import type {
  AccountState,
  AdminApiTokenPage,
  AdminApiTokenQuery,
  AdminApiTokenRevocationCommand,
  AdminAttachmentPage,
  AdminAttachmentQuery,
  AdminBalanceAdjustment,
  AdminBalanceAdjustmentCommand,
  AdminLedgerPage,
  AdminLedgerQuery,
  AdminSessionPage,
  AdminSessionQuery,
  AdminSessionRevocationCommand,
  AdminStorageSummary,
  AdminUser,
  AdminUserPage,
  AdminUserQuery,
  ApiTokenSummary,
  ApprovalStatus,
  AttachmentStorageUsage,
  Conversation,
  ConversationDetail,
  ConversationFolder,
  ConversationFolderMembership,
  ConversationPortabilityV1,
  ConversationSearchPage,
  ConversationSearchQuery,
  ConversationShareAttachmentPolicy,
  ConversationShareIdentityVisibility,
  ConversationShareSummary,
  ConversationTag,
  ConversationTagBinding,
  ConversationTagSet,
  MessageNode,
  MessageRole,
  ModelCapability,
  PublicConversationShare,
  PublicConversationShareAttachment,
  PublicUser,
  UsageSummary,
  UserPreferences,
  UserRole,
} from "@dg-chat/contracts";
import {
  hasVisibleConversationSearchText,
  stripConversationSearchControls,
} from "@dg-chat/contracts";
import type { LedgerEntry, StoredApiToken, StoredSession, StoredUser, UsageRun } from "./memory.ts";
export {
  DOCX_MIME_TYPE,
  INGESTIBLE_DOCUMENT_MIME_TYPES,
  isIngestibleDocumentMime,
} from "./attachment-policy.ts";

export type MaybePromise<T> = T | Promise<T>;

const CONVERSATION_SEARCH_CURSOR_VERSION = 1;
export const CONVERSATION_SEARCH_CURSOR_MAX_CHARS = 2_048;
const CONVERSATION_SEARCH_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
/** PostgreSQL cancels a conversation search before an admission lease may expire. */
export const CONVERSATION_SEARCH_STATEMENT_TIMEOUT_MS = 5_000;
/** Search reads cannot starve transactional application work in the repository's primary pool. */
export const CONVERSATION_SEARCH_POOL_MAX = 4;
export const CONVERSATION_SEARCH_APPLICATION_NAME = "dg-chat-conversation-search";
export const CONVERSATION_SEARCH_QUERY_VALIDATION_MESSAGE =
  "Search query must be between 2 and 200 characters and contain safe visible text";
const CONVERSATION_SEARCH_SNIPPET_CHARS = 240;
const CONVERSATION_SEARCH_SCAN_CHARS = 4_096;
const CONVERSATION_SEARCH_EXCERPT_CHARS = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})(?:\d{3})?Z$/;

function validConversationSearchCursorTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CURSOR_TIMESTAMP_PATTERN.exec(value);
  if (!match || value.startsWith("0000-")) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === `${match[1]}Z`;
}

function conversationSearchFingerprint(
  query: Pick<ConversationSearchQuery, "query" | "view" | "folderId" | "tagIds">,
  ownerId: string,
) {
  // A compact one-way binding keeps the search text itself out of the opaque cursor. The cursor
  // is only a position hint; owner authorization is independently enforced by every query.
  const input = JSON.stringify({
    ownerId,
    view: query.view,
    query: query.query.trim().toLowerCase(),
    folderId: query.folderId ?? null,
    tagIds: [...(query.tagIds ?? [])].sort(),
  });
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const byte of new TextEncoder().encode(input)) {
    left = Math.imul(left ^ byte, 0x01000193) >>> 0;
    right = Math.imul(right ^ byte, 0x85ebca6b) >>> 0;
  }
  return left.toString(16).padStart(8, "0") + right.toString(16).padStart(8, "0");
}

export function encodeConversationSearchCursor(
  value: { updatedAt: string; id: string },
  query: Pick<ConversationSearchQuery, "query" | "view" | "folderId" | "tagIds">,
  ownerId: string,
): string {
  const bytes = new TextEncoder().encode(JSON.stringify([
    CONVERSATION_SEARCH_CURSOR_VERSION,
    value.updatedAt,
    value.id,
    conversationSearchFingerprint(query, ownerId),
  ]));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeConversationSearchCursor(
  cursor: string,
  query: Pick<ConversationSearchQuery, "query" | "view" | "folderId" | "tagIds">,
  ownerId: string,
): { updatedAt: string; id: string } | undefined {
  try {
    if (
      cursor.length === 0 || cursor.length > CONVERSATION_SEARCH_CURSOR_MAX_CHARS ||
      !CONVERSATION_SEARCH_CURSOR_PATTERN.test(cursor)
    ) return undefined;
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    // Reject alternate encodings with non-zero trailing bits. Keeping one canonical wire form
    // makes cursors safely comparable in logs and prevents padded/non-base64url variants from
    // bypassing validation at repository boundaries.
    const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
      .replace(/=+$/, "");
    if (canonical !== cursor) return undefined;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    ));
    if (
      !Array.isArray(value) || value.length !== 4 ||
      value[0] !== CONVERSATION_SEARCH_CURSOR_VERSION ||
      !validConversationSearchCursorTimestamp(value[1]) || typeof value[2] !== "string" ||
      !UUID_PATTERN.test(value[2]) || value[3] !== conversationSearchFingerprint(query, ownerId)
    ) return undefined;
    return { updatedAt: value[1], id: value[2] };
  } catch {
    return undefined;
  }
}

/** Finds case-insensitive text without allocating a normalized copy of a potentially huge body. */
export function conversationSearchMatchIndex(content: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return -1;
  const overlap = Math.min(Math.max(needle.length * 3, 32), CONVERSATION_SEARCH_SCAN_CHARS - 1);
  for (let offset = 0; offset < content.length; offset += CONVERSATION_SEARCH_SCAN_CHARS) {
    const start = Math.max(0, offset - overlap);
    const chunk = content.slice(start, offset + CONVERSATION_SEARCH_SCAN_CHARS);
    const match = chunk.toLowerCase().indexOf(needle);
    if (match >= 0) return start + match;
  }
  return -1;
}

/** Removes terminal/bidi controls and produces a short single-line plain-text excerpt. */
export function conversationSearchSnippet(content: string, query: string): string {
  const rawMatch = conversationSearchMatchIndex(content, query);
  const rawStart = Math.max(0, rawMatch < 0 ? 0 : rawMatch - 256);
  const rawEnd = Math.min(content.length, rawStart + CONVERSATION_SEARCH_EXCERPT_CHARS);
  const plain = stripConversationSearchControls(content.slice(rawStart, rawEnd), " ")
    .replace(/\s+/gu, " ").trim();
  if (
    plain.length <= CONVERSATION_SEARCH_SNIPPET_CHARS && rawStart === 0 &&
    rawEnd === content.length
  ) return plain;
  const match = conversationSearchMatchIndex(plain, query);
  let prefix = rawStart > 0;
  let suffix = rawEnd < content.length;
  let available = CONVERSATION_SEARCH_SNIPPET_CHARS - Number(prefix) - Number(suffix);
  let start = Math.max(
    0,
    Math.min(match < 0 ? 0 : match - 80, plain.length - available),
  );
  prefix ||= start > 0;
  available = CONVERSATION_SEARCH_SNIPPET_CHARS - Number(prefix) - Number(suffix);
  start = Math.max(0, Math.min(match < 0 ? 0 : match - 80, plain.length - available));
  suffix ||= start + available < plain.length;
  available = CONVERSATION_SEARCH_SNIPPET_CHARS - Number(prefix) - Number(suffix);
  start = Math.max(0, Math.min(match < 0 ? 0 : match - 80, plain.length - available));
  const excerpt = plain.slice(
    start,
    start + available,
  );
  return `${prefix ? "…" : ""}${excerpt}${suffix ? "…" : ""}`;
}

export function validConversationSearchTerm(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.length <= 200 && !trimmed.includes("\u0000") &&
    hasVisibleConversationSearchText(trimmed);
}

export function validConversationSearchScopeId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function conversationSearchMessageContent(
  message: Pick<MessageNode, "role" | "content" | "metadata">,
): string {
  return message.role === "user" && typeof message.metadata.authoredContent === "string"
    ? message.metadata.authoredContent
    : message.content;
}

export interface ConversationPortabilityExportOptions {
  includeTemporary?: boolean;
  includeDeleted?: boolean;
}

export interface ConversationPortabilityImportResult {
  dryRun: boolean;
  replayed: boolean;
  conversations: number;
  messages: number;
  attachments: number;
  folders: number;
  tags: number;
  /** Old archive identifiers mapped to newly allocated owner-scoped identifiers. */
  idMap: Record<string, string>;
}

export interface CreateConversationShareInput {
  conversationId: string;
  leafId: string;
  expectedConversationVersion: number;
  identityVisibility: ConversationShareIdentityVisibility;
  attachmentPolicy: ConversationShareAttachmentPolicy;
  /** Required and non-empty only for the selected policy. Private attachment identifiers. */
  selectedAttachmentIds: string[];
  expiresAt: string | null;
  idempotencyKey: string;
  /** SHA-256 of the caller-held 32-byte capability. The plaintext is never persisted. */
  secretHash: string;
}

export interface CreateConversationShareResult {
  share: ConversationShareSummary;
  replayed: boolean;
}
export const MAX_ACTIVE_CONVERSATION_SHARES = 100;
export const MAX_CONVERSATION_SHARE_MESSAGES = 20_000;
export const MAX_CONVERSATION_SHARE_ATTACHMENTS = 2_000;
export const MAX_CONVERSATION_SHARE_CONTENT_CHARS = 16_000_000;

/** Internal object access returned only after a valid capability has resolved. */
export interface ConversationShareAttachmentAccess {
  shareId: string;
  ownerId: string;
  attachment: PublicConversationShareAttachment;
  objectKey: string;
  /** Internal immutable digest used to validate the object before public streaming. */
  sha256: string;
}

export interface CreateUserInput {
  id?: string;
  email: string;
  name: string;
  passwordHash?: string | null;
  role?: UserRole;
  approvalStatus?: ApprovalStatus;
  state?: AccountState;
  emailVerified?: boolean;
}

export interface AdminUserCommand {
  actorId: string;
  expectedAuthorityEpoch: number;
  targetUserId: string;
  expectedVersion: number;
  reason?: string;
}

export interface AdminApprovalCommand extends AdminUserCommand {
  status: "approved" | "rejected";
  startingCreditMicros: number;
  requireEmailVerification?: boolean;
}

export interface AdminRoleCommand extends AdminUserCommand {
  role: UserRole;
  reason: string;
  requireEmailVerification?: boolean;
}

export interface AdminStateCommand extends AdminUserCommand {
  state: AccountState;
  requireEmailVerification?: boolean;
}

export interface AdminDeletionCommand extends AdminUserCommand {
  deleted: boolean;
  reason: string;
  requireEmailVerification?: boolean;
}

const ADMIN_USER_CURSOR_VERSION = 2;
const LEGACY_ADMIN_USER_CURSOR_VERSION = 1;
const MAX_ADMIN_USER_CURSOR_MICROS = 253_402_300_799_999_999n;

function validAdminUserCursorMicros(value: unknown, createdAt: string): value is string {
  if (typeof value !== "string" || !/^\d{1,18}$/.test(value)) return false;
  try {
    const micros = BigInt(value);
    return micros <= MAX_ADMIN_USER_CURSOR_MICROS &&
      micros / 1_000n === BigInt(Date.parse(createdAt));
  } catch {
    return false;
  }
}

/** Bind pagination cursors to the normalized filters that produced them. */
export function adminUserQueryFingerprint(query: AdminUserQuery): string {
  return JSON.stringify({
    search: query.search?.trim().toLocaleLowerCase() || null,
    role: query.role ?? null,
    approvalStatus: query.approvalStatus ?? null,
    state: query.state ?? null,
    deletion: query.deletion ?? "present",
    emailVerified: query.emailVerified ?? null,
  });
}

