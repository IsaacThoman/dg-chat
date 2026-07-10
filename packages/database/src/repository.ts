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
export interface DocumentChunkInput {
  id: string;
  ordinal: number;
  content: string;
  metadata: Record<string, unknown>;
}
export interface DocumentChunk extends DocumentChunkInput {
  attachmentId: string;
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
  capabilities: string[];
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
  capabilities: string[];
  contextWindow: number;
  enabled?: boolean;
  customParams?: Record<string, unknown>;
}
export interface UpdateProviderModelInput {
  publicModelId?: string;
  upstreamModelId?: string;
  displayName?: string;
  capabilities?: string[];
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
