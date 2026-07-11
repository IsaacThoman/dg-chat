import postgres from "npm:postgres@3.4.7";
import type { AccountState, Conversation, MessageNode, PublicUser } from "@dg-chat/contracts";
import { DomainError } from "./memory.ts";
import { INGESTIBLE_DOCUMENT_MIME_TYPES, isIngestibleDocumentMime } from "./attachment-policy.ts";
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  normalizeKnowledgeSearchLimit,
  validateChunkEmbeddings,
  validateDocumentChunkInputs,
} from "./repository.ts";
import type { LedgerEntry, StoredApiToken, StoredSession, StoredUser, UsageRun } from "./memory.ts";
import type {
  ApiIdempotencyEndpoint,
  ApiIdempotencyFrame,
  ApiIdempotencyRequest,
  ApiReplayQuota,
  ApiSseFrameInput,
  ApiUsageObservation,
  AppendMessageInput,
  AttachmentRecord,
  AttachmentState,
  AuditEvent,
  AuditEventInput,
  AuditPage,
  AuditQuery,
  BeginApiRequestInput,
  BeginApiRequestResult,
  BeginAssistantGenerationInput,
  BeginGenerationInput,
  CompleteApiRequestInput,
  CompleteGenerationInput,
  ConversationPatch,
  CreateApiTokenInput,
  CreateAttachmentInput,
  CreateAttachmentResult,
  CreateKnowledgeCollectionInput,
  CreateModelPriceVersionInput,
  CreateProviderInput,
  CreateProviderModelInput,
  CreateProviderRetryPolicyInput,
  CreateUserInput,
  DocumentChunk,
  DocumentChunkEmbeddingInput,
  DocumentChunkInput,
  DomainRepository,
  EmbeddingProviderAttemptInput,
  EnsureUsageReservationInput,
  FailApiRequestInput,
  FailGenerationInput,
  FinalizeProviderUsageInput,
  FinishEmbeddingProviderAttemptInput,
  FinishProviderAttemptInput,
  IdentityTokenPurpose,
  KnowledgeCollection,
  KnowledgeCollectionPatch,
  KnowledgeConversationBinding,
  KnowledgeRetrievalMode,
  KnowledgeSearchHit,
  ModelPriceVersion,
  ProviderAttempt,
  ProviderCredentialEnvelope,
  ProviderCredentialMutation,
  ProviderExecutionClaim,
  ProviderExecutionPlan,
  ProviderModelRecord,
  ProviderModelRoute,
  ProviderRecord,
  ProviderRetryPolicy,
  RegistryMutationContext,
  ReplaceConversationKnowledgeInput,
  ReserveChildProviderUsageInput,
  SearchConversationKnowledgeInput,
  SessionSummary,
  SetProviderModelRouteInput,
  StartProviderAttemptInput,
  StoredProviderCredential,
  UpdateProviderInput,
  UpdateProviderModelInput,
  UpdateProviderRetryPolicyInput,
  UsagePricingSnapshot,
} from "./repository.ts";
import {
  decodeAuditCursor,
  encodeAuditPostgresCursor,
  isUsagePricingSnapshot,
} from "./repository.ts";

type Row = Record<string, unknown>;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const nullableIso = (value: unknown) => value == null ? null : iso(value);
const number = (value: unknown) => Number(value);
const knowledgeCollection = (row: Row): KnowledgeCollection => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  name: String(row.name),
  description: String(row.description),
  version: number(row.version),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  deletedAt: nullableIso(row.deleted_at),
});
const knowledgeBinding = (row: Row): KnowledgeConversationBinding => ({
  conversationId: String(row.conversation_id),
  collectionId: String(row.collection_id),
  ownerId: String(row.owner_id),
  mode: row.mode as KnowledgeRetrievalMode,
  version: number(row.version),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
const replayQuota = (quota?: ApiReplayQuota): ApiReplayQuota => {
  const value = quota ?? { maxRequests: 256, maxBytes: 67_108_864, maxEvents: 20_000 };
  if (
    !Number.isSafeInteger(value.maxRequests) || value.maxRequests < 1 ||
    !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 ||
    !Number.isSafeInteger(value.maxEvents) || value.maxEvents < 1
  ) throw new DomainError("validation_error", "Invalid replay quota", 422);
  return value;
};

function user(row: Row): StoredUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    passwordHash: String(row.password_hash),
    role: row.role as StoredUser["role"],
    approvalStatus: row.approval_status as StoredUser["approvalStatus"],
    state: row.state as StoredUser["state"],
    balanceMicros: number(row.balance_micros),
    emailVerifiedAt: nullableIso(row.email_verified_at),
    createdAt: iso(row.created_at),
  };
}
function publicUser(value: StoredUser): PublicUser {
  const { passwordHash: _passwordHash, ...safe } = value;
  return safe;
}
function conversation(row: Row): Conversation {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    title: String(row.title),
    activeLeafId: row.active_leaf_id == null ? null : String(row.active_leaf_id),
    version: number(row.version),
    pinned: Boolean(row.pinned),
    temporary: Boolean(row.temporary),
    archivedAt: nullableIso(row.archived_at),
    deletedAt: nullableIso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function message(row: Row): MessageNode {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    supersedesId: row.supersedes_id == null ? null : String(row.supersedes_id),
    generationId: row.generation_id == null ? null : String(row.generation_id),
    siblingIndex: number(row.sibling_index),
    role: row.role as MessageNode["role"],
    content: String(row.content),
    model: row.model == null ? null : String(row.model),
    status: row.status as MessageNode["status"],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: iso(row.created_at),
  };
}
function token(row: Row): StoredApiToken {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    preview: String(row.preview),
    scopes: row.scopes as string[],
    expiresAt: nullableIso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    lastUsedAt: nullableIso(row.last_used_at),
    createdAt: iso(row.created_at),
  };
}
function run(row: Row): UsageRun {
  const pricingSnapshot = row.pricing_version_id
    ? {
      pricingVersionId: String(row.pricing_version_id),
      inputMicrosPerMillion: number(row.pricing_input_micros_per_million),
      cachedInputMicrosPerMillion: number(row.pricing_cached_input_micros_per_million),
      reasoningMicrosPerMillion: number(row.pricing_reasoning_micros_per_million),
      outputMicrosPerMillion: number(row.pricing_output_micros_per_million),
      fixedCallMicros: number(row.pricing_fixed_call_micros),
      source: String(row.pricing_source),
    }
    : null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    model: String(row.model),
    status: row.status as UsageRun["status"],
    reservedMicros: number(row.reserved_micros),
    costMicros: number(row.cost_micros),
    inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens),
    latencyMs: number(row.latency_ms ?? 0),
    executionEpoch: number(row.execution_epoch ?? 0),
    executionOwnerLeaseToken: row.execution_owner_lease_token
      ? String(row.execution_owner_lease_token)
      : null,
    runLeaseToken: row.run_lease_token ? String(row.run_lease_token) : null,
    runLeaseExpiresAt: iso(row.run_lease_expires_at),
    actualProviderCostMicros: number(row.actual_provider_cost_micros ?? 0),
    actualProviderInputTokens: number(row.actual_provider_input_tokens ?? 0),
    actualProviderCachedInputTokens: number(row.actual_provider_cached_input_tokens ?? 0),
    actualProviderReasoningTokens: number(row.actual_provider_reasoning_tokens ?? 0),
    actualProviderOutputTokens: number(row.actual_provider_output_tokens ?? 0),
    pricingSnapshot,
    generationLeaseToken: row.generation_lease_token ? String(row.generation_lease_token) : null,
    generationLeaseExpiresAt: nullableIso(row.generation_lease_expires_at),
    createdAt: iso(row.created_at),
  };
}
function attachment(row: Row): AttachmentRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    objectKey: String(row.object_key),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: number(row.size_bytes),
    sha256: String(row.sha256),
    state: row.state as AttachmentState,
    inspectionError: row.inspection_error ? String(row.inspection_error) : null,
    ingestionStatus: String(
      row.ingestion_status ?? "not_applicable",
    ) as AttachmentRecord["ingestionStatus"],
    ingestionError: row.ingestion_error ? String(row.ingestion_error) : null,
    ingestedAt: nullableIso(row.ingested_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
    deletedAt: nullableIso(row.deleted_at),
  };
}
function documentChunk(row: Row): DocumentChunk {
  return {
    id: String(row.id),
    attachmentId: String(row.attachment_id),
    ordinal: number(row.ordinal),
    content: String(row.content),
    metadata: row.metadata as Record<string, unknown>,
  };
}

function provider(row: Row): ProviderRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    baseUrl: String(row.base_url),
    protocol: row.protocol as ProviderRecord["protocol"],
    enabled: Boolean(row.enabled),
    version: number(row.version),
    hasCredential: row.credential_envelope != null,
    credentialUpdatedAt: nullableIso(row.credential_updated_at),
    healthStatus: row.health_status as ProviderRecord["healthStatus"],
    healthCheckedAt: nullableIso(row.health_checked_at),
    healthLatencyMs: row.health_latency_ms == null ? null : number(row.health_latency_ms),
    healthError: row.health_error == null ? null : String(row.health_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function providerModel(row: Row): ProviderModelRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    publicModelId: String(row.public_model_id),
    upstreamModelId: String(row.upstream_model_id),
    displayName: String(row.display_name),
    capabilities: [...(row.capabilities as string[])],
    contextWindow: number(row.context_window),
    enabled: Boolean(row.enabled),
    version: number(row.version),
    customParams: structuredClone((row.custom_params ?? {}) as Record<string, unknown>),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function modelPrice(row: Row): ModelPriceVersion {
  return {
    id: String(row.id),
    providerModelId: String(row.provider_model_id),
    effectiveAt: iso(row.effective_at),
    inputMicrosPerMillion: number(row.input_micros_per_million),
    cachedInputMicrosPerMillion: number(row.cached_input_micros_per_million),
    reasoningMicrosPerMillion: number(row.reasoning_micros_per_million),
    outputMicrosPerMillion: number(row.output_micros_per_million),
    fixedCallMicros: number(row.fixed_call_micros),
    source: String(row.source),
    createdAt: iso(row.created_at),
  };
}
function retryPolicy(row: Row): ProviderRetryPolicy {
  return {
    id: String(row.id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    maxAttempts: number(row.max_attempts),
    maxRetries: number(row.max_retries),
    baseDelayMs: number(row.base_delay_ms),
    maxDelayMs: number(row.max_delay_ms),
    backoffMultiplierBps: number(row.backoff_multiplier_bps),
    jitterBps: number(row.jitter_bps),
    firstTokenTimeoutMs: number(row.first_token_timeout_ms),
    idleTimeoutMs: number(row.idle_timeout_ms),
    totalTimeoutMs: number(row.total_timeout_ms),
    retryableStatuses: [...(row.retryable_statuses as number[])],
    version: number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function providerAttempt(row: Row): ProviderAttempt {
  return {
    id: String(row.id),
    usageRunId: String(row.usage_run_id),
    attemptNumber: number(row.attempt_number),
    executionEpoch: number(row.execution_epoch),
    targetOrdinal: number(row.target_ordinal),
    retryNumber: number(row.retry_number),
    reason: row.reason as ProviderAttempt["reason"],
    breakerBefore: row.breaker_before == null
      ? null
      : row.breaker_before as ProviderAttempt["breakerBefore"],
    breakerAfter: row.breaker_after == null
      ? null
      : row.breaker_after as ProviderAttempt["breakerAfter"],
    retryable: Boolean(row.retryable),
    providerId: String(row.provider_id),
    providerSlug: String(row.provider_slug),
    providerVersion: number(row.provider_version),
    protocol: row.protocol as ProviderAttempt["protocol"],
    providerModelId: String(row.provider_model_id),
    publicModelId: String(row.public_model_id),
    upstreamModelId: String(row.upstream_model_id),
    modelVersion: number(row.model_version),
    pricing: {
      pricingVersionId: String(row.pricing_version_id),
      inputMicrosPerMillion: number(row.pricing_input_micros_per_million),
      cachedInputMicrosPerMillion: number(row.pricing_cached_input_micros_per_million),
      reasoningMicrosPerMillion: number(row.pricing_reasoning_micros_per_million),
      outputMicrosPerMillion: number(row.pricing_output_micros_per_million),
      fixedCallMicros: number(row.pricing_fixed_call_micros),
      source: String(row.pricing_source),
    },
    status: row.status as ProviderAttempt["status"],
    phase: row.phase as ProviderAttempt["phase"],
    errorCode: row.error_code == null ? null : String(row.error_code),
    httpStatus: row.http_status == null ? null : number(row.http_status),
    visibleOutput: Boolean(row.visible_output),
    inputTokens: number(row.input_tokens),
    cachedInputTokens: number(row.cached_input_tokens),
    reasoningTokens: number(row.reasoning_tokens),
    outputTokens: number(row.output_tokens),
    costMicros: number(row.cost_micros),
    tokenSource: row.token_source as ProviderAttempt["tokenSource"],
    costSource: row.cost_source as ProviderAttempt["costSource"],
    latencyMs: row.latency_ms == null ? null : number(row.latency_ms),
    ttftMs: row.ttft_ms == null ? null : number(row.ttft_ms),
    upstreamRequestId: row.upstream_request_id == null ? null : String(row.upstream_request_id),
    tokensPerSecond: row.tokens_per_second == null ? null : number(row.tokens_per_second),
    startedAt: iso(row.started_at),
    completedAt: nullableIso(row.completed_at),
  };
}

const registryConflict = () =>
  new DomainError("version_conflict", "The registry record changed; reload and try again", 409);

function normalizeProviderBaseUrl(value: string): string {
  if (value !== value.trim() || value.length > 2048) {
    throw new DomainError("validation_error", "Provider base URL is invalid", 422);
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.port === "0"
    ) {
      throw new Error();
    }
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    throw new DomainError("validation_error", "Provider base URL is invalid", 422);
  }
}

function validateProviderInput(input: Partial<CreateProviderInput & UpdateProviderInput>) {
  if (input.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
    throw new DomainError("validation_error", "Provider slug is invalid", 422);
  }
  if (
    input.displayName !== undefined &&
    (input.displayName.trim().length < 1 || input.displayName.trim().length > 120)
  ) throw new DomainError("validation_error", "Provider display name is invalid", 422);
  if (input.baseUrl !== undefined) normalizeProviderBaseUrl(input.baseUrl);
  if (input.protocol !== undefined && !["chat_completions", "responses"].includes(input.protocol)) {
    throw new DomainError("validation_error", "Provider protocol is invalid", 422);
  }
  if (
    input.healthStatus !== undefined &&
    !["unknown", "healthy", "unhealthy", "disabled"].includes(input.healthStatus)
  ) throw new DomainError("validation_error", "Provider health status is invalid", 422);
  if (
    input.healthLatencyMs !== undefined && input.healthLatencyMs !== null &&
    (!Number.isSafeInteger(input.healthLatencyMs) || input.healthLatencyMs < 0)
  ) throw new DomainError("validation_error", "Provider health latency is invalid", 422);
  if (
    input.healthError !== undefined && input.healthError !== null && input.healthError.length > 1000
  ) {
    throw new DomainError("validation_error", "Provider health error is too long", 422);
  }
  if (
    input.healthCheckedAt !== undefined && input.healthCheckedAt !== null &&
    !Number.isFinite(Date.parse(input.healthCheckedAt))
  ) throw new DomainError("validation_error", "Provider health timestamp is invalid", 422);
}
function validateProviderModelInput(
  input: Partial<CreateProviderModelInput & UpdateProviderModelInput>,
) {
  if (
    input.publicModelId !== undefined &&
    (input.publicModelId.length < 3 || input.publicModelId.length > 255 ||
      input.publicModelId.indexOf("/") < 1)
  ) throw new DomainError("validation_error", "Public model ID must be namespaced", 422);
  for (
    const [value, maximum] of [[input.upstreamModelId, 255], [input.displayName, 120]] as const
  ) {
    if (value !== undefined && (value.trim().length < 1 || value.length > maximum)) {
      throw new DomainError("validation_error", "Provider model text is invalid", 422);
    }
  }
  if (
    input.contextWindow !== undefined &&
    (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 1)
  ) throw new DomainError("validation_error", "Model context window is invalid", 422);
  if (
    input.capabilities !== undefined &&
    (input.capabilities.length > 64 ||
      new Set(input.capabilities).size !== input.capabilities.length ||
      input.capabilities.some((value) => !value || value.length > 64))
  ) throw new DomainError("validation_error", "Model capabilities are invalid", 422);
  if (
    input.customParams !== undefined &&
    (input.customParams === null || Array.isArray(input.customParams))
  ) throw new DomainError("validation_error", "Model custom parameters are invalid", 422);
}
function validatePriceInput(input: CreateModelPriceVersionInput) {
  if (!Number.isFinite(Date.parse(input.effectiveAt))) {
    throw new DomainError("validation_error", "Price effective timestamp is invalid", 422);
  }
  for (
    const value of [
      input.inputMicrosPerMillion,
      input.cachedInputMicrosPerMillion,
      input.reasoningMicrosPerMillion,
      input.outputMicrosPerMillion,
      input.fixedCallMicros,
    ]
  ) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DomainError("validation_error", "Price amounts must be non-negative integers", 422);
    }
  }
  if (!input.source.trim() || input.source.length > 120) {
    throw new DomainError("validation_error", "Price source is invalid", 422);
  }
}
function validateRetryPolicy(input: CreateProviderRetryPolicyInput) {
  const valid = (value: number, min: number, max: number) =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  if (
    !input.name.trim() || input.name.length > 120 || !valid(input.maxAttempts, 1, 8) ||
    !valid(input.maxRetries, 0, 3) || input.maxRetries >= input.maxAttempts ||
    !valid(input.baseDelayMs, 0, 60_000) || !valid(input.maxDelayMs, input.baseDelayMs, 300_000) ||
    !valid(input.backoffMultiplierBps, 10_000, 40_000) || !valid(input.jitterBps, 0, 10_000) ||
    !valid(input.firstTokenTimeoutMs, 250, 300_000) || !valid(input.idleTimeoutMs, 250, 300_000) ||
    !valid(
      input.totalTimeoutMs,
      Math.max(input.firstTokenTimeoutMs, input.idleTimeoutMs),
      900_000,
    ) ||
    input.retryableStatuses.length > 32 ||
    new Set(input.retryableStatuses).size !== input.retryableStatuses.length ||
    input.retryableStatuses.some((status) => ![408, 425, 429, 500, 502, 503, 504].includes(status))
  ) {
    throw new DomainError("validation_error", "Provider retry policy is invalid", 422);
  }
}
function validateAttemptFinish(input: FinishProviderAttemptInput) {
  const count = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
  if (
    ![input.inputTokens, input.cachedInputTokens, input.reasoningTokens, input.outputTokens].every(
      count,
    ) ||
    input.cachedInputTokens > input.inputTokens || input.reasoningTokens > input.outputTokens ||
    !Number.isSafeInteger(input.costMicros) || input.costMicros < 0 ||
    !Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 ||
    (input.ttftMs != null &&
      (!Number.isSafeInteger(input.ttftMs) || input.ttftMs < 0 ||
        input.ttftMs > input.latencyMs)) ||
    (input.httpStatus != null &&
      (!Number.isSafeInteger(input.httpStatus) || input.httpStatus < 100 ||
        input.httpStatus > 599)) ||
    (input.errorCode != null && !/^[a-z0-9][a-z0-9_.-]{0,119}$/.test(input.errorCode)) ||
    (input.status === "succeeded" &&
      (input.phase !== "complete" || input.errorCode != null ||
        (input.httpStatus != null && (input.httpStatus < 200 || input.httpStatus > 299)))) ||
    (["failed", "cancelled", "skipped"].includes(input.status) && input.errorCode == null) ||
    (input.status === "skipped" &&
      (input.visibleOutput || input.inputTokens + input.outputTokens + input.costMicros !== 0 ||
        input.tokenSource !== "none" || input.costSource !== "none")) ||
    (input.breakerAfter != null &&
      !["closed", "open", "half_open", "unavailable"].includes(input.breakerAfter)) ||
    (input.upstreamRequestId != null &&
      !/^[A-Za-z0-9._:-]{1,255}$/.test(input.upstreamRequestId)) ||
    (input.tokensPerSecond != null &&
      (!Number.isFinite(input.tokensPerSecond) || input.tokensPerSecond < 0 ||
        input.tokensPerSecond > 1_000_000))
  ) {
    throw new DomainError("validation_error", "Provider attempt telemetry is invalid", 422);
  }
}
function exactAttemptCost(attempt: ProviderAttempt, input: FinishProviderAttemptInput): number {
  if (input.status === "skipped") return 0;
  if (
    input.costSource === "none" && input.costMicros === 0 && input.inputTokens === 0 &&
    input.outputTokens === 0 && input.status !== "succeeded"
  ) return 0;
  const numerator = BigInt(input.inputTokens - input.cachedInputTokens) *
      BigInt(attempt.pricing.inputMicrosPerMillion) +
    BigInt(input.cachedInputTokens) * BigInt(attempt.pricing.cachedInputMicrosPerMillion) +
    BigInt(input.reasoningTokens) * BigInt(attempt.pricing.reasoningMicrosPerMillion) +
    BigInt(input.outputTokens - input.reasoningTokens) *
      BigInt(attempt.pricing.outputMicrosPerMillion);
  const cost = BigInt(attempt.pricing.fixedCallMicros) + (numerator + 999_999n) / 1_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError(
      "accounting_overflow",
      "Provider attempt cost exceeds accounting bounds",
      422,
    );
  }
  return Number(cost);
}
function validateCredentialEnvelope(envelope: ProviderCredentialEnvelope) {
  const strings = [
    envelope.wrappedKeyNonce,
    envelope.wrappedKey,
    envelope.contentNonce,
    envelope.ciphertext,
  ];
  if (
    envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(envelope.keyId) ||
    !Number.isSafeInteger(envelope.credentialVersion) || envelope.credentialVersion < 1 ||
    strings.some((value) =>
      typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 65_536
    )
  ) throw new DomainError("validation_error", "Provider credential envelope is invalid", 422);
}
function validateRegistryMutation(mutation: RegistryMutationContext) {
  if (!mutation.action.trim() || mutation.action.length > 255) {
    throw new DomainError("validation_error", "Registry audit action is invalid", 422);
  }
}

function validateDocumentChunks(
  chunks: DocumentChunkInput[],
  attachmentId: string,
): DocumentChunkInput[] {
  try {
    return validateDocumentChunkInputs(chunks, attachmentId);
  } catch {
    throw new DomainError("invalid_document_chunks", "Document chunks are invalid", 422);
  }
}
function validateAttachmentInput(input: CreateAttachmentInput) {
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new DomainError("validation_error", "Attachment SHA-256 is invalid", 422);
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new DomainError("validation_error", "Attachment size is invalid", 422);
  }
  if (
    !input.filename || input.filename.length > 255 || /[\\/\0]/.test(input.filename) ||
    !input.mimeType || input.mimeType.length > 255 ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ||
    !input.objectKey || input.objectKey.length > 1024 || input.objectKey.startsWith("/") ||
    input.objectKey.split("/").some((part) => part === ".." || part === "")
  ) throw new DomainError("validation_error", "Attachment metadata is invalid", 422);
}
function apiRequest(row: Row, frames: ApiIdempotencyFrame[] = []): ApiIdempotencyRequest {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    endpoint: row.endpoint as ApiIdempotencyEndpoint,
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    stream: Boolean(row.stream),
    model: String(row.model),
    state: row.state as ApiIdempotencyRequest["state"],
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    usageRunId: String(row.usage_run_id),
    responseStatus: row.response_status == null ? null : number(row.response_status),
    responseHeaders: (row.response_headers ?? {}) as Record<string, string>,
    responseBody: row.response_body == null ? null : String(row.response_body),
    failureStartedStream: Boolean(row.failure_started_stream),
    observedInputTokens: number(row.observed_input_tokens),
    observedOutputTokens: number(row.observed_output_tokens),
    observedCostMicros: number(row.observed_cost_micros),
    observedLatencyMs: number(row.observed_latency_ms),
    retentionSeconds: number(row.retention_seconds),
    frames,
    createdAt: iso(row.created_at),
    completedAt: nullableIso(row.completed_at),
    expiresAt: iso(row.expires_at),
  };
}
function apiFrame(row: Row): ApiIdempotencyFrame {
  return {
    sequence: number(row.sequence),
    frame: String(row.frame),
    createdAt: iso(row.created_at),
  };
}