export function encodeAdminUserCursor(
  value: Pick<PublicUser, "createdAt" | "id">,
  query: AdminUserQuery,
  createdAtMicros?: string,
): string {
  if (
    createdAtMicros !== undefined && !validAdminUserCursorMicros(createdAtMicros, value.createdAt)
  ) {
    throw new TypeError("Admin user cursor microseconds must match its timestamp");
  }
  const bytes = new TextEncoder().encode(JSON.stringify([
    ADMIN_USER_CURSOR_VERSION,
    value.createdAt,
    value.id,
    adminUserQueryFingerprint(query),
    createdAtMicros ?? null,
  ]));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export function decodeAdminUserCursor(
  cursor: string,
  query: AdminUserQuery,
): { createdAt: string; id: string; createdAtMicros?: string } | undefined {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    );
    if (!Array.isArray(value)) return undefined;
    const legacy = value[0] === LEGACY_ADMIN_USER_CURSOR_VERSION && value.length === 4;
    const current = value[0] === ADMIN_USER_CURSOR_VERSION && value.length === 5;
    const parsedCreatedAt = typeof value[1] === "string" ? Date.parse(value[1]) : Number.NaN;
    if (
      (!legacy && !current) ||
      typeof value[1] !== "string" || !Number.isFinite(parsedCreatedAt) ||
      new Date(parsedCreatedAt).toISOString() !== value[1] ||
      typeof value[2] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(value[2]) ||
      value[3] !== adminUserQueryFingerprint(query) ||
      (current && value[4] !== null && !validAdminUserCursorMicros(value[4], value[1]))
    ) return undefined;
    return {
      createdAt: value[1],
      id: value[2],
      ...(current && value[4] !== null ? { createdAtMicros: value[4] } : {}),
    };
  } catch {
    return undefined;
  }
}
export type IdentityTokenPurpose = "email_verification" | "password_reset";
export interface SessionSummary {
  id: string;
  userId: string;
  limited: boolean;
  expiresAt: string;
  createdAt: string;
  invalidatedAt: string | null;
}
const ADMIN_RESOURCE_CURSOR_VERSION = 1;
const ADMIN_RESOURCE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_RESOURCE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
function validAdminResourceTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ADMIN_RESOURCE_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
}
export function encodeAdminResourceCursor(
  resource: "sessions" | "tokens" | "ledger",
  targetUserId: string,
  position: string,
  id: string,
  fingerprint = "",
): string {
  return btoa(
    JSON.stringify([
      ADMIN_RESOURCE_CURSOR_VERSION,
      resource,
      targetUserId,
      position,
      id,
      fingerprint,
    ]),
  )
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodeAdminResourceCursor(
  cursor: string,
  resource: "sessions" | "tokens" | "ledger",
  targetUserId: string,
  fingerprint = "",
): { position: string; id: string } | undefined {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const value = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    if (
      !Array.isArray(value) || value.length !== 6 || value[0] !== ADMIN_RESOURCE_CURSOR_VERSION ||
      value[1] !== resource || value[2] !== targetUserId || typeof value[3] !== "string" ||
      (resource === "ledger"
        ? !/^[1-9]\d{0,15}$/.test(value[3]) || !Number.isSafeInteger(Number(value[3]))
        : !validAdminResourceTimestamp(value[3])) ||
      typeof value[4] !== "string" || value[5] !== fingerprint ||
      (resource === "sessions"
        ? !/^(?:legacy|better_auth):[0-9a-f-]{36}$/i.test(value[4]) ||
          !ADMIN_RESOURCE_UUID_PATTERN.test(value[4].slice(value[4].indexOf(":") + 1))
        : !ADMIN_RESOURCE_UUID_PATTERN.test(value[4]))
    ) return undefined;
    return { position: value[3], id: value[4] };
  } catch {
    return undefined;
  }
}
export interface AuditEventInput {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}
export interface PrivilegedAuditEventInput extends AuditEventInput {
  actorId: string;
  requireEmailVerification: boolean;
  expectedAuthorityEpoch: number;
}
/** Authority admitted by middleware and revalidated at the storage disclosure boundary. */
export interface PrivilegedReadContext {
  actorId: string;
  requireEmailVerification: boolean;
  expectedAuthorityEpoch: number;
}
export interface AuditEvent extends AuditEventInput {
  id: string;
  createdAt: string;
}
export interface AuditQuery {
  limit?: number;
  cursor?: string;
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}
export interface AuditPage {
  data: AuditEvent[];
  nextCursor: string | null;
}

export function encodeAuditCursor(event: Pick<AuditEvent, "createdAt" | "id">): string {
  return encodeAuditCursorTuple(event.createdAt, event.id);
}

/** PostgreSQL ordering cursor that preserves the database timestamp's full microsecond precision. */
export function encodeAuditPostgresCursor(timestamp: string, id: string): string {
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError("Invalid audit timestamp cursor");
  }
  return encodeAuditCursorTuple(`pg:${timestamp}`, id);
}

function encodeAuditCursorTuple(timestamp: string, id: string): string {
  return btoa(JSON.stringify([timestamp, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export type DecodedAuditCursor =
  | { kind: "timestamp"; createdAt: string; id: string }
  | { kind: "postgres_timestamp"; timestamp: string; id: string };

export function decodeAuditCursor(cursor: string): DecodedAuditCursor | undefined {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    if (
      !Array.isArray(decoded) || decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded[1])
    ) return undefined;
    if (decoded[0].startsWith("pg:")) {
      const timestamp = decoded[0].slice(3);
      return Number.isFinite(Date.parse(timestamp))
        ? { kind: "postgres_timestamp", timestamp, id: decoded[1] }
        : undefined;
    }
    if (!Number.isFinite(Date.parse(decoded[0]))) return undefined;
    return { kind: "timestamp", createdAt: new Date(decoded[0]).toISOString(), id: decoded[1] };
  } catch {
    return undefined;
  }
}

export type AttachmentState =
  | "pending"
  | "inspecting"
  | "ready"
  | "quarantined"
  | "failed"
  | "deleted";
export type AttachmentIngestionStatus =
  | "not_applicable"
  | "queued"
  | "processing"
  | "ready"
  | "failed";
export interface AttachmentRecord {
  id: string;
  ownerId: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  state: AttachmentState;
  inspectionError: string | null;
  requiredInspectionMode: RequiredAttachmentInspectionMode;
  inspectionPolicyVersion: typeof ATTACHMENT_INSPECTION_POLICY_VERSION;
  /** Monotonic policy epoch. Inspection results must bind to the epoch they examined. */
  inspectionEpoch: number;
  /** Optimistic administrative version, independent from the immutable content digest. */
  version: number;
  ingestionStatus: AttachmentIngestionStatus;
  ingestionError: string | null;
  ingestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
/** Stable machine-readable inspection outcomes shared by workers and authorization decisions. */
export const ATTACHMENT_INSPECTION_REASON = Object.freeze(
  {
    localPolicyRejected: "worker_local_policy_rejected",
    malwareDetected: "worker_malware_detected",
    retryExhausted: "worker_retry_exhausted",
    externalScannerUnavailable: "worker_external_scanner_unavailable",
  } as const,
);
export const ATTACHMENT_INSPECTION_POLICY_VERSION = "worker-policy-v1" as const;
export type RequiredAttachmentInspectionMode = "local" | "external";
export type AttachmentReinspectionBlockReason =
  | "deleted"
  | "nonterminal"
  | "policy_quarantine";
export interface AttachmentReinspectionEligibility {
  eligible: boolean;
  blockedReason: AttachmentReinspectionBlockReason | null;
}
export function attachmentReinspectionEligibility(
  attachment: Pick<AttachmentRecord, "state" | "inspectionError" | "deletedAt">,
): AttachmentReinspectionEligibility {
  if (attachment.deletedAt !== null || attachment.state === "deleted") {
    return { eligible: false, blockedReason: "deleted" };
  }
  if (attachment.state === "ready" || attachment.state === "failed") {
    return { eligible: true, blockedReason: null };
  }
  if (attachment.state === "quarantined") {
    const workerOwned = attachment.inspectionError ===
        ATTACHMENT_INSPECTION_REASON.localPolicyRejected ||
      attachment.inspectionError === ATTACHMENT_INSPECTION_REASON.malwareDetected;
    return workerOwned
      ? { eligible: true, blockedReason: null }
      : { eligible: false, blockedReason: "policy_quarantine" };
  }
  return { eligible: false, blockedReason: "nonterminal" };
}
export type AttachmentListOrder = "asc" | "desc";
/**
 * Owner-scoped keyset pagination for attachment-backed file APIs. `after` is the public
 * attachment identifier returned by the preceding page, rather than an opaque internal cursor.
 */
export interface AttachmentListQuery {
  limit: number;
  order: AttachmentListOrder;
  after?: string;
}
export interface AttachmentPage {
  data: AttachmentRecord[];
  hasMore: boolean;
}

const ADMIN_ATTACHMENT_CURSOR_VERSION = 1;
function adminAttachmentFingerprint(query: AdminAttachmentQuery): string {
  // The bounded filter tuple itself is safe to embed and avoids accepting deliberate collisions
  // from a short non-cryptographic digest.
  return JSON.stringify({
    ownerId: query.ownerId ?? null,
    state: query.state ?? null,
    deletion: query.deletion ?? "present",
  });
}
export function encodeAdminAttachmentCursor(
  createdAt: string,
  id: string,
  query: AdminAttachmentQuery,
): string {
  return btoa(JSON.stringify([
    ADMIN_ATTACHMENT_CURSOR_VERSION,
    createdAt,
    id,
    adminAttachmentFingerprint(query),
  ])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodeAdminAttachmentCursor(
  cursor: string,
  query: AdminAttachmentQuery,
): { createdAt: string; id: string } | undefined {
  try {
    if (!cursor || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    if (
      btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== cursor
    ) return undefined;
    const value = JSON.parse(decoded);
    if (
      !Array.isArray(value) || value.length !== 4 ||
      value[0] !== ADMIN_ATTACHMENT_CURSOR_VERSION ||
      typeof value[1] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value[1]) ||
      !Number.isFinite(Date.parse(value[1])) ||
      typeof value[2] !== "string" || !UUID_PATTERN.test(value[2]) ||
      value[3] !== adminAttachmentFingerprint(query)
    ) return undefined;
    return { createdAt: value[1], id: value[2] };
  } catch {
    return undefined;
  }
}
export interface DocumentChunkMetadata extends Record<string, unknown> {
  sourceAttachmentId?: string;
  filename?: string;
  mimeType?: string;
  sha256?: string;
  extractorVersion?: string;
  chunkerVersion?: string;
  pageNumber?: number;
  pageLabel?: string;
  section?: string;
  sectionPath?: string[];
  startLine?: number;
  endLine?: number;
  charStart?: number;
  charEnd?: number;
}
export interface DocumentChunkInput {
  id: string;
  ordinal: number;
  content: string;
  metadata: DocumentChunkMetadata;
}
export interface DocumentChunk extends DocumentChunkInput {
  attachmentId: string;
}
export interface DocumentChunkEmbeddingInput {
  chunkId: string;
  ownerId: string;
  model: string;
  version: string;
  contentSha256: string;
  embedding: number[];
}
export interface KnowledgeSearchHit extends DocumentChunk {
  collectionId: string;
  collectionName: string;
  filename: string;
  lexicalScore: number;
  vectorScore: number | null;
  score: number;
}
export interface EmbeddingProviderAttemptInput {
  usageRunId: string;
  parentUsageRunId?: string;
  purpose: "document" | "query";
  provider: string;
  model: string;
  upstreamModel: string;
  itemCount: number;
}
export interface FinishEmbeddingProviderAttemptInput {
  usageRunId: string;
  status: "succeeded" | "failed" | "cancelled";
  inputTokens: number;
  costMicros: number;
  tokenSource: "provider" | "estimated" | "none";
  costSource: "calculated" | "none";
  latencyMs: number;
  error?: string;
}
export type FinalizeEmbeddingProviderUsageInput = FinishEmbeddingProviderAttemptInput;
export interface SearchConversationKnowledgeInput {
  conversationId: string;
  ownerId: string;
  query: string;
  queryEmbedding?: number[];
  embeddingVersion?: string;
  limit?: number;
}
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

export function normalizeKnowledgeSearchLimit(limit = 12): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError("Knowledge search limit must be between 1 and 50");
  }
  return limit;
}

export function validateChunkEmbeddings(
  values: readonly DocumentChunkEmbeddingInput[],
): DocumentChunkEmbeddingInput[] {
  if (values.length < 1 || values.length > 256) {
    throw new TypeError("Document chunk embedding batch is invalid");
  }
  const keys = new Set<string>();
  return values.map((value) => {
    const key = `${value.chunkId}:${value.version}`;
    if (
      !DOCUMENT_UUID_PATTERN.test(value.chunkId) || !DOCUMENT_UUID_PATTERN.test(value.ownerId) ||
      !value.model || value.model.length > 200 ||
      !DOCUMENT_VERSION_PATTERN.test(value.version) ||
      !/^[0-9a-f]{64}$/.test(value.contentSha256) || keys.has(key) ||
      value.embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
      value.embedding.some((part) => typeof part !== "number" || !Number.isFinite(part))
    ) throw new TypeError("Document chunk embedding batch is invalid");
    keys.add(key);
    return { ...value, embedding: [...value.embedding] };
  });
}

const DOCUMENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOCUMENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 100 &&
    entries.every(([key, item]) => key.length <= 128 && isJsonValue(item, depth + 1));
}

/** Validates and JSON-clones chunk metadata so memory and PostgreSQL persist identical values. */
export function normalizeDocumentChunkMetadata(
  metadata: DocumentChunkMetadata,
): DocumentChunkMetadata {
  if (!isJsonValue(metadata)) {
    throw new TypeError("Document chunk metadata is invalid");
  }
  const serialized = JSON.stringify(metadata);
  if (serialized.length > 32_768) {
    throw new TypeError("Document chunk metadata is too large");
  }
  if (
    (metadata.sourceAttachmentId !== undefined &&
      (typeof metadata.sourceAttachmentId !== "string" ||
        !DOCUMENT_UUID_PATTERN.test(metadata.sourceAttachmentId))) ||
    (metadata.extractorVersion !== undefined &&
      (typeof metadata.extractorVersion !== "string" ||
        !DOCUMENT_VERSION_PATTERN.test(metadata.extractorVersion))) ||
    (metadata.chunkerVersion !== undefined &&
      (typeof metadata.chunkerVersion !== "string" ||
        !DOCUMENT_VERSION_PATTERN.test(metadata.chunkerVersion))) ||
    (metadata.filename !== undefined &&
      (typeof metadata.filename !== "string" || metadata.filename.length > 255)) ||
    (metadata.mimeType !== undefined &&
      (typeof metadata.mimeType !== "string" || metadata.mimeType.length > 255)) ||
    (metadata.sha256 !== undefined &&
      (typeof metadata.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.sha256))) ||
    (metadata.pageNumber !== undefined &&
      (!Number.isSafeInteger(metadata.pageNumber) || metadata.pageNumber < 1)) ||
    (metadata.pageLabel !== undefined &&
      (typeof metadata.pageLabel !== "string" || metadata.pageLabel.length > 120)) ||
    (metadata.section !== undefined &&
      (typeof metadata.section !== "string" || metadata.section.length > 500)) ||
    (metadata.sectionPath !== undefined &&
      (!Array.isArray(metadata.sectionPath) || metadata.sectionPath.length > 32 ||
        metadata.sectionPath.some((part) => typeof part !== "string" || part.length > 500))) ||
    ([metadata.startLine, metadata.endLine].some((value) =>
      value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1)
    )) ||
    ([metadata.charStart, metadata.charEnd].some((value) =>
      value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)
    )) ||
    (metadata.startLine !== undefined && metadata.endLine !== undefined &&
      metadata.endLine < metadata.startLine) ||
    (metadata.charStart !== undefined && metadata.charEnd !== undefined &&
      metadata.charEnd < metadata.charStart)
  ) throw new TypeError("Document chunk metadata is invalid");
  return JSON.parse(serialized) as DocumentChunkMetadata;
}

