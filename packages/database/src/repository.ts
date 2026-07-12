import type {
  AccountState,
  ApiTokenSummary,
  ApprovalStatus,
  Conversation,
  ConversationDetail,
  MessageNode,
  MessageRole,
  ModelCapability,
  PublicUser,
  UsageSummary,
  UserRole,
} from "@dg-chat/contracts";
import type { LedgerEntry, StoredApiToken, StoredSession, StoredUser, UsageRun } from "./memory.ts";
export {
  DOCX_MIME_TYPE,
  INGESTIBLE_DOCUMENT_MIME_TYPES,
  isIngestibleDocumentMime,
} from "./attachment-policy.ts";

export type MaybePromise<T> = T | Promise<T>;

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
  ingestionStatus: AttachmentIngestionStatus;
  ingestionError: string | null;
  ingestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
  /** Set only when trusted server-side validation has already completed. */
  inspectionComplete?: boolean;
}
export interface CreateAttachmentResult {
  attachment: AttachmentRecord;
  inspectionJobId: string | null;
  deduplicated: boolean;
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
export type ApiIdempotencyEndpoint =
  | "chat.completions"
  | "responses"
  | "embeddings"
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
  markUserEmailVerified(userId: string): MaybePromise<StoredUser>;
  resetPassword(tokenHash: string, passwordHash: string): MaybePromise<StoredUser>;
  prepareBetterAuthPasswordReset(token: string): MaybePromise<void>;
  secureAfterPasswordReset(userId: string, token: string): MaybePromise<void>;
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
  createApiToken(userId: string, input: CreateApiTokenInput): MaybePromise<StoredApiToken>;
  findApiTokenByHash(hash: string): MaybePromise<StoredApiToken | undefined>;
  listApiTokens(userId: string): MaybePromise<ApiTokenSummary[]>;
  revokeApiToken(id: string, userId: string): MaybePromise<void>;
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
  reclaimApiRequest(
    id: string,
    expiredLeaseToken: string,
    leaseSeconds?: number,
  ): MaybePromise<{ request: ApiIdempotencyRequest; leaseToken: string }>;
  completeApiJson(input: CompleteApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  completeApiStream(input: CompleteApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  failApiRequest(input: FailApiRequestInput): MaybePromise<ApiIdempotencyRequest>;
  reapStaleApiRequests(limit?: number): MaybePromise<number>;
  pruneExpiredApiRequests(limit?: number): MaybePromise<number>;
  usage(userId: string): MaybePromise<UsageSummary>;
  listLedger(userId: string): MaybePromise<LedgerEntry[]>;
  enqueueJob(type: string, payload: unknown, availableAt?: string): MaybePromise<string>;
  adminSummary(): MaybePromise<AdminSummary>;
  adminAnalytics(query: AdminAnalyticsQuery): MaybePromise<AdminAnalytics>;
  listJobs(query?: AdminJobQuery): MaybePromise<AdminJobPage>;
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
    actorId: string,
  ): MaybePromise<RetentionScrubRun>;
  getRetentionScrubRun(id: string): MaybePromise<RetentionScrubRun>;
  listRetentionScrubRuns(query?: RetentionScrubQuery): MaybePromise<RetentionScrubPage>;
  scrubRetentionBatch(runId: string, limit?: number): MaybePromise<RetentionScrubBatchResult>;
  failRetentionScrubRun(
    runId: string,
    code: RetentionScrubFailureCode,
  ): MaybePromise<RetentionScrubRun>;
  readiness(): MaybePromise<{ ready: boolean; storage: string }>;
}
