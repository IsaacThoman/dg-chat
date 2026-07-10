import type {
  AccountState,
  ApiTokenSummary,
  ApprovalStatus,
  Conversation,
  ConversationDetail,
  MessageNode,
  MessageRole,
  PublicUser,
  UsageSummary,
  UserRole,
} from "@dg-chat/contracts";
import type { LedgerEntry, StoredApiToken, StoredSession, StoredUser, UsageRun } from "./memory.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  role?: UserRole;
  approvalStatus?: ApprovalStatus;
  state?: AccountState;
  emailVerified?: boolean;
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
export interface AuditEventInput {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
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
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
}
export interface CreateAttachmentResult {
  attachment: AttachmentRecord;
  inspectionJobId: string;
  deduplicated: boolean;
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
}

export interface BeginGenerationInput {
  message: AppendMessageInput;
  attachmentIds?: string[];
  runId: string;
  provider: string;
  reserveMicros: number;
  tokenId?: string;
  leaseSeconds?: number;
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
}
export interface GenerationResult {
  message: MessageNode;
  conversation: Conversation;
  usageRun: UsageRun;
}
export type BeginGenerationResult =
  | (GenerationResult & { kind: "started" | "claimed"; leaseToken: string })
  | (GenerationResult & { kind: "completed" })
  | (GenerationResult & { kind: "in_progress"; retryAfterSeconds: number });
export interface ConversationPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
}
export interface AdminSummary {
  calls: number;
  users: number;
  balanceMicros: number;
  ledger: LedgerEntry[];
}
export interface JobSummary {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  createdAt: string;
}
export type ApiIdempotencyEndpoint = "chat.completions" | "responses";
export type ApiIdempotencyState = "in_progress" | "completed" | "failed";
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
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
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
  provider: string;
  tokenId?: string;
  leaseSeconds?: number;
  retentionSeconds?: number;
  quota?: ApiReplayQuota;
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
  billing: { mode: "refund" } | {
    mode: "settle";
    costMicros: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
}

/** Persistence boundary shared by synchronous test stores and async production stores. */
export interface DomainRepository {
  readonly storageKind: "postgres" | "memory";
  close(): MaybePromise<void>;
  bootstrapAdmin(input: CreateUserInput, startingCreditMicros: number): MaybePromise<StoredUser>;
  createUser(input: CreateUserInput): MaybePromise<StoredUser>;
  findUser(id: string): MaybePromise<StoredUser | undefined>;
  findUserByEmail(email: string): MaybePromise<StoredUser | undefined>;
  listUsers(): MaybePromise<PublicUser[]>;
  createSession(userId: string, tokenHash: string, limited: boolean): MaybePromise<StoredSession>;
  getSession(tokenHash: string): MaybePromise<StoredSession | undefined>;
  invalidateUserSessions(userId: string): MaybePromise<void>;
  deleteSession(tokenHash: string): MaybePromise<void>;
  listSessions(userId: string): MaybePromise<SessionSummary[]>;
  revokeSession(id: string, ownerId?: string): MaybePromise<void>;
  createIdentityToken(
    userId: string,
    purpose: IdentityTokenPurpose,
    tokenHash: string,
    expiresAt: string,
  ): MaybePromise<void>;
  verifyEmail(tokenHash: string): MaybePromise<StoredUser>;
  resetPassword(tokenHash: string, passwordHash: string): MaybePromise<StoredUser>;
  recordAudit(input: AuditEventInput): MaybePromise<AuditEvent>;
  listAudit(query?: AuditQuery): MaybePromise<AuditPage>;
  approveUser(
    id: string,
    status: "approved" | "rejected",
    creditMicros: number,
    requireEmailVerification?: boolean,
  ): MaybePromise<StoredUser>;
  setUserState(id: string, state: AccountState): MaybePromise<StoredUser>;
  createConversation(
    ownerId: string,
    title: string,
    temporary?: boolean,
    idempotencyKey?: string,
  ): MaybePromise<Conversation>;
  listConversations(ownerId: string, includeDeleted?: boolean): MaybePromise<Conversation[]>;
  updateConversation(
    ownerId: string,
    id: string,
    patch: ConversationPatch,
  ): MaybePromise<Conversation>;
  detail(id: string, ownerId: string): MaybePromise<ConversationDetail>;
  appendMessage(input: AppendMessageInput): MaybePromise<MessageNode>;
  beginGeneration(input: BeginGenerationInput): MaybePromise<BeginGenerationResult>;
  heartbeatGeneration(
    runId: string,
    ownerId: string,
    leaseToken: string,
    leaseSeconds?: number,
  ): MaybePromise<void>;
  completeGeneration(input: CompleteGenerationInput): MaybePromise<GenerationResult>;
  failGeneration(input: FailGenerationInput): MaybePromise<GenerationResult>;
  reapStaleGenerations(limit?: number): MaybePromise<number>;
  setActiveLeaf(
    conversationId: string,
    ownerId: string,
    leafId: string,
    expectedVersion: number,
  ): MaybePromise<Conversation>;
  createAttachment(input: CreateAttachmentInput): MaybePromise<CreateAttachmentResult>;
  listAttachments(ownerId: string, includeDeleted?: boolean): MaybePromise<AttachmentRecord[]>;
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
  linkAttachmentToMessage(
    messageId: string,
    attachmentId: string,
    ownerId: string,
  ): MaybePromise<void>;
  listMessageAttachments(messageId: string, ownerId: string): MaybePromise<AttachmentRecord[]>;
  createApiToken(userId: string, input: CreateApiTokenInput): MaybePromise<StoredApiToken>;
  findApiTokenByHash(hash: string): MaybePromise<StoredApiToken | undefined>;
  listApiTokens(userId: string): MaybePromise<ApiTokenSummary[]>;
  revokeApiToken(id: string, userId: string): MaybePromise<void>;
  reserve(
    userId: string,
    runId: string,
    model: string,
    amountMicros: number,
    provider?: string,
    tokenId?: string,
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
  completeApiJson(input: CompleteApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  completeApiStream(input: CompleteApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  failApiRequest(input: FailApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  reapStaleApiRequests(limit?: number): MaybePromise<number>;
  pruneExpiredApiRequests(limit?: number): MaybePromise<number>;
  usage(userId: string): MaybePromise<UsageSummary>;
  listLedger(userId: string): MaybePromise<LedgerEntry[]>;
  enqueueJob(type: string, payload: unknown, availableAt?: string): MaybePromise<string>;
  adminSummary(): MaybePromise<AdminSummary>;
  listJobs(): MaybePromise<JobSummary[]>;
  readiness(): MaybePromise<{ ready: boolean; storage: string }>;
}