/** Validates a complete replacement set before any existing chunks are removed. */
export function validateDocumentChunkInputs(
  chunks: readonly DocumentChunkInput[],
  attachmentId?: string,
): DocumentChunkInput[] {
  const ids = new Set<string>();
  return chunks.map((chunk, index) => {
    if (
      !DOCUMENT_UUID_PATTERN.test(chunk.id) || chunk.ordinal !== index || !chunk.content ||
      chunk.content.length > 20_000 || ids.has(chunk.id)
    ) throw new TypeError("Document chunks are invalid");
    ids.add(chunk.id);
    const metadata = normalizeDocumentChunkMetadata(chunk.metadata);
    if (attachmentId && metadata.sourceAttachmentId !== attachmentId) {
      throw new TypeError("Document chunks are invalid");
    }
    return { ...chunk, metadata };
  });
}
export interface CreateAttachmentInput {
  ownerId: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  state?: "pending" | "ready" | "quarantined";
  inspectionError?: string | null;
  requiredInspectionMode?: RequiredAttachmentInspectionMode;
  inspectionPolicyVersion?: typeof ATTACHMENT_INSPECTION_POLICY_VERSION;
  /** Set only when trusted server-side validation has already completed. */
  inspectionComplete?: boolean;
}
export interface AttachmentStorageQuota {
  /** Retained physical bytes for one owner, inclusive of historical soft-deleted attachments. */
  perUserBytes: number;
  /** Retained physical object count for one owner. */
  perUserObjects: number;
  /** Retained physical bytes across the installation. */
  installationBytes: number;
  /** Retained physical object count across the installation. */
  installationObjects: number;
}
export interface RequestAttachmentReinspectionInput {
  attachmentId: string;
  actorId: string;
  expectedVersion: number;
  reason: string;
  /** Trusted server-side policy snapshot to apply to the new inspection epoch. */
  requiredInspectionMode: RequiredAttachmentInspectionMode;
  inspectionPolicyVersion: typeof ATTACHMENT_INSPECTION_POLICY_VERSION;
}
export interface AttachmentReinspectionResult {
  attachment: AttachmentRecord;
  inspectionJobId: string;
}
export interface TransitionAttachmentInspectionInput {
  attachmentId: string;
  ownerId: string;
  inspectionEpoch: number;
  expectedState: "pending" | "inspecting";
  nextState: "inspecting" | "ready" | "quarantined" | "failed";
  inspectionError?: string | null;
}
export interface CreateAttachmentResult {
  attachment: AttachmentRecord;
  inspectionJobId: string | null;
  deduplicated: boolean;
}
export interface FinalizeFileUploadInput {
  attachment: CreateAttachmentInput;
  request: Omit<
    CompleteApiRequestInput,
    "responseBody" | "responseBodyEncoding" | "frames" | "terminalFrame"
  >;
  responseBody: (attachment: AttachmentRecord) => string;
}
export interface FinalizeFileUploadResult {
  attachment: AttachmentRecord;
  request: ApiIdempotencyRequest;
}
export interface FileUploadStage {
  requestId: string;
  ownerId: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  purpose: string;
  attachmentState: "pending" | "ready" | "quarantined";
  inspectionError: string | null;
  requiredInspectionMode: RequiredAttachmentInspectionMode;
  inspectionPolicyVersion: typeof ATTACHMENT_INSPECTION_POLICY_VERSION;
  state: "pending" | "stored" | "finalized";
  attachmentId: string | null;
  createdAt: string;
  updatedAt: string;
}
export type StageFileUploadInput = Omit<
  FileUploadStage,
  "state" | "attachmentId" | "createdAt" | "updatedAt"
>;

export interface AttachmentUploadStage {
  id: string;
  ownerId: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  state:
    | "pending"
    | "stored"
    | "cleanup_pending"
    | "cleaning"
    | "finalized"
    | "cleaned"
    | "abandoned";
  attachmentId: string | null;
  cleanupError: string | null;
  /** Untrusted workers may clean this object only after the active PUT lease expires. */
  uploadLeaseToken: string;
  uploadLeaseExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}
export type StageAttachmentUploadInput = Pick<
  AttachmentUploadStage,
  "id" | "ownerId" | "objectKey" | "filename" | "mimeType" | "sizeBytes" | "sha256"
>;