export class PostgresRepository implements DomainRepository {
  readonly storageKind = "postgres" as const;
  readonly #sql: ReturnType<typeof postgres>;
  private constructor(sql: ReturnType<typeof postgres>) {
    this.#sql = sql;
  }
  static async connect(url: string) {
    const sql = postgres(url, { max: 10 });
    await sql`SELECT 1`;
    return new PostgresRepository(sql);
  }
  async close() {
    await this.#sql.end({ timeout: 5 });
  }

  async bootstrapAdmin(input: CreateUserInput, credit: number) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-bootstrap'))`;
      const existing = await tx<Row[]>`SELECT id FROM users WHERE role = 'admin' LIMIT 1`;
      if (existing.length) {
        throw new DomainError("already_bootstrapped", "An administrator already exists", 409);
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO users (email,name,password_hash,role,approval_status,state,balance_micros,email_verified_at) VALUES (${input.email},${input.name},${input.passwordHash},'admin','approved','active',${credit},now()) RETURNING *`;
      const userId = String(rows[0].id);
      await tx`INSERT INTO ledger_entries (user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES (${userId},${`bootstrap:${userId}`},'grant',${credit},${credit})`;
      return user(rows[0]);
    });
  }
  async createUser(input: CreateUserInput) {
    try {
      const rows = await this.#sql<
        Row[]
      >`INSERT INTO users (email,name,password_hash,role,approval_status,state,email_verified_at) VALUES (${input.email},${input.name},${input.passwordHash},${
        input.role ?? "user"
      },${input.approvalStatus ?? "pending"},${input.state ?? "active"},${
        input.emailVerified || input.approvalStatus === "approved" ? new Date().toISOString() : null
      }) RETURNING *`;
      return user(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("email_taken", "An account with that email already exists", 409);
      }
      throw error;
    }
  }
  async findUser(id: string) {
    const rows = await this.#sql<Row[]>`SELECT * FROM users WHERE id=${id}`;
    return rows[0] ? user(rows[0]) : undefined;
  }
  async findUserByEmail(email: string) {
    const rows = await this.#sql<Row[]>`SELECT * FROM users WHERE email=${email}`;
    return rows[0] ? user(rows[0]) : undefined;
  }
  async listUsers() {
    return (await this.#sql<Row[]>`SELECT * FROM users ORDER BY created_at`).map(user).map(
      publicUser,
    );
  }
  async createSession(userId: string, tokenHash: string, limited: boolean) {
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO sessions (user_id,token_hash,limited,expires_at) VALUES (${userId},${tokenHash},${limited},now()+interval '30 days') RETURNING *`;
    return {
      id: String(rows[0].id),
      tokenHash: String(rows[0].token_hash),
      userId: String(rows[0].user_id),
      limited: Boolean(rows[0].limited),
      expiresAt: new Date(rows[0].expires_at as string).getTime(),
      createdAt: iso(rows[0].created_at),
      invalidatedAt: nullableIso(rows[0].invalidated_at),
    };
  }
  async getSession(tokenHash: string): Promise<StoredSession | undefined> {
    const rows = await this.#sql<
      Row[]
    >`SELECT * FROM sessions WHERE token_hash=${tokenHash} AND invalidated_at IS NULL AND expires_at>now()`;
    return rows[0]
      ? {
        id: String(rows[0].id),
        tokenHash,
        userId: String(rows[0].user_id),
        limited: Boolean(rows[0].limited),
        expiresAt: new Date(rows[0].expires_at as string).getTime(),
        createdAt: iso(rows[0].created_at),
        invalidatedAt: nullableIso(rows[0].invalidated_at),
      }
      : undefined;
  }
  async invalidateUserSessions(userId: string) {
    await this
      .#sql`UPDATE sessions SET invalidated_at=now() WHERE user_id=${userId} AND invalidated_at IS NULL`;
  }
  async deleteSession(tokenHash: string) {
    await this.#sql`UPDATE sessions SET invalidated_at=now() WHERE token_hash=${tokenHash}`;
  }
  async listSessions(userId: string): Promise<SessionSummary[]> {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM sessions WHERE user_id=${userId} ORDER BY created_at DESC`).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      limited: Boolean(row.limited),
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      invalidatedAt: nullableIso(row.invalidated_at),
    }));
  }
  async revokeSession(id: string, ownerId?: string) {
    const rows = ownerId
      ? await this
        .#sql`UPDATE sessions SET invalidated_at=now() WHERE id=${id} AND user_id=${ownerId} AND invalidated_at IS NULL RETURNING id`
      : await this
        .#sql`UPDATE sessions SET invalidated_at=now() WHERE id=${id} AND invalidated_at IS NULL RETURNING id`;
    if (!rows.length) throw new DomainError("not_found", "Session not found", 404);
  }
  async createIdentityToken(
    userId: string,
    purpose: IdentityTokenPurpose,
    tokenHash: string,
    expiresAt: string,
  ) {
    await this
      .#sql`INSERT INTO identity_tokens(user_id,purpose,token_hash,expires_at) VALUES(${userId},${purpose},${tokenHash},${expiresAt})`;
  }
  async verifyEmail(tokenHash: string) {
    return await this.#sql.begin(async (tx) => {
      const tokens = await tx<
        Row[]
      >`UPDATE identity_tokens SET consumed_at=now() WHERE token_hash=${tokenHash} AND purpose='email_verification' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`;
      if (!tokens[0]) {
        throw new DomainError(
          "invalid_identity_token",
          "Verification token is invalid or expired",
          400,
        );
      }
      const rows = await tx<
        Row[]
      >`UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=${
        String(tokens[0].user_id)
      } RETURNING *`;
      return user(rows[0]);
    });
  }
  async resetPassword(tokenHash: string, passwordHash: string) {
    return await this.#sql.begin(async (tx) => {
      const tokens = await tx<
        Row[]
      >`UPDATE identity_tokens SET consumed_at=now() WHERE token_hash=${tokenHash} AND purpose='password_reset' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`;
      if (!tokens[0]) {
        throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
      }
      const userId = String(tokens[0].user_id);
      const rows = await tx<
        Row[]
      >`UPDATE users SET password_hash=${passwordHash},updated_at=now() WHERE id=${userId} RETURNING *`;
      await tx`UPDATE sessions SET invalidated_at=now() WHERE user_id=${userId} AND invalidated_at IS NULL`;
      await tx`UPDATE api_tokens SET revoked_at=now() WHERE user_id=${userId} AND revoked_at IS NULL`;
      await tx`UPDATE identity_tokens SET consumed_at=now() WHERE user_id=${userId} AND consumed_at IS NULL`;
      return user(rows[0]);
    });
  }
  async recordAudit(input: AuditEventInput): Promise<AuditEvent> {
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata) VALUES(${
      input.actorId ?? null
    },${input.action},${input.targetType},${input.targetId ?? null},${
      this.#sql.json((input.metadata ?? {}) as postgres.JSONValue)
    }) RETURNING *`;
    const row = rows[0];
    return {
      id: String(row.id),
      actorId: row.actor_id ? String(row.actor_id) : null,
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: row.target_id ? String(row.target_id) : null,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: iso(row.created_at),
    };
  }
  async listAudit(query: AuditQuery = {}): Promise<AuditPage> {
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new DomainError("validation_error", "Audit limit must be between 1 and 200", 422);
    }
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : undefined;
    if (query.cursor && !cursor) {
      throw new DomainError("validation_error", "Invalid audit cursor", 422);
    }
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    if ((query.from && !Number.isFinite(from)) || (query.to && !Number.isFinite(to))) {
      throw new DomainError("validation_error", "Invalid audit date range", 422);
    }
    if (from !== undefined && to !== undefined && from > to) {
      throw new DomainError("validation_error", "Audit date range is reversed", 422);
    }
    const fromIso = from === undefined ? null : new Date(from).toISOString();
    const toIso = to === undefined ? null : new Date(to).toISOString();
    const cursorTimestamp = cursor?.kind === "postgres_timestamp"
      ? cursor.timestamp
      : cursor?.kind === "timestamp"
      ? cursor.createdAt
      : null;
    const rows = await this.#sql<Row[]>`
      SELECT *,created_at::text audit_cursor_timestamp
      FROM audit_events
      WHERE (${query.action ?? null}::text IS NULL OR action=${query.action ?? null})
        AND (${query.actorId ?? null}::text IS NULL OR actor_id::text=${query.actorId ?? null})
        AND (${query.targetType ?? null}::text IS NULL OR target_type=${query.targetType ?? null})
        AND (${query.targetId ?? null}::text IS NULL OR target_id::text=${query.targetId ?? null})
        AND (${fromIso}::timestamptz IS NULL OR created_at>=${fromIso})
        AND (${toIso}::timestamptz IS NULL OR created_at<=${toIso})
        AND (${cursorTimestamp}::text IS NULL OR
          (created_at,id)<(${cursorTimestamp}::text::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
    const events = rows.map((row) => ({
      id: String(row.id),
      actorId: row.actor_id ? String(row.actor_id) : null,
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: row.target_id ? String(row.target_id) : null,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: iso(row.created_at),
    }));
    const data = events.slice(0, limit);
    return {
      data,
      nextCursor: events.length > limit
        ? encodeAuditPostgresCursor(
          String(rows[limit - 1].audit_cursor_timestamp),
          String(rows[limit - 1].id),
        )
        : null,
    };
  }

  async approveUser(
    id: string,
    status: "approved" | "rejected",
    credit: number,
    requireEmailVerification = false,
  ) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await tx<Row[]>`SELECT * FROM users WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
      if (status === "approved" && requireEmailVerification && !rows[0].email_verified_at) {
        throw new DomainError("email_not_verified", "Email must be verified before approval", 409);
      }
      if (rows[0].role === "admin" && status === "rejected") {
        const count = await tx<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM users WHERE role='admin' AND state='active' AND approval_status='approved'`;
        if (count[0].count <= 1) {
          throw new DomainError(
            "final_admin",
            "The final approved administrator is protected",
            409,
          );
        }
      }
      let balance = number(rows[0].balance_micros);
      if (status === "approved" && credit > 0) {
        const balanceAfterGrant = balance + credit;
        const grant =
          await tx`INSERT INTO ledger_entries (user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES (${id},${`approval:${id}`},'grant',${credit},${balanceAfterGrant}) ON CONFLICT DO NOTHING RETURNING id`;
        if (grant.length) balance = balanceAfterGrant;
      }
      const updated = await tx<
        Row[]
      >`UPDATE users SET approval_status=${status},balance_micros=${balance},updated_at=now() WHERE id=${id} RETURNING *`;
      if (status === "rejected") {
        await tx`UPDATE sessions SET invalidated_at=now() WHERE user_id=${id} AND invalidated_at IS NULL`;
        await tx`UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${id}`;
      }
      return user(updated[0]);
    });
  }
  async setUserState(id: string, state: AccountState) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await tx<Row[]>`SELECT * FROM users WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
      if (rows[0].role === "admin" && state !== "active") {
        const count = await tx<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM users WHERE role='admin' AND state='active' AND approval_status='approved'`;
        if (count[0].count <= 1) {
          throw new DomainError("final_admin", "The final active administrator is protected", 409);
        }
      }
      const updated = await tx<Row[]>`UPDATE users SET state=${state},deleted_at=${
        state === "deleted" ? new Date() : null
      },updated_at=now() WHERE id=${id} RETURNING *`;
      if (state !== "active") {
        await tx`UPDATE sessions SET invalidated_at=now() WHERE user_id=${id}`;
        await tx`UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${id}`;
      }
      return user(updated[0]);
    });
  }

  async createConversation(
    ownerId: string,
    title: string,
    temporary = false,
    idempotencyKey?: string,
  ) {
    return await this.#sql.begin(async (tx) => {
      const fingerprint = JSON.stringify({ title, temporary });
      if (idempotencyKey) {
        const prior = await tx<
          Row[]
        >`SELECT payload_hash,result_id FROM operation_idempotency WHERE owner_id=${ownerId} AND operation='conversation.create' AND idempotency_key=${idempotencyKey}`;
        if (prior[0]) {
          if (prior[0].payload_hash !== fingerprint) {
            throw new DomainError(
              "idempotency_conflict",
              "Conversation replay payload differs",
              409,
            );
          }
          const rows = await tx<Row[]>`SELECT * FROM conversations WHERE id=${
            String(prior[0].result_id)
          } AND owner_id=${ownerId}`;
          return conversation(rows[0]);
        }
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO conversations(owner_id,title,temporary) VALUES(${ownerId},${title},${temporary}) RETURNING *`;
      if (idempotencyKey) {
        await tx`INSERT INTO operation_idempotency(owner_id,operation,idempotency_key,payload_hash,result_id) VALUES(${ownerId},'conversation.create',${idempotencyKey},${fingerprint},${
          String(rows[0].id)
        })`;
      }
      return conversation(rows[0]);
    });
  }
  async listConversations(ownerId: string, includeDeleted = false) {
    const rows = includeDeleted
      ? await this.#sql<
        Row[]
      >`SELECT * FROM conversations WHERE owner_id=${ownerId} ORDER BY updated_at DESC`
      : await this.#sql<
        Row[]
      >`SELECT * FROM conversations WHERE owner_id=${ownerId} AND deleted_at IS NULL ORDER BY updated_at DESC`;
    return rows.map(conversation);
  }
  async updateConversation(ownerId: string, id: string, patch: ConversationPatch) {
    const rows = await this.#sql<Row[]>`UPDATE conversations SET title=COALESCE(${
      patch.title ?? null
    },title),pinned=COALESCE(${patch.pinned ?? null},pinned),archived_at=CASE WHEN ${
      patch.archived ?? null
    }::boolean IS NULL THEN archived_at WHEN ${
      patch.archived ?? false
    } THEN now() ELSE NULL END,deleted_at=CASE WHEN ${
      patch.deleted ?? null
    }::boolean IS NULL THEN deleted_at WHEN ${
      patch.deleted ?? false
    } THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=${id} AND owner_id=${ownerId} RETURNING *`;
    if (!rows[0]) throw new DomainError("not_found", "Conversation not found", 404);
    return conversation(rows[0]);
  }
  async detail(id: string, ownerId: string) {
    const rows = await this.#sql<
      Row[]
    >`SELECT * FROM conversations WHERE id=${id} AND owner_id=${ownerId}`;
    if (!rows[0]) throw new DomainError("not_found", "Conversation not found", 404);
    const nodes = await this.#sql<
      Row[]
    >`SELECT * FROM messages WHERE conversation_id=${id} ORDER BY created_at,id`;
    return { ...conversation(rows[0]), messages: nodes.map(message) };
  }
  async appendMessage(input: AppendMessageInput) {
    return await this.#sql.begin(async (tx) => {
      const conversations = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.conversationId} AND owner_id=${input.ownerId} FOR UPDATE`;
      if (!conversations[0]) throw new DomainError("not_found", "Conversation not found", 404);
      if (conversations[0].deleted_at) {
        throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
      }
      if (conversations[0].archived_at) {
        throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
      }
      const existing = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.conversationId} AND idempotency_key=${input.idempotencyKey}`;
      if (existing[0]) {
        const prior = message(existing[0]);
        if (
          prior.parentId !== input.parentId ||
          prior.supersedesId !== (input.supersedesId ?? null) ||
          prior.role !== input.role || prior.content !== input.content ||
          prior.model !== (input.model ?? null)
        ) {
          throw new DomainError(
            "idempotency_conflict",
            "This idempotency key was used with a different message",
            409,
          );
        }
        return prior;
      }
      if (number(conversations[0].version) !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Conversation changed in another tab", 409);
      }
      if (input.parentId) {
        const parent = await tx<
          Row[]
        >`SELECT id FROM messages WHERE id=${input.parentId} AND conversation_id=${input.conversationId}`;
        if (!parent[0]) {
          throw new DomainError("invalid_parent", "Parent is not in this conversation", 422);
        }
      }
      if (input.supersedesId) {
        const sibling = await tx<
          Row[]
        >`SELECT id FROM messages WHERE id=${input.supersedesId} AND conversation_id=${input.conversationId} AND parent_id IS NOT DISTINCT FROM ${input.parentId}`;
        if (!sibling[0]) {
          throw new DomainError(
            "invalid_supersedes",
            "Edited messages must branch beside the original",
            422,
          );
        }
      }
      const indexRows = await tx<
        { next: number }[]
      >`SELECT count(*)::int AS next FROM messages WHERE conversation_id=${input.conversationId} AND parent_id IS NOT DISTINCT FROM ${input.parentId}`;
      const inserted = await tx<
        Row[]
      >`INSERT INTO messages(conversation_id,parent_id,supersedes_id,generation_id,sibling_index,role,content,model,metadata,idempotency_key) VALUES(${input.conversationId},${input.parentId},${
        input.supersedesId ?? null
      },${input.role === "assistant" ? crypto.randomUUID() : null},${
        indexRows[0].next
      },${input.role},${input.content},${input.model ?? null},${
        this.#sql.json((input.metadata ?? {}) as postgres.JSONValue)
      },${input.idempotencyKey}) RETURNING *`;
      const insertedId = String(inserted[0].id);
      await tx`UPDATE conversations SET active_leaf_id=${insertedId},version=version+1,updated_at=now() WHERE id=${input.conversationId}`;
      return message(inserted[0]);
    });
  }
  async beginGeneration(input: BeginGenerationInput) {
    const leaseSeconds = input.leaseSeconds ?? 120;
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new DomainError("validation_error", "Generation lease duration is invalid", 422);
    }
    if (input.pricingSnapshot !== undefined && !isUsagePricingSnapshot(input.pricingSnapshot)) {
      throw new DomainError("validation_error", "Usage pricing snapshot is invalid", 422);
    }
    const attachmentIds = [...(input.attachmentIds ?? [])].sort();
    if (new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.length > 10) {
      throw new DomainError("validation_error", "Attachment identifiers are invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      if (!input.message.content.trim() && attachmentIds.length === 0) {
        throw new DomainError(
          "validation_error",
          "Message content or at least one attachment is required",
          422,
        );
      }
      const c = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.message.conversationId} AND owner_id=${input.message.ownerId} FOR UPDATE`;
      if (!c[0]) throw new DomainError("not_found", "Conversation not found", 404);
      if (c[0].deleted_at) {
        throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
      }
      if (c[0].archived_at) {
        throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
      }
      if (input.message.role !== "user") {
        throw new DomainError("invalid_role", "A generation must begin with a user message", 422);
      }
      const prior = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.message.conversationId} AND idempotency_key=${input.message.idempotencyKey}`;
      const priorRun = await tx<
        Row[]
      >`SELECT *,generation_lease_expires_at>now() AS generation_lease_active,GREATEST(1,ceil(extract(epoch FROM (generation_lease_expires_at-now()))))::int AS generation_lease_retry_seconds FROM usage_runs WHERE id=${input.runId} FOR UPDATE`;
      if (prior[0] && priorRun[0]) {
        const replay = message(prior[0]);
        const priorAttachments = await tx<{ attachment_id: string }[]>`
          SELECT attachment_id FROM message_attachments
          WHERE message_id=${replay.id}
          ORDER BY attachment_id
        `;
        if (
          replay.content !== input.message.content || replay.parentId !== input.message.parentId ||
          replay.supersedesId !== (input.message.supersedesId ?? null) ||
          replay.role !== input.message.role ||
          replay.model !== (input.message.model ?? null) ||
          String(priorRun[0].user_id) !== input.message.ownerId ||
          priorAttachments.map((row) => String(row.attachment_id)).join("\0") !==
            [...attachmentIds].sort().join("\0")
        ) {
          throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
        }
        if (priorRun[0].status === "completed" || priorRun[0].status === "failed") {
          return {
            kind: "completed" as const,
            message: replay,
            conversation: conversation(c[0]),
            usageRun: run(priorRun[0]),
          };
        }
        if (priorRun[0].generation_lease_active === true) {
          return {
            kind: "in_progress" as const,
            message: replay,
            conversation: conversation(c[0]),
            usageRun: run(priorRun[0]),
            retryAfterSeconds: number(priorRun[0].generation_lease_retry_seconds),
          };
        }
        const leaseToken = crypto.randomUUID();
        const claimed = await tx<
          Row[]
        >`UPDATE usage_runs SET generation_lease_token=${leaseToken},generation_lease_expires_at=now()+${leaseSeconds}*interval '1 second' WHERE id=${input.runId} AND status='reserved' RETURNING *`;
        return {
          kind: "claimed" as const,
          leaseToken,
          message: replay,
          conversation: conversation(c[0]),
          usageRun: run(claimed[0]),
        };
      }
      if (prior[0] || priorRun[0]) {
        throw new DomainError("idempotency_conflict", "Incomplete generation replay", 409);
      }
      if (number(c[0].version) !== input.message.expectedVersion) {
        throw new DomainError("version_conflict", "Conversation changed in another tab", 409);
      }
      const running = await tx`SELECT 1 FROM generation_controls
        WHERE conversation_id=${input.message.conversationId} AND terminal_at IS NULL FOR UPDATE`;
      if (running.length) {
        throw new DomainError("generation_in_progress", "A generation is already active", 409);
      }
      if (input.message.parentId) {
        const p = await tx`SELECT id FROM messages WHERE id=${input.message.parentId}
          AND conversation_id=${input.message.conversationId} AND role='assistant'`;
        if (!p.length) {
          throw new DomainError(
            "invalid_parent",
            "A new user turn must follow an assistant response",
            422,
          );
        }
      }
      if (!input.message.parentId && c[0].active_leaf_id && !input.message.supersedesId) {
        throw new DomainError(
          "invalid_parent",
          "A non-empty conversation requires a parent or an explicit root edit",
          422,
        );
      }
      if (input.message.supersedesId) {
        const s = await tx`SELECT id FROM messages WHERE id=${input.message.supersedesId}
            AND conversation_id=${input.message.conversationId} AND role='user'
            AND parent_id IS NOT DISTINCT FROM ${input.message.parentId}`;
        if (!s.length) {
          throw new DomainError(
            "invalid_supersedes",
            "Edited user messages must branch beside another user message",
            422,
          );
        }
      }
      for (const attachmentId of attachmentIds) {
        const ready = await tx`
          SELECT id FROM attachments
          WHERE id=${attachmentId} AND owner_id=${input.message.ownerId}
            AND state='ready' AND deleted_at IS NULL
          FOR UPDATE
        `;
        if (!ready.length) {
          throw new DomainError("attachment_not_ready", "Attachment is not ready", 409);
        }
      }
      const account = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.message.ownerId} FOR UPDATE`;
      const balance = number(account[0].balance_micros);
      if (balance < input.reserveMicros) {
        throw new DomainError("insufficient_credit", "Insufficient credit", 402);
      }
      const idx = await tx<
        { next: number }[]
      >`SELECT count(*)::int next FROM messages WHERE conversation_id=${input.message.conversationId} AND parent_id IS NOT DISTINCT FROM ${input.message.parentId}`;
      const nodes = await tx<
        Row[]
      >`INSERT INTO messages(conversation_id,parent_id,supersedes_id,sibling_index,role,content,model,metadata,idempotency_key) VALUES(${input.message.conversationId},${input.message.parentId},${
        input.message.supersedesId ?? null
      },${idx[0].next},${input.message.role},${input.message.content},${
        input.message.model ?? null
      },${
        tx.json((input.message.metadata ?? {}) as postgres.JSONValue)
      },${input.message.idempotencyKey}) RETURNING *`;
      const leaseToken = crypto.randomUUID();
      const pricing = input.pricingSnapshot;
      const runs = await tx<
        Row[]
      >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,status,reserved_micros,pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source,generation_lease_token,generation_lease_expires_at) VALUES(${input.runId},${input.message.ownerId},${
        input.tokenId ?? null
      },${input.message.model ?? "unknown"},${input.provider},'reserved',${input.reserveMicros},${
        pricing?.pricingVersionId ?? null
      },${pricing?.inputMicrosPerMillion ?? null},${pricing?.cachedInputMicrosPerMillion ?? null},${
        pricing?.reasoningMicrosPerMillion ?? null
      },${pricing?.outputMicrosPerMillion ?? null},${pricing?.fixedCallMicros ?? null},${
        pricing?.source ?? null
      },${leaseToken},now()+${leaseSeconds}*interval '1 second') RETURNING *`;
      await tx`INSERT INTO generation_controls(run_id,generation_id,conversation_id,owner_id,user_message_id)
        VALUES(${input.runId},${
        input.generationId ?? crypto.randomUUID()
      },${input.message.conversationId},${input.message.ownerId},${String(nodes[0].id)})`;
      for (const attachmentId of attachmentIds) {
        await tx`
          INSERT INTO message_attachments(message_id,attachment_id)
          VALUES(${String(nodes[0].id)},${attachmentId})
        `;
      }
      const after = balance - input.reserveMicros;
      await tx`UPDATE users SET balance_micros=${after} WHERE id=${input.message.ownerId}`;
      await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.message.ownerId},${input.runId},'reserve',${-input
        .reserveMicros},${after})`;
      const updated = await tx<Row[]>`UPDATE conversations SET active_leaf_id=${
        String(nodes[0].id)
      },version=version+1,updated_at=now() WHERE id=${input.message.conversationId} RETURNING *`;
      return {
        kind: "started" as const,
        leaseToken,
        message: message(nodes[0]),
        conversation: conversation(updated[0]),
        usageRun: run(runs[0]),
      };
    });
  }

  async beginAssistantGeneration(input: BeginAssistantGenerationInput) {
    const leaseSeconds = input.leaseSeconds ?? 120;
    return await this.#sql.begin(async (tx) => {
      const conversations = await tx<Row[]>`
        SELECT * FROM conversations WHERE id=${input.conversationId}
          AND owner_id=${input.ownerId} FOR UPDATE
      `;
      const current = conversations[0];
      if (!current || current.deleted_at) {
        throw new DomainError("not_found", "Conversation not found", 404);
      }
      if (current.archived_at) {
        throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
      }
      const sources = await tx<Row[]>`
        SELECT source.*, parent.role AS parent_role, parent.id AS user_message_id
        FROM messages source JOIN messages parent ON parent.id=source.parent_id
        WHERE source.id=${input.sourceAssistantId}
          AND source.conversation_id=${input.conversationId}
          AND source.role='assistant' AND parent.role='user'
      `;
      const source = sources[0];
      if (!source) {
        throw new DomainError(
          "invalid_generation_source",
          "Source must be an assistant response",
          422,
        );
      }
      const sourceUserMessageId = String(source.user_message_id);
      const priorRuns = await tx<Row[]>`SELECT *,generation_lease_expires_at>now() AS lease_active,
        GREATEST(1,ceil(extract(epoch FROM (generation_lease_expires_at-now()))))::int AS retry_seconds
        FROM usage_runs WHERE id=${input.runId} FOR UPDATE`;
      const priorControls = await tx<Row[]>`SELECT * FROM generation_controls
        WHERE run_id=${input.runId} FOR UPDATE`;
      if (priorRuns[0] && priorControls[0]) {
        const runRow = priorRuns[0];
        const control = priorControls[0];
        if (
          String(control.source_message_id) !== input.sourceAssistantId ||
          String(control.mode) !== input.mode || String(runRow.model) !== input.model ||
          String(runRow.user_id) !== input.ownerId
        ) throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
        const userRows = await tx<Row[]>`SELECT * FROM messages WHERE id=${sourceUserMessageId}`;
        const user = message(userRows[0]);
        if (runRow.status === "completed" || runRow.status === "failed") {
          return {
            kind: "completed" as const,
            message: user,
            conversation: conversation(current),
            usageRun: run(runRow),
          };
        }
        if (runRow.lease_active === true) {
          return {
            kind: "in_progress" as const,
            message: user,
            conversation: conversation(current),
            usageRun: run(runRow),
            retryAfterSeconds: number(runRow.retry_seconds),
          };
        }
        const leaseToken = crypto.randomUUID();
        const claimed = await tx<Row[]>`UPDATE usage_runs SET generation_lease_token=${leaseToken},
          generation_lease_expires_at=now()+${leaseSeconds}*interval '1 second'
          WHERE id=${input.runId} AND status='reserved' RETURNING *`;
        return {
          kind: "claimed" as const,
          leaseToken,
          message: user,
          conversation: conversation(current),
          usageRun: run(claimed[0]),
        };
      }
      if (priorRuns[0] || priorControls[0]) {
        throw new DomainError("idempotency_conflict", "Incomplete generation replay", 409);
      }
      const running =
        await tx`SELECT 1 FROM generation_controls WHERE conversation_id=${input.conversationId} AND terminal_at IS NULL FOR UPDATE`;
      if (running.length) {
        throw new DomainError("generation_in_progress", "A generation is already active", 409);
      }
      const activeLeafId = String(current.active_leaf_id);
      const active = await tx<{ found: boolean }[]>`
        WITH RECURSIVE path AS (
          SELECT id,parent_id FROM messages WHERE id=${activeLeafId}
          UNION ALL
          SELECT m.id,m.parent_id FROM messages m JOIN path p ON m.id=p.parent_id
        ) SELECT EXISTS(SELECT 1 FROM path WHERE id=${input.sourceAssistantId}) AS found
      `;
      if (!active[0]?.found) {
        throw new DomainError(
          "invalid_generation_source",
          "Source is not on the active branch",
          409,
        );
      }
      if (number(current.version) !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Conversation changed in another tab", 409);
      }
      const account = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.ownerId} FOR UPDATE`;
      const balance = number(account[0].balance_micros);
      if (balance < input.reserveMicros) {
        throw new DomainError("insufficient_credit", "Insufficient credit", 402);
      }
      const leaseToken = crypto.randomUUID();
      const pricing = input.pricingSnapshot;
      const runs = await tx<
        Row[]
      >`INSERT INTO usage_runs(id,user_id,model,provider,status,reserved_micros,
        pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,
        pricing_reasoning_micros_per_million,pricing_output_micros_per_million,
        pricing_fixed_call_micros,pricing_source,generation_lease_token,generation_lease_expires_at)
        VALUES(${input.runId},${input.ownerId},${input.model},${input.provider},'reserved',${input.reserveMicros},${
        pricing?.pricingVersionId ?? null
      },${pricing?.inputMicrosPerMillion ?? null},${pricing?.cachedInputMicrosPerMillion ?? null},${
        pricing?.reasoningMicrosPerMillion ?? null
      },${pricing?.outputMicrosPerMillion ?? null},${pricing?.fixedCallMicros ?? null},${
        pricing?.source ?? null
      },${leaseToken},now()+${leaseSeconds}*interval '1 second') RETURNING *`;
      await tx`INSERT INTO generation_controls(run_id,generation_id,conversation_id,owner_id,user_message_id,mode,source_message_id)
        VALUES(${input.runId},${input.generationId},${input.conversationId},${input.ownerId},${sourceUserMessageId},${input.mode},${input.sourceAssistantId})`;
      const after = balance - input.reserveMicros;
      await tx`UPDATE users SET balance_micros=${after} WHERE id=${input.ownerId}`;
      await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros)
        VALUES(${input.ownerId},${input.runId},'reserve',${-input.reserveMicros},${after})`;
      const userRows = await tx<Row[]>`SELECT * FROM messages WHERE id=${sourceUserMessageId}`;
      // The conversation row is locked and its version was checked above, so selecting
      // an earlier source here is atomic with reserving the generation. A concurrent
      // explicit branch selection either wins first (causing version_conflict) or runs
      // afterwards and is preserved by terminal/reaper compare-and-set updates.
      const updated = await tx<
        Row[]
      >`UPDATE conversations SET active_leaf_id=${input.sourceAssistantId},
        version=version+1,updated_at=now() WHERE id=${input.conversationId} RETURNING *`;
      return {
        kind: "started" as const,
        leaseToken,
        message: message(userRows[0]),
        conversation: conversation(updated[0]),
        usageRun: run(runs[0]),
      };
    });
  }

  async heartbeatGeneration(
    runId: string,
    ownerId: string,
    leaseToken: string,
    leaseSeconds = 120,
  ) {
    const rows = await this
      .#sql`UPDATE usage_runs SET generation_lease_expires_at=now()+${leaseSeconds}*interval '1 second' WHERE id=${runId} AND user_id=${ownerId} AND status='reserved' AND generation_lease_token=${leaseToken} AND generation_lease_expires_at>now() RETURNING id`;
    if (!rows.length) {
      throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
    }
  }

  async requestGenerationStop(conversationId: string, ownerId: string, generationId: string) {
    const rows = await this.#sql<Row[]>`
      UPDATE generation_controls gc SET stop_requested_at=COALESCE(stop_requested_at,now())
      FROM usage_runs ur
      WHERE gc.run_id=ur.id AND gc.conversation_id=${conversationId}
        AND gc.owner_id=${ownerId} AND gc.generation_id=${generationId}
        AND gc.terminal_at IS NULL AND ur.status='reserved'
        AND ur.generation_lease_expires_at>now()
      RETURNING gc.*
    `;
    if (!rows[0]) throw new DomainError("not_found", "Active generation not found", 404);
    return {
      runId: String(rows[0].run_id),
      generationId: String(rows[0].generation_id),
      conversationId: String(rows[0].conversation_id),
      ownerId: String(rows[0].owner_id),
      userMessageId: String(rows[0].user_message_id),
      mode: String(rows[0].mode) as "send" | "regenerate" | "continue",
      sourceMessageId: rows[0].source_message_id ? String(rows[0].source_message_id) : null,
      stopRequestedAt: nullableIso(rows[0].stop_requested_at),
      terminalAt: nullableIso(rows[0].terminal_at),
    };
  }

  async generationStopRequested(runId: string, ownerId: string, leaseToken: string) {
    const rows = await this.#sql<{ requested: boolean }[]>`
      SELECT gc.stop_requested_at IS NOT NULL AS requested
      FROM generation_controls gc JOIN usage_runs ur ON ur.id=gc.run_id
      WHERE gc.run_id=${runId} AND gc.owner_id=${ownerId} AND gc.terminal_at IS NULL
        AND ur.status='reserved' AND ur.generation_lease_token=${leaseToken}
        AND ur.generation_lease_expires_at>now()
    `;
    if (!rows[0]) throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
    return rows[0].requested;
  }

  async completeGeneration(input: CompleteGenerationInput) {
    return await this.#sql.begin(async (tx) => {
      const c = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.conversationId} AND owner_id=${input.ownerId} FOR UPDATE`;
      const runs = await tx<
        Row[]
      >`SELECT *,generation_lease_expires_at>now() AS generation_lease_active FROM usage_runs WHERE id=${input.runId} AND user_id=${input.ownerId} FOR UPDATE`;
      if (!c[0] || !runs[0]) throw new DomainError("not_found", "Generation not found", 404);
      const existing = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.conversationId} AND idempotency_key=${input.idempotencyKey}`;
      if (existing[0] && runs[0].status === "completed") {
        const replay = message(existing[0]);
        if (
          replay.content !== input.content || replay.parentId !== input.userMessageId ||
          replay.model !== input.model || replay.status !== (input.status ?? "complete") ||
          replay.supersedesId !== (input.supersedesId ?? null)
        ) throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
        return {
          message: replay,
          conversation: conversation(c[0]),
          usageRun: run(runs[0]),
        };
      }
      if (runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Generation is not reserved", 409);
      }
      if (
        String(runs[0].generation_lease_token) !== input.leaseToken ||
        runs[0].generation_lease_active !== true
      ) throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
      const parent =
        await tx`SELECT id FROM messages WHERE id=${input.userMessageId} AND conversation_id=${input.conversationId}`;
      if (!parent.length) throw new DomainError("not_found", "Generation message not found", 404);
      const account = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.ownerId} FOR UPDATE`;
      const providerExecution = number(runs[0].execution_epoch) > 0;
      const uncertainty = providerExecution
        ? await tx<{ uncertain: boolean }[]>`SELECT EXISTS(SELECT 1 FROM provider_attempts
            WHERE usage_run_id=${input.runId} AND status='running') AS uncertain`
        : [{ uncertain: false }];
      const actualCost = uncertainty[0].uncertain
        ? number(runs[0].reserved_micros)
        : number(runs[0].actual_provider_cost_micros);
      const effectiveCost = providerExecution ? actualCost : input.costMicros;
      const effectiveInputTokens = providerExecution
        ? number(runs[0].actual_provider_input_tokens)
        : input.inputTokens;
      const effectiveOutputTokens = providerExecution
        ? number(runs[0].actual_provider_output_tokens)
        : input.outputTokens;
      if (providerExecution && uncertainty[0].uncertain) {
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${input.runId} AND status='running'`;
      }
      const delta = number(runs[0].reserved_micros) - effectiveCost;
      const after = number(account[0].balance_micros) + delta;
      if (after < 0) {
        throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
      }
      const idx = await tx<
        { next: number }[]
      >`SELECT count(*)::int next FROM messages WHERE conversation_id=${input.conversationId} AND parent_id=${input.userMessageId}`;
      const nodes = await tx<
        Row[]
      >`INSERT INTO messages(conversation_id,parent_id,supersedes_id,generation_id,sibling_index,role,content,model,status,metadata,idempotency_key) VALUES(${input.conversationId},${input.userMessageId},${
        input.supersedesId ?? null
      },${crypto.randomUUID()},${idx[0].next},'assistant',${input.content},${input.model},${
        input.status ?? "complete"
      },${
        tx.json((input.metadata ?? {}) as postgres.JSONValue)
      },${input.idempotencyKey}) RETURNING *`;
      await tx`UPDATE users SET balance_micros=${after} WHERE id=${input.ownerId}`;
      if (delta !== 0) {
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.ownerId},${input.runId},${
          delta > 0 ? "refund" : "settle"
        },${delta},${after})`;
      }
      const finished = await tx<
        Row[]
      >`UPDATE usage_runs SET status='completed',generation_lease_token=NULL,generation_lease_expires_at=NULL,run_lease_token=NULL,run_lease_expires_at=NULL,cost_micros=${effectiveCost},input_tokens=${effectiveInputTokens},output_tokens=${effectiveOutputTokens},latency_ms=${input.latencyMs},completed_at=now() WHERE id=${input.runId} RETURNING *`;
      await tx`UPDATE generation_controls SET terminal_at=now() WHERE run_id=${input.runId}`;
      const updated = await tx<
        Row[]
      >`UPDATE conversations SET active_leaf_id=CASE WHEN active_leaf_id=${input.userMessageId}
        OR active_leaf_id=${input.supersedesId ?? null} THEN ${
        String(nodes[0].id)
      } ELSE active_leaf_id END,version=version+1,updated_at=now() WHERE id=${input.conversationId} RETURNING *`;
      return {
        message: message(nodes[0]),
        conversation: conversation(updated[0]),
        usageRun: run(finished[0]),
      };
    });
  }

  async failGeneration(input: FailGenerationInput) {
    return await this.#sql.begin(async (tx) => {
      const c = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.conversationId} AND owner_id=${input.ownerId} FOR UPDATE`;
      const runs = await tx<
        Row[]
      >`SELECT *,generation_lease_expires_at>now() AS generation_lease_active FROM usage_runs WHERE id=${input.runId} AND user_id=${input.ownerId} FOR UPDATE`;
      if (!c[0] || !runs[0]) throw new DomainError("not_found", "Generation not found", 404);
      const existing = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.conversationId} AND idempotency_key=${input.idempotencyKey}`;
      if (existing[0] && runs[0].status === "failed") {
        const replay = message(existing[0]);
        if (
          replay.content !== (input.content ?? input.error) ||
          replay.parentId !== input.userMessageId ||
          replay.model !== input.model
        ) throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
        return {
          message: replay,
          conversation: conversation(c[0]),
          usageRun: run(runs[0]),
        };
      }
      if (runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Generation is not reserved", 409);
      }
      if (
        String(runs[0].generation_lease_token) !== input.leaseToken ||
        runs[0].generation_lease_active !== true
      ) throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
      const account = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.ownerId} FOR UPDATE`;
      const providerExecution = number(runs[0].execution_epoch) > 0;
      const uncertainty = providerExecution
        ? await tx<{ uncertain: boolean }[]>`SELECT EXISTS(SELECT 1 FROM provider_attempts
            WHERE usage_run_id=${input.runId} AND status='running') AS uncertain`
        : [{ uncertain: false }];
      const actualCost = providerExecution
        ? uncertainty[0].uncertain
          ? number(runs[0].reserved_micros)
          : number(runs[0].actual_provider_cost_micros)
        : 0;
      if (providerExecution && uncertainty[0].uncertain) {
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${input.runId} AND status='running'`;
      }
      const delta = number(runs[0].reserved_micros) - actualCost;
      const after = number(account[0].balance_micros) + delta;
      const idx = await tx<
        { next: number }[]
      >`SELECT count(*)::int next FROM messages WHERE conversation_id=${input.conversationId} AND parent_id=${input.userMessageId}`;
      const nodes = await tx<
        Row[]
      >`INSERT INTO messages(conversation_id,parent_id,supersedes_id,generation_id,sibling_index,role,content,model,status,metadata,idempotency_key) VALUES(${input.conversationId},${input.userMessageId},${
        input.supersedesId ?? null
      },${crypto.randomUUID()},${idx[0].next},'assistant',${
        input.content ?? input.error
      },${input.model},'error',${
        tx.json({ generationError: input.error, retryable: true, ...input.metadata })
      },${input.idempotencyKey}) RETURNING *`;
      await tx`UPDATE users SET balance_micros=${after} WHERE id=${input.ownerId}`;
      if (delta !== 0) {
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.ownerId},${input.runId},${
          delta > 0 ? "refund" : "settle"
        },${delta},${after})`;
      }
      const failed = await tx<
        Row[]
      >`UPDATE usage_runs SET status='failed',generation_lease_token=NULL,generation_lease_expires_at=NULL,run_lease_token=NULL,run_lease_expires_at=NULL,cost_micros=${actualCost},input_tokens=${
        providerExecution ? number(runs[0].actual_provider_input_tokens) : 0
      },output_tokens=${
        providerExecution ? number(runs[0].actual_provider_output_tokens) : 0
      },error=${input.error},completed_at=now() WHERE id=${input.runId} RETURNING *`;
      await tx`UPDATE generation_controls SET terminal_at=now() WHERE run_id=${input.runId}`;
      const updated = await tx<
        Row[]
      >`UPDATE conversations SET active_leaf_id=CASE WHEN active_leaf_id=${input.userMessageId}
        OR active_leaf_id=${input.supersedesId ?? null} THEN ${
        String(nodes[0].id)
      } ELSE active_leaf_id END,version=version+1,updated_at=now() WHERE id=${input.conversationId} RETURNING *`;
      return {
        message: message(nodes[0]),
        conversation: conversation(updated[0]),
        usageRun: run(failed[0]),
      };
    });
  }
  async reapStaleGenerations(limit = 100) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT * FROM usage_runs WHERE status='reserved' AND generation_lease_token IS NOT NULL AND generation_lease_expires_at<=now() ORDER BY generation_lease_expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      for (const row of rows) {
        const userId = String(row.user_id);
        const controls = await tx<Row[]>`SELECT * FROM generation_controls
          WHERE run_id=${String(row.id)} FOR UPDATE`;
        const control = controls[0];
        const uncertainty = await tx<{ uncertain: boolean }[]>`SELECT EXISTS(SELECT 1
          FROM provider_attempts WHERE usage_run_id=${String(row.id)} AND status='running')
          AS uncertain`;
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='generation_lease_expired',breaker_after='unavailable',retryable=true,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${String(row.id)} AND status='running'`;
        const account = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        const providerExecution = number(row.execution_epoch) > 0;
        const actualCost = providerExecution
          ? uncertainty[0].uncertain
            ? number(row.reserved_micros)
            : number(row.actual_provider_cost_micros)
          : 0;
        const amount = number(row.reserved_micros) - actualCost;
        const after = number(account[0].balance_micros) + amount;
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        if (amount !== 0) {
          await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
            String(row.id)
          },${amount > 0 ? "refund" : "settle"},${amount},${after})`;
        }
        await tx`UPDATE usage_runs SET status='failed',cost_micros=${actualCost},input_tokens=${
          providerExecution ? number(row.actual_provider_input_tokens) : 0
        },output_tokens=${
          providerExecution ? number(row.actual_provider_output_tokens) : 0
        },generation_lease_token=NULL,generation_lease_expires_at=NULL,run_lease_token=NULL,run_lease_expires_at=NULL,error='generation lease expired',completed_at=now() WHERE id=${
          String(row.id)
        }`;
        if (control) {
          const existing = await tx`SELECT id FROM messages WHERE
            conversation_id=${String(control.conversation_id)} AND role='assistant'
            AND metadata->>'runId'=${String(row.id)} LIMIT 1`;
          if (!existing.length) {
            const idx = await tx<{ next: number }[]>`SELECT count(*)::int next FROM messages
              WHERE conversation_id=${String(control.conversation_id)}
                AND parent_id=${String(control.user_message_id)}`;
            const nodes = await tx<Row[]>`INSERT INTO messages(
              conversation_id,parent_id,supersedes_id,generation_id,sibling_index,role,content,
              model,status,metadata,idempotency_key
            ) VALUES(
              ${String(control.conversation_id)},${String(control.user_message_id)},
              ${control.source_message_id ? String(control.source_message_id) : null},
              ${String(control.generation_id)},${idx[0].next},'assistant',
              ${
              control.stop_requested_at
                ? "Generation stopped."
                : "Generation interrupted before completion."
            },${String(row.model)},${control.stop_requested_at ? "stopped" : "error"},
              ${
              tx.json({
                runId: String(row.id),
                ...(control.stop_requested_at
                  ? { stopReason: "user" }
                  : { generationError: "Generation lease expired", retryable: true }),
              })
            },${`generation-reaper:${String(control.generation_id)}`}
            ) RETURNING id`;
            await tx`UPDATE conversations SET
              active_leaf_id=CASE WHEN active_leaf_id=${String(control.user_message_id)}
                OR active_leaf_id=${
              control.source_message_id ? String(control.source_message_id) : null
            } THEN ${String(nodes[0].id)} ELSE active_leaf_id END,
              version=version+1,updated_at=now()
              WHERE id=${String(control.conversation_id)}`;
          }
        }
        await tx`UPDATE generation_controls SET terminal_at=now() WHERE run_id=${String(row.id)}`;
      }
      return rows.length;
    });
  }
  async setActiveLeaf(
    conversationId: string,
    ownerId: string,
    leafId: string,
    expectedVersion: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${conversationId} AND owner_id=${ownerId} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Conversation not found", 404);
      if (rows[0].deleted_at) {
        throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
      }
      if (rows[0].archived_at) {
        throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
      }
      if (number(rows[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Conversation changed in another tab", 409);
      }
      const leaves = await tx<
        Row[]
      >`SELECT m.id FROM messages m WHERE m.id=${leafId} AND m.conversation_id=${conversationId} AND NOT EXISTS(SELECT 1 FROM messages child WHERE child.parent_id=m.id)`;
      if (!leaves[0]) {
        throw new DomainError("invalid_leaf", "Active branch must end at a leaf", 422);
      }
      const updated = await tx<
        Row[]
      >`UPDATE conversations SET active_leaf_id=${leafId},version=version+1,updated_at=now() WHERE id=${conversationId} RETURNING *`;
      return conversation(updated[0]);
    });
  }

  async createAttachment(input: CreateAttachmentInput): Promise<CreateAttachmentResult> {
    validateAttachmentInput(input);
    return await this.#sql.begin(async (tx) => {
      const owner = await tx`SELECT id FROM users WHERE id=${input.ownerId} FOR UPDATE`;
      if (!owner.length) throw new DomainError("not_found", "User not found", 404);
      const inserted = await tx<
        Row[]
      >`INSERT INTO attachments(owner_id,object_key,filename,mime_type,size_bytes,sha256,state,inspection_error,ingestion_status) VALUES(${input.ownerId},${input.objectKey},${input.filename},${input.mimeType},${input.sizeBytes},${input.sha256},${
        input.state ?? "pending"
      },${input.inspectionError ?? null},${
        input.state === "ready" && isIngestibleDocumentMime(input.mimeType)
          ? "queued"
          : "not_applicable"
      }) ON CONFLICT DO NOTHING RETURNING *`;
      let record = inserted[0];
      const deduplicated = !record;
      if (!record) {
        const existing = await tx<
          Row[]
        >`SELECT * FROM attachments WHERE owner_id=${input.ownerId} AND sha256=${input.sha256} AND deleted_at IS NULL FOR UPDATE`;
        record = existing[0];
        if (!record) {
          throw new DomainError("object_key_taken", "Attachment object key already exists", 409);
        }
        if (
          number(record.size_bytes) !== input.sizeBytes ||
          String(record.mime_type) !== input.mimeType
        ) {
          throw new DomainError(
            "attachment_hash_conflict",
            "Attachment digest metadata differs",
            409,
          );
        }
      }
      const attachmentId = String(record.id);
      const idempotencyKey = `attachment.inspect:${attachmentId}`;
      const jobs = await tx<
        Row[]
      >`INSERT INTO jobs(type,payload,idempotency_key) VALUES('attachment.inspect',${
        tx.json({ attachmentId, ownerId: input.ownerId })
      },${idempotencyKey}) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`;
      if (String(record.ingestion_status) === "queued") {
        await tx`INSERT INTO jobs(type,payload,idempotency_key) VALUES('attachment.ingest',${
          tx.json({ attachmentId, ownerId: input.ownerId })
        },${`attachment.ingest:${attachmentId}`}) ON CONFLICT(idempotency_key) DO NOTHING`;
      }
      return {
        attachment: attachment(record),
        inspectionJobId: String(jobs[0].id),
        deduplicated,
      };
    });
  }

  async listAttachments(ownerId: string, includeDeleted = false) {
    const rows = includeDeleted
      ? await this.#sql<
        Row[]
      >`SELECT * FROM attachments WHERE owner_id=${ownerId} ORDER BY created_at DESC,id`
      : await this.#sql<
        Row[]
      >`SELECT * FROM attachments WHERE owner_id=${ownerId} AND deleted_at IS NULL ORDER BY created_at DESC,id`;
    return rows.map(attachment);
  }

  async getAttachment(id: string, ownerId: string, includeDeleted = false) {
    const rows = includeDeleted
      ? await this.#sql<Row[]>`SELECT * FROM attachments WHERE id=${id} AND owner_id=${ownerId}`
      : await this.#sql<
        Row[]
      >`SELECT * FROM attachments WHERE id=${id} AND owner_id=${ownerId} AND deleted_at IS NULL`;
    if (!rows[0]) throw new DomainError("not_found", "Attachment not found", 404);
    return attachment(rows[0]);
  }

  async deleteAttachment(id: string, ownerId: string) {
    const rows = await this.#sql<
      Row[]
    >`UPDATE attachments SET state='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=${id} AND owner_id=${ownerId} RETURNING *`;
    if (!rows[0]) throw new DomainError("not_found", "Attachment not found", 404);
    return attachment(rows[0]);
  }

  async transitionAttachment(
    id: string,
    ownerId: string,
    expectedState: AttachmentState,
    nextState: AttachmentState,
    inspectionError: string | null = null,
  ) {
    const allowed: Record<AttachmentState, AttachmentState[]> = {
      pending: ["inspecting", "deleted"],
      inspecting: ["ready", "quarantined", "failed", "deleted"],
      ready: ["deleted"],
      quarantined: ["deleted"],
      failed: ["pending", "deleted"],
      deleted: [],
    };
    if (!allowed[expectedState]?.includes(nextState)) {
      throw new DomainError(
        "invalid_attachment_transition",
        "Attachment transition is invalid",
        422,
      );
    }
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`UPDATE attachments SET state=${nextState},inspection_error=${inspectionError},
        ingestion_status=CASE WHEN ${nextState}='ready' AND mime_type = ANY(${[
        ...INGESTIBLE_DOCUMENT_MIME_TYPES,
      ]}) THEN 'queued' ELSE ingestion_status END,
        ingestion_error=CASE WHEN ${nextState}='ready' THEN NULL ELSE ingestion_error END,
        deleted_at=CASE WHEN ${nextState}='deleted' THEN COALESCE(deleted_at,now()) ELSE deleted_at END,
        updated_at=now() WHERE id=${id} AND owner_id=${ownerId} AND state=${expectedState} RETURNING *`;
      if (rows[0] && nextState === "ready" && isIngestibleDocumentMime(String(rows[0].mime_type))) {
        await tx`INSERT INTO jobs(type,payload,idempotency_key) VALUES('attachment.ingest',${
          tx.json({ attachmentId: id, ownerId })
        },${`attachment.ingest:${id}`}) ON CONFLICT(idempotency_key) DO NOTHING`;
      }
      if (rows[0]) return attachment(rows[0]);
      const exists = await tx`SELECT id FROM attachments WHERE id=${id} AND owner_id=${ownerId}`;
      if (!exists.length) throw new DomainError("not_found", "Attachment not found", 404);
      throw new DomainError("attachment_state_conflict", "Attachment state changed", 409);
    });
  }

  async linkAttachmentToMessage(messageId: string, attachmentId: string, ownerId: string) {
    const authorized = await this
      .#sql`SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN attachments a ON a.id=${attachmentId} AND a.owner_id=${ownerId} AND a.state='ready' AND a.deleted_at IS NULL WHERE m.id=${messageId} AND c.owner_id=${ownerId}`;
    if (!authorized.length) {
      throw new DomainError("attachment_not_ready", "Message or ready attachment not found", 409);
    }
    await this
      .#sql`INSERT INTO message_attachments(message_id,attachment_id) VALUES(${messageId},${attachmentId}) ON CONFLICT DO NOTHING`;
  }

  async listMessageAttachments(messageId: string, ownerId: string) {
    const message = await this
      .#sql`SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=${messageId} AND c.owner_id=${ownerId}`;
    if (!message.length) throw new DomainError("not_found", "Message not found", 404);
    return (await this.#sql<
      Row[]
    >`SELECT a.* FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id WHERE ma.message_id=${messageId} ORDER BY a.created_at,a.id`)
      .map(attachment);
  }

  async beginAttachmentIngestion(id: string, ownerId: string) {
    const rows = await this.#sql<Row[]>`
      UPDATE attachments SET ingestion_status='processing',ingestion_error=NULL,updated_at=now()
      WHERE id=${id} AND owner_id=${ownerId} AND deleted_at IS NULL AND state='ready'
        AND mime_type = ANY(${[...INGESTIBLE_DOCUMENT_MIME_TYPES]})
        AND ingestion_status IN ('queued','processing') RETURNING *`;
    if (rows[0]) return attachment(rows[0]);
    const exists = await this
      .#sql`SELECT id FROM attachments WHERE id=${id} AND owner_id=${ownerId}`;
    if (!exists.length) throw new DomainError("not_found", "Attachment not found", 404);
    throw new DomainError("ingestion_state_conflict", "Attachment ingestion is not queued", 409);
  }

  async completeAttachmentIngestion(
    id: string,
    ownerId: string,
    chunks: DocumentChunkInput[],
  ) {
    const validatedChunks = validateDocumentChunks(chunks, id);
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`
        SELECT * FROM attachments WHERE id=${id} AND owner_id=${ownerId}
          AND deleted_at IS NULL AND ingestion_status='processing' FOR UPDATE`;
      if (!rows[0]) {
        throw new DomainError(
          "ingestion_state_conflict",
          "Attachment ingestion is not processing",
          409,
        );
      }
      await tx`DELETE FROM document_chunks WHERE attachment_id=${id}`;
      for (const chunk of validatedChunks) {
        await tx`INSERT INTO document_chunks(id,attachment_id,ordinal,content,metadata)
          VALUES(${chunk.id},${id},${chunk.ordinal},${chunk.content},${
          tx.json(chunk.metadata as never)
        })`;
      }
      const updated = await tx<Row[]>`
        UPDATE attachments SET ingestion_status='ready',ingestion_error=NULL,ingested_at=now(),updated_at=now()
        WHERE id=${id} RETURNING *`;
      return attachment(updated[0]);
    });
  }

  async failAttachmentIngestion(id: string, ownerId: string, error: string) {
    const rows = await this.#sql<Row[]>`
      UPDATE attachments SET ingestion_status='failed',ingestion_error=${
      error.slice(0, 1000)
    },updated_at=now()
      WHERE id=${id} AND owner_id=${ownerId} AND deleted_at IS NULL
        AND ingestion_status IN ('queued','processing') RETURNING *`;
    if (rows[0]) return attachment(rows[0]);
    const exists = await this
      .#sql`SELECT id FROM attachments WHERE id=${id} AND owner_id=${ownerId}`;
    if (!exists.length) throw new DomainError("not_found", "Attachment not found", 404);
    throw new DomainError("ingestion_state_conflict", "Attachment ingestion is not active", 409);
  }

  async retryAttachmentIngestion(id: string, ownerId: string) {
    return await this.#sql.begin(async (tx) => {
      const records = await tx<Row[]>`SELECT * FROM attachments WHERE id=${id}
        AND owner_id=${ownerId} AND deleted_at IS NULL AND state='ready' FOR UPDATE`;
      if (!records[0]) throw new DomainError("not_found", "Attachment not found", 404);
      const jobs = await tx<Row[]>`SELECT * FROM jobs
        WHERE idempotency_key=${`attachment.ingest:${id}`} FOR UPDATE`;
      const legacySplit = String(records[0].ingestion_status) === "queued" &&
        String(jobs[0]?.status) === "failed";
      if (String(records[0].ingestion_status) !== "failed" && !legacySplit) {
        throw new DomainError(
          "ingestion_state_conflict",
          "Only failed ingestion can be retried",
          409,
        );
      }
      const rows = await tx<Row[]>`UPDATE attachments SET ingestion_status='queued',
        ingestion_error=NULL,ingested_at=NULL,updated_at=now() WHERE id=${id} RETURNING *`;
      await tx`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
        VALUES('attachment.ingest',${
        tx.json({ attachmentId: id, ownerId })
      },${`attachment.ingest:${id}`},'queued',0,now())
        ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',attempts=0,available_at=now(),
          last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL`;
      return attachment(rows[0]);
    });
  }

  async listDocumentChunks(id: string, ownerId: string) {
    const exists = await this.#sql`
      SELECT id FROM attachments WHERE id=${id} AND owner_id=${ownerId} AND deleted_at IS NULL`;
    if (!exists.length) throw new DomainError("not_found", "Attachment not found", 404);
    return (await this.#sql<Row[]>`
      SELECT dc.* FROM document_chunks dc WHERE dc.attachment_id=${id} ORDER BY dc.ordinal`)
      .map(documentChunk);
  }

  async upsertDocumentChunkEmbeddings(values: DocumentChunkEmbeddingInput[]) {
    let validated: DocumentChunkEmbeddingInput[];
    try {
      validated = validateChunkEmbeddings(values);
    } catch {
      throw new DomainError("validation_error", "Document chunk embeddings are invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      for (const value of validated) {
        const owned = await tx`SELECT 1 FROM document_chunks dc
          JOIN attachments a ON a.id=dc.attachment_id
          WHERE dc.id=${value.chunkId} AND a.owner_id=${value.ownerId}
            AND a.deleted_at IS NULL FOR UPDATE OF dc`;
        if (!owned.length) throw new DomainError("not_found", "Document chunk not found", 404);
        await tx`INSERT INTO document_chunk_embeddings(
          chunk_id,owner_id,model,embedding_version,content_sha256,embedding
        ) VALUES(
          ${value.chunkId},${value.ownerId},${value.model},${value.version},
          ${value.contentSha256},${JSON.stringify(value.embedding)}::vector
        ) ON CONFLICT(chunk_id,embedding_version) DO UPDATE SET
          owner_id=EXCLUDED.owner_id,model=EXCLUDED.model,
          content_sha256=EXCLUDED.content_sha256,embedding=EXCLUDED.embedding,updated_at=now()`;
      }
      return validated.length;
    });
  }

  async startEmbeddingProviderAttempt(input: EmbeddingProviderAttemptInput): Promise<void> {
    if (
      !["document", "query"].includes(input.purpose) ||
      !Number.isSafeInteger(input.itemCount) || input.itemCount < 1 || input.itemCount > 256
    ) throw new DomainError("validation_error", "Embedding attempt is invalid", 422);
    try {
      await this.#sql`INSERT INTO embedding_provider_attempts(
        usage_run_id,parent_usage_run_id,purpose,provider,model,upstream_model,item_count)
        VALUES(${input.usageRunId},${input.parentUsageRunId ?? null},${input.purpose},
          ${input.provider},${input.model},${input.upstreamModel},${input.itemCount})`;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("idempotency_conflict", "Embedding attempt already exists", 409);
      }
      throw error;
    }
  }

  async finishEmbeddingProviderAttempt(input: FinishEmbeddingProviderAttemptInput): Promise<void> {
    if (
      !["succeeded", "failed", "cancelled"].includes(input.status) ||
      !Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0 ||
      !Number.isSafeInteger(input.costMicros) || input.costMicros < 0 ||
      !Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0
    ) throw new DomainError("validation_error", "Embedding attempt result is invalid", 422);
    const rows = await this.#sql`UPDATE embedding_provider_attempts SET status=${input.status},
      input_tokens=${input.inputTokens},cost_micros=${input.costMicros},
      token_source=${input.tokenSource},cost_source=${input.costSource},
      latency_ms=${input.latencyMs},error=${input.error?.slice(0, 1000) ?? null},completed_at=now()
      WHERE usage_run_id=${input.usageRunId} AND status='running' RETURNING id`;
    if (!rows.length) {
      const terminal = await this.#sql`SELECT 1 FROM embedding_provider_attempts
        WHERE usage_run_id=${input.usageRunId} AND status=${input.status}
          AND input_tokens=${input.inputTokens} AND cost_micros=${input.costMicros}`;
      if (terminal.length) return;
      throw new DomainError("invalid_usage_state", "Embedding attempt is not running", 409);
    }
  }

  async searchConversationKnowledge(
    input: SearchConversationKnowledgeInput,
  ): Promise<KnowledgeSearchHit[]> {
    let limit: number;
    try {
      limit = normalizeKnowledgeSearchLimit(input.limit);
    } catch {
      throw new DomainError("validation_error", "Knowledge search input is invalid", 422);
    }
    const query = input.query.trim().slice(0, 8_000);
    const vector = input.queryEmbedding;
    if (
      (vector !== undefined &&
        (vector.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
          vector.some((part) => typeof part !== "number" || !Number.isFinite(part)))) ||
      (vector !== undefined && !input.embeddingVersion)
    ) throw new DomainError("validation_error", "Knowledge search input is invalid", 422);

    const vectorLiteral = vector ? JSON.stringify(vector) : null;
    const candidateLimit = Math.max(64, limit * 8);
    const rows = await this.#sql<Row[]>`
      WITH scoped AS MATERIALIZED (
        SELECT dc.id,dc.attachment_id,dc.ordinal,dc.content,dc.metadata,
          k.id AS collection_id,k.name AS collection_name,a.filename,b.owner_id
        FROM conversation_knowledge_bindings b
        JOIN conversations c ON c.id=b.conversation_id AND c.owner_id=b.owner_id
          AND c.deleted_at IS NULL
        JOIN knowledge_collections k ON k.id=b.collection_id AND k.owner_id=b.owner_id
          AND k.deleted_at IS NULL
        JOIN knowledge_collection_attachments ka ON ka.collection_id=k.id
        JOIN attachments a ON a.id=ka.attachment_id AND a.owner_id=b.owner_id
          AND a.deleted_at IS NULL AND a.state='ready' AND a.ingestion_status='ready'
        JOIN document_chunks dc ON dc.attachment_id=a.id
        WHERE b.conversation_id=${input.conversationId} AND b.owner_id=${input.ownerId}
          AND b.mode='retrieval'
      ), lexical_candidates AS (
        SELECT collection_id,id FROM scoped
        WHERE ${query}='' OR to_tsvector('simple',content) @@ plainto_tsquery('simple',${query})
        ORDER BY CASE WHEN ${query}='' THEN 1::double precision ELSE ts_rank_cd(
          to_tsvector('simple',content),plainto_tsquery('simple',${query}),32
        )::double precision END DESC,collection_id,id
        LIMIT ${candidateLimit}
      ), vector_nearest AS MATERIALIZED (
        SELECT dce.chunk_id
        FROM document_chunk_embeddings dce
        WHERE ${vectorLiteral}::text IS NOT NULL AND dce.owner_id=${input.ownerId}
          AND dce.embedding_version=${input.embeddingVersion ?? ""}
        ORDER BY dce.embedding <=> ${vectorLiteral}::vector
        LIMIT ${candidateLimit}
      ), vector_candidates AS (
        SELECT s.collection_id,s.id FROM vector_nearest vn
        JOIN scoped s ON s.id=vn.chunk_id
      ), candidate_ids AS (
        SELECT collection_id,id FROM lexical_candidates
        UNION SELECT collection_id,id FROM vector_candidates
      ), candidates AS (
        SELECT s.*,
          CASE WHEN ${query}='' THEN 1::double precision ELSE ts_rank_cd(
            to_tsvector('simple',s.content),plainto_tsquery('simple',${query}),32
          )::double precision END AS lexical_score,
          CASE WHEN ${vectorLiteral}::text IS NULL THEN NULL ELSE
            (1-(dce.embedding <=> ${vectorLiteral}::vector))::double precision END AS vector_score
        FROM candidate_ids ci JOIN scoped s USING(collection_id,id)
        LEFT JOIN document_chunk_embeddings dce ON dce.chunk_id=s.id
          AND dce.owner_id=s.owner_id AND dce.embedding_version=${input.embeddingVersion ?? ""}
      )
      SELECT *, lexical_score * 0.45 +
        CASE WHEN vector_score IS NULL THEN 0 ELSE GREATEST(0,vector_score) * 0.55 END AS score
      FROM candidates
      WHERE lexical_score > 0 OR vector_score IS NOT NULL
      ORDER BY score DESC,collection_id,attachment_id,ordinal,id
      LIMIT ${limit}`;
    return rows.map((row) => ({
      ...documentChunk(row),
      collectionId: String(row.collection_id),
      collectionName: String(row.collection_name),
      filename: String(row.filename),
      lexicalScore: number(row.lexical_score),
      vectorScore: row.vector_score == null ? null : number(row.vector_score),
      score: number(row.score),
    }));
  }

  async createKnowledgeCollection(ownerId: string, input: CreateKnowledgeCollectionInput) {
    const name = input.name.trim();
    if (
      !name || name.length > 120 || (input.description?.length ?? 0) > 2000 ||
      !/^[A-Za-z0-9._:-]{1,160}$/.test(input.idempotencyKey)
    ) {
      throw new DomainError("validation_error", "Knowledge collection input is invalid", 422);
    }
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO knowledge_collections(owner_id,name,description,idempotency_key)
      VALUES(${ownerId},${name},${input.description?.trim() ?? ""},${input.idempotencyKey})
      ON CONFLICT(owner_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`;
    const record = knowledgeCollection(rows[0]);
    if (record.deletedAt) {
      throw new DomainError("idempotency_conflict", "Idempotency key was already used", 409);
    }
    if (record.name !== name || record.description !== (input.description?.trim() ?? "")) {
      throw new DomainError("idempotency_conflict", "Idempotency key payload differs", 409);
    }
    return record;
  }
  async listKnowledgeCollections(ownerId: string) {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM knowledge_collections WHERE owner_id=${ownerId} AND deleted_at IS NULL ORDER BY updated_at DESC,id`)
      .map(knowledgeCollection);
  }
  async getKnowledgeCollection(id: string, ownerId: string) {
    const rows = await this.#sql<
      Row[]
    >`SELECT * FROM knowledge_collections WHERE id=${id} AND owner_id=${ownerId} AND deleted_at IS NULL`;
    if (!rows[0]) throw new DomainError("not_found", "Knowledge collection not found", 404);
    return knowledgeCollection(rows[0]);
  }
  async updateKnowledgeCollection(id: string, ownerId: string, patch: KnowledgeCollectionPatch) {
    const name = patch.name?.trim();
    if ((name != null && (!name || name.length > 120)) || (patch.description?.length ?? 0) > 2000) {
      throw new DomainError("validation_error", "Knowledge collection input is invalid", 422);
    }
    const rows = await this.#sql<Row[]>`UPDATE knowledge_collections SET name=COALESCE(${
      name ?? null
    },name),description=COALESCE(${
      patch.description?.trim() ?? null
    },description),version=version+1,updated_at=now()
      WHERE id=${id} AND owner_id=${ownerId} AND deleted_at IS NULL AND version=${patch.expectedVersion} RETURNING *`;
    if (!rows[0]) {
      await this.getKnowledgeCollection(id, ownerId);
      throw new DomainError("version_conflict", "Knowledge collection changed", 409);
    }
    return knowledgeCollection(rows[0]);
  }
  async deleteKnowledgeCollection(id: string, ownerId: string, expectedVersion: number) {
    const rows = await this.#sql<
      Row[]
    >`UPDATE knowledge_collections SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=${id} AND owner_id=${ownerId} AND deleted_at IS NULL AND version=${expectedVersion} RETURNING *`;
    if (!rows[0]) {
      await this.getKnowledgeCollection(id, ownerId);
      throw new DomainError("version_conflict", "Knowledge collection changed", 409);
    }
    return knowledgeCollection(rows[0]);
  }
  async linkKnowledgeAttachment(
    collectionId: string,
    attachmentId: string,
    ownerId: string,
    expectedVersion: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      const collections = await tx<
        Row[]
      >`SELECT * FROM knowledge_collections WHERE id=${collectionId} AND owner_id=${ownerId} AND deleted_at IS NULL FOR UPDATE`;
      if (!collections[0]) {
        throw new DomainError("not_found", "Knowledge collection not found", 404);
      }
      const attachments = await tx<
        Row[]
      >`SELECT id FROM attachments WHERE id=${attachmentId} AND owner_id=${ownerId} AND state='ready' AND deleted_at IS NULL`;
      if (!attachments[0]) throw new DomainError("not_found", "Ready attachment not found", 404);
      const prior =
        await tx`SELECT 1 FROM knowledge_collection_attachments WHERE collection_id=${collectionId} AND attachment_id=${attachmentId}`;
      if (prior.length) return knowledgeCollection(collections[0]);
      if (number(collections[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Knowledge collection changed", 409);
      }
      const inserted =
        await tx`INSERT INTO knowledge_collection_attachments(collection_id,attachment_id) VALUES(${collectionId},${attachmentId}) ON CONFLICT DO NOTHING RETURNING collection_id`;
      if (!inserted.length) return knowledgeCollection(collections[0]);
      return knowledgeCollection(
        (await tx<
          Row[]
        >`UPDATE knowledge_collections SET version=version+1,updated_at=now() WHERE id=${collectionId} RETURNING *`)[
          0
        ],
      );
    });
  }
  async unlinkKnowledgeAttachment(
    collectionId: string,
    attachmentId: string,
    ownerId: string,
    expectedVersion: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT * FROM knowledge_collections WHERE id=${collectionId} AND owner_id=${ownerId} AND deleted_at IS NULL FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Knowledge collection not found", 404);
      const attachments =
        await tx`SELECT 1 FROM attachments WHERE id=${attachmentId} AND owner_id=${ownerId} AND deleted_at IS NULL`;
      if (!attachments.length) throw new DomainError("not_found", "Attachment not found", 404);
      const prior =
        await tx`SELECT 1 FROM knowledge_collection_attachments WHERE collection_id=${collectionId} AND attachment_id=${attachmentId}`;
      if (!prior.length) return knowledgeCollection(rows[0]);
      if (number(rows[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Knowledge collection changed", 409);
      }
      const deleted =
        await tx`DELETE FROM knowledge_collection_attachments WHERE collection_id=${collectionId} AND attachment_id=${attachmentId} RETURNING collection_id`;
      if (!deleted.length) return knowledgeCollection(rows[0]);
      return knowledgeCollection(
        (await tx<
          Row[]
        >`UPDATE knowledge_collections SET version=version+1,updated_at=now() WHERE id=${collectionId} RETURNING *`)[
          0
        ],
      );
    });
  }
  async listKnowledgeAttachments(collectionId: string, ownerId: string) {
    await this.getKnowledgeCollection(collectionId, ownerId);
    return (await this.#sql<
      Row[]
    >`SELECT a.* FROM attachments a
      JOIN knowledge_collection_attachments ka ON ka.attachment_id=a.id
      JOIN knowledge_collections k ON k.id=ka.collection_id AND k.owner_id=a.owner_id AND k.deleted_at IS NULL
      WHERE ka.collection_id=${collectionId} AND a.owner_id=${ownerId} AND a.state='ready' AND a.deleted_at IS NULL
      ORDER BY ka.created_at,a.id`)
      .map(attachment);
  }
  async bindKnowledgeCollection(
    conversationId: string,
    collectionId: string,
    ownerId: string,
    mode: KnowledgeRetrievalMode,
    expectedVersion?: number,
  ) {
    if (!["retrieval", "full_context"].includes(mode)) {
      throw new DomainError("validation_error", "Invalid retrieval mode", 422);
    }
    return await this.#sql.begin(async (tx) => {
      // Serialize first creation as well as updates. A row lock cannot protect the
      // initially-absent composite key, while this transaction lock can.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${conversationId}:${collectionId}`},0))`;
      const parents = await tx`SELECT 1 FROM conversations c, knowledge_collections k
        WHERE c.id=${conversationId} AND c.owner_id=${ownerId} AND c.deleted_at IS NULL
          AND k.id=${collectionId} AND k.owner_id=${ownerId} AND k.deleted_at IS NULL`;
      if (!parents.length) {
        throw new DomainError("not_found", "Conversation or knowledge collection not found", 404);
      }
      const prior = await tx<
        Row[]
      >`SELECT * FROM conversation_knowledge_bindings WHERE conversation_id=${conversationId} AND collection_id=${collectionId} FOR UPDATE`;
      if (prior[0]) {
        if (String(prior[0].owner_id) !== ownerId) {
          throw new DomainError("not_found", "Knowledge binding not found", 404);
        }
        if (prior[0].mode === mode) return knowledgeBinding(prior[0]);
        if (number(prior[0].version) !== expectedVersion) {
          throw new DomainError("version_conflict", "Knowledge binding changed", 409);
        }
        return knowledgeBinding(
          (await tx<
            Row[]
          >`UPDATE conversation_knowledge_bindings SET mode=${mode},version=version+1,updated_at=now() WHERE conversation_id=${conversationId} AND collection_id=${collectionId} RETURNING *`)[
            0
          ],
        );
      }
      if (expectedVersion != null && expectedVersion !== 0) {
        throw new DomainError("version_conflict", "Knowledge binding changed", 409);
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO conversation_knowledge_bindings(conversation_id,collection_id,owner_id,mode) VALUES(${conversationId},${collectionId},${ownerId},${mode}) RETURNING *`;
      return knowledgeBinding(rows[0]);
    });
  }
  async unbindKnowledgeCollection(
    conversationId: string,
    collectionId: string,
    ownerId: string,
    expectedVersion: number,
  ) {
    await this.#sql.begin(async (tx) => {
      const live = await tx`SELECT 1 FROM conversation_knowledge_bindings b
        JOIN conversations c ON c.id=b.conversation_id AND c.owner_id=b.owner_id AND c.deleted_at IS NULL
        JOIN knowledge_collections k ON k.id=b.collection_id AND k.owner_id=b.owner_id AND k.deleted_at IS NULL
        WHERE b.conversation_id=${conversationId} AND b.collection_id=${collectionId} AND b.owner_id=${ownerId} FOR UPDATE OF b`;
      if (!live.length) throw new DomainError("not_found", "Knowledge binding not found", 404);
      const rows =
        await tx`DELETE FROM conversation_knowledge_bindings WHERE conversation_id=${conversationId} AND collection_id=${collectionId} AND owner_id=${ownerId} AND version=${expectedVersion} RETURNING conversation_id`;
      if (!rows.length) throw new DomainError("version_conflict", "Knowledge binding changed", 409);
    });
  }
  async listConversationKnowledge(conversationId: string, ownerId: string) {
    const conversations = await this
      .#sql`SELECT 1 FROM conversations WHERE id=${conversationId} AND owner_id=${ownerId} AND deleted_at IS NULL`;
    if (!conversations.length) throw new DomainError("not_found", "Conversation not found", 404);
    return (await this.#sql<
      Row[]
    >`SELECT b.* FROM conversation_knowledge_bindings b
      JOIN conversations c ON c.id=b.conversation_id AND c.owner_id=b.owner_id AND c.deleted_at IS NULL
      JOIN knowledge_collections k ON k.id=b.collection_id AND k.owner_id=b.owner_id AND k.deleted_at IS NULL
      WHERE b.conversation_id=${conversationId} AND b.owner_id=${ownerId} ORDER BY b.created_at,b.collection_id`)
      .map(knowledgeBinding);
  }

  async replaceConversationKnowledge(
    conversationId: string,
    ownerId: string,
    input: ReplaceConversationKnowledgeInput,
  ) {
    if (
      !["retrieval", "full_context"].includes(input.mode) ||
      new Set(input.collectionIds).size !== input.collectionIds.length
    ) throw new DomainError("validation_error", "Knowledge replacement is invalid", 422);
    return await this.#sql.begin(async (tx) => {
      // The conversation lock serializes every replacement for this conversation,
      // including empty-set replacements where there is no binding row to lock.
      const conversations = await tx`SELECT 1 FROM conversations
        WHERE id=${conversationId} AND owner_id=${ownerId} AND deleted_at IS NULL FOR UPDATE`;
      if (!conversations.length) throw new DomainError("not_found", "Conversation not found", 404);
      for (const collectionId of input.collectionIds) {
        const collection = await tx`SELECT 1 FROM knowledge_collections
          WHERE id=${collectionId} AND owner_id=${ownerId} AND deleted_at IS NULL FOR SHARE`;
        if (!collection.length) {
          throw new DomainError("not_found", "Knowledge collection not found", 404);
        }
      }
      if (input.collectionIds.length === 0) {
        await tx`DELETE FROM conversation_knowledge_bindings
          WHERE conversation_id=${conversationId} AND owner_id=${ownerId}`;
        return [];
      }
      await tx`DELETE FROM conversation_knowledge_bindings
        WHERE conversation_id=${conversationId} AND owner_id=${ownerId}
          AND NOT (collection_id = ANY(${tx.array(input.collectionIds)}::uuid[]))`;
      const result: KnowledgeConversationBinding[] = [];
      for (const collectionId of input.collectionIds) {
        const rows = await tx<Row[]>`INSERT INTO conversation_knowledge_bindings(
            conversation_id,collection_id,owner_id,mode)
          VALUES(${conversationId},${collectionId},${ownerId},${input.mode})
          ON CONFLICT(conversation_id,collection_id) DO UPDATE SET
            mode=EXCLUDED.mode,
            version=conversation_knowledge_bindings.version +
              CASE WHEN conversation_knowledge_bindings.mode IS DISTINCT FROM EXCLUDED.mode THEN 1 ELSE 0 END,
            updated_at=CASE WHEN conversation_knowledge_bindings.mode IS DISTINCT FROM EXCLUDED.mode
              THEN now() ELSE conversation_knowledge_bindings.updated_at END
          RETURNING *`;
        result.push(knowledgeBinding(rows[0]));
      }
      return result;
    });
  }

  async createProvider(input: CreateProviderInput, mutation: RegistryMutationContext) {
    validateRegistryMutation(mutation);
    validateProviderInput(input);
    try {
      return await this.#sql.begin(async (tx) => {
        const rows = await tx<Row[]>`
          INSERT INTO providers(slug,display_name,base_url,protocol,enabled,health_status)
          VALUES(${input.slug},${input.displayName.trim()},${
          normalizeProviderBaseUrl(input.baseUrl)
        },
            ${input.protocol},${input.enabled ?? true},${
          input.enabled === false ? "disabled" : "unknown"
        })
          RETURNING *`;
        const value = provider(rows[0]);
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${mutation.actorId ?? null},${mutation.action},'provider',${value.id},${
          tx.json({ ...mutation.metadata, version: value.version })
        })`;
        return value;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("provider_slug_taken", "Provider slug already exists", 409);
      }
      throw error;
    }
  }

  async updateProvider(
    id: string,
    expectedVersion: number,
    input: UpdateProviderInput,
    mutation: RegistryMutationContext,
  ) {
    validateRegistryMutation(mutation);
    validateProviderInput(input);
    try {
      return await this.#sql.begin(async (tx) => {
        const currentRows = await tx<Row[]>`SELECT * FROM providers WHERE id=${id} FOR UPDATE`;
        if (!currentRows[0]) throw new DomainError("not_found", "Provider not found", 404);
        const current = provider(currentRows[0]);
        if (current.version !== expectedVersion) throw registryConflict();
        const enabled = input.enabled ?? current.enabled;
        let healthStatus = input.healthStatus ?? current.healthStatus;
        if (!enabled) healthStatus = "disabled";
        else if (input.enabled === true && healthStatus === "disabled") healthStatus = "unknown";
        const rows = await tx<Row[]>`
          UPDATE providers SET
            slug=${input.slug ?? current.slug},
            display_name=${input.displayName?.trim() ?? current.displayName},
            base_url=${
          input.baseUrl === undefined ? current.baseUrl : normalizeProviderBaseUrl(input.baseUrl)
        },
            protocol=${input.protocol ?? current.protocol},
            enabled=${enabled},
            health_status=${healthStatus},
            health_checked_at=${
          input.healthCheckedAt === undefined ? current.healthCheckedAt : input.healthCheckedAt
        },
            health_latency_ms=${
          input.healthLatencyMs === undefined ? current.healthLatencyMs : input.healthLatencyMs
        },
            health_error=${
          input.healthError === undefined ? current.healthError : input.healthError
        },
            version=version+1,updated_at=now()
          WHERE id=${id} RETURNING *`;
        const value = provider(rows[0]);
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${mutation.actorId ?? null},${mutation.action},'provider',${value.id},${
          tx.json({ ...mutation.metadata, version: value.version })
        })`;
        return value;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("provider_slug_taken", "Provider slug already exists", 409);
      }
      throw error;
    }
  }

  async listProviders(enabledOnly = false) {
    const rows = enabledOnly
      ? await this.#sql<Row[]>`SELECT * FROM providers WHERE enabled ORDER BY display_name,id`
      : await this.#sql<Row[]>`SELECT * FROM providers ORDER BY display_name,id`;
    return rows.map(provider);
  }

  async findProvider(idOrSlug: string) {
    const rows = await this.#sql<Row[]>`
      SELECT * FROM providers WHERE id::text=${idOrSlug} OR slug=${idOrSlug} LIMIT 1`;
    return rows[0] ? provider(rows[0]) : undefined;
  }

  async setProviderCredential(
    id: string,
    expectedVersion: number,
    credential: ProviderCredentialMutation | null,
    mutation: RegistryMutationContext,
  ) {
    validateRegistryMutation(mutation);
    if (credential) validateCredentialEnvelope(credential.envelope);
    return await this.#sql.begin(async (tx) => {
      const current = await tx<Row[]>`SELECT version FROM providers WHERE id=${id} FOR UPDATE`;
      if (!current[0]) throw new DomainError("not_found", "Provider not found", 404);
      if (number(current[0].version) !== expectedVersion) throw registryConflict();
      const rows = await tx<Row[]>`
        UPDATE providers SET credential_envelope=${
        credential ? tx.json(credential.envelope as never) : null
      },credential_updated_at=${credential ? new Date().toISOString() : null},
          health_status=CASE WHEN enabled THEN 'unknown' ELSE 'disabled' END,
          health_checked_at=NULL,health_latency_ms=NULL,health_error=NULL,
          version=version+1,updated_at=now()
        WHERE id=${id} RETURNING *`;
      const value = provider(rows[0]);
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${mutation.actorId ?? null},${mutation.action},'provider',${value.id},${
        tx.json({
          ...mutation.metadata,
          version: value.version,
          credentialChanged: true,
          hasCredential: value.hasCredential,
        })
      })`;
      return value;
    });
  }

  async getProviderCredential(id: string): Promise<StoredProviderCredential | undefined> {
    const rows = await this.#sql<Row[]>`
      SELECT id,credential_envelope FROM providers WHERE id=${id}`;
    if (!rows[0]?.credential_envelope) return undefined;
    return {
      providerId: String(rows[0].id),
      envelope: structuredClone(rows[0].credential_envelope as ProviderCredentialEnvelope),
    };
  }

  async createProviderModel(input: CreateProviderModelInput, mutation: RegistryMutationContext) {
    validateRegistryMutation(mutation);
    validateProviderModelInput(input);
    try {
      return await this.#sql.begin(async (tx) => {
        const providerRows = await tx`SELECT id FROM providers WHERE id=${input.providerId}`;
        if (!providerRows.length) throw new DomainError("not_found", "Provider not found", 404);
        const rows = await tx<Row[]>`
          INSERT INTO provider_models(provider_id,public_model_id,upstream_model_id,display_name,
            capabilities,context_window,enabled,custom_params)
          VALUES(${input.providerId},${input.publicModelId},${input.upstreamModelId.trim()},
            ${input.displayName.trim()},${tx.json(input.capabilities)},${input.contextWindow},
            ${input.enabled ?? true},${tx.json((input.customParams ?? {}) as never)}) RETURNING *`;
        const value = providerModel(rows[0]);
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${mutation.actorId ?? null},${mutation.action},'provider_model',${value.id},${
          tx.json({ ...mutation.metadata, providerId: value.providerId, version: value.version })
        })`;
        return value;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("model_id_taken", "Public model ID already exists", 409);
      }
      throw error;
    }
  }

  async updateProviderModel(
    id: string,
    expectedVersion: number,
    input: UpdateProviderModelInput,
    mutation: RegistryMutationContext,
  ) {
    validateRegistryMutation(mutation);
    validateProviderModelInput(input);
    try {
      return await this.#sql.begin(async (tx) => {
        const currentRows = await tx<
          Row[]
        >`SELECT * FROM provider_models WHERE id=${id} FOR UPDATE`;
        if (!currentRows[0]) throw new DomainError("not_found", "Provider model not found", 404);
        const current = providerModel(currentRows[0]);
        if (current.version !== expectedVersion) throw registryConflict();
        const rows = await tx<Row[]>`
          UPDATE provider_models SET public_model_id=${
          input.publicModelId ?? current.publicModelId
        },
            upstream_model_id=${input.upstreamModelId?.trim() ?? current.upstreamModelId},
            display_name=${input.displayName?.trim() ?? current.displayName},
            capabilities=${tx.json(input.capabilities ?? current.capabilities)},
            context_window=${input.contextWindow ?? current.contextWindow},
            enabled=${input.enabled ?? current.enabled},
            custom_params=${tx.json((input.customParams ?? current.customParams) as never)},
            version=version+1,updated_at=now() WHERE id=${id} RETURNING *`;
        const value = providerModel(rows[0]);
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${mutation.actorId ?? null},${mutation.action},'provider_model',${value.id},${
          tx.json({ ...mutation.metadata, providerId: value.providerId, version: value.version })
        })`;
        return value;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("model_id_taken", "Public model ID already exists", 409);
      }
      throw error;
    }
  }

  async listProviderModels(providerId?: string, enabledOnly = false) {
    const rows = providerId && enabledOnly
      ? await this.#sql<Row[]>`SELECT * FROM provider_models WHERE provider_id=${providerId}
          AND enabled ORDER BY display_name,id`
      : providerId
      ? await this.#sql<Row[]>`SELECT * FROM provider_models WHERE provider_id=${providerId}
          ORDER BY display_name,id`
      : enabledOnly
      ? await this.#sql<Row[]>`SELECT * FROM provider_models WHERE enabled ORDER BY display_name,id`
      : await this.#sql<Row[]>`SELECT * FROM provider_models ORDER BY display_name,id`;
    return rows.map(providerModel);
  }

  async findProviderModel(idOrPublicModelId: string) {
    const rows = await this.#sql<Row[]>`
      SELECT * FROM provider_models WHERE id::text=${idOrPublicModelId}
        OR public_model_id=${idOrPublicModelId} LIMIT 1`;
    return rows[0] ? providerModel(rows[0]) : undefined;
  }

  async createModelPriceVersion(
    input: CreateModelPriceVersionInput,
    mutation: RegistryMutationContext,
  ) {
    validateRegistryMutation(mutation);
    validatePriceInput(input);
    try {
      return await this.#sql.begin(async (tx) => {
        const models = await tx<Row[]>`
          SELECT version FROM provider_models WHERE id=${input.providerModelId} FOR UPDATE`;
        if (!models[0]) throw new DomainError("not_found", "Provider model not found", 404);
        if (number(models[0].version) !== input.expectedModelVersion) throw registryConflict();
        const rows = await tx<Row[]>`
          INSERT INTO model_price_versions(provider_model_id,effective_at,input_micros_per_million,
            cached_input_micros_per_million,reasoning_micros_per_million,
            output_micros_per_million,fixed_call_micros,source)
          VALUES(${input.providerModelId},${input.effectiveAt},${input.inputMicrosPerMillion},
            ${input.cachedInputMicrosPerMillion},${input.reasoningMicrosPerMillion},
            ${input.outputMicrosPerMillion},${input.fixedCallMicros},${input.source.trim()})
          RETURNING *`;
        const value = modelPrice(rows[0]);
        const modelRows = await tx<Row[]>`
          UPDATE provider_models SET version=version+1,updated_at=now()
          WHERE id=${input.providerModelId} RETURNING version`;
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${mutation.actorId ?? null},${mutation.action},'model_price_version',${value.id},${
          tx.json({
            ...mutation.metadata,
            providerModelId: value.providerModelId,
            effectiveAt: value.effectiveAt,
            modelVersion: number(modelRows[0].version),
          })
        })`;
        return value;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError(
          "price_effective_at_taken",
          "A price already starts at that time",
          409,
        );
      }
      throw error;
    }
  }

  async listModelPriceVersions(providerModelId: string) {
    const exists = await this.#sql`SELECT id FROM provider_models WHERE id=${providerModelId}`;
    if (!exists.length) throw new DomainError("not_found", "Provider model not found", 404);
    return (await this.#sql<Row[]>`
      SELECT * FROM model_price_versions WHERE provider_model_id=${providerModelId}
      ORDER BY effective_at DESC,id DESC`).map(modelPrice);
  }

  async effectiveModelPrice(providerModelId: string, at = new Date().toISOString()) {
    if (!Number.isFinite(Date.parse(at))) {
      throw new DomainError("validation_error", "Price lookup timestamp is invalid", 422);
    }
    const exists = await this.#sql`SELECT id FROM provider_models WHERE id=${providerModelId}`;
    if (!exists.length) throw new DomainError("not_found", "Provider model not found", 404);
    const rows = await this.#sql<Row[]>`
      SELECT * FROM model_price_versions WHERE provider_model_id=${providerModelId}
        AND effective_at <= ${at} ORDER BY effective_at DESC,id DESC LIMIT 1`;
    return rows[0] ? modelPrice(rows[0]) : undefined;
  }

  async createProviderRetryPolicy(
    input: CreateProviderRetryPolicyInput,
    mutation: RegistryMutationContext,
  ) {
    validateRegistryMutation(mutation);
    validateRetryPolicy(input);
    try {
      return await this.#sql.begin(async (tx) => {
        const rows = await tx<
          Row[]
        >`INSERT INTO provider_retry_policies(name,enabled,max_attempts,max_retries,
          base_delay_ms,max_delay_ms,backoff_multiplier_bps,jitter_bps,first_token_timeout_ms,
          idle_timeout_ms,total_timeout_ms,retryable_statuses)
          VALUES(${input.name.trim()},${
          input.enabled ?? true
        },${input.maxAttempts},${input.maxRetries},${input.baseDelayMs},
          ${input.maxDelayMs},${input.backoffMultiplierBps},${input.jitterBps},${input.firstTokenTimeoutMs},
          ${input.idleTimeoutMs},${input.totalTimeoutMs},${
          tx.json([...input.retryableStatuses].sort((a, b) => a - b))
        }) RETURNING *`;
        const value = retryPolicy(rows[0]);
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${
          mutation.actorId ?? null
        },${mutation.action},'provider_retry_policy',${value.id},${
          tx.json({ ...mutation.metadata, version: value.version })
        })`;
        return value;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("retry_policy_name_taken", "Retry policy name already exists", 409);
      }
      throw error;
    }
  }

  async updateProviderRetryPolicy(
    id: string,
    expectedVersion: number,
    input: UpdateProviderRetryPolicyInput,
    mutation: RegistryMutationContext,
  ) {
    validateRegistryMutation(mutation);
    try {
      return await this.#sql.begin(async (tx) => {
        const rows = await tx<
          Row[]
        >`SELECT * FROM provider_retry_policies WHERE id=${id} FOR UPDATE`;
        if (!rows[0]) throw new DomainError("not_found", "Retry policy not found", 404);
        const current = retryPolicy(rows[0]);
        if (current.version !== expectedVersion) throw registryConflict();
        const next = { ...current, ...input, name: input.name?.trim() ?? current.name };
        validateRetryPolicy(next);
        const updated = await tx<
          Row[]
        >`UPDATE provider_retry_policies SET name=${next.name},enabled=${next.enabled},
          max_attempts=${next.maxAttempts},max_retries=${next.maxRetries},base_delay_ms=${next.baseDelayMs},max_delay_ms=${next.maxDelayMs},
          backoff_multiplier_bps=${next.backoffMultiplierBps},jitter_bps=${next.jitterBps},
          first_token_timeout_ms=${next.firstTokenTimeoutMs},idle_timeout_ms=${next.idleTimeoutMs},
          total_timeout_ms=${next.totalTimeoutMs},retryable_statuses=${
          tx.json([...next.retryableStatuses].sort((a, b) => a - b))
        },
          version=version+1,updated_at=now() WHERE id=${id} RETURNING *`;
        const value = retryPolicy(updated[0]);
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${
          mutation.actorId ?? null
        },${mutation.action},'provider_retry_policy',${value.id},${
          tx.json({ ...mutation.metadata, version: value.version })
        })`;
        return value;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("retry_policy_name_taken", "Retry policy name already exists", 409);
      }
      throw error;
    }
  }

  async listProviderRetryPolicies(enabledOnly = false) {
    const rows = enabledOnly
      ? await this.#sql<Row[]>`SELECT * FROM provider_retry_policies WHERE enabled ORDER BY name,id`
      : await this.#sql<Row[]>`SELECT * FROM provider_retry_policies ORDER BY name,id`;
    return rows.map(retryPolicy);
  }

  async setProviderModelRoute(
    input: SetProviderModelRouteInput,
    mutation: RegistryMutationContext,
  ): Promise<ProviderModelRoute> {
    validateRegistryMutation(mutation);
    if (
      input.fallbackModelIds.length > 8 ||
      new Set(input.fallbackModelIds).size !== input.fallbackModelIds.length ||
      input.fallbackModelIds.includes(input.sourceModelId)
    ) {
      throw new DomainError("validation_error", "Fallback targets are invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('provider_model_routes',0))`;
      const source = await tx<Row[]>`SELECT m.*,p.protocol FROM provider_models m
        JOIN providers p ON p.id=m.provider_id WHERE m.id=${input.sourceModelId}`;
      if (!source.length) throw new DomainError("not_found", "Source model not found", 404);
      if (input.retryPolicyId != null) {
        const policy =
          await tx`SELECT id FROM provider_retry_policies WHERE id=${input.retryPolicyId}`;
        if (!policy.length) throw new DomainError("not_found", "Retry policy not found", 404);
      }
      const targets = input.fallbackModelIds.length
        ? await tx<
          Row[]
        >`SELECT m.*,p.protocol,p.enabled AS provider_enabled,p.credential_envelope,
            EXISTS(SELECT 1 FROM model_price_versions mp WHERE mp.provider_model_id=m.id AND mp.effective_at<=now()) AS priced
          FROM provider_models m JOIN providers p ON p.id=m.provider_id
          WHERE m.id = ANY(${input.fallbackModelIds}::uuid[])`
        : [];
      if (targets.length !== input.fallbackModelIds.length) {
        throw new DomainError("validation_error", "Fallback targets are invalid", 422);
      }
      const sourceRow = source[0];
      const sourceCapabilities = sourceRow.capabilities as string[];
      if (
        targets.some((target) =>
          !target.enabled || !target.provider_enabled || target.credential_envelope == null ||
          !target.priced || target.protocol !== sourceRow.protocol ||
          number(target.context_window) < number(sourceRow.context_window) ||
          sourceCapabilities.some((capability) =>
            !(target.capabilities as string[]).includes(capability)
          )
        )
      ) {
        throw new DomainError(
          "fallback_incompatible",
          "Fallback targets must be available and compatible with the source model",
          422,
        );
      }
      const currentRows = await tx<
        Row[]
      >`SELECT * FROM provider_model_routes WHERE source_model_id=${input.sourceModelId} FOR UPDATE`;
      const currentVersion = currentRows[0] ? number(currentRows[0].version) : 0;
      if (currentVersion !== input.expectedVersion) throw registryConflict();
      let routeRows: Row[];
      if (currentRows[0]) {
        const routeId = String(currentRows[0].id);
        routeRows = await tx<Row[]>`UPDATE provider_model_routes SET retry_policy_id=${
          input.retryPolicyId ?? null
        },version=version+1,updated_at=now() WHERE id=${routeId} RETURNING *`;
      } else {
        routeRows = await tx<
          Row[]
        >`INSERT INTO provider_model_routes(source_model_id,retry_policy_id) VALUES(${input.sourceModelId},${
          input.retryPolicyId ?? null
        }) RETURNING *`;
      }
      const route = routeRows[0];
      const routeId = String(route.id);
      await tx`DELETE FROM provider_model_route_targets WHERE route_id=${routeId}`;
      for (const [index, target] of input.fallbackModelIds.entries()) {
        await tx`INSERT INTO provider_model_route_targets(route_id,target_model_id,ordinal) VALUES(${routeId},${target},${
          index + 1
        })`;
      }
      const cycle = await tx`WITH RECURSIVE edges AS (
          SELECT r.source_model_id AS source,p.target_model_id AS target
          FROM provider_model_routes r JOIN provider_model_route_targets p ON p.route_id=r.id
        ), walk(root,node,path,cycle) AS (
          SELECT source,target,ARRAY[source,target],target=source FROM edges
          UNION ALL
          SELECT w.root,e.target,w.path||e.target,e.target=ANY(w.path)
          FROM walk w JOIN edges e ON e.source=w.node WHERE NOT w.cycle
        ) SELECT 1 FROM walk WHERE cycle LIMIT 1`;
      if (cycle.length) {
        throw new DomainError("fallback_cycle", "Fallback routes must be acyclic", 422);
      }
      const tooDeep = await tx`WITH RECURSIVE edges AS (
          SELECT r.source_model_id AS source,p.target_model_id AS target
          FROM provider_model_routes r JOIN provider_model_route_targets p ON p.route_id=r.id
        ), reach(root,node) AS (
          SELECT source,source FROM edges UNION SELECT source,target FROM edges
          UNION SELECT r.root,e.target FROM reach r JOIN edges e ON e.source=r.node
        ) SELECT root FROM reach GROUP BY root HAVING count(DISTINCT node)>8 LIMIT 1`;
      if (tooDeep.length) {
        throw new DomainError(
          "fallback_depth",
          "Execution plans may contain at most eight targets",
          422,
        );
      }
      const value: ProviderModelRoute = {
        id: String(route.id),
        sourceModelId: String(route.source_model_id),
        retryPolicyId: route.retry_policy_id == null ? null : String(route.retry_policy_id),
        fallbackModelIds: [...input.fallbackModelIds],
        version: number(route.version),
        createdAt: iso(route.created_at),
        updatedAt: iso(route.updated_at),
      };
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${mutation.actorId ?? null},${mutation.action},'provider_model_route',${value.id},${
        tx.json({
          ...mutation.metadata,
          sourceModelId: value.sourceModelId,
          version: value.version,
          fallbackCount: value.fallbackModelIds.length,
        })
      })`;
      return value;
    });
  }

  async findProviderModelRoute(sourceModelId: string): Promise<ProviderModelRoute | undefined> {
    const rows = await this.#sql<
      Row[]
    >`SELECT r.*,COALESCE(jsonb_agg(t.target_model_id ORDER BY t.ordinal) FILTER (WHERE t.target_model_id IS NOT NULL),'[]'::jsonb) AS targets
      FROM provider_model_routes r LEFT JOIN provider_model_route_targets t ON t.route_id=r.id
      WHERE r.source_model_id=${sourceModelId} GROUP BY r.id`;
    if (!rows[0]) return undefined;
    return {
      id: String(rows[0].id),
      sourceModelId: String(rows[0].source_model_id),
      retryPolicyId: rows[0].retry_policy_id == null ? null : String(rows[0].retry_policy_id),
      fallbackModelIds: (rows[0].targets as unknown[]).map(String),
      version: number(rows[0].version),
      createdAt: iso(rows[0].created_at),
      updatedAt: iso(rows[0].updated_at),
    };
  }

  async resolveProviderExecutionPlan(
    sourceModelId: string,
    at = new Date().toISOString(),
  ): Promise<ProviderExecutionPlan> {
    if (!Number.isFinite(Date.parse(at))) {
      throw new DomainError("validation_error", "Plan timestamp is invalid", 422);
    }
    const route = await this.findProviderModelRoute(sourceModelId);
    const ids: string[] = [];
    const seen = new Set<string>();
    const flatten = async (id: string): Promise<void> => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
      const nested = await this.findProviderModelRoute(id);
      for (const fallback of nested?.fallbackModelIds ?? []) await flatten(fallback);
    };
    await flatten(sourceModelId);
    const targets = [];
    let sourceRow: Row | undefined;
    for (const id of ids) {
      const rows = await this.#sql<
        Row[]
      >`SELECT m.*,p.slug,p.version AS provider_version,p.protocol,p.enabled AS provider_enabled,
          p.credential_envelope,mp.id AS price_id,mp.input_micros_per_million,mp.cached_input_micros_per_million,
          mp.reasoning_micros_per_million,mp.output_micros_per_million,mp.fixed_call_micros,mp.source
        FROM provider_models m JOIN providers p ON p.id=m.provider_id
        LEFT JOIN LATERAL (SELECT * FROM model_price_versions WHERE provider_model_id=m.id AND effective_at<=${at} ORDER BY effective_at DESC,id DESC LIMIT 1) mp ON true
        WHERE m.id=${id}`;
      const row = rows[0];
      if (id === sourceModelId) sourceRow = row;
      const compatible = row && sourceRow && row.protocol === sourceRow.protocol &&
        number(row.context_window) >= number(sourceRow.context_window) &&
        (sourceRow.capabilities as string[]).every((capability) =>
          (row.capabilities as string[]).includes(capability)
        );
      const unavailable = !row || !row.enabled || !row.provider_enabled ||
        row.credential_envelope == null ||
        row.price_id == null || !compatible;
      if (unavailable) {
        if (id !== sourceModelId) continue;
        throw new DomainError(
          "execution_plan_unavailable",
          "Provider execution target is unavailable",
          409,
        );
      }
      targets.push({
        ordinal: targets.length,
        providerId: String(row.provider_id),
        providerSlug: String(row.slug),
        providerVersion: number(row.provider_version),
        protocol: row.protocol as ProviderExecutionPlan["targets"][number]["protocol"],
        providerModelId: String(row.id),
        publicModelId: String(row.public_model_id),
        upstreamModelId: String(row.upstream_model_id),
        modelVersion: number(row.version),
        pricing: {
          pricingVersionId: String(row.price_id),
          inputMicrosPerMillion: number(row.input_micros_per_million),
          cachedInputMicrosPerMillion: number(row.cached_input_micros_per_million),
          reasoningMicrosPerMillion: number(row.reasoning_micros_per_million),
          outputMicrosPerMillion: number(row.output_micros_per_million),
          fixedCallMicros: number(row.fixed_call_micros),
          source: String(row.source),
        },
      });
    }
    const policies = route?.retryPolicyId
      ? await this.#sql<
        Row[]
      >`SELECT * FROM provider_retry_policies WHERE id=${route.retryPolicyId}`
      : [];
    return {
      sourceModelId,
      routeId: route?.id ?? null,
      routeVersion: route?.version ?? 0,
      retryPolicy: policies[0] && policies[0].enabled ? retryPolicy(policies[0]) : null,
      targets,
      resolvedAt: new Date(at).toISOString(),
    };
  }

  async claimProviderExecution(
    usageRunId: string,
    ownerLeaseToken: string,
  ): Promise<ProviderExecutionClaim> {
    return await this.#sql.begin(async (tx) => {
      const runs = await tx<Row[]>`SELECT *,(
          (generation_lease_token=${ownerLeaseToken} AND generation_lease_expires_at>now()) OR
          (run_lease_token=${ownerLeaseToken} AND run_lease_expires_at>now()) OR
          EXISTS(SELECT 1 FROM api_idempotency_requests a WHERE a.usage_run_id=usage_runs.id
            AND a.state='in_progress' AND a.lease_token=${ownerLeaseToken} AND a.lease_expires_at>now())
        ) AS lease_valid FROM usage_runs WHERE id=${usageRunId} FOR UPDATE`;
      if (!runs[0]) throw new DomainError("not_found", "Usage run not found", 404);
      if (runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      if (runs[0].lease_valid !== true) {
        throw new DomainError("stale_lease", "Provider execution lease is stale", 409);
      }
      let epoch = number(runs[0].execution_epoch ?? 0);
      const reconciledAttemptIds: string[] = [];
      if (String(runs[0].execution_owner_lease_token ?? "") !== ownerLeaseToken) {
        epoch += 1;
        const reconciled = await tx<Row[]>`SELECT id FROM provider_attempts
          WHERE usage_run_id=${usageRunId} AND status='running' FOR UPDATE`;
        reconciledAttemptIds.push(...reconciled.map((row) => String(row.id)));
        await tx`UPDATE usage_runs SET execution_epoch=${epoch},
          execution_owner_lease_token=${ownerLeaseToken} WHERE id=${usageRunId}`;
      }
      const ordinals = await tx<
        { next: number }[]
      >`SELECT COALESCE(max(attempt_number),0)::int+1 AS next
        FROM provider_attempts WHERE usage_run_id=${usageRunId}`;
      const nextAttemptNumber = number(ordinals[0].next);
      const consumed = await tx<{ count: number }[]>`SELECT count(*)::int count
        FROM provider_attempts WHERE usage_run_id=${usageRunId} AND status<>'skipped'`;
      if (nextAttemptNumber > 16) {
        throw new DomainError(
          "execution_path_exhausted",
          "Provider execution path is exhausted",
          409,
        );
      }
      return {
        usageRunId,
        executionEpoch: epoch,
        nextAttemptNumber,
        consumedAttempts: number(consumed[0].count),
        reconciledAttemptIds,
      };
    });
  }

  async heartbeatProviderExecutionLease(
    usageRunId: string,
    ownerLeaseToken: string,
    leaseSeconds = 120,
  ) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) {
      throw new DomainError(
        "validation_error",
        "Provider execution lease duration is invalid",
        422,
      );
    }
    const rows = await this.#sql<Row[]>`UPDATE usage_runs SET
      run_lease_expires_at=now()+${leaseSeconds}*interval '1 second'
      WHERE id=${usageRunId} AND status='reserved' AND run_lease_token=${ownerLeaseToken}
        AND run_lease_expires_at>now()
      RETURNING run_lease_token,run_lease_expires_at`;
    if (!rows[0]) {
      throw new DomainError("stale_lease", "Provider execution lease is no longer active", 409);
    }
    return {
      leaseToken: String(rows[0].run_lease_token),
      leaseExpiresAt: iso(rows[0].run_lease_expires_at)!,
    };
  }

  async reclaimProviderExecutionLease(
    usageRunId: string,
    expiredLeaseToken: string,
    leaseSeconds = 120,
  ) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) {
      throw new DomainError(
        "validation_error",
        "Provider execution lease duration is invalid",
        422,
      );
    }
    const replacement = crypto.randomUUID();
    const rows = await this.#sql<Row[]>`UPDATE usage_runs SET run_lease_token=${replacement},
      run_lease_expires_at=now()+${leaseSeconds}*interval '1 second'
      WHERE id=${usageRunId} AND status='reserved' AND run_lease_token=${expiredLeaseToken}
        AND run_lease_expires_at<=now()
      RETURNING run_lease_token,run_lease_expires_at`;
    if (!rows[0]) {
      throw new DomainError(
        "lease_not_reclaimable",
        "Provider execution lease cannot be reclaimed",
        409,
      );
    }
    return {
      leaseToken: String(rows[0].run_lease_token),
      leaseExpiresAt: iso(rows[0].run_lease_expires_at)!,
    };
  }

  async startProviderAttempt(input: StartProviderAttemptInput): Promise<ProviderAttempt> {
    if (
      !Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1 ||
      input.attemptNumber > 16 || !isUsagePricingSnapshot(input.pricing) ||
      !Number.isSafeInteger(input.executionEpoch) || input.executionEpoch < 1 ||
      !/^[0-9a-f-]{36}$/i.test(input.ownerLeaseToken) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.providerSlug) ||
      input.publicModelId.length < 3 || input.publicModelId.length > 255 ||
      !input.upstreamModelId || input.upstreamModelId.length > 255 ||
      !Number.isSafeInteger(input.providerVersion) || input.providerVersion < 1 ||
      !Number.isSafeInteger(input.modelVersion) || input.modelVersion < 1 ||
      !["chat_completions", "responses"].includes(input.protocol) ||
      !Number.isSafeInteger(input.targetOrdinal) || input.targetOrdinal < 0 ||
      input.targetOrdinal > 7 || !Number.isSafeInteger(input.retryNumber) ||
      input.retryNumber < 0 || input.retryNumber > 3 ||
      !["primary", "retry", "fallback", "circuit_skip", "half_open"].includes(input.reason) ||
      (input.breakerBefore != null &&
        !["closed", "open", "half_open", "unavailable"].includes(input.breakerBefore))
    ) throw new DomainError("validation_error", "Provider attempt start is invalid", 422);
    return await this.#sql.begin(async (tx) => {
      const runs = await tx<Row[]>`SELECT *,(
          (generation_lease_token=${input.ownerLeaseToken} AND generation_lease_expires_at>now()) OR
          (run_lease_token=${input.ownerLeaseToken} AND run_lease_expires_at>now()) OR
          EXISTS(SELECT 1 FROM api_idempotency_requests a WHERE a.usage_run_id=usage_runs.id
            AND a.state='in_progress' AND a.lease_token=${input.ownerLeaseToken} AND a.lease_expires_at>now())
        ) AS lease_valid FROM usage_runs WHERE id=${input.usageRunId} FOR UPDATE`;
      if (!runs[0] || runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      if (
        runs[0].lease_valid !== true || number(runs[0].execution_epoch) !== input.executionEpoch ||
        String(runs[0].execution_owner_lease_token ?? "") !== input.ownerLeaseToken
      ) {
        throw new DomainError("stale_lease", "Provider execution epoch is stale", 409);
      }
      const prior = await tx<
        Row[]
      >`SELECT * FROM provider_attempts WHERE usage_run_id=${input.usageRunId} AND attempt_number=${input.attemptNumber} FOR UPDATE`;
      if (prior[0]) {
        const existing = providerAttempt(prior[0]);
        const same = existing.providerId === input.providerId &&
          existing.targetOrdinal === input.targetOrdinal &&
          existing.executionEpoch === input.executionEpoch &&
          existing.retryNumber === input.retryNumber && existing.reason === input.reason &&
          existing.breakerBefore === (input.breakerBefore ?? null) &&
          existing.providerSlug === input.providerSlug &&
          existing.providerVersion === input.providerVersion &&
          existing.protocol === input.protocol &&
          existing.providerModelId === input.providerModelId &&
          existing.publicModelId === input.publicModelId &&
          existing.upstreamModelId === input.upstreamModelId &&
          existing.modelVersion === input.modelVersion &&
          JSON.stringify(existing.pricing) === JSON.stringify(input.pricing);
        if (!same) {
          throw new DomainError(
            "idempotency_conflict",
            "Attempt number already has different target data",
            409,
          );
        }
        return existing;
      }
      const p = input.pricing;
      const snapshots = await tx<Row[]>`SELECT mp.*,m.provider_id FROM model_price_versions mp
        JOIN provider_models m ON m.id=mp.provider_model_id
        WHERE mp.id=${p.pricingVersionId} AND mp.provider_model_id=${input.providerModelId}`;
      const snapshot = snapshots[0];
      if (
        !snapshot || String(snapshot.provider_id) !== input.providerId ||
        number(snapshot.input_micros_per_million) !== p.inputMicrosPerMillion ||
        number(snapshot.cached_input_micros_per_million) !== p.cachedInputMicrosPerMillion ||
        number(snapshot.reasoning_micros_per_million) !== p.reasoningMicrosPerMillion ||
        number(snapshot.output_micros_per_million) !== p.outputMicrosPerMillion ||
        number(snapshot.fixed_call_micros) !== p.fixedCallMicros ||
        String(snapshot.source) !== p.source
      ) {
        throw new DomainError(
          "validation_error",
          "Provider attempt target snapshot is invalid",
          422,
        );
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO provider_attempts(usage_run_id,attempt_number,execution_epoch,target_ordinal,retry_number,reason,breaker_before,provider_id,provider_slug,provider_version,protocol,provider_model_id,public_model_id,upstream_model_id,model_version,pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source)
        VALUES(${input.usageRunId},${input.attemptNumber},${input.executionEpoch},${input.targetOrdinal},${input.retryNumber},${input.reason},${
        input.breakerBefore ?? null
      },${input.providerId},${input.providerSlug},${input.providerVersion},${input.protocol},${input.providerModelId},${input.publicModelId},${input.upstreamModelId},${input.modelVersion},${p.pricingVersionId},${p.inputMicrosPerMillion},${p.cachedInputMicrosPerMillion},${p.reasoningMicrosPerMillion},${p.outputMicrosPerMillion},${p.fixedCallMicros},${p.source}) RETURNING *`;
      return providerAttempt(rows[0]);
    });
  }

  async finishProviderAttempt(input: FinishProviderAttemptInput): Promise<ProviderAttempt> {
    validateAttemptFinish(input);
    return await this.#sql.begin(async (tx) => {
      const lookup = await tx<
        Row[]
      >`SELECT usage_run_id FROM provider_attempts WHERE id=${input.id}`;
      if (!lookup[0]) throw new DomainError("not_found", "Provider attempt not found", 404);
      const runs = await tx<Row[]>`SELECT *,(
          (generation_lease_token=${input.ownerLeaseToken} AND generation_lease_expires_at>now()) OR
          (run_lease_token=${input.ownerLeaseToken} AND run_lease_expires_at>now()) OR
          EXISTS(SELECT 1 FROM api_idempotency_requests a WHERE a.usage_run_id=usage_runs.id
            AND a.state='in_progress' AND a.lease_token=${input.ownerLeaseToken} AND a.lease_expires_at>now())
        ) AS lease_valid FROM usage_runs WHERE id=${String(lookup[0].usage_run_id)} FOR UPDATE`;
      if (!runs[0] || runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      const prior = await tx<
        Row[]
      >`SELECT * FROM provider_attempts WHERE id=${input.id} FOR UPDATE`;
      if (!prior[0]) throw new DomainError("not_found", "Provider attempt not found", 404);
      const existing = providerAttempt(prior[0]);
      if (
        runs[0].lease_valid !== true || existing.executionEpoch !== input.executionEpoch ||
        number(runs[0].execution_epoch) !== input.executionEpoch ||
        String(runs[0].execution_owner_lease_token ?? "") !== input.ownerLeaseToken
      ) {
        throw new DomainError("stale_lease", "Provider execution epoch is stale", 409);
      }
      const terminal = {
        ...input,
        errorCode: input.errorCode ?? null,
        httpStatus: input.httpStatus ?? null,
        ttftMs: input.ttftMs ?? null,
        breakerAfter: input.breakerAfter ?? null,
        upstreamRequestId: input.upstreamRequestId ?? null,
        tokensPerSecond: input.tokensPerSecond ?? null,
      };
      if (existing.status !== "running") {
        const same = existing.status === terminal.status && existing.phase === terminal.phase &&
          existing.errorCode === terminal.errorCode &&
          existing.httpStatus === terminal.httpStatus &&
          existing.visibleOutput === terminal.visibleOutput &&
          existing.inputTokens === terminal.inputTokens &&
          existing.cachedInputTokens === terminal.cachedInputTokens &&
          existing.reasoningTokens === terminal.reasoningTokens &&
          existing.outputTokens === terminal.outputTokens &&
          existing.costMicros === terminal.costMicros &&
          existing.tokenSource === terminal.tokenSource &&
          existing.costSource === terminal.costSource &&
          existing.latencyMs === terminal.latencyMs && existing.ttftMs === terminal.ttftMs;
        const telemetrySame = existing.breakerAfter === terminal.breakerAfter &&
          existing.retryable === terminal.retryable &&
          existing.upstreamRequestId === terminal.upstreamRequestId &&
          existing.tokensPerSecond === terminal.tokensPerSecond;
        if (!same || !telemetrySame) {
          throw new DomainError(
            "attempt_terminal_conflict",
            "Provider attempt is already terminal",
            409,
          );
        }
        return existing;
      }
      const exactCost = exactAttemptCost(existing, input);
      if (input.costMicros !== exactCost) {
        throw new DomainError(
          "invalid_attempt_cost",
          "Provider attempt cost does not match its pricing snapshot",
          422,
        );
      }
      const rows = await tx<
        Row[]
      >`UPDATE provider_attempts SET status=${terminal.status},phase=${terminal.phase},error_code=${terminal.errorCode},http_status=${terminal.httpStatus},visible_output=${terminal.visibleOutput},input_tokens=${terminal.inputTokens},cached_input_tokens=${terminal.cachedInputTokens},reasoning_tokens=${terminal.reasoningTokens},output_tokens=${terminal.outputTokens},cost_micros=${terminal.costMicros},token_source=${terminal.tokenSource},cost_source=${terminal.costSource},latency_ms=${terminal.latencyMs},ttft_ms=${terminal.ttftMs},breaker_after=${terminal.breakerAfter},retryable=${terminal.retryable},upstream_request_id=${terminal.upstreamRequestId},tokens_per_second=${terminal.tokensPerSecond},completed_at=now() WHERE id=${input.id} RETURNING *`;
      await tx`UPDATE usage_runs SET
        actual_provider_cost_micros=actual_provider_cost_micros+${exactCost},
        actual_provider_input_tokens=actual_provider_input_tokens+${input.inputTokens},
        actual_provider_cached_input_tokens=actual_provider_cached_input_tokens+${input.cachedInputTokens},
        actual_provider_reasoning_tokens=actual_provider_reasoning_tokens+${input.reasoningTokens},
        actual_provider_output_tokens=actual_provider_output_tokens+${input.outputTokens}
        WHERE id=${existing.usageRunId}`;
      return providerAttempt(rows[0]);
    });
  }

  async listProviderAttempts(usageRunId: string) {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM provider_attempts WHERE usage_run_id=${usageRunId} ORDER BY attempt_number`)
      .map(providerAttempt);
  }

  async #finalizeProviderUsage(
    input: FinalizeProviderUsageInput,
    refundOnly: boolean,
  ): Promise<UsageRun> {
    if (
      !Number.isSafeInteger(input.executionEpoch) || input.executionEpoch < 1 ||
      !Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 ||
      (input.error != null && input.error.length > 1_000)
    ) {
      throw new DomainError("validation_error", "Provider usage finalization is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT *,(
          (generation_lease_token=${input.ownerLeaseToken} AND generation_lease_expires_at>now()) OR
          (run_lease_token=${input.ownerLeaseToken} AND run_lease_expires_at>now()) OR
          EXISTS(SELECT 1 FROM api_idempotency_requests a WHERE a.usage_run_id=usage_runs.id
            AND a.state='in_progress' AND a.lease_token=${input.ownerLeaseToken} AND a.lease_expires_at>now())
        ) AS lease_valid FROM usage_runs WHERE id=${input.usageRunId} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Usage run not found", 404);
      if (rows[0].status !== "reserved") {
        if (
          number(rows[0].execution_epoch) === input.executionEpoch &&
          String(rows[0].execution_owner_lease_token ?? "") === input.ownerLeaseToken
        ) {
          return run(rows[0]);
        }
        throw new DomainError("invalid_usage_state", "Usage run is already terminal", 409);
      }
      if (
        rows[0].lease_valid !== true || number(rows[0].execution_epoch) !== input.executionEpoch ||
        String(rows[0].execution_owner_lease_token ?? "") !== input.ownerLeaseToken
      ) {
        throw new DomainError("stale_lease", "Provider execution epoch is stale", 409);
      }
      const uncertainty = await tx<{ uncertain: boolean }[]>`SELECT EXISTS(SELECT 1
        FROM provider_attempts WHERE usage_run_id=${input.usageRunId} AND status='running')
        AS uncertain`;
      const cost = uncertainty[0].uncertain
        ? number(rows[0].reserved_micros)
        : number(rows[0].actual_provider_cost_micros);
      if (uncertainty[0].uncertain) {
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${input.usageRunId} AND status='running'`;
      }
      const userId = String(rows[0].user_id);
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      const reserved = number(rows[0].reserved_micros);
      const delta = reserved - cost;
      const after = number(users[0].balance_micros) + delta;
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new DomainError("insufficient_credit", "Provider cost exceeds available credit", 402);
      }
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
      if (delta !== 0) {
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros)
          VALUES(${userId},${input.usageRunId},${
          delta > 0 ? "refund" : "settle"
        },${delta},${after})`;
      }
      const updated = await tx<Row[]>`UPDATE usage_runs SET status=${
        refundOnly ? "failed" : "completed"
      },cost_micros=${cost},input_tokens=${number(rows[0].actual_provider_input_tokens)},
        output_tokens=${
        number(rows[0].actual_provider_output_tokens)
      },latency_ms=${input.latencyMs},
        error=${input.error ?? null},run_lease_token=NULL,run_lease_expires_at=NULL,
        generation_lease_token=NULL,generation_lease_expires_at=NULL,completed_at=now()
        WHERE id=${input.usageRunId} RETURNING *`;
      return run(updated[0]);
    });
  }

  settleProviderUsage(input: FinalizeProviderUsageInput): Promise<UsageRun> {
    return this.#finalizeProviderUsage(input, false);
  }

  refundProviderUsage(input: FinalizeProviderUsageInput): Promise<UsageRun> {
    return this.#finalizeProviderUsage(input, true);
  }

  async reserveChildProviderUsage(input: ReserveChildProviderUsageInput): Promise<UsageRun> {
    if (
      !Number.isSafeInteger(input.reserveMicros) || input.reserveMicros < 0 ||
      !isUsagePricingSnapshot(input.pricingSnapshot)
    ) throw new DomainError("validation_error", "Child usage reservation is invalid", 422);
    return await this.#sql.begin(async (tx) => {
      const parents = await tx<Row[]>`SELECT *,(
          (generation_lease_token=${input.parentOwnerLeaseToken} AND
            generation_lease_expires_at>now()) OR
          (run_lease_token=${input.parentOwnerLeaseToken} AND run_lease_expires_at>now()) OR
          EXISTS(SELECT 1 FROM api_idempotency_requests a
            WHERE a.usage_run_id=usage_runs.id AND a.state='in_progress'
              AND a.lease_token=${input.parentOwnerLeaseToken} AND a.lease_expires_at>now())
        ) AS lease_valid FROM usage_runs WHERE id=${input.parentUsageRunId} FOR UPDATE`;
      const parent = parents[0];
      if (!parent || parent.status !== "reserved" || parent.lease_valid !== true) {
        throw new DomainError("stale_lease", "Parent provider execution lease is stale", 409);
      }
      const userId = String(parent.user_id);
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      const balance = number(users[0].balance_micros);
      if (balance < input.reserveMicros) {
        throw new DomainError("insufficient_credit", "Insufficient credit for OCR", 402);
      }
      const p = input.pricingSnapshot;
      const leaseToken = crypto.randomUUID();
      let rows: Row[];
      try {
        rows = await tx<Row[]>`INSERT INTO usage_runs(
          id,user_id,model,provider,status,reserved_micros,run_lease_token,run_lease_expires_at,
          pricing_version_id,pricing_input_micros_per_million,
          pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,
          pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source)
          VALUES(${input.runId},${userId},${input.model},${input.provider},'reserved',
          ${input.reserveMicros},${leaseToken},now()+120*interval '1 second',
          ${p.pricingVersionId},${p.inputMicrosPerMillion},${p.cachedInputMicrosPerMillion},
          ${p.reasoningMicrosPerMillion},${p.outputMicrosPerMillion},${p.fixedCallMicros},${p.source})
          RETURNING *`;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new DomainError("idempotency_conflict", "Child usage run already exists", 409);
        }
        throw error;
      }
      const after = balance - input.reserveMicros;
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
      await tx`INSERT INTO ledger_entries(
        user_id,usage_run_id,kind,amount_micros,balance_after_micros)
        VALUES(${userId},${input.runId},'reserve',${-input.reserveMicros},${after})`;
      return run(rows[0]);
    });
  }

  async ensureUsageReservation(input: EnsureUsageReservationInput): Promise<UsageRun> {
    if (!Number.isSafeInteger(input.requiredMicros) || input.requiredMicros < 0) {
      throw new DomainError("validation_error", "Usage reservation requirement is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT *,(
          (generation_lease_token=${input.ownerLeaseToken} AND generation_lease_expires_at>now()) OR
          (run_lease_token=${input.ownerLeaseToken} AND run_lease_expires_at>now()) OR
          EXISTS(SELECT 1 FROM api_idempotency_requests a WHERE a.usage_run_id=usage_runs.id
            AND a.state='in_progress' AND a.lease_token=${input.ownerLeaseToken}
            AND a.lease_expires_at>now())
        ) AS lease_valid FROM usage_runs WHERE id=${input.usageRunId} FOR UPDATE`;
      const current = rows[0];
      if (!current || current.status !== "reserved" || current.lease_valid !== true) {
        throw new DomainError("stale_lease", "Usage reservation lease is stale", 409);
      }
      const reserved = number(current.reserved_micros);
      if (reserved >= input.requiredMicros) return run(current);
      const delta = input.requiredMicros - reserved;
      const userId = String(current.user_id);
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      const balance = number(users[0].balance_micros);
      if (balance < delta) {
        throw new DomainError("insufficient_credit", "Insufficient credit for expanded input", 402);
      }
      const after = balance - delta;
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
      const updated = await tx<Row[]>`UPDATE usage_runs SET reserved_micros=${input.requiredMicros}
        WHERE id=${input.usageRunId} RETURNING *`;
      await tx`INSERT INTO ledger_entries(
        user_id,usage_run_id,kind,amount_micros,balance_after_micros)
        VALUES(${userId},${input.usageRunId},'reserve',${-delta},${after})`;
      return run(updated[0]);
    });
  }

  async reapStaleProviderExecutionLeases(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new DomainError("validation_error", "Provider lease reaper limit is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT r.* FROM usage_runs r
        WHERE r.status='reserved' AND r.run_lease_token IS NOT NULL
          AND r.run_lease_expires_at<=now() AND r.generation_lease_token IS NULL
          AND NOT EXISTS(SELECT 1 FROM api_idempotency_requests a WHERE a.usage_run_id=r.id)
        ORDER BY r.run_lease_expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      for (const row of rows) {
        const runId = String(row.id);
        const uncertainty = await tx<{ uncertain: boolean; embedding_uncertain: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM provider_attempts
            WHERE usage_run_id=${runId} AND status='running') AS uncertain,
          EXISTS(SELECT 1 FROM embedding_provider_attempts
            WHERE usage_run_id=${runId} AND status='running') AS embedding_uncertain`;
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='execution_lease_expired',breaker_after='unavailable',retryable=true,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${runId} AND status='running'`;
        await tx`UPDATE embedding_provider_attempts SET status='cancelled',
          cost_micros=${number(row.reserved_micros)},cost_source='calculated',
          token_source='estimated',error='execution lease expired',
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${runId} AND status='running'`;
        const userId = String(row.user_id);
        const users = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        const providerExecution = number(row.execution_epoch) > 0;
        const cost = uncertainty[0].embedding_uncertain
          ? number(row.reserved_micros)
          : providerExecution
          ? uncertainty[0].uncertain
            ? number(row.reserved_micros)
            : number(row.actual_provider_cost_micros)
          : 0;
        const delta = number(row.reserved_micros) - cost;
        const after = number(users[0].balance_micros) + delta;
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        if (delta !== 0) {
          await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros)
            VALUES(${userId},${runId},${delta > 0 ? "refund" : "settle"},${delta},${after})`;
        }
        await tx`UPDATE usage_runs SET status='failed',cost_micros=${cost},input_tokens=${
          providerExecution ? number(row.actual_provider_input_tokens) : 0
        },output_tokens=${
          providerExecution ? number(row.actual_provider_output_tokens) : 0
        },run_lease_token=NULL,run_lease_expires_at=NULL,error='provider execution lease expired',
          completed_at=now() WHERE id=${runId}`;
      }
      return rows.length;
    });
  }

  async createApiToken(userId: string, input: CreateApiTokenInput) {
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO api_tokens(user_id,name,token_hash,preview,scopes,expires_at) VALUES(${userId},${input.name},${input.tokenHash},${input.preview},${
      this.#sql.json(input.scopes)
    },${input.expiresAt ?? null}) RETURNING *`;
    return token(rows[0]);
  }
  async findApiTokenByHash(hash: string) {
    const rows = await this.#sql<
      Row[]
    >`UPDATE api_tokens SET last_used_at=now() WHERE token_hash=${hash} RETURNING *`;
    return rows[0] ? token(rows[0]) : undefined;
  }
  async listApiTokens(userId: string) {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM api_tokens WHERE user_id=${userId} ORDER BY created_at DESC`).map((row) => {
      const { tokenHash: _hash, userId: _userId, ...summary } = token(row);
      return summary;
    });
  }
  async revokeApiToken(id: string, userId: string) {
    const rows = await this
      .#sql`UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id} AND user_id=${userId} RETURNING id`;
    if (!rows.length) throw new DomainError("not_found", "Token not found", 404);
  }

  async reserve(
    userId: string,
    runId: string,
    model: string,
    amount: number,
    provider = "unknown",
    tokenId?: string,
    pricingSnapshot?: UsagePricingSnapshot,
  ) {
    if (pricingSnapshot !== undefined && !isUsagePricingSnapshot(pricingSnapshot)) {
      throw new DomainError("validation_error", "Usage pricing snapshot is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      if (!users[0]) throw new DomainError("not_found", "User not found", 404);
      const balance = number(users[0].balance_micros);
      if (balance < amount) {
        throw new DomainError("insufficient_credit", "Insufficient credit", 402);
      }
      try {
        const runLeaseToken = crypto.randomUUID();
        const runs = await tx<
          Row[]
        >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,status,reserved_micros,run_lease_token,run_lease_expires_at,pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source) VALUES(${runId},${userId},${
          tokenId ?? null
        },${model},${provider},'reserved',${amount},${runLeaseToken},now()+120*interval '1 second',${
          pricingSnapshot?.pricingVersionId ?? null
        },${pricingSnapshot?.inputMicrosPerMillion ?? null},${
          pricingSnapshot?.cachedInputMicrosPerMillion ?? null
        },${pricingSnapshot?.reasoningMicrosPerMillion ?? null},${
          pricingSnapshot?.outputMicrosPerMillion ?? null
        },${pricingSnapshot?.fixedCallMicros ?? null},${
          pricingSnapshot?.source ?? null
        }) RETURNING *`;
        const after = balance - amount;
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${runId},'reserve',${-amount},${after})`;
        return run(runs[0]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new DomainError(
            "idempotency_conflict",
            "This idempotency key has already been used",
            409,
          );
        }
        throw error;
      }
    });
  }
  async settle(
    runId: string,
    cost: number,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      const runs = await tx<Row[]>`SELECT *,EXISTS(SELECT 1 FROM provider_attempts
        WHERE usage_run_id=usage_runs.id AND status='running') AS provider_accounting_uncertain,
        EXISTS(SELECT 1 FROM embedding_provider_attempts
          WHERE usage_run_id=usage_runs.id AND status='running') AS embedding_accounting_uncertain
        FROM usage_runs WHERE id=${runId} FOR UPDATE`;
      if (!runs[0]) throw new DomainError("not_found", "Usage reservation not found", 404);
      if (runs[0].status === "completed") return run(runs[0]);
      if (runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      if (number(runs[0].execution_epoch) > 0) {
        cost = runs[0].provider_accounting_uncertain === true
          ? number(runs[0].reserved_micros)
          : number(runs[0].actual_provider_cost_micros);
        inputTokens = number(runs[0].actual_provider_input_tokens);
        outputTokens = number(runs[0].actual_provider_output_tokens);
        if (runs[0].provider_accounting_uncertain === true) {
          await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
            error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
            latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
            completed_at=now() WHERE usage_run_id=${runId} AND status='running'`;
        }
      }
      const reserved = number(runs[0].reserved_micros);
      const delta = reserved - cost;
      const userId = String(runs[0].user_id);
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      const after = number(users[0].balance_micros) + delta;
      if (after < 0) {
        throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
      }
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
      if (delta !== 0) {
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${runId},${
          delta > 0 ? "refund" : "settle"
        },${delta},${after})`;
      }
      const updated = await tx<
        Row[]
      >`UPDATE usage_runs SET status='completed',cost_micros=${cost},input_tokens=${inputTokens},output_tokens=${outputTokens},latency_ms=${latencyMs},run_lease_token=NULL,run_lease_expires_at=NULL,completed_at=now() WHERE id=${runId} RETURNING *`;
      return run(updated[0]);
    });
  }
  async refund(runId: string, error?: string) {
    return await this.#sql.begin(async (tx) => {
      const runs = await tx<Row[]>`SELECT *,EXISTS(SELECT 1 FROM provider_attempts
        WHERE usage_run_id=usage_runs.id AND status='running') AS provider_accounting_uncertain,
        EXISTS(SELECT 1 FROM embedding_provider_attempts
          WHERE usage_run_id=usage_runs.id AND status='running') AS embedding_accounting_uncertain
        FROM usage_runs WHERE id=${runId} FOR UPDATE`;
      if (!runs[0]) return undefined;
      if (runs[0].status !== "reserved") return run(runs[0]);
      const userId = String(runs[0].user_id);
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      const providerExecution = number(runs[0].execution_epoch) > 0;
      const embeddingExecution = runs[0].embedding_accounting_uncertain === true;
      const actualCost = embeddingExecution
        ? number(runs[0].reserved_micros)
        : providerExecution
        ? runs[0].provider_accounting_uncertain === true
          ? number(runs[0].reserved_micros)
          : number(runs[0].actual_provider_cost_micros)
        : 0;
      if (providerExecution && runs[0].provider_accounting_uncertain === true) {
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${runId} AND status='running'`;
      }
      if (embeddingExecution) {
        await tx`UPDATE embedding_provider_attempts SET status='cancelled',
          cost_micros=${actualCost},cost_source='calculated',token_source='estimated',
          error='accounting state unknown',
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${runId} AND status='running'`;
      }
      const delta = number(runs[0].reserved_micros) - actualCost;
      const after = number(users[0].balance_micros) + delta;
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
      if (delta !== 0) {
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${runId},${
          delta > 0 ? "refund" : "settle"
        },${delta},${after})`;
      }
      const updated = await tx<
        Row[]
      >`UPDATE usage_runs SET status='failed',cost_micros=${actualCost},input_tokens=${
        providerExecution ? number(runs[0].actual_provider_input_tokens) : 0
      },output_tokens=${
        providerExecution ? number(runs[0].actual_provider_output_tokens) : 0
      },error=${
        error ?? null
      },run_lease_token=NULL,run_lease_expires_at=NULL,completed_at=now() WHERE id=${runId} RETURNING *`;
      return run(updated[0]);
    });
  }
  async beginApiRequest(input: BeginApiRequestInput): Promise<BeginApiRequestResult> {
    const leaseSeconds = input.leaseSeconds ?? 120;
    const retentionSeconds = input.retentionSeconds ?? 86400;
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new DomainError("validation_error", "Idempotency key length is invalid", 422);
    }
    if (!/^[0-9a-f]{64}$/.test(input.requestHash)) {
      throw new DomainError("validation_error", "Request fingerprint must be SHA-256 hex", 422);
    }
    if (
      input.reserveMicros < 0 || leaseSeconds < 1 || retentionSeconds < 60 ||
      retentionSeconds > 2_592_000
    ) throw new DomainError("validation_error", "Invalid idempotent request parameters", 422);
    if (input.pricingSnapshot !== undefined && !isUsagePricingSnapshot(input.pricingSnapshot)) {
      throw new DomainError("validation_error", "Usage pricing snapshot is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const users = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.userId} FOR UPDATE`;
      if (!users[0]) throw new DomainError("not_found", "User not found", 404);
      await tx`DELETE FROM api_idempotency_requests WHERE user_id=${input.userId} AND endpoint=${input.endpoint} AND idempotency_key=${input.idempotencyKey} AND state<>'in_progress' AND expires_at<=now()`;
      const leaseToken = crypto.randomUUID();
      const id = crypto.randomUUID();
      const inserted = await tx<
        Row[]
      >`INSERT INTO api_idempotency_requests(id,user_id,endpoint,idempotency_key,request_hash,stream,model,state,lease_token,lease_expires_at,usage_run_id,retention_seconds,expires_at) VALUES(${id},${input.userId},${input.endpoint},${input.idempotencyKey},${input.requestHash},${input.stream},${input.model},'in_progress',${leaseToken},now()+${leaseSeconds}*interval '1 second',${input.runId},${retentionSeconds},now()+${retentionSeconds}*interval '1 second') ON CONFLICT(user_id,endpoint,idempotency_key) DO NOTHING RETURNING *`;
      if (!inserted[0]) {
        const rows = await tx<
          Row[]
        >`SELECT * FROM api_idempotency_requests WHERE user_id=${input.userId} AND endpoint=${input.endpoint} AND idempotency_key=${input.idempotencyKey}`;
        const row = rows[0];
        if (
          String(row.request_hash) !== input.requestHash || Boolean(row.stream) !== input.stream
        ) {
          throw new DomainError("idempotency_conflict", "Idempotency key payload differs", 409);
        }
        const events = await tx<Row[]>`SELECT * FROM api_idempotency_events WHERE request_id=${
          String(row.id)
        } ORDER BY sequence`;
        const request = apiRequest(row, events.map(apiFrame));
        if (request.state === "completed" || request.state === "failed") {
          return { kind: request.state, request };
        }
        return {
          kind: "in_progress",
          request,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((Date.parse(request.leaseExpiresAt!) - Date.now()) / 1000),
          ),
        };
      }
      const quota = replayQuota(input.quota);
      const live = await tx<
        { count: number }[]
      >`SELECT count(*)::int count FROM api_idempotency_requests WHERE user_id=${input.userId} AND expires_at>now()`;
      if (live[0].count > quota.maxRequests) {
        throw new DomainError("replay_quota_exceeded", "Replay request quota exceeded", 429);
      }
      const balance = number(users[0].balance_micros);
      if (balance < input.reserveMicros) {
        throw new DomainError("insufficient_credit", "Insufficient credit", 402);
      }
      const pricing = input.pricingSnapshot;
      const runs = await tx<
        Row[]
      >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,status,reserved_micros,pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source) VALUES(${input.runId},${input.userId},${
        input.tokenId ?? null
      },${input.model},${input.provider},'reserved',${input.reserveMicros},${
        pricing?.pricingVersionId ?? null
      },${pricing?.inputMicrosPerMillion ?? null},${pricing?.cachedInputMicrosPerMillion ?? null},${
        pricing?.reasoningMicrosPerMillion ?? null
      },${pricing?.outputMicrosPerMillion ?? null},${pricing?.fixedCallMicros ?? null},${
        pricing?.source ?? null
      }) RETURNING *`;
      const after = balance - input.reserveMicros;
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${input.userId}`;
      await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.userId},${input.runId},'reserve',${-input
        .reserveMicros},${after})`;
      return {
        kind: "started",
        request: apiRequest(inserted[0]),
        leaseToken,
        usageRun: run(runs[0]),
      };
    });
  }
  async getApiRequest(userId: string, endpoint: ApiIdempotencyEndpoint, idempotencyKey: string) {
    const rows = await this.#sql<
      Row[]
    >`SELECT * FROM api_idempotency_requests WHERE user_id=${userId} AND endpoint=${endpoint} AND idempotency_key=${idempotencyKey} AND expires_at>now()`;
    if (!rows[0]) return undefined;
    const events = await this.#sql<Row[]>`SELECT * FROM api_idempotency_events WHERE request_id=${
      String(rows[0].id)
    } ORDER BY sequence`;
    return apiRequest(rows[0], events.map(apiFrame));
  }
  async appendApiSseFrame(
    id: string,
    leaseToken: string,
    sequence: number,
    frame: string,
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
    quota?: ApiReplayQuota,
  ) {
    return await this.appendApiSseFrames(
      id,
      leaseToken,
      [{ sequence, frame }],
      leaseSeconds,
      observation,
      quota,
    );
  }
  async appendApiSseFrames(
    id: string,
    leaseToken: string,
    frames: ApiSseFrameInput[],
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
    quotaInput?: ApiReplayQuota,
  ) {
    if (frames.length === 0) {
      const request = await this.#sql<Row[]>`SELECT * FROM api_idempotency_requests WHERE id=${id}`;
      if (!request[0]) throw new DomainError("not_found", "Idempotent request not found", 404);
      const events = await this.#sql<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${id} ORDER BY sequence`;
      return apiRequest(request[0], events.map(apiFrame));
    }
    const encoder = new TextEncoder();
    const frameBytes = frames.map(({ frame }) => encoder.encode(frame).length);
    if (frameBytes.some((bytes) => bytes > 1_048_576)) {
      throw new DomainError("response_too_large", "SSE frame exceeds replay limit", 413);
    }
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT *,lease_expires_at>now() AS lease_active FROM api_idempotency_requests WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Idempotent request not found", 404);
      if (
        rows[0].state !== "in_progress" || String(rows[0].lease_token) !== leaseToken ||
        rows[0].lease_active !== true
      ) {
        throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
      }
      await tx`SELECT id FROM users WHERE id=${String(rows[0].user_id)} FOR UPDATE`;
      const stats = await tx<
        { count: number; bytes: number }[]
      >`SELECT count(*)::int count,COALESCE(sum(octet_length(frame)),0)::int bytes FROM api_idempotency_events WHERE request_id=${id}`;
      const firstSequence = Math.min(...frames.map(({ sequence }) => sequence));
      const lastSequence = Math.max(...frames.map(({ sequence }) => sequence));
      const existing = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${id} AND sequence BETWEEN ${firstSequence} AND ${lastSequence} ORDER BY sequence`;
      const existingBySequence = new Map(existing.map((row) => [number(row.sequence), row]));
      const pending: ApiSseFrameInput[] = [];
      for (const item of frames) {
        const prior = existingBySequence.get(item.sequence);
        if (prior) {
          if (String(prior.frame) !== item.frame) {
            throw new DomainError("sequence_conflict", "SSE frame sequence payload differs", 409);
          }
          continue;
        }
        if (item.sequence !== stats[0].count + pending.length) {
          throw new DomainError("sequence_conflict", "SSE replay sequence is not contiguous", 409);
        }
        pending.push(item);
      }
      const pendingBytes = pending.reduce(
        (sum, item) => sum + encoder.encode(item.frame).length,
        0,
      );
      if (stats[0].count + pending.length > 10_000 || stats[0].bytes + pendingBytes > 16_777_216) {
        throw new DomainError("response_too_large", "SSE replay exceeds storage limit", 413);
      }
      const quota = replayQuota(quotaInput);
      const aggregate = await tx<
        { events: number; bytes: number }[]
      >`SELECT
        (SELECT count(*)::int FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${
        String(rows[0].user_id)
      } AND r.expires_at>now()) events,
        ((SELECT COALESCE(sum(octet_length(e.frame)),0)::bigint FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${
        String(rows[0].user_id)
      } AND r.expires_at>now()) +
         (SELECT COALESCE(sum(octet_length(response_body)),0)::bigint FROM api_idempotency_requests WHERE user_id=${
        String(rows[0].user_id)
      } AND expires_at>now())) bytes`;
      if (
        number(aggregate[0].events) + pending.length > quota.maxEvents ||
        number(aggregate[0].bytes) + pendingBytes > quota.maxBytes
      ) throw new DomainError("replay_quota_exceeded", "User replay storage quota exceeded", 429);
      if (pending.length > 0) {
        await tx`INSERT INTO api_idempotency_events ${
          tx(
            pending.map((item) => ({ request_id: id, sequence: item.sequence, frame: item.frame })),
            "request_id",
            "sequence",
            "frame",
          )
        }`;
      }
      const updated = await tx<
        Row[]
      >`UPDATE api_idempotency_requests SET lease_expires_at=now()+${leaseSeconds}*interval '1 second',observed_input_tokens=GREATEST(observed_input_tokens,${
        observation?.inputTokens ?? 0
      }),observed_output_tokens=GREATEST(observed_output_tokens,${
        observation?.outputTokens ?? 0
      }),observed_cost_micros=GREATEST(observed_cost_micros,${
        observation?.costMicros ?? 0
      }),observed_latency_ms=GREATEST(observed_latency_ms,${
        observation?.latencyMs ?? 0
      }),updated_at=now() WHERE id=${id} RETURNING *`;
      const events = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${id} ORDER BY sequence`;
      return apiRequest(updated[0], events.map(apiFrame));
    });
  }
  async heartbeatApiRequest(
    id: string,
    leaseToken: string,
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
  ) {
    const rows = await this
      .#sql`UPDATE api_idempotency_requests SET lease_expires_at=now()+${leaseSeconds}*interval '1 second',observed_input_tokens=GREATEST(observed_input_tokens,${
      observation?.inputTokens ?? 0
    }),observed_output_tokens=GREATEST(observed_output_tokens,${
      observation?.outputTokens ?? 0
    }),observed_cost_micros=GREATEST(observed_cost_micros,${
      observation?.costMicros ?? 0
    }),observed_latency_ms=GREATEST(observed_latency_ms,${
      observation?.latencyMs ?? 0
    }),updated_at=now() WHERE id=${id} AND state='in_progress' AND lease_token=${leaseToken} AND lease_expires_at>now() RETURNING id`;
    if (!rows.length) {
      throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
    }
  }
  async #completeApi(input: CompleteApiRequestInput, stream: boolean) {
    if (input.responseBody && new TextEncoder().encode(input.responseBody).length > 16_777_216) {
      throw new DomainError("response_too_large", "Replay response exceeds storage limit", 413);
    }
    return await this.#sql.begin(async (tx) => {
      const requests = await tx<
        Row[]
      >`SELECT *,lease_expires_at>now() AS lease_active FROM api_idempotency_requests WHERE id=${input.id} FOR UPDATE`;
      if (!requests[0]) throw new DomainError("not_found", "Idempotent request not found", 404);
      const row = requests[0];
      if (row.state === "completed") {
        if (
          number(row.response_status) !== input.responseStatus ||
          String(row.response_body ?? "") !== (input.responseBody ?? "")
        ) throw new DomainError("idempotency_conflict", "Completion replay payload differs", 409);
        const events = await tx<
          Row[]
        >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} ORDER BY sequence`;
        return apiRequest(row, events.map(apiFrame));
      }
      if (
        row.state !== "in_progress" || String(row.lease_token) !== input.leaseToken ||
        row.lease_active !== true
      ) {
        throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
      }
      if (!stream && input.frames?.length) {
        throw new DomainError("validation_error", "JSON completion cannot include SSE frames", 422);
      }
      const encoder = new TextEncoder();
      const stats = await tx<
        { count: number; bytes: number }[]
      >`SELECT count(*)::int count,COALESCE(sum(octet_length(frame)),0)::int bytes FROM api_idempotency_events WHERE request_id=${input.id}`;
      const frameInputs = input.frames ?? [];
      if (frameInputs.some(({ frame }) => encoder.encode(frame).length > 1_048_576)) {
        throw new DomainError("response_too_large", "SSE frame exceeds replay limit", 413);
      }
      const existingBySequence = new Map<number, Row>();
      if (frameInputs.length > 0) {
        const first = Math.min(...frameInputs.map(({ sequence }) => sequence));
        const last = Math.max(...frameInputs.map(({ sequence }) => sequence));
        const existing = await tx<
          Row[]
        >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} AND sequence BETWEEN ${first} AND ${last}`;
        for (const event of existing) existingBySequence.set(number(event.sequence), event);
      }
      const pending: ApiSseFrameInput[] = [];
      for (const item of frameInputs) {
        const prior = existingBySequence.get(item.sequence);
        if (prior) {
          if (String(prior.frame) !== item.frame) {
            throw new DomainError("sequence_conflict", "SSE frame sequence payload differs", 409);
          }
          continue;
        }
        if (item.sequence !== stats[0].count + pending.length) {
          throw new DomainError("sequence_conflict", "SSE replay sequence is not contiguous", 409);
        }
        pending.push(item);
      }
      const pendingBytes = pending.reduce(
        (sum, item) => sum + encoder.encode(item.frame).length,
        0,
      );
      const terminalBytes = input.terminalFrame ? encoder.encode(input.terminalFrame).length : 0;
      if (terminalBytes > 1_048_576) {
        throw new DomainError("response_too_large", "Terminal SSE frame exceeds replay limit", 413);
      }
      if (
        stats[0].count + pending.length + (input.terminalFrame ? 1 : 0) > 10_000 ||
        stats[0].bytes + pendingBytes + terminalBytes > 16_777_216
      ) throw new DomainError("response_too_large", "SSE replay exceeds storage limit", 413);
      const quota = replayQuota(input.quota);
      await tx`SELECT id FROM users WHERE id=${String(row.user_id)} FOR UPDATE`;
      const aggregate = await tx<
        { events: number; bytes: number }[]
      >`SELECT
        (SELECT count(*)::int FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${
        String(row.user_id)
      } AND r.expires_at>now()) events,
        ((SELECT COALESCE(sum(octet_length(e.frame)),0)::bigint FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${
        String(row.user_id)
      } AND r.expires_at>now()) +
         (SELECT COALESCE(sum(octet_length(response_body)),0)::bigint FROM api_idempotency_requests WHERE user_id=${
        String(row.user_id)
      } AND expires_at>now())) bytes`;
      const responseBytes = input.responseBody
        ? new TextEncoder().encode(input.responseBody).length
        : 0;
      if (
        number(aggregate[0].events) + pending.length + (input.terminalFrame ? 1 : 0) >
          quota.maxEvents ||
        number(aggregate[0].bytes) + responseBytes + pendingBytes + terminalBytes > quota.maxBytes
      ) throw new DomainError("replay_quota_exceeded", "User replay storage quota exceeded", 429);
      const completingFrames = [...pending];
      if (stream && input.terminalFrame !== undefined) {
        completingFrames.push({
          sequence: stats[0].count + pending.length,
          frame: input.terminalFrame,
        });
      }
      if (completingFrames.length > 0) {
        await tx`INSERT INTO api_idempotency_events ${
          tx(
            completingFrames.map((item) => ({
              request_id: input.id,
              sequence: item.sequence,
              frame: item.frame,
            })),
            "request_id",
            "sequence",
            "frame",
          )
        }`;
      }
      const runs = await tx<Row[]>`SELECT *,EXISTS(SELECT 1 FROM provider_attempts
        WHERE usage_run_id=usage_runs.id AND status='running') AS provider_accounting_uncertain
        FROM usage_runs WHERE id=${String(row.usage_run_id)} FOR UPDATE`;
      if (!runs[0]) throw new DomainError("not_found", "Usage reservation not found", 404);
      if (runs[0].status === "reserved") {
        const providerExecution = number(runs[0].execution_epoch) > 0;
        const effectiveCost = providerExecution
          ? runs[0].provider_accounting_uncertain === true
            ? number(runs[0].reserved_micros)
            : number(runs[0].actual_provider_cost_micros)
          : input.costMicros;
        const effectiveInputTokens = providerExecution
          ? number(runs[0].actual_provider_input_tokens)
          : input.inputTokens;
        const effectiveOutputTokens = providerExecution
          ? number(runs[0].actual_provider_output_tokens)
          : input.outputTokens;
        if (providerExecution && runs[0].provider_accounting_uncertain === true) {
          await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
            error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
            latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
            completed_at=now() WHERE usage_run_id=${String(row.usage_run_id)} AND status='running'`;
        }
        const reserved = number(runs[0].reserved_micros);
        const delta = reserved - effectiveCost;
        const userId = String(row.user_id);
        const users = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        const after = number(users[0].balance_micros) + delta;
        if (after < 0) {
          throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
        }
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        if (delta !== 0) {
          await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
            String(row.usage_run_id)
          },${delta > 0 ? "refund" : "settle"},${delta},${after})`;
        }
        await tx`UPDATE usage_runs SET status='completed',cost_micros=${effectiveCost},input_tokens=${effectiveInputTokens},output_tokens=${effectiveOutputTokens},latency_ms=${input.latencyMs},run_lease_token=NULL,run_lease_expires_at=NULL,completed_at=now() WHERE id=${
          String(row.usage_run_id)
        }`;
      } else if (runs[0].status !== "completed") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      const updated = await tx<
        Row[]
      >`UPDATE api_idempotency_requests SET state='completed',lease_token=NULL,lease_expires_at=NULL,response_status=${input.responseStatus},response_headers=${
        tx.json((input.responseHeaders ?? {}) as postgres.JSONValue)
      },response_body=${
        input.responseBody ?? null
      },completed_at=now(),updated_at=now(),expires_at=now()+retention_seconds*interval '1 second' WHERE id=${input.id} RETURNING *`;
      const events = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} ORDER BY sequence`;
      return apiRequest(updated[0], events.map(apiFrame));
    });
  }
  completeApiJson(input: CompleteApiRequestInput) {
    return this.#completeApi(input, false);
  }
  completeApiStream(input: CompleteApiRequestInput) {
    return this.#completeApi(input, true);
  }
  async failApiRequest(input: FailApiRequestInput) {
    if (new TextEncoder().encode(input.responseBody).length > 16_777_216) {
      throw new DomainError("response_too_large", "Replay response exceeds storage limit", 413);
    }
    return await this.#sql.begin(async (tx) => {
      const requests = await tx<
        Row[]
      >`SELECT *,lease_expires_at>now() AS lease_active FROM api_idempotency_requests WHERE id=${input.id} FOR UPDATE`;
      if (!requests[0]) throw new DomainError("not_found", "Idempotent request not found", 404);
      const row = requests[0];
      if (row.state === "failed") {
        const events = await tx<
          Row[]
        >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} ORDER BY sequence`;
        return apiRequest(row, events.map(apiFrame));
      }
      if (
        row.state !== "in_progress" || String(row.lease_token) !== input.leaseToken ||
        row.lease_active !== true
      ) {
        throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
      }
      let eventCount = 0;
      const stats = await tx<
        { count: number; bytes: number }[]
      >`SELECT count(*)::int count,COALESCE(sum(octet_length(frame)),0)::int bytes FROM api_idempotency_events WHERE request_id=${input.id}`;
      eventCount = stats[0].count;
      const failureStartedStream = eventCount > 0 || input.terminalFrame !== undefined;
      if (input.terminalFrame !== undefined) {
        const terminalBytes = new TextEncoder().encode(input.terminalFrame).length;
        if (terminalBytes > 1_048_576 || stats[0].bytes + terminalBytes > 16_777_216) {
          throw new DomainError(
            "response_too_large",
            "Terminal SSE frame exceeds replay limit",
            413,
          );
        }
        await tx`INSERT INTO api_idempotency_events(request_id,sequence,frame) VALUES(${input.id},${eventCount},${input.terminalFrame})`;
        eventCount++;
      }
      const runs = await tx<Row[]>`SELECT *,EXISTS(SELECT 1 FROM provider_attempts
        WHERE usage_run_id=usage_runs.id AND status='running') AS provider_accounting_uncertain
        FROM usage_runs WHERE id=${String(row.usage_run_id)} FOR UPDATE`;
      if (runs[0]?.status === "reserved") {
        const userId = String(row.user_id);
        const users = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        const providerExecution = number(runs[0].execution_epoch) > 0;
        if (providerExecution || input.billing.mode === "refund") {
          const effectiveCost = providerExecution
            ? runs[0].provider_accounting_uncertain === true
              ? number(runs[0].reserved_micros)
              : number(runs[0].actual_provider_cost_micros)
            : 0;
          if (providerExecution && runs[0].provider_accounting_uncertain === true) {
            await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
              error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
              latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
              completed_at=now() WHERE usage_run_id=${
              String(row.usage_run_id)
            } AND status='running'`;
          }
          const amount = number(runs[0].reserved_micros) - effectiveCost;
          const after = number(users[0].balance_micros) + amount;
          await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
          if (amount !== 0) {
            await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
              String(row.usage_run_id)
            },${amount > 0 ? "refund" : "settle"},${amount},${after})`;
          }
          await tx`UPDATE usage_runs SET status='failed',cost_micros=${effectiveCost},input_tokens=${
            providerExecution ? number(runs[0].actual_provider_input_tokens) : 0
          },output_tokens=${
            providerExecution ? number(runs[0].actual_provider_output_tokens) : 0
          },run_lease_token=NULL,run_lease_expires_at=NULL,error='idempotent request failed',completed_at=now() WHERE id=${
            String(row.usage_run_id)
          }`;
        } else {
          const delta = number(runs[0].reserved_micros) - input.billing.costMicros;
          const after = number(users[0].balance_micros) + delta;
          if (after < 0) {
            throw new DomainError(
              "insufficient_credit",
              "Actual cost exceeds available credit",
              402,
            );
          }
          await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
          if (delta !== 0) {
            await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
              String(row.usage_run_id)
            },${delta > 0 ? "refund" : "settle"},${delta},${after})`;
          }
          await tx`UPDATE usage_runs SET status='completed',cost_micros=${input.billing.costMicros},input_tokens=${input.billing.inputTokens},output_tokens=${input.billing.outputTokens},latency_ms=${input.billing.latencyMs},error='request failed after partial usage',completed_at=now() WHERE id=${
            String(row.usage_run_id)
          }`;
        }
      }
      const updated = await tx<
        Row[]
      >`UPDATE api_idempotency_requests SET state='failed',lease_token=NULL,lease_expires_at=NULL,response_status=${input.responseStatus},response_headers=${
        tx.json((input.responseHeaders ?? {}) as postgres.JSONValue)
      },response_body=${input.responseBody},failure_started_stream=${failureStartedStream},completed_at=now(),updated_at=now(),expires_at=now()+retention_seconds*interval '1 second' WHERE id=${input.id} RETURNING *`;
      const events = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} ORDER BY sequence`;
      return apiRequest(updated[0], events.map(apiFrame));
    });
  }
  async reapStaleApiRequests(limit = 100) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_requests WHERE state='in_progress' AND lease_expires_at<=now() ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      for (const row of rows) {
        const id = String(row.id);
        const runs = await tx<Row[]>`SELECT *,EXISTS(SELECT 1 FROM provider_attempts
          WHERE usage_run_id=usage_runs.id AND status='running') AS provider_accounting_uncertain
          FROM usage_runs WHERE id=${String(row.usage_run_id)} FOR UPDATE`;
        if (runs[0]?.status === "reserved") {
          await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
            error_code='api_lease_expired',breaker_after='unavailable',retryable=true,
            latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
            completed_at=now() WHERE usage_run_id=${String(row.usage_run_id)} AND status='running'`;
          const userId = String(row.user_id);
          const users = await tx<
            Row[]
          >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
          const reserved = number(runs[0].reserved_micros);
          const providerExecution = number(runs[0].execution_epoch) > 0;
          const effectiveCost = providerExecution
            ? runs[0].provider_accounting_uncertain === true
              ? number(runs[0].reserved_micros)
              : number(runs[0].actual_provider_cost_micros)
            : number(row.observed_cost_micros);
          const delta = reserved - effectiveCost;
          const after = number(users[0].balance_micros) + delta;
          if (after < 0) {
            throw new DomainError(
              "insufficient_credit",
              "Observed cost exceeds available credit",
              402,
            );
          }
          await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
          if (delta !== 0) {
            await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
              String(row.usage_run_id)
            },${delta > 0 ? "refund" : "settle"},${delta},${after})`;
          }
          await tx`UPDATE usage_runs SET status='failed',cost_micros=${effectiveCost},input_tokens=${
            providerExecution
              ? number(runs[0].actual_provider_input_tokens)
              : number(row.observed_input_tokens)
          },output_tokens=${
            providerExecution
              ? number(runs[0].actual_provider_output_tokens)
              : number(row.observed_output_tokens)
          },latency_ms=${
            number(row.observed_latency_ms)
          },run_lease_token=NULL,run_lease_expires_at=NULL,error=${
            effectiveCost > 0
              ? "request lease expired after partial usage"
              : "request lease expired"
          },completed_at=now() WHERE id=${String(row.usage_run_id)}`;
        }
        const stats = await tx<
          { count: number }[]
        >`SELECT count(*)::int count FROM api_idempotency_events WHERE request_id=${id}`;
        const errorBody = JSON.stringify({
          error: {
            message: "Request interrupted before completion",
            type: "server_error",
            param: null,
            code: "request_abandoned",
          },
        });
        if (stats[0].count > 0) {
          const frame = row.endpoint === "responses"
            ? `event: error\ndata: ${errorBody}\n\n`
            : `data: ${errorBody}\n\n`;
          await tx`INSERT INTO api_idempotency_events(request_id,sequence,frame) VALUES(${id},${
            stats[0].count
          },${frame})`;
        }
        await tx`UPDATE api_idempotency_requests SET state='failed',lease_token=NULL,lease_expires_at=NULL,response_status=500,response_headers='{"content-type":"application/json"}'::jsonb,response_body=${errorBody},failure_started_stream=${
          stats[0].count > 0
        },completed_at=now(),updated_at=now(),expires_at=now()+retention_seconds*interval '1 second' WHERE id=${id}`;
      }
      return rows.length;
    });
  }
  async pruneExpiredApiRequests(limit = 100) {
    const rows = await this
      .#sql`WITH doomed AS (SELECT id FROM api_idempotency_requests WHERE state<>'in_progress' AND expires_at<=now() ORDER BY expires_at LIMIT ${limit}) DELETE FROM api_idempotency_requests r USING doomed WHERE r.id=doomed.id RETURNING r.id`;
    return rows.length;
  }
  async usage(userId: string) {
    const rows = await this.#sql<
      Row[]
    >`SELECT u.balance_micros,count(r.id) FILTER(WHERE r.status='completed')::int calls,COALESCE(sum(r.input_tokens) FILTER(WHERE r.status='completed'),0)::bigint input_tokens,COALESCE(sum(r.output_tokens) FILTER(WHERE r.status='completed'),0)::bigint output_tokens,COALESCE(sum(r.cost_micros) FILTER(WHERE r.status='completed'),0)::bigint spent_micros FROM users u LEFT JOIN usage_runs r ON r.user_id=u.id WHERE u.id=${userId} GROUP BY u.id`;
    if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
    return {
      balanceMicros: number(rows[0].balance_micros),
      calls: number(rows[0].calls),
      inputTokens: number(rows[0].input_tokens),
      outputTokens: number(rows[0].output_tokens),
      spentMicros: number(rows[0].spent_micros),
    };
  }
  async listLedger(userId: string): Promise<LedgerEntry[]> {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM ledger_entries WHERE user_id=${userId} ORDER BY created_at,id`).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      usageRunId: String(row.usage_run_id),
      kind: row.kind as LedgerEntry["kind"],
      amountMicros: number(row.amount_micros),
      balanceAfterMicros: number(row.balance_after_micros),
      createdAt: iso(row.created_at),
    }));
  }
  async enqueueJob(type: string, payload: unknown, availableAt?: string) {
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO jobs(type,payload,available_at) VALUES(${type},${
      this.#sql.json(payload as postgres.JSONValue)
    },${availableAt ?? new Date().toISOString()}) RETURNING id`;
    return String(rows[0].id);
  }
  async adminSummary() {
    const totals = await this.#sql<
      Row[]
    >`SELECT (SELECT count(*)::int FROM usage_runs) calls,(SELECT count(*)::int FROM users) users,COALESCE((SELECT sum(balance_micros) FROM users),0)::bigint balance_micros`;
    return {
      calls: number(totals[0].calls),
      users: number(totals[0].users),
      balanceMicros: number(totals[0].balance_micros),
      ledger: await this.listAllLedger(),
    };
  }
  private async listAllLedger(): Promise<LedgerEntry[]> {
    return (await this.#sql<Row[]>`SELECT * FROM ledger_entries ORDER BY created_at,id`).map((
      row,
    ) => ({
      id: String(row.id),
      userId: String(row.user_id),
      usageRunId: String(row.usage_run_id),
      kind: row.kind as LedgerEntry["kind"],
      amountMicros: number(row.amount_micros),
      balanceAfterMicros: number(row.balance_after_micros),
      createdAt: iso(row.created_at),
    }));
  }
  async listJobs() {
    return (await this.#sql<Row[]>`SELECT * FROM jobs ORDER BY created_at DESC`).map((row) => ({
      id: String(row.id),
      type: String(row.type),
      payload: row.payload,
      status: String(row.status),
      attempts: number(row.attempts),
      createdAt: iso(row.created_at),
    }));
  }
  async readiness() {
    try {
      await this.#sql`SELECT 1`;
      return { ready: true, storage: this.storageKind };
    } catch {
      return { ready: false, storage: this.storageKind };
    }
  }
}