/** Accept only the content-addressed namespace shared by Files uploads and cleanup jobs. */
export function isCanonicalFileUploadObjectKey(
  ownerId: string,
  sha256: string,
  objectKey: string,
): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId) || !/^[0-9a-f]{64}$/.test(sha256)) return false;
  const escapedOwner = ownerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^uploads/${escapedOwner}/blobs/${sha256.slice(0, 2)}/${sha256}\\.[a-z0-9]{1,12}$`,
  ).test(objectKey);
}

export interface StaleFileUpload {
  stage: FileUploadStage;
  request: ApiIdempotencyRequest;
}

export type GeneratedAssetInputRole = "source" | "mask" | "reference";
export interface GeneratedAssetInput {
  attachmentId: string;
  role: GeneratedAssetInputRole;
  ordinal: number;
  width: number;
  height: number;
  hasAlpha?: boolean | null;
}
export interface GeneratedAssetRecord {
  id: string;
  ownerId: string;
  usageRunId: string;
  providerModelId: string;
  publicModelId: string;
  upstreamModelId: string;
  providerSlug: string;
  pricingSnapshot: UsagePricingSnapshot;
  attachmentId: string;
  idempotencyKey: string;
  requestHash: string;
  operation: "generation" | "edit";
  prompt: string;
  providerCreatedAt: number;
  ordinal: number;
  width: number;
  height: number;
  revisedPrompt: string | null;
  inputs: GeneratedAssetInput[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface FinalizeGeneratedAssetsInput {
  ownerId: string;
  usageRunId: string;
  providerModelId: string;
  publicModelId: string;
  upstreamModelId: string;
  providerSlug: string;
  pricingSnapshot: UsagePricingSnapshot;
  idempotencyKey: string;
  requestHash: string;
  operation: "generation" | "edit";
  prompt: string;
  providerCreatedAt: number;
  assets: Array<{
    attachmentId: string;
    ordinal: number;
    width: number;
    height: number;
    revisedPrompt?: string | null;
    inputs?: GeneratedAssetInput[];
  }>;
}

export type GeneratedObjectStageState =
  | "pending"
  | "stored"
  | "attached"
  | "finalized"
  | "cleanup_pending"
  | "cleaning"
  | "cleaned";
export interface GeneratedObjectStage {
  id: string;
  ownerId: string;
  usageRunId: string;
  ordinal: number;
  purpose: "output" | "edit_input";
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  attachmentId: string | null;
  cleanupAttachment: boolean;
  state: GeneratedObjectStageState;
  cleanupError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface StageGeneratedObjectInput {
  ownerId: string;
  usageRunId: string;
  ordinal: number;
  purpose?: "output" | "edit_input";
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}
export interface GeneratedObjectCleanupSettlement {
  stage: GeneratedObjectStage;
  /** True only for the first durable release of an admitted generated object. */
  storageReleased: boolean;
}

const unicodeScalarLength = (value: string): number => [...value].length;

export function validateGeneratedAssetFinalization(input: FinalizeGeneratedAssetsInput): void {
  if (
    !DOCUMENT_UUID_PATTERN.test(input.ownerId) || !input.usageRunId ||
    input.usageRunId.length > 200 || !DOCUMENT_UUID_PATTERN.test(input.providerModelId) ||
    input.publicModelId.length < 3 || input.publicModelId.length > 255 ||
    !input.publicModelId.includes("/") || !input.upstreamModelId.trim() ||
    input.upstreamModelId.length > 255 ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.providerSlug) ||
    !isUsagePricingSnapshot(input.pricingSnapshot) ||
    input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 ||
    !/^[0-9a-f]{64}$/.test(input.requestHash) ||
    !["generation", "edit"].includes(input.operation) || !input.prompt ||
    !Number.isSafeInteger(input.providerCreatedAt) || input.providerCreatedAt < 0 ||
    unicodeScalarLength(input.prompt) > 32_000 || input.assets.length < 1 ||
    input.assets.length > 10
  ) throw new TypeError("Generated asset finalization is invalid");
  let canonicalInputs: string | undefined;
  for (let index = 0; index < input.assets.length; index++) {
    const asset = input.assets[index];
    if (
      asset.ordinal !== index || !DOCUMENT_UUID_PATTERN.test(asset.attachmentId) ||
      !Number.isSafeInteger(asset.width) ||
      asset.width < 1 || asset.width > 65_535 || !Number.isSafeInteger(asset.height) ||
      asset.height < 1 || asset.height > 65_535 ||
      (asset.revisedPrompt != null &&
        (typeof asset.revisedPrompt !== "string" ||
          unicodeScalarLength(asset.revisedPrompt) > 32_000))
    ) throw new TypeError("Generated asset finalization is invalid");
    const inputKeys = new Set<string>();
    const attachmentIds = new Set<string>();
    const byRole = new Map<GeneratedAssetInputRole, number[]>();
    for (const source of asset.inputs ?? []) {
      const key = `${source.role}:${source.ordinal}`;
      if (
        !DOCUMENT_UUID_PATTERN.test(source.attachmentId) ||
        !["source", "mask", "reference"].includes(source.role) ||
        !Number.isSafeInteger(source.ordinal) || source.ordinal < 0 || source.ordinal > 15 ||
        inputKeys.has(key) || attachmentIds.has(source.attachmentId)
      ) throw new TypeError("Generated asset finalization is invalid");
      if (
        !Number.isSafeInteger(source.width) || source.width < 1 || source.width > 65_535 ||
        !Number.isSafeInteger(source.height) || source.height < 1 || source.height > 65_535 ||
        (source.role === "mask"
          ? source.hasAlpha !== true
          : source.hasAlpha !== undefined && source.hasAlpha !== null)
      ) throw new TypeError("Generated asset finalization is invalid");
      inputKeys.add(key);
      attachmentIds.add(source.attachmentId);
      const ordinals = byRole.get(source.role) ?? [];
      ordinals.push(source.ordinal);
      byRole.set(source.role, ordinals);
    }
    for (const ordinals of byRole.values()) {
      ordinals.sort((a, b) => a - b);
      if (ordinals.some((ordinal, ordinalIndex) => ordinal !== ordinalIndex)) {
        throw new TypeError("Generated asset finalization is invalid");
      }
    }
    const sources = byRole.get("source") ?? [];
    const masks = byRole.get("mask") ?? [];
    if (
      (input.operation === "generation" && inputKeys.size !== 0) ||
      (input.operation === "edit" &&
        (sources.length < 1 || sources.length > 16 || masks.length > 1))
    ) throw new TypeError("Generated asset finalization is invalid");
    if (input.operation === "edit") {
      const orderedSources = (asset.inputs ?? []).filter((source) => source.role === "source")
        .sort((a, b) => a.ordinal - b.ordinal);
      const first = orderedSources[0];
      if (
        orderedSources.some((source) =>
          source.width !== first.width || source.height !== first.height
        ) ||
        (asset.inputs ?? []).some((source) =>
          source.role === "mask" &&
          (source.width !== first.width || source.height !== first.height)
        )
      ) throw new TypeError("Generated asset finalization is invalid");
    }
    const serialized = JSON.stringify([...(asset.inputs ?? [])].sort(generatedInputOrder));
    if (canonicalInputs !== undefined && serialized !== canonicalInputs) {
      throw new TypeError("Generated asset finalization is invalid");
    }
    canonicalInputs = serialized;
  }
}

export function sameGeneratedAssetFinalization(
  records: GeneratedAssetRecord[],
  input: FinalizeGeneratedAssetsInput,
): boolean {
  return records.length === input.assets.length && records.every((record, index) => {
    const candidate = input.assets[index];
    const sources = candidate.inputs ?? [];
    return record.ownerId === input.ownerId && record.usageRunId === input.usageRunId &&
      record.providerModelId === input.providerModelId &&
      record.publicModelId === input.publicModelId &&
      record.upstreamModelId === input.upstreamModelId &&
      record.providerSlug === input.providerSlug &&
      usagePricingSnapshotsEqual(record.pricingSnapshot, input.pricingSnapshot) &&
      record.idempotencyKey === input.idempotencyKey && record.requestHash === input.requestHash &&
      record.operation === input.operation && record.prompt === input.prompt &&
      record.providerCreatedAt === input.providerCreatedAt &&
      record.attachmentId === candidate.attachmentId && record.ordinal === candidate.ordinal &&
      record.width === candidate.width && record.height === candidate.height &&
      record.revisedPrompt === (candidate.revisedPrompt ?? null) &&
      record.inputs.length === sources.length && [...record.inputs].sort(generatedInputOrder)
      .every((source, sourceIndex) => {
        const expected = [...sources].sort(generatedInputOrder)[sourceIndex];
        return source.attachmentId === expected.attachmentId && source.role === expected.role &&
          source.ordinal === expected.ordinal && source.width === expected.width &&
          source.height === expected.height &&
          (source.hasAlpha ?? null) === (expected.hasAlpha ?? null);
      });
  });
}

export function usagePricingSnapshotsEqual(
  left: UsagePricingSnapshot | undefined,
  right: UsagePricingSnapshot | undefined,
): boolean {
  return Boolean(left && right) && left!.pricingVersionId === right!.pricingVersionId &&
    left!.inputMicrosPerMillion === right!.inputMicrosPerMillion &&
    left!.cachedInputMicrosPerMillion === right!.cachedInputMicrosPerMillion &&
    left!.reasoningMicrosPerMillion === right!.reasoningMicrosPerMillion &&
    left!.outputMicrosPerMillion === right!.outputMicrosPerMillion &&
    left!.fixedCallMicros === right!.fixedCallMicros && left!.source === right!.source;
}

function generatedInputOrder(a: GeneratedAssetInput, b: GeneratedAssetInput): number {
  return a.role.localeCompare(b.role) || a.ordinal - b.ordinal ||
    a.attachmentId.localeCompare(b.attachmentId);
}

export type KnowledgeRetrievalMode = "retrieval" | "full_context";
export interface KnowledgeCollection {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface CreateKnowledgeCollectionInput {
  name: string;
  description?: string;
  idempotencyKey: string;
}
export interface KnowledgeCollectionPatch {
  name?: string;
  description?: string;
  expectedVersion: number;
}
export interface KnowledgeConversationBinding {
  conversationId: string;
  collectionId: string;
  ownerId: string;
  mode: KnowledgeRetrievalMode;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ReplaceConversationKnowledgeInput {
  collectionIds: string[];
  mode: KnowledgeRetrievalMode;
}

export interface AppendMessageInput {
  conversationId: string;
  ownerId: string;
  parentId: string | null;
  supersedesId?: string | null;
  role: MessageRole;
  content: string;
  model?: string;
  expectedVersion: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface CreateApiTokenInput {
  name: string;
  scopes: string[];
  tokenHash: string;
  preview: string;
  expiresAt?: string | null;
  rpmLimit?: number | null;
  burstLimit?: number | null;
}
export interface UpdateApiTokenInput {
  expectedVersion: number;
  name?: string;
  scopes?: string[];
  expiresAt?: string | null;
  rpmLimit?: number | null;
  burstLimit?: number | null;
}
export interface RotateApiTokenInput {
  expectedVersion: number;
  tokenHash: string;
  preview: string;
  overlapSeconds: number;
}
export interface RotatedApiToken {
  previous: ApiTokenSummary;
  replacement: ApiTokenSummary;
}
export interface TokenAccessSubject {
  userId: string;
  tokenId?: string | null;
}
export interface ModelAlias {
  id: string;
  alias: string;
  targetModelId: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateModelAliasInput {
  alias: string;
  targetModelId: string;
  description?: string;
}
export interface UpdateModelAliasInput {
  expectedVersion: number;
  alias?: string;
  targetModelId?: string;
  description?: string;
}
export interface AccessGroup {
  id: string;
  name: string;
  description: string;
  version: number;
  userIds: string[];
  modelIds: string[];
  tokenIds: string[];
  tokenOwners: Array<{ tokenId: string; ownerId: string }>;
  createdAt: string;
  updatedAt: string;
}
export interface CreateAccessGroupInput {
  name: string;
  description?: string;
  /** Initial policy subjects. Omitted arrays preserve the legacy empty-group behavior. */
  userIds?: string[];
  modelIds?: string[];
  tokenIds?: string[];
}
export interface UpdateAccessGroupInput {
  expectedVersion: number;
  name?: string;
  description?: string;
}
export interface ReplaceAccessGroupPolicyInput extends UpdateAccessGroupInput {
  userIds: string[];
  modelIds: string[];
  tokenIds: string[];
  acknowledgePublicModelIds: string[];
}
export interface AccessGroupPolicyProposal {
  userIds: string[];
  modelIds: string[];
  tokenIds: string[];
}
export interface AccessGroupPolicyImpact {
  modelIdsBecomingPublic: string[];
  tokenIdsLosingGroupAccess: string[];
  tokenIdsRevertingToOwnerInheritance: string[];
}

/**
 * Canonicalizes an acknowledgement as a mathematical set. Callers use the same representation
 * for both the locked impact and the supplied acknowledgement so neither ordering nor duplicate
 * JSON entries can create a false mismatch.
 */
export function normalizeModelAccessWideningAcknowledgement(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

export function modelAccessWideningAcknowledgementMatches(
  actualModelIds: readonly string[],
  acknowledgedModelIds: readonly string[],
): boolean {
  const actual = normalizeModelAccessWideningAcknowledgement(actualModelIds);
  const acknowledged = normalizeModelAccessWideningAcknowledgement(acknowledgedModelIds);
  return actual.length === acknowledged.length &&
    actual.every((modelId, index) => modelId === acknowledged[index]);
}
export interface EntitledProviderModel {
  model: ProviderModelRecord;
  alias: ModelAlias | null;
  matchedGroupIds: string[];
}
export interface AdminTokenLookupItem {
  id: string;
  name: string;
  preview: string;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  version: number;
  groupIds: string[];
  revokedAt: string | null;
  accessMode: "inherit" | "restricted";
}
export interface AdminTokenLookupPage {
  data: AdminTokenLookupItem[];
  nextCursor: string | null;
}

/** Immutable effective pricing copied onto a usage run when credit is reserved. */
export interface UsagePricingSnapshot {
  pricingVersionId: string;
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  reasoningMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  fixedCallMicros: number;
  source: string;
}

export function isUsagePricingSnapshot(value: unknown): value is UsagePricingSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  const amounts = [
    snapshot.inputMicrosPerMillion,
    snapshot.cachedInputMicrosPerMillion,
    snapshot.reasoningMicrosPerMillion,
    snapshot.outputMicrosPerMillion,
    snapshot.fixedCallMicros,
  ];
  return typeof snapshot.pricingVersionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      snapshot.pricingVersionId,
    ) && amounts.every((amount) => Number.isSafeInteger(amount) && Number(amount) >= 0) &&
    typeof snapshot.source === "string" && snapshot.source.length >= 1 &&
    snapshot.source.length <= 120;
}

export interface BeginGenerationInput {
  message: AppendMessageInput;
  attachmentIds?: string[];
  runId: string;
  provider: string;
  reserveMicros: number;
  pricingSnapshot?: UsagePricingSnapshot;
  tokenId?: string;
  leaseSeconds?: number;
  generationId?: string;
}
export interface BeginAssistantGenerationInput {
  conversationId: string;
  ownerId: string;
  sourceAssistantId: string;
  mode: "regenerate" | "continue";
  model: string;
  expectedVersion: number;
  idempotencyKey: string;
  runId: string;
  provider: string;
  reserveMicros: number;
  pricingSnapshot?: UsagePricingSnapshot;
  leaseSeconds?: number;
  generationId: string;
}
export interface CompleteGenerationInput {
  conversationId: string;
  ownerId: string;
  userMessageId: string;
  runId: string;
  leaseToken: string;
  idempotencyKey: string;
  content: string;
  model: string;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  metadata?: Record<string, unknown>;
  status?: "complete" | "stopped";
  supersedesId?: string | null;
}
export interface FailGenerationInput {
  conversationId: string;
  ownerId: string;
  userMessageId: string;
  runId: string;
  leaseToken: string;
  idempotencyKey: string;
  model: string;
  error: string;
  content?: string;
  metadata?: Record<string, unknown>;
  supersedesId?: string | null;
}
export interface GenerationResult {
  message: MessageNode;
  conversation: Conversation;
  usageRun: UsageRun;
}
export interface GenerationControl {
  runId: string;
  generationId: string;
  conversationId: string;
  ownerId: string;
  userMessageId: string;
  mode: "send" | "regenerate" | "continue";
  sourceMessageId: string | null;
  stopRequestedAt: string | null;
  terminalAt: string | null;
}
export type BeginGenerationResult =
  | (GenerationResult & { kind: "started" | "claimed"; leaseToken: string })
  | (GenerationResult & { kind: "completed" })
  | (GenerationResult & { kind: "in_progress"; retryAfterSeconds: number });
export interface ConversationPatch {
  expectedVersion: number;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
}
export type LifecycleConversation = Conversation;
export type LifecycleConversationDetail = ConversationDetail;
export interface PurgeTemporaryConversationsInput {
  /** Omit only from trusted maintenance code to purge across owners. */
  ownerId?: string;
  limit?: number;
  /** Injectable cutoff for deterministic maintenance jobs and tests. */
  now?: string;
}
export interface PurgeTemporaryConversationsResult {
  conversationIds: string[];
}
/** Locale-independent workspace identity: display Unicode is preserved; ASCII case is folded. */
export function canonicalWorkspaceName(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
export type UserPreferencesPatch =
  & Partial<
    Pick<
      UserPreferences,
      | "theme"
      | "compactConversations"
      | "reduceMotion"
      | "customInstructions"
      | "useMemory"
      | "saveHistory"
      | "preferredModelId"
    >
  >
  & { expectedVersion: number };
export interface WorkspaceList {
  folders: ConversationFolder[];
  memberships: ConversationFolderMembership[];
}
export interface TagList {
  tags: ConversationTag[];
  bindings: ConversationTagBinding[];
  tagSets: ConversationTagSet[];
}
export interface AdminSummary {
  calls: number;
  users: number;
  balanceMicros: number;
}
export type AnalyticsBucket = "hour" | "day";
export type AdminAnalyticsStatus = "reserved" | "completed" | "failed";
export interface AdminAnalyticsQuery {
  from: string;
  to: string;
  bucket: AnalyticsBucket;
  userId?: string;
  model?: string;
  provider?: string;
  status?: AdminAnalyticsStatus;
}
export interface AdminAnalyticsSummary {
  calls: number;
  completed: number;
  failed: number;
  successRate: number;
  inputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  customerCostMicros: number;
  providerCostMicros: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  avgTtftMs: number | null;
}
export interface AdminAnalyticsPoint {
  start: string;
  calls: number;
  completed: number;
  failed: number;
  customerCostMicros: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
}
export interface AdminAnalyticsDistribution {
  key: string;
  calls: number;
  customerCostMicros: number;
}
export interface AdminAnalytics {
  query: AdminAnalyticsQuery;
  summary: AdminAnalyticsSummary;
  points: AdminAnalyticsPoint[];
  models: AdminAnalyticsDistribution[];
  providers: AdminAnalyticsDistribution[];
  statuses: AdminAnalyticsDistribution[];
}
export type AdminJobStatus = "queued" | "running" | "completed" | "failed";
export interface AdminJobQuery {
  status?: AdminJobStatus;
  type?: string;
  cursor?: string;
  limit?: number;
}
export interface AdminJobSummary {
  id: string;
  type: string;
  status: AdminJobStatus;
  attempts: number;
  availableAt: string;
  lockedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  lastError: string | null;
}
export interface AdminJobPage {
  items: AdminJobSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  hasPrevious: boolean;
}
export interface RetriedAdminJob {
  job: AdminJobSummary;
  priorAttempts: number;
}
export interface AdminWorkerInstance {
  instanceId: string;
  workerName: string;
  state: "starting" | "running" | "draining" | "stopped";
  startedAt: string;
  heartbeatAt: string;
  progressAt: string;
  heartbeatAgeMs: number;
  progressAgeMs: number;
  heartbeatStaleMs: number;
  progressStaleMs: number;
  healthClockToleranceMs: number;
  liveness: "fresh" | "heartbeat_stale" | "progress_stalled" | "inactive";
  currentJobId: string | null;
  currentJobType: string | null;
  lastCompletedAt: string | null;
  lastCompletedJobId: string | null;
  lastCompletedJobType: string | null;
}
export type AdminWorkerScope = "active" | "history" | "all";
export interface AdminWorkerQuery {
  scope?: AdminWorkerScope;
  cursor?: string;
  limit?: number;
}
export interface AdminWorkerPage {
  items: AdminWorkerInstance[];
  scope: AdminWorkerScope;
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}
export type RetentionDays = 1 | 7 | 14 | 30 | 90;
export interface RetentionPolicy {
  version: number;
  captureEnabled: boolean;
  requestBodyDays: RetentionDays;
  responseBodyDays: RetentionDays;
  updatedAt: string;
  updatedBy: string | null;
}
export interface UpdateRetentionPolicyInput {
  expectedVersion: number;
  captureEnabled: boolean;
  requestBodyDays: RetentionDays;
  responseBodyDays: RetentionDays;
}
export interface ProviderPayloadCaptureInput {
  usageRunId: string;
  providerAttemptId: string;
  requestBody?: string | null;
  responseBody?: string | null;
}
export interface ProviderPayloadCapture {
  id: string;
  usageRunId: string;
  providerAttemptId: string;
  requestBody: string | null;
  responseBody: string | null;
  requestBytes: number;
  responseBytes: number;
  capturedAt: string;
  scrubbedAt: string | null;
}
export interface RetentionPreview {
  policyVersion: number;
  requestCutoffAt: string;
  responseCutoffAt: string;
  captures: number;
  requestBodies: number;
  responseBodies: number;
  requestBytes: number;
  responseBytes: number;
}
export type RetentionScrubStatus = "queued" | "running" | "completed" | "failed";
export type RetentionScrubFailureCode =
  | "worker_retry_exhausted"
  | "invalid_job_payload"
  | "manual_recovery";
export interface RetentionScrubRun {
  id: string;
  idempotencyKey: string;
  status: RetentionScrubStatus;
  policy: RetentionPolicy;
  requestCutoffAt: string;
  responseCutoffAt: string;
  capturesScrubbed: number;
  requestBodiesScrubbed: number;
  responseBodiesScrubbed: number;
  bytesScrubbed: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}
export interface RetentionScrubQuery {
  status?: RetentionScrubStatus;
  limit?: number;
}
export interface RetentionScrubPage {
  items: RetentionScrubRun[];
}
export interface RetentionScrubBatchResult {
  run: RetentionScrubRun;
  processed: number;
  completed: boolean;
}
export interface EnqueueRetentionScrubInput {
  idempotencyKey: string;
  expectedPolicyVersion: number;
  requestCutoffAt: string;
  responseCutoffAt: string;
}
export interface ScheduleRetentionScrubInput {
  /** Durable cadence. Production configuration is bounded to five minutes through thirty days. */
  intervalSeconds: number;
  /** Injectable only so memory and PostgreSQL implementations can exercise identical boundaries. */
  now?: string;
}
export type RetentionScheduleReason = "interval_due" | "policy_changed";
export interface RetentionScheduleResult {
  scheduled: boolean;
  reason: RetentionScheduleReason | null;
  run: RetentionScrubRun | null;
  intervalSeconds: number;
  nextDueAt: string;
  /** How late the due slot was when this scheduling transaction began. */
  overdueSeconds: number;
}
export type ApiIdempotencyEndpoint =
  | "chat.completions"
  | "responses"
  | "embeddings"
  | "files"
  | "images.generations"
  | "images.edits"
  | "audio.transcriptions"
  | "audio.translations"
  | "audio.speech";
export type ApiIdempotencyState = "in_progress" | "completed" | "failed";
export type ApiResponseBodyEncoding = "utf8" | "base64";
export class InvalidApiResponseBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiResponseBodyError";
  }
}

/**
 * Returns the public response body's decoded byte length and rejects non-canonical Base64.
 * Keeping this validation in the repository makes replay quotas independent of storage encoding.
 */
export function apiResponseBodyByteLength(
  body: string,
  encoding: ApiResponseBodyEncoding = "utf8",
): number {
  if (encoding === "utf8") return new TextEncoder().encode(body).byteLength;
  if (
    body.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)
  ) throw new InvalidApiResponseBodyError("Binary replay body is not valid Base64");
  let decoded: string;
  try {
    decoded = atob(body);
  } catch {
    throw new InvalidApiResponseBodyError("Binary replay body is not valid Base64");
  }
  if (btoa(decoded) !== body) {
    throw new InvalidApiResponseBodyError("Binary replay body is not canonical Base64");
  }
  return decoded.length;
}

export function decodeApiResponseBody(
  body: string,
  encoding: ApiResponseBodyEncoding = "utf8",
): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(body);
  apiResponseBodyByteLength(body, encoding);
  const decoded = atob(body);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}
export interface ApiIdempotencyFrame {
  sequence: number;
  frame: string;
  createdAt: string;
}
export interface ApiUsageObservation {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
}
export interface ApiReplayQuota {
  maxRequests: number;
  maxBytes: number;
  maxEvents: number;
}
export const API_SSE_REPLAY_FRAGMENT_MAX_BYTES = 1_048_576;
export const API_SSE_REPLAY_REQUEST_MAX_BYTES = 268_435_456;
export const API_SSE_REPLAY_REQUEST_MAX_EVENTS = 20_000;
export const DEFAULT_API_REPLAY_QUOTA: Readonly<ApiReplayQuota> = {
  maxRequests: 256,
  maxBytes: 67_108_864,
  maxEvents: 20_000,
};

export const ABANDONED_API_ERROR_BODY = JSON.stringify({
  error: {
    message: "Request interrupted before completion",
    type: "server_error",
    param: null,
    code: "request_abandoned",
  },
});

export interface AbandonedApiReplayPlanInput {
  endpoint: ApiIdempotencyEndpoint;
  eventCount: number;
  eventBytes: number;
  replayReservedBytes: number;
  replayReservedEvents: number;
  aggregateBytes: number;
  aggregateEvents: number;
  quota?: ApiReplayQuota;
}

/**
 * Plans crash-recovery storage without violating replay limits. When an interrupted
 * stream has exhausted its reservation, the bounded fallback retains its immutable
 * prefix and closes it without manufacturing an event or JSON body beyond capacity.
 */
export function planAbandonedApiReplay(
  input: AbandonedApiReplayPlanInput,
): { responseBody: string | null; terminalFrame: string | null } {
  const encoder = new TextEncoder();
  const quota = input.quota ?? DEFAULT_API_REPLAY_QUOTA;
  const hasStreamPrefix = input.eventCount > 0;
  const terminalFrame = hasStreamPrefix
    ? input.endpoint === "responses"
      ? `event: error\ndata: ${ABANDONED_API_ERROR_BODY}\n\n`
      : `data: ${ABANDONED_API_ERROR_BODY}\n\n`
    : null;
  const candidates = hasStreamPrefix
    ? [
      { responseBody: ABANDONED_API_ERROR_BODY, terminalFrame },
      { responseBody: null, terminalFrame },
      { responseBody: null, terminalFrame: null },
    ]
    : [
      { responseBody: ABANDONED_API_ERROR_BODY, terminalFrame: null },
      { responseBody: null, terminalFrame: null },
    ];
  const reserved = input.replayReservedBytes > 0 || input.replayReservedEvents > 0;
  for (const candidate of candidates) {
    const bodyBytes = candidate.responseBody === null
      ? 0
      : encoder.encode(candidate.responseBody).length;
    const frameBytes = candidate.terminalFrame === null
      ? 0
      : encoder.encode(candidate.terminalFrame).length;
    const addedEvents = candidate.terminalFrame === null ? 0 : 1;
    if (
      bodyBytes > API_SSE_REPLAY_REQUEST_MAX_BYTES ||
      input.eventCount + addedEvents > API_SSE_REPLAY_REQUEST_MAX_EVENTS ||
      input.eventBytes + frameBytes > API_SSE_REPLAY_REQUEST_MAX_BYTES
    ) continue;
    if (reserved) {
      if (
        input.eventCount + addedEvents > input.replayReservedEvents ||
        input.eventBytes + bodyBytes + frameBytes > input.replayReservedBytes
      ) continue;
    } else if (
      input.aggregateEvents + addedEvents > quota.maxEvents ||
      input.aggregateBytes + bodyBytes + frameBytes > quota.maxBytes
    ) continue;
    return candidate;
  }
  // The final candidate adds no storage and therefore always fits valid persisted state.
  return { responseBody: null, terminalFrame: null };
}

/** Splits replay records without changing their exact string concatenation. */
export function splitApiSseReplayFrame(
  frame: string,
  maximumBytes = API_SSE_REPLAY_FRAGMENT_MAX_BYTES,
): string[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) {
    throw new TypeError("SSE replay fragment size must be an integer of at least four bytes");
  }
  if (frame.length === 0) return [""];
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < frame.length;) {
    const first = frame.charCodeAt(index);
    const paired = first >= 0xd800 && first <= 0xdbff && index + 1 < frame.length &&
      frame.charCodeAt(index + 1) >= 0xdc00 && frame.charCodeAt(index + 1) <= 0xdfff;
    const width = paired ? 2 : 1;
    const codePoint = paired ? frame.codePointAt(index)! : first;
    const encodedBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
      ? 2
      : codePoint <= 0xffff
      ? 3
      : 4;
    if (bytes + encodedBytes > maximumBytes) {
      chunks.push(frame.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += encodedBytes;
    index += width;
  }
  chunks.push(frame.slice(start));
  return chunks;
}
export interface ApiSseFrameInput {
  sequence: number;
  frame: string;
}
export interface ApiIdempotencyRequest {
  id: string;
  userId: string;
  endpoint: ApiIdempotencyEndpoint;
  idempotencyKey: string;
  requestHash: string;
  stream: boolean;
  model: string;
  state: ApiIdempotencyState;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  usageRunId: string;
  replayReservedBytes: number;
  replayReservedEvents: number;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  responseBodyEncoding: ApiResponseBodyEncoding;
  failureStartedStream: boolean;
  observedInputTokens: number;
  observedOutputTokens: number;
  observedCostMicros: number;
  observedLatencyMs: number;
  retentionSeconds: number;
  frames: ApiIdempotencyFrame[];
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
}
export interface BeginApiRequestInput {
  userId: string;
  endpoint: ApiIdempotencyEndpoint;
  idempotencyKey: string;
  requestHash: string;
  stream: boolean;
  model: string;
  runId: string;
  reserveMicros: number;
  pricingSnapshot?: UsagePricingSnapshot;
  provider: string;
  tokenId?: string;
  leaseSeconds?: number;
  retentionSeconds?: number;
  quota?: ApiReplayQuota;
  replayReservedBytes?: number;
  replayReservedEvents?: number;
}
export type BeginApiRequestResult =
  | { kind: "started"; request: ApiIdempotencyRequest; leaseToken: string; usageRun: UsageRun }
  | { kind: "completed" | "failed"; request: ApiIdempotencyRequest }
  | { kind: "in_progress"; request: ApiIdempotencyRequest; retryAfterSeconds: number };
export interface CompleteApiRequestInput {
  id: string;
  leaseToken: string;
  responseStatus: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyEncoding?: ApiResponseBodyEncoding;
  frames?: ApiSseFrameInput[];
  terminalFrame?: string;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  quota?: ApiReplayQuota;
}
export interface FailApiRequestInput {
  id: string;
  leaseToken: string;
  responseStatus: number;
  responseHeaders?: Record<string, string>;
  responseBody: string;
  terminalFrame?: string;
  quota?: ApiReplayQuota;
  billing: { mode: "refund" } | {
    mode: "settle";
    costMicros: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
}

export type ProviderProtocol = "chat_completions" | "responses";
export type ProviderHealthStatus = "unknown" | "healthy" | "unhealthy" | "disabled";
export interface RegistryMutationContext {
  actorId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
}
/** Public provider shape. The encrypted credential envelope is intentionally absent. */
export interface ProviderRecord {
  id: string;
  slug: string;
  displayName: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  version: number;
  hasCredential: boolean;
  credentialUpdatedAt: string | null;
  healthStatus: ProviderHealthStatus;
  healthCheckedAt: string | null;
  healthLatencyMs: number | null;
  healthError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CreateProviderInput {
  slug: string;
  displayName: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled?: boolean;
}
export interface UpdateProviderInput {
  slug?: string;
  displayName?: string;
  baseUrl?: string;
  protocol?: ProviderProtocol;
  enabled?: boolean;
  healthStatus?: ProviderHealthStatus;
  healthCheckedAt?: string | null;
  healthLatencyMs?: number | null;
  healthError?: string | null;
}
export interface ProviderCredentialEnvelope {
  version: 1;
  algorithm: "AES-256-GCM";
  keyId: string;
  credentialVersion: number;
  wrappedKeyNonce: string;
  wrappedKey: string;
  contentNonce: string;
  ciphertext: string;
}
export interface ProviderCredentialMutation {
  envelope: ProviderCredentialEnvelope;
}
/** Privileged persistence-only credential accessor. Never serialize this value to clients. */
export interface StoredProviderCredential {
  providerId: string;
  envelope: ProviderCredentialEnvelope;
}
export interface ProviderModelRecord {
  id: string;
  providerId: string;
  publicModelId: string;
  upstreamModelId: string;
  displayName: string;
  capabilities: ModelCapability[];
  contextWindow: number;
  enabled: boolean;
  version: number;
  customParams: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface CreateProviderModelInput {
  providerId: string;
  publicModelId: string;
  upstreamModelId: string;
  displayName: string;
  capabilities: ModelCapability[];
  contextWindow: number;
  enabled?: boolean;
  customParams?: Record<string, unknown>;
}
export interface UpdateProviderModelInput {
  publicModelId?: string;
  upstreamModelId?: string;
  displayName?: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
  enabled?: boolean;
  customParams?: Record<string, unknown>;
}
export interface ModelPriceVersion {
  id: string;
  providerModelId: string;
  effectiveAt: string;
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  reasoningMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  fixedCallMicros: number;
  source: string;
  createdAt: string;
}
export interface CreateModelPriceVersionInput {
  providerModelId: string;
  expectedModelVersion: number;
  effectiveAt: string;
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  reasoningMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  fixedCallMicros: number;
  source: string;
}

export interface ProviderRetryPolicy {
  id: string;
  name: string;
  enabled: boolean;
  maxAttempts: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplierBps: number;
  jitterBps: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  retryableStatuses: number[];
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateProviderRetryPolicyInput {
  name: string;
  enabled?: boolean;
  maxAttempts: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplierBps: number;
  jitterBps: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  retryableStatuses: number[];
}
export type UpdateProviderRetryPolicyInput = Partial<CreateProviderRetryPolicyInput>;

export interface ProviderModelRoute {
  id: string;
  sourceModelId: string;
  retryPolicyId: string | null;
  fallbackModelIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface SetProviderModelRouteInput {
  sourceModelId: string;
  expectedVersion: number;
  retryPolicyId?: string | null;
  fallbackModelIds: string[];
}
export interface ProviderExecutionTarget {
  ordinal: number;
  providerId: string;
  providerSlug: string;
  providerVersion: number;
  protocol: ProviderProtocol;
  providerModelId: string;
  publicModelId: string;
  upstreamModelId: string;
  modelVersion: number;
  pricing: UsagePricingSnapshot;
}
export interface ProviderExecutionPlan {
  sourceModelId: string;
  routeId: string | null;
  routeVersion: number;
  retryPolicy: ProviderRetryPolicy | null;
  targets: ProviderExecutionTarget[];
  resolvedAt: string;
}

export type ProviderAttemptStatus = "running" | "succeeded" | "failed" | "cancelled" | "skipped";
export type ProviderAttemptPhase =
  | "planning"
  | "connect"
  | "headers"
  | "first_token"
  | "streaming"
  | "complete";
export type ProviderTokenSource = "provider" | "estimated" | "none";
export type ProviderCostSource = "provider" | "calculated" | "none";
export type ProviderAttemptReason = "primary" | "retry" | "fallback" | "circuit_skip" | "half_open";
export type ProviderBreakerState = "closed" | "open" | "half_open" | "unavailable";
export interface ProviderAttempt {
  id: string;
  usageRunId: string;
  attemptNumber: number;
  executionEpoch: number;
  targetOrdinal: number;
  retryNumber: number;
  reason: ProviderAttemptReason;
  breakerBefore: ProviderBreakerState | null;
  breakerAfter: ProviderBreakerState | null;
  retryable: boolean;
  providerId: string;
  providerSlug: string;
  providerVersion: number;
  protocol: ProviderProtocol;
  providerModelId: string;
  publicModelId: string;
  upstreamModelId: string;
  modelVersion: number;
  pricing: UsagePricingSnapshot;
  status: ProviderAttemptStatus;
  phase: ProviderAttemptPhase;
  errorCode: string | null;
  httpStatus: number | null;
  visibleOutput: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  costMicros: number;
  tokenSource: ProviderTokenSource;
  costSource: ProviderCostSource;
  latencyMs: number | null;
  ttftMs: number | null;
  upstreamRequestId: string | null;
  tokensPerSecond: number | null;
  startedAt: string;
  completedAt: string | null;
}
export interface StartProviderAttemptInput extends
  Omit<
    ProviderExecutionTarget,
    "ordinal"
  > {
  usageRunId: string;
  ownerLeaseToken: string;
  executionEpoch: number;
  attemptNumber: number;
  targetOrdinal: number;
  retryNumber: number;
  reason: ProviderAttemptReason;
  breakerBefore?: ProviderBreakerState | null;
}
export interface FinishProviderAttemptInput {
  id: string;
  ownerLeaseToken: string;
  executionEpoch: number;
  status: Exclude<ProviderAttemptStatus, "running">;
  phase: ProviderAttemptPhase;
  errorCode?: string | null;
  httpStatus?: number | null;
  visibleOutput: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  costMicros: number;
  tokenSource: ProviderTokenSource;
  costSource: ProviderCostSource;
  latencyMs: number;
  ttftMs?: number | null;
  breakerAfter?: ProviderBreakerState | null;
  retryable: boolean;
  upstreamRequestId?: string | null;
  tokensPerSecond?: number | null;
}
export interface ProviderExecutionClaim {
  usageRunId: string;
  executionEpoch: number;
  nextAttemptNumber: number;
  /** Physical upstream calls already started across every lease epoch. */
  consumedAttempts: number;
  reconciledAttemptIds: string[];
}
export interface ProviderExecutionLease {
  leaseToken: string;
  leaseExpiresAt: string;
}
export interface FinalizeProviderUsageInput {
  usageRunId: string;
  ownerLeaseToken: string;
  executionEpoch: number;
  latencyMs: number;
  error?: string | null;
}

export interface ReserveChildProviderUsageInput {
  parentUsageRunId: string;
  parentOwnerLeaseToken: string;
  runId: string;
  model: string;
  provider: string;
  reserveMicros: number;
  pricingSnapshot: UsagePricingSnapshot;
}

export interface EnsureUsageReservationInput {
  usageRunId: string;
  ownerLeaseToken: string;
  requiredMicros: number;
}

export interface EnsureIdempotentReservationInput {
  userId: string;
  usageRunId: string;
  model: string;
  provider: string;
  reservedMicros: number;
  recoveryOwner: UsageRecoveryOwner;
}

export type UsageRecoveryOwner =
  | "provider"
  | "api_replay"
  | "document_embedding"
  | "tool";

/** Persistence boundary shared by synchronous test stores and async production stores. */
export interface DomainRepository {
  readonly storageKind: "postgres" | "memory";
  close(): MaybePromise<void>;
  /** Creates the first administrator, credit grant, and bootstrap audit as one transaction. */
  bootstrapAdmin(input: CreateUserInput, startingCreditMicros: number): MaybePromise<StoredUser>;
  createUser(input: CreateUserInput): MaybePromise<StoredUser>;
  findUser(id: string): MaybePromise<StoredUser | undefined>;
  findUserByEmail(email: string): MaybePromise<StoredUser | undefined>;
  listUsers(): MaybePromise<PublicUser[]>;
  listAdminUsers(query?: AdminUserQuery): MaybePromise<AdminUserPage>;
  getAdminUser(id: string): MaybePromise<AdminUser>;
  createSession(
    userId: string,
    tokenHash: string,
    limited: boolean,
    expectedAuthorityEpoch?: number,
  ): MaybePromise<StoredSession>;
  getSession(tokenHash: string): MaybePromise<StoredSession | undefined>;
  invalidateUserSessions(userId: string): MaybePromise<void>;
  deleteSession(tokenHash: string): MaybePromise<void>;
  listSessions(userId: string): MaybePromise<SessionSummary[]>;
  revokeSession(id: string, ownerId?: string): MaybePromise<void>;
  listAdminUserSessions(
    actorId: string,
    targetUserId: string,
    query?: AdminSessionQuery,
    currentSession?: AdminSessionRevocationCommand["currentSession"],
  ): MaybePromise<AdminSessionPage>;
  listAdminUserTokens(
    actorId: string,
    targetUserId: string,
    query?: AdminApiTokenQuery,
  ): MaybePromise<AdminApiTokenPage>;
  listAdminUserLedger(
    actorId: string,
    targetUserId: string,
    query?: AdminLedgerQuery,
  ): MaybePromise<AdminLedgerPage>;
  revokeAdminUserSession(input: AdminSessionRevocationCommand): MaybePromise<void>;
  revokeAdminUserTokenFamily(input: AdminApiTokenRevocationCommand): MaybePromise<void>;
  adjustAdminUserBalance(
    input: AdminBalanceAdjustmentCommand,
  ): MaybePromise<AdminBalanceAdjustment>;
  createIdentityToken(
    userId: string,
    purpose: IdentityTokenPurpose,
    tokenHash: string,
    expiresAt: string,
    expectedAuthorityEpoch: number,
  ): MaybePromise<void>;
  /** Consumes the token, verifies the identity, and appends its audit as one transaction. */
  verifyEmail(tokenHash: string): MaybePromise<StoredUser>;
  markUserEmailVerified(userId: string): MaybePromise<StoredUser>;
  /** Changes the credential, revokes prior authority, and appends its audit as one transaction. */
  resetPassword(tokenHash: string, passwordHash: string): MaybePromise<StoredUser>;
  /** Better Auth equivalent of resetPassword, with the same transactional audit invariant. */
  resetBetterAuthPassword(token: string, passwordHash: string): MaybePromise<StoredUser>;
  recordAudit(input: AuditEventInput): MaybePromise<AuditEvent>;
  listAudit(query?: AuditQuery): MaybePromise<AuditPage>;
  decideUserApproval(input: AdminApprovalCommand): MaybePromise<AdminUser>;
  setAdminUserRole(input: AdminRoleCommand): MaybePromise<AdminUser>;
  setAdminUserState(input: AdminStateCommand): MaybePromise<AdminUser>;
  setAdminUserDeleted(input: AdminDeletionCommand): MaybePromise<AdminUser>;
  createConversation(
    ownerId: string,
    title: string,
    temporary?: boolean,
    idempotencyKey?: string,
    temporaryRetentionDays?: number,
  ): MaybePromise<LifecycleConversation>;
  listConversations(
    ownerId: string,
    includeDeleted?: boolean,
  ): MaybePromise<LifecycleConversation[]>;
  searchConversations(
    ownerId: string,
    query: ConversationSearchQuery,
    signal?: AbortSignal,
  ): MaybePromise<ConversationSearchPage>;
  updateConversation(
    ownerId: string,
    id: string,
    patch: ConversationPatch,
  ): MaybePromise<LifecycleConversation>;
  detail(id: string, ownerId: string): MaybePromise<LifecycleConversationDetail>;
  promoteTemporaryConversation(
    ownerId: string,
    id: string,
    expectedVersion: number,
  ): MaybePromise<LifecycleConversation>;
  purgeExpiredTemporaryConversations(
    input: PurgeTemporaryConversationsInput,
  ): MaybePromise<PurgeTemporaryConversationsResult>;
  getUserPreferences(ownerId: string): MaybePromise<UserPreferences>;
  exportConversationPortability(
    ownerId: string,
    options?: ConversationPortabilityExportOptions,
  ): MaybePromise<ConversationPortabilityV1>;
  importConversationPortability(
    ownerId: string,
    archive: ConversationPortabilityV1,
    idempotencyKey: string,
    dryRun?: boolean,
  ): MaybePromise<ConversationPortabilityImportResult>;
  createConversationShare(
    ownerId: string,
    input: CreateConversationShareInput,
  ): MaybePromise<CreateConversationShareResult>;
  listConversationShares(ownerId: string): MaybePromise<ConversationShareSummary[]>;
  getConversationShare(
    ownerId: string,
    shareId: string,
  ): MaybePromise<ConversationShareSummary>;
  revokeConversationShare(
    ownerId: string,
    shareId: string,
    expectedVersion: number,
  ): MaybePromise<ConversationShareSummary>;
  resolvePublicConversationShare(
    secretHash: string,
    now?: string,
  ): MaybePromise<PublicConversationShare | undefined>;
  resolvePublicShareAttachment(
    secretHash: string,
    publicAttachmentId: string,
    now?: string,
  ): MaybePromise<ConversationShareAttachmentAccess | undefined>;
  updateUserPreferences(
    ownerId: string,
    patch: UserPreferencesPatch,
  ): MaybePromise<UserPreferences>;
  listConversationFolders(ownerId: string): MaybePromise<WorkspaceList>;
  createConversationFolder(
    ownerId: string,
    name: string,
    idempotencyKey: string,
  ): MaybePromise<ConversationFolder>;
  updateConversationFolder(
    ownerId: string,
    id: string,
    name: string,
    expectedVersion: number,
  ): MaybePromise<ConversationFolder>;
  deleteConversationFolder(
    ownerId: string,
    id: string,
    expectedVersion: number,
    expectedMembershipVersion: number,
  ): MaybePromise<void>;
  reorderConversationFolders(
    ownerId: string,
    folderIds: string[],
    expectedVersions: Record<string, number>,
  ): MaybePromise<ConversationFolder[]>;
  replaceFolderMemberships(
    ownerId: string,
    folderId: string,
    conversationIds: string[],
    expectedMembershipVersions: Record<string, number>,
  ): MaybePromise<WorkspaceList>;
  listConversationTags(ownerId: string): MaybePromise<TagList>;
  createConversationTag(
    ownerId: string,
    name: string,
    color: string,
    idempotencyKey: string,
  ): MaybePromise<ConversationTag>;
  updateConversationTag(
    ownerId: string,
    id: string,
    patch: { name?: string; color?: string; expectedVersion: number },
  ): MaybePromise<ConversationTag>;
  deleteConversationTag(ownerId: string, id: string, expectedVersion: number): MaybePromise<void>;
  replaceConversationTags(
    ownerId: string,
    conversationId: string,
    tagIds: string[],
    expectedVersion: number,
  ): MaybePromise<{ tagSet: ConversationTagSet; bindings: ConversationTagBinding[] }>;
  appendMessage(input: AppendMessageInput): MaybePromise<MessageNode>;
  beginGeneration(input: BeginGenerationInput): MaybePromise<BeginGenerationResult>;
  beginAssistantGeneration(
    input: BeginAssistantGenerationInput,
  ): MaybePromise<BeginGenerationResult>;
  heartbeatGeneration(
    runId: string,
    ownerId: string,
    leaseToken: string,
    leaseSeconds?: number,
  ): MaybePromise<void>;
  requestGenerationStop(
    conversationId: string,
    ownerId: string,
    generationId: string,
  ): MaybePromise<GenerationControl>;
  generationStopRequested(
    runId: string,
    ownerId: string,
    leaseToken: string,
  ): MaybePromise<boolean>;
  completeGeneration(input: CompleteGenerationInput): MaybePromise<GenerationResult>;
  failGeneration(input: FailGenerationInput): MaybePromise<GenerationResult>;
  reapStaleGenerations(limit?: number): MaybePromise<number>;
  setActiveLeaf(
    conversationId: string,
    ownerId: string,
    leafId: string,
    expectedVersion: number,
  ): MaybePromise<Conversation>;
  createAttachment(
    input: CreateAttachmentInput,
    quota?: AttachmentStorageQuota,
  ): MaybePromise<CreateAttachmentResult>;
  /**
   * Atomically admits an attachment and binds it to a stored generated-object stage.
   * Callers must use this instead of publishing the attachment and stage in separate commits.
   */
  createAttachmentFromGeneratedObjectStage(
    id: string,
    ownerId: string,
    input: CreateAttachmentInput,
    quota?: AttachmentStorageQuota,
  ): MaybePromise<CreateAttachmentResult>;
  stageAttachmentUpload(
    input: StageAttachmentUploadInput,
    leaseSeconds: number,
  ): MaybePromise<AttachmentUploadStage>;
  heartbeatAttachmentUpload(
    id: string,
    ownerId: string,
    uploadLeaseToken: string,
    leaseSeconds: number,
  ): MaybePromise<AttachmentUploadStage>;
  markAttachmentUploadStored(
    id: string,
    ownerId: string,
    uploadLeaseToken: string,
    leaseSeconds: number,
  ): MaybePromise<AttachmentUploadStage>;
  createAttachmentFromUploadStage(
    id: string,
    ownerId: string,
    uploadLeaseToken: string,
    input: CreateAttachmentInput,
    quota?: AttachmentStorageQuota,
  ): MaybePromise<CreateAttachmentResult>;
  requestAttachmentUploadCleanup(
    id: string,
    ownerId: string,
    uploadLeaseToken: string,
    reason: string,
  ): MaybePromise<AttachmentUploadStage>;
  abandonAttachmentUpload(
    id: string,
    ownerId: string,
    reason: string,
  ): MaybePromise<AttachmentUploadStage>;
  stageFileUpload(input: StageFileUploadInput): MaybePromise<FileUploadStage>;
  markFileUploadStored(requestId: string, leaseToken: string): MaybePromise<FileUploadStage>;
  listStaleFileUploads(limit?: number): MaybePromise<StaleFileUpload[]>;
  attachmentObjectReferenceCount(objectKey: string): MaybePromise<number>;
  finalizeFileUpload(
    input: FinalizeFileUploadInput,
    quota?: AttachmentStorageQuota,
  ): MaybePromise<FinalizeFileUploadResult>;
  listAttachments(ownerId: string, includeDeleted?: boolean): MaybePromise<AttachmentRecord[]>;
  listAttachmentPage(
    ownerId: string,
    query: AttachmentListQuery,
  ): MaybePromise<AttachmentPage>;
  getAttachment(
    id: string,
    ownerId: string,
    includeDeleted?: boolean,
  ): MaybePromise<AttachmentRecord>;
  deleteAttachment(id: string, ownerId: string): MaybePromise<AttachmentRecord>;
  transitionAttachment(
    id: string,
    ownerId: string,
    expectedState: AttachmentState,
    nextState: AttachmentState,
    inspectionError?: string | null,
  ): MaybePromise<AttachmentRecord>;
  requestAttachmentReinspection(
    input: RequestAttachmentReinspectionInput,
  ): MaybePromise<AttachmentReinspectionResult>;
  transitionAttachmentInspection(
    input: TransitionAttachmentInspectionInput,
  ): MaybePromise<AttachmentRecord>;
  attachmentStorageUsage(ownerId: string): MaybePromise<AttachmentStorageUsage>;
  adminStorageSummary(actorId: string): MaybePromise<AdminStorageSummary>;
  listAdminAttachments(
    actorId: string,
    query: AdminAttachmentQuery,
  ): MaybePromise<AdminAttachmentPage>;
  linkAttachmentToMessage(
    messageId: string,
    attachmentId: string,
    ownerId: string,
  ): MaybePromise<void>;
  listMessageAttachments(messageId: string, ownerId: string): MaybePromise<AttachmentRecord[]>;
  finalizeGeneratedAssets(
    input: FinalizeGeneratedAssetsInput,
  ): MaybePromise<GeneratedAssetRecord[]>;
  listGeneratedAssets(
    ownerId: string,
    includeDeleted?: boolean,
  ): MaybePromise<GeneratedAssetRecord[]>;
  findGeneratedAssetByAttachment(
    ownerId: string,
    attachmentId: string,
    before?: string,
    excludeId?: string,
  ): MaybePromise<GeneratedAssetRecord | undefined>;
  findGeneratedAssetsByIdempotency(
    ownerId: string,
    idempotencyKey: string,
  ): MaybePromise<GeneratedAssetRecord[]>;
  getGeneratedAsset(
    id: string,
    ownerId: string,
    includeDeleted?: boolean,
  ): MaybePromise<GeneratedAssetRecord>;
  deleteGeneratedAsset(id: string, ownerId: string): MaybePromise<GeneratedAssetRecord>;
  restoreGeneratedAsset(id: string, ownerId: string): MaybePromise<GeneratedAssetRecord>;
  stageGeneratedObject(input: StageGeneratedObjectInput): MaybePromise<GeneratedObjectStage>;
  markGeneratedObjectStored(id: string, ownerId: string): MaybePromise<GeneratedObjectStage>;
  attachGeneratedObject(
    id: string,
    ownerId: string,
    attachmentId: string,
    cleanupAttachment?: boolean,
  ): MaybePromise<GeneratedObjectStage>;
  requestGeneratedObjectCleanup(
    ownerId: string,
    usageRunId: string,
    reason: string,
  ): MaybePromise<number>;
  /**
   * Settle a generated cleanup only after the object-store delete succeeds. Replays are
   * idempotent; cleanupAttachment=false stages never decrement retained-storage counters.
   */
  settleGeneratedObjectCleanup(
    stageId: string,
    ownerId: string,
  ): MaybePromise<GeneratedObjectCleanupSettlement>;
  beginAttachmentIngestion(id: string, ownerId: string): MaybePromise<AttachmentRecord>;
  completeAttachmentIngestion(
    id: string,
    ownerId: string,
    chunks: DocumentChunkInput[],
  ): MaybePromise<AttachmentRecord>;
  failAttachmentIngestion(
    id: string,
    ownerId: string,
    error: string,
  ): MaybePromise<AttachmentRecord>;
  retryAttachmentIngestion(id: string, ownerId: string): MaybePromise<AttachmentRecord>;
  listDocumentChunks(id: string, ownerId: string): MaybePromise<DocumentChunk[]>;
  upsertDocumentChunkEmbeddings(
    values: DocumentChunkEmbeddingInput[],
  ): MaybePromise<number>;
  startEmbeddingProviderAttempt(input: EmbeddingProviderAttemptInput): MaybePromise<void>;
  finishEmbeddingProviderAttempt(input: FinishEmbeddingProviderAttemptInput): MaybePromise<void>;
  /** Atomically finalizes the attempt, usage run, ledger, and balance; safe to replay. */
  finalizeEmbeddingProviderUsage(
    input: FinalizeEmbeddingProviderUsageInput,
  ): MaybePromise<UsageRun>;
  searchConversationKnowledge(
    input: SearchConversationKnowledgeInput,
  ): MaybePromise<KnowledgeSearchHit[]>;
  createKnowledgeCollection(
    ownerId: string,
    input: CreateKnowledgeCollectionInput,
  ): MaybePromise<KnowledgeCollection>;
  listKnowledgeCollections(ownerId: string): MaybePromise<KnowledgeCollection[]>;
  getKnowledgeCollection(id: string, ownerId: string): MaybePromise<KnowledgeCollection>;
  updateKnowledgeCollection(
    id: string,
    ownerId: string,
    patch: KnowledgeCollectionPatch,
  ): MaybePromise<KnowledgeCollection>;
  deleteKnowledgeCollection(
    id: string,
    ownerId: string,
    expectedVersion: number,
  ): MaybePromise<KnowledgeCollection>;
  linkKnowledgeAttachment(
    collectionId: string,
    attachmentId: string,
    ownerId: string,
    expectedVersion: number,
  ): MaybePromise<KnowledgeCollection>;
  unlinkKnowledgeAttachment(
    collectionId: string,
    attachmentId: string,
    ownerId: string,
    expectedVersion: number,
  ): MaybePromise<KnowledgeCollection>;
  listKnowledgeAttachments(collectionId: string, ownerId: string): MaybePromise<AttachmentRecord[]>;
  bindKnowledgeCollection(
    conversationId: string,
    collectionId: string,
    ownerId: string,
    mode: KnowledgeRetrievalMode,
    expectedVersion?: number,
  ): MaybePromise<KnowledgeConversationBinding>;
  unbindKnowledgeCollection(
    conversationId: string,
    collectionId: string,
    ownerId: string,
    expectedVersion: number,
  ): MaybePromise<void>;
  listConversationKnowledge(
    conversationId: string,
    ownerId: string,
  ): MaybePromise<KnowledgeConversationBinding[]>;
  replaceConversationKnowledge(
    conversationId: string,
    ownerId: string,
    input: ReplaceConversationKnowledgeInput,
  ): MaybePromise<KnowledgeConversationBinding[]>;
  /** Creates a personal token and its mandatory audit record as one atomic command. */
  createApiToken(
    userId: string,
    input: CreateApiTokenInput,
    expectedAuthorityEpoch: number,
  ): MaybePromise<StoredApiToken>;
  authenticateApiToken(hash: string): MaybePromise<StoredApiToken | undefined>;
  findApiTokenByHash(hash: string): MaybePromise<StoredApiToken | undefined>;
  listApiTokens(userId: string): MaybePromise<ApiTokenSummary[]>;
  /** Revokes the token family and appends its mandatory audit in the same transaction. */
  revokeApiToken(
    id: string,
    userId: string,
    expectedAuthorityEpoch: number,
  ): MaybePromise<void>;
  /** Updates the token family and appends its mandatory audit in the same transaction. */
  updateApiToken(
    userId: string,
    id: string,
    input: UpdateApiTokenInput,
    expectedAuthorityEpoch: number,
  ): MaybePromise<ApiTokenSummary>;
  /** Rotates the token and appends its mandatory audit before the replacement secret is returned. */
  rotateApiToken(
    userId: string,
    id: string,
    input: RotateApiTokenInput,
    expectedAuthorityEpoch: number,
  ): MaybePromise<RotatedApiToken>;
  /** CAS-revokes the family and appends its mandatory audit in the same transaction. */
  revokeApiTokenFamily(
    id: string,
    userId: string,
    expectedVersion: number,
    expectedAuthorityEpoch: number,
  ): MaybePromise<void>;
  searchApiTokens(
    context: PrivilegedReadContext,
    query?: string,
    limit?: number,
    cursor?: string,
  ): MaybePromise<AdminTokenLookupPage>;
  listModelAliases(): MaybePromise<ModelAlias[]>;
  /** Creates a model alias and appends its mandatory privileged audit atomically. */
  createModelAlias(
    input: CreateModelAliasInput,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<ModelAlias>;
  /** Updates a model alias and appends its mandatory privileged audit atomically. */
  updateModelAlias(
    id: string,
    input: UpdateModelAliasInput,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<ModelAlias>;
  /** Deletes a model alias and appends its mandatory privileged audit atomically. */
  deleteModelAlias(
    id: string,
    expectedVersion: number,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<void>;
  listAccessGroups(context: PrivilegedReadContext): MaybePromise<AccessGroup[]>;
  createAccessGroup(
    input: CreateAccessGroupInput,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<AccessGroup>;
  updateAccessGroup(
    id: string,
    input: UpdateAccessGroupInput,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<AccessGroup>;
  deleteAccessGroup(
    id: string,
    expectedVersion: number,
    acknowledgePublicModelIds: string[],
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<void>;
  replaceAccessGroupUsers(
    id: string,
    userIds: string[],
    expectedVersion: number,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<AccessGroup>;
  replaceAccessGroupModels(
    id: string,
    modelIds: string[],
    expectedVersion: number,
    acknowledgePublicModelIds: string[],
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<AccessGroup>;
  replaceAccessGroupPolicy(
    id: string,
    input: ReplaceAccessGroupPolicyInput,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<AccessGroup>;
  previewAccessGroupPolicyImpact(
    context: PrivilegedReadContext,
    id: string,
    proposal?: AccessGroupPolicyProposal | null,
  ): MaybePromise<AccessGroupPolicyImpact>;
  setTokenAccessGroups(
    userId: string,
    tokenId: string,
    groupIds: string[],
    expectedVersion: number,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<ApiTokenSummary>;
  setTokenAccessMode(
    userId: string,
    tokenId: string,
    mode: "inherit" | "restricted",
    expectedVersion: number,
    audit: PrivilegedAuditEventInput,
  ): MaybePromise<ApiTokenSummary>;
  listEntitledProviderModels(subject: TokenAccessSubject): MaybePromise<ProviderModelRecord[]>;
  resolveEntitledProviderModel(
    subject: TokenAccessSubject,
    requestedId: string,
  ): MaybePromise<EntitledProviderModel | undefined>;
  createProvider(
    input: CreateProviderInput,
    mutation: RegistryMutationContext,
  ): MaybePromise<ProviderRecord>;
  updateProvider(
    id: string,
    expectedVersion: number,
    input: UpdateProviderInput,
    mutation: RegistryMutationContext,
  ): MaybePromise<ProviderRecord>;
  listProviders(enabledOnly?: boolean): MaybePromise<ProviderRecord[]>;
  findProvider(idOrSlug: string): MaybePromise<ProviderRecord | undefined>;
  setProviderCredential(
    id: string,
    expectedVersion: number,
    credential: ProviderCredentialMutation | null,
    mutation: RegistryMutationContext,
  ): MaybePromise<ProviderRecord>;
  getProviderCredential(id: string): MaybePromise<StoredProviderCredential | undefined>;
  createProviderModel(
    input: CreateProviderModelInput,
    mutation: RegistryMutationContext,
  ): MaybePromise<ProviderModelRecord>;
  updateProviderModel(
    id: string,
    expectedVersion: number,
    input: UpdateProviderModelInput,
    mutation: RegistryMutationContext,
  ): MaybePromise<ProviderModelRecord>;
  listProviderModels(
    providerId?: string,
    enabledOnly?: boolean,
  ): MaybePromise<ProviderModelRecord[]>;
  findProviderModel(idOrPublicModelId: string): MaybePromise<ProviderModelRecord | undefined>;
  createModelPriceVersion(
    input: CreateModelPriceVersionInput,
    mutation: RegistryMutationContext,
  ): MaybePromise<ModelPriceVersion>;
  listModelPriceVersions(providerModelId: string): MaybePromise<ModelPriceVersion[]>;
  effectiveModelPrice(
    providerModelId: string,
    at?: string,
  ): MaybePromise<ModelPriceVersion | undefined>;
  createProviderRetryPolicy(
    input: CreateProviderRetryPolicyInput,
    mutation: RegistryMutationContext,
  ): MaybePromise<ProviderRetryPolicy>;
  updateProviderRetryPolicy(
    id: string,
    expectedVersion: number,
    input: UpdateProviderRetryPolicyInput,
    mutation: RegistryMutationContext,
  ): MaybePromise<ProviderRetryPolicy>;
  listProviderRetryPolicies(enabledOnly?: boolean): MaybePromise<ProviderRetryPolicy[]>;
  setProviderModelRoute(
    input: SetProviderModelRouteInput,
    mutation: RegistryMutationContext,
  ): MaybePromise<ProviderModelRoute>;
  findProviderModelRoute(sourceModelId: string): MaybePromise<ProviderModelRoute | undefined>;
  resolveProviderExecutionPlan(
    sourceModelId: string,
    at?: string,
  ): MaybePromise<ProviderExecutionPlan>;
  claimProviderExecution(
    usageRunId: string,
    ownerLeaseToken: string,
  ): MaybePromise<ProviderExecutionClaim>;
  heartbeatProviderExecutionLease(
    usageRunId: string,
    ownerLeaseToken: string,
    leaseSeconds?: number,
  ): MaybePromise<ProviderExecutionLease>;
  reclaimProviderExecutionLease(
    usageRunId: string,
    expiredLeaseToken: string,
    leaseSeconds?: number,
  ): MaybePromise<ProviderExecutionLease>;
  startProviderAttempt(input: StartProviderAttemptInput): MaybePromise<ProviderAttempt>;
  finishProviderAttempt(input: FinishProviderAttemptInput): MaybePromise<ProviderAttempt>;
  listProviderAttempts(usageRunId: string): MaybePromise<ProviderAttempt[]>;
  settleProviderUsage(input: FinalizeProviderUsageInput): MaybePromise<UsageRun>;
  refundProviderUsage(input: FinalizeProviderUsageInput): MaybePromise<UsageRun>;
  /** Atomically validates the active parent lease and reserves credit for a billed child call. */
  reserveChildProviderUsage(input: ReserveChildProviderUsageInput): MaybePromise<UsageRun>;
  /** Atomically raises an active run's reservation; never lowers or duplicates an extension. */
  ensureUsageReservation(input: EnsureUsageReservationInput): MaybePromise<UsageRun>;
  /** Creates a reservation once, or returns the existing active reservation when every billing field matches. */
  ensureIdempotentReservation(input: EnsureIdempotentReservationInput): MaybePromise<UsageRun>;
  reapStaleProviderExecutionLeases(limit?: number): MaybePromise<number>;
  reserve(
    userId: string,
    runId: string,
    model: string,
    amountMicros: number,
    provider?: string,
    tokenId?: string,
    pricingSnapshot?: UsagePricingSnapshot,
  ): MaybePromise<UsageRun>;
  settle(
    runId: string,
    costMicros: number,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
  ): MaybePromise<UsageRun>;
  refund(runId: string, error?: string): MaybePromise<UsageRun | undefined>;
  beginApiRequest(input: BeginApiRequestInput): MaybePromise<BeginApiRequestResult>;
  getApiRequest(
    userId: string,
    endpoint: ApiIdempotencyEndpoint,
    idempotencyKey: string,
  ): MaybePromise<ApiIdempotencyRequest | undefined>;
  appendApiSseFrame(
    id: string,
    leaseToken: string,
    sequence: number,
    frame: string,
    leaseSeconds?: number,
    observation?: ApiUsageObservation,
    quota?: ApiReplayQuota,
  ): MaybePromise<ApiIdempotencyRequest>;
  appendApiSseFrames(
    id: string,
    leaseToken: string,
    frames: ApiSseFrameInput[],
    leaseSeconds?: number,
    observation?: ApiUsageObservation,
    quota?: ApiReplayQuota,
  ): MaybePromise<ApiIdempotencyRequest>;
  heartbeatApiRequest(
    id: string,
    leaseToken: string,
    leaseSeconds?: number,
    observation?: ApiUsageObservation,
  ): MaybePromise<void>;
  releaseApiRequestLease(id: string, leaseToken: string): MaybePromise<ApiIdempotencyRequest>;
  reclaimApiRequest(
    id: string,
    expiredLeaseToken: string,
    leaseSeconds?: number,
  ): MaybePromise<{ request: ApiIdempotencyRequest; leaseToken: string }>;
  completeApiJson(input: CompleteApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  completeApiStream(input: CompleteApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  failApiRequest(input: FailApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  reapStaleApiRequests(limit?: number, quota?: ApiReplayQuota): MaybePromise<number>;
  pruneExpiredApiRequests(limit?: number): MaybePromise<number>;
  usage(userId: string): MaybePromise<UsageSummary>;
  listLedger(userId: string): MaybePromise<LedgerEntry[]>;
  enqueueJob(
    type: string,
    payload: unknown,
    availableAt?: string,
    idempotencyKey?: string,
  ): MaybePromise<string>;
  adminSummary(): MaybePromise<AdminSummary>;
  adminAnalytics(query: AdminAnalyticsQuery): MaybePromise<AdminAnalytics>;
  listJobs(query?: AdminJobQuery): MaybePromise<AdminJobPage>;
  listWorkerInstances(query?: AdminWorkerQuery): MaybePromise<AdminWorkerPage>;
  /** Atomically requeues a failed job and records the privileged actor in the audit log. */
  retryFailedJob(id: string, actorId: string): MaybePromise<RetriedAdminJob>;
  getRetentionPolicy(): MaybePromise<RetentionPolicy>;
  updateRetentionPolicy(
    input: UpdateRetentionPolicyInput,
    actorId: string,
  ): MaybePromise<RetentionPolicy>;
  captureProviderPayload(
    input: ProviderPayloadCaptureInput,
  ): MaybePromise<ProviderPayloadCapture | null>;
  previewRetentionScrub(): MaybePromise<RetentionPreview>;
  enqueueRetentionScrub(
    input: EnqueueRetentionScrubInput,
    actorId: string | null,
  ): MaybePromise<RetentionScrubRun>;
  /**
   * Atomically fences all scheduler replicas, snapshots the current policy/cutoffs, and enqueues
   * at most one durable retention.scrub job for the due slot or newly activated policy version.
   */
  scheduleRetentionScrub(
    input: ScheduleRetentionScrubInput,
  ): MaybePromise<RetentionScheduleResult>;
  getRetentionScrubRun(id: string): MaybePromise<RetentionScrubRun>;
  listRetentionScrubRuns(query?: RetentionScrubQuery): MaybePromise<RetentionScrubPage>;
  scrubRetentionBatch(runId: string, limit?: number): MaybePromise<RetentionScrubBatchResult>;
  failRetentionScrubRun(
    runId: string,
    code: RetentionScrubFailureCode,
  ): MaybePromise<RetentionScrubRun>;
  readiness(signal?: AbortSignal): MaybePromise<{ ready: boolean; storage: string }>;
}
