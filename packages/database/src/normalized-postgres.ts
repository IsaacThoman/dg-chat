import postgres from "npm:postgres@3.4.7";
import {
  isModelCapability,
  parseConversationPortabilityV1,
  parsePublicConversationShare,
} from "@dg-chat/contracts";
import type {
  AdminApiTokenPage,
  AdminApiTokenQuery,
  AdminApiTokenRevocationCommand,
  AdminAttachmentPage,
  AdminAttachmentQuery,
  AdminAttachmentSummary,
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
  AttachmentStorageUsage,
  CommunityProfile,
  ConversationFolder,
  ConversationFolderMembership,
  ConversationPortabilityV1,
  ConversationSearchPage,
  ConversationSearchQuery,
  ConversationSearchResult,
  ConversationShareSummary,
  ConversationTag,
  ConversationTagBinding,
  ConversationTagSet,
  MessageNode,
  ModelCapability,
  PublicConversationShare,
  PublicConversationShareAttachment,
  PublicUser,
  UserPreferences,
} from "@dg-chat/contracts";
import { DomainError } from "./memory.ts";
import { INGESTIBLE_DOCUMENT_MIME_TYPES, isIngestibleDocumentMime } from "./attachment-policy.ts";
import { canonicalJson, sha256Hex } from "./backup-format.ts";
import {
  providerCustomParamsViolation,
  providerDefaultsViolation,
  providerModelOcrGraphViolation,
  providerOcrTargetProviderViolation,
} from "./provider-model-invariants.ts";
import {
  API_SSE_REPLAY_FRAGMENT_MAX_BYTES,
  API_SSE_REPLAY_REQUEST_MAX_BYTES,
  API_SSE_REPLAY_REQUEST_MAX_EVENTS,
  apiResponseBodyByteLength,
  applyCommunityProfilePatch,
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  attachmentReinspectionEligibility,
  canonicalWorkspaceName,
  CONVERSATION_SEARCH_APPLICATION_NAME,
  CONVERSATION_SEARCH_POOL_MAX,
  CONVERSATION_SEARCH_QUERY_VALIDATION_MESSAGE,
  CONVERSATION_SEARCH_STATEMENT_TIMEOUT_MS,
  conversationSearchSnippet,
  decodeAdminAttachmentCursor,
  decodeConversationSearchCursor,
  DEFAULT_API_REPLAY_QUOTA,
  encodeAdminAttachmentCursor,
  encodeConversationSearchCursor,
  isCanonicalFileUploadObjectKey,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  MAX_ACTIVE_CONVERSATION_SHARES,
  MAX_CONVERSATION_SHARE_ATTACHMENTS,
  MAX_CONVERSATION_SHARE_CONTENT_CHARS,
  MAX_CONVERSATION_SHARE_MESSAGES,
  modelAccessWideningAcknowledgementMatches,
  normalizeKnowledgeSearchLimit,
  planAbandonedApiReplay,
  splitApiSseReplayFrame,
  validateChunkEmbeddings,
  validateDocumentChunkInputs,
  validConversationSearchScopeId,
  validConversationSearchTerm,
} from "./repository.ts";
import type { LedgerEntry, StoredApiToken, StoredSession, StoredUser, UsageRun } from "./memory.ts";
import type {
  AccessGroup,
  AccessGroupPolicyImpact,
  AccessGroupPolicyProposal,
  AdminAnalytics,
  AdminAnalyticsDistribution,
  AdminAnalyticsQuery,
  AdminApprovalCommand,
  AdminDeletionCommand,
  AdminJobPage,
  AdminJobQuery,
  AdminJobStatus,
  AdminJobSummary,
  AdminRoleCommand,
  AdminStateCommand,
  AdminTokenLookupPage,
  AdminWorkerInstance,
  AdminWorkerPage,
  AdminWorkerQuery,
  ApiIdempotencyEndpoint,
  ApiIdempotencyFrame,
  ApiIdempotencyRequest,
  ApiReplayQuota,
  ApiSseFrameInput,
  ApiUsageObservation,
  AppendMessageInput,
  AttachmentListQuery,
  AttachmentPage,
  AttachmentRecord,
  AttachmentReinspectionResult,
  AttachmentState,
  AttachmentStorageQuota,
  AttachmentUploadStage,
  AuditEvent,
  AuditEventInput,
  AuditPage,
  AuditQuery,
  BeginApiRequestInput,
  BeginApiRequestResult,
  BeginAssistantGenerationInput,
  BeginGenerationInput,
  CommunityLeaderboardReadQuery,
  CommunityLeaderboardRepositoryPage,
  CommunityProfileMutationContext,
  CommunityProfilePatch,
  CompleteApiRequestInput,
  CompleteGenerationInput,
  ConversationPatch,
  ConversationPortabilityExportOptions,
  ConversationPortabilityImportResult,
  ConversationShareAttachmentAccess,
  CreateAccessGroupInput,
  CreateApiTokenInput,
  CreateAttachmentInput,
  CreateAttachmentResult,
  CreateConversationShareInput,
  CreateConversationShareResult,
  CreateKnowledgeCollectionInput,
  CreateModelAliasInput,
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
  EnqueueRetentionScrubInput,
  EnsureIdempotentReservationInput,
  EnsureUsageReservationInput,
  EntitledProviderModel,
  FailApiRequestInput,
  FailGenerationInput,
  FileUploadStage,
  FinalizeEmbeddingProviderUsageInput,
  FinalizeFileUploadInput,
  FinalizeFileUploadResult,
  FinalizeGeneratedAssetsInput,
  FinalizeProviderUsageInput,
  FinishEmbeddingProviderAttemptInput,
  FinishProviderAttemptInput,
  GeneratedAssetRecord,
  GeneratedObjectStage,
  IdentityTokenPurpose,
  KnowledgeCollection,
  KnowledgeCollectionPatch,
  KnowledgeConversationBinding,
  KnowledgeRetrievalMode,
  KnowledgeSearchHit,
  LifecycleConversation,
  ModelAlias,
  ModelPriceVersion,
  PrivilegedAuditEventInput,
  PrivilegedReadContext,
  ProviderAttempt,
  ProviderCredentialEnvelope,
  ProviderCredentialMutation,
  ProviderExecutionClaim,
  ProviderExecutionPlan,
  ProviderModelRecord,
  ProviderModelRoute,
  ProviderPayloadCapture,
  ProviderPayloadCaptureInput,
  ProviderRecord,
  ProviderRetryPolicy,
  PurgeTemporaryConversationsInput,
  RegistryMutationContext,
  ReplaceAccessGroupPolicyInput,
  ReplaceConversationKnowledgeInput,
  RequestAttachmentReinspectionInput,
  ReserveChildProviderUsageInput,
  RetentionPolicy,
  RetentionPreview,
  RetentionScheduleResult,
  RetentionScrubBatchResult,
  RetentionScrubFailureCode,
  RetentionScrubPage,
  RetentionScrubQuery,
  RetentionScrubRun,
  RotateApiTokenInput,
  RotatedApiToken,
  ScheduleRetentionScrubInput,
  SearchConversationKnowledgeInput,
  SessionSummary,
  SetProviderModelRouteInput,
  StageAttachmentUploadInput,
  StageFileUploadInput,
  StageGeneratedObjectInput,
  StartProviderAttemptInput,
  StoredProviderCredential,
  TokenAccessSubject,
  TransitionAttachmentInspectionInput,
  UpdateAccessGroupInput,
  UpdateApiTokenInput,
  UpdateModelAliasInput,
  UpdateProviderInput,
  UpdateProviderModelInput,
  UpdateProviderRetryPolicyInput,
  UpdateRetentionPolicyInput,
  UsagePricingSnapshot,
} from "./repository.ts";
import {
  decodeAdminResourceCursor,
  decodeAdminUserCursor,
  decodeAuditCursor,
  encodeAdminResourceCursor,
  encodeAdminUserCursor,
  encodeAuditPostgresCursor,
  isUsagePricingSnapshot,
  sameGeneratedAssetFinalization,
  usagePricingSnapshotsEqual,
  validateCommunityLeaderboardReadQuery,
  validateGeneratedAssetFinalization,
} from "./repository.ts";

type Row = Record<string, unknown>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const nullableIso = (value: unknown) => value == null ? null : iso(value);
const number = (value: unknown) => Number(value);

function requirePrivilegedAuditContext(
  audit: PrivilegedAuditEventInput | undefined,
): asserts audit is PrivilegedAuditEventInput {
  if (
    !audit ||
    typeof audit.actorId !== "string" || audit.actorId.trim() === "" ||
    typeof audit.action !== "string" || audit.action.trim() === "" ||
    typeof audit.targetType !== "string" || audit.targetType.trim() === "" ||
    typeof audit.requireEmailVerification !== "boolean" ||
    !Number.isSafeInteger(audit.expectedAuthorityEpoch) ||
    audit.expectedAuthorityEpoch < 1
  ) {
    throw new DomainError(
      "admin_authority_required",
      "Privileged mutation context is required",
      403,
    );
  }
}

function requirePrivilegedReadContext(
  context: PrivilegedReadContext | undefined,
): asserts context is PrivilegedReadContext {
  if (
    !context ||
    typeof context.actorId !== "string" || context.actorId.trim() === "" ||
    typeof context.requireEmailVerification !== "boolean" ||
    !Number.isSafeInteger(context.expectedAuthorityEpoch) ||
    context.expectedAuthorityEpoch < 1
  ) {
    throw new DomainError(
      "admin_authority_required",
      "Privileged read context is required",
      403,
    );
  }
}

const isEffectiveAdminRow = (row: Row, requireEmailVerification = false): boolean =>
  row.role === "admin" && row.approval_status === "approved" && row.state === "active" &&
  row.deleted_at == null && row.password_reset_pending === false &&
  (!requireEmailVerification || row.email_verified_at != null);

function adminUser(row: Row): AdminUser {
  const stored = user(row);
  return { ...publicUser(stored), effectiveAdmin: isEffectiveAdminRow(row) };
}

function validateAdminCommand(
  input: {
    expectedVersion: number;
    expectedAuthorityEpoch?: number;
    reason?: string;
  },
  reasonRequired = false,
  authorityEpochRequired = false,
): string | undefined {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new DomainError("validation_error", "Expected version must be a positive integer", 422);
  }
  if (
    (authorityEpochRequired || input.expectedAuthorityEpoch !== undefined) &&
    (!Number.isSafeInteger(input.expectedAuthorityEpoch) ||
      (input.expectedAuthorityEpoch ?? 0) < 1)
  ) {
    throw new DomainError(
      "validation_error",
      "Expected authority epoch must be a positive integer",
      422,
    );
  }
  const reason = input.reason?.trim();
  if (
    (reasonRequired && !reason) || (input.reason !== undefined && (!reason || reason.length > 500))
  ) {
    throw new DomainError("validation_error", "Administrative reason is invalid", 422);
  }
  return reason || undefined;
}

function adminMutationBefore(row: Row): Record<string, unknown> {
  return {
    role: row.role,
    approvalStatus: row.approval_status,
    state: row.state,
    deleted: row.deleted_at != null,
    version: number(row.version),
  };
}

function adminMutationMetadata(
  before: Record<string, unknown>,
  row: Row,
  reason?: string,
): Record<string, unknown> {
  return {
    before,
    after: {
      role: row.role,
      approvalStatus: row.approval_status,
      state: row.state,
      deleted: row.deleted_at != null,
      version: number(row.version),
    },
    ...(reason ? { reason } : {}),
  };
}

async function lockUsersAndAssertEffectiveAdminActor(
  tx: postgres.Sql,
  actorId: string,
  userIds: readonly string[],
  requireEmailVerification = false,
  expectedAuthorityEpoch?: number,
): Promise<Row[]> {
  if (
    expectedAuthorityEpoch !== undefined &&
    (!Number.isSafeInteger(expectedAuthorityEpoch) || expectedAuthorityEpoch < 1)
  ) {
    throw new DomainError(
      "validation_error",
      "Expected authority epoch must be a positive integer",
      422,
    );
  }
  const lockIds = [...new Set([actorId, ...userIds])].sort();
  const actors = await tx<Row[]>`SELECT * FROM users
    WHERE id=ANY(${tx.array(lockIds)}::uuid[]) ORDER BY id FOR UPDATE`;
  const actor = actors.find((row) => String(row.id) === actorId);
  if (
    !actor || !isEffectiveAdminRow(actor, requireEmailVerification) ||
    expectedAuthorityEpoch !== undefined &&
      number(actor.authority_epoch) !== expectedAuthorityEpoch
  ) {
    throw new DomainError(
      "admin_authority_required",
      "Administrator authority changed before the request completed",
      403,
    );
  }
  return actors;
}

async function assertEffectiveAdminActor(
  tx: postgres.Sql,
  actorId: string,
  requireEmailVerification = false,
  expectedAuthorityEpoch?: number,
): Promise<void> {
  await lockUsersAndAssertEffectiveAdminActor(
    tx,
    actorId,
    [],
    requireEmailVerification,
    expectedAuthorityEpoch,
  );
}

async function assertPersonalTokenOwner(
  tx: postgres.TransactionSql,
  userId: string,
  expectedAuthorityEpoch: number,
  action: "update" | "revoke",
): Promise<void> {
  const users = await tx<Row[]>`SELECT approval_status,state,deleted_at,
    password_reset_pending,authority_epoch FROM users WHERE id=${userId} FOR UPDATE`;
  const user = users[0];
  if (
    !user || user.approval_status !== "approved" || user.state !== "active" ||
    user.deleted_at != null || user.password_reset_pending === true ||
    number(user.authority_epoch) !== expectedAuthorityEpoch
  ) {
    throw new DomainError(
      "account_unavailable",
      `Account cannot ${action} API tokens`,
      403,
    );
  }
}

async function invalidateFullUserAuthority(
  tx: postgres.TransactionSql,
  userId: string,
): Promise<void> {
  await tx`UPDATE users SET authority_epoch=authority_epoch+1,updated_at=now()
    WHERE id=${userId}`;
  await tx`UPDATE sessions SET invalidated_at=now()
    WHERE user_id=${userId} AND limited=false AND invalidated_at IS NULL`;
  await tx`DELETE FROM auth_sessions WHERE user_id=${userId} AND limited=false`;
  await tx`UPDATE api_tokens SET revoked_at=now(),version=version+1
    WHERE user_id=${userId} AND revoked_at IS NULL`;
  await tx`UPDATE identity_tokens SET consumed_at=now()
    WHERE user_id=${userId} AND consumed_at IS NULL`;
  await tx`DELETE FROM auth_verifications
    WHERE value=${userId} AND identifier LIKE 'reset-password:%'`;
}
const adminJob = (row: Row): AdminJobSummary => ({
  id: String(row.id),
  type: String(row.type),
  status: row.status as AdminJobStatus,
  attempts: number(row.attempts),
  availableAt: iso(row.available_at),
  lockedAt: nullableIso(row.locked_at),
  createdAt: iso(row.created_at),
  completedAt: nullableIso(row.completed_at),
  lastError: row.last_error == null ? null : String(row.last_error).slice(0, 1000),
});
const retentionPolicy = (row: Row): RetentionPolicy => ({
  version: number(row.policy_version ?? row.version),
  captureEnabled: Boolean(row.capture_enabled),
  requestBodyDays: number(row.request_body_days) as RetentionPolicy["requestBodyDays"],
  responseBodyDays: number(row.response_body_days) as RetentionPolicy["responseBodyDays"],
  updatedAt: iso(row.policy_updated_at ?? row.updated_at),
  updatedBy: row.policy_updated_by == null && row.updated_by == null
    ? null
    : String(row.policy_updated_by ?? row.updated_by),
});
const payloadCapture = (row: Row): ProviderPayloadCapture => ({
  id: String(row.id),
  usageRunId: String(row.usage_run_id),
  providerAttemptId: String(row.provider_attempt_id),
  requestBody: row.request_body == null ? null : String(row.request_body),
  responseBody: row.response_body == null ? null : String(row.response_body),
  requestBytes: number(row.request_bytes),
  responseBytes: number(row.response_bytes),
  capturedAt: iso(row.captured_at),
  scrubbedAt: nullableIso(row.scrubbed_at),
});
const retentionRun = (row: Row): RetentionScrubRun => ({
  id: String(row.id),
  idempotencyKey: String(row.idempotency_key),
  status: row.status as RetentionScrubRun["status"],
  policy: retentionPolicy(row),
  requestCutoffAt: iso(row.request_cutoff_at),
  responseCutoffAt: iso(row.response_cutoff_at),
  capturesScrubbed: number(row.captures_scrubbed),
  requestBodiesScrubbed: number(row.request_bodies_scrubbed),
  responseBodiesScrubbed: number(row.response_bodies_scrubbed),
  bytesScrubbed: number(row.bytes_scrubbed),
  createdAt: iso(row.created_at),
  startedAt: nullableIso(row.started_at),
  completedAt: nullableIso(row.completed_at),
  error: row.error == null ? null : String(row.error).slice(0, 1000),
});
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
  const value = quota ?? DEFAULT_API_REPLAY_QUOTA;
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
    passwordHash: row.password_hash == null ? null : String(row.password_hash),
    passwordResetPending: row.password_reset_pending === true,
    authorityEpoch: number(row.authority_epoch ?? 1),
    role: row.role as StoredUser["role"],
    approvalStatus: row.approval_status as StoredUser["approvalStatus"],
    state: row.state as StoredUser["state"],
    balanceMicros: number(row.balance_micros),
    emailVerifiedAt: nullableIso(row.email_verified_at),
    deletedAt: nullableIso(row.deleted_at),
    version: number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function publicUser(value: StoredUser): PublicUser {
  return {
    id: value.id,
    email: value.email,
    name: value.name,
    role: value.role,
    approvalStatus: value.approvalStatus,
    state: value.state,
    balanceMicros: value.balanceMicros,
    emailVerifiedAt: value.emailVerifiedAt,
    deletedAt: value.deletedAt,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
function conversation(row: Row): LifecycleConversation {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    title: String(row.title),
    activeLeafId: row.active_leaf_id == null ? null : String(row.active_leaf_id),
    version: number(row.version),
    pinned: Boolean(row.pinned),
    temporary: Boolean(row.temporary),
    temporaryExpiresAt: nullableIso(row.temporary_expires_at),
    archivedAt: nullableIso(row.archived_at),
    deletedAt: nullableIso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function preferences(row: Row): UserPreferences {
  return {
    userId: String(row.user_id),
    version: number(row.version),
    theme: String(row.theme) as UserPreferences["theme"],
    compactConversations: Boolean(row.compact_conversations),
    reduceMotion: Boolean(row.reduce_motion),
    customInstructions: String(row.custom_instructions),
    useMemory: Boolean(row.use_memory),
    saveHistory: Boolean(row.save_history),
    preferredModelId: row.preferred_model_id == null ? null : String(row.preferred_model_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function communityProfile(row: Row): CommunityProfile {
  return {
    userId: String(row.user_id),
    optedIn: Boolean(row.opted_in),
    identityMode: String(row.identity_mode) as CommunityProfile["identityMode"],
    nickname: row.nickname == null ? null : String(row.nickname),
    color: String(row.color) as CommunityProfile["color"],
    shareBalance: Boolean(row.share_balance),
    version: number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function folder(row: Row): ConversationFolder {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    position: number(row.position),
    version: number(row.version),
    membershipVersion: number(row.membership_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function folderMembership(row: Row): ConversationFolderMembership {
  return {
    folderId: String(row.folder_id),
    conversationId: String(row.conversation_id),
    ownerId: String(row.owner_id),
    position: number(row.position),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function conversationTag(row: Row): ConversationTag {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    color: String(row.color),
    version: number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function tagBinding(row: Row): ConversationTagBinding {
  return {
    conversationId: String(row.conversation_id),
    tagId: String(row.tag_id),
    ownerId: String(row.owner_id),
    createdAt: iso(row.created_at),
  };
}
function tagSet(row: Row): ConversationTagSet {
  return {
    conversationId: String(row.conversation_id),
    ownerId: String(row.owner_id),
    version: number(row.version),
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
function conversationShareSummary(row: Row): ConversationShareSummary {
  const snapshot = parsePublicConversationShare(row.public_snapshot);
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    leafId: String(row.leaf_id),
    conversationVersion: number(row.conversation_version),
    title: String(row.title),
    identityVisibility: String(
      row.identity_visibility,
    ) as ConversationShareSummary["identityVisibility"],
    attachmentPolicy: String(row.attachment_policy) as ConversationShareSummary["attachmentPolicy"],
    attachmentCount: snapshot.attachments.length,
    messageCount: snapshot.messages.length,
    version: number(row.version),
    createdAt: iso(row.created_at),
    expiresAt: nullableIso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
  };
}
function materializePublicConversationShare(value: unknown): PublicConversationShare {
  try {
    return parsePublicConversationShare(value);
  } catch {
    throw new DomainError(
      "conversation_not_shareable",
      "Conversation contains unsupported public data",
      422,
    );
  }
}
const CONVERSATION_SHARE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function token(row: Row): StoredApiToken {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    preview: String(row.preview),
    scopes: row.scopes as string[],
    authorityEpoch: number(row.authority_epoch ?? 1),
    version: number(row.version),
    rpmLimit: row.rpm_limit == null ? null : number(row.rpm_limit),
    burstLimit: row.burst_limit == null ? null : number(row.burst_limit),
    accessMode: row.access_mode as "inherit" | "restricted",
    rotationFamilyId: String(row.rotation_family_id),
    rotationGeneration: number(row.rotation_generation),
    rotatedFromTokenId: row.rotated_from_token_id == null
      ? null
      : String(row.rotated_from_token_id),
    replacedByTokenId: row.replaced_by_token_id == null ? null : String(row.replaced_by_token_id),
    overlapEndsAt: nullableIso(row.overlap_ends_at),
    expiresAt: nullableIso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    lastUsedAt: nullableIso(row.last_used_at),
    createdAt: iso(row.created_at),
  };
}
function tokenSummary(value: StoredApiToken) {
  const {
    tokenHash: _hash,
    userId: _userId,
    authorityEpoch: _authorityEpoch,
    ...summary
  } = value;
  return summary;
}
function adminBalanceAdjustment(row: Row, replayed: boolean): AdminBalanceAdjustment {
  return {
    id: String(row.id),
    targetUserId: String(row.target_user_id),
    actorId: String(row.actor_id),
    amountMicros: number(row.amount_micros),
    balanceBeforeMicros: number(row.balance_before_micros),
    balanceAfterMicros: number(row.balance_after_micros),
    reason: String(row.reason),
    ledgerEntryId: String(row.ledger_entry_id),
    auditEventId: String(row.audit_event_id),
    createdAt: iso(row.created_at),
    replayed,
  };
}
function validateTokenRates(rpm: number | null, burst: number | null) {
  if (
    (rpm !== null && (!Number.isInteger(rpm) || rpm < 1 || rpm > 60_000)) ||
    (burst !== null && (!Number.isInteger(burst) || burst < 1 || burst > 1_000)) ||
    (rpm !== null && burst !== null && burst > rpm)
  ) throw new DomainError("validation_error", "Token rate policy is invalid", 422);
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
    tokenId: row.token_id == null ? null : String(row.token_id),
    model: String(row.model),
    provider: String(row.provider),
    recoveryOwner: String(row.recovery_owner) as UsageRun["recoveryOwner"],
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
    requiredInspectionMode: String(
      row.required_inspection_mode ?? "local",
    ) as AttachmentRecord["requiredInspectionMode"],
    inspectionPolicyVersion: String(
      row.inspection_policy_version ?? ATTACHMENT_INSPECTION_POLICY_VERSION,
    ) as AttachmentRecord["inspectionPolicyVersion"],
    inspectionEpoch: number(row.inspection_epoch ?? 1),
    version: number(row.version ?? 1),
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
function fileUploadStage(row: Row): FileUploadStage {
  return {
    requestId: String(row.request_id),
    ownerId: String(row.owner_id),
    objectKey: String(row.object_key),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: number(row.size_bytes),
    sha256: String(row.sha256),
    purpose: String(row.purpose),
    attachmentState: row.attachment_state as FileUploadStage["attachmentState"],
    inspectionError: row.inspection_error ? String(row.inspection_error) : null,
    requiredInspectionMode: row.required_inspection_mode as FileUploadStage[
      "requiredInspectionMode"
    ],
    inspectionPolicyVersion: String(row.inspection_policy_version) as FileUploadStage[
      "inspectionPolicyVersion"
    ],
    state: row.state as FileUploadStage["state"],
    attachmentId: row.attachment_id ? String(row.attachment_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function attachmentUploadStage(row: Row): AttachmentUploadStage {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    objectKey: String(row.object_key),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: number(row.size_bytes),
    sha256: String(row.sha256),
    state: row.state as AttachmentUploadStage["state"],
    attachmentId: row.attachment_id ? String(row.attachment_id) : null,
    cleanupError: row.cleanup_error ? String(row.cleanup_error) : null,
    uploadLeaseToken: String(row.upload_lease_token),
    uploadLeaseExpiresAt: iso(row.upload_lease_expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function generatedAsset(row: Row): GeneratedAssetRecord {
  const rawInputs = Array.isArray(row.inputs) ? row.inputs as Row[] : [];
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    usageRunId: String(row.usage_run_id),
    providerModelId: String(row.provider_model_id),
    publicModelId: String(row.public_model_id),
    upstreamModelId: String(row.upstream_model_id),
    providerSlug: String(row.provider_slug),
    pricingSnapshot: {
      pricingVersionId: String(row.pricing_version_id),
      inputMicrosPerMillion: number(row.pricing_input_micros_per_million),
      cachedInputMicrosPerMillion: number(row.pricing_cached_input_micros_per_million),
      reasoningMicrosPerMillion: number(row.pricing_reasoning_micros_per_million),
      outputMicrosPerMillion: number(row.pricing_output_micros_per_million),
      fixedCallMicros: number(row.pricing_fixed_call_micros),
      source: String(row.pricing_source),
    },
    attachmentId: String(row.attachment_id),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    operation: row.operation as GeneratedAssetRecord["operation"],
    prompt: String(row.prompt),
    providerCreatedAt: number(row.provider_created_at),
    ordinal: number(row.ordinal),
    width: number(row.width),
    height: number(row.height),
    revisedPrompt: row.revised_prompt == null ? null : String(row.revised_prompt),
    inputs: rawInputs.map((value) => ({
      attachmentId: String(value.attachmentId ?? value.attachment_id),
      role: String(value.role) as GeneratedAssetRecord["inputs"][number]["role"],
      ordinal: number(value.ordinal),
      width: number(value.width),
      height: number(value.height),
      hasAlpha: value.hasAlpha == null && value.has_alpha == null
        ? null
        : Boolean(value.hasAlpha ?? value.has_alpha),
    })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: nullableIso(row.deleted_at),
  };
}
function generatedObjectStage(row: Row): GeneratedObjectStage {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    usageRunId: String(row.usage_run_id),
    ordinal: number(row.ordinal),
    purpose: String(row.purpose ?? "output") as GeneratedObjectStage["purpose"],
    objectKey: String(row.object_key),
    mimeType: String(row.mime_type),
    sizeBytes: number(row.size_bytes),
    sha256: String(row.sha256),
    attachmentId: row.attachment_id == null ? null : String(row.attachment_id),
    cleanupAttachment: row.cleanup_attachment == null ? true : Boolean(row.cleanup_attachment),
    state: String(row.state) as GeneratedObjectStage["state"],
    cleanupError: row.cleanup_error == null ? null : String(row.cleanup_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
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
export function parseStoredModelCapabilities(
  value: unknown,
  modelId = "unknown",
): ModelCapability[] {
  if (
    !Array.isArray(value) || value.length > 64 ||
    value.some((capability) => typeof capability !== "string" || !isModelCapability(capability)) ||
    new Set(value).size !== value.length
  ) {
    throw new DomainError(
      "data_integrity_error",
      `Provider model '${modelId}' contains invalid persisted capabilities; run database migrations and repair the row`,
      500,
    );
  }
  return [...value] as ModelCapability[];
}
function providerModel(row: Row): ProviderModelRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    publicModelId: String(row.public_model_id),
    upstreamModelId: String(row.upstream_model_id),
    displayName: String(row.display_name),
    capabilities: parseStoredModelCapabilities(row.capabilities, String(row.public_model_id)),
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
    const testHttp = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:" &&
      Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
    if (
      (!testHttp && url.protocol !== "https:") || url.username || url.password || url.search ||
      url.hash ||
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
      input.capabilities.some((value) => !isModelCapability(value)))
  ) throw new DomainError("validation_error", "Model capabilities are invalid", 422);
  if (input.customParams !== undefined) {
    const violation = providerCustomParamsViolation(input.customParams, input.publicModelId);
    if (violation) throw new DomainError(violation.code, violation.message, 422);
  }
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
    input.requiredInspectionMode != null &&
      !["local", "external"].includes(input.requiredInspectionMode) ||
    input.inspectionPolicyVersion != null &&
      input.inspectionPolicyVersion !== ATTACHMENT_INSPECTION_POLICY_VERSION
  ) throw new DomainError("validation_error", "Attachment inspection policy is invalid", 422);
  if (
    !input.filename || input.filename.length > 255 || /[\\/\0]/.test(input.filename) ||
    !input.mimeType || input.mimeType.length > 255 ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ||
    !input.objectKey || input.objectKey.length > 1024 || input.objectKey.startsWith("/") ||
    input.objectKey.split("/").some((part) => part === ".." || part === "")
  ) throw new DomainError("validation_error", "Attachment metadata is invalid", 422);
}

function validateAttachmentStorageQuota(quota?: AttachmentStorageQuota): void {
  if (
    quota && (
      !Number.isSafeInteger(quota.perUserBytes) || quota.perUserBytes < 0 ||
      !Number.isSafeInteger(quota.perUserObjects) || quota.perUserObjects < 0 ||
      !Number.isSafeInteger(quota.installationBytes) || quota.installationBytes < 0 ||
      !Number.isSafeInteger(quota.installationObjects) || quota.installationObjects < 0
    )
  ) throw new DomainError("validation_error", "Attachment storage quota is invalid", 422);
}

async function admitAttachmentStorage(
  tx: postgres.TransactionSql,
  input: CreateAttachmentInput,
  quota?: AttachmentStorageQuota,
): Promise<void> {
  validateAttachmentStorageQuota(quota);
  try {
    await tx`SELECT dg_chat_admit_attachment_storage(
      ${input.ownerId},${input.objectKey},${input.sizeBytes},${input.sha256},${input.mimeType},
      ${quota?.perUserBytes ?? null},${quota?.perUserObjects ?? null},
      ${quota?.installationBytes ?? null},${quota?.installationObjects ?? null}
    )`;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : "";
    if (code === "P0001" && message.includes("quota exceeded")) {
      throw new DomainError("storage_quota_exceeded", "Attachment storage quota exceeded", 413);
    }
    if (
      code === "23514" &&
      (message.includes("retained blob") || message.includes("cannot be reused"))
    ) {
      throw new DomainError(
        "attachment_object_conflict",
        "Attachment object metadata differs from retained history",
        409,
      );
    }
    throw error;
  }
}

/**
 * Every writer that makes attachment bytes durably reachable takes this row lock before writing
 * its reference. Generated-object cleanup takes the same lock before tombstoning and deleting the
 * object, so either the reference commits first and fences deletion or the writer observes the
 * tombstone. Sorting the unique IDs gives multi-attachment writers one global lock order.
 */
async function lockReferenceableAttachments(
  tx: postgres.TransactionSql,
  ownerId: string,
  attachmentIds: readonly string[],
  code: string,
  message: string,
): Promise<Row[]> {
  const ids = [...new Set(attachmentIds)].sort();
  if (!ids.length) return [];
  const rows = await tx<Row[]>`
    SELECT * FROM attachments
    WHERE owner_id=${ownerId} AND id=ANY(${ids}::uuid[])
    ORDER BY id
    FOR UPDATE`;
  if (
    rows.length !== ids.length ||
    rows.some((row) => String(row.state) !== "ready" || row.deleted_at !== null)
  ) throw new DomainError(code, message, 409);
  return rows;
}

function validateGeneratedObjectStageInput(input: StageGeneratedObjectInput) {
  if (
    !UUID_PATTERN.test(input.ownerId) || !input.usageRunId ||
    input.usageRunId.length > 200 || !Number.isSafeInteger(input.ordinal) || input.ordinal < 0 ||
    input.ordinal > 16 || !input.objectKey || input.objectKey.length > 1024 ||
    (input.purpose !== undefined && !["output", "edit_input"].includes(input.purpose)) ||
    input.objectKey.startsWith("/") ||
    input.objectKey.split("/").some((part) => !part || part === "..") ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) || input.mimeType.length > 255 ||
    !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 ||
    input.sizeBytes > 25 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(input.sha256)
  ) throw new DomainError("validation_error", "Generated object stage is invalid", 422);
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
    replayReservedBytes: number(row.replay_reserved_bytes ?? 0),
    replayReservedEvents: number(row.replay_reserved_events ?? 0),
    responseStatus: row.response_status == null ? null : number(row.response_status),
    responseHeaders: (row.response_headers ?? {}) as Record<string, string>,
    responseBody: row.response_body == null ? null : String(row.response_body),
    responseBodyEncoding: row.response_body_encoding === "base64" ? "base64" : "utf8",
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

interface CancellablePostgresQuery<T> extends PromiseLike<T> {
  cancel(): void | Promise<void>;
}

async function endPostgresPool(
  sql: ReturnType<typeof postgres>,
  timeout: number,
): Promise<void> {
  await sql.end({ timeout });
}

/**
 * Closes every distinct pool owned by a repository before reporting any failure. Keeping this
 * settlement at the repository boundary prevents a rejected driver close from being mistaken for
 * proof that shutdown completed.
 */
export async function closeOwnedPostgresPools<T extends object>(
  pools: readonly (T | undefined)[],
  timeout: number,
  closePool: (pool: T, timeout: number) => Promise<void>,
): Promise<void> {
  const uniquePools = [...new Set(pools.filter((pool): pool is T => pool !== undefined))];
  const results = await Promise.allSettled(
    uniquePools.map(async (pool) => await closePool(pool, timeout)),
  );
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Failed to close PostgreSQL pools");
}

/**
 * A search has one wall-clock deadline across scope checks and the result query. The PostgreSQL
 * startup parameter is the authoritative per-statement limit; this watchdog also bounds time spent
 * waiting for a connection in postgres.js' queue, where PostgreSQL cannot yet enforce a timeout.
 */
async function awaitConversationSearchQuery<T>(
  query: CancellablePostgresQuery<T>,
  deadlineAt: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  callerSignal?.throwIfAborted();
  let deadlineElapsed = false;
  const cancel = () => {
    try {
      void Promise.resolve(query.cancel()).catch(() => undefined);
    } catch {
      // The query may have completed between the abort event and cancellation dispatch.
    }
  };
  const remainingMs = Math.max(0, deadlineAt - performance.now());
  const deadlineTimer = setTimeout(() => {
    deadlineElapsed = true;
    cancel();
  }, remainingMs);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await query;
    // A caller cancellation always wins a same-turn race with the internal deadline.
    callerSignal?.throwIfAborted();
    if (deadlineElapsed) {
      throw new DomainError(
        "search_timeout",
        "Conversation search took too long. Try a more specific phrase.",
        503,
      );
    }
    return result;
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (deadlineElapsed || (error as { code?: string }).code === "57014") {
      throw new DomainError(
        "search_timeout",
        "Conversation search took too long. Try a more specific phrase.",
        503,
      );
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

export class PostgresRepository implements DomainRepository {
  readonly storageKind = "postgres" as const;
  readonly #sql: ReturnType<typeof postgres>;
  readonly #conversationSearchSql: ReturnType<typeof postgres>;
  private constructor(
    sql: ReturnType<typeof postgres>,
    conversationSearchSql: ReturnType<typeof postgres>,
  ) {
    this.#sql = sql;
    this.#conversationSearchSql = conversationSearchSql;
  }
  static async connect(
    url: string,
    options: {
      connectTimeoutSeconds?: number;
      statementTimeoutMs?: number;
      /** Worker processes never execute conversation search and must not reserve its pool. */
      conversationSearch?: boolean;
      poolMax?: number;
    } = {},
  ) {
    const connectTimeoutSeconds = options.connectTimeoutSeconds;
    const statementTimeoutMs = options.statementTimeoutMs;
    if (
      statementTimeoutMs !== undefined &&
      (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1 ||
        statementTimeoutMs > 2_147_483_647)
    ) throw new TypeError("PostgreSQL statement timeout is invalid");
    let sql: ReturnType<typeof postgres> | undefined;
    if (
      options.poolMax !== undefined &&
      (!Number.isSafeInteger(options.poolMax) || options.poolMax < 1 || options.poolMax > 100)
    ) throw new TypeError("PostgreSQL pool maximum is invalid");
    let conversationSearchSql: ReturnType<typeof postgres> | undefined;
    try {
      sql = postgres(url, {
        max: options.poolMax ?? 10,
        ...(connectTimeoutSeconds === undefined ? {} : { connect_timeout: connectTimeoutSeconds }),
        ...(statementTimeoutMs === undefined
          ? {}
          : { connection: { statement_timeout: statementTimeoutMs } }),
      });
      conversationSearchSql = options.conversationSearch === false ? sql : postgres(url, {
        max: CONVERSATION_SEARCH_POOL_MAX,
        connect_timeout: connectTimeoutSeconds ?? 5,
        idle_timeout: 20,
        max_lifetime: 60 * 30,
        connection: {
          application_name: CONVERSATION_SEARCH_APPLICATION_NAME,
          statement_timeout: statementTimeoutMs === undefined
            ? CONVERSATION_SEARCH_STATEMENT_TIMEOUT_MS
            : Math.min(statementTimeoutMs, CONVERSATION_SEARCH_STATEMENT_TIMEOUT_MS),
        },
      });
      await sql`SELECT 1`;
      if (conversationSearchSql !== sql) {
        await conversationSearchSql`/* dg-chat:conversation-search:connect */ SELECT 1`;
      }
      return new PostgresRepository(sql, conversationSearchSql);
    } catch (error) {
      // A failed constructor or startup connection never reaches an instance whose close() caller
      // can invoke. Attempt both closes even if one pool failed to initialize or close cleanly.
      await closeOwnedPostgresPools(
        [sql, conversationSearchSql],
        0,
        endPostgresPool,
      ).catch(() => undefined);
      throw error;
    }
  }
  async close() {
    await closeOwnedPostgresPools(
      [this.#sql, this.#conversationSearchSql],
      5,
      endPostgresPool,
    );
  }

  /** Immediately destroys owned pools. Used only by the worker's absolute shutdown watchdog. */
  async forceClose(): Promise<void> {
    await closeOwnedPostgresPools(
      [this.#sql, this.#conversationSearchSql],
      0,
      endPostgresPool,
    );
  }

  async bootstrapAdmin(input: CreateUserInput, credit: number) {
    if (!input.passwordHash) {
      throw new DomainError("validation_error", "Bootstrap requires a local password", 422);
    }
    const passwordHash = input.passwordHash;
    const id = input.id ?? crypto.randomUUID();
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-bootstrap'))`;
      const existing = await tx<Row[]>`SELECT id FROM users WHERE role = 'admin' LIMIT 1`;
      if (existing.length) {
        throw new DomainError("already_bootstrapped", "An administrator already exists", 409);
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO users (id,email,name,password_hash,role,approval_status,state,balance_micros,email_verified_at) VALUES (${id},${input.email},${input.name},null,'admin','approved','active',${credit},now()) RETURNING *`;
      const userId = String(rows[0].id);
      await tx`
        INSERT INTO auth_users(id,name,email,email_verified,created_at,updated_at)
        VALUES(${userId},${input.name},${input.email},true,now(),now())
      `;
      await tx`
        INSERT INTO auth_accounts(
          id,account_id,provider_id,user_id,password,created_at,updated_at
        ) VALUES(
          ${crypto.randomUUID()},${userId},'credential',${userId},${passwordHash},now(),now()
        )
      `;
      await tx`INSERT INTO ledger_entries (user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES (${userId},${`bootstrap:${userId}`},'grant',${credit},${credit})`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'identity.bootstrap_admin','user',${userId},'{}'::jsonb)`;
      return user(rows[0]);
    });
  }
  async createUser(input: CreateUserInput) {
    try {
      const id = input.id ?? crypto.randomUUID();
      const rows = await this.#sql<
        Row[]
      >`INSERT INTO users (id,email,name,password_hash,role,approval_status,state,email_verified_at) VALUES (${id},${input.email},${input.name},${
        input.passwordHash ?? null
      },${input.role ?? "user"},${input.approvalStatus ?? "pending"},${input.state ?? "active"},${
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
  async listAdminUsers(query: AdminUserQuery = {}): Promise<AdminUserPage> {
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("validation_error", "User limit must be between 1 and 100", 422);
    }
    const search = query.search?.trim() || undefined;
    if (search && search.length > 200) {
      throw new DomainError("validation_error", "User search is too long", 422);
    }
    const cursor = query.cursor ? decodeAdminUserCursor(query.cursor, query) : undefined;
    if (query.cursor && !cursor) {
      throw new DomainError("validation_error", "Invalid user cursor", 422);
    }
    const deletion = query.deletion ?? "present";
    const rows = await this.#sql<Row[]>`
      SELECT *,floor(extract(epoch FROM created_at)*1000000)::bigint::text AS cursor_created_at_micros
      FROM users
      WHERE (${search ?? null}::text IS NULL OR
          strpos(lower(email),lower(${search ?? null}))>0 OR
          strpos(lower(name),lower(${search ?? null}))>0)
        AND (${query.role ?? null}::text IS NULL OR role::text=${query.role ?? null})
        AND (${query.approvalStatus ?? null}::text IS NULL OR
          approval_status::text=${query.approvalStatus ?? null})
        AND (${query.state ?? null}::text IS NULL OR state::text=${query.state ?? null})
        AND (${query.emailVerified ?? null}::boolean IS NULL OR
          (email_verified_at IS NOT NULL)=${query.emailVerified ?? null})
        AND (${deletion}='all' OR (${deletion}='deleted')=(deleted_at IS NOT NULL))
        AND (
          ${cursor?.createdAt ?? null}::timestamptz IS NULL OR
          (${cursor?.createdAtMicros ?? null}::bigint IS NOT NULL AND
            (created_at,id)<(
              timestamptz 'epoch' + ${
      cursor?.createdAtMicros ?? null
    }::bigint * interval '1 microsecond',
              ${cursor?.id ?? null}::uuid
            )) OR
          (${cursor?.createdAtMicros ?? null}::bigint IS NULL AND
            (date_trunc('milliseconds',created_at),id)<(
              ${cursor?.createdAt ?? null}::timestamptz,
              ${cursor?.id ?? null}::uuid
            ))
        )
      ORDER BY created_at DESC,id DESC
      LIMIT ${limit + 1}`;
    const data = rows.slice(0, limit).map(adminUser);
    return {
      data,
      nextCursor: rows.length > limit
        ? encodeAdminUserCursor(
          {
            createdAt: data[data.length - 1].createdAt,
            id: String(rows[limit - 1].id),
          },
          query,
          String(rows[limit - 1].cursor_created_at_micros),
        )
        : null,
    };
  }
  async getAdminUser(id: string): Promise<AdminUser> {
    const rows = await this.#sql<Row[]>`SELECT * FROM users WHERE id=${id}`;
    if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
    return adminUser(rows[0]);
  }
  async createSession(
    userId: string,
    tokenHash: string,
    limited: boolean,
    expectedAuthorityEpoch = 1,
  ) {
    return await this.#sql.begin(async (tx) => {
      // Credential issuance and administrative authority loss take the same row lock. If a
      // suspension/rejection/deletion commits first, issuance observes the terminal state and
      // fails. If issuance commits first, the lifecycle transaction invalidates this session.
      const users = await tx<Row[]>`SELECT approval_status,state,deleted_at,
        password_reset_pending,authority_epoch FROM users WHERE id=${userId} FOR UPDATE`;
      const user = users[0];
      const eligible = user && user.state === "active" && user.deleted_at == null &&
        user.password_reset_pending !== true && user.approval_status !== "rejected" &&
        (limited || user.approval_status === "approved") &&
        number(user.authority_epoch) === expectedAuthorityEpoch;
      if (!eligible) {
        throw new DomainError("account_unavailable", "Account cannot create this session", 403);
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO sessions (user_id,token_hash,limited,authority_epoch,expires_at)
        VALUES (${userId},${tokenHash},${limited},${expectedAuthorityEpoch},now()+interval '30 days') RETURNING *`;
      return {
        id: String(rows[0].id),
        tokenHash: String(rows[0].token_hash),
        userId: String(rows[0].user_id),
        limited: Boolean(rows[0].limited),
        authorityEpoch: number(rows[0].authority_epoch),
        expiresAt: new Date(rows[0].expires_at as string).getTime(),
        createdAt: iso(rows[0].created_at),
        invalidatedAt: nullableIso(rows[0].invalidated_at),
      };
    });
  }
  async getSession(tokenHash: string): Promise<StoredSession | undefined> {
    const rows = await this.#sql<
      Row[]
    >`SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=${tokenHash} AND s.invalidated_at IS NULL AND s.expires_at>now()
        AND (s.limited=true OR s.authority_epoch=u.authority_epoch)`;
    return rows[0]
      ? {
        id: String(rows[0].id),
        tokenHash,
        userId: String(rows[0].user_id),
        limited: Boolean(rows[0].limited),
        authorityEpoch: number(rows[0].authority_epoch),
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
  #adminResourceQuery(
    query: { cursor?: string; limit?: number },
    resource: "sessions" | "tokens" | "ledger",
    targetUserId: string,
    fingerprint: string,
  ) {
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("validation_error", "Page limit must be between 1 and 100", 422);
    }
    const cursor = query.cursor
      ? decodeAdminResourceCursor(query.cursor, resource, targetUserId, fingerprint)
      : undefined;
    if (query.cursor && !cursor) {
      throw new DomainError("validation_error", "Invalid page cursor", 422);
    }
    return { limit, cursor };
  }
  async #adminRead<T>(
    actorId: string,
    targetUserId: string,
    read: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    const result = await this.#sql.begin(async (tx) => {
      // The actor lock prevents lifecycle mutations from revoking authority between the
      // authorization decision and the sensitive resource read.
      const actors = await tx<Row[]>`SELECT * FROM users WHERE id=${actorId} FOR SHARE`;
      if (!actors[0] || !isEffectiveAdminRow(actors[0])) {
        throw new DomainError(
          "admin_authority_required",
          "Administrator authority changed before the request completed",
          403,
        );
      }
      const targets = await tx`SELECT id FROM users WHERE id=${targetUserId} FOR SHARE`;
      if (!targets.length) throw new DomainError("not_found", "User not found", 404);
      return await read(tx);
    });
    return result as T;
  }
  async listAdminUserSessions(
    actorId: string,
    targetUserId: string,
    query: AdminSessionQuery = {},
    currentSession: AdminSessionRevocationCommand["currentSession"] = null,
  ): Promise<AdminSessionPage> {
    return await this.#adminRead(actorId, targetUserId, async (tx) => {
      const fingerprint = JSON.stringify({
        source: query.source ?? null,
        status: query.status ?? null,
      });
      const { limit, cursor } = this.#adminResourceQuery(
        query,
        "sessions",
        targetUserId,
        fingerprint,
      );
      const rows = await tx<Row[]>`
      WITH all_sessions AS (
        SELECT 'legacy'::text source,id,user_id,limited,created_at,expires_at,invalidated_at,
          NULL::text ip_address,NULL::text user_agent,
          CASE WHEN invalidated_at IS NOT NULL THEN 'revoked'
            WHEN expires_at<=now() THEN 'expired' ELSE 'active' END status,
          'legacy:'||id::text sort_id,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at
        FROM sessions WHERE user_id=${targetUserId}
        UNION ALL
        SELECT 'better_auth',id,user_id,limited,created_at,expires_at,NULL,
          ip_address,user_agent,CASE WHEN expires_at<=now() THEN 'expired' ELSE 'active' END,
          'better_auth:'||id::text,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        FROM auth_sessions WHERE user_id=${targetUserId}
      ) SELECT * FROM all_sessions
      WHERE (${query.source ?? null}::text IS NULL OR source=${query.source ?? null})
        AND (${query.status ?? null}::text IS NULL OR status=${query.status ?? null})
        AND (${cursor?.position ?? null}::text IS NULL OR
          (created_at,sort_id)<(
            ${cursor?.position ?? null}::text::timestamptz,${cursor?.id ?? null}
          ))
      ORDER BY created_at DESC,sort_id DESC LIMIT ${limit + 1}`;
      const data = rows.slice(0, limit).map((row) => ({
        id: String(row.sort_id),
        userId: String(row.user_id),
        source: row.source as "legacy" | "better_auth",
        current: currentSession !== null && currentSession.source === row.source &&
          currentSession.id === String(row.id),
        limited: Boolean(row.limited),
        status: row.status as "active" | "expired" | "revoked",
        ipAddress: row.ip_address == null ? null : String(row.ip_address),
        userAgent: row.user_agent == null ? null : String(row.user_agent),
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
        invalidatedAt: nullableIso(row.invalidated_at),
      }));
      return {
        data,
        nextCursor: rows.length > limit
          ? encodeAdminResourceCursor(
            "sessions",
            targetUserId,
            String(rows[limit - 1].cursor_created_at),
            String(rows[limit - 1].sort_id),
            fingerprint,
          )
          : null,
      };
    });
  }
  async listAdminUserTokens(
    actorId: string,
    targetUserId: string,
    query: AdminApiTokenQuery = {},
  ): Promise<AdminApiTokenPage> {
    return await this.#adminRead(actorId, targetUserId, async (tx) => {
      const fingerprint = JSON.stringify({ status: query.status ?? null });
      const { limit, cursor } = this.#adminResourceQuery(
        query,
        "tokens",
        targetUserId,
        fingerprint,
      );
      const rows = await tx<Row[]>`
      WITH token_page AS (
        SELECT t.*,
          to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at,
          COALESCE(array_agg(g.group_id::text ORDER BY g.group_id)
            FILTER(WHERE g.group_id IS NOT NULL),ARRAY[]::text[]) group_ids,
          CASE WHEN t.revoked_at IS NOT NULL THEN 'revoked'
            WHEN t.expires_at IS NOT NULL AND t.expires_at<=now() THEN 'expired'
            WHEN t.replaced_by_token_id IS NOT NULL AND t.overlap_ends_at>now() THEN 'overlap'
            WHEN t.replaced_by_token_id IS NOT NULL THEN 'replaced' ELSE 'active' END status
        FROM api_tokens t LEFT JOIN access_group_tokens g ON g.token_id=t.id
        WHERE t.user_id=${targetUserId}
        GROUP BY t.id
      ) SELECT * FROM token_page
      WHERE (${query.status ?? null}::text IS NULL OR status=${query.status ?? null})
        AND (${cursor?.position ?? null}::text IS NULL OR
          (created_at,id)<(
            ${cursor?.position ?? null}::text::timestamptz,${cursor?.id ?? null}::uuid
          ))
      ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
      const data = rows.slice(0, limit).map((row) => ({
        ...tokenSummary(token(row)),
        ownerId: targetUserId,
        groupIds: (row.group_ids as unknown[]).map(String),
        status: row.status as "active" | "overlap" | "expired" | "revoked" | "replaced",
      }));
      return {
        data,
        nextCursor: rows.length > limit
          ? encodeAdminResourceCursor(
            "tokens",
            targetUserId,
            String(rows[limit - 1].cursor_created_at),
            String(rows[limit - 1].id),
            fingerprint,
          )
          : null,
      };
    });
  }
  async listAdminUserLedger(
    actorId: string,
    targetUserId: string,
    query: AdminLedgerQuery = {},
  ): Promise<AdminLedgerPage> {
    return await this.#adminRead(actorId, targetUserId, async (tx) => {
      const fingerprint = JSON.stringify({ kind: query.kind ?? null });
      const { limit, cursor } = this.#adminResourceQuery(
        query,
        "ledger",
        targetUserId,
        fingerprint,
      );
      const rows = await tx<Row[]>`
      SELECT l.*,a.id adjustment_id,
        a.actor_id adjustment_actor_id,a.reason adjustment_reason
      FROM ledger_entries l LEFT JOIN admin_balance_adjustments a ON a.ledger_entry_id=l.id
      WHERE l.user_id=${targetUserId}
        AND (${query.kind ?? null}::text IS NULL OR l.kind::text=${query.kind ?? null})
        AND (${cursor?.position ?? null}::text IS NULL OR
          (l.sequence,l.id)<(${cursor?.position ?? null}::bigint,${cursor?.id ?? null}::uuid))
      ORDER BY l.sequence DESC,l.id DESC LIMIT ${limit + 1}`;
      const data = rows.slice(0, limit).map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        sequence: number(row.sequence),
        usageRunId: String(row.usage_run_id),
        kind: row.kind as "grant" | "reserve" | "settle" | "refund" | "adjustment",
        amountMicros: number(row.amount_micros),
        balanceAfterMicros: number(row.balance_after_micros),
        adjustment: row.adjustment_id == null ? null : {
          id: String(row.adjustment_id),
          actorId: String(row.adjustment_actor_id),
          reason: String(row.adjustment_reason),
        },
        createdAt: iso(row.created_at),
      }));
      return {
        data,
        nextCursor: rows.length > limit
          ? encodeAdminResourceCursor(
            "ledger",
            targetUserId,
            String(rows[limit - 1].sequence),
            String(rows[limit - 1].id),
            fingerprint,
          )
          : null,
      };
    });
  }
  async revokeAdminUserSession(input: AdminSessionRevocationCommand): Promise<void> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) {
      throw new DomainError("validation_error", "Administrative reason is invalid", 422);
    }
    await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(tx, input.actorId);
      const targets = await tx`SELECT id FROM users WHERE id=${input.targetUserId} FOR SHARE`;
      if (!targets.length) throw new DomainError("not_found", "User not found", 404);
      if (
        input.currentSession?.source === input.source && input.currentSession.id === input.sessionId
      ) {
        throw new DomainError(
          "current_session_protected",
          "Current session cannot be revoked",
          409,
        );
      }
      let changed: Row[];
      if (input.source === "legacy") {
        changed = await tx<Row[]>`UPDATE sessions SET invalidated_at=now()
          WHERE id=${input.sessionId} AND user_id=${input.targetUserId}
            AND invalidated_at IS NULL RETURNING id`;
      } else {
        changed = await tx<Row[]>`DELETE FROM auth_sessions
          WHERE id=${input.sessionId} AND user_id=${input.targetUserId} RETURNING id`;
      }
      if (!changed[0]) throw new DomainError("not_found", "Session not found", 404);
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${input.actorId},'user.session.revoked','session',${input.sessionId},${
        tx.json({ targetUserId: input.targetUserId, source: input.source, reason })
      })`;
    });
  }
  async revokeAdminUserTokenFamily(input: AdminApiTokenRevocationCommand): Promise<void> {
    const reason = input.reason.trim();
    if (
      !reason || reason.length > 500 || !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw new DomainError("validation_error", "Token revocation is invalid", 422);
    }
    await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(tx, input.actorId);
      const family = await tx<Row[]>`SELECT rotation_family_id FROM api_tokens
        WHERE id=${input.tokenId} AND user_id=${input.targetUserId}`;
      if (!family[0]) throw new DomainError("not_found", "Token not found", 404);
      const familyId = String(family[0].rotation_family_id);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${familyId}))`;
      const selected = await tx<Row[]>`SELECT * FROM api_tokens
        WHERE id=${input.tokenId} AND user_id=${input.targetUserId} FOR UPDATE`;
      if (!selected[0]) throw new DomainError("not_found", "Token not found", 404);
      if (number(selected[0].version) !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Token was modified", 409);
      }
      const changed = await tx`UPDATE api_tokens SET revoked_at=now(),version=version+1
        WHERE rotation_family_id=${familyId} AND revoked_at IS NULL RETURNING id`;
      if (!changed.length) {
        throw new DomainError("no_state_change", "Token family is already revoked", 409);
      }
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${input.actorId},'user.api_token_family.revoked','api_token',${input.tokenId},${
        tx.json({ targetUserId: input.targetUserId, rotationFamilyId: familyId, reason })
      })`;
    });
  }
  async adjustAdminUserBalance(
    input: AdminBalanceAdjustmentCommand,
  ): Promise<AdminBalanceAdjustment> {
    const reason = input.reason.trim();
    if (
      !reason || reason.length > 500 || !Number.isSafeInteger(input.amountMicros) ||
      input.amountMicros === 0 || !Number.isSafeInteger(input.expectedBalanceMicros) ||
      input.expectedBalanceMicros < 0 || !/^[0-9a-f]{64}$/.test(input.idempotencyKeyHash) ||
      !/^[0-9a-f]{64}$/.test(input.requestHash)
    ) {
      throw new DomainError("validation_error", "Balance adjustment is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(tx, input.actorId);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`${input.actorId}:${input.idempotencyKeyHash}`}))`;
      const prior = await tx<Row[]>`SELECT * FROM admin_balance_adjustments
        WHERE actor_id=${input.actorId} AND idempotency_key_hash=${input.idempotencyKeyHash}`;
      if (prior[0]) {
        if (String(prior[0].request_hash) !== input.requestHash) {
          throw new DomainError("idempotency_conflict", "Adjustment key was reused", 409);
        }
        return adminBalanceAdjustment(prior[0], true);
      }
      const users = await tx<Row[]>`SELECT * FROM users WHERE id=${input.targetUserId} FOR UPDATE`;
      if (!users[0]) throw new DomainError("not_found", "User not found", 404);
      const before = number(users[0].balance_micros);
      if (before !== input.expectedBalanceMicros) {
        throw new DomainError("balance_conflict", "User balance changed", 409);
      }
      const after = before + input.amountMicros;
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new DomainError(
          "validation_error",
          "Adjustment would produce an invalid balance",
          422,
        );
      }
      const adjustmentId = crypto.randomUUID();
      const ledgerId = crypto.randomUUID();
      const usageRunId = `admin-adjustment:${adjustmentId}`;
      await tx`UPDATE users SET balance_micros=${after},updated_at=now()
        WHERE id=${input.targetUserId}`;
      const ledger = await tx<Row[]>`INSERT INTO ledger_entries
        (id,user_id,usage_run_id,kind,amount_micros,balance_after_micros,metadata)
        VALUES(${ledgerId},${input.targetUserId},${usageRunId},'adjustment',${input.amountMicros},
          ${after},${tx.json({ administrative: true })}) RETURNING created_at`;
      const audits = await tx<Row[]>`INSERT INTO audit_events
        (actor_id,action,target_type,target_id,metadata)
        VALUES(${input.actorId},'user.balance.adjusted','user',${input.targetUserId},${
        tx.json({
          amountMicros: input.amountMicros,
          balanceBeforeMicros: before,
          balanceAfterMicros: after,
          reason,
          ledgerEntryId: ledgerId,
        })
      }) RETURNING id`;
      const inserted = await tx<Row[]>`INSERT INTO admin_balance_adjustments
        (id,actor_id,target_user_id,idempotency_key_hash,request_hash,amount_micros,
          balance_before_micros,balance_after_micros,reason,ledger_entry_id,audit_event_id,created_at)
        VALUES(${adjustmentId},${input.actorId},${input.targetUserId},${input.idempotencyKeyHash},
          ${input.requestHash},${input.amountMicros},${before},${after},${reason},${ledgerId},
          ${String(audits[0].id)},${iso(ledger[0].created_at)}) RETURNING *`;
      return adminBalanceAdjustment(inserted[0], false);
    });
  }
  async createIdentityToken(
    userId: string,
    purpose: IdentityTokenPurpose,
    tokenHash: string,
    expiresAt: string,
    expectedAuthorityEpoch: number,
  ) {
    const rows = await this.#sql.begin(async (tx) => {
      const users = await tx<Row[]>`SELECT authority_epoch,state,deleted_at,approval_status,
        password_reset_pending FROM users
        WHERE id=${userId} FOR UPDATE`;
      if (
        !users[0] || users[0].state !== "active" || users[0].deleted_at != null ||
        number(users[0].authority_epoch) !== expectedAuthorityEpoch ||
        (purpose === "password_reset" &&
          (users[0].approval_status === "rejected" ||
            users[0].password_reset_pending === true))
      ) throw new DomainError("account_unavailable", "Identity authority changed", 403);
      return await tx<{ user_id: string }[]>`
      INSERT INTO identity_tokens(user_id,purpose,token_hash,expires_at,authority_epoch)
      VALUES(${userId},${purpose},${tokenHash},${expiresAt},${expectedAuthorityEpoch})
      ON CONFLICT(token_hash) DO UPDATE SET token_hash=EXCLUDED.token_hash
      WHERE identity_tokens.user_id=EXCLUDED.user_id
        AND identity_tokens.purpose=EXCLUDED.purpose
        AND identity_tokens.authority_epoch=EXCLUDED.authority_epoch
        AND identity_tokens.consumed_at IS NULL
      RETURNING user_id
      `;
    });
    if (!rows[0]) {
      throw new DomainError(
        "identity_token_conflict",
        "Identity token registration conflicts with existing authority",
        409,
      );
    }
  }
  async verifyEmail(tokenHash: string) {
    return await this.#sql.begin(async (tx) => {
      const candidates = await tx<Row[]>`SELECT user_id FROM identity_tokens
        WHERE token_hash=${tokenHash} AND purpose='email_verification'`;
      if (!candidates[0]) {
        throw new DomainError(
          "invalid_identity_token",
          "Verification token is invalid or expired",
          400,
        );
      }
      const userId = String(candidates[0].user_id);
      const users = await tx<Row[]>`SELECT * FROM users WHERE id=${userId} FOR UPDATE`;
      if (!users[0] || users[0].state !== "active" || users[0].deleted_at !== null) {
        throw new DomainError(
          "invalid_identity_token",
          "Verification token is invalid or expired",
          400,
        );
      }
      const tokens = await tx<Row[]>`SELECT id FROM identity_tokens
        WHERE token_hash=${tokenHash} AND purpose='email_verification' AND user_id=${userId}
          AND authority_epoch=${number(users[0].authority_epoch)}
          AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`;
      if (!tokens[0]) {
        throw new DomainError(
          "invalid_identity_token",
          "Verification token is invalid or expired",
          400,
        );
      }
      await tx`UPDATE identity_tokens SET consumed_at=now() WHERE id=${String(tokens[0].id)}`;
      const rows = await tx<
        Row[]
      >`UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now()
        WHERE id=${userId} RETURNING *`;
      await tx`
        UPDATE auth_users SET email_verified=true,updated_at=now()
        WHERE id=${userId}
      `;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'identity.email_verified','user',${userId},'{}'::jsonb)`;
      return user(rows[0]);
    });
  }
  async markUserEmailVerified(userId: string) {
    const rows = await this.#sql<Row[]>`
      UPDATE users
      SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now()
      WHERE id=${userId} AND state='active' AND deleted_at IS NULL
      RETURNING *
    `;
    if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
    return user(rows[0]);
  }
  async resetPassword(tokenHash: string, passwordHash: string) {
    return await this.#sql.begin(async (tx) => {
      // Discover the subject without a lock, then take every durable lock in the global
      // user-before-verification order used by lifecycle invalidation.
      const candidates = await tx<Row[]>`SELECT user_id FROM identity_tokens
        WHERE token_hash=${tokenHash} AND purpose='password_reset'`;
      if (!candidates[0]) {
        throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
      }
      const userId = String(candidates[0].user_id);
      const users = await tx<Row[]>`SELECT * FROM users WHERE id=${userId} FOR UPDATE`;
      if (
        !users[0] || users[0].state !== "active" || users[0].deleted_at !== null ||
        users[0].approval_status === "rejected" ||
        users[0].password_reset_pending === true
      ) {
        throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
      }
      const tokens = await tx<Row[]>`SELECT id FROM identity_tokens
        WHERE token_hash=${tokenHash} AND purpose='password_reset' AND user_id=${userId}
          AND authority_epoch=${number(users[0].authority_epoch)}
          AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`;
      if (!tokens[0]) {
        throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
      }
      await tx`UPDATE identity_tokens SET consumed_at=now() WHERE id=${String(tokens[0].id)}`;
      const credentials = await tx`
        UPDATE auth_accounts SET password=${passwordHash},updated_at=now()
        WHERE provider_id='credential' AND account_id=${userId} AND user_id=${userId}
        RETURNING id
      `;
      if (!credentials.length) {
        throw new DomainError("credential_not_found", "Local credential is unavailable", 409);
      }
      const rows = await tx<
        Row[]
      >`UPDATE users SET password_hash=NULL,authority_epoch=authority_epoch+1,updated_at=now()
        WHERE id=${userId} RETURNING *`;
      await tx`UPDATE sessions SET invalidated_at=now() WHERE user_id=${userId} AND invalidated_at IS NULL`;
      await tx`DELETE FROM auth_sessions WHERE user_id=${userId}`;
      await tx`UPDATE api_tokens SET revoked_at=now() WHERE user_id=${userId} AND revoked_at IS NULL`;
      await tx`UPDATE identity_tokens SET consumed_at=now() WHERE user_id=${userId} AND consumed_at IS NULL`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'identity.password_reset_completed','user',${userId},'{}'::jsonb)`;
      return user(rows[0]);
    });
  }
  async resetBetterAuthPassword(token: string, passwordHash: string) {
    return await this.#sql.begin(async (tx) => {
      const identifier = `reset-password:${token}`;
      // Subject discovery is deliberately non-locking. Every authority-changing transaction
      // takes the durable user lock first, followed by the verification lock.
      const candidates = await tx<{ value: string }[]>`
        SELECT value FROM auth_verifications
        WHERE identifier=${identifier} AND expires_at>now()
      `;
      if (!candidates[0]) {
        throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
      }
      const userId = candidates[0].value;
      const users = await tx<Row[]>`SELECT * FROM users WHERE id=${userId} FOR UPDATE`;
      if (
        !users[0] || users[0].state !== "active" || users[0].deleted_at !== null ||
        users[0].approval_status === "rejected" ||
        users[0].password_reset_pending === true
      ) {
        throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
      }
      const authorityEpoch = number(users[0].authority_epoch);
      const verifications = await tx<Row[]>`
        SELECT id FROM auth_verifications
        WHERE identifier=${identifier} AND value=${userId}
          AND authority_epoch=${authorityEpoch} AND expires_at>now()
        FOR UPDATE
      `;
      if (!verifications[0]) {
        throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
      }
      const credentials = await tx`
        UPDATE auth_accounts SET password=${passwordHash},updated_at=now()
        WHERE provider_id='credential' AND account_id=${userId} AND user_id=${userId}
        RETURNING id
      `;
      if (!credentials.length) {
        throw new DomainError("credential_not_found", "Local credential is unavailable", 409);
      }
      const rows = await tx<Row[]>`
        UPDATE users SET password_hash=NULL,authority_epoch=authority_epoch+1,
          password_reset_pending=false,password_reset_token_identifier=NULL,updated_at=now()
        WHERE id=${userId} RETURNING *
      `;
      await tx`UPDATE sessions SET invalidated_at=now()
        WHERE user_id=${userId} AND invalidated_at IS NULL`;
      await tx`DELETE FROM auth_sessions WHERE user_id=${userId}`;
      await tx`UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now())
        WHERE user_id=${userId}`;
      await tx`UPDATE identity_tokens SET consumed_at=COALESCE(consumed_at,now())
        WHERE user_id=${userId}`;
      await tx`DELETE FROM auth_verifications
        WHERE value=${userId} AND identifier LIKE 'reset-password:%'`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'identity.password_reset_completed','user',${userId},'{}'::jsonb)`;
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

  async decideUserApproval(input: AdminApprovalCommand): Promise<AdminUser> {
    const reason = validateAdminCommand(input, input.status === "rejected", true);
    if (
      !Number.isSafeInteger(input.startingCreditMicros) || input.startingCreditMicros < 0 ||
      input.startingCreditMicros > 1_000_000_000
    ) throw new DomainError("validation_error", "Starting credit is invalid", 422);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await lockUsersAndAssertEffectiveAdminActor(
        tx,
        input.actorId,
        [input.targetUserId],
        input.requireEmailVerification,
        input.expectedAuthorityEpoch,
      );
      const row = rows.find((candidate) => String(candidate.id) === input.targetUserId);
      if (!row) throw new DomainError("not_found", "User not found", 404);
      if (number(row.version) !== input.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "User was modified by another administrator",
          409,
        );
      }
      if (row.approval_status === input.status) {
        throw new DomainError("no_state_change", "Approval status is unchanged", 409);
      }
      if (input.actorId === input.targetUserId && input.status === "rejected") {
        throw new DomainError("self_action_forbidden", "You cannot reject your own account", 403);
      }
      if (input.status === "approved" && input.requireEmailVerification && !row.email_verified_at) {
        throw new DomainError("email_not_verified", "Email must be verified before approval", 409);
      }
      const remainsEffective = row.role === "admin" && input.status === "approved" &&
        row.state === "active" && row.deleted_at == null && row.password_reset_pending === false &&
        (!input.requireEmailVerification || row.email_verified_at != null);
      if (isEffectiveAdminRow(row, input.requireEmailVerification) && !remainsEffective) {
        const others = await tx<{ count: number }[]>`
          SELECT count(*)::int count FROM users WHERE id<>${input.targetUserId}
            AND role='admin' AND approval_status='approved' AND state='active'
            AND deleted_at IS NULL AND password_reset_pending=false AND (${
          input.requireEmailVerification === true
        }=false OR email_verified_at IS NOT NULL)`;
        if (others[0].count === 0) {
          throw new DomainError("final_admin", "The final active administrator is protected", 409);
        }
      }
      const before = adminMutationBefore(row);
      let balance = number(row.balance_micros);
      if (input.status === "approved" && input.startingCreditMicros > 0) {
        const usageRunId = `approval:${input.targetUserId}`;
        const prior = await tx`SELECT id FROM ledger_entries
          WHERE usage_run_id=${usageRunId} AND kind='grant' LIMIT 1`;
        if (!prior.length) {
          const nextBalance = balance + input.startingCreditMicros;
          if (!Number.isSafeInteger(nextBalance)) {
            throw new DomainError(
              "validation_error",
              "Starting credit would overflow balance",
              422,
            );
          }
          await tx`INSERT INTO ledger_entries
            (user_id,usage_run_id,kind,amount_micros,balance_after_micros)
            VALUES(${input.targetUserId},${usageRunId},'grant',${input.startingCreditMicros},
              ${nextBalance})`;
          balance = nextBalance;
        }
      }
      const updated = await tx<Row[]>`UPDATE users SET approval_status=${input.status},
        balance_micros=${balance},version=version+1,updated_at=now()
        WHERE id=${input.targetUserId} RETURNING *`;
      if (input.status === "rejected") {
        await invalidateFullUserAuthority(tx, input.targetUserId);
      }
      const result = updated[0];
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${input.actorId},${`user.approval.${input.status}`},'user',${input.targetUserId},
          ${tx.json(adminMutationMetadata(before, result, reason) as postgres.JSONValue)})`;
      return adminUser(result);
    });
  }

  async setAdminUserRole(input: AdminRoleCommand): Promise<AdminUser> {
    const reason = validateAdminCommand(input, true, true);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await lockUsersAndAssertEffectiveAdminActor(
        tx,
        input.actorId,
        [input.targetUserId],
        input.requireEmailVerification,
        input.expectedAuthorityEpoch,
      );
      const row = rows.find((candidate) => String(candidate.id) === input.targetUserId);
      if (!row) throw new DomainError("not_found", "User not found", 404);
      if (number(row.version) !== input.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "User was modified by another administrator",
          409,
        );
      }
      if (row.role === input.role) {
        throw new DomainError("no_state_change", "Role is unchanged", 409);
      }
      if (input.actorId === input.targetUserId && input.role !== "admin") {
        throw new DomainError("self_action_forbidden", "You cannot demote your own account", 403);
      }
      if (
        input.role === "admin" &&
        (row.approval_status !== "approved" || row.state !== "active" ||
          row.deleted_at != null || row.password_reset_pending !== false)
      ) {
        throw new DomainError(
          "invalid_transition",
          "Only available approved users can be promoted",
          409,
        );
      }
      if (input.role === "admin" && input.requireEmailVerification && !row.email_verified_at) {
        throw new DomainError("email_not_verified", "Email must be verified before promotion", 409);
      }
      const remainsEffective = input.role === "admin" && row.approval_status === "approved" &&
        row.state === "active" && row.deleted_at == null && row.password_reset_pending === false &&
        (!input.requireEmailVerification || row.email_verified_at != null);
      if (isEffectiveAdminRow(row, input.requireEmailVerification) && !remainsEffective) {
        const others = await tx<{ count: number }[]>`
          SELECT count(*)::int count FROM users WHERE id<>${input.targetUserId}
            AND role='admin' AND approval_status='approved' AND state='active'
            AND deleted_at IS NULL AND password_reset_pending=false AND (${
          input.requireEmailVerification === true
        }=false OR email_verified_at IS NOT NULL)`;
        if (others[0].count === 0) {
          throw new DomainError("final_admin", "The final active administrator is protected", 409);
        }
      }
      const before = adminMutationBefore(row);
      const updated = await tx<Row[]>`UPDATE users SET role=${input.role},version=version+1,
        updated_at=now() WHERE id=${input.targetUserId} RETURNING *`;
      // Promotion and demotion both invalidate the privilege represented by every full
      // credential. An old user session must never become an administrator session in place.
      await invalidateFullUserAuthority(tx, input.targetUserId);
      const result = updated[0];
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${input.actorId},${`user.role.${input.role}`},'user',${input.targetUserId},
          ${tx.json(adminMutationMetadata(before, result, reason) as postgres.JSONValue)})`;
      return adminUser(result);
    });
  }

  async setAdminUserState(input: AdminStateCommand): Promise<AdminUser> {
    const reason = validateAdminCommand(input, input.state === "suspended", true);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await lockUsersAndAssertEffectiveAdminActor(
        tx,
        input.actorId,
        [input.targetUserId],
        input.requireEmailVerification,
        input.expectedAuthorityEpoch,
      );
      const row = rows.find((candidate) => String(candidate.id) === input.targetUserId);
      if (!row) throw new DomainError("not_found", "User not found", 404);
      if (number(row.version) !== input.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "User was modified by another administrator",
          409,
        );
      }
      if (row.state === input.state) {
        throw new DomainError("no_state_change", "Account state is unchanged", 409);
      }
      if (input.actorId === input.targetUserId && input.state === "suspended") {
        throw new DomainError("self_action_forbidden", "You cannot suspend your own account", 403);
      }
      const remainsEffective = row.role === "admin" && row.approval_status === "approved" &&
        input.state === "active" && row.deleted_at == null &&
        row.password_reset_pending === false &&
        (!input.requireEmailVerification || row.email_verified_at != null);
      if (isEffectiveAdminRow(row, input.requireEmailVerification) && !remainsEffective) {
        const others = await tx<{ count: number }[]>`
          SELECT count(*)::int count FROM users WHERE id<>${input.targetUserId}
            AND role='admin' AND approval_status='approved' AND state='active'
            AND deleted_at IS NULL AND password_reset_pending=false AND (${
          input.requireEmailVerification === true
        }=false OR email_verified_at IS NOT NULL)`;
        if (others[0].count === 0) {
          throw new DomainError("final_admin", "The final active administrator is protected", 409);
        }
      }
      const before = adminMutationBefore(row);
      const updated = await tx<Row[]>`UPDATE users SET state=${input.state},version=version+1,
        updated_at=now() WHERE id=${input.targetUserId} RETURNING *`;
      if (input.state === "suspended") {
        await invalidateFullUserAuthority(tx, input.targetUserId);
      }
      const result = updated[0];
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${input.actorId},${`user.state.${input.state}`},'user',${input.targetUserId},
          ${tx.json(adminMutationMetadata(before, result, reason) as postgres.JSONValue)})`;
      return adminUser(result);
    });
  }

  async setAdminUserDeleted(input: AdminDeletionCommand): Promise<AdminUser> {
    const reason = validateAdminCommand(input, true, true);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await lockUsersAndAssertEffectiveAdminActor(
        tx,
        input.actorId,
        [input.targetUserId],
        input.requireEmailVerification,
        input.expectedAuthorityEpoch,
      );
      const row = rows.find((candidate) => String(candidate.id) === input.targetUserId);
      if (!row) throw new DomainError("not_found", "User not found", 404);
      if (number(row.version) !== input.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "User was modified by another administrator",
          409,
        );
      }
      if ((row.deleted_at != null) === input.deleted) {
        throw new DomainError("no_state_change", "Deletion status is unchanged", 409);
      }
      if (input.actorId === input.targetUserId && input.deleted) {
        throw new DomainError("self_action_forbidden", "You cannot delete your own account", 403);
      }
      const remainsEffective = row.role === "admin" && row.approval_status === "approved" &&
        row.state === "active" && !input.deleted && row.password_reset_pending === false &&
        (!input.requireEmailVerification || row.email_verified_at != null);
      if (isEffectiveAdminRow(row, input.requireEmailVerification) && !remainsEffective) {
        const others = await tx<{ count: number }[]>`
          SELECT count(*)::int count FROM users WHERE id<>${input.targetUserId}
            AND role='admin' AND approval_status='approved' AND state='active'
            AND deleted_at IS NULL AND password_reset_pending=false AND (${
          input.requireEmailVerification === true
        }=false OR email_verified_at IS NOT NULL)`;
        if (others[0].count === 0) {
          throw new DomainError("final_admin", "The final active administrator is protected", 409);
        }
      }
      const before = adminMutationBefore(row);
      const updated = await tx<Row[]>`UPDATE users SET deleted_at=${
        input.deleted ? new Date() : null
      },version=version+1,updated_at=now() WHERE id=${input.targetUserId} RETURNING *`;
      if (input.deleted) {
        await invalidateFullUserAuthority(tx, input.targetUserId);
      }
      const result = updated[0];
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${input.actorId},${input.deleted ? "user.deleted" : "user.restored"},'user',
          ${input.targetUserId},
          ${tx.json(adminMutationMetadata(before, result, reason) as postgres.JSONValue)})`;
      return adminUser(result);
    });
  }

  async createConversation(
    ownerId: string,
    title: string,
    temporary = false,
    idempotencyKey?: string,
    temporaryRetentionDays = 30,
  ) {
    if (
      temporary &&
      (!Number.isInteger(temporaryRetentionDays) || temporaryRetentionDays < 1 ||
        temporaryRetentionDays > 3650)
    ) {
      throw new DomainError(
        "validation_error",
        "Temporary retention days must be between 1 and 3650",
        422,
      );
    }
    return await this.#sql.begin(async (tx) => {
      const fingerprint = JSON.stringify(
        temporary && temporaryRetentionDays !== 30
          ? { title, temporary, temporaryRetentionDays }
          : { title, temporary },
      );
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
      >`INSERT INTO conversations(owner_id,title,temporary,temporary_expires_at) VALUES(
        ${ownerId},${title},${temporary},
        CASE WHEN ${temporary} THEN now()+${temporaryRetentionDays}*interval '1 day' ELSE NULL END
      ) RETURNING *`;
      if (idempotencyKey) {
        await tx`INSERT INTO operation_idempotency(owner_id,operation,idempotency_key,payload_hash,result_id) VALUES(${ownerId},'conversation.create',${idempotencyKey},${fingerprint},${
          String(rows[0].id)
        })`;
      }
      return conversation(rows[0]);
    });
  }
  async promoteTemporaryConversation(ownerId: string, id: string, expectedVersion: number) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`UPDATE conversations
        SET temporary=false,temporary_expires_at=NULL,version=version+1,updated_at=now()
        WHERE id=${id} AND owner_id=${ownerId} AND version=${expectedVersion} AND temporary=true
        RETURNING *`;
      if (rows[0]) {
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${ownerId},'conversation.temporary_kept','conversation',${id},
            ${tx.json({ source: "temporary_lifecycle" })})`;
        return conversation(rows[0]);
      }
      const existing = await tx<Row[]>`SELECT version,temporary FROM conversations
        WHERE id=${id} AND owner_id=${ownerId}`;
      if (!existing[0]) throw new DomainError("not_found", "Conversation not found", 404);
      if (number(existing[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Conversation changed in another request", 409);
      }
      throw new DomainError("not_temporary", "Conversation is already saved", 409);
    });
  }
  async purgeExpiredTemporaryConversations(input: PurgeTemporaryConversationsInput) {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError("validation_error", "Purge limit must be between 1 and 1000", 422);
    }
    const cutoff = input.now ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(cutoff))) {
      throw new DomainError("validation_error", "Invalid purge cutoff", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const selected = input.ownerId
        ? await tx<Row[]>`SELECT id,owner_id FROM conversations
          WHERE owner_id=${input.ownerId} AND temporary=true AND temporary_expires_at<=${cutoff}
          ORDER BY temporary_expires_at,id FOR UPDATE SKIP LOCKED LIMIT ${limit}`
        : await tx<Row[]>`SELECT id,owner_id FROM conversations
          WHERE temporary=true AND temporary_expires_at<=${cutoff}
          ORDER BY temporary_expires_at,id FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      const conversationIds = selected.map((row) => String(row.id));
      if (conversationIds.length) {
        for (const row of selected) {
          await tx`DELETE FROM operation_idempotency
            WHERE owner_id=${String(row.owner_id)} AND operation='conversation.create'
              AND result_id=${String(row.id)}`;
        }
        if (input.ownerId) {
          await tx`DELETE FROM conversations WHERE owner_id=${input.ownerId}
            AND id=ANY(${conversationIds}::uuid[]) AND temporary=true
            AND temporary_expires_at<=${cutoff}`;
        } else {
          await tx`DELETE FROM conversations WHERE id=ANY(${conversationIds}::uuid[])
            AND temporary=true AND temporary_expires_at<=${cutoff}`;
        }
        for (const row of selected) {
          await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
            VALUES(NULL,'conversation.temporary_purged','conversation',${String(row.id)},
              ${tx.json({ source: "temporary_lifecycle", ownerId: String(row.owner_id) })})`;
        }
      }
      return { conversationIds };
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
  async searchConversations(
    ownerId: string,
    query: ConversationSearchQuery,
    signal?: AbortSignal,
  ): Promise<ConversationSearchPage> {
    signal?.throwIfAborted();
    const deadlineAt = performance.now() + CONVERSATION_SEARCH_STATEMENT_TIMEOUT_MS;
    const limit = query.limit ?? 25;
    const needle = query.query.trim();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("validation_error", "Search limit must be between 1 and 100", 422);
    }
    const tagIds = query.tagIds ?? [];
    if (
      !validConversationSearchTerm(query.query) ||
      !["chat", "archived", "trash"].includes(query.view) ||
      (query.folderId !== undefined && !validConversationSearchScopeId(query.folderId)) ||
      tagIds.length > 20 || new Set(tagIds).size !== tagIds.length ||
      tagIds.some((id) => !validConversationSearchScopeId(id))
    ) {
      if (!validConversationSearchTerm(query.query)) {
        throw new DomainError(
          "validation_error",
          CONVERSATION_SEARCH_QUERY_VALIDATION_MESSAGE,
          422,
        );
      }
      throw new DomainError("validation_error", "Invalid conversation search", 422);
    }
    if (query.folderId) {
      const folder = await awaitConversationSearchQuery(
        this.#conversationSearchSql<Row[]>`/* dg-chat:conversation-search:folder-scope */
          SELECT 1 FROM conversation_folders
          WHERE id=${query.folderId} AND owner_id=${ownerId}`,
        deadlineAt,
        signal,
      );
      if (!folder[0]) {
        throw new DomainError(
          "validation_error",
          query.cursor ? "Invalid conversation search cursor" : "Invalid conversation search scope",
          422,
        );
      }
    }
    if (tagIds.length) {
      const tags = await awaitConversationSearchQuery(
        this.#conversationSearchSql<Row[]>`/* dg-chat:conversation-search:tag-scope */
          SELECT count(*)::integer AS count FROM conversation_tags
          WHERE owner_id=${ownerId} AND id=ANY(${
          this.#conversationSearchSql.array(tagIds)
        }::uuid[])`,
        deadlineAt,
        signal,
      );
      if (Number(tags[0]?.count) !== tagIds.length) {
        throw new DomainError(
          "validation_error",
          query.cursor ? "Invalid conversation search cursor" : "Invalid conversation search scope",
          422,
        );
      }
    }
    const cursor = query.cursor
      ? decodeConversationSearchCursor(query.cursor, query, ownerId)
      : undefined;
    if (query.cursor && !cursor) {
      throw new DomainError("validation_error", "Invalid conversation search cursor", 422);
    }
    const cursorTimestamp = cursor?.updatedAt ?? null;
    const cursorId = cursor?.id ?? null;
    const literalPattern = `%${
      needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
    }%`;
    const rows = await awaitConversationSearchQuery(
      this.#conversationSearchSql<Row[]>`/* dg-chat:conversation-search:results */
      WITH RECURSIVE eligible_base AS (
        SELECT c.* FROM conversations c
        WHERE c.owner_id=${ownerId}
          AND (
            (${query.view}::text='chat' AND c.deleted_at IS NULL AND c.archived_at IS NULL) OR
            (${query.view}::text='archived' AND c.deleted_at IS NULL AND c.archived_at IS NOT NULL) OR
            (${query.view}::text='trash' AND c.deleted_at IS NOT NULL)
          )
          AND (${query.folderId ?? null}::uuid IS NULL OR EXISTS(
            SELECT 1 FROM conversation_folder_memberships folder_scope
            WHERE folder_scope.owner_id=${ownerId} AND folder_scope.folder_id=${
        query.folderId ?? null
      }::uuid AND folder_scope.conversation_id=c.id
          ))
          AND (${tagIds.length}=0 OR (
            SELECT count(*) FROM conversation_tag_bindings tag_scope
            WHERE tag_scope.owner_id=${ownerId} AND tag_scope.conversation_id=c.id
              AND tag_scope.tag_id=ANY(${this.#conversationSearchSql.array(tagIds)}::uuid[])
          )=${tagIds.length})
      ), matching_titles AS (
        SELECT c.id
        FROM conversations c JOIN eligible_base scoped ON scoped.id=c.id
        WHERE lower(c.title) LIKE lower(${literalPattern}) ESCAPE chr(92)
      ), searchable_messages AS (
        SELECT m.id,m.conversation_id,
          CASE WHEN m.role='user' AND jsonb_typeof(m.metadata->'authoredContent')='string'
            THEN m.metadata->>'authoredContent' ELSE m.content END AS search_content
        FROM eligible_base c JOIN messages m ON m.conversation_id=c.id
        WHERE m.role IN ('user','assistant') AND m.status<>'tombstoned'
      ), matching_messages AS (
        SELECT id,conversation_id,
          substring(search_content FROM greatest(
            1,strpos(lower(search_content),lower(${needle}))-256
          ) FOR 1024) AS search_content
        FROM searchable_messages
        WHERE lower(search_content) LIKE lower(${literalPattern}) ESCAPE chr(92)
      ), message_candidate_conversations AS (
        SELECT DISTINCT conversation_id FROM matching_messages
      ), active_path AS (
        SELECT m.id,m.conversation_id,m.parent_id,m.role,m.created_at,
          ARRAY[m.id]::uuid[] AS visited_ids
        FROM eligible_base c
        JOIN message_candidate_conversations candidate ON candidate.conversation_id=c.id
        JOIN messages m ON m.id=c.active_leaf_id AND m.conversation_id=c.id
        UNION ALL
        SELECT parent.id,parent.conversation_id,parent.parent_id,parent.role,parent.created_at,
          child.visited_ids || parent.id
        FROM active_path child JOIN messages parent
          ON parent.id=child.parent_id AND parent.conversation_id=child.conversation_id
        WHERE NOT parent.id=ANY(child.visited_ids)
      ), message_matches AS (
        SELECT DISTINCT ON (path.conversation_id)
          path.conversation_id,path.id,path.role,candidate.search_content
        FROM active_path path JOIN matching_messages candidate ON candidate.id=path.id
        ORDER BY path.conversation_id,path.created_at DESC,path.id DESC
      ), all_matches AS (
        SELECT c.*,matched.id AS search_message_id,matched.role AS search_message_role,
          matched.search_content AS search_message_content,
          (title_match.id IS NOT NULL) AS search_title_match,
          to_char(c.updated_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS search_cursor_updated_at
        FROM eligible_base c
        LEFT JOIN matching_titles title_match ON title_match.id=c.id
        LEFT JOIN message_matches matched ON matched.conversation_id=c.id
        WHERE title_match.id IS NOT NULL OR matched.id IS NOT NULL
      ), cursor_guard AS (
        SELECT ${cursorTimestamp}::text::timestamptz IS NULL OR EXISTS(
          SELECT 1 FROM all_matches cursor_match
          WHERE cursor_match.id=${cursorId}::uuid
            AND cursor_match.updated_at=${cursorTimestamp}::text::timestamptz
        ) AS valid
      ), page AS (
        SELECT * FROM all_matches candidate
        WHERE ${cursorTimestamp}::text::timestamptz IS NULL OR
          -- Cast through text so postgres.js does not coerce the ISO cursor through a
          -- millisecond-precision JavaScript Date before PostgreSQL compares it.
          (candidate.updated_at,candidate.id)<(
            ${cursorTimestamp}::text::timestamptz,${cursorId}::uuid
          )
        ORDER BY candidate.updated_at DESC,candidate.id DESC
        LIMIT ${limit + 1}
      )
      -- RIGHT JOIN deliberately emits one null page row when the page is empty. That lets the
      -- repository distinguish an ordinary final page from an invalid/stale state-bound cursor
      -- without a second statement or a race between cursor validation and the search snapshot.
      SELECT page.*,cursor_guard.valid AS search_cursor_valid
      FROM page RIGHT JOIN cursor_guard ON cursor_guard.valid
      ORDER BY page.updated_at DESC,page.id DESC NULLS LAST`,
      deadlineAt,
      signal,
    );
    signal?.throwIfAborted();
    if (rows[0]?.search_cursor_valid !== true) {
      throw new DomainError("validation_error", "Invalid conversation search cursor", 422);
    }
    const resultRows = rows.filter((row) => row.id != null);
    const hasMore = resultRows.length > limit;
    const data: ConversationSearchResult[] = resultRows.slice(0, limit).map((row) => {
      const titleMatch = Boolean(row.search_title_match);
      const base = conversation(row);
      return {
        ...base,
        snippet: conversationSearchSnippet(
          titleMatch ? base.title : String(row.search_message_content),
          needle,
        ),
        matchSource: titleMatch ? "title" : "message",
        messageId: titleMatch ? null : String(row.search_message_id),
        messageRole: titleMatch ? null : row.search_message_role as "user" | "assistant",
      };
    });
    return {
      data,
      nextCursor: hasMore
        ? encodeConversationSearchCursor(
          {
            updatedAt: String(resultRows[limit - 1].search_cursor_updated_at),
            id: String(resultRows[limit - 1].id),
          },
          query,
          ownerId,
        )
        : null,
    };
  }
  async updateConversation(ownerId: string, id: string, patch: ConversationPatch) {
    return await this.#sql.begin(async (tx) => {
      if (patch.deleted === true) {
        await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-workspace'),hashtext(${ownerId}))`;
      }
      const affectedFolders = patch.deleted === true
        ? await tx<
          Row[]
        >`SELECT f.id FROM conversation_folder_memberships m JOIN conversation_folders f ON f.id=m.folder_id WHERE m.conversation_id=${id} AND m.owner_id=${ownerId} FOR UPDATE OF f`
        : [];
      const rows = await tx<Row[]>`UPDATE conversations SET title=COALESCE(${
        patch.title ?? null
      },title),pinned=COALESCE(${patch.pinned ?? null},pinned),archived_at=CASE WHEN ${
        patch.archived ?? null
      }::boolean IS NULL THEN archived_at WHEN ${
        patch.archived ?? false
      } THEN now() ELSE NULL END,deleted_at=CASE WHEN ${
        patch.deleted ?? null
      }::boolean IS NULL THEN deleted_at WHEN ${
        patch.deleted ?? false
      } THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=${id} AND owner_id=${ownerId} AND version=${patch.expectedVersion} RETURNING *`;
      if (!rows[0]) {
        const exists = await tx<
          Row[]
        >`SELECT 1 FROM conversations WHERE id=${id} AND owner_id=${ownerId}`;
        if (exists[0]) {
          throw new DomainError("version_conflict", "Conversation changed in another request", 409);
        }
        throw new DomainError("not_found", "Conversation not found", 404);
      }
      if (patch.deleted === true) {
        await tx`DELETE FROM conversation_folder_memberships WHERE conversation_id=${id} AND owner_id=${ownerId}`;
        await tx`DELETE FROM conversation_tag_bindings WHERE conversation_id=${id} AND owner_id=${ownerId}`;
        await tx`DELETE FROM conversation_tag_sets WHERE conversation_id=${id} AND owner_id=${ownerId}`;
        if (affectedFolders.length) {
          await tx`UPDATE conversation_folders SET membership_version=membership_version+1,updated_at=now() WHERE id=ANY(${
            tx.array(affectedFolders.map((row) => String(row.id)))
          }::uuid[])`;
        }
      }
      return conversation(rows[0]);
    });
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
  async getUserPreferences(ownerId: string) {
    let rows = await this.#sql<Row[]>`SELECT * FROM user_preferences WHERE user_id=${ownerId}`;
    if (!rows[0]) {
      await this
        .#sql`INSERT INTO user_preferences(user_id) VALUES(${ownerId}) ON CONFLICT(user_id) DO NOTHING`;
      rows = await this.#sql<Row[]>`SELECT * FROM user_preferences WHERE user_id=${ownerId}`;
    }
    return preferences(rows[0]);
  }
  async getCommunityProfile(ownerId: string): Promise<CommunityProfile> {
    let rows = await this.#sql<Row[]>`SELECT * FROM community_profiles WHERE user_id=${ownerId}`;
    if (!rows[0]) {
      const inserted = await this.#sql<Row[]>`
        INSERT INTO community_profiles(user_id)
        SELECT id FROM users WHERE id=${ownerId}
        ON CONFLICT(user_id) DO NOTHING
        RETURNING *
      `;
      if (!inserted[0]) {
        rows = await this.#sql<Row[]>`SELECT * FROM community_profiles WHERE user_id=${ownerId}`;
        if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
      } else {
        rows = inserted;
      }
    }
    return communityProfile(rows[0]);
  }
  async exportConversationPortability(
    ownerId: string,
    options: ConversationPortabilityExportOptions = {},
  ): Promise<ConversationPortabilityV1> {
    return await this.#sql.begin("isolation level repeatable read", async (tx) => {
      const preferenceRows = await tx<
        Row[]
      >`SELECT * FROM user_preferences WHERE user_id=${ownerId}`;
      if (!preferenceRows[0]) {
        const exists = await tx`SELECT 1 FROM users WHERE id=${ownerId}`;
        if (!exists.length) throw new DomainError("not_found", "User not found", 404);
        await tx`INSERT INTO user_preferences(user_id) VALUES(${ownerId}) ON CONFLICT DO NOTHING`;
      }
      const preference = preferences(
        (await tx<Row[]>`SELECT * FROM user_preferences WHERE user_id=${ownerId}`)[0],
      );
      const conversationRows = await tx<Row[]>`SELECT * FROM conversations
        WHERE owner_id=${ownerId}
          AND (${Boolean(options.includeTemporary)} OR temporary=false)
          AND (${Boolean(options.includeDeleted)} OR deleted_at IS NULL)
        ORDER BY created_at,id`;
      const conversationIds = conversationRows.map((row) => String(row.id));
      const messageRows = conversationIds.length
        ? await tx<
          Row[]
        >`SELECT * FROM messages WHERE conversation_id=ANY(${conversationIds}::uuid[])
            ORDER BY created_at,id`
        : [];
      if (messageRows.some((row) => row.status === "streaming")) {
        throw new DomainError(
          "export_in_progress",
          "Finish or stop active generations before exporting conversations",
          409,
        );
      }
      const messageIds = messageRows.map((row) => String(row.id));
      const linkRows = messageIds.length
        ? await tx<Row[]>`SELECT ma.message_id,ma.attachment_id FROM message_attachments ma
            WHERE ma.message_id=ANY(${messageIds}::uuid[]) ORDER BY ma.message_id,ma.position`
        : [];
      const attachmentIds = [...new Set(linkRows.map((row) => String(row.attachment_id)))];
      const attachmentRows = attachmentIds.length
        ? await tx<Row[]>`SELECT * FROM attachments WHERE owner_id=${ownerId}
            AND id=ANY(${attachmentIds}::uuid[]) ORDER BY id`
        : [];
      if (attachmentRows.length !== attachmentIds.length) {
        throw new DomainError("invalid_attachment", "Conversation attachment is unavailable", 409);
      }
      const membershipRows = conversationIds.length
        ? await tx<Row[]>`SELECT * FROM conversation_folder_memberships WHERE owner_id=${ownerId}
            AND conversation_id=ANY(${conversationIds}::uuid[]) ORDER BY folder_id,position`
        : [];
      const folderIds = [...new Set(membershipRows.map((row) => String(row.folder_id)))];
      const folderRows = folderIds.length
        ? await tx<Row[]>`SELECT * FROM conversation_folders WHERE owner_id=${ownerId}
            AND id=ANY(${folderIds}::uuid[]) ORDER BY position,id`
        : [];
      const bindingRows = conversationIds.length
        ? await tx<Row[]>`SELECT * FROM conversation_tag_bindings WHERE owner_id=${ownerId}
            AND conversation_id=ANY(${conversationIds}::uuid[]) ORDER BY conversation_id,tag_id`
        : [];
      const tagIds = [...new Set(bindingRows.map((row) => String(row.tag_id)))];
      const tagRows = tagIds.length
        ? await tx<Row[]>`SELECT * FROM conversation_tags WHERE owner_id=${ownerId}
            AND id=ANY(${tagIds}::uuid[]) ORDER BY normalized_name,id`
        : [];
      return parseConversationPortabilityV1({
        format: "dgchat.owner-export",
        version: 1,
        scope: "owner",
        exportedAt: new Date().toISOString(),
        preferences: {
          theme: preference.theme,
          compactConversations: preference.compactConversations,
          reduceMotion: preference.reduceMotion,
          customInstructions: preference.customInstructions,
          useMemory: preference.useMemory,
          saveHistory: preference.saveHistory,
          preferredModelId: preference.preferredModelId,
        },
        folders: folderRows.map((row, position) => ({
          id: String(row.id),
          name: String(row.name),
          position,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        })),
        tags: tagRows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          color: String(row.color),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        })),
        attachments: attachmentRows.map((row) => ({
          id: String(row.id),
          filename: String(row.filename),
          mimeType: String(row.mime_type),
          byteSize: number(row.size_bytes),
          sha256: String(row.sha256),
          width: row.width == null ? null : number(row.width),
          height: row.height == null ? null : number(row.height),
          createdAt: iso(row.created_at),
          content: { included: false },
        })),
        conversations: conversationRows.map((row) => {
          const id = String(row.id);
          const membership = membershipRows.find((item) => String(item.conversation_id) === id);
          return {
            id,
            title: String(row.title),
            activeLeafId: row.active_leaf_id == null ? null : String(row.active_leaf_id),
            pinned: Boolean(row.pinned),
            temporary: Boolean(row.temporary),
            archivedAt: nullableIso(row.archived_at),
            deletedAt: nullableIso(row.deleted_at),
            createdAt: iso(row.created_at),
            updatedAt: iso(row.updated_at),
            folderId: membership ? String(membership.folder_id) : null,
            folderPosition: membership ? number(membership.position) : null,
            tagIds: bindingRows.filter((item) => String(item.conversation_id) === id)
              .map((item) => String(item.tag_id)),
            messages: messageRows.filter((item) => String(item.conversation_id) === id).map(
              (item) => {
                const messageId = String(item.id);
                return {
                  id: messageId,
                  parentId: item.parent_id == null ? null : String(item.parent_id),
                  supersedesId: item.supersedes_id == null ? null : String(item.supersedes_id),
                  generationId: item.generation_id == null ? null : String(item.generation_id),
                  siblingIndex: number(item.sibling_index),
                  role: String(item.role),
                  content: String(item.content),
                  model: item.model == null ? null : String(item.model),
                  status: String(item.status),
                  metadata: item.metadata ?? {},
                  attachments: linkRows.filter((link) => String(link.message_id) === messageId)
                    .map((link, position) => ({
                      attachmentId: String(link.attachment_id),
                      position,
                    })),
                  createdAt: iso(item.created_at),
                };
              },
            ),
          };
        }),
      });
    });
  }

  async importConversationPortability(
    ownerId: string,
    input: ConversationPortabilityV1,
    idempotencyKey: string,
    dryRun = false,
  ): Promise<ConversationPortabilityImportResult> {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new DomainError("validation_error", "Import idempotency key is invalid", 422);
    }
    const archive = parseConversationPortabilityV1(input);
    const payloadHash = await sha256Hex(new TextEncoder().encode(canonicalJson(archive)));
    const allocateIds = () => {
      const idMap: Record<string, string> = {};
      const allocate = (id: string) => idMap[id] ??= crypto.randomUUID();
      for (const value of archive.folders) allocate(value.id);
      for (const value of archive.tags) allocate(value.id);
      for (const value of archive.attachments) allocate(value.id);
      for (const value of archive.conversations) {
        allocate(value.id);
        for (const node of value.messages) {
          allocate(node.id);
          if (node.generationId) allocate(node.generationId);
        }
      }
      return idMap;
    };
    const summary = (idMap: Record<string, string>): ConversationPortabilityImportResult => ({
      dryRun,
      replayed: false,
      conversations: archive.conversations.length,
      messages: archive.conversations.reduce((total, value) => total + value.messages.length, 0),
      attachments: archive.attachments.length,
      folders: archive.folders.length,
      tags: archive.tags.length,
      idMap,
    });
    if (dryRun) {
      const exists = await this.#sql`SELECT 1 FROM users WHERE id=${ownerId}`;
      if (!exists.length) throw new DomainError("not_found", "User not found", 404);
      return summary(allocateIds());
    }
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-portability'),hashtext(${ownerId}))`;
      const userRows = await tx`SELECT 1 FROM users WHERE id=${ownerId} FOR UPDATE`;
      if (!userRows.length) throw new DomainError("not_found", "User not found", 404);
      const prior = await tx<Row[]>`SELECT payload_hash,result FROM conversation_portability_imports
        WHERE owner_id=${ownerId} AND idempotency_key=${idempotencyKey}`;
      if (prior[0]) {
        if (String(prior[0].payload_hash) !== payloadHash) {
          throw new DomainError("idempotency_conflict", "Import replay payload differs", 409);
        }
        return { ...(prior[0].result as ConversationPortabilityImportResult), replayed: true };
      }
      const idMap = allocateIds();
      const result = summary(idMap);
      await tx`INSERT INTO user_preferences(
        user_id,theme,compact_conversations,reduce_motion,custom_instructions,use_memory,
        save_history,preferred_model_id,version,updated_at
      ) VALUES(${ownerId},${archive.preferences.theme},${archive.preferences.compactConversations},
        ${archive.preferences.reduceMotion},${archive.preferences.customInstructions},
        ${archive.preferences.useMemory},${archive.preferences.saveHistory},
        ${archive.preferences.preferredModelId},1,now())
      ON CONFLICT(user_id) DO UPDATE SET
        theme=excluded.theme,compact_conversations=excluded.compact_conversations,
        reduce_motion=excluded.reduce_motion,custom_instructions=excluded.custom_instructions,
        use_memory=excluded.use_memory,save_history=excluded.save_history,
        preferred_model_id=excluded.preferred_model_id,
        version=user_preferences.version+1,updated_at=now()`;
      const folderNames = new Set((await tx<Row[]>`SELECT normalized_name FROM conversation_folders
        WHERE owner_id=${ownerId}`).map((row) => String(row.normalized_name)));
      const tagNames = new Set((await tx<Row[]>`SELECT normalized_name FROM conversation_tags
        WHERE owner_id=${ownerId}`).map((row) => String(row.normalized_name)));
      const uniqueName = (name: string, used: Set<string>, max: number) => {
        let candidate = name.slice(0, max);
        for (let suffix = 2; used.has(canonicalWorkspaceName(candidate)); suffix++) {
          const marker = ` (import ${suffix})`;
          candidate = `${name.slice(0, max - marker.length)}${marker}`;
        }
        used.add(canonicalWorkspaceName(candidate));
        return candidate;
      };
      const offsets = await tx<{ next: number }[]>`SELECT COALESCE(max(position)+1,0)::int next
        FROM conversation_folders WHERE owner_id=${ownerId}`;
      for (const value of archive.folders) {
        const name = uniqueName(value.name, folderNames, 120);
        await tx`INSERT INTO conversation_folders(
          id,owner_id,name,normalized_name,position,version,membership_version,created_at,updated_at
        ) VALUES(${idMap[value.id]},${ownerId},${name},${canonicalWorkspaceName(name)},
          ${offsets[0].next + value.position},1,0,${value.createdAt},${value.updatedAt})`;
      }
      for (const value of archive.tags) {
        const name = uniqueName(value.name, tagNames, 64);
        await tx`INSERT INTO conversation_tags(
          id,owner_id,name,normalized_name,color,version,created_at,updated_at
        ) VALUES(${idMap[value.id]},${ownerId},${name},${
          canonicalWorkspaceName(name)
        },${value.color},
          1,${value.createdAt},${value.updatedAt})`;
      }
      const importedAt = new Date().toISOString();
      for (const value of archive.attachments) {
        const id = idMap[value.id];
        await tx`INSERT INTO attachments(
          id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,inspection_error,
          ingestion_status,ingestion_error,width,height,physical_object,
          created_at,updated_at,deleted_at
        ) VALUES(${id},${ownerId},${`imports/${ownerId}/${id}/manifest-only`},${value.filename},
          ${value.mimeType},${value.byteSize},${value.sha256},'failed',
          'Attachment bytes were not included in the .dgchat manifest','failed',
          'Attachment bytes require a separate restore',${value.width},${value.height},false,
          ${value.createdAt},${importedAt},${importedAt})`;
      }
      const foldersWithMemberships = new Set<string>();
      for (const value of archive.conversations) {
        const conversationId = idMap[value.id];
        const temporaryExpiresAt = value.temporary
          ? new Date(Date.now() + 30 * 86_400_000).toISOString()
          : null;
        await tx`INSERT INTO conversations(
          id,owner_id,title,active_leaf_id,version,pinned,temporary,temporary_expires_at,
          archived_at,deleted_at,created_at,updated_at
        ) VALUES(${conversationId},${ownerId},${value.title},
          ${
          value.activeLeafId ? idMap[value.activeLeafId] : null
        },0,${value.pinned},${value.temporary},
          ${temporaryExpiresAt},${value.archivedAt},${value.deletedAt},${value.createdAt},${value.updatedAt})`;
        for (const node of value.messages) {
          await tx`INSERT INTO messages(
            id,conversation_id,parent_id,supersedes_id,generation_id,sibling_index,role,content,
            model,status,metadata,idempotency_key,created_at
          ) VALUES(${idMap[node.id]},${conversationId},${
            node.parentId ? idMap[node.parentId] : null
          },
            ${node.supersedesId ? idMap[node.supersedesId] : null},
            ${
            node.generationId ? idMap[node.generationId] : null
          },${node.siblingIndex},${node.role},
            ${node.content},${node.model},${node.status},
            ${
            tx.json(node.metadata as postgres.JSONValue)
          },${`import:${node.id}`},${node.createdAt})`;
          for (const link of [...node.attachments].sort((a, b) => a.position - b.position)) {
            await tx`INSERT INTO message_attachments(message_id,attachment_id,position)
              VALUES(${idMap[node.id]},${idMap[link.attachmentId]},${link.position})`;
          }
        }
        if (value.folderId) {
          const folderId = idMap[value.folderId];
          foldersWithMemberships.add(folderId);
          await tx`INSERT INTO conversation_folder_memberships(
            folder_id,conversation_id,owner_id,position,created_at,updated_at
          ) VALUES(${folderId},${conversationId},${ownerId},${value
            .folderPosition!},${importedAt},${importedAt})`;
        }
        await tx`INSERT INTO conversation_tag_sets(conversation_id,owner_id,version,updated_at)
          VALUES(${conversationId},${ownerId},${value.tagIds.length ? 1 : 0},${importedAt})`;
        for (const tagId of value.tagIds) {
          await tx`INSERT INTO conversation_tag_bindings(conversation_id,tag_id,owner_id,created_at)
            VALUES(${conversationId},${idMap[tagId]},${ownerId},${importedAt})`;
        }
      }
      for (const folderId of foldersWithMemberships) {
        await tx`UPDATE conversation_folders SET membership_version=1 WHERE id=${folderId}
          AND owner_id=${ownerId}`;
      }
      await tx`INSERT INTO conversation_portability_imports(
        owner_id,idempotency_key,payload_hash,result
      ) VALUES(${ownerId},${idempotencyKey},${payloadHash},${
        tx.json(result as unknown as postgres.JSONValue)
      })`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${ownerId},'conversation.portability_imported','user',${ownerId},${
        tx.json({
          conversations: result.conversations,
          messages: result.messages,
          attachments: result.attachments,
        })
      })`;
      return result;
    });
  }
  async createConversationShare(
    ownerId: string,
    input: CreateConversationShareInput,
  ): Promise<CreateConversationShareResult> {
    if (
      !input.idempotencyKey || input.idempotencyKey.length > 200 ||
      !CONVERSATION_SHARE_UUID_PATTERN.test(input.conversationId) ||
      !CONVERSATION_SHARE_UUID_PATTERN.test(input.leafId) ||
      !/^[0-9a-f]{64}$/.test(input.secretHash) ||
      !Number.isSafeInteger(input.expectedConversationVersion) ||
      input.expectedConversationVersion < 0 ||
      !["owner", "anonymous"].includes(input.identityVisibility) ||
      !["include", "redact", "selected"].includes(input.attachmentPolicy) ||
      !Array.isArray(input.selectedAttachmentIds) ||
      input.selectedAttachmentIds.length > 100 ||
      input.selectedAttachmentIds.some((id) => !CONVERSATION_SHARE_UUID_PATTERN.test(id)) ||
      new Set(input.selectedAttachmentIds).size !== input.selectedAttachmentIds.length ||
      (input.attachmentPolicy === "selected") !== (input.selectedAttachmentIds.length > 0)
    ) throw new DomainError("validation_error", "Share request is invalid", 422);
    const expiryInstant = input.expiresAt === null ? null : Date.parse(input.expiresAt);
    if (
      input.expiresAt !== null &&
      (!Number.isFinite(expiryInstant) || Number(expiryInstant) <= Date.now())
    ) throw new DomainError("validation_error", "Share expiry must be in the future", 422);
    const expiresAt = expiryInstant === null ? null : new Date(expiryInstant).toISOString();
    const payloadHash = await sha256Hex(new TextEncoder().encode(canonicalJson({
      conversationId: input.conversationId,
      leafId: input.leafId,
      expectedConversationVersion: input.expectedConversationVersion,
      identityVisibility: input.identityVisibility,
      attachmentPolicy: input.attachmentPolicy,
      selectedAttachmentIds: [...input.selectedAttachmentIds].sort(),
      expiresAt,
      secretHash: input.secretHash,
    })));
    return await this.#sql.begin(async (tx) => {
      const owners = await tx<Row[]>`SELECT approval_status,state,deleted_at FROM users
        WHERE id=${ownerId} FOR SHARE`;
      if (
        !owners[0] || owners[0].approval_status !== "approved" ||
        owners[0].state !== "active" || owners[0].deleted_at !== null
      ) throw new DomainError("account_unavailable", "Account cannot create shares", 403);
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-share-idempotency'),hashtext(${`${ownerId}:${input.idempotencyKey}`}))`;
      const prior = await tx<Row[]>`SELECT * FROM conversation_share_snapshots
        WHERE owner_id=${ownerId} AND idempotency_key=${input.idempotencyKey}`;
      if (prior[0]) {
        if (String(prior[0].payload_hash) !== payloadHash) {
          throw new DomainError("idempotency_conflict", "Share replay payload differs", 409);
        }
        return { share: conversationShareSummary(prior[0]), replayed: true };
      }
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-share-owner'),hashtext(${ownerId}))`;
      const activeShares = await tx<{ count: number }[]>`SELECT count(*)::int count
        FROM conversation_share_snapshots WHERE owner_id=${ownerId} AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at>now())`;
      if (activeShares[0].count >= MAX_ACTIVE_CONVERSATION_SHARES) {
        throw new DomainError(
          "share_limit_exceeded",
          "Revoke an existing share before creating another",
          409,
        );
      }
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-share-secret'),hashtext(${input.secretHash}))`;
      if (
        (await tx`SELECT 1 FROM conversation_share_snapshots WHERE secret_hash=${input.secretHash}`)
          .length
      ) {
        throw new DomainError("secret_conflict", "Share capability already exists", 409);
      }
      const rows = await tx<Row[]>`SELECT c.*,u.name owner_name,u.approval_status,u.state,
        u.deleted_at owner_deleted_at
        FROM conversations c JOIN users u ON u.id=c.owner_id
        WHERE c.id=${input.conversationId} AND c.owner_id=${ownerId} FOR UPDATE OF c`;
      const row = rows[0];
      if (!row || row.deleted_at) throw new DomainError("not_found", "Conversation not found", 404);
      if (
        row.approval_status !== "approved" || row.state !== "active" ||
        row.owner_deleted_at !== null
      ) {
        throw new DomainError("account_unavailable", "Account cannot create shares", 403);
      }
      if (row.temporary) {
        throw new DomainError(
          "temporary_conversation_not_shareable",
          "Save this temporary chat before sharing",
          409,
        );
      }
      if (number(row.version) !== input.expectedConversationVersion) {
        throw new DomainError("version_conflict", "Conversation changed before sharing", 409);
      }
      const messageRows = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.conversationId}
        ORDER BY created_at,id LIMIT ${MAX_CONVERSATION_SHARE_MESSAGES + 1}`;
      if (messageRows.length > MAX_CONVERSATION_SHARE_MESSAGES) {
        throw new DomainError("share_too_large", "Conversation is too large to share", 413);
      }
      if (messageRows.some((value) => value.status === "streaming")) {
        throw new DomainError(
          "generation_in_progress",
          "Stop the active generation before sharing",
          409,
        );
      }
      const byId = new Map(messageRows.map((value) => [String(value.id), value]));
      const reversePath: Row[] = [];
      const seen = new Set<string>();
      let cursor: string | null = input.leafId;
      while (cursor !== null) {
        if (seen.has(cursor)) {
          throw new DomainError("invalid_graph", "Conversation graph contains a cycle", 409);
        }
        seen.add(cursor);
        const node = byId.get(cursor);
        if (!node) {
          throw new DomainError("invalid_leaf", "Share leaf is not in this conversation", 422);
        }
        reversePath.push(node);
        cursor = node.parent_id == null ? null : String(node.parent_id);
      }
      const path = reversePath.reverse();
      const leaf = path[path.length - 1];
      if (
        leaf.status === "tombstoned" || leaf.role === "system" || leaf.role === "developer"
      ) throw new DomainError("leaf_not_shareable", "Share leaf is not publicly shareable", 422);
      const publicPath = path.filter((value) =>
        value.status !== "tombstoned" && value.role !== "system" && value.role !== "developer"
      );
      if (
        publicPath.length > MAX_CONVERSATION_SHARE_MESSAGES ||
        publicPath.reduce((total, value) => total + String(value.content).length, 0) >
          MAX_CONVERSATION_SHARE_CONTENT_CHARS
      ) throw new DomainError("share_too_large", "Conversation is too large to share", 413);
      const pathIds = publicPath.map((value) => String(value.id));
      const links = input.attachmentPolicy === "redact" || !pathIds.length
        ? []
        : input.attachmentPolicy === "selected"
        ? await tx<Row[]>`SELECT message_id,attachment_id,position FROM message_attachments
          WHERE message_id=ANY(${pathIds}::uuid[])
            AND attachment_id=ANY(${input.selectedAttachmentIds}::uuid[])
          ORDER BY message_id,position LIMIT ${MAX_CONVERSATION_SHARE_ATTACHMENTS + 1}`
        : await tx<Row[]>`SELECT message_id,attachment_id,position FROM message_attachments
          WHERE message_id=ANY(${pathIds}::uuid[]) ORDER BY message_id,position
          LIMIT ${MAX_CONVERSATION_SHARE_ATTACHMENTS + 1}`;
      if (links.length > MAX_CONVERSATION_SHARE_ATTACHMENTS) {
        throw new DomainError(
          "share_too_large",
          "Conversation has too many shared attachments",
          413,
        );
      }
      const byMessage = new Map<string, Row[]>();
      const pathAttachmentIds: string[] = [];
      for (const link of links) {
        const messageId = String(link.message_id);
        const values = byMessage.get(messageId) ?? [];
        values.push(link);
        if (values.length > 100) {
          throw new DomainError(
            "share_too_large",
            "Conversation has too many shared attachments",
            413,
          );
        }
        byMessage.set(messageId, values);
        const attachmentId = String(link.attachment_id);
        if (!pathAttachmentIds.includes(attachmentId)) pathAttachmentIds.push(attachmentId);
      }
      const selected = input.attachmentPolicy === "include"
        ? pathAttachmentIds
        : input.attachmentPolicy === "selected"
        ? input.selectedAttachmentIds
        : [];
      if (selected.length > MAX_CONVERSATION_SHARE_ATTACHMENTS) {
        throw new DomainError(
          "share_too_large",
          "Conversation has too many shared attachments",
          413,
        );
      }
      if (selected.some((id) => !pathAttachmentIds.includes(id))) {
        throw new DomainError(
          "invalid_attachment",
          "Selected attachment is not on the shared path",
          422,
        );
      }
      const attachmentRows = await lockReferenceableAttachments(
        tx,
        ownerId,
        selected,
        "invalid_attachment",
        "Shared attachment is unavailable",
      );
      const attachmentById = new Map(attachmentRows.map((value) => [String(value.id), value]));
      const attachmentPublicIds = new Map(selected.map((id) => [id, crypto.randomUUID()]));
      const publicAttachments: PublicConversationShareAttachment[] = selected.map(
        (attachmentId) => {
          const value = attachmentById.get(attachmentId)!;
          return {
            id: attachmentPublicIds.get(attachmentId)!,
            filename: String(value.filename),
            mimeType: String(value.mime_type),
            sizeBytes: number(value.size_bytes),
            width: value.width == null ? null : number(value.width),
            height: value.height == null ? null : number(value.height),
            createdAt: iso(value.created_at),
          };
        },
      );
      const sourceAttachments = Object.fromEntries(selected.map((attachmentId) => {
        const value = attachmentById.get(attachmentId)!;
        return [attachmentPublicIds.get(attachmentId)!, {
          attachmentId,
          objectKey: String(value.object_key),
        }];
      }));
      const messagePublicIds = new Map(
        publicPath.map((value) => [String(value.id), crypto.randomUUID()]),
      );
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(createdAt)) {
        throw new DomainError("validation_error", "Share expiry must be in the future", 422);
      }
      const publicSnapshot = materializePublicConversationShare({
        id,
        title: String(row.title),
        conversationVersion: number(row.version),
        identity: {
          visibility: input.identityVisibility,
          displayName: input.identityVisibility === "owner" ? String(row.owner_name) : null,
        },
        attachmentPolicy: input.attachmentPolicy,
        messages: publicPath.map((value, index) => {
          const messageId = String(value.id);
          return {
            id: messagePublicIds.get(messageId)!,
            parentId: index === 0 ? null : messagePublicIds.get(String(publicPath[index - 1].id))!,
            role: String(value.role),
            content: String(value.content),
            status: String(value.status),
            attachmentIds: (byMessage.get(messageId) ?? []).map((link) =>
              attachmentPublicIds.get(String(link.attachment_id))
            ).filter((value) => value !== undefined),
            createdAt: iso(value.created_at),
          };
        }),
        attachments: publicAttachments,
        createdAt,
        expiresAt,
      });
      const inserted = await tx<Row[]>`INSERT INTO conversation_share_snapshots(
        id,owner_id,conversation_id,leaf_id,conversation_version,title,identity_visibility,
        attachment_policy,owner_name_snapshot,public_snapshot,source_attachments,secret_hash,
        idempotency_key,payload_hash,version,expires_at,created_at
      ) VALUES(${id},${ownerId},${input.conversationId},${input.leafId},${number(row.version)},
        ${String(row.title)},${input.identityVisibility},${input.attachmentPolicy},
        ${input.identityVisibility === "owner" ? String(row.owner_name) : null},
        ${tx.json(publicSnapshot as unknown as postgres.JSONValue)},
        ${tx.json(sourceAttachments as postgres.JSONValue)},${input.secretHash},
        ${input.idempotencyKey},${payloadHash},1,${expiresAt},${createdAt}) RETURNING *`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${ownerId},'conversation.share_created','conversation_share',${id},
          ${
        tx.json({ conversationId: input.conversationId, attachmentCount: publicAttachments.length })
      })`;
      return { share: conversationShareSummary(inserted[0]), replayed: false };
    });
  }

  async listConversationShares(ownerId: string): Promise<ConversationShareSummary[]> {
    if (!(await this.#sql`SELECT 1 FROM users WHERE id=${ownerId}`).length) {
      throw new DomainError("not_found", "User not found", 404);
    }
    const rows = await this.#sql<Row[]>`SELECT * FROM conversation_share_snapshots
      WHERE owner_id=${ownerId} ORDER BY created_at DESC,id DESC`;
    return rows.map(conversationShareSummary);
  }

  async getConversationShare(ownerId: string, shareId: string): Promise<ConversationShareSummary> {
    const rows = await this.#sql<Row[]>`SELECT * FROM conversation_share_snapshots
      WHERE id=${shareId} AND owner_id=${ownerId}`;
    if (!rows[0]) throw new DomainError("not_found", "Share not found", 404);
    return conversationShareSummary(rows[0]);
  }

  async revokeConversationShare(
    ownerId: string,
    shareId: string,
    expectedVersion: number,
  ): Promise<ConversationShareSummary> {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`UPDATE conversation_share_snapshots
        SET revoked_at=now(),version=version+1
        WHERE id=${shareId} AND owner_id=${ownerId} AND version=${expectedVersion}
          AND revoked_at IS NULL RETURNING *`;
      if (rows[0]) {
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${ownerId},'conversation.share_revoked','conversation_share',${shareId},
            ${tx.json({ conversationId: String(rows[0].conversation_id) })})`;
        return conversationShareSummary(rows[0]);
      }
      const current = await tx<Row[]>`SELECT * FROM conversation_share_snapshots
        WHERE id=${shareId} AND owner_id=${ownerId}`;
      if (!current[0]) throw new DomainError("not_found", "Share not found", 404);
      if (number(current[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Share changed in another request", 409);
      }
      return conversationShareSummary(current[0]);
    });
  }

  async resolvePublicConversationShare(
    secretHash: string,
    now = new Date().toISOString(),
  ): Promise<PublicConversationShare | undefined> {
    if (!/^[0-9a-f]{64}$/.test(secretHash) || !Number.isFinite(Date.parse(now))) return undefined;
    const rows = await this.#sql<Row[]>`SELECT s.public_snapshot FROM conversation_share_snapshots s
      JOIN users u ON u.id=s.owner_id WHERE s.secret_hash=${secretHash}
        AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>${now})
        AND u.approval_status='approved' AND u.state='active' AND u.deleted_at IS NULL`;
    return rows[0] ? parsePublicConversationShare(rows[0].public_snapshot) : undefined;
  }

  async resolvePublicShareAttachment(
    secretHash: string,
    publicAttachmentId: string,
    now = new Date().toISOString(),
  ): Promise<ConversationShareAttachmentAccess | undefined> {
    if (
      !/^[0-9a-f]{64}$/.test(secretHash) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        publicAttachmentId,
      ) ||
      !Number.isFinite(Date.parse(now))
    ) return undefined;
    const rows = await this.#sql<Row[]>`SELECT s.*,u.approval_status,u.state
      FROM conversation_share_snapshots s JOIN users u ON u.id=s.owner_id
      WHERE s.secret_hash=${secretHash} AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at>${now})
        AND u.approval_status='approved' AND u.state='active' AND u.deleted_at IS NULL`;
    if (!rows[0]) return undefined;
    const snapshot = parsePublicConversationShare(rows[0].public_snapshot);
    const publicAttachment = snapshot.attachments.find((value) => value.id === publicAttachmentId);
    const sources = rows[0].source_attachments;
    const source = sources && typeof sources === "object" && !Array.isArray(sources)
      ? (sources as Record<string, unknown>)[publicAttachmentId]
      : undefined;
    if (!publicAttachment || !source || typeof source !== "object" || Array.isArray(source)) {
      return undefined;
    }
    const attachmentId = (source as Record<string, unknown>).attachmentId;
    if (typeof attachmentId !== "string") return undefined;
    const attachments = await this.#sql<Row[]>`SELECT object_key,sha256 FROM attachments
      WHERE id=${attachmentId} AND owner_id=${String(rows[0].owner_id)}
        AND state='ready' AND deleted_at IS NULL`;
    if (!attachments[0]) return undefined;
    return {
      shareId: String(rows[0].id),
      ownerId: String(rows[0].owner_id),
      attachment: publicAttachment,
      objectKey: String(attachments[0].object_key),
      sha256: String(attachments[0].sha256),
    };
  }

  async updateUserPreferences(
    ownerId: string,
    patch: import("./repository.ts").UserPreferencesPatch,
  ) {
    const rows = await this.#sql<Row[]>`UPDATE user_preferences SET theme=COALESCE(${
      patch.theme ?? null
    },theme),compact_conversations=COALESCE(${
      patch.compactConversations ?? null
    },compact_conversations),reduce_motion=COALESCE(${
      patch.reduceMotion ?? null
    },reduce_motion),custom_instructions=COALESCE(${
      patch.customInstructions ?? null
    },custom_instructions),use_memory=COALESCE(${
      patch.useMemory ?? null
    },use_memory),save_history=COALESCE(${
      patch.saveHistory ?? null
    },save_history),preferred_model_id=CASE WHEN ${
      patch.preferredModelId === undefined
    } THEN preferred_model_id ELSE ${
      patch.preferredModelId ?? null
    } END,version=version+1,updated_at=now() WHERE user_id=${ownerId} AND version=${patch.expectedVersion} RETURNING *`;
    if (!rows[0]) {
      await this.getUserPreferences(ownerId);
      throw new DomainError("version_conflict", "Preferences changed in another request", 409);
    }
    return preferences(rows[0]);
  }
  async updateCommunityProfile(
    ownerId: string,
    patch: CommunityProfilePatch,
    context: CommunityProfileMutationContext,
  ): Promise<CommunityProfile> {
    if (!context || context.actorId !== ownerId) {
      throw new DomainError("forbidden", "Community profile can only be changed by its owner", 403);
    }
    return await this.#sql.begin(async (tx) => {
      const inserted = await tx<Row[]>`
        INSERT INTO community_profiles(user_id)
        SELECT id FROM users WHERE id=${ownerId}
        ON CONFLICT(user_id) DO NOTHING
        RETURNING *
      `;
      let rows = inserted;
      if (!rows[0]) {
        rows = await tx<Row[]>`
          SELECT * FROM community_profiles WHERE user_id=${ownerId} FOR UPDATE
        `;
      }
      if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
      const current = communityProfile(rows[0]);
      if (current.version !== patch.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "Community profile changed in another request",
          409,
        );
      }
      const canonical = applyCommunityProfilePatch(current, patch);
      const changedFields = (
        ["optedIn", "identityMode", "nickname", "color", "shareBalance"] as const
      ).filter((field) => current[field] !== canonical[field]);
      const updated = await tx<Row[]>`
        UPDATE community_profiles SET
          opted_in=${canonical.optedIn},
          identity_mode=${canonical.identityMode},
          nickname=${canonical.nickname},
          color=${canonical.color},
          share_balance=${canonical.shareBalance},
          version=version+1,
          updated_at=now()
        WHERE user_id=${ownerId} AND version=${patch.expectedVersion}
        RETURNING *
      `;
      if (!updated[0]) {
        throw new DomainError(
          "version_conflict",
          "Community profile changed in another request",
          409,
        );
      }
      const next = communityProfile(updated[0]);
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(
          ${ownerId},
          'community.profile_updated',
          'community_profile',
          ${ownerId},
          ${
        tx.json({
          changedFields,
          optedIn: next.optedIn,
          identityMode: next.identityMode,
          color: next.color,
          shareBalance: next.shareBalance,
          nicknameChanged: current.nickname !== next.nickname,
          version: next.version,
        })
      }
        )`;
      return next;
    });
  }

  async listCommunityLeaderboard(
    input: CommunityLeaderboardReadQuery,
  ): Promise<CommunityLeaderboardRepositoryPage> {
    const query = validateCommunityLeaderboardReadQuery(input);
    const afterScore = query.after?.score ?? 0;
    const afterUserId = query.after?.userId ?? "00000000-0000-0000-0000-000000000000";
    const hasAfter = query.after !== undefined;
    const rows = await this.#sql<Row[]>`
      WITH aggregated AS (
        SELECT
          users.id AS user_id,
          profiles.identity_mode,
          profiles.nickname,
          profiles.color,
          GREATEST(0, LEAST(
            CASE ${query.metric}
              WHEN 'balance' THEN users.balance_micros::numeric
              WHEN 'calls' THEN count(runs.id)::numeric
              WHEN 'tokens' THEN COALESCE(
                sum(runs.input_tokens::numeric + runs.output_tokens::numeric),
                0
              )
              ELSE COALESCE(sum(runs.cost_micros::numeric), 0)
            END,
            ${Number.MAX_SAFE_INTEGER}::numeric
          ))::bigint AS value
        FROM community_profiles profiles
        JOIN users ON users.id=profiles.user_id
        LEFT JOIN usage_runs runs ON
          ${query.metric !== "balance"}
          AND runs.user_id=users.id
          AND (runs.status='completed' OR runs.cost_micros>0)
          AND (
            ${query.from === null}
            OR COALESCE(runs.completed_at,runs.created_at)>=${query.from}::timestamptz
          )
          AND COALESCE(runs.completed_at,runs.created_at)<${query.asOf}::timestamptz
        WHERE profiles.opted_in=true
          AND users.approval_status='approved'
          AND users.state='active'
          AND users.deleted_at IS NULL
          AND (${query.metric !== "balance"} OR profiles.share_balance=true)
        GROUP BY
          users.id,
          users.balance_micros,
          profiles.identity_mode,
          profiles.nickname,
          profiles.color
      ),
      ranked AS (
        SELECT
          user_id,
          identity_mode,
          nickname,
          color,
          value,
          dense_rank() OVER (ORDER BY value DESC)::bigint AS position
        FROM aggregated
      )
      SELECT user_id,identity_mode,nickname,color,value,position
      FROM ranked
      WHERE (
        ${!hasAfter}
        OR value<${afterScore}::bigint
        OR (value=${afterScore}::bigint AND user_id>${afterUserId}::uuid)
      )
      ORDER BY value DESC,user_id ASC
      LIMIT ${query.limit + 1}
    `;
    const selected = rows.slice(0, query.limit);
    const data = selected.map((row) => ({
      userId: String(row.user_id),
      position: number(row.position),
      identityMode: String(row.identity_mode) as "anonymous" | "nickname",
      nickname: row.identity_mode === "nickname" && row.nickname != null
        ? String(row.nickname)
        : null,
      color: String(row.color) as
        | "slate"
        | "blue"
        | "cyan"
        | "emerald"
        | "amber"
        | "orange"
        | "rose"
        | "violet",
      value: number(row.value),
    }));
    const last = data.at(-1);
    return {
      data,
      nextBoundary: rows.length > query.limit && last
        ? { score: last.value, userId: last.userId, position: last.position }
        : null,
    };
  }

  async listConversationFolders(ownerId: string) {
    const [folders, memberships] = await Promise.all([
      this.#sql<
        Row[]
      >`SELECT * FROM conversation_folders WHERE owner_id=${ownerId} ORDER BY position,id`,
      this.#sql<
        Row[]
      >`SELECT * FROM conversation_folder_memberships WHERE owner_id=${ownerId} ORDER BY folder_id,position,conversation_id`,
    ]);
    return { folders: folders.map(folder), memberships: memberships.map(folderMembership) };
  }
  async createConversationFolder(ownerId: string, inputName: string, idempotencyKey: string) {
    const name = inputName.trim();
    const fingerprint = JSON.stringify({ name });
    try {
      return await this.#sql.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${ownerId} FOR UPDATE`;
        const prior = await tx<
          Row[]
        >`SELECT payload_hash,result_id FROM operation_idempotency WHERE owner_id=${ownerId} AND operation='folder.create' AND idempotency_key=${idempotencyKey}`;
        if (prior[0]) {
          if (String(prior[0].payload_hash) !== fingerprint) {
            throw new DomainError("idempotency_conflict", "Folder replay payload differs", 409);
          }
          const replay = await tx<Row[]>`SELECT * FROM conversation_folders WHERE id=${
            String(prior[0].result_id)
          } AND owner_id=${ownerId}`;
          if (!replay[0]) {
            throw new DomainError(
              "idempotency_conflict",
              "Folder replay target is unavailable",
              409,
            );
          }
          return folder(replay[0]);
        }
        const rows = await tx<
          Row[]
        >`INSERT INTO conversation_folders(owner_id,name,normalized_name,position) VALUES(${ownerId},${name},${
          canonicalWorkspaceName(name)
        },COALESCE((SELECT max(position)+1 FROM conversation_folders WHERE owner_id=${ownerId}),0)) RETURNING *`;
        await tx`INSERT INTO operation_idempotency(owner_id,operation,idempotency_key,payload_hash,result_id) VALUES(${ownerId},'folder.create',${idempotencyKey},${fingerprint},${
          String(rows[0].id)
        })`;
        return folder(rows[0]);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("name_conflict", "A folder with that name already exists", 409);
      }
      throw error;
    }
  }
  async updateConversationFolder(
    ownerId: string,
    id: string,
    inputName: string,
    expectedVersion: number,
  ) {
    const name = inputName.trim();
    try {
      const rows = await this.#sql<
        Row[]
      >`UPDATE conversation_folders SET name=${name},normalized_name=${
        canonicalWorkspaceName(name)
      },version=version+1,updated_at=now() WHERE id=${id} AND owner_id=${ownerId} AND version=${expectedVersion} RETURNING *`;
      if (!rows[0]) {
        const exists = await this.#sql<
          Row[]
        >`SELECT 1 FROM conversation_folders WHERE id=${id} AND owner_id=${ownerId}`;
        throw new DomainError(
          exists[0] ? "version_conflict" : "not_found",
          exists[0] ? "Folder changed in another request" : "Folder not found",
          exists[0] ? 409 : 404,
        );
      }
      return folder(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("name_conflict", "A folder with that name already exists", 409);
      }
      throw error;
    }
  }
  async deleteConversationFolder(
    ownerId: string,
    id: string,
    expectedVersion: number,
    expectedMembershipVersion: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-workspace'),hashtext(${ownerId}))`;
      const rows = await tx<
        Row[]
      >`DELETE FROM conversation_folders WHERE id=${id} AND owner_id=${ownerId} AND version=${expectedVersion} AND membership_version=${expectedMembershipVersion} RETURNING id`;
      if (!rows[0]) {
        const exists = await tx<
          Row[]
        >`SELECT 1 FROM conversation_folders WHERE id=${id} AND owner_id=${ownerId}`;
        throw new DomainError(
          exists[0] ? "version_conflict" : "not_found",
          exists[0] ? "Folder changed in another request" : "Folder not found",
          exists[0] ? 409 : 404,
        );
      }
    });
  }
  async reorderConversationFolders(
    ownerId: string,
    ids: string[],
    versions: Record<string, number>,
  ) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-workspace'),hashtext(${ownerId}))`;
      await tx`SET CONSTRAINTS conversation_folders_owner_position_uq DEFERRED`;
      const rows = await tx<
        Row[]
      >`SELECT * FROM conversation_folders WHERE owner_id=${ownerId} ORDER BY position,id FOR UPDATE`;
      if (
        rows.length !== ids.length || rows.some((x) => !ids.includes(String(x.id))) ||
        Object.keys(versions).length !== ids.length
      ) throw new DomainError("folder_set_conflict", "Folder set changed", 409);
      for (const row of rows) {
        if (versions[String(row.id)] !== number(row.version)) {
          throw new DomainError("version_conflict", "Folder changed in another request", 409);
        }
      }
      for (let position = 0; position < ids.length; position++) {
        await tx`UPDATE conversation_folders SET position=${position},version=version+1,updated_at=now() WHERE id=${
          ids[position]
        } AND owner_id=${ownerId}`;
      }
      return (await tx<
        Row[]
      >`SELECT * FROM conversation_folders WHERE owner_id=${ownerId} ORDER BY position,id`).map(
        folder,
      );
    });
  }
  async replaceFolderMemberships(
    ownerId: string,
    folderId: string,
    ids: string[],
    expected: Record<string, number>,
  ) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-workspace'),hashtext(${ownerId}))`;
      await tx`SET CONSTRAINTS conversation_folder_memberships_position_uq DEFERRED`;
      const target = await tx<
        Row[]
      >`SELECT * FROM conversation_folders WHERE id=${folderId} AND owner_id=${ownerId}`;
      if (!target[0]) throw new DomainError("not_found", "Folder not found", 404);
      const chats = ids.length
        ? await tx<
          Row[]
        >`SELECT id,temporary,deleted_at FROM conversations WHERE owner_id=${ownerId} AND id=ANY(${
          tx.array(ids)
        }::uuid[]) FOR UPDATE`
        : [];
      if (chats.length !== ids.length) {
        throw new DomainError("not_found", "Conversation not found", 404);
      }
      if (chats.some((x) => x.temporary || x.deleted_at)) {
        throw new DomainError(
          "conversation_not_organizable",
          "Temporary or deleted conversations cannot be organized",
          409,
        );
      }
      const sources = ids.length
        ? await tx<
          Row[]
        >`SELECT DISTINCT folder_id FROM conversation_folder_memberships WHERE owner_id=${ownerId} AND conversation_id=ANY(${
          tx.array(ids)
        }::uuid[])`
        : [];
      const affected = [...new Set([folderId, ...sources.map((x) => String(x.folder_id))])].sort();
      const folders = await tx<
        Row[]
      >`SELECT * FROM conversation_folders WHERE owner_id=${ownerId} AND id=ANY(${
        tx.array(affected)
      }::uuid[]) ORDER BY id FOR UPDATE`;
      if (
        folders.length !== affected.length || Object.keys(expected).length !== affected.length ||
        folders.some((x) => expected[String(x.id)] !== number(x.membership_version))
      ) throw new DomainError("version_conflict", "Folder membership changed", 409);
      await tx`DELETE FROM conversation_folder_memberships WHERE folder_id=${folderId} OR (owner_id=${ownerId} AND conversation_id=ANY(${
        tx.array(ids)
      }::uuid[]))`;
      for (let position = 0; position < ids.length; position++) {
        await tx`INSERT INTO conversation_folder_memberships(folder_id,conversation_id,owner_id,position) VALUES(${folderId},${
          ids[position]
        },${ownerId},${position})`;
      }
      await tx`UPDATE conversation_folders SET membership_version=membership_version+1,updated_at=now() WHERE id=ANY(${
        tx.array(affected)
      }::uuid[])`;
      const foldersOut = (await tx<
        Row[]
      >`SELECT * FROM conversation_folders WHERE owner_id=${ownerId} ORDER BY position,id`).map(
        folder,
      );
      const memberships = (await tx<
        Row[]
      >`SELECT * FROM conversation_folder_memberships WHERE owner_id=${ownerId} ORDER BY folder_id,position`)
        .map(folderMembership);
      return { folders: foldersOut, memberships };
    });
  }
  async listConversationTags(ownerId: string) {
    const [tags, bindings, sets] = await Promise.all([
      this.#sql<
        Row[]
      >`SELECT * FROM conversation_tags WHERE owner_id=${ownerId} ORDER BY normalized_name,id`,
      this.#sql<
        Row[]
      >`SELECT * FROM conversation_tag_bindings WHERE owner_id=${ownerId} ORDER BY conversation_id,tag_id`,
      this.#sql<
        Row[]
      >`SELECT * FROM conversation_tag_sets WHERE owner_id=${ownerId} ORDER BY conversation_id`,
    ]);
    return {
      tags: tags.map(conversationTag),
      bindings: bindings.map(tagBinding),
      tagSets: sets.map(tagSet),
    };
  }
  async createConversationTag(
    ownerId: string,
    inputName: string,
    color: string,
    idempotencyKey: string,
  ) {
    const name = inputName.trim();
    const fingerprint = JSON.stringify({ name, color });
    try {
      return await this.#sql.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${ownerId} FOR UPDATE`;
        const prior = await tx<
          Row[]
        >`SELECT payload_hash,result_id FROM operation_idempotency WHERE owner_id=${ownerId} AND operation='tag.create' AND idempotency_key=${idempotencyKey}`;
        if (prior[0]) {
          if (String(prior[0].payload_hash) !== fingerprint) {
            throw new DomainError("idempotency_conflict", "Tag replay payload differs", 409);
          }
          const replay = await tx<Row[]>`SELECT * FROM conversation_tags WHERE id=${
            String(prior[0].result_id)
          } AND owner_id=${ownerId}`;
          if (!replay[0]) {
            throw new DomainError("idempotency_conflict", "Tag replay target is unavailable", 409);
          }
          return conversationTag(replay[0]);
        }
        const rows = await tx<
          Row[]
        >`INSERT INTO conversation_tags(owner_id,name,normalized_name,color) VALUES(${ownerId},${name},${
          canonicalWorkspaceName(name)
        },${color}) RETURNING *`;
        await tx`INSERT INTO operation_idempotency(owner_id,operation,idempotency_key,payload_hash,result_id) VALUES(${ownerId},'tag.create',${idempotencyKey},${fingerprint},${
          String(rows[0].id)
        })`;
        return conversationTag(rows[0]);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("name_conflict", "A tag with that name already exists", 409);
      }
      throw error;
    }
  }
  async updateConversationTag(
    ownerId: string,
    id: string,
    patch: { name?: string; color?: string; expectedVersion: number },
  ) {
    const name = patch.name?.trim();
    try {
      const rows = await this.#sql<Row[]>`UPDATE conversation_tags SET name=COALESCE(${
        name ?? null
      },name),normalized_name=CASE WHEN ${name ?? null}::text IS NULL THEN normalized_name ELSE ${
        canonicalWorkspaceName(name ?? "")
      } END,color=COALESCE(${
        patch.color ?? null
      },color),version=version+1,updated_at=now() WHERE id=${id} AND owner_id=${ownerId} AND version=${patch.expectedVersion} RETURNING *`;
      if (!rows[0]) {
        const exists = await this.#sql<
          Row[]
        >`SELECT 1 FROM conversation_tags WHERE id=${id} AND owner_id=${ownerId}`;
        throw new DomainError(
          exists[0] ? "version_conflict" : "not_found",
          exists[0] ? "Tag changed in another request" : "Tag not found",
          exists[0] ? 409 : 404,
        );
      }
      return conversationTag(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("name_conflict", "A tag with that name already exists", 409);
      }
      throw error;
    }
  }
  async deleteConversationTag(ownerId: string, id: string, expectedVersion: number) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-workspace'),hashtext(${ownerId}))`;
      const tag = await tx<
        Row[]
      >`SELECT * FROM conversation_tags WHERE id=${id} AND owner_id=${ownerId} FOR UPDATE`;
      if (!tag[0]) throw new DomainError("not_found", "Tag not found", 404);
      if (number(tag[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Tag changed in another request", 409);
      }
      const affected = await tx<
        Row[]
      >`SELECT DISTINCT conversation_id FROM conversation_tag_bindings WHERE tag_id=${id} ORDER BY conversation_id`;
      if (affected.length) {
        const ids = affected.map((x) => String(x.conversation_id));
        await tx`SELECT 1 FROM conversation_tag_sets WHERE conversation_id=ANY(${
          tx.array(ids)
        }::uuid[]) ORDER BY conversation_id FOR UPDATE`;
        await tx`UPDATE conversation_tag_sets SET version=version+1,updated_at=now() WHERE conversation_id=ANY(${
          tx.array(ids)
        }::uuid[])`;
      }
      await tx`DELETE FROM conversation_tags WHERE id=${id}`;
    });
  }
  async replaceConversationTags(
    ownerId: string,
    conversationId: string,
    ids: string[],
    expected: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-workspace'),hashtext(${ownerId}))`;
      const chats = await tx<
        Row[]
      >`SELECT id,temporary,deleted_at FROM conversations WHERE id=${conversationId} AND owner_id=${ownerId} FOR UPDATE`;
      if (!chats[0]) throw new DomainError("not_found", "Conversation not found", 404);
      if (chats[0].temporary || chats[0].deleted_at) {
        throw new DomainError(
          "conversation_not_organizable",
          "Temporary or deleted conversations cannot be organized",
          409,
        );
      }
      await tx`INSERT INTO conversation_tag_sets(conversation_id,owner_id) VALUES(${conversationId},${ownerId}) ON CONFLICT DO NOTHING`;
      const sets = await tx<
        Row[]
      >`SELECT * FROM conversation_tag_sets WHERE conversation_id=${conversationId} AND owner_id=${ownerId} FOR UPDATE`;
      if (number(sets[0].version) !== expected) {
        throw new DomainError("version_conflict", "Conversation tags changed", 409);
      }
      const tags = ids.length
        ? await tx<Row[]>`SELECT id FROM conversation_tags WHERE owner_id=${ownerId} AND id=ANY(${
          tx.array(ids)
        }::uuid[])`
        : [];
      if (tags.length !== ids.length) throw new DomainError("not_found", "Tag not found", 404);
      await tx`DELETE FROM conversation_tag_bindings WHERE conversation_id=${conversationId}`;
      for (const id of ids) {
        await tx`INSERT INTO conversation_tag_bindings(conversation_id,tag_id,owner_id) VALUES(${conversationId},${id},${ownerId})`;
      }
      const updated = (await tx<
        Row[]
      >`UPDATE conversation_tag_sets SET version=version+1,updated_at=now() WHERE conversation_id=${conversationId} RETURNING *`)[
        0
      ];
      return {
        tagSet: tagSet(updated),
        bindings: (await tx<
          Row[]
        >`SELECT * FROM conversation_tag_bindings WHERE conversation_id=${conversationId} ORDER BY tag_id`)
          .map(tagBinding),
      };
    });
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
      await lockReferenceableAttachments(
        tx,
        input.message.ownerId,
        attachmentIds,
        "attachment_not_ready",
        "Attachment is not ready",
      );
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
      >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,recovery_owner,status,reserved_micros,pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source,generation_lease_token,generation_lease_expires_at) VALUES(${input.runId},${input.message.ownerId},${
        input.tokenId ?? null
      },${
        input.message.model ?? "unknown"
      },${input.provider},'provider','reserved',${input.reserveMicros},${
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
      for (const [position, attachmentId] of attachmentIds.entries()) {
        await tx`
          INSERT INTO message_attachments(message_id,attachment_id,position)
          VALUES(${String(nodes[0].id)},${attachmentId},${position})
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
      >`INSERT INTO usage_runs(id,user_id,model,provider,recovery_owner,status,reserved_micros,
        pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,
        pricing_reasoning_micros_per_million,pricing_output_micros_per_million,
        pricing_fixed_call_micros,pricing_source,generation_lease_token,generation_lease_expires_at)
        VALUES(${input.runId},${input.ownerId},${input.model},${input.provider},'provider','reserved',${input.reserveMicros},${
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
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='generation_lease_expired',breaker_after='unavailable',retryable=true,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${String(row.id)} AND status='running'`;
        const account = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        const actualCost = 0;
        const amount = number(row.reserved_micros) - actualCost;
        const after = number(account[0].balance_micros) + amount;
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        if (amount !== 0) {
          await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
            String(row.id)
          },${amount > 0 ? "refund" : "settle"},${amount},${after})`;
        }
        await tx`UPDATE usage_runs SET status='failed',cost_micros=${actualCost},input_tokens=0,
          output_tokens=0,generation_lease_token=NULL,generation_lease_expires_at=NULL,
          run_lease_token=NULL,run_lease_expires_at=NULL,error='generation lease expired',
          completed_at=now() WHERE id=${String(row.id)}`;
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

  async createAttachment(
    input: CreateAttachmentInput,
    quota?: AttachmentStorageQuota,
  ): Promise<CreateAttachmentResult> {
    validateAttachmentInput(input);
    validateAttachmentStorageQuota(quota);
    return await this.#sql.begin((tx) => this.#createAttachment(tx, input, quota));
  }

  async #createAttachment(
    tx: postgres.TransactionSql,
    input: CreateAttachmentInput,
    quota?: AttachmentStorageQuota,
  ): Promise<CreateAttachmentResult> {
    const requiredInspectionMode = input.requiredInspectionMode ?? "local";
    const inspectionPolicyVersion = input.inspectionPolicyVersion ??
      ATTACHMENT_INSPECTION_POLICY_VERSION;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`attachment-dedup:${input.ownerId}:${input.sha256}`},0))`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.objectKey},0))`;
    const stagedObject = await tx`SELECT id FROM attachment_upload_staging
        WHERE object_key=${input.objectKey} LIMIT 1`;
    if (stagedObject.length) {
      throw new DomainError(
        "upload_stage_conflict",
        "Attachment object is controlled by a browser upload stage",
        409,
      );
    }
    const owner = await tx`SELECT id FROM users WHERE id=${input.ownerId} FOR UPDATE`;
    if (!owner.length) throw new DomainError("not_found", "User not found", 404);
    const existing = await tx<
      Row[]
    >`SELECT * FROM attachments WHERE owner_id=${input.ownerId} AND sha256=${input.sha256}
        AND required_inspection_mode=${requiredInspectionMode}
        AND inspection_policy_version=${inspectionPolicyVersion}
        AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE`;
    let record = existing[0];
    const deduplicated = Boolean(record);
    if (record) {
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
    } else {
      const objectConflict = await tx`
          SELECT id FROM attachments WHERE object_key=${input.objectKey} LIMIT 1`;
      if (objectConflict.length) {
        throw new DomainError("object_key_taken", "Attachment object key already exists", 409);
      }
      await admitAttachmentStorage(tx, input, quota);
      const inserted = await tx<
        Row[]
      >`INSERT INTO attachments(owner_id,object_key,filename,mime_type,size_bytes,sha256,state,
          inspection_error,required_inspection_mode,inspection_policy_version,ingestion_status)
          VALUES(${input.ownerId},${input.objectKey},${input.filename},${input.mimeType},
          ${input.sizeBytes},${input.sha256},${input.state ?? "pending"},${
        input.inspectionError ?? null
      },${requiredInspectionMode},${inspectionPolicyVersion},${
        input.state === "ready" && isIngestibleDocumentMime(input.mimeType)
          ? "queued"
          : "not_applicable"
      }) RETURNING *`;
      record = inserted[0];
    }
    const attachmentId = String(record.id);
    const inspectionEpoch = number(record.inspection_epoch ?? 1);
    const idempotencyKey = `attachment.inspect:${attachmentId}:${inspectionEpoch}`;
    const jobs = input.inspectionComplete ? [] : await tx<
      Row[]
    >`INSERT INTO jobs(type,payload,idempotency_key) VALUES('attachment.inspect',${
      tx.json({
        attachmentId,
        ownerId: input.ownerId,
        inspectionEpoch,
        requiredInspectionMode: String(record.required_inspection_mode),
        inspectionPolicyVersion: String(record.inspection_policy_version),
      })
    },${idempotencyKey}) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`;
    if (String(record.ingestion_status) === "queued") {
      await tx`INSERT INTO jobs(type,payload,idempotency_key) VALUES('attachment.ingest',${
        tx.json({ attachmentId, ownerId: input.ownerId })
      },${`attachment.ingest:${attachmentId}`}) ON CONFLICT(idempotency_key) DO NOTHING`;
    }
    return {
      attachment: attachment(record),
      inspectionJobId: jobs[0] ? String(jobs[0].id) : null,
      deduplicated,
    };
  }

  async createAttachmentFromGeneratedObjectStage(
    id: string,
    ownerId: string,
    input: CreateAttachmentInput,
    quota?: AttachmentStorageQuota,
  ): Promise<CreateAttachmentResult> {
    validateAttachmentInput(input);
    validateAttachmentStorageQuota(quota);
    return await this.#sql.begin(async (tx) => {
      const stages = await tx<Row[]>`SELECT * FROM generated_object_staging
        WHERE id=${id} AND owner_id=${ownerId} FOR UPDATE`;
      const stage = stages[0];
      if (!stage) throw new DomainError("not_found", "Generated object stage not found", 404);
      if (
        String(stage.state) !== "stored" || input.ownerId !== ownerId ||
        String(stage.object_key) !== input.objectKey ||
        number(stage.size_bytes) !== input.sizeBytes ||
        String(stage.sha256) !== input.sha256 ||
        String(stage.mime_type) !== input.mimeType
      ) {
        throw new DomainError("generated_stage_conflict", "Generated object stage changed", 409);
      }
      const created = await this.#createAttachment(tx, input, quota);
      const referenceable = await tx`SELECT id FROM attachments
        WHERE id=${created.attachment.id} AND owner_id=${ownerId}
          AND state='ready' AND deleted_at IS NULL AND physical_object FOR UPDATE`;
      if (!referenceable.length) {
        throw new DomainError(
          "generated_stage_conflict",
          "Generated object attachment is not ready",
          409,
        );
      }
      const attached = await tx`UPDATE generated_object_staging SET state='attached',
        attachment_id=${created.attachment.id},
        cleanup_attachment=${created.attachment.objectKey === String(stage.object_key)},
        updated_at=now() WHERE id=${id} AND owner_id=${ownerId} AND state='stored'
        RETURNING id`;
      if (!attached.length) {
        throw new DomainError("generated_stage_conflict", "Generated object stage changed", 409);
      }
      return created;
    });
  }

  async stageAttachmentUpload(input: StageAttachmentUploadInput, leaseSeconds: number) {
    validateAttachmentInput({
      ownerId: input.ownerId,
      objectKey: input.objectKey,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    });
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) {
      throw new DomainError("validation_error", "Attachment upload lease is invalid", 422);
    }
    const rows = await this.#sql<Row[]>`
      INSERT INTO attachment_upload_staging(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,upload_lease_expires_at
      ) VALUES(${input.id},${input.ownerId},${input.objectKey},${input.filename},
        ${input.mimeType},${input.sizeBytes},${input.sha256},
        now()+${leaseSeconds}*interval '1 second')
      ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING *`;
    const stage = attachmentUploadStage(rows[0]);
    if (
      stage.ownerId !== input.ownerId || stage.objectKey !== input.objectKey ||
      stage.filename !== input.filename || stage.mimeType !== input.mimeType ||
      stage.sizeBytes !== input.sizeBytes || stage.sha256 !== input.sha256
    ) throw new DomainError("idempotency_conflict", "Attachment upload stage differs", 409);
    return stage;
  }

  async markAttachmentUploadStored(
    id: string,
    ownerId: string,
    uploadLeaseToken: string,
    leaseSeconds: number,
  ) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) {
      throw new DomainError("validation_error", "Attachment upload lease is invalid", 422);
    }
    const rows = await this.#sql<Row[]>`UPDATE attachment_upload_staging
      SET state='stored',upload_lease_expires_at=now()+${leaseSeconds}*interval '1 second',
        updated_at=now() WHERE id=${id} AND owner_id=${ownerId}
        AND upload_lease_token=${uploadLeaseToken} AND upload_lease_expires_at>now()
        AND state IN('pending','stored') RETURNING *`;
    if (!rows[0]) {
      throw new DomainError("upload_stage_conflict", "Attachment upload stage changed", 409);
    }
    return attachmentUploadStage(rows[0]);
  }

  async heartbeatAttachmentUpload(
    id: string,
    ownerId: string,
    uploadLeaseToken: string,
    leaseSeconds: number,
  ) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) {
      throw new DomainError("validation_error", "Attachment upload lease is invalid", 422);
    }
    const rows = await this.#sql<Row[]>`UPDATE attachment_upload_staging
      SET upload_lease_expires_at=now()+${leaseSeconds}*interval '1 second',updated_at=now()
      WHERE id=${id} AND owner_id=${ownerId} AND upload_lease_token=${uploadLeaseToken}
        AND upload_lease_expires_at>now() AND state IN('pending','stored') RETURNING *`;
    if (!rows[0]) {
      throw new DomainError("upload_stage_conflict", "Attachment upload stage changed", 409);
    }
    return attachmentUploadStage(rows[0]);
  }

  async createAttachmentFromUploadStage(
    id: string,
    ownerId: string,
    uploadLeaseToken: string,
    input: CreateAttachmentInput,
    quota?: AttachmentStorageQuota,
  ) {
    validateAttachmentInput(input);
    validateAttachmentStorageQuota(quota);
    if (input.ownerId !== ownerId) {
      throw new DomainError("upload_stage_conflict", "Attachment upload owner differs", 409);
    }
    const requiredInspectionMode = input.requiredInspectionMode ?? "local";
    const inspectionPolicyVersion = input.inspectionPolicyVersion ??
      ATTACHMENT_INSPECTION_POLICY_VERSION;
    return await this.#sql.begin(async (tx) => {
      const stages = await tx<Row[]>`SELECT * FROM attachment_upload_staging
        WHERE id=${id} AND owner_id=${ownerId} AND upload_lease_token=${uploadLeaseToken}
          AND upload_lease_expires_at>now() FOR UPDATE`;
      const stage = stages[0] ? attachmentUploadStage(stages[0]) : undefined;
      if (
        !stage || stage.state !== "stored" || stage.objectKey !== input.objectKey ||
        stage.filename !== input.filename || stage.mimeType !== input.mimeType ||
        stage.sizeBytes !== input.sizeBytes || stage.sha256 !== input.sha256
      ) throw new DomainError("upload_stage_conflict", "Attachment upload stage differs", 409);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`attachment-dedup:${ownerId}:${input.sha256}`},0))`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.objectKey},0))`;
      const existing = await tx<Row[]>`SELECT * FROM attachments
        WHERE owner_id=${ownerId} AND sha256=${input.sha256}
          AND required_inspection_mode=${requiredInspectionMode}
          AND inspection_policy_version=${inspectionPolicyVersion}
          AND deleted_at IS NULL
        ORDER BY created_at,id LIMIT 1 FOR UPDATE`;
      if (existing[0]) {
        if (
          number(existing[0].size_bytes) !== input.sizeBytes ||
          String(existing[0].mime_type) !== input.mimeType
        ) {
          throw new DomainError(
            "attachment_hash_conflict",
            "Attachment digest metadata differs",
            409,
          );
        }
        await tx`UPDATE attachment_upload_staging SET state='cleanup_pending',
          cleanup_error='deduplicated browser upload',updated_at=now() WHERE id=${id}`;
        await tx`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
          VALUES('attachment_object.cleanup',${tx.json({ stageId: id, ownerId })},
            ${`attachment_object.cleanup:${id}`},'queued',0,${stages[0]
          .upload_lease_expires_at as Date})
          ON CONFLICT(idempotency_key) DO NOTHING`;
        return {
          attachment: attachment(existing[0]),
          inspectionJobId: null,
          deduplicated: true,
        };
      }
      const conflict = await tx`SELECT 1 FROM attachments WHERE object_key=${input.objectKey}
        LIMIT 1`;
      if (conflict.length) {
        throw new DomainError("object_key_taken", "Attachment object key already exists", 409);
      }
      await admitAttachmentStorage(tx, input, quota);
      const inserted = await tx<Row[]>`INSERT INTO attachments(
        owner_id,object_key,filename,mime_type,size_bytes,sha256,state,inspection_error,
        required_inspection_mode,inspection_policy_version,ingestion_status
      ) VALUES(${ownerId},${input.objectKey},${input.filename},${input.mimeType},
        ${input.sizeBytes},${input.sha256},${input.state ?? "pending"},
        ${input.inspectionError ?? null},${requiredInspectionMode},${inspectionPolicyVersion},${
        input.state === "ready" && isIngestibleDocumentMime(input.mimeType)
          ? "queued"
          : "not_applicable"
      }) RETURNING *`;
      const record = inserted[0];
      const attachmentId = String(record.id);
      const inspectionEpoch = number(record.inspection_epoch ?? 1);
      let inspectionJobId: string | null = null;
      if (!input.inspectionComplete) {
        const jobs = await tx<Row[]>`INSERT INTO jobs(type,payload,idempotency_key)
          VALUES('attachment.inspect',${
          tx.json({
            attachmentId,
            ownerId,
            inspectionEpoch,
            requiredInspectionMode: String(record.required_inspection_mode),
            inspectionPolicyVersion: String(record.inspection_policy_version),
          })
        },${`attachment.inspect:${attachmentId}:${inspectionEpoch}`}) RETURNING id`;
        inspectionJobId = String(jobs[0].id);
      }
      if (String(record.ingestion_status) === "queued") {
        await tx`INSERT INTO jobs(type,payload,idempotency_key)
          VALUES('attachment.ingest',${tx.json({ attachmentId, ownerId })},
            ${`attachment.ingest:${attachmentId}`}) ON CONFLICT(idempotency_key) DO NOTHING`;
      }
      await tx`UPDATE attachment_upload_staging SET state='finalized',
        attachment_id=${attachmentId},cleanup_error=NULL,upload_lease_expires_at=now(),
        updated_at=now() WHERE id=${id}`;
      return { attachment: attachment(record), inspectionJobId, deduplicated: false };
    });
  }

  async requestAttachmentUploadCleanup(
    id: string,
    ownerId: string,
    uploadLeaseToken: string,
    reason: string,
  ) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`UPDATE attachment_upload_staging
        SET state='cleanup_pending',cleanup_error=${reason.slice(0, 1000)},updated_at=now()
        WHERE id=${id} AND owner_id=${ownerId} AND upload_lease_token=${uploadLeaseToken}
          AND state IN('pending','stored','cleanup_pending','cleaning','cleaned') RETURNING *`;
      if (!rows[0]) {
        throw new DomainError("upload_stage_conflict", "Attachment upload stage changed", 409);
      }
      await tx`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
        VALUES('attachment_object.cleanup',${tx.json({ stageId: id, ownerId })},
          ${`attachment_object.cleanup:${id}`},'queued',0,${rows[0]
        .upload_lease_expires_at as Date})
        ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',
          attempts=0,
          available_at=EXCLUDED.available_at,
          last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL
        WHERE jobs.status IN('completed','failed')`;
      return attachmentUploadStage(rows[0]);
    });
  }

  async abandonAttachmentUpload(id: string, ownerId: string, reason: string) {
    const rows = await this.#sql<Row[]>`UPDATE attachment_upload_staging
      SET state='abandoned',cleanup_error=${reason.slice(0, 1000)},updated_at=now()
      WHERE id=${id} AND owner_id=${ownerId} AND state IN('pending','abandoned')
      RETURNING *`;
    if (!rows[0]) {
      throw new DomainError("upload_stage_conflict", "Attachment upload stage changed", 409);
    }
    return attachmentUploadStage(rows[0]);
  }

  async stageFileUpload(input: StageFileUploadInput) {
    if (input.purpose !== "assistants") {
      throw new DomainError("unsupported_purpose", "File purpose is not supported", 422);
    }
    validateAttachmentInput({
      ownerId: input.ownerId,
      objectKey: input.objectKey,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      state: input.attachmentState,
      inspectionError: input.inspectionError,
    });
    if (!isCanonicalFileUploadObjectKey(input.ownerId, input.sha256, input.objectKey)) {
      throw new DomainError("validation_error", "File upload object key is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.objectKey},0))`;
      const requests = await tx<Row[]>`
        SELECT * FROM api_idempotency_requests WHERE id=${input.requestId} FOR UPDATE`;
      if (
        !requests[0] || String(requests[0].endpoint) !== "files" ||
        String(requests[0].user_id) !== input.ownerId
      ) throw new DomainError("idempotency_conflict", "File upload stage owner differs", 409);
      const rows = await tx<Row[]>`
        INSERT INTO file_upload_staging(request_id,owner_id,object_key,filename,mime_type,
          size_bytes,sha256,purpose,attachment_state,inspection_error,
          required_inspection_mode,inspection_policy_version)
        VALUES(${input.requestId},${input.ownerId},${input.objectKey},${input.filename},
          ${input.mimeType},${input.sizeBytes},${input.sha256},${input.purpose},
          ${input.attachmentState},${input.inspectionError},${input.requiredInspectionMode},
          ${input.inspectionPolicyVersion})
        ON CONFLICT(request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING *`;
      const stage = fileUploadStage(rows[0]);
      if (
        stage.ownerId !== input.ownerId || stage.objectKey !== input.objectKey ||
        stage.filename !== input.filename || stage.mimeType !== input.mimeType ||
        stage.sizeBytes !== input.sizeBytes || stage.sha256 !== input.sha256 ||
        stage.purpose !== input.purpose || stage.attachmentState !== input.attachmentState ||
        stage.inspectionError !== input.inspectionError ||
        stage.requiredInspectionMode !== input.requiredInspectionMode ||
        stage.inspectionPolicyVersion !== input.inspectionPolicyVersion
      ) throw new DomainError("idempotency_conflict", "File upload stage differs", 409);
      return stage;
    });
  }
  async markFileUploadStored(requestId: string, leaseToken: string) {
    const rows = await this.#sql<Row[]>`
      UPDATE file_upload_staging s SET state='stored',updated_at=now()
      FROM api_idempotency_requests r WHERE s.request_id=${requestId}
        AND r.id=s.request_id AND r.state='in_progress' AND r.lease_token=${leaseToken}
        AND r.lease_expires_at>now() AND s.state IN ('pending','stored') RETURNING s.*`;
    if (!rows[0]) throw new DomainError("stale_lease", "File upload lease is stale", 409);
    return fileUploadStage(rows[0]);
  }
  async listStaleFileUploads(limit = 100) {
    const rows = await this.#sql<Row[]>`
      SELECT s.*,row_to_json(r.*) request FROM file_upload_staging s
        JOIN api_idempotency_requests r
        ON r.id=s.request_id WHERE s.state<>'finalized' AND r.state='in_progress'
        AND r.lease_expires_at<=now() ORDER BY r.lease_expires_at LIMIT ${limit}`;
    return rows.map((row) => ({
      stage: fileUploadStage(row),
      request: apiRequest(row.request as Row),
    }));
  }
  async attachmentObjectReferenceCount(objectKey: string) {
    const rows = await this.#sql<{ count: number }[]>`
      SELECT count(*)::int count FROM attachments
      WHERE object_key=${objectKey} AND deleted_at IS NULL`;
    return rows[0]?.count ?? 0;
  }

  async finalizeFileUpload(
    input: FinalizeFileUploadInput,
    quota?: AttachmentStorageQuota,
  ): Promise<FinalizeFileUploadResult> {
    validateAttachmentInput(input.attachment);
    validateAttachmentStorageQuota(quota);
    if (
      input.request.responseStatus !== 201 || input.request.costMicros !== 0 ||
      input.request.inputTokens !== 0 || input.request.outputTokens !== 0
    ) throw new DomainError("validation_error", "File completion accounting is invalid", 422);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.attachment.objectKey},0))`;
      const requests = await tx<Row[]>`
        SELECT *,lease_expires_at>now() AS lease_active
        FROM api_idempotency_requests WHERE id=${input.request.id} FOR UPDATE`;
      const request = requests[0];
      if (!request) throw new DomainError("not_found", "Idempotent request not found", 404);
      if (
        String(request.user_id) !== input.attachment.ownerId ||
        String(request.endpoint) !== "files" || String(request.model) !== "files/upload"
      ) throw new DomainError("idempotency_conflict", "File completion owner differs", 409);
      if (String(request.state) === "completed") {
        let attachmentId: string | undefined;
        try {
          const parsed = JSON.parse(String(request.response_body ?? "{}"));
          if (typeof parsed.id === "string") attachmentId = parsed.id;
        } catch {
          // Converted to a categorical corruption error below.
        }
        const prior = attachmentId
          ? await tx<Row[]>`SELECT * FROM attachments WHERE id=${attachmentId}
            AND owner_id=${input.attachment.ownerId}`
          : [];
        if (!prior[0]) {
          throw new DomainError("idempotency_corrupt", "Stored file replay is invalid", 500);
        }
        return {
          attachment: attachment(prior[0]),
          request: apiRequest(request),
        };
      }
      if (
        String(request.state) !== "in_progress" ||
        String(request.lease_token) !== input.request.leaseToken ||
        request.lease_active !== true
      ) throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
      const owners = await tx`
        SELECT id FROM users WHERE id=${input.attachment.ownerId} FOR UPDATE`;
      if (!owners.length) throw new DomainError("not_found", "User not found", 404);
      const stages = await tx<Row[]>`
        SELECT * FROM file_upload_staging WHERE request_id=${input.request.id} FOR UPDATE`;
      const stage = stages[0] ? fileUploadStage(stages[0]) : undefined;
      if (
        !stage || stage.state !== "stored" ||
        stage.ownerId !== input.attachment.ownerId ||
        stage.objectKey !== input.attachment.objectKey ||
        stage.filename !== input.attachment.filename ||
        stage.mimeType !== input.attachment.mimeType ||
        stage.sizeBytes !== input.attachment.sizeBytes ||
        stage.sha256 !== input.attachment.sha256 ||
        stage.attachmentState !== (input.attachment.state ?? "pending") ||
        stage.inspectionError !== (input.attachment.inspectionError ?? null) ||
        stage.requiredInspectionMode !== (input.attachment.requiredInspectionMode ?? "local") ||
        stage.inspectionPolicyVersion !==
          (input.attachment.inspectionPolicyVersion ?? ATTACHMENT_INSPECTION_POLICY_VERSION)
      ) throw new DomainError("file_upload_stage_conflict", "File upload stage differs", 409);
      const peers = await tx<Row[]>`
        SELECT * FROM attachments WHERE object_key=${input.attachment.objectKey}
          AND deleted_at IS NULL FOR UPDATE`;
      if (
        peers.some((peer) =>
          String(peer.owner_id) !== input.attachment.ownerId ||
          String(peer.sha256) !== input.attachment.sha256 ||
          number(peer.size_bytes) !== input.attachment.sizeBytes ||
          String(peer.mime_type) !== input.attachment.mimeType
        )
      ) throw new DomainError("object_key_taken", "Attachment object key already exists", 409);
      await admitAttachmentStorage(tx, input.attachment, quota);
      const requiredInspectionMode = input.attachment.requiredInspectionMode ?? "local";
      const inspectionPolicyVersion = input.attachment.inspectionPolicyVersion ??
        ATTACHMENT_INSPECTION_POLICY_VERSION;
      const inserted = await tx<Row[]>`
        INSERT INTO attachments(owner_id,object_key,filename,mime_type,size_bytes,sha256,state,
          inspection_error,required_inspection_mode,inspection_policy_version,ingestion_status)
        VALUES(${input.attachment.ownerId},${input.attachment.objectKey},
          ${input.attachment.filename},${input.attachment.mimeType},
          ${input.attachment.sizeBytes},${input.attachment.sha256},
          ${input.attachment.state ?? "pending"},${input.attachment.inspectionError ?? null},
          ${requiredInspectionMode},${inspectionPolicyVersion},${
        input.attachment.state === "ready" &&
          isIngestibleDocumentMime(input.attachment.mimeType)
          ? "queued"
          : "not_applicable"
      }) RETURNING *`;
      const record = inserted[0];
      const attachmentId = String(record.id);
      const inspectionEpoch = number(record.inspection_epoch ?? 1);
      if (!input.attachment.inspectionComplete) {
        await tx`INSERT INTO jobs(type,payload,idempotency_key)
          VALUES('attachment.inspect',${
          tx.json({
            attachmentId,
            ownerId: input.attachment.ownerId,
            inspectionEpoch,
            requiredInspectionMode: String(record.required_inspection_mode),
            inspectionPolicyVersion: String(record.inspection_policy_version),
          })
        },${`attachment.inspect:${attachmentId}:${inspectionEpoch}`})`;
      }
      if (String(record.ingestion_status) === "queued") {
        await tx`INSERT INTO jobs(type,payload,idempotency_key)
          VALUES('attachment.ingest',${
          tx.json({ attachmentId, ownerId: input.attachment.ownerId })
        },${`attachment.ingest:${attachmentId}`})`;
      }
      const materialized = attachment(record);
      const responseBody = input.responseBody(materialized);
      const responseBytes = new TextEncoder().encode(responseBody).length;
      const reservedBytes = number(request.replay_reserved_bytes ?? 0);
      if (
        responseBytes > API_SSE_REPLAY_REQUEST_MAX_BYTES ||
        (reservedBytes > 0 && responseBytes > reservedBytes)
      ) throw new DomainError("replay_quota_exceeded", "Reserved replay capacity exceeded", 429);
      const runs = await tx<Row[]>`
        SELECT * FROM usage_runs WHERE id=${String(request.usage_run_id)} FOR UPDATE`;
      if (!runs[0] || String(runs[0].status) !== "reserved") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      await tx`UPDATE usage_runs SET status='completed',cost_micros=0,input_tokens=0,
        output_tokens=0,latency_ms=${input.request.latencyMs},run_lease_token=NULL,
        run_lease_expires_at=NULL,completed_at=now()
        WHERE id=${String(request.usage_run_id)}`;
      const updated = await tx<Row[]>`
        UPDATE api_idempotency_requests SET state='completed',lease_token=NULL,
          lease_expires_at=NULL,response_status=201,response_headers=${
        tx.json((input.request.responseHeaders ?? {}) as postgres.JSONValue)
      },response_body=${responseBody},response_body_encoding='utf8',completed_at=now(),
          updated_at=now(),expires_at=now()+retention_seconds*interval '1 second'
        WHERE id=${input.request.id} RETURNING *`;
      await tx`UPDATE file_upload_staging SET state='finalized',attachment_id=${attachmentId},
        updated_at=now() WHERE request_id=${input.request.id}`;
      return { attachment: materialized, request: apiRequest(updated[0]) };
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

  async listAttachmentPage(
    ownerId: string,
    query: AttachmentListQuery,
  ): Promise<AttachmentPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 10_000) {
      throw new DomainError(
        "invalid_file_limit",
        "File list limit must be between 1 and 10000",
        400,
      );
    }
    if (query.order !== "asc" && query.order !== "desc") {
      throw new DomainError("invalid_file_order", "File list order must be asc or desc", 400);
    }

    let cursor: { id: string; created_at: string } | undefined;
    if (query.after !== undefined) {
      const cursorRows = await this.#sql<{ id: string; created_at: string }[]>`
        SELECT id,created_at::text AS created_at
        FROM attachments
        WHERE id=${query.after} AND owner_id=${ownerId}`;
      cursor = cursorRows[0];
      if (!cursor) {
        throw new DomainError(
          "invalid_file_cursor",
          "The file list cursor is invalid for this owner",
          400,
        );
      }
    }

    const fetchLimit = query.limit + 1;
    let rows: Row[];
    if (query.order === "asc") {
      rows = query.after === undefined
        ? await this.#sql<Row[]>`
          SELECT * FROM attachments
          WHERE owner_id=${ownerId} AND deleted_at IS NULL
          ORDER BY created_at ASC,id ASC LIMIT ${fetchLimit}`
        : await this.#sql<Row[]>`
          SELECT * FROM attachments
          WHERE owner_id=${ownerId} AND deleted_at IS NULL
            AND (created_at,id)>(${cursor!.created_at}::text::timestamptz,${cursor!.id}::uuid)
          ORDER BY created_at ASC,id ASC LIMIT ${fetchLimit}`;
    } else {
      rows = query.after === undefined
        ? await this.#sql<Row[]>`
          SELECT * FROM attachments
          WHERE owner_id=${ownerId} AND deleted_at IS NULL
          ORDER BY created_at DESC,id DESC LIMIT ${fetchLimit}`
        : await this.#sql<Row[]>`
          SELECT * FROM attachments
          WHERE owner_id=${ownerId} AND deleted_at IS NULL
            AND (created_at,id)<(${cursor!.created_at}::text::timestamptz,${cursor!.id}::uuid)
          ORDER BY created_at DESC,id DESC LIMIT ${fetchLimit}`;
    }
    return {
      data: rows.slice(0, query.limit).map(attachment),
      hasMore: rows.length > query.limit,
    };
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
    >`UPDATE attachments SET state='deleted',
      version=CASE WHEN deleted_at IS NULL THEN version+1 ELSE version END,
      deleted_at=COALESCE(deleted_at,now()),updated_at=now()
      WHERE id=${id} AND owner_id=${ownerId} RETURNING *`;
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
    if (
      expectedState === "inspecting" &&
      ["ready", "quarantined", "failed"].includes(nextState)
    ) {
      return await this.transitionAttachmentInspection({
        attachmentId: id,
        ownerId,
        inspectionEpoch: 1,
        expectedState,
        nextState: nextState as "ready" | "quarantined" | "failed",
        inspectionError,
      });
    }
    const allowed: Record<AttachmentState, AttachmentState[]> = {
      pending: ["inspecting", "deleted"],
      inspecting: ["deleted"],
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
        version=version+1,
        ingestion_status=CASE WHEN ${nextState}='ready' AND mime_type = ANY(${[
        ...INGESTIBLE_DOCUMENT_MIME_TYPES,
      ]}) THEN 'queued' ELSE ingestion_status END,
        ingestion_error=CASE WHEN ${nextState}='ready' THEN NULL ELSE ingestion_error END,
        deleted_at=CASE WHEN ${nextState}='deleted' THEN COALESCE(deleted_at,now()) ELSE deleted_at END,
        updated_at=now() WHERE id=${id} AND owner_id=${ownerId} AND state=${expectedState}
        AND inspection_epoch=1 RETURNING *`;
      if (rows[0] && nextState === "ready" && isIngestibleDocumentMime(String(rows[0].mime_type))) {
        await tx`INSERT INTO jobs(type,payload,idempotency_key) VALUES('attachment.ingest',${
          tx.json({ attachmentId: id, ownerId })
        },${`attachment.ingest:${id}`}) ON CONFLICT(idempotency_key) DO NOTHING`;
      }
      if (rows[0]) return attachment(rows[0]);
      const exists = await tx`SELECT id FROM attachments WHERE id=${id} AND owner_id=${ownerId}`;
      if (!exists.length) throw new DomainError("not_found", "Attachment not found", 404);
      const versioned = await tx`
        SELECT id FROM attachments WHERE id=${id} AND owner_id=${ownerId}
          AND inspection_epoch<>1`;
      if (versioned.length) {
        throw new DomainError(
          "attachment_inspection_conflict",
          "Versioned reinspection requires an epoch-bound transition",
          409,
        );
      }
      throw new DomainError("attachment_state_conflict", "Attachment state changed", 409);
    });
  }

  async requestAttachmentReinspection(
    input: RequestAttachmentReinspectionInput,
  ): Promise<AttachmentReinspectionResult> {
    const reason = validateAdminCommand(input, true)!;
    if (
      !["local", "external"].includes(input.requiredInspectionMode) ||
      input.inspectionPolicyVersion !== ATTACHMENT_INSPECTION_POLICY_VERSION
    ) throw new DomainError("validation_error", "Reinspection request is invalid", 422);
    return await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(tx, input.actorId);
      const rows = await tx<Row[]>`
        SELECT * FROM attachments WHERE id=${input.attachmentId} FOR UPDATE`;
      const prior = rows[0];
      if (!prior) throw new DomainError("not_found", "Attachment not found", 404);
      const eligibility = attachmentReinspectionEligibility(attachment(prior));
      if (eligibility.blockedReason === "deleted") {
        throw new DomainError(
          "attachment_deleted",
          "Deleted attachments cannot be reinspected",
          409,
        );
      }
      if (!eligibility.eligible) {
        throw new DomainError(
          "attachment_state_conflict",
          eligibility.blockedReason === "policy_quarantine"
            ? "This quarantine was issued by a non-retriable upload policy"
            : "Only terminal attachments can be reinspected",
          409,
        );
      }
      if (number(prior.version) !== input.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "Attachment was modified by another administrator",
          409,
        );
      }
      const updated = await tx<Row[]>`
        UPDATE attachments SET state='pending',inspection_error=NULL,
          inspection_epoch=inspection_epoch+1,
          required_inspection_mode=${input.requiredInspectionMode},
          inspection_policy_version=${input.inspectionPolicyVersion},
          version=version+1,updated_at=now()
        WHERE id=${input.attachmentId} RETURNING *`;
      const record = updated[0];
      const epoch = number(record.inspection_epoch);
      const key = `attachment.inspect:${input.attachmentId}:${epoch}`;
      const jobs = await tx<Row[]>`
        INSERT INTO jobs(type,payload,idempotency_key)
        VALUES('attachment.inspect',${
        tx.json({
          attachmentId: input.attachmentId,
          ownerId: String(record.owner_id),
          inspectionEpoch: epoch,
          requiredInspectionMode: String(record.required_inspection_mode),
          inspectionPolicyVersion: String(record.inspection_policy_version),
        })
      },${key})
        ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
        RETURNING id`;
      const jobId = String(jobs[0].id);
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${input.actorId},'attachment.reinspection_requested','attachment',${input.attachmentId},${
        tx.json({
          ownerId: String(record.owner_id),
          reason,
          before: {
            state: String(prior.state),
            inspectionEpoch: number(prior.inspection_epoch),
            requiredInspectionMode: String(prior.required_inspection_mode),
            inspectionPolicyVersion: String(prior.inspection_policy_version),
            version: number(prior.version),
          },
          after: {
            state: "pending",
            inspectionEpoch: epoch,
            requiredInspectionMode: String(record.required_inspection_mode),
            inspectionPolicyVersion: String(record.inspection_policy_version),
            version: number(record.version),
          },
          inspectionJobId: jobId,
        })
      })`;
      return { attachment: attachment(record), inspectionJobId: jobId };
    });
  }

  async transitionAttachmentInspection(
    input: TransitionAttachmentInspectionInput,
  ): Promise<AttachmentRecord> {
    const inspectionError = input.inspectionError?.trim() || null;
    const requiresReason = ["quarantined", "failed"].includes(input.nextState);
    if (
      !Number.isSafeInteger(input.inspectionEpoch) || input.inspectionEpoch < 1 ||
      (input.expectedState === "pending" && input.nextState !== "inspecting") ||
      (input.expectedState === "inspecting" &&
        !["ready", "quarantined", "failed"].includes(input.nextState)) ||
      (requiresReason ? inspectionError === null : inspectionError !== null) ||
      (inspectionError !== null && inspectionError.length > 1_000)
    ) throw new DomainError("validation_error", "Attachment inspection transition is invalid", 422);
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`
        UPDATE attachments SET state=${input.nextState},
          inspection_error=${inspectionError},version=version+1,
          ingestion_status=CASE
            WHEN ${input.nextState}='ready'
              AND ingestion_status<>'ready'
              AND mime_type=ANY(${[...INGESTIBLE_DOCUMENT_MIME_TYPES]})
            THEN 'queued' ELSE ingestion_status END,
          ingestion_error=CASE WHEN ${input.nextState}='ready' THEN NULL ELSE ingestion_error END,
          updated_at=now()
        WHERE id=${input.attachmentId} AND owner_id=${input.ownerId}
          AND deleted_at IS NULL AND inspection_epoch=${input.inspectionEpoch}
          AND state=${input.expectedState}
        RETURNING *`;
      if (!rows[0]) {
        const exists = await tx`
          SELECT id FROM attachments WHERE id=${input.attachmentId}
            AND owner_id=${input.ownerId}`;
        if (!exists.length) throw new DomainError("not_found", "Attachment not found", 404);
        throw new DomainError(
          "attachment_inspection_conflict",
          "Attachment inspection epoch or state changed",
          409,
        );
      }
      if (
        input.nextState === "ready" && String(rows[0].ingestion_status) === "queued"
      ) {
        await tx`INSERT INTO jobs(type,payload,idempotency_key)
          VALUES('attachment.ingest',${
          tx.json({ attachmentId: input.attachmentId, ownerId: input.ownerId })
        },${`attachment.ingest:${input.attachmentId}`})
          ON CONFLICT(idempotency_key) DO NOTHING`;
      }
      if (["ready", "quarantined", "failed"].includes(input.nextState)) {
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(NULL,'attachment.inspection.completed','attachment',${input.attachmentId},${
          tx.json({
            ownerId: input.ownerId,
            inspectionEpoch: input.inspectionEpoch,
            outcome: input.nextState,
            reason: inspectionError,
          })
        })`;
      }
      return attachment(rows[0]);
    });
  }

  async attachmentStorageUsage(ownerId: string): Promise<AttachmentStorageUsage> {
    const rows = await this.#sql<Row[]>`
      SELECT physical_bytes,physical_objects FROM attachment_storage_usage
      WHERE owner_id=${ownerId}`;
    return {
      ownerId,
      physicalBytes: number(rows[0]?.physical_bytes ?? 0),
      physicalObjects: number(rows[0]?.physical_objects ?? 0),
    };
  }

  async adminStorageSummary(actorId: string): Promise<AdminStorageSummary> {
    return await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(tx, actorId);
      const rows = await tx<Row[]>`
        SELECT installation.physical_bytes,installation.physical_objects,
          (SELECT count(*) FROM attachments) attachment_records,
          (SELECT count(*) FROM attachments WHERE deleted_at IS NULL) active_records,
          (SELECT count(*) FROM attachments WHERE deleted_at IS NOT NULL) deleted_records,
          (SELECT count(*) FROM attachments
            WHERE deleted_at IS NULL AND state='quarantined') quarantined_records,
          (SELECT count(*) FROM attachment_storage_usage
            WHERE physical_objects>0) owners_with_storage
        FROM attachment_storage_installation installation WHERE singleton_id=1`;
      const row = rows[0];
      return {
        physicalBytes: number(row.physical_bytes),
        physicalObjects: number(row.physical_objects),
        attachmentRecords: number(row.attachment_records),
        activeRecords: number(row.active_records),
        deletedRecords: number(row.deleted_records),
        quarantinedRecords: number(row.quarantined_records),
        ownersWithStorage: number(row.owners_with_storage),
      };
    });
  }

  async listAdminAttachments(
    actorId: string,
    query: AdminAttachmentQuery,
  ): Promise<AdminAttachmentPage> {
    const limit = query.limit ?? 50;
    const deletion = query.deletion ?? "present";
    if (
      !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      (query.ownerId !== undefined && !UUID_PATTERN.test(query.ownerId)) ||
      !["present", "deleted", "all"].includes(deletion)
    ) throw new DomainError("validation_error", "Attachment inventory query is invalid", 422);
    const cursor = query.cursor ? decodeAdminAttachmentCursor(query.cursor, query) : undefined;
    if (query.cursor && !cursor) {
      throw new DomainError("invalid_cursor", "Attachment inventory cursor is invalid", 400);
    }
    const fetchLimit = limit + 1;
    return await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(tx, actorId);
      const rows = await tx<Row[]>`
        SELECT attachments.*,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            AS created_at_cursor
        FROM attachments
        WHERE (${query.ownerId ?? null}::uuid IS NULL OR owner_id=${query.ownerId ?? null}::uuid)
          AND (${query.state ?? null}::text IS NULL OR state=${query.state ?? null}::text)
          AND (${deletion}='all'
            OR (${deletion}='deleted' AND deleted_at IS NOT NULL)
            OR (${deletion}='present' AND deleted_at IS NULL))
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (created_at,id)<(
              ${cursor?.createdAt ?? null}::timestamptz,
              ${cursor?.id ?? null}::uuid
            ))
        ORDER BY created_at DESC,id DESC LIMIT ${fetchLimit}`;
      const project = (row: Row): AdminAttachmentSummary => {
        const item = attachment(row);
        return {
          id: item.id,
          ownerId: item.ownerId,
          filename: item.filename,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          state: item.state,
          inspectionError: item.inspectionError,
          inspectionEpoch: item.inspectionEpoch,
          version: item.version,
          reinspectionEligible: attachmentReinspectionEligibility(item).eligible,
          reinspectionBlockedReason: attachmentReinspectionEligibility(item).blockedReason,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          deletedAt: item.deletedAt,
        };
      };
      return {
        data: rows.slice(0, limit).map(project),
        nextCursor: rows.length > limit
          ? encodeAdminAttachmentCursor(
            String(rows[limit - 1].created_at_cursor),
            String(rows[limit - 1].id),
            query,
          )
          : null,
      };
    });
  }

  async linkAttachmentToMessage(messageId: string, attachmentId: string, ownerId: string) {
    await this.#sql.begin(async (tx) => {
      const ready = await lockReferenceableAttachments(
        tx,
        ownerId,
        [attachmentId],
        "attachment_not_ready",
        "Message or ready attachment not found",
      ).catch((error) => {
        if (error instanceof DomainError && error.code === "attachment_not_ready") return [];
        throw error;
      });
      const message = await tx`SELECT m.id FROM messages m JOIN conversations c
        ON c.id=m.conversation_id WHERE m.id=${messageId} AND c.owner_id=${ownerId} FOR UPDATE OF m`;
      if (!ready.length || !message.length) {
        throw new DomainError("attachment_not_ready", "Message or ready attachment not found", 409);
      }
      await tx`INSERT INTO message_attachments(message_id,attachment_id,position)
        SELECT ${messageId},${attachmentId},count(*)::int FROM message_attachments
        WHERE message_id=${messageId} ON CONFLICT DO NOTHING`;
    });
  }

  async listMessageAttachments(messageId: string, ownerId: string) {
    const message = await this
      .#sql`SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=${messageId} AND c.owner_id=${ownerId}`;
    if (!message.length) throw new DomainError("not_found", "Message not found", 404);
    return (await this.#sql<
      Row[]
    >`SELECT a.* FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id WHERE ma.message_id=${messageId} ORDER BY ma.position`)
      .map(attachment);
  }

  async finalizeGeneratedAssets(input: FinalizeGeneratedAssetsInput) {
    validateGeneratedAssetFinalization(input);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.ownerId}:${input.idempotencyKey}`},0))`;
      const priorRows = await tx<Row[]>`
        SELECT ga.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'attachmentId',gai.attachment_id,'role',gai.role,'ordinal',gai.ordinal,
          'width',gai.width,'height',gai.height,'hasAlpha',gai.has_alpha)
          ORDER BY gai.role,gai.ordinal,gai.attachment_id)
          FROM generated_asset_inputs gai WHERE gai.generated_asset_id=ga.id),'[]'::jsonb) AS inputs
        FROM generated_assets ga
        WHERE ga.owner_id=${input.ownerId} AND ga.idempotency_key=${input.idempotencyKey}
        ORDER BY ga.ordinal FOR UPDATE`;
      if (priorRows.length) {
        const prior = priorRows.map(generatedAsset);
        if (!sameGeneratedAssetFinalization(prior, input)) {
          throw new DomainError(
            "idempotency_conflict",
            "Generated asset replay payload differs",
            409,
          );
        }
        return prior;
      }
      const runRows = await tx<Row[]>`SELECT * FROM usage_runs WHERE id=${input.usageRunId}
        AND user_id=${input.ownerId} FOR UPDATE`;
      if (!runRows.length) throw new DomainError("not_found", "Usage run not found", 404);
      const used = await tx`SELECT id FROM generated_assets WHERE usage_run_id=${input.usageRunId}
        LIMIT 1`;
      if (used.length) {
        throw new DomainError(
          "idempotency_conflict",
          "Usage run already has generated assets",
          409,
        );
      }
      const models = await tx<Row[]>`SELECT pm.*,p.slug provider_slug FROM provider_models pm
        JOIN providers p ON p.id=pm.provider_id WHERE pm.id=${input.providerModelId}`;
      if (!models.length) throw new DomainError("not_found", "Provider model not found", 404);
      const prices = await tx<Row[]>`SELECT * FROM model_price_versions
        WHERE id=${input.pricingSnapshot.pricingVersionId}`;
      const usage = run(runRows[0]);
      const persistedPrice = prices[0]
        ? {
          pricingVersionId: String(prices[0].id),
          inputMicrosPerMillion: number(prices[0].input_micros_per_million),
          cachedInputMicrosPerMillion: number(prices[0].cached_input_micros_per_million),
          reasoningMicrosPerMillion: number(prices[0].reasoning_micros_per_million),
          outputMicrosPerMillion: number(prices[0].output_micros_per_million),
          fixedCallMicros: number(prices[0].fixed_call_micros),
          source: String(prices[0].source),
        }
        : undefined;
      if (
        usage.model !== input.publicModelId ||
        String(models[0].upstream_model_id) !== input.upstreamModelId ||
        String(models[0].provider_slug) !== input.providerSlug ||
        !usagePricingSnapshotsEqual(persistedPrice, input.pricingSnapshot) ||
        !usagePricingSnapshotsEqual(usage.pricingSnapshot ?? undefined, input.pricingSnapshot)
      ) {
        throw new DomainError(
          "snapshot_conflict",
          "Generated asset registry snapshot does not match the usage run",
          409,
        );
      }
      const attachmentIds = [
        ...new Set(input.assets.flatMap((asset) => [
          asset.attachmentId,
          ...(asset.inputs ?? []).map((source) => source.attachmentId),
        ])),
      ];
      const ready = await lockReferenceableAttachments(
        tx,
        input.ownerId,
        attachmentIds,
        "attachment_not_ready",
        "Generated asset attachment is not ready",
      );
      const mimeById = new Map(ready.map((attachment) => [
        String(attachment.id),
        String(attachment.mime_type).toLowerCase(),
      ]));
      for (const asset of input.assets) {
        for (const source of asset.inputs ?? []) {
          const mime = mimeById.get(source.attachmentId) ?? "";
          if (!mime.startsWith("image/") || (source.role === "mask" && mime !== "image/png")) {
            throw new DomainError(
              "attachment_not_ready",
              "Generated asset input is not a supported image",
              409,
            );
          }
        }
      }
      const stages = await tx<Row[]>`SELECT * FROM generated_object_staging
        WHERE usage_run_id=${input.usageRunId} AND purpose='output'
        ORDER BY ordinal FOR UPDATE`;
      if (
        (input.operation === "edit" || stages.length > 0) &&
        (stages.length !== input.assets.length ||
          stages.some((stage, index) =>
            number(stage.ordinal) !== index || String(stage.state) !== "attached" ||
            String(stage.attachment_id) !== input.assets[index].attachmentId
          ))
      ) {
        throw new DomainError(
          "generated_stage_conflict",
          "Generated object stages are not ready",
          409,
        );
      }
      const editStages = await tx<Row[]>`SELECT * FROM generated_object_staging
        WHERE usage_run_id=${input.usageRunId} AND purpose='edit_input'
        ORDER BY ordinal FOR UPDATE`;
      const editInputIds = new Set(
        input.assets[0]?.inputs?.map((source) => source.attachmentId) ?? [],
      );
      if (
        editStages.length > 0 &&
        (editStages.length !== editInputIds.size ||
          editStages.some((stage) =>
            String(stage.state) !== "attached" || !stage.attachment_id ||
            !editInputIds.has(String(stage.attachment_id))
          ))
      ) {
        throw new DomainError(
          "generated_stage_conflict",
          "Edit input stages do not match immutable lineage",
          409,
        );
      }
      for (const candidate of input.assets) {
        const inserted = await tx<Row[]>`
          INSERT INTO generated_assets(owner_id,usage_run_id,provider_model_id,public_model_id,
            upstream_model_id,provider_slug,pricing_version_id,
            pricing_input_micros_per_million,pricing_cached_input_micros_per_million,
            pricing_reasoning_micros_per_million,pricing_output_micros_per_million,
            pricing_fixed_call_micros,pricing_source,attachment_id,idempotency_key,request_hash,
            operation,prompt,provider_created_at,ordinal,width,height,revised_prompt)
          VALUES(${input.ownerId},${input.usageRunId},${input.providerModelId},
            ${input.publicModelId},${input.upstreamModelId},${input.providerSlug},
            ${input.pricingSnapshot.pricingVersionId},
            ${input.pricingSnapshot.inputMicrosPerMillion},
            ${input.pricingSnapshot.cachedInputMicrosPerMillion},
            ${input.pricingSnapshot.reasoningMicrosPerMillion},
            ${input.pricingSnapshot.outputMicrosPerMillion},
            ${input.pricingSnapshot.fixedCallMicros},${input.pricingSnapshot.source},
            ${candidate.attachmentId},${input.idempotencyKey},${input.requestHash},
            ${input.operation},${input.prompt},${input.providerCreatedAt},
            ${candidate.ordinal},${candidate.width},${candidate.height},
            ${candidate.revisedPrompt ?? null}) RETURNING id`;
        const assetId = String(inserted[0].id);
        for (const source of candidate.inputs ?? []) {
          await tx`INSERT INTO generated_asset_inputs(generated_asset_id,owner_id,attachment_id,role,
            ordinal,width,height,has_alpha) VALUES(${assetId},${input.ownerId},
            ${source.attachmentId},${source.role},${source.ordinal},${source.width},${source.height},
            ${source.hasAlpha ?? null})`;
        }
      }
      if (stages.length) {
        await tx`UPDATE generated_object_staging SET
          state=CASE WHEN cleanup_attachment THEN 'finalized' ELSE 'cleanup_pending' END,
          cleanup_error=CASE WHEN cleanup_attachment THEN NULL ELSE 'deduplicated object cleanup' END,
          updated_at=now() WHERE usage_run_id=${input.usageRunId}`;
        const cleanupStages = await tx<{ id: string }[]>`SELECT id FROM generated_object_staging
          WHERE usage_run_id=${input.usageRunId} AND NOT cleanup_attachment FOR UPDATE`;
        for (const stage of cleanupStages) {
          await tx`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
            VALUES('generated_object.cleanup',${
            tx.json({ stageId: String(stage.id), ownerId: input.ownerId })
          },${`generated_object.cleanup:${String(stage.id)}`},'queued',0,now())
            ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',attempts=0,
              available_at=now(),last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL
              WHERE jobs.status IN ('completed','failed')`;
        }
      }
      const rows = await tx<Row[]>`
        SELECT ga.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'attachmentId',gai.attachment_id,'role',gai.role,'ordinal',gai.ordinal,
          'width',gai.width,'height',gai.height,'hasAlpha',gai.has_alpha)
          ORDER BY gai.role,gai.ordinal,gai.attachment_id)
          FROM generated_asset_inputs gai WHERE gai.generated_asset_id=ga.id),'[]'::jsonb) AS inputs
        FROM generated_assets ga WHERE ga.owner_id=${input.ownerId}
          AND ga.idempotency_key=${input.idempotencyKey} ORDER BY ga.ordinal`;
      return rows.map(generatedAsset);
    });
  }

  async listGeneratedAssets(ownerId: string, includeDeleted = false) {
    const rows = await this.#sql<Row[]>`
      SELECT ga.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'attachmentId',gai.attachment_id,'role',gai.role,'ordinal',gai.ordinal,
        'width',gai.width,'height',gai.height,'hasAlpha',gai.has_alpha)
        ORDER BY gai.role,gai.ordinal,gai.attachment_id)
        FROM generated_asset_inputs gai WHERE gai.generated_asset_id=ga.id),'[]'::jsonb) AS inputs
      FROM generated_assets ga WHERE ga.owner_id=${ownerId}
        AND (${includeDeleted} OR ga.deleted_at IS NULL)
      ORDER BY ga.created_at DESC,ga.id DESC`;
    return rows.map(generatedAsset);
  }

  async findGeneratedAssetByAttachment(
    ownerId: string,
    attachmentId: string,
    before?: string,
    excludeId?: string,
  ) {
    const rows = await this.#sql<Row[]>`
      SELECT ga.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'attachmentId',gai.attachment_id,'role',gai.role,'ordinal',gai.ordinal,
        'width',gai.width,'height',gai.height,'hasAlpha',gai.has_alpha)
        ORDER BY gai.role,gai.ordinal,gai.attachment_id)
        FROM generated_asset_inputs gai WHERE gai.generated_asset_id=ga.id),'[]'::jsonb) AS inputs
      FROM generated_assets ga
      WHERE ga.owner_id=${ownerId} AND ga.attachment_id=${attachmentId}
        AND (${before ?? null}::timestamptz IS NULL OR ga.created_at <= ${
      before ?? null
    }::timestamptz)
        AND (${excludeId ?? null}::uuid IS NULL OR ga.id <> ${excludeId ?? null}::uuid)
      ORDER BY ga.created_at DESC,ga.id DESC LIMIT 1`;
    return rows[0] ? generatedAsset(rows[0]) : undefined;
  }

  async findGeneratedAssetsByIdempotency(ownerId: string, idempotencyKey: string) {
    const rows = await this.#sql<Row[]>`
      SELECT ga.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'attachmentId',gai.attachment_id,'role',gai.role,'ordinal',gai.ordinal,
        'width',gai.width,'height',gai.height,'hasAlpha',gai.has_alpha)
        ORDER BY gai.role,gai.ordinal,gai.attachment_id)
        FROM generated_asset_inputs gai WHERE gai.generated_asset_id=ga.id),'[]'::jsonb) AS inputs
      FROM generated_assets ga WHERE ga.owner_id=${ownerId}
        AND ga.idempotency_key=${idempotencyKey} ORDER BY ga.ordinal`;
    return rows.map(generatedAsset);
  }

  async getGeneratedAsset(id: string, ownerId: string, includeDeleted = false) {
    const rows = await this.#sql<Row[]>`
      SELECT ga.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'attachmentId',gai.attachment_id,'role',gai.role,'ordinal',gai.ordinal,
        'width',gai.width,'height',gai.height,'hasAlpha',gai.has_alpha)
        ORDER BY gai.role,gai.ordinal,gai.attachment_id)
        FROM generated_asset_inputs gai WHERE gai.generated_asset_id=ga.id),'[]'::jsonb) AS inputs
      FROM generated_assets ga WHERE ga.id=${id} AND ga.owner_id=${ownerId}
        AND (${includeDeleted} OR ga.deleted_at IS NULL)`;
    if (!rows[0]) throw new DomainError("not_found", "Generated asset not found", 404);
    return generatedAsset(rows[0]);
  }

  async deleteGeneratedAsset(id: string, ownerId: string) {
    const rows = await this.#sql<Row[]>`
      UPDATE generated_assets SET deleted_at=COALESCE(deleted_at,now()),updated_at=now()
      WHERE id=${id} AND owner_id=${ownerId} RETURNING id`;
    if (!rows[0]) throw new DomainError("not_found", "Generated asset not found", 404);
    return await this.getGeneratedAsset(id, ownerId, true);
  }

  async restoreGeneratedAsset(id: string, ownerId: string) {
    const rows = await this.#sql<Row[]>`
      UPDATE generated_assets SET deleted_at=NULL,updated_at=now()
      WHERE id=${id} AND owner_id=${ownerId} RETURNING id`;
    if (!rows[0]) throw new DomainError("not_found", "Generated asset not found", 404);
    return await this.getGeneratedAsset(id, ownerId, true);
  }

  async stageGeneratedObject(input: StageGeneratedObjectInput) {
    validateGeneratedObjectStageInput(input);
    return await this.#sql.begin(async (tx) => {
      const run = await tx`SELECT id FROM usage_runs WHERE id=${input.usageRunId}
        AND user_id=${input.ownerId} FOR UPDATE`;
      if (!run.length) throw new DomainError("not_found", "Usage run not found", 404);
      const inserted = await tx<Row[]>`INSERT INTO generated_object_staging(
        owner_id,usage_run_id,purpose,ordinal,object_key,mime_type,size_bytes,sha256)
        VALUES(${input.ownerId},${input.usageRunId},${
        input.purpose ?? "output"
      },${input.ordinal},${input.objectKey},
          ${input.mimeType},${input.sizeBytes},${input.sha256})
        ON CONFLICT DO NOTHING RETURNING *`;
      const row = inserted[0] ?? (await tx<Row[]>`SELECT * FROM generated_object_staging
        WHERE usage_run_id=${input.usageRunId} AND purpose=${input.purpose ?? "output"}
          AND ordinal=${input.ordinal} FOR UPDATE`)[0];
      if (!row) throw new DomainError("object_key_taken", "Generated object key exists", 409);
      if (
        String(row.owner_id) !== input.ownerId || String(row.object_key) !== input.objectKey ||
        String(row.purpose) !== (input.purpose ?? "output") ||
        String(row.mime_type) !== input.mimeType || number(row.size_bytes) !== input.sizeBytes ||
        String(row.sha256) !== input.sha256
      ) throw new DomainError("idempotency_conflict", "Generated object stage differs", 409);
      return generatedObjectStage(row);
    });
  }

  async markGeneratedObjectStored(id: string, ownerId: string) {
    const rows = await this.#sql<Row[]>`UPDATE generated_object_staging SET state='stored',
      updated_at=now() WHERE id=${id} AND owner_id=${ownerId} AND state IN ('pending','stored')
      RETURNING *`;
    if (rows[0]) return generatedObjectStage(rows[0]);
    const exists = await this.#sql`SELECT id FROM generated_object_staging
      WHERE id=${id} AND owner_id=${ownerId}`;
    if (!exists.length) throw new DomainError("not_found", "Generated object stage not found", 404);
    throw new DomainError("generated_stage_conflict", "Generated object stage changed", 409);
  }

  async attachGeneratedObject(
    id: string,
    ownerId: string,
    attachmentId: string,
    cleanupAttachment = true,
  ) {
    return await this.#sql.begin(async (tx) => {
      // Generated staging is itself a durable path to attachment bytes. Take the same row lock as
      // every other reference writer before publishing that path. Cleanup takes this lock before
      // tombstoning, so a concurrent attach either commits first and fences cleanup or wakes after
      // the tombstone and fails without publishing a dangling attachment_id.
      const [attachment] = await lockReferenceableAttachments(
        tx,
        ownerId,
        [attachmentId],
        "generated_stage_conflict",
        "Generated object attachment is not ready",
      );
      if (attachment.physical_object !== true) {
        throw new DomainError(
          "generated_stage_conflict",
          "Generated object attachment differs from the staged object",
          409,
        );
      }
      const rows = await tx<Row[]>`UPDATE generated_object_staging SET state='attached',
        attachment_id=${attachmentId},cleanup_attachment=${cleanupAttachment},updated_at=now()
        WHERE id=${id} AND owner_id=${ownerId} AND state IN ('stored','attached')
          AND (attachment_id IS NULL OR attachment_id=${attachmentId})
          AND (state='stored' OR cleanup_attachment=${cleanupAttachment})
          AND (${!cleanupAttachment} OR object_key=${String(attachment.object_key)})
          AND size_bytes=${number(attachment.size_bytes)}
          AND sha256=${String(attachment.sha256)}
          AND mime_type=${String(attachment.mime_type)}
        RETURNING *`;
      if (rows[0]) return generatedObjectStage(rows[0]);
      const exists = await tx`SELECT id FROM generated_object_staging
        WHERE id=${id} AND owner_id=${ownerId}`;
      if (!exists.length) {
        throw new DomainError("not_found", "Generated object stage not found", 404);
      }
      throw new DomainError("generated_stage_conflict", "Generated object stage changed", 409);
    });
  }

  async requestGeneratedObjectCleanup(ownerId: string, usageRunId: string, reason: string) {
    const message = reason.slice(0, 1000);
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`UPDATE generated_object_staging SET state='cleanup_pending',
        cleanup_error=${message},updated_at=now() WHERE owner_id=${ownerId}
        AND usage_run_id=${usageRunId} AND state NOT IN ('finalized','cleaned') RETURNING id`;
      for (const row of rows) {
        await tx`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
          VALUES('generated_object.cleanup',${tx.json({ stageId: String(row.id), ownerId })},
            ${`generated_object.cleanup:${String(row.id)}`},'queued',0,now())
          ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',attempts=0,available_at=now(),
            last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL
            WHERE jobs.status IN ('completed','failed')`;
      }
      return rows.length;
    });
  }

  async settleGeneratedObjectCleanup(stageId: string, ownerId: string) {
    try {
      return await this.#sql.begin(async (tx) => {
        const settled = await tx<{ storage_released: boolean }[]>`
          SELECT dg_chat_settle_generated_object_cleanup(
            ${stageId},${ownerId}
          ) storage_released`;
        const rows = await tx<Row[]>`SELECT * FROM generated_object_staging
          WHERE id=${stageId} AND owner_id=${ownerId}`;
        if (!rows[0]) throw new DomainError("not_found", "Generated object stage not found", 404);
        return {
          stage: generatedObjectStage(rows[0]),
          storageReleased: Boolean(settled[0]?.storage_released),
        };
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const message = error instanceof Error ? error.message : "";
      if (
        code === "55000" &&
        (message.includes("requires the exact tombstoned attachment") ||
          message.includes("fenced by a durable reference") ||
          message.includes("release stage is invalid"))
      ) {
        throw new DomainError("generated_cleanup_fenced", message, 409);
      }
      if (
        code === "55000" &&
        (message.includes("storage") || message.includes("cleaned generated stage"))
      ) {
        throw new DomainError("generated_cleanup_invariant", message, 500);
      }
      throw error;
    }
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
        const rows = await this.#sql<Row[]>`SELECT * FROM embedding_provider_attempts
          WHERE usage_run_id=${input.usageRunId}`;
        const existing = rows[0];
        if (
          existing && String(existing.status) === "running" &&
          (existing.parent_usage_run_id === null
              ? undefined
              : String(existing.parent_usage_run_id)) ===
            input.parentUsageRunId &&
          String(existing.purpose) === input.purpose &&
          String(existing.provider) === input.provider && String(existing.model) === input.model &&
          String(existing.upstream_model) === input.upstreamModel &&
          number(existing.item_count) === input.itemCount
        ) return;
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

  async finalizeEmbeddingProviderUsage(
    input: FinalizeEmbeddingProviderUsageInput,
  ): Promise<UsageRun> {
    if (
      !["succeeded", "failed", "cancelled"].includes(input.status) ||
      !Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0 ||
      !Number.isSafeInteger(input.costMicros) || input.costMicros < 0 ||
      !Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0
    ) throw new DomainError("validation_error", "Embedding attempt result is invalid", 422);
    return await this.#sql.begin(async (tx) => {
      const [usage] = await tx<Row[]>`SELECT * FROM usage_runs
        WHERE id=${input.usageRunId} FOR UPDATE`;
      const [attempt] = await tx<Row[]>`SELECT * FROM embedding_provider_attempts
        WHERE usage_run_id=${input.usageRunId} FOR UPDATE`;
      if (!usage || !attempt) {
        throw new DomainError("not_found", "Embedding accounting state was not found", 404);
      }
      const expectedRunStatus = input.status === "succeeded" ? "completed" : "failed";
      const terminalMatches = String(usage.status) === expectedRunStatus &&
        String(attempt.status) === input.status &&
        number(usage.cost_micros) === input.costMicros &&
        number(usage.input_tokens) === input.inputTokens &&
        number(attempt.cost_micros) === input.costMicros &&
        number(attempt.input_tokens) === input.inputTokens;
      if (terminalMatches) return run(usage);
      // Reconcile the pre-0019 split-finalization crash shape: usage committed, attempt running.
      if (
        usage.status === "completed" && attempt.status === "running" &&
        input.status === "succeeded" && number(usage.cost_micros) === input.costMicros &&
        number(usage.input_tokens) === input.inputTokens
      ) {
        await tx`UPDATE embedding_provider_attempts SET status='succeeded',
          input_tokens=${input.inputTokens},cost_micros=${input.costMicros},
          token_source=${input.tokenSource},cost_source=${input.costSource},
          latency_ms=${input.latencyMs},error=NULL,completed_at=now()
          WHERE usage_run_id=${input.usageRunId}`;
        return run(usage);
      }
      if (usage.status !== "reserved" || attempt.status !== "running") {
        throw new DomainError("idempotency_conflict", "Embedding terminal result differs", 409);
      }
      const reserved = number(usage.reserved_micros);
      if (input.costMicros > reserved) {
        throw new DomainError(
          "invalid_usage_state",
          "Embedding cost exceeded its reservation",
          409,
        );
      }
      const userId = String(usage.user_id);
      const [account] = await tx<Row[]>`SELECT balance_micros FROM users
        WHERE id=${userId} FOR UPDATE`;
      const delta = reserved - input.costMicros;
      const after = number(account.balance_micros) + delta;
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
      if (delta !== 0) {
        await tx`INSERT INTO ledger_entries(
          user_id,usage_run_id,kind,amount_micros,balance_after_micros)
          VALUES(${userId},${input.usageRunId},'refund',${delta},${after})`;
      }
      const [updated] = await tx<Row[]>`UPDATE usage_runs SET
        status=${expectedRunStatus},cost_micros=${input.costMicros},
        input_tokens=${input.inputTokens},output_tokens=0,latency_ms=${input.latencyMs},
        error=${input.error?.slice(0, 1000) ?? null},run_lease_token=NULL,
        run_lease_expires_at=NULL,completed_at=now()
        WHERE id=${input.usageRunId} RETURNING *`;
      await tx`UPDATE embedding_provider_attempts SET status=${input.status},
        input_tokens=${input.inputTokens},cost_micros=${input.costMicros},
        token_source=${input.tokenSource},cost_source=${input.costSource},
        latency_ms=${input.latencyMs},error=${input.error?.slice(0, 1000) ?? null},
        completed_at=now() WHERE usage_run_id=${input.usageRunId}`;
      return run(updated);
    });
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
    const rows = await this.#sql.begin(async (tx) => {
      if (vectorLiteral !== null) await tx`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
      return await tx<Row[]>`
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
          AND EXISTS (SELECT 1 FROM scoped s WHERE s.id=dce.chunk_id)
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
    });
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
      try {
        await lockReferenceableAttachments(
          tx,
          ownerId,
          [attachmentId],
          "not_found",
          "Ready attachment not found",
        );
      } catch (error) {
        if (error instanceof DomainError && error.code === "not_found") {
          throw new DomainError("not_found", "Ready attachment not found", 404);
        }
        throw error;
      }
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
        await tx`SELECT pg_advisory_xact_lock(hashtext('provider-model-invariants'))`;
        const currentRows = await tx<Row[]>`SELECT * FROM providers WHERE id=${id} FOR UPDATE`;
        if (!currentRows[0]) throw new DomainError("not_found", "Provider not found", 404);
        const current = provider(currentRows[0]);
        if (current.version !== expectedVersion) throw registryConflict();
        if (input.enabled === false && current.enabled) {
          const models = (await tx<Row[]>`SELECT * FROM provider_models`).map(providerModel);
          const providers = (await tx<Row[]>`SELECT id,enabled FROM providers`).map((row) => ({
            id: String(row.id),
            enabled: String(row.id) === id ? false : Boolean(row.enabled),
          }));
          const violation = providerOcrTargetProviderViolation(models, providers);
          if (violation) throw new DomainError(violation.code, violation.message, 422);
        }
        if (input.protocol !== undefined && input.protocol !== current.protocol) {
          const models = (await tx<Row[]>`SELECT * FROM provider_models WHERE provider_id=${id}`)
            .map(providerModel);
          const violation = models.map((model) =>
            providerDefaultsViolation(input.protocol!, model.customParams, model.publicModelId)
          ).find(Boolean);
          if (violation) throw new DomainError(violation.code, violation.message, 422);
        }
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
        await tx`SELECT pg_advisory_xact_lock(hashtext('provider-model-invariants'))`;
        await tx`SELECT pg_advisory_xact_lock(hashtext('model-public-id-namespace'))`;
        const providerRows = await tx<
          Row[]
        >`SELECT id,protocol FROM providers WHERE id=${input.providerId}`;
        if ((await tx`SELECT 1 FROM model_aliases WHERE alias=${input.publicModelId}`).length) {
          throw new DomainError(
            "model_id_taken",
            "Public model ID already exists as an alias",
            409,
          );
        }
        if (!providerRows.length) throw new DomainError("not_found", "Provider not found", 404);
        const defaultsViolation = providerDefaultsViolation(
          providerRows[0].protocol as "chat_completions" | "responses",
          input.customParams ?? {},
          input.publicModelId,
        );
        if (defaultsViolation) {
          throw new DomainError(defaultsViolation.code, defaultsViolation.message, 422);
        }
        const rows = await tx<Row[]>`
          INSERT INTO provider_models(provider_id,public_model_id,upstream_model_id,display_name,
            capabilities,context_window,enabled,custom_params)
          VALUES(${input.providerId},${input.publicModelId},${input.upstreamModelId.trim()},
            ${input.displayName.trim()},${tx.json(input.capabilities)},${input.contextWindow},
            ${input.enabled ?? true},${tx.json((input.customParams ?? {}) as never)}) RETURNING *`;
        const value = providerModel(rows[0]);
        const graphViolation = providerModelOcrGraphViolation(
          (await tx<Row[]>`SELECT * FROM provider_models`).map(providerModel),
        );
        if (graphViolation) throw new DomainError(graphViolation.code, graphViolation.message, 422);
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
        await tx`SELECT pg_advisory_xact_lock(hashtext('provider-model-invariants'))`;
        await tx`SELECT pg_advisory_xact_lock(hashtext('model-public-id-namespace'))`;
        const currentRows = await tx<
          Row[]
        >`SELECT * FROM provider_models WHERE id=${id} FOR UPDATE`;
        if (!currentRows[0]) throw new DomainError("not_found", "Provider model not found", 404);
        const current = providerModel(currentRows[0]);
        if (current.version !== expectedVersion) throw registryConflict();
        const candidate: ProviderModelRecord = {
          ...current,
          ...(input.publicModelId === undefined ? {} : { publicModelId: input.publicModelId }),
          ...(input.upstreamModelId === undefined
            ? {}
            : { upstreamModelId: input.upstreamModelId.trim() }),
          ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
          ...(input.capabilities === undefined ? {} : { capabilities: [...input.capabilities] }),
          ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.customParams === undefined
            ? {}
            : { customParams: structuredClone(input.customParams) }),
        };
        const providerRows = await tx<
          Row[]
        >`SELECT protocol FROM providers WHERE id=${current.providerId}`;
        const defaultsViolation = providerDefaultsViolation(
          providerRows[0].protocol as "chat_completions" | "responses",
          candidate.customParams,
          candidate.publicModelId,
        );
        if (defaultsViolation) {
          throw new DomainError(defaultsViolation.code, defaultsViolation.message, 422);
        }
        if (
          input.publicModelId &&
          (await tx`SELECT 1 FROM model_aliases WHERE alias=${input.publicModelId}`).length
        ) {
          throw new DomainError(
            "model_id_taken",
            "Public model ID already exists as an alias",
            409,
          );
        }
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
        const graphViolation = providerModelOcrGraphViolation(
          (await tx<Row[]>`SELECT * FROM provider_models`).map(providerModel),
        );
        if (graphViolation) throw new DomainError(graphViolation.code, graphViolation.message, 422);
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
          !target.priced ||
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
      const compatible = row && sourceRow &&
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
      !UUID_PATTERN.test(input.ownerLeaseToken) ||
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
          id,user_id,model,provider,recovery_owner,status,reserved_micros,run_lease_token,run_lease_expires_at,
          pricing_version_id,pricing_input_micros_per_million,
          pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,
          pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source)
          VALUES(${input.runId},${userId},${input.model},${input.provider},'provider','reserved',
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

  async ensureIdempotentReservation(input: EnsureIdempotentReservationInput): Promise<UsageRun> {
    if (
      typeof input.userId !== "string" || input.userId.length < 1 || input.userId.length > 128 ||
      typeof input.usageRunId !== "string" || input.usageRunId.length < 1 ||
      input.usageRunId.length > 512 || typeof input.model !== "string" ||
      input.model.length < 1 || input.model.length > 255 || typeof input.provider !== "string" ||
      input.provider.length < 1 || input.provider.length > 255 ||
      !(["provider", "api_replay", "document_embedding", "tool"] as const).includes(
        input.recoveryOwner,
      ) || !Number.isSafeInteger(input.reservedMicros) || input.reservedMicros < 0
    ) throw new DomainError("validation_error", "Usage reservation is invalid", 422);
    const acceptExisting = (existing: Row) => {
      if (
        String(existing.user_id) !== input.userId ||
        String(existing.model) !== input.model || String(existing.provider) !== input.provider ||
        String(existing.recovery_owner) !== input.recoveryOwner ||
        number(existing.reserved_micros) !== input.reservedMicros ||
        String(existing.status) !== "reserved" || existing.token_id !== null
      ) {
        throw new DomainError("idempotency_conflict", "Existing reservation does not match", 409);
      }
      return run(existing);
    };
    try {
      return await this.#sql.begin(async (tx) => {
        // Existing runs use the same run -> user lock order as settlement/refund, avoiding an
        // otherwise needless deadlock. Most importantly, inspect the already-committed debit
        // before current-balance admission: consuming the last cent must not make it invisible.
        let rows = await tx<Row[]>`SELECT * FROM usage_runs
          WHERE id=${input.usageRunId} FOR UPDATE`;
        if (rows[0]) return acceptExisting(rows[0]);

        // New reservations for an account serialize on the user row. Recheck after acquiring it:
        // another same-account reconciler may have committed while this transaction was waiting.
        const users = await tx<Row[]>`SELECT balance_micros FROM users
          WHERE id=${input.userId} FOR UPDATE`;
        if (!users[0]) throw new DomainError("not_found", "User not found", 404);
        rows = await tx<Row[]>`SELECT * FROM usage_runs
          WHERE id=${input.usageRunId} FOR UPDATE`;
        if (rows[0]) return acceptExisting(rows[0]);

        const balance = number(users[0].balance_micros);
        if (balance < input.reservedMicros) {
          throw new DomainError("insufficient_credit", "Insufficient credit", 402);
        }
        const runLeaseToken = crypto.randomUUID();
        const inserted = await tx<Row[]>`INSERT INTO usage_runs(
          id,user_id,token_id,model,provider,recovery_owner,status,reserved_micros,
          run_lease_token,run_lease_expires_at)
          VALUES(${input.usageRunId},${input.userId},NULL,${input.model},${input.provider},
            ${input.recoveryOwner},'reserved',${input.reservedMicros},${runLeaseToken},
            now()+120*interval '1 second')
          RETURNING *`;
        const after = balance - input.reservedMicros;
        await tx`UPDATE users SET balance_micros=${after},updated_at=now()
          WHERE id=${input.userId}`;
        await tx`INSERT INTO ledger_entries(
          user_id,usage_run_id,kind,amount_micros,balance_after_micros)
          VALUES(${input.userId},${input.usageRunId},'reserve',${-input.reservedMicros},${after})`;
        return run(inserted[0]);
      });
    } catch (error) {
      // Different accounts do not share a user lock. A globally colliding run ID can therefore
      // lose at the unique constraint even after both transactions observed a missing row. Keep
      // the repository contract categorical and never expose a driver-specific 23505.
      if ((error as { code?: string }).code === "23505") {
        const rows = await this.#sql<Row[]>`SELECT * FROM usage_runs
          WHERE id=${input.usageRunId}`;
        if (rows[0]) {
          return acceptExisting(rows[0]);
        }
        throw new DomainError(
          "idempotency_conflict",
          "This idempotency key has already been used",
          409,
        );
      }
      throw error;
    }
  }

  async reapStaleProviderExecutionLeases(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new DomainError("validation_error", "Provider lease reaper limit is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT r.* FROM usage_runs r
        WHERE r.status='reserved' AND r.run_lease_token IS NOT NULL
          -- Document embeddings share this conservative provider-attempt reaper once their owning
          -- job is terminal. API replay and tool recovery remain fenced to their own state machines.
          AND r.recovery_owner IN ('provider','document_embedding')
          AND r.run_lease_expires_at<=now() AND r.generation_lease_token IS NULL
          AND NOT EXISTS(SELECT 1 FROM api_idempotency_requests a WHERE a.usage_run_id=r.id)
          AND NOT EXISTS(
            SELECT 1 FROM document_embedding_batches b
            JOIN jobs j ON j.id=b.job_id
            WHERE b.usage_run_id=r.id
              AND b.phase IN ('pre_dispatch','dispatched','succeeded')
              AND j.status IN ('queued','running')
          )
        ORDER BY r.run_lease_expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      for (const row of rows) {
        const runId = String(row.id);
        const uncertainty = await tx<{
          uncertain: boolean;
          embedding_uncertain: boolean;
          embedding_retry_safe: boolean;
          embedding_estimated_input_tokens: number;
        }[]>`
          SELECT EXISTS(SELECT 1 FROM provider_attempts
            WHERE usage_run_id=${runId} AND status='running') AS uncertain,
          EXISTS(SELECT 1 FROM embedding_provider_attempts
            WHERE usage_run_id=${runId} AND status='running') AS embedding_uncertain,
          COALESCE((SELECT retry_safe FROM document_embedding_batches
            WHERE usage_run_id=${runId} AND phase='dispatched'),false) AS embedding_retry_safe,
          COALESCE((SELECT maximum_input_tokens FROM document_embedding_batches
            WHERE usage_run_id=${runId}),0)::int AS embedding_estimated_input_tokens`;
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='execution_lease_expired',breaker_after='unavailable',retryable=true,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${runId} AND status='running'`;
        const retrySafeEmbedding = uncertainty[0].embedding_retry_safe === true;
        const embeddingCost = uncertainty[0].embedding_uncertain && !retrySafeEmbedding
          ? number(row.reserved_micros)
          : 0;
        const embeddingInputTokens = uncertainty[0].embedding_uncertain && !retrySafeEmbedding
          ? number(uncertainty[0].embedding_estimated_input_tokens)
          : 0;
        await tx`UPDATE embedding_provider_attempts SET
          status=${retrySafeEmbedding ? "failed" : "cancelled"},
          input_tokens=${embeddingInputTokens},cost_micros=${embeddingCost},
          cost_source=${retrySafeEmbedding ? "none" : "calculated"},
          token_source=${retrySafeEmbedding ? "none" : "estimated"},
          error=${
          retrySafeEmbedding
            ? "definitive provider rejection settlement interrupted"
            : "execution lease expired"
        },
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${runId} AND status='running'`;
        const userId = String(row.user_id);
        const users = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        const cost = uncertainty[0].embedding_uncertain ? embeddingCost : 0;
        const delta = number(row.reserved_micros) - cost;
        const after = number(users[0].balance_micros) + delta;
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        if (delta !== 0) {
          await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros)
            VALUES(${userId},${runId},${delta > 0 ? "refund" : "settle"},${delta},${after})`;
        }
        await tx`UPDATE usage_runs SET status='failed',cost_micros=${cost},
          input_tokens=${uncertainty[0].embedding_uncertain ? embeddingInputTokens : 0},
          output_tokens=0,run_lease_token=NULL,run_lease_expires_at=NULL,error='provider execution lease expired',
          completed_at=now() WHERE id=${runId}`;
      }
      return rows.length;
    });
  }

  async createApiToken(
    userId: string,
    input: CreateApiTokenInput,
    expectedAuthorityEpoch: number,
  ) {
    validateTokenRates(input.rpmLimit ?? null, input.burstLimit ?? null);
    const id = crypto.randomUUID();
    return await this.#sql.begin(async (tx) => {
      // See createSession: this lock makes token creation linearizable with every lifecycle
      // transition that invalidates full user authority.
      const users = await tx<Row[]>`SELECT approval_status,state,deleted_at,
        password_reset_pending,authority_epoch FROM users WHERE id=${userId} FOR UPDATE`;
      const user = users[0];
      if (
        !user || user.approval_status !== "approved" || user.state !== "active" ||
        user.deleted_at != null || user.password_reset_pending === true ||
        number(user.authority_epoch) !== expectedAuthorityEpoch
      ) {
        throw new DomainError("account_unavailable", "Account cannot create API tokens", 403);
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO api_tokens(id,user_id,name,token_hash,preview,scopes,authority_epoch,
        expires_at,rpm_limit,burst_limit,rotation_family_id)
        VALUES(${id},${userId},${input.name},${input.tokenHash},${input.preview},${
        tx.json(input.scopes)
      },${expectedAuthorityEpoch},${input.expiresAt ?? null},${input.rpmLimit ?? null},${
        input.burstLimit ?? null
      },${id}) RETURNING *`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'api_token.created','api_token',${id},'{}'::jsonb)`;
      return token(rows[0]);
    });
  }
  async findApiTokenByHash(hash: string) {
    return await this.authenticateApiToken(hash);
  }
  async authenticateApiToken(hash: string) {
    const rows = await this.#sql<
      Row[]
    >`UPDATE api_tokens t SET last_used_at=now() FROM users u
      WHERE t.token_hash=${hash} AND t.user_id=u.id
        AND t.authority_epoch=u.authority_epoch AND u.state='active' AND u.deleted_at IS NULL
        AND u.password_reset_pending=false AND u.approval_status='approved'
        AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now())
        AND (t.replaced_by_token_id IS NULL OR t.overlap_ends_at>now()) RETURNING t.*`;
    return rows[0] ? token(rows[0]) : undefined;
  }
  async listApiTokens(userId: string) {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM api_tokens WHERE user_id=${userId} ORDER BY created_at DESC`).map((row) => {
      const {
        tokenHash: _hash,
        userId: _userId,
        authorityEpoch: _authorityEpoch,
        ...summary
      } = token(row);
      return summary;
    });
  }
  async revokeApiToken(id: string, userId: string, expectedAuthorityEpoch: number) {
    await this.#sql.begin(async (tx) => {
      await assertPersonalTokenOwner(tx, userId, expectedAuthorityEpoch, "revoke");
      const family = await tx<
        Row[]
      >`SELECT rotation_family_id FROM api_tokens WHERE id=${id} AND user_id=${userId}`;
      if (!family[0]) throw new DomainError("not_found", "Token not found", 404);
      const familyId = String(family[0].rotation_family_id);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${familyId}))`;
      const selected = await tx<
        Row[]
      >`SELECT id FROM api_tokens WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      if (!selected[0]) throw new DomainError("not_found", "Token not found", 404);
      await tx`UPDATE api_tokens
        SET revoked_at=COALESCE(revoked_at,now()),version=version+1
        WHERE rotation_family_id=${familyId}`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'api_token.revoked','api_token',${id},'{}'::jsonb)`;
    });
  }
  async revokeApiTokenFamily(
    id: string,
    userId: string,
    expectedVersion: number,
    expectedAuthorityEpoch: number,
  ) {
    await this.#sql.begin(async (tx) => {
      // Account lifecycle transitions lock the user before revoking token rows. Preserve that
      // global order here: the mandatory audit insert also references this user, so taking the
      // family lock first would create a user<->token deadlock with suspension or deletion.
      await assertPersonalTokenOwner(tx, userId, expectedAuthorityEpoch, "revoke");
      const family = await tx<
        Row[]
      >`SELECT rotation_family_id FROM api_tokens WHERE id=${id} AND user_id=${userId}`;
      if (!family[0]) throw new DomainError("not_found", "Token not found", 404);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${String(family[0].rotation_family_id)}))`;
      const selected = await tx<
        Row[]
      >`SELECT rotation_family_id,version FROM api_tokens WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      if (!selected[0]) throw new DomainError("not_found", "Token not found", 404);
      if (number(selected[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Token was modified", 409);
      }
      await tx`UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()),version=version+1 WHERE rotation_family_id=${
        String(selected[0].rotation_family_id)
      }`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'api_token.revoked','api_token',${id},'{}'::jsonb)`;
    });
  }
  async updateApiToken(
    userId: string,
    id: string,
    input: UpdateApiTokenInput,
    expectedAuthorityEpoch: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      // See revokeApiTokenFamily: lifecycle transitions and personal-token mutations must always
      // acquire the owning user row before the family advisory lock and token rows.
      await assertPersonalTokenOwner(tx, userId, expectedAuthorityEpoch, "update");
      const family = await tx<
        Row[]
      >`SELECT rotation_family_id FROM api_tokens WHERE id=${id} AND user_id=${userId}`;
      if (!family[0]) throw new DomainError("not_found", "Token not found", 404);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${String(family[0].rotation_family_id)}))`;
      const rows = await tx<
        Row[]
      >`SELECT * FROM api_tokens WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Token not found", 404);
      const old = token(rows[0]);
      if (old.version !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Token was modified", 409);
      }
      const rpm = input.rpmLimit === undefined ? old.rpmLimit : input.rpmLimit;
      const burst = input.burstLimit === undefined ? old.burstLimit : input.burstLimit;
      validateTokenRates(rpm, burst);
      await tx`UPDATE api_tokens SET name=${input.name ?? old.name},scopes=${
        tx.json(input.scopes ?? old.scopes)
      },expires_at=${
        input.expiresAt === undefined ? old.expiresAt : input.expiresAt
      },rpm_limit=${rpm},burst_limit=${burst},version=version+1 WHERE rotation_family_id=${old.rotationFamilyId}`;
      const updated = await tx<Row[]>`SELECT * FROM api_tokens WHERE id=${id}`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'api_token.updated','api_token',${id},'{}'::jsonb)`;
      return tokenSummary(token(updated[0]));
    });
  }
  async rotateApiToken(
    userId: string,
    id: string,
    input: RotateApiTokenInput,
    expectedAuthorityEpoch: number,
  ): Promise<RotatedApiToken> {
    if (
      !Number.isInteger(input.overlapSeconds) || input.overlapSeconds < 0 ||
      input.overlapSeconds > 3600
    ) {
      throw new DomainError(
        "validation_error",
        "Rotation overlap must be between 0 and 3600 seconds",
        422,
      );
    }
    return await this.#sql.begin(async (tx) => {
      // Keep the user row first in the lock order. Lifecycle transitions also lock the user before
      // revoking token rows, so taking a family/token lock first would introduce a user<->token
      // deadlock. It also makes replacement issuance linearizable with authority loss: either the
      // replacement commits first and is revoked by the transition, or the transition commits first
      // and this eligibility check fails.
      const users = await tx<Row[]>`SELECT approval_status,state,deleted_at,
        password_reset_pending,authority_epoch FROM users WHERE id=${userId} FOR UPDATE`;
      const currentUser = users[0];
      if (
        !currentUser || currentUser.approval_status !== "approved" ||
        currentUser.state !== "active" || currentUser.deleted_at != null ||
        currentUser.password_reset_pending === true ||
        number(currentUser.authority_epoch) !== expectedAuthorityEpoch
      ) {
        throw new DomainError("account_unavailable", "Account cannot rotate API tokens", 403);
      }
      const family = await tx<
        Row[]
      >`SELECT rotation_family_id FROM api_tokens WHERE id=${id} AND user_id=${userId}`;
      if (!family[0]) throw new DomainError("not_found", "Token not found", 404);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${String(family[0].rotation_family_id)}))`;
      const rows = await tx<
        Row[]
      >`SELECT * FROM api_tokens WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Token not found", 404);
      const old = token(rows[0]);
      if (old.version !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Token was modified", 409);
      }
      if (
        old.revokedAt || old.replacedByTokenId ||
        (old.expiresAt && Date.parse(old.expiresAt) <= Date.now())
      ) {
        throw new DomainError(
          "invalid_state",
          "Only the current active token generation can be rotated",
          409,
        );
      }
      const nextId = crypto.randomUUID();
      let inserted: Row[];
      try {
        inserted = await tx<
          Row[]
        >`INSERT INTO api_tokens(id,user_id,name,token_hash,preview,scopes,authority_epoch,
          expires_at,rpm_limit,burst_limit,access_mode,rotation_family_id,rotation_generation,
          rotated_from_token_id)
          VALUES(${nextId},${userId},${old.name},${input.tokenHash},${input.preview},${
          tx.json(old.scopes)
        },${expectedAuthorityEpoch},${old.expiresAt},${old.rpmLimit},${old.burstLimit},${old.accessMode},${old.rotationFamilyId},${
          old.rotationGeneration + 1
        },${old.id}) RETURNING *`;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new DomainError("conflict", "Token hash or generation already exists", 409);
        }
        throw error;
      }
      await tx`INSERT INTO access_group_tokens(group_id,token_id,user_id) SELECT group_id,${nextId},user_id FROM access_group_tokens WHERE token_id=${old.id}`;
      await tx`UPDATE api_tokens SET version=version+1
        WHERE rotation_family_id=${old.rotationFamilyId} AND id<>${nextId}`;
      const previous = await tx<
        Row[]
      >`UPDATE api_tokens SET replaced_by_token_id=${nextId},overlap_ends_at=now()+${input.overlapSeconds}*interval '1 second' WHERE id=${old.id} RETURNING *`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${userId},'api_token.rotated','api_token',${nextId},${
        tx.json({
          previousTokenId: old.id,
          overlapSeconds: input.overlapSeconds,
        })
      })`;
      return {
        previous: tokenSummary(token(previous[0])),
        replacement: tokenSummary(token(inserted[0])),
      };
    });
  }
  async searchApiTokens(
    context: PrivilegedReadContext,
    query = "",
    limit = 50,
    cursor?: string,
  ): Promise<AdminTokenLookupPage> {
    requirePrivilegedReadContext(context);
    if (cursor && !UUID_PATTERN.test(cursor)) {
      throw new DomainError("validation_error", "cursor must be a valid UUID", 422);
    }
    const bounded = Math.min(100, Math.max(1, limit));
    const q = `%${query.trim()}%`;
    return await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(
        tx,
        context.actorId,
        context.requireEmailVerification,
        context.expectedAuthorityEpoch,
      );
      const rows = await tx<
        Row[]
      >`SELECT t.id,t.name token_name,t.preview,t.user_id,t.version,t.revoked_at,t.access_mode,u.email,u.name owner_name,COALESCE(array_agg(gt.group_id) FILTER(WHERE gt.group_id IS NOT NULL),'{}') group_ids FROM api_tokens t JOIN users u ON u.id=t.user_id LEFT JOIN access_group_tokens gt ON gt.token_id=t.id WHERE (${
        query.trim() === ""
      } OR t.name ILIKE ${q} OR t.preview ILIKE ${q} OR u.email ILIKE ${q}) AND (${
        cursor ?? null
      }::uuid IS NULL OR t.id>${cursor ?? null}) GROUP BY t.id,u.id ORDER BY t.id LIMIT ${
        bounded + 1
      }`;
      const page = rows.slice(0, bounded);
      return {
        data: page.map((r) => ({
          id: String(r.id),
          name: String(r.token_name),
          preview: String(r.preview),
          ownerId: String(r.user_id),
          ownerEmail: String(r.email),
          ownerName: String(r.owner_name),
          version: number(r.version),
          groupIds: (r.group_ids as unknown[]).map(String),
          revokedAt: nullableIso(r.revoked_at),
          accessMode: r.access_mode as "inherit" | "restricted",
        })),
        nextCursor: rows.length > bounded ? String(page.at(-1)!.id) : null,
      };
    });
  }

  async listModelAliases(): Promise<ModelAlias[]> {
    return (await this.#sql<Row[]>`SELECT * FROM model_aliases ORDER BY alias`).map((r) => ({
      id: String(r.id),
      alias: String(r.alias),
      targetModelId: String(r.target_model_id),
      description: String(r.description),
      version: number(r.version),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    }));
  }
  async createModelAlias(
    input: CreateModelAliasInput,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(input.alias)) {
      throw new DomainError("validation_error", "Invalid model alias", 422);
    }
    const r = await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(
        tx,
        audit.actorId,
        audit.requireEmailVerification,
        audit.expectedAuthorityEpoch,
      );
      await tx`SELECT pg_advisory_xact_lock(hashtext('model-public-id-namespace'))`;
      if ((await tx`SELECT 1 FROM provider_models WHERE public_model_id=${input.alias}`).length) {
        throw new DomainError("conflict", "Alias collides with a canonical model", 409);
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO model_aliases(alias,target_model_id,description) VALUES(${input.alias},${input.targetModelId},${
        input.description ?? ""
      }) RETURNING *`;
      const row = rows[0];
      const metadata = {
        ...audit.metadata,
        after: {
          alias: String(row.alias),
          targetModelId: String(row.target_model_id),
          description: String(row.description),
        },
      };
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${audit.actorId},${audit.action},${audit.targetType},${String(row.id)},${
        tx.json(metadata as postgres.JSONValue)
      })`;
      return rows;
    });
    return {
      id: String(r[0].id),
      alias: String(r[0].alias),
      targetModelId: String(r[0].target_model_id),
      description: String(r[0].description),
      version: number(r[0].version),
      createdAt: iso(r[0].created_at),
      updatedAt: iso(r[0].updated_at),
    };
  }
  async updateModelAlias(
    id: string,
    input: UpdateModelAliasInput,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    const r = await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(
        tx,
        audit.actorId,
        audit.requireEmailVerification,
        audit.expectedAuthorityEpoch,
      );
      await tx`SELECT pg_advisory_xact_lock(hashtext('model-public-id-namespace'))`;
      if (
        input.alias &&
        (await tx`SELECT 1 FROM provider_models WHERE public_model_id=${input.alias}`).length
      ) throw new DomainError("conflict", "Alias collides with a canonical model", 409);
      const current = (await tx<Row[]>`SELECT * FROM model_aliases
        WHERE id=${id} FOR UPDATE`)[0];
      if (!current || number(current.version) !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Model alias not found or modified", 409);
      }
      const rows = await tx<Row[]>`UPDATE model_aliases SET alias=COALESCE(${
        input.alias ?? null
      },alias),target_model_id=COALESCE(${
        input.targetModelId ?? null
      }::uuid,target_model_id),description=COALESCE(${
        input.description ?? null
      },description),version=version+1,updated_at=now() WHERE id=${id} RETURNING *`;
      const row = rows[0];
      const metadata = {
        ...audit.metadata,
        before: {
          alias: String(current.alias),
          targetModelId: String(current.target_model_id),
          description: String(current.description),
        },
        after: {
          alias: String(row.alias),
          targetModelId: String(row.target_model_id),
          description: String(row.description),
        },
      };
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${audit.actorId},${audit.action},${audit.targetType},${id},${
        tx.json(metadata as postgres.JSONValue)
      })`;
      return rows;
    });
    return {
      id: String(r[0].id),
      alias: String(r[0].alias),
      targetModelId: String(r[0].target_model_id),
      description: String(r[0].description),
      version: number(r[0].version),
      createdAt: iso(r[0].created_at),
      updatedAt: iso(r[0].updated_at),
    };
  }
  async deleteModelAlias(
    id: string,
    expectedVersion: number,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(
        tx,
        audit.actorId,
        audit.requireEmailVerification,
        audit.expectedAuthorityEpoch,
      );
      const current = (await tx<Row[]>`SELECT * FROM model_aliases
        WHERE id=${id} FOR UPDATE`)[0];
      if (!current || number(current.version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Model alias not found or modified", 409);
      }
      await tx`DELETE FROM model_aliases WHERE id=${id}`;
      const metadata = {
        ...audit.metadata,
        before: {
          alias: String(current.alias),
          targetModelId: String(current.target_model_id),
          description: String(current.description),
        },
      };
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${audit.actorId},${audit.action},${audit.targetType},${id},${
        tx.json(metadata as postgres.JSONValue)
      })`;
    });
  }
  async #loadAccessGroup(tx: postgres.Sql, id: string): Promise<AccessGroup> {
    const r = (await tx<Row[]>`SELECT * FROM access_groups WHERE id=${id}`)[0];
    if (!r) throw new DomainError("not_found", "Access group not found", 404);
    const u = await tx<Row[]>`SELECT user_id FROM access_group_users WHERE group_id=${id}`;
    const m = await tx<
      Row[]
    >`SELECT provider_model_id FROM access_group_models WHERE group_id=${id}`;
    const t = await tx<
      Row[]
    >`SELECT token_id,user_id FROM access_group_tokens WHERE group_id=${id}`;
    return {
      id: String(r.id),
      name: String(r.name),
      description: String(r.description),
      version: number(r.version),
      userIds: u.map((x) => String(x.user_id)),
      modelIds: m.map((x) => String(x.provider_model_id)),
      tokenIds: t.map((x) => String(x.token_id)),
      tokenOwners: t.map((x) => ({ tokenId: String(x.token_id), ownerId: String(x.user_id) })),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }
  async #lockAccessGroupModelPolicy(
    tx: postgres.Sql,
    id: string,
    expectedVersion: number,
    nextModelIds: readonly string[],
    lockForDeletion = false,
  ): Promise<{ currentModelIds: string[]; modelIdsBecomingPublic: string[] }> {
    // The group row is the first lock in every access-policy mutation. Model locks follow in
    // canonical UUID order, before any token-family advisory lock or token row lock.
    // Non-deleting writes deliberately use NO KEY UPDATE: it still serializes every writer and
    // protects the version check, while remaining compatible with the KEY SHARE lock taken by a
    // concurrent token rotation's access-group FK insert. Deletion must exclude KEY SHARE.
    const groupRows = lockForDeletion
      ? await tx<Row[]>`SELECT version FROM access_groups WHERE id=${id} FOR UPDATE`
      : await tx<Row[]>`SELECT version FROM access_groups WHERE id=${id} FOR NO KEY UPDATE`;
    if (!groupRows[0] || number(groupRows[0].version) !== expectedVersion) {
      throw new DomainError("version_conflict", "Access group not found or modified", 409);
    }
    const currentRows = await tx<
      Row[]
    >`SELECT provider_model_id FROM access_group_models WHERE group_id=${id} ORDER BY provider_model_id`;
    const currentModelIds = currentRows.map((row) => String(row.provider_model_id));
    const nextSet = new Set(nextModelIds);
    const affectedModelIds = [...new Set([...currentModelIds, ...nextSet])].sort();
    for (const modelId of affectedModelIds) {
      // Prefixing the exact text input gives access policies a dedicated namespace without
      // passing an imprecise JavaScript number as hashtextextended's bigint seed.
      await tx`SELECT pg_advisory_xact_lock(
        hashtextextended(${`dg-chat:model-access:${modelId}`}, 0)
      )`;
    }
    const removedModelIds = currentModelIds.filter((modelId) => !nextSet.has(modelId));
    const stillRestrictedRows = removedModelIds.length
      ? await tx<
        Row[]
      >`SELECT DISTINCT provider_model_id FROM access_group_models
        WHERE group_id<>${id} AND provider_model_id=ANY(${tx.array(removedModelIds)}::uuid[])`
      : [];
    const stillRestricted = new Set(
      stillRestrictedRows.map((row) => String(row.provider_model_id)),
    );
    return {
      currentModelIds,
      modelIdsBecomingPublic: removedModelIds.filter((modelId) => !stillRestricted.has(modelId))
        .sort(),
    };
  }
  async #accessGroupTokenSubjects(
    tx: postgres.Sql,
    groupId: string,
    requestedTokenIds: readonly string[] = [],
  ): Promise<Array<{ ownerId: string; familyId: string }>> {
    const rows = await tx<Row[]>`SELECT DISTINCT t.user_id,t.rotation_family_id
      FROM api_tokens t
      WHERE t.id=ANY(${tx.array([...requestedTokenIds])}::uuid[])
        OR EXISTS(
          SELECT 1 FROM access_group_tokens gt
          WHERE gt.group_id=${groupId} AND gt.token_id=t.id
        )
      ORDER BY t.user_id,t.rotation_family_id`;
    return rows.map((row) => ({
      ownerId: String(row.user_id),
      familyId: String(row.rotation_family_id),
    }));
  }
  #requireAccessGroupSubjectOwnersLocked(
    subjects: readonly { ownerId: string }[],
    lockedUserIds: ReadonlySet<string>,
  ): void {
    if (subjects.some((subject) => !lockedUserIds.has(subject.ownerId))) {
      throw new DomainError(
        "version_conflict",
        "Access group token ownership changed; refresh and retry",
        409,
      );
    }
  }
  async #lockTokenFamilies(
    tx: postgres.Sql,
    subjects: readonly { familyId: string }[],
  ): Promise<Array<{ id: string; familyId: string }>> {
    const familyIds = [...new Set(subjects.map((subject) => subject.familyId))].sort();
    for (const familyId of familyIds) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${familyId}))`;
    }
    if (!familyIds.length) return [];
    const rows = await tx<Row[]>`SELECT id,rotation_family_id FROM api_tokens
      WHERE rotation_family_id=ANY(${tx.array(familyIds)}::uuid[])
      ORDER BY id FOR UPDATE`;
    return rows.map((row) => ({
      id: String(row.id),
      familyId: String(row.rotation_family_id),
    }));
  }
  #requireModelAccessWideningAcknowledgement(
    actualModelIds: readonly string[],
    acknowledgedModelIds: readonly string[],
  ) {
    if (
      !modelAccessWideningAcknowledgementMatches(actualModelIds, acknowledgedModelIds)
    ) {
      throw new DomainError(
        "model_access_widening_acknowledgement_required",
        `Acknowledge the exact models that will become public before applying this change: ${
          actualModelIds.join(", ")
        }`,
        409,
      );
    }
  }
  async #requireProviderModelsExist(tx: postgres.Sql, modelIds: readonly string[]) {
    if (!modelIds.length) return;
    const existing = await tx<
      Row[]
    >`SELECT id FROM provider_models WHERE id=ANY(${tx.array([...modelIds])}::uuid[])`;
    if (existing.length !== modelIds.length) {
      throw new DomainError("not_found", "Model not found", 404);
    }
  }
  async listAccessGroups(context: PrivilegedReadContext) {
    requirePrivilegedReadContext(context);
    return await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(
        tx,
        context.actorId,
        context.requireEmailVerification,
        context.expectedAuthorityEpoch,
      );
      const rows = await tx<Row[]>`SELECT g.*,
        ARRAY(SELECT gu.user_id FROM access_group_users gu WHERE gu.group_id=g.id ORDER BY gu.user_id) user_ids,
        ARRAY(SELECT gm.provider_model_id FROM access_group_models gm WHERE gm.group_id=g.id ORDER BY gm.provider_model_id) model_ids,
        ARRAY(SELECT gt.token_id FROM access_group_tokens gt WHERE gt.group_id=g.id ORDER BY gt.token_id) token_ids,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('tokenId',gt.token_id,'ownerId',gt.user_id) ORDER BY gt.token_id) FROM access_group_tokens gt WHERE gt.group_id=g.id),'[]'::jsonb) token_owners
        FROM access_groups g ORDER BY g.name`;
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        description: String(row.description),
        version: number(row.version),
        userIds: (row.user_ids as unknown[]).map(String),
        modelIds: (row.model_ids as unknown[]).map(String),
        tokenIds: (row.token_ids as unknown[]).map(String),
        tokenOwners: (row.token_owners as Array<{ tokenId: string; ownerId: string }>).map((
          entry,
        ) => ({ tokenId: String(entry.tokenId), ownerId: String(entry.ownerId) })),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      }));
    });
  }
  async createAccessGroup(
    input: CreateAccessGroupInput,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    const name = input.name.trim();
    const description = input.description ?? "";
    const userIds = [...new Set(input.userIds ?? [])].sort();
    const modelIds = [...new Set(input.modelIds ?? [])].sort();
    const requestedTokenIds = [...new Set(input.tokenIds ?? [])].sort();
    try {
      return await this.#sql.begin(async (tx) => {
        // Model-access mutations take locks in one order everywhere: users (including the
        // authority-bearing actor and token owners), models/groups, then token families.
        // Reading token subjects before locking is safe because token lifecycle mutations
        // must first lock their owner user; the locked re-read below detects any stale row.
        const requestedRows = requestedTokenIds.length
          ? await tx<Row[]>`SELECT id,user_id,rotation_family_id FROM api_tokens
              WHERE id=ANY(${tx.array(requestedTokenIds)}::uuid[]) ORDER BY id`
          : [];
        if (requestedRows.length !== requestedTokenIds.length) {
          throw new DomainError("not_found", "Token not found", 404);
        }
        const requestedFamilyIds = [
          ...new Set(requestedRows.map((row) => String(row.rotation_family_id))),
        ].sort();
        const preliminaryFamilyRows = requestedFamilyIds.length
          ? await tx<Row[]>`SELECT DISTINCT user_id,rotation_family_id FROM api_tokens
              WHERE rotation_family_id=ANY(${tx.array(requestedFamilyIds)}::uuid[])
              ORDER BY user_id,rotation_family_id`
          : [];
        const preliminarySubjects = preliminaryFamilyRows.map((row) => ({
          ownerId: String(row.user_id),
          familyId: String(row.rotation_family_id),
        }));
        const lockedUsers = await lockUsersAndAssertEffectiveAdminActor(
          tx,
          audit.actorId,
          [...userIds, ...preliminarySubjects.map((subject) => subject.ownerId)],
          audit.requireEmailVerification,
          audit.expectedAuthorityEpoch,
        );
        const lockedUserIds = new Set(lockedUsers.map((row) => String(row.id)));
        if (userIds.some((userId) => !lockedUserIds.has(userId))) {
          throw new DomainError("not_found", "User not found", 404);
        }
        for (const modelId of modelIds) {
          await tx`SELECT pg_advisory_xact_lock(
            hashtextextended(${`dg-chat:model-access:${modelId}`}, 0)
          )`;
        }
        await this.#requireProviderModelsExist(tx, modelIds);
        const rows = await tx<
          Row[]
        >`INSERT INTO access_groups(name,description) VALUES(${name},${description}) RETURNING id`;
        const id = String(rows[0].id);
        this.#requireAccessGroupSubjectOwnersLocked(preliminarySubjects, lockedUserIds);
        const lockedTokens = await this.#lockTokenFamilies(tx, preliminarySubjects);
        const lockedTokenIds = new Set(lockedTokens.map((token) => token.id));
        if (requestedTokenIds.some((tokenId) => !lockedTokenIds.has(tokenId))) {
          throw new DomainError(
            "version_conflict",
            "API token changed while creating the access group; refresh and retry",
            409,
          );
        }
        const expandedRows = requestedFamilyIds.length
          ? await tx<Row[]>`SELECT id,user_id FROM api_tokens
              WHERE rotation_family_id=ANY(${tx.array(requestedFamilyIds)}::uuid[]) ORDER BY id`
          : [];
        const tokenIds = expandedRows.map((row) => String(row.id));
        const tokenOwners = new Map(
          expandedRows.map((row) => [String(row.id), String(row.user_id)]),
        );
        for (const tokenId of tokenIds) {
          if (!userIds.includes(tokenOwners.get(tokenId)!)) {
            throw new DomainError(
              "validation_error",
              "Every token owner must be included in the group",
              422,
            );
          }
        }
        for (const userId of userIds) {
          await tx`INSERT INTO access_group_users(group_id,user_id) VALUES(${id},${userId})`;
        }
        for (const modelId of modelIds) {
          await tx`INSERT INTO access_group_models(group_id,provider_model_id)
            VALUES(${id},${modelId})`;
        }
        for (const tokenId of tokenIds) {
          await tx`INSERT INTO access_group_tokens(group_id,token_id,user_id)
            VALUES(${id},${tokenId},${tokenOwners.get(tokenId)!})`;
        }
        if (tokenIds.length) {
          await tx`UPDATE api_tokens SET access_mode='restricted',version=version+1
            WHERE id=ANY(${tx.array(tokenIds)}::uuid[])`;
        }
        const metadata = {
          ...audit.metadata,
          after: { name, description, userIds, modelIds, tokenIds },
        };
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${audit.actorId},${audit.action},${audit.targetType},${id},${
          tx.json(metadata as postgres.JSONValue)
        })`;
        return await this.#loadAccessGroup(tx, id);
      });
    } catch (error) {
      const postgresError = error as { code?: string; constraint_name?: string };
      if (
        postgresError.code === "23505" &&
        postgresError.constraint_name === "access_groups_name_uq"
      ) {
        throw new DomainError("conflict", "Access group name is already used", 409);
      }
      throw error;
    }
  }
  async updateAccessGroup(
    id: string,
    input: UpdateAccessGroupInput,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    if (input.name === undefined && input.description === undefined) {
      throw new DomainError(
        "validation_error",
        "Provide a name or description to update",
        422,
      );
    }
    try {
      return await this.#sql.begin(async (tx) => {
        await assertEffectiveAdminActor(
          tx,
          audit.actorId,
          audit.requireEmailVerification,
          audit.expectedAuthorityEpoch,
        );
        const currentRows = await tx<
          Row[]
        >`SELECT name,description,version FROM access_groups WHERE id=${id} FOR UPDATE`;
        const current = currentRows[0];
        if (!current || number(current.version) !== input.expectedVersion) {
          throw new DomainError("version_conflict", "Access group not found or modified", 409);
        }
        const before = {
          name: String(current.name),
          description: String(current.description),
        };
        const after = {
          name: input.name?.trim() ?? before.name,
          description: input.description ?? before.description,
        };
        await tx`UPDATE access_groups SET name=${after.name},description=${after.description},
          version=version+1,updated_at=now() WHERE id=${id}`;
        const metadata = { ...audit.metadata, before, after };
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${audit.actorId},${audit.action},${audit.targetType},${id},${
          tx.json(metadata as postgres.JSONValue)
        })`;
        return await this.#loadAccessGroup(tx, id);
      });
    } catch (error) {
      const postgresError = error as { code?: string; constraint_name?: string };
      if (
        postgresError.code === "23505" &&
        postgresError.constraint_name === "access_groups_name_uq"
      ) {
        throw new DomainError("conflict", "Access group name is already used", 409);
      }
      throw error;
    }
  }
  async deleteAccessGroup(
    id: string,
    expectedVersion: number,
    acknowledgePublicModelIds: string[],
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    await this.#sql.begin(async (tx) => {
      const preliminarySubjects = await this.#accessGroupTokenSubjects(tx, id);
      const lockedUsers = await lockUsersAndAssertEffectiveAdminActor(
        tx,
        audit.actorId,
        preliminarySubjects.map((subject) => subject.ownerId),
        audit.requireEmailVerification,
        audit.expectedAuthorityEpoch,
      );
      const lockedUserIds = new Set(lockedUsers.map((row) => String(row.id)));
      const impact = await this.#lockAccessGroupModelPolicy(tx, id, expectedVersion, [], true);
      const subjects = await this.#accessGroupTokenSubjects(tx, id);
      this.#requireAccessGroupSubjectOwnersLocked(subjects, lockedUserIds);
      const lockedTokens = await this.#lockTokenFamilies(tx, subjects);
      this.#requireModelAccessWideningAcknowledgement(
        impact.modelIdsBecomingPublic,
        acknowledgePublicModelIds,
      );
      if (lockedTokens.length) {
        await tx`UPDATE api_tokens SET access_mode='restricted',version=version+1
          WHERE id=ANY(${tx.array(lockedTokens.map((token) => token.id))}::uuid[])`;
      }
      await tx`DELETE FROM access_groups WHERE id=${id}`;
      const metadata = {
        ...audit.metadata,
        modelIdsBecomingPublic: impact.modelIdsBecomingPublic,
      };
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${audit.actorId ?? null},${audit.action},${audit.targetType},${id},${
        tx.json(metadata as postgres.JSONValue)
      })`;
    });
  }
  async replaceAccessGroupUsers(
    id: string,
    userIds: string[],
    expectedVersion: number,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    return await this.#sql.begin(async (tx) => {
      const desired = [...new Set(userIds)].sort();
      const preliminarySubjects = await this.#accessGroupTokenSubjects(tx, id);
      const lockedUsers = await lockUsersAndAssertEffectiveAdminActor(
        tx,
        audit.actorId,
        [...desired, ...preliminarySubjects.map((subject) => subject.ownerId)],
        audit.requireEmailVerification,
        audit.expectedAuthorityEpoch,
      );
      const lockedUserIds = new Set(lockedUsers.map((row) => String(row.id)));
      if (desired.some((userId) => !lockedUserIds.has(userId))) {
        throw new DomainError("not_found", "User not found", 404);
      }
      const rows = await tx<
        Row[]
      >`SELECT version FROM access_groups WHERE id=${id} FOR UPDATE`;
      if (!rows[0] || number(rows[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Access group not found or modified", 409);
      }
      const subjects = await this.#accessGroupTokenSubjects(tx, id);
      this.#requireAccessGroupSubjectOwnersLocked(subjects, lockedUserIds);
      const lockedTokens = await this.#lockTokenFamilies(tx, subjects);
      const removedFamilyIds = new Set(
        subjects.filter((subject) => !desired.includes(subject.ownerId)).map((subject) =>
          subject.familyId
        ),
      );
      const tokensLosingMembership = lockedTokens.filter((token) =>
        removedFamilyIds.has(token.familyId)
      );
      if (tokensLosingMembership.length) {
        await tx`UPDATE api_tokens SET access_mode='restricted',version=version+1
          WHERE id=ANY(${tx.array(tokensLosingMembership.map((token) => token.id))}::uuid[])`;
      }
      await tx`DELETE FROM access_group_users WHERE group_id=${id} AND NOT (user_id = ANY(${
        tx.array(desired)
      }::uuid[]))`;
      for (const uid of desired) {
        await tx`INSERT INTO access_group_users(group_id,user_id) VALUES(${id},${uid}) ON CONFLICT DO NOTHING`;
      }
      await tx`UPDATE access_groups SET version=version+1,updated_at=now() WHERE id=${id}`;
      const group = await this.#loadAccessGroup(tx, id);
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${audit.actorId},${audit.action},${audit.targetType},${id},${
        tx.json((audit.metadata ?? {}) as postgres.JSONValue)
      })`;
      return group;
    });
  }
  async replaceAccessGroupModels(
    id: string,
    modelIds: string[],
    expectedVersion: number,
    acknowledgePublicModelIds: string[],
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    return await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(
        tx,
        audit.actorId,
        audit.requireEmailVerification,
        audit.expectedAuthorityEpoch,
      );
      const desiredModelIds = [...new Set(modelIds)];
      const impact = await this.#lockAccessGroupModelPolicy(
        tx,
        id,
        expectedVersion,
        desiredModelIds,
      );
      await this.#requireProviderModelsExist(tx, desiredModelIds);
      this.#requireModelAccessWideningAcknowledgement(
        impact.modelIdsBecomingPublic,
        acknowledgePublicModelIds,
      );
      await tx`UPDATE access_groups SET version=version+1,updated_at=now() WHERE id=${id}`;
      await tx`DELETE FROM access_group_models WHERE group_id=${id}`;
      for (const mid of desiredModelIds) {
        await tx`INSERT INTO access_group_models(group_id,provider_model_id) VALUES(${id},${mid})`;
      }
      const group = await this.#loadAccessGroup(tx, id);
      const metadata = {
        ...audit.metadata,
        modelIdsBecomingPublic: impact.modelIdsBecomingPublic,
      };
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${audit.actorId ?? null},${audit.action},${audit.targetType},${id},${
        tx.json(metadata as postgres.JSONValue)
      })`;
      return group;
    });
  }
  async replaceAccessGroupPolicy(
    id: string,
    input: ReplaceAccessGroupPolicyInput,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    try {
      return await this.#sql.begin(async (tx) => {
        const userIds = [...new Set(input.userIds)].sort();
        const modelIds = [...new Set(input.modelIds)];
        const requestedTokenIds = [...new Set(input.tokenIds)];
        const preliminarySubjects = await this.#accessGroupTokenSubjects(
          tx,
          id,
          requestedTokenIds,
        );
        const lockedUsers = await lockUsersAndAssertEffectiveAdminActor(
          tx,
          audit.actorId,
          [...userIds, ...preliminarySubjects.map((subject) => subject.ownerId)],
          audit.requireEmailVerification,
          audit.expectedAuthorityEpoch,
        );
        const lockedUserIds = new Set(lockedUsers.map((row) => String(row.id)));
        if (userIds.some((userId) => !lockedUserIds.has(userId))) {
          throw new DomainError("not_found", "User not found", 404);
        }
        const impact = await this.#lockAccessGroupModelPolicy(
          tx,
          id,
          input.expectedVersion,
          modelIds,
          true,
        );
        const metadataRows = await tx<
          Row[]
        >`SELECT name,description FROM access_groups WHERE id=${id}`;
        const before = {
          name: String(metadataRows[0].name),
          description: String(metadataRows[0].description),
        };
        const after = {
          name: input.name?.trim() ?? before.name,
          description: input.description ?? before.description,
        };
        await this.#requireProviderModelsExist(tx, modelIds);
        this.#requireModelAccessWideningAcknowledgement(
          impact.modelIdsBecomingPublic,
          input.acknowledgePublicModelIds,
        );
        const requestedExisting = requestedTokenIds.length
          ? await tx<Row[]>`SELECT id FROM api_tokens WHERE id=ANY(${
            tx.array(requestedTokenIds)
          }::uuid[])`
          : [];
        if (requestedExisting.length !== requestedTokenIds.length) {
          throw new DomainError("not_found", "Token not found", 404);
        }
        const subjects = await this.#accessGroupTokenSubjects(tx, id, requestedTokenIds);
        this.#requireAccessGroupSubjectOwnersLocked(subjects, lockedUserIds);
        await this.#lockTokenFamilies(tx, subjects);
        const desiredRows = requestedTokenIds.length
          ? await tx<
            Row[]
          >`SELECT id FROM api_tokens WHERE rotation_family_id IN (SELECT rotation_family_id FROM api_tokens WHERE id=ANY(${
            tx.array(requestedTokenIds)
          }::uuid[])) ORDER BY id`
          : [];
        const tokenIds = desiredRows.map((row) => String(row.id));
        const existingRows = await tx<
          Row[]
        >`SELECT token_id FROM access_group_tokens WHERE group_id=${id}`;
        const rawExistingTokenIds = existingRows.map((row) => String(row.token_id));
        const expandedExisting = rawExistingTokenIds.length
          ? await tx<
            Row[]
          >`SELECT id FROM api_tokens WHERE rotation_family_id IN (SELECT rotation_family_id FROM api_tokens WHERE id=ANY(${
            tx.array(rawExistingTokenIds)
          }::uuid[])) ORDER BY id`
          : [];
        const existingTokenIds = expandedExisting.map((row) => String(row.id));
        const affected = [...new Set([...existingTokenIds, ...tokenIds])].sort();
        const locked = affected.length
          ? await tx<Row[]>`SELECT id,user_id FROM api_tokens WHERE id=ANY(${
            tx.array(affected)
          }::uuid[]) ORDER BY id FOR UPDATE`
          : [];
        const owners = new Map(locked.map((row) => [String(row.id), String(row.user_id)]));
        if (owners.size !== affected.length) {
          throw new DomainError("not_found", "Token not found", 404);
        }
        for (const tokenId of tokenIds) {
          const owner = owners.get(tokenId)!;
          if (!userIds.includes(owner)) {
            throw new DomainError(
              "validation_error",
              "Every token owner must be included in the group",
              422,
            );
          }
        }
        await tx`UPDATE access_groups SET name=${after.name},description=${after.description},
        version=version+1,updated_at=now() WHERE id=${id}`;
        await tx`DELETE FROM access_group_tokens WHERE group_id=${id}`;
        await tx`DELETE FROM access_group_users WHERE group_id=${id}`;
        await tx`DELETE FROM access_group_models WHERE group_id=${id}`;
        for (const userId of userIds) {
          await tx`INSERT INTO access_group_users(group_id,user_id) VALUES(${id},${userId})`;
        }
        for (const modelId of modelIds) {
          await tx`INSERT INTO access_group_models(group_id,provider_model_id) VALUES(${id},${modelId})`;
        }
        for (const tokenId of tokenIds) {
          const owner = owners.get(tokenId)!;
          await tx`INSERT INTO access_group_tokens(group_id,token_id,user_id) VALUES(${id},${tokenId},${owner})`;
        }
        const changedTokens = affected.filter((tokenId) =>
          existingTokenIds.includes(tokenId) !== tokenIds.includes(tokenId)
        );
        if (changedTokens.length) {
          await tx`UPDATE api_tokens SET access_mode='restricted',version=version+1 WHERE id=ANY(${
            tx.array(changedTokens)
          }::uuid[])`;
        }
        const group = await this.#loadAccessGroup(tx, id);
        const metadata = {
          ...audit.metadata,
          before,
          after,
          modelIdsBecomingPublic: impact.modelIdsBecomingPublic,
        };
        await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${audit.actorId ?? null},${audit.action},${audit.targetType},${id},${
          tx.json(metadata as postgres.JSONValue)
        })`;
        return group;
      });
    } catch (error) {
      const postgresError = error as { code?: string; constraint_name?: string };
      if (
        postgresError.code === "23505" &&
        postgresError.constraint_name === "access_groups_name_uq"
      ) {
        throw new DomainError("conflict", "Access group name is already used", 409);
      }
      throw error;
    }
  }
  async previewAccessGroupPolicyImpact(
    context: PrivilegedReadContext,
    id: string,
    proposal: AccessGroupPolicyProposal | null = null,
  ): Promise<AccessGroupPolicyImpact> {
    requirePrivilegedReadContext(context);
    return await this.#sql.begin(async (tx) => {
      await assertEffectiveAdminActor(
        tx,
        context.actorId,
        context.requireEmailVerification,
        context.expectedAuthorityEpoch,
      );
      const group = await this.#loadAccessGroup(tx, id);
      const nextModels = new Set(proposal?.modelIds ?? []);
      const proposedTokenIds = [...new Set(proposal?.tokenIds ?? [])];
      const expandedProposed = proposedTokenIds.length
        ? await tx<Row[]>`SELECT id FROM api_tokens WHERE rotation_family_id IN
          (SELECT rotation_family_id FROM api_tokens WHERE id=ANY(${
          tx.array(proposedTokenIds)
        }::uuid[]))`
        : [];
      const nextTokens = new Set(expandedProposed.map((row) => String(row.id)));
      const models: string[] = [];
      for (const modelId of group.modelIds) {
        if (
          !nextModels.has(modelId) &&
          !(await tx<
            Row[]
          >`SELECT 1 FROM access_group_models WHERE provider_model_id=${modelId} AND group_id<>${id} LIMIT 1`)
            .length
        ) models.push(modelId);
      }
      const tokens = group.tokenIds.filter((tokenId) => !nextTokens.has(tokenId));
      return {
        modelIdsBecomingPublic: models,
        tokenIdsLosingGroupAccess: tokens,
        tokenIdsRevertingToOwnerInheritance: [],
      };
    });
  }
  async setTokenAccessGroups(
    userId: string,
    tokenId: string,
    groupIds: string[],
    expectedVersion: number,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    return await this.#sql.begin(async (tx) => {
      const userLockIds = [
        ...new Set([userId, audit.actorId].filter(
          (id): id is string => typeof id === "string",
        )),
      ].sort();
      await tx`SELECT id FROM users WHERE id=ANY(${tx.array(userLockIds)}::uuid[])
        ORDER BY id FOR UPDATE`;
      await assertEffectiveAdminActor(
        tx,
        audit.actorId,
        audit.requireEmailVerification,
        audit.expectedAuthorityEpoch,
      );
      const desiredGroupIds = [...new Set(groupIds)].sort();
      if (desiredGroupIds.length) {
        await tx`SELECT id FROM access_groups
          WHERE id=ANY(${tx.array(desiredGroupIds)}::uuid[]) ORDER BY id FOR KEY SHARE`;
      }
      for (const groupId of desiredGroupIds) {
        const membership =
          await tx`SELECT 1 FROM access_group_users WHERE group_id=${groupId} AND user_id=${userId}`;
        if (!membership.length) {
          throw new DomainError("forbidden", "Token groups must be held by the owner", 403);
        }
      }
      const seed = await tx<
        Row[]
      >`SELECT rotation_family_id FROM api_tokens WHERE id=${tokenId} AND user_id=${userId}`;
      if (!seed[0]) throw new DomainError("not_found", "Token not found", 404);
      const familyId = String(seed[0].rotation_family_id);
      await this.#lockTokenFamilies(tx, [{ familyId }]);
      const current = await tx<
        Row[]
      >`SELECT * FROM api_tokens WHERE id=${tokenId} AND user_id=${userId}`;
      if (!current[0] || number(current[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Token not found or modified", 409);
      }
      await tx`DELETE FROM access_group_tokens WHERE token_id IN (SELECT id FROM api_tokens WHERE rotation_family_id=${familyId})`;
      for (const gid of desiredGroupIds) {
        await tx`INSERT INTO access_group_tokens(group_id,token_id,user_id) SELECT ${gid},id,user_id FROM api_tokens WHERE rotation_family_id=${familyId}`;
      }
      await tx`UPDATE api_tokens SET access_mode='restricted',version=version+1 WHERE rotation_family_id=${familyId}`;
      const updated = await tx<Row[]>`SELECT * FROM api_tokens WHERE id=${tokenId}`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${audit.actorId ?? null},${audit.action},${audit.targetType},${tokenId},${
        tx.json((audit.metadata ?? {}) as postgres.JSONValue)
      })`;
      return tokenSummary(token(updated[0]));
    });
  }
  async setTokenAccessMode(
    userId: string,
    tokenId: string,
    mode: "inherit" | "restricted",
    expectedVersion: number,
    audit: PrivilegedAuditEventInput,
  ) {
    requirePrivilegedAuditContext(audit);
    return await this.#sql.begin(async (tx) => {
      const userLockIds = [
        ...new Set([userId, audit.actorId].filter(
          (id): id is string => typeof id === "string",
        )),
      ].sort();
      await tx`SELECT id FROM users WHERE id=ANY(${tx.array(userLockIds)}::uuid[])
        ORDER BY id FOR UPDATE`;
      await assertEffectiveAdminActor(
        tx,
        audit.actorId,
        audit.requireEmailVerification,
        audit.expectedAuthorityEpoch,
      );
      const seed = await tx<
        Row[]
      >`SELECT rotation_family_id FROM api_tokens WHERE id=${tokenId} AND user_id=${userId}`;
      if (!seed[0]) throw new DomainError("not_found", "Token not found", 404);
      const familyId = String(seed[0].rotation_family_id);
      await this.#lockTokenFamilies(tx, [{ familyId }]);
      const current = await tx<
        Row[]
      >`SELECT * FROM api_tokens WHERE id=${tokenId} AND user_id=${userId}`;
      if (!current[0] || number(current[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Token not found or modified", 409);
      }
      if (mode === "inherit") {
        await tx`DELETE FROM access_group_tokens WHERE token_id IN (SELECT id FROM api_tokens WHERE rotation_family_id=${familyId})`;
      }
      await tx`UPDATE api_tokens SET access_mode=${mode},version=version+1 WHERE rotation_family_id=${familyId}`;
      const updated = await tx<Row[]>`SELECT * FROM api_tokens WHERE id=${tokenId}`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${audit.actorId ?? null},${audit.action},${audit.targetType},${tokenId},${
        tx.json((audit.metadata ?? {}) as postgres.JSONValue)
      })`;
      return tokenSummary(token(updated[0]));
    });
  }
  async listEntitledProviderModels(subject: TokenAccessSubject) {
    const rows = await this.#sql<
      Row[]
    >`SELECT m.* FROM provider_models m WHERE m.enabled AND (${
      subject.tokenId ?? null
    }::uuid IS NULL OR EXISTS(SELECT 1 FROM api_tokens at WHERE at.id=${
      subject.tokenId ?? null
    } AND at.user_id=${subject.userId} AND at.revoked_at IS NULL AND (at.expires_at IS NULL OR at.expires_at>now()) AND (at.replaced_by_token_id IS NULL OR at.overlap_ends_at>now()))) AND (NOT EXISTS(SELECT 1 FROM access_group_models gm WHERE gm.provider_model_id=m.id) OR EXISTS(SELECT 1 FROM access_group_models gm JOIN access_group_users gu ON gu.group_id=gm.group_id WHERE gm.provider_model_id=m.id AND gu.user_id=${subject.userId} AND (${
      subject.tokenId ?? null
    }::uuid IS NULL OR (SELECT access_mode FROM api_tokens WHERE id=${
      subject.tokenId ?? null
    })='inherit' OR EXISTS(SELECT 1 FROM access_group_tokens gt WHERE gt.token_id=${
      subject.tokenId ?? null
    } AND gt.group_id=gm.group_id))))`;
    return rows.map(providerModel);
  }
  async resolveEntitledProviderModel(
    subject: TokenAccessSubject,
    requestedId: string,
  ): Promise<EntitledProviderModel | undefined> {
    const row = (await this.#sql<
      Row[]
    >`SELECT m.*,a.id alias_id,a.alias alias_name,a.description alias_description,a.version alias_version,a.created_at alias_created_at,a.updated_at alias_updated_at FROM provider_models m LEFT JOIN model_aliases a ON a.target_model_id=m.id AND a.alias=${requestedId} WHERE m.public_model_id=${requestedId} OR a.alias=${requestedId} ORDER BY (m.public_model_id=${requestedId}) DESC LIMIT 1`)[
      0
    ];
    if (!row) return undefined;
    if (!row.enabled) return undefined;
    const access = await this.#sql<Row[]>`SELECT ((${
      subject.tokenId ?? null
    }::uuid IS NULL OR EXISTS(SELECT 1 FROM api_tokens at WHERE at.id=${
      subject.tokenId ?? null
    } AND at.user_id=${subject.userId} AND at.revoked_at IS NULL AND (at.expires_at IS NULL OR at.expires_at>now()) AND (at.replaced_by_token_id IS NULL OR at.overlap_ends_at>now()))) AND (NOT EXISTS(SELECT 1 FROM access_group_models gm WHERE gm.provider_model_id=${
      String(row.id)
    }) OR EXISTS(SELECT 1 FROM access_group_models gm JOIN access_group_users gu ON gu.group_id=gm.group_id WHERE gm.provider_model_id=${
      String(row.id)
    } AND gu.user_id=${subject.userId} AND (${
      subject.tokenId ?? null
    }::uuid IS NULL OR (SELECT access_mode FROM api_tokens WHERE id=${
      subject.tokenId ?? null
    })='inherit' OR EXISTS(SELECT 1 FROM access_group_tokens gt WHERE gt.token_id=${
      subject.tokenId ?? null
    } AND gt.group_id=gm.group_id))))) allowed`;
    if (!access[0]?.allowed) return undefined;
    const model = providerModel(row);
    const groups = await this.#sql<
      Row[]
    >`SELECT gm.group_id FROM access_group_models gm JOIN access_group_users gu ON gu.group_id=gm.group_id WHERE gm.provider_model_id=${model.id} AND gu.user_id=${subject.userId} AND (${
      subject.tokenId ?? null
    }::uuid IS NULL OR (SELECT access_mode FROM api_tokens WHERE id=${
      subject.tokenId ?? null
    })='inherit' OR EXISTS(SELECT 1 FROM access_group_tokens gt WHERE gt.token_id=${
      subject.tokenId ?? null
    } AND gt.group_id=gm.group_id))`;
    return {
      model,
      alias: row.alias_id
        ? {
          id: String(row.alias_id),
          alias: String(row.alias_name),
          targetModelId: model.id,
          description: String(row.alias_description),
          version: number(row.alias_version),
          createdAt: iso(row.alias_created_at),
          updatedAt: iso(row.alias_updated_at),
        }
        : null,
      matchedGroupIds: groups.map((g) => String(g.group_id)),
    };
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
        >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,recovery_owner,status,reserved_micros,run_lease_token,run_lease_expires_at,pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source) VALUES(${runId},${userId},${
          tokenId ?? null
        },${model},${provider},'provider','reserved',${amount},${runLeaseToken},now()+120*interval '1 second',${
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
      if (
        number(runs[0].execution_epoch) > 0 &&
        runs[0].provider_accounting_uncertain === true
      ) {
        // The route supplies customer usage and cost from the immutable public/source pricing
        // snapshot. Target-attempt aggregates remain separate provider-cost telemetry.
        await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
          error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
          latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
          completed_at=now() WHERE usage_run_id=${runId} AND status='running'`;
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
      const actualCost = embeddingExecution ? number(runs[0].reserved_micros) : 0;
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
      >`UPDATE usage_runs SET status='failed',cost_micros=${actualCost},input_tokens=0,output_tokens=0,error=${
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
      retentionSeconds > 2_592_000 ||
      !Number.isSafeInteger(input.replayReservedBytes ?? 0) ||
      (input.replayReservedBytes ?? 0) < 0 ||
      !Number.isSafeInteger(input.replayReservedEvents ?? 0) ||
      (input.replayReservedEvents ?? 0) < 0 ||
      ((input.replayReservedBytes ?? 0) === 0 && (input.replayReservedEvents ?? 0) > 0)
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
      >`INSERT INTO api_idempotency_requests(id,user_id,endpoint,idempotency_key,request_hash,stream,model,state,lease_token,lease_expires_at,usage_run_id,replay_reserved_bytes,replay_reserved_events,retention_seconds,expires_at) VALUES(${id},${input.userId},${input.endpoint},${input.idempotencyKey},${input.requestHash},${input.stream},${input.model},'in_progress',${leaseToken},now()+${leaseSeconds}*interval '1 second',${input.runId},${
        input.replayReservedBytes ?? 0
      },${
        input.replayReservedEvents ?? 0
      },${retentionSeconds},now()+${retentionSeconds}*interval '1 second') ON CONFLICT(user_id,endpoint,idempotency_key) DO NOTHING RETURNING *`;
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
        { count: number; bytes: number; events: number }[]
      >`SELECT count(*)::int count,
        COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_bytes>0
          THEN replay_reserved_bytes
          ELSE COALESCE(CASE response_body_encoding WHEN 'base64'
            THEN octet_length(decode(response_body,'base64')) ELSE octet_length(response_body) END,0) +
            COALESCE((SELECT sum(octet_length(frame)) FROM api_idempotency_events e WHERE e.request_id=r.id),0)
        END),0)::bigint bytes,
        COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_events>0
          THEN replay_reserved_events
          ELSE (SELECT count(*) FROM api_idempotency_events e WHERE e.request_id=r.id)
        END),0)::bigint events
        FROM api_idempotency_requests r WHERE user_id=${input.userId} AND expires_at>now()`;
      if (live[0].count > quota.maxRequests) {
        throw new DomainError("replay_quota_exceeded", "Replay request quota exceeded", 429);
      }
      if (number(live[0].bytes) > quota.maxBytes || number(live[0].events) > quota.maxEvents) {
        throw new DomainError("replay_quota_exceeded", "Replay storage quota exceeded", 429);
      }
      const balance = number(users[0].balance_micros);
      if (balance < input.reserveMicros) {
        throw new DomainError("insufficient_credit", "Insufficient credit", 402);
      }
      const pricing = input.pricingSnapshot;
      const runs = await tx<
        Row[]
      >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,recovery_owner,status,reserved_micros,pricing_version_id,pricing_input_micros_per_million,pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source) VALUES(${input.runId},${input.userId},${
        input.tokenId ?? null
      },${input.model},${input.provider},'api_replay','reserved',${input.reserveMicros},${
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
    if (frameBytes.some((bytes) => bytes > API_SSE_REPLAY_FRAGMENT_MAX_BYTES)) {
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
      if (
        stats[0].count + pending.length > API_SSE_REPLAY_REQUEST_MAX_EVENTS ||
        stats[0].bytes + pendingBytes > API_SSE_REPLAY_REQUEST_MAX_BYTES
      ) {
        throw new DomainError("response_too_large", "SSE replay exceeds storage limit", 413);
      }
      const quota = replayQuota(quotaInput);
      const reservedBytes = number(rows[0].replay_reserved_bytes ?? 0);
      const reservedEvents = number(rows[0].replay_reserved_events ?? 0);
      if (
        (reservedBytes > 0 || reservedEvents > 0) &&
        (stats[0].count + pending.length > reservedEvents ||
          stats[0].bytes + pendingBytes > reservedBytes)
      ) throw new DomainError("replay_quota_exceeded", "Reserved replay capacity exceeded", 429);
      const aggregate = await tx<
        { events: number; bytes: number }[]
      >`SELECT
        COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_events>0
          THEN replay_reserved_events
          ELSE (SELECT count(*) FROM api_idempotency_events e WHERE e.request_id=r.id)
        END),0)::bigint events,
        COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_bytes>0
          THEN replay_reserved_bytes
          ELSE COALESCE(CASE response_body_encoding WHEN 'base64'
            THEN octet_length(decode(response_body,'base64')) ELSE octet_length(response_body) END,0) +
            COALESCE((SELECT sum(octet_length(frame)) FROM api_idempotency_events e WHERE e.request_id=r.id),0)
        END),0)::bigint bytes
        FROM api_idempotency_requests r WHERE user_id=${
        String(rows[0].user_id)
      } AND expires_at>now()`;
      if (
        reservedBytes === 0 && reservedEvents === 0 && (
          number(aggregate[0].events) + pending.length > quota.maxEvents ||
          number(aggregate[0].bytes) + pendingBytes > quota.maxBytes
        )
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
  async releaseApiRequestLease(id: string, leaseToken: string) {
    const rows = await this.#sql<Row[]>`
      UPDATE api_idempotency_requests SET lease_expires_at=now()-interval '1 millisecond',
        updated_at=now() WHERE id=${id} AND state='in_progress' AND lease_token=${leaseToken}
        AND lease_expires_at>now() RETURNING *`;
    if (!rows[0]) throw new DomainError("stale_lease", "Idempotent request lease is stale", 409);
    const events = await this.#sql<Row[]>`
      SELECT * FROM api_idempotency_events WHERE request_id=${id} ORDER BY sequence`;
    return apiRequest(rows[0], events.map(apiFrame));
  }
  async reclaimApiRequest(id: string, expiredLeaseToken: string, leaseSeconds = 120) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new DomainError("validation_error", "Lease duration is invalid", 422);
    }
    const leaseToken = crypto.randomUUID();
    const rows = await this.#sql<Row[]>`
      UPDATE api_idempotency_requests SET lease_token=${leaseToken},
        lease_expires_at=now()+${leaseSeconds}*interval '1 second',updated_at=now()
      WHERE id=${id} AND state='in_progress' AND lease_token=${expiredLeaseToken}
        AND lease_expires_at<=now() RETURNING *`;
    if (!rows[0]) {
      throw new DomainError("stale_lease", "Idempotent request cannot be reclaimed", 409);
    }
    const events = await this.#sql<Row[]>`
      SELECT * FROM api_idempotency_events WHERE request_id=${id} ORDER BY sequence`;
    return { request: apiRequest(rows[0], events.map(apiFrame)), leaseToken };
  }
  async #completeApi(input: CompleteApiRequestInput, stream: boolean) {
    const responseBodyEncoding = input.responseBodyEncoding ?? "utf8";
    const decodedResponseBytes = input.responseBody
      ? apiResponseBodyByteLength(input.responseBody, responseBodyEncoding)
      : 0;
    if (decodedResponseBytes > API_SSE_REPLAY_REQUEST_MAX_BYTES) {
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
          String(row.response_body ?? "") !== (input.responseBody ?? "") ||
          String(row.response_body_encoding ?? "utf8") !== responseBodyEncoding
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
      if (
        frameInputs.some(({ frame }) =>
          encoder.encode(frame).length > API_SSE_REPLAY_FRAGMENT_MAX_BYTES
        )
      ) {
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
      const terminalFragments = stream && input.terminalFrame !== undefined
        ? splitApiSseReplayFrame(input.terminalFrame)
        : [];
      const terminalBytes = terminalFragments.reduce(
        (sum, frame) => sum + encoder.encode(frame).length,
        0,
      );
      if (
        stats[0].count + pending.length + terminalFragments.length >
          API_SSE_REPLAY_REQUEST_MAX_EVENTS ||
        stats[0].bytes + pendingBytes + terminalBytes > API_SSE_REPLAY_REQUEST_MAX_BYTES
      ) throw new DomainError("response_too_large", "SSE replay exceeds storage limit", 413);
      const quota = replayQuota(input.quota);
      const responseBytes = decodedResponseBytes;
      const reservedBytes = number(row.replay_reserved_bytes ?? 0);
      const reservedEvents = number(row.replay_reserved_events ?? 0);
      if (
        (reservedBytes > 0 || reservedEvents > 0) &&
        (stats[0].count + pending.length + terminalFragments.length > reservedEvents ||
          stats[0].bytes + responseBytes + pendingBytes + terminalBytes > reservedBytes)
      ) throw new DomainError("replay_quota_exceeded", "Reserved replay capacity exceeded", 429);
      await tx`SELECT id FROM users WHERE id=${String(row.user_id)} FOR UPDATE`;
      const aggregate = await tx<
        { events: number; bytes: number }[]
      >`SELECT
        COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_events>0
          THEN replay_reserved_events
          ELSE (SELECT count(*) FROM api_idempotency_events e WHERE e.request_id=r.id)
        END),0)::bigint events,
        COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_bytes>0
          THEN replay_reserved_bytes
          ELSE COALESCE(CASE response_body_encoding WHEN 'base64'
            THEN octet_length(decode(response_body,'base64')) ELSE octet_length(response_body) END,0) +
            COALESCE((SELECT sum(octet_length(frame)) FROM api_idempotency_events e WHERE e.request_id=r.id),0)
        END),0)::bigint bytes
        FROM api_idempotency_requests r WHERE user_id=${String(row.user_id)} AND expires_at>now()`;
      if (
        reservedBytes === 0 && reservedEvents === 0 && (
          number(aggregate[0].events) + pending.length + terminalFragments.length >
            quota.maxEvents ||
          number(aggregate[0].bytes) + responseBytes + pendingBytes + terminalBytes > quota.maxBytes
        )
      ) throw new DomainError("replay_quota_exceeded", "User replay storage quota exceeded", 429);
      const completingFrames = [...pending];
      if (stream) {
        for (const frame of terminalFragments) {
          completingFrames.push({
            sequence: stats[0].count + completingFrames.length,
            frame,
          });
        }
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
        const effectiveCost = input.costMicros;
        const effectiveInputTokens = input.inputTokens;
        const effectiveOutputTokens = input.outputTokens;
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
      },response_body_encoding=${responseBodyEncoding},completed_at=now(),updated_at=now(),expires_at=now()+retention_seconds*interval '1 second' WHERE id=${input.id} RETURNING *`;
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
    const responseBytes = new TextEncoder().encode(input.responseBody).length;
    if (responseBytes > API_SSE_REPLAY_REQUEST_MAX_BYTES) {
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
      const terminalFragments = input.terminalFrame === undefined
        ? []
        : splitApiSseReplayFrame(input.terminalFrame);
      const terminalBytes = input.terminalFrame === undefined
        ? 0
        : new TextEncoder().encode(input.terminalFrame).length;
      if (
        eventCount + terminalFragments.length > API_SSE_REPLAY_REQUEST_MAX_EVENTS ||
        stats[0].bytes + terminalBytes > API_SSE_REPLAY_REQUEST_MAX_BYTES
      ) {
        throw new DomainError(
          "response_too_large",
          "SSE replay exceeds storage limit",
          413,
        );
      }
      const reservedBytes = number(row.replay_reserved_bytes ?? 0);
      const reservedEvents = number(row.replay_reserved_events ?? 0);
      if (
        (reservedBytes > 0 || reservedEvents > 0) &&
        (eventCount + terminalFragments.length > reservedEvents ||
          stats[0].bytes + responseBytes + terminalBytes > reservedBytes)
      ) {
        throw new DomainError(
          "replay_quota_exceeded",
          "Reserved replay capacity exceeded",
          429,
        );
      }
      await tx`SELECT id FROM users WHERE id=${String(row.user_id)} FOR UPDATE`;
      if (reservedBytes === 0 && reservedEvents === 0) {
        const quota = replayQuota(input.quota);
        const aggregate = await tx<
          { events: number; bytes: number }[]
        >`SELECT
          COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_events>0
            THEN replay_reserved_events
            ELSE (SELECT count(*) FROM api_idempotency_events e WHERE e.request_id=r.id)
          END),0)::bigint events,
          COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_bytes>0
            THEN replay_reserved_bytes
            ELSE COALESCE(CASE response_body_encoding WHEN 'base64'
              THEN octet_length(decode(response_body,'base64')) ELSE octet_length(response_body) END,0) +
              COALESCE((SELECT sum(octet_length(frame)) FROM api_idempotency_events e WHERE e.request_id=r.id),0)
          END),0)::bigint bytes
          FROM api_idempotency_requests r WHERE user_id=${
          String(row.user_id)
        } AND expires_at>now()`;
        if (
          number(aggregate[0].events) + terminalFragments.length > quota.maxEvents ||
          number(aggregate[0].bytes) + responseBytes + terminalBytes > quota.maxBytes
        ) {
          throw new DomainError(
            "replay_quota_exceeded",
            "User replay storage quota exceeded",
            429,
          );
        }
      }
      if (input.terminalFrame !== undefined) {
        await tx`INSERT INTO api_idempotency_events ${
          tx(
            terminalFragments.map((frame, index) => ({
              request_id: input.id,
              sequence: eventCount + index,
              frame,
            })),
            "request_id",
            "sequence",
            "frame",
          )
        }`;
        eventCount += terminalFragments.length;
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
        if (input.billing.mode === "refund") {
          const effectiveCost = 0;
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
          await tx`UPDATE usage_runs SET status='failed',cost_micros=${effectiveCost},input_tokens=0,
            output_tokens=0,run_lease_token=NULL,run_lease_expires_at=NULL,
            error='idempotent request failed',completed_at=now() WHERE id=${
            String(row.usage_run_id)
          }`;
        } else {
          if (providerExecution && runs[0].provider_accounting_uncertain === true) {
            await tx`UPDATE provider_attempts SET status='cancelled',phase='planning',
              error_code='accounting_unknown',breaker_after='unavailable',retryable=false,
              latency_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000)::int),
              completed_at=now() WHERE usage_run_id=${
              String(row.usage_run_id)
            } AND status='running'`;
          }
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
  async reapStaleApiRequests(limit = 100, quotaInput?: ApiReplayQuota) {
    const quota = replayQuota(quotaInput);
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT r.* FROM api_idempotency_requests r
        WHERE r.state='in_progress' AND r.lease_expires_at<=now()
          AND NOT (r.endpoint='images.generations' AND EXISTS(
            SELECT 1 FROM generated_assets ga WHERE ga.usage_run_id=r.usage_run_id))
          AND NOT (r.endpoint='files' AND EXISTS(
            SELECT 1 FROM file_upload_staging s
            WHERE s.request_id=r.id AND s.state<>'finalized'))
        ORDER BY r.lease_expires_at FOR UPDATE OF r SKIP LOCKED LIMIT ${limit}`;
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
          const effectiveCost = number(row.observed_cost_micros);
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
            number(row.observed_input_tokens)
          },output_tokens=${number(row.observed_output_tokens)},latency_ms=${
            number(row.observed_latency_ms)
          },run_lease_token=NULL,run_lease_expires_at=NULL,error=${
            effectiveCost > 0
              ? "request lease expired after partial usage"
              : "request lease expired"
          },completed_at=now() WHERE id=${String(row.usage_run_id)}`;
        }
        await tx`SELECT id FROM users WHERE id=${String(row.user_id)} FOR UPDATE`;
        const stats = await tx<
          { count: number; bytes: number }[]
        >`SELECT count(*)::int count,COALESCE(sum(octet_length(frame)),0)::int bytes
          FROM api_idempotency_events WHERE request_id=${id}`;
        const aggregate = await tx<
          { events: number; bytes: number }[]
        >`SELECT
          COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_events>0
            THEN replay_reserved_events
            ELSE (SELECT count(*) FROM api_idempotency_events e WHERE e.request_id=r.id)
          END),0)::bigint events,
          COALESCE(sum(CASE WHEN state='in_progress' AND replay_reserved_bytes>0
            THEN replay_reserved_bytes
            ELSE COALESCE(CASE response_body_encoding WHEN 'base64'
              THEN octet_length(decode(response_body,'base64')) ELSE octet_length(response_body) END,0) +
              COALESCE((SELECT sum(octet_length(frame)) FROM api_idempotency_events e
                WHERE e.request_id=r.id),0)
          END),0)::bigint bytes
          FROM api_idempotency_requests r WHERE user_id=${
          String(row.user_id)
        } AND expires_at>now()`;
        const recovery = planAbandonedApiReplay({
          endpoint: row.endpoint as ApiIdempotencyEndpoint,
          eventCount: stats[0].count,
          eventBytes: stats[0].bytes,
          replayReservedBytes: number(row.replay_reserved_bytes ?? 0),
          replayReservedEvents: number(row.replay_reserved_events ?? 0),
          aggregateBytes: number(aggregate[0].bytes),
          aggregateEvents: number(aggregate[0].events),
          quota,
        });
        if (recovery.terminalFrame !== null) {
          await tx`INSERT INTO api_idempotency_events(request_id,sequence,frame) VALUES(${id},${
            stats[0].count
          },${recovery.terminalFrame})`;
        }
        const responseHeaders = {
          "content-type": stats[0].count > 0 ? "text/event-stream" : "application/json",
          ...(stats[0].count > 0 ? { "cache-control": "no-cache" } : {}),
        };
        await tx`UPDATE api_idempotency_requests SET state='failed',lease_token=NULL,lease_expires_at=NULL,response_status=${
          stats[0].count > 0 ? 200 : 500
        },response_headers=${
          tx.json(responseHeaders)
        },response_body=${recovery.responseBody},failure_started_stream=${
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
    >`SELECT u.balance_micros,
      count(r.id) FILTER(WHERE r.status='completed' OR r.cost_micros>0)::int calls,
      COALESCE(sum(r.input_tokens) FILTER(WHERE r.status='completed' OR r.cost_micros>0),0)::bigint input_tokens,
      COALESCE(sum(r.output_tokens) FILTER(WHERE r.status='completed' OR r.cost_micros>0),0)::bigint output_tokens,
      COALESCE(sum(r.cost_micros) FILTER(WHERE r.status='completed' OR r.cost_micros>0),0)::bigint spent_micros
      FROM users u LEFT JOIN usage_runs r ON r.user_id=u.id WHERE u.id=${userId} GROUP BY u.id`;
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
    >`SELECT * FROM ledger_entries WHERE user_id=${userId} ORDER BY sequence,id`).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      sequence: number(row.sequence),
      usageRunId: String(row.usage_run_id),
      kind: row.kind as LedgerEntry["kind"],
      amountMicros: number(row.amount_micros),
      balanceAfterMicros: number(row.balance_after_micros),
      createdAt: iso(row.created_at),
    }));
  }
  async enqueueJob(
    type: string,
    payload: unknown,
    availableAt?: string,
    idempotencyKey?: string,
  ) {
    if (idempotencyKey === undefined) {
      const rows = await this.#sql<
        Row[]
      >`INSERT INTO jobs(type,payload,available_at) VALUES(${type},${
        this.#sql.json(payload as postgres.JSONValue)
      },${availableAt ?? new Date().toISOString()}) RETURNING id`;
      return String(rows[0].id);
    }
    return await this.#sql.begin(async (tx) => {
      const inserted = await tx<Row[]>`
        INSERT INTO jobs(type,payload,available_at,idempotency_key)
        VALUES(${type},${tx.json(payload as postgres.JSONValue)},
          ${availableAt ?? new Date().toISOString()},${idempotencyKey})
        ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`;
      if (inserted[0]) return String(inserted[0].id);
      const existing = await tx<Row[]>`
        SELECT id FROM jobs WHERE idempotency_key=${idempotencyKey}
          AND type=${type} AND payload=${tx.json(payload as postgres.JSONValue)}`;
      const prior = existing[0];
      if (!prior) {
        throw new DomainError(
          "job_idempotency_conflict",
          "Job idempotency key payload differs",
          409,
        );
      }
      return String(prior.id);
    });
  }
  async adminSummary() {
    const totals = await this.#sql<
      Row[]
    >`SELECT (SELECT count(*)::numeric FROM usage_runs) calls,
      (SELECT count(*)::numeric FROM users) users,
      COALESCE((SELECT sum(balance_micros)::numeric FROM users),0::numeric) balance_micros`;
    const calls = Number(totals[0].calls);
    const users = Number(totals[0].users);
    const balanceMicros = Number(totals[0].balance_micros);
    if (
      !Number.isSafeInteger(calls) || !Number.isSafeInteger(users) ||
      !Number.isSafeInteger(balanceMicros)
    ) {
      throw new DomainError(
        "accounting_overflow",
        "Administrative usage summary exceeds safe integer bounds",
        500,
      );
    }
    return {
      calls,
      users,
      balanceMicros,
    };
  }
  async adminAnalytics(query: AdminAnalyticsQuery): Promise<AdminAnalytics> {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    const range = to - from;
    if (
      !Number.isFinite(from) || !Number.isFinite(to) || from >= to || range > 90 * 86_400_000 ||
      (query.bucket === "hour" && range > 14 * 86_400_000) ||
      !["hour", "day"].includes(query.bucket)
    ) {
      throw new DomainError("validation_error", "Invalid analytics range or bucket", 422);
    }
    if (
      (query.userId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          query.userId,
        )) ||
      [query.model, query.provider].some((value) =>
        value !== undefined && (value.length < 1 || value.length > 200)
      ) ||
      (query.status && !["reserved", "completed", "failed"].includes(query.status))
    ) {
      throw new DomainError("validation_error", "Invalid analytics filter", 422);
    }
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    const userId = query.userId ?? "00000000-0000-0000-0000-000000000000";
    const model = query.model ?? "";
    const provider = query.provider ?? "";
    const status = query.status ?? "";
    // All panels must describe one point-in-time view even when usage is settling concurrently.
    return await this.#sql.begin("isolation level repeatable read read only", async (tx) => {
      const summaryRows = await tx<Row[]>`SELECT count(*)::int calls,
      count(*) FILTER(WHERE status='completed')::int completed,
      count(*) FILTER(WHERE status='failed')::int failed,
      COALESCE(sum(input_tokens),0)::bigint input_tokens,
      COALESCE(sum(actual_provider_cached_input_tokens),0)::bigint cached_input_tokens,
      COALESCE(sum(actual_provider_reasoning_tokens),0)::bigint reasoning_tokens,
      COALESCE(sum(output_tokens),0)::bigint output_tokens,
      COALESCE(sum(cost_micros),0)::bigint customer_cost_micros,
      COALESCE(sum(actual_provider_cost_micros),0)::bigint provider_cost_micros,
      avg(latency_ms)::float8 avg_latency_ms,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY latency_ms) FILTER(WHERE latency_ms IS NOT NULL)::float8 p95_latency_ms,
      avg(ttft_ms)::float8 avg_ttft_ms
      FROM usage_runs WHERE created_at>=${fromIso} AND created_at<${toIso}
      AND (${query.userId === undefined} OR user_id=${userId}::uuid)
      AND (${query.model === undefined} OR model=${model})
      AND (${query.provider === undefined} OR provider=${provider})
      AND (${query.status === undefined} OR status=${status})`;
      const bucket = query.bucket === "hour" ? "hour" : "day";
      const points = await tx<Row[]>`SELECT date_trunc(${bucket},created_at) bucket,
      count(*)::int calls,count(*) FILTER(WHERE status='completed')::int completed,
      count(*) FILTER(WHERE status='failed')::int failed,
      COALESCE(sum(cost_micros),0)::bigint customer_cost_micros,
      COALESCE(sum(input_tokens),0)::bigint input_tokens,
      COALESCE(sum(output_tokens),0)::bigint output_tokens,
      avg(latency_ms)::float8 avg_latency_ms,avg(ttft_ms)::float8 avg_ttft_ms
      FROM usage_runs WHERE created_at>=${fromIso} AND created_at<${toIso}
      AND (${query.userId === undefined} OR user_id=${userId}::uuid)
      AND (${query.model === undefined} OR model=${model})
      AND (${query.provider === undefined} OR provider=${provider})
      AND (${query.status === undefined} OR status=${status})
      GROUP BY bucket ORDER BY bucket`;
      const distribution = async (dimension: "model" | "provider" | "status") => {
        const select = tx(dimension);
        const rows = await tx<Row[]>`SELECT ${select} key,count(*)::int calls,
        COALESCE(sum(cost_micros),0)::bigint customer_cost_micros
        FROM usage_runs WHERE created_at>=${fromIso} AND created_at<${toIso}
        AND (${query.userId === undefined} OR user_id=${userId}::uuid)
        AND (${query.model === undefined} OR model=${model})
        AND (${query.provider === undefined} OR provider=${provider})
        AND (${query.status === undefined} OR status=${status})
        GROUP BY ${select} ORDER BY calls DESC,customer_cost_micros DESC,key LIMIT 20`;
        return rows.map((row): AdminAnalyticsDistribution => ({
          key: String(row.key),
          calls: number(row.calls),
          customerCostMicros: number(row.customer_cost_micros),
        }));
      };
      const summary = summaryRows[0];
      const completed = number(summary.completed);
      const failed = number(summary.failed);
      return {
        query: { ...query, from: fromIso, to: toIso },
        summary: {
          calls: number(summary.calls),
          completed,
          failed,
          successRate: completed + failed ? completed / (completed + failed) : 0,
          inputTokens: number(summary.input_tokens),
          cachedInputTokens: number(summary.cached_input_tokens),
          reasoningTokens: number(summary.reasoning_tokens),
          outputTokens: number(summary.output_tokens),
          customerCostMicros: number(summary.customer_cost_micros),
          providerCostMicros: number(summary.provider_cost_micros),
          avgLatencyMs: summary.avg_latency_ms == null ? null : number(summary.avg_latency_ms),
          p95LatencyMs: summary.p95_latency_ms == null ? null : number(summary.p95_latency_ms),
          avgTtftMs: summary.avg_ttft_ms == null ? null : number(summary.avg_ttft_ms),
        },
        points: points.map((row) => ({
          start: iso(row.bucket),
          calls: number(row.calls),
          completed: number(row.completed),
          failed: number(row.failed),
          customerCostMicros: number(row.customer_cost_micros),
          inputTokens: number(row.input_tokens),
          outputTokens: number(row.output_tokens),
          avgLatencyMs: row.avg_latency_ms == null ? null : number(row.avg_latency_ms),
          avgTtftMs: row.avg_ttft_ms == null ? null : number(row.avg_ttft_ms),
        })),
        models: await distribution("model"),
        providers: await distribution("provider"),
        statuses: await distribution("status"),
      };
    });
  }
  async listJobs(query: AdminJobQuery = {}): Promise<AdminJobPage> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("validation_error", "Job page limit must be between 1 and 100", 422);
    }
    if (
      (query.status && !["queued", "running", "completed", "failed"].includes(query.status)) ||
      (query.type !== undefined && (query.type.length < 1 || query.type.length > 200))
    ) {
      throw new DomainError("validation_error", "Invalid job filter", 422);
    }
    let cursor: { createdAtMicros: string; id: string } | undefined;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(atob(query.cursor));
        if (
          typeof decoded.createdAtMicros !== "string" ||
          !/^\d{1,20}$/u.test(decoded.createdAtMicros) ||
          BigInt(decoded.createdAtMicros) > 253_402_300_799_999_999n ||
          typeof decoded.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            decoded.id,
          )
        ) {
          throw new Error();
        }
        cursor = decoded;
      } catch {
        throw new DomainError("validation_error", "Invalid job cursor", 422);
      }
    }
    const status = query.status ?? "";
    const type = query.type ?? "";
    const previousRows = cursor
      ? await this.#sql<Row[]>`SELECT id,created_at,
        floor(extract(epoch FROM created_at)*1000000)::bigint created_at_micros FROM jobs
        WHERE (${query.status === undefined} OR status=${status})
        AND (${query.type === undefined} OR type=${type})
        AND (created_at>to_timestamp(${cursor.createdAtMicros}::numeric/1000000) OR
          (created_at=to_timestamp(${cursor.createdAtMicros}::numeric/1000000)
            AND id>${cursor.id}::uuid))
        ORDER BY created_at ASC,id ASC LIMIT ${limit}`
      : [];
    const rows = cursor
      ? await this.#sql<Row[]>`SELECT id,type,status,attempts,available_at,locked_at,
        last_error,created_at,completed_at,
        floor(extract(epoch FROM created_at)*1000000)::bigint created_at_micros FROM jobs
        WHERE (${query.status === undefined} OR status=${status})
        AND (${query.type === undefined} OR type=${type})
        AND (created_at<to_timestamp(${cursor.createdAtMicros}::numeric/1000000) OR
          (created_at=to_timestamp(${cursor.createdAtMicros}::numeric/1000000)
            AND id<${cursor.id}::uuid))
        ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`
      : await this.#sql<Row[]>`SELECT id,type,status,attempts,available_at,locked_at,
        last_error,created_at,completed_at,
        floor(extract(epoch FROM created_at)*1000000)::bigint created_at_micros FROM jobs
        WHERE (${query.status === undefined} OR status=${status})
        AND (${query.type === undefined} OR type=${type})
        ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const previousBoundary = previousRows.length === limit ? previousRows.at(-1) : undefined;
    return {
      items: page.map(adminJob),
      nextCursor: rows.length > limit && last
        ? btoa(JSON.stringify({
          createdAtMicros: String(last.created_at_micros),
          id: String(last.id),
        }))
        : null,
      hasPrevious: Boolean(cursor),
      previousCursor: previousBoundary
        ? btoa(JSON.stringify({
          createdAtMicros: String(previousBoundary.created_at_micros),
          id: String(previousBoundary.id),
        }))
        : null,
    };
  }
  async retryFailedJob(id: string, actorId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new DomainError("validation_error", "Invalid job id", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT id,type,payload,status,attempts,available_at,locked_at,last_error,
        created_at,completed_at FROM jobs WHERE id=${id}::uuid FOR UPDATE`;
      if (!rows.length) throw new DomainError("not_found", "Job not found", 404);
      if (rows[0].status !== "failed") {
        throw new DomainError("conflict", "Only failed jobs can be retried", 409);
      }
      const priorAttempts = number(rows[0].attempts);
      if (rows[0].type === "retention.scrub") {
        const payload = rows[0].payload as { runId?: unknown } | null;
        if (
          !payload || typeof payload.runId !== "string" ||
          !UUID_PATTERN.test(payload.runId)
        ) {
          throw new DomainError("conflict", "Retention scrub job payload is invalid", 409);
        }
        const reset = await tx<Row[]>`UPDATE retention_scrub_runs SET status='queued',error=NULL,
          completed_at=NULL WHERE id=${payload.runId}::uuid AND status='failed' RETURNING id`;
        if (!reset.length) {
          throw new DomainError("conflict", "Retention scrub run is not safely retryable", 409);
        }
      }
      const updated = await tx<Row[]>`UPDATE jobs SET status='queued',attempts=0,available_at=now(),
        locked_at=NULL,locked_by=NULL,last_error=NULL,completed_at=NULL WHERE id=${id}::uuid
        RETURNING id,type,status,attempts,available_at,locked_at,last_error,created_at,completed_at`;
      const auditMetadata = tx.json({
        type: String(rows[0].type),
        priorAttempts,
      } as postgres.JSONValue);
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${actorId}::uuid,'job.retried','job',${id},${auditMetadata})`;
      return { job: adminJob(updated[0]), priorAttempts };
    });
  }
  async listWorkerInstances(query: AdminWorkerQuery = {}): Promise<AdminWorkerPage> {
    const limit = query.limit ?? 50;
    const scope = query.scope ?? "active";
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("validation_error", "Worker page limit must be between 1 and 100", 422);
    }
    if (!["active", "history", "all"].includes(scope)) {
      throw new DomainError("validation_error", "Worker scope is invalid", 422);
    }
    let cursor: { startedAtMicros: string; id: string; scope: string } | undefined;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(atob(query.cursor));
        if (
          !decoded || typeof decoded.startedAtMicros !== "string" ||
          !/^\d{1,20}$/u.test(decoded.startedAtMicros) ||
          BigInt(decoded.startedAtMicros) > 253_402_300_799_999_999n ||
          typeof decoded.id !== "string" || !UUID_PATTERN.test(decoded.id) ||
          decoded.scope !== scope
        ) throw new Error();
        cursor = decoded;
      } catch {
        throw new DomainError("validation_error", "Worker cursor is invalid", 422);
      }
    }
    const rows = await this.#sql<Row[]>`SELECT instance_id,worker_name,state,started_at,
      heartbeat_at,progress_at,current_job_id,current_job_type,last_completed_at,
      last_completed_job_id,last_completed_job_type,heartbeat_stale_ms,progress_stale_ms,
      health_clock_tolerance_ms,
      greatest(0,floor(extract(epoch FROM (clock_timestamp()-heartbeat_at))*1000))::bigint
        heartbeat_age_ms,
      greatest(0,floor(extract(epoch FROM (clock_timestamp()-progress_at))*1000))::bigint
        progress_age_ms,
      CASE
        WHEN state='stopped' THEN 'inactive'
        WHEN heartbeat_at NOT BETWEEN
          clock_timestamp()-heartbeat_stale_ms*interval '1 millisecond'
          AND clock_timestamp()+health_clock_tolerance_ms*interval '1 millisecond'
          THEN 'heartbeat_stale'
        WHEN progress_at NOT BETWEEN
          clock_timestamp()-progress_stale_ms*interval '1 millisecond'
          AND clock_timestamp()+health_clock_tolerance_ms*interval '1 millisecond'
          THEN 'progress_stalled'
        ELSE 'fresh'
      END liveness,
      floor(extract(epoch FROM started_at)*1000000)::bigint started_at_micros
      FROM worker_instances
      WHERE (${scope === "all"} OR (${scope === "active"} AND state<>'stopped') OR
        (${scope === "history"} AND state='stopped'))
      AND (${cursor === undefined} OR started_at<to_timestamp(${
      cursor?.startedAtMicros ?? "0"
    }::numeric/1000000) OR
        (started_at=to_timestamp(${cursor?.startedAtMicros ?? "0"}::numeric/1000000)
          AND instance_id<${cursor?.id ?? "00000000-0000-4000-8000-000000000000"}::uuid))
      ORDER BY started_at DESC,instance_id DESC LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const items = page.map((row) => ({
      instanceId: String(row.instance_id),
      workerName: String(row.worker_name),
      state: row.state as AdminWorkerInstance["state"],
      startedAt: iso(row.started_at),
      heartbeatAt: iso(row.heartbeat_at),
      progressAt: iso(row.progress_at),
      heartbeatAgeMs: number(row.heartbeat_age_ms),
      progressAgeMs: number(row.progress_age_ms),
      heartbeatStaleMs: number(row.heartbeat_stale_ms),
      progressStaleMs: number(row.progress_stale_ms),
      healthClockToleranceMs: number(row.health_clock_tolerance_ms),
      liveness: String(row.liveness) as AdminWorkerInstance["liveness"],
      currentJobId: row.current_job_id ? String(row.current_job_id) : null,
      currentJobType: row.current_job_type ? String(row.current_job_type) : null,
      lastCompletedAt: row.last_completed_at ? iso(row.last_completed_at) : null,
      lastCompletedJobId: row.last_completed_job_id ? String(row.last_completed_job_id) : null,
      lastCompletedJobType: row.last_completed_job_type
        ? String(row.last_completed_job_type)
        : null,
    }));
    return {
      items,
      scope,
      limit,
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit && last
        ? btoa(JSON.stringify({
          startedAtMicros: String(last.started_at_micros),
          id: String(last.instance_id),
          scope,
        }))
        : null,
    };
  }
  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const rows = await this.#sql<Row[]>`SELECT v.* FROM retention_policy_state s
      JOIN retention_policy_versions v ON v.version=s.current_version WHERE s.singleton_id=1`;
    if (!rows.length) {
      throw new DomainError("not_found", "Retention policy is not initialized", 500);
    }
    return retentionPolicy(rows[0]);
  }
  async updateRetentionPolicy(input: UpdateRetentionPolicyInput, actorId: string) {
    if (
      ![1, 7, 14, 30, 90].includes(input.requestBodyDays) ||
      ![1, 7, 14, 30, 90].includes(input.responseBodyDays)
    ) {
      throw new DomainError("validation_error", "Retention days are invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const state = await tx<Row[]>`SELECT current_version FROM retention_policy_state
        WHERE singleton_id=1 FOR UPDATE`;
      if (!state.length) {
        throw new DomainError("not_found", "Retention policy is not initialized", 500);
      }
      if (number(state[0].current_version) !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Retention policy changed", 409);
      }
      const version = input.expectedVersion + 1;
      const rows = await tx<Row[]>`INSERT INTO retention_policy_versions(version,capture_enabled,
        request_body_days,response_body_days,updated_by) VALUES(${version},${input.captureEnabled},
        ${input.requestBodyDays},${input.responseBodyDays},${actorId}::uuid) RETURNING *`;
      await tx`UPDATE retention_policy_state SET current_version=${version} WHERE singleton_id=1`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${actorId}::uuid,'retention.policy.updated','retention_policy',${String(version)},
        ${
        tx.json(
          {
            captureEnabled: input.captureEnabled,
            requestBodyDays: input.requestBodyDays,
            responseBodyDays: input.responseBodyDays,
          } as postgres.JSONValue,
        )
      })`;
      return retentionPolicy(rows[0]);
    });
  }
  async captureProviderPayload(input: ProviderPayloadCaptureInput) {
    return await this.#sql.begin(async (tx) => {
      const policy = await tx<Row[]>`SELECT v.capture_enabled FROM retention_policy_state s
        JOIN retention_policy_versions v ON v.version=s.current_version WHERE s.singleton_id=1
        FOR SHARE OF s`;
      if (!policy[0]?.capture_enabled) return null;
      if (
        !UUID_PATTERN.test(input.providerAttemptId) || !input.usageRunId ||
        input.usageRunId.length > 200
      ) {
        throw new DomainError("validation_error", "Provider payload linkage is invalid", 422);
      }
      const requestBody = input.requestBody ?? null;
      const responseBody = input.responseBody ?? null;
      if (requestBody === null && responseBody === null) {
        throw new DomainError("validation_error", "A provider payload body is required", 422);
      }
      const requestBytes = requestBody === null
        ? 0
        : new TextEncoder().encode(requestBody).byteLength;
      const responseBytes = responseBody === null
        ? 0
        : new TextEncoder().encode(responseBody).byteLength;
      if (requestBytes > 1_048_576 || responseBytes > 1_048_576) {
        throw new DomainError("validation_error", "Provider payload exceeds one MiB", 422);
      }
      const rows = await tx<Row[]>`INSERT INTO provider_payload_captures(usage_run_id,
        provider_attempt_id,request_body,response_body,request_bytes,response_bytes)
        SELECT ${input.usageRunId},${input.providerAttemptId}::uuid,${requestBody},${responseBody},
          ${requestBytes},${responseBytes} FROM provider_attempts a
        WHERE a.id=${input.providerAttemptId}::uuid AND a.usage_run_id=${input.usageRunId}
        ON CONFLICT(provider_attempt_id) DO NOTHING RETURNING *`;
      if (rows[0]) return payloadCapture(rows[0]);
      const prior = await tx<Row[]>`SELECT * FROM provider_payload_captures
        WHERE provider_attempt_id=${input.providerAttemptId}::uuid`;
      if (!prior.length) throw new DomainError("not_found", "Provider attempt not found", 404);
      if (prior[0].request_body !== requestBody || prior[0].response_body !== responseBody) {
        throw new DomainError("idempotency_conflict", "Provider payload capture differs", 409);
      }
      return payloadCapture(prior[0]);
    });
  }
  async previewRetentionScrub(): Promise<RetentionPreview> {
    const rows = await this.#sql<Row[]>`SELECT v.version policy_version,
      now()-v.request_body_days*interval '1 day' request_cutoff_at,
      now()-v.response_body_days*interval '1 day' response_cutoff_at,
      count(*) FILTER(WHERE (p.request_body IS NOT NULL AND p.captured_at<=now()-v.request_body_days*interval '1 day')
        OR (p.response_body IS NOT NULL AND p.captured_at<=now()-v.response_body_days*interval '1 day'))::int captures,
      count(*) FILTER(WHERE p.request_body IS NOT NULL AND p.captured_at<=now()-v.request_body_days*interval '1 day')::int request_bodies,
      count(*) FILTER(WHERE p.response_body IS NOT NULL AND p.captured_at<=now()-v.response_body_days*interval '1 day')::int response_bodies,
      COALESCE(sum(p.request_bytes) FILTER(WHERE p.request_body IS NOT NULL AND p.captured_at<=now()-v.request_body_days*interval '1 day'),0)::bigint request_bytes,
      COALESCE(sum(p.response_bytes) FILTER(WHERE p.response_body IS NOT NULL AND p.captured_at<=now()-v.response_body_days*interval '1 day'),0)::bigint response_bytes
      FROM retention_policy_state s JOIN retention_policy_versions v ON v.version=s.current_version
      LEFT JOIN provider_payload_captures p ON true WHERE s.singleton_id=1 GROUP BY v.version`;
    const row = rows[0];
    return {
      policyVersion: number(row.policy_version),
      requestCutoffAt: iso(row.request_cutoff_at),
      responseCutoffAt: iso(row.response_cutoff_at),
      captures: number(row.captures),
      requestBodies: number(row.request_bodies),
      responseBodies: number(row.response_bodies),
      requestBytes: number(row.request_bytes),
      responseBytes: number(row.response_bytes),
    };
  }
  async enqueueRetentionScrub(input: EnqueueRetentionScrubInput, actorId: string | null) {
    if (
      !input.idempotencyKey || input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 200 ||
      !Number.isFinite(Date.parse(input.requestCutoffAt)) ||
      !Number.isFinite(Date.parse(input.responseCutoffAt))
    ) {
      throw new DomainError("validation_error", "Retention idempotency key is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const prior = await tx<Row[]>`SELECT r.*,v.updated_at policy_updated_at,
        v.updated_by policy_updated_by FROM retention_scrub_runs r
        JOIN retention_policy_versions v ON v.version=r.policy_version
        WHERE r.idempotency_key=${input.idempotencyKey}`;
      if (prior[0]) {
        if (
          number(prior[0].policy_version) !== input.expectedPolicyVersion ||
          iso(prior[0].request_cutoff_at) !== new Date(input.requestCutoffAt).toISOString() ||
          iso(prior[0].response_cutoff_at) !== new Date(input.responseCutoffAt).toISOString()
        ) {
          throw new DomainError("idempotency_conflict", "Retention scrub request differs", 409);
        }
        return retentionRun(prior[0]);
      }
      const current = await tx<Row[]>`SELECT v.* FROM retention_policy_state s
        JOIN retention_policy_versions v ON v.version=s.current_version
        WHERE s.singleton_id=1 FOR UPDATE OF s`;
      if (!current[0] || number(current[0].version) !== input.expectedPolicyVersion) {
        throw new DomainError("version_conflict", "Retention preview is stale", 409);
      }
      if (
        Date.parse(input.requestCutoffAt) >
          Date.now() - number(current[0].request_body_days) * 86_400_000 ||
        Date.parse(input.responseCutoffAt) >
          Date.now() - number(current[0].response_body_days) * 86_400_000
      ) {
        throw new DomainError("validation_error", "Retention preview cutoffs are invalid", 422);
      }
      const concurrent = await tx<Row[]>`SELECT r.*,v.updated_at policy_updated_at,
        v.updated_by policy_updated_by FROM retention_scrub_runs r
        JOIN retention_policy_versions v ON v.version=r.policy_version
        WHERE r.idempotency_key=${input.idempotencyKey}`;
      if (concurrent[0]) {
        if (
          number(concurrent[0].policy_version) !== input.expectedPolicyVersion ||
          iso(concurrent[0].request_cutoff_at) !== new Date(input.requestCutoffAt).toISOString() ||
          iso(concurrent[0].response_cutoff_at) !== new Date(input.responseCutoffAt).toISOString()
        ) {
          throw new DomainError("idempotency_conflict", "Retention scrub request differs", 409);
        }
        return retentionRun(concurrent[0]);
      }
      const rows = await tx<Row[]>`INSERT INTO retention_scrub_runs(idempotency_key,status,
        policy_version,capture_enabled,request_body_days,response_body_days,request_cutoff_at,
        response_cutoff_at,requested_by)
        VALUES(${input.idempotencyKey},'queued',${input.expectedPolicyVersion},
          ${Boolean(current[0].capture_enabled)},${number(current[0].request_body_days)},
          ${number(current[0].response_body_days)},
          ${new Date(input.requestCutoffAt).toISOString()},
          ${new Date(input.responseCutoffAt).toISOString()},${actorId}::uuid) RETURNING *`;
      await tx`INSERT INTO jobs(type,payload,idempotency_key) VALUES('retention.scrub',
        ${tx.json({ runId: String(rows[0].id) })},${`retention.scrub:${String(rows[0].id)}`})`;
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${actorId}::uuid,'retention.scrub.enqueued','retention_scrub_run',${
        String(rows[0].id)
      },
          ${tx.json({ policyVersion: input.expectedPolicyVersion } as postgres.JSONValue)})`;
      return retentionRun({
        ...rows[0],
        policy_updated_at: current[0].updated_at,
        policy_updated_by: current[0].updated_by,
      });
    });
  }
  async scheduleRetentionScrub(
    input: ScheduleRetentionScrubInput,
  ): Promise<RetentionScheduleResult> {
    if (
      !Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 300 ||
      input.intervalSeconds > 2_592_000
    ) {
      throw new DomainError(
        "validation_error",
        "Retention schedule interval must be between 300 and 2592000 seconds",
        422,
      );
    }
    const now = new Date(input.now ?? new Date().toISOString());
    if (!Number.isFinite(now.getTime())) {
      throw new DomainError("validation_error", "Retention schedule time is invalid", 422);
    }
    const nowIso = now.toISOString();
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT s.*,v.version current_policy_version,
        v.capture_enabled,v.request_body_days,
        v.response_body_days,v.updated_at policy_updated_at,v.updated_by policy_updated_by
        FROM retention_schedule_state s
        JOIN retention_policy_state ps ON ps.singleton_id=1
        JOIN retention_policy_versions v ON v.version=ps.current_version
        WHERE s.singleton_id=1 FOR UPDATE OF s`;
      const state = rows[0];
      if (!state) {
        throw new DomainError("not_found", "Retention schedule is not initialized", 500);
      }
      let dueAt = new Date(String(state.next_due_at));
      if (number(state.interval_seconds) !== input.intervalSeconds) {
        const cadenceAnchor = state.last_scheduled_at === null
          ? now.getTime()
          : new Date(String(state.last_scheduled_at)).getTime();
        dueAt = new Date(cadenceAnchor + input.intervalSeconds * 1_000);
      }
      const policyVersion = number(state.current_policy_version);
      const lastPolicyVersion = state.last_policy_version === null
        ? null
        : number(state.last_policy_version);
      const intervalDue = dueAt.getTime() <= now.getTime();
      const policyChanged = lastPolicyVersion !== policyVersion;
      const overdueSeconds = intervalDue
        ? Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / 1_000))
        : 0;
      if (!intervalDue && !policyChanged) {
        const unchanged = await tx<Row[]>`UPDATE retention_schedule_state
          SET interval_seconds=${input.intervalSeconds},next_due_at=${dueAt.toISOString()},
          updated_at=${nowIso}
          WHERE singleton_id=1 RETURNING next_due_at`;
        return {
          scheduled: false,
          reason: null,
          run: null,
          intervalSeconds: input.intervalSeconds,
          nextDueAt: iso(unchanged[0].next_due_at),
          overdueSeconds,
        };
      }
      const reason = policyChanged ? "policy_changed" : "interval_due";
      // The locked singleton state is the exactly-once fence. A unique key cannot collide with
      // administrator-chosen idempotency keys created before automatic scheduling existed.
      const idempotencyKey = `retention.auto:${crypto.randomUUID()}`;
      const requestCutoffAt = new Date(
        now.getTime() - number(state.request_body_days) * 86_400_000,
      ).toISOString();
      const responseCutoffAt = new Date(
        now.getTime() - number(state.response_body_days) * 86_400_000,
      ).toISOString();
      const inserted = await tx<Row[]>`INSERT INTO retention_scrub_runs(idempotency_key,status,
        policy_version,capture_enabled,request_body_days,response_body_days,request_cutoff_at,
        response_cutoff_at,requested_by)
        VALUES(${idempotencyKey},'queued',${policyVersion},${Boolean(state.capture_enabled)},
          ${number(state.request_body_days)},${number(state.response_body_days)},${requestCutoffAt},
          ${responseCutoffAt},NULL) RETURNING *`;
      const runId = String(inserted[0].id);
      await tx`INSERT INTO jobs(type,payload,idempotency_key) VALUES('retention.scrub',
        ${tx.json({ runId })},${`retention.scrub:${runId}`})`;
      const intervalMs = input.intervalSeconds * 1_000;
      const nextDueMs = intervalDue
        ? dueAt.getTime() +
          (Math.floor((now.getTime() - dueAt.getTime()) / intervalMs) + 1) * intervalMs
        : now.getTime() + intervalMs;
      const nextDueAt = new Date(nextDueMs).toISOString();
      await tx`UPDATE retention_schedule_state SET interval_seconds=${input.intervalSeconds},
        next_due_at=${nextDueAt},last_policy_version=${policyVersion},last_scheduled_at=${nowIso},
        last_run_id=${runId}::uuid,updated_at=${nowIso} WHERE singleton_id=1`;
      await tx`INSERT INTO audit_events(action,target_type,target_id,metadata)
        VALUES('retention.scrub.enqueued','retention_scrub_run',${runId},${
        tx.json({ policyVersion, source: "automatic" } as postgres.JSONValue)
      }),('retention.schedule.enqueued','retention_scrub_run',${runId},${
        tx.json(
          {
            reason,
            policyVersion,
            intervalSeconds: input.intervalSeconds,
            overdueSeconds,
            nextDueAt,
          } as postgres.JSONValue,
        )
      })`;
      return {
        scheduled: true,
        reason,
        run: retentionRun({
          ...inserted[0],
          policy_updated_at: state.policy_updated_at,
          policy_updated_by: state.policy_updated_by,
        }),
        intervalSeconds: input.intervalSeconds,
        nextDueAt,
        overdueSeconds,
      };
    });
  }
  async getRetentionScrubRun(id: string) {
    if (!UUID_PATTERN.test(id)) {
      throw new DomainError("validation_error", "Retention scrub run id is invalid", 422);
    }
    const rows = await this.#sql<Row[]>`SELECT r.*,v.updated_at policy_updated_at,
      v.updated_by policy_updated_by FROM retention_scrub_runs r
      JOIN retention_policy_versions v ON v.version=r.policy_version WHERE r.id=${id}::uuid`;
    if (!rows.length) throw new DomainError("not_found", "Retention scrub run not found", 404);
    return retentionRun(rows[0]);
  }
  async listRetentionScrubRuns(query: RetentionScrubQuery = {}): Promise<RetentionScrubPage> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("validation_error", "Retention page limit is invalid", 422);
    }
    if (query.status && !["queued", "running", "completed", "failed"].includes(query.status)) {
      throw new DomainError("validation_error", "Retention scrub status is invalid", 422);
    }
    const status = query.status ?? "";
    const rows = await this.#sql<Row[]>`SELECT r.*,v.updated_at policy_updated_at,
      v.updated_by policy_updated_by FROM retention_scrub_runs r
      JOIN retention_policy_versions v ON v.version=r.policy_version
      WHERE (${query.status === undefined} OR r.status=${status})
      ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit}`;
    return { items: rows.map(retentionRun) };
  }
  async scrubRetentionBatch(runId: string, limit = 100): Promise<RetentionScrubBatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new DomainError("validation_error", "Retention batch limit is invalid", 422);
    }
    if (!UUID_PATTERN.test(runId)) {
      throw new DomainError("validation_error", "Retention scrub run id is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const runs = await tx<Row[]>`SELECT r.*,v.updated_at policy_updated_at,
        v.updated_by policy_updated_by FROM retention_scrub_runs r
        JOIN retention_policy_versions v ON v.version=r.policy_version
        WHERE r.id=${runId}::uuid FOR UPDATE OF r`;
      if (!runs.length) throw new DomainError("not_found", "Retention scrub run not found", 404);
      if (runs[0].status === "failed") {
        throw new DomainError("conflict", "Retention scrub run failed", 409);
      }
      if (runs[0].status === "completed") {
        return { run: retentionRun(runs[0]), processed: 0, completed: true };
      }
      const requestCutoff = iso(runs[0].request_cutoff_at);
      const responseCutoff = iso(runs[0].response_cutoff_at);
      const scrubbed = await tx<Row[]>`WITH candidates AS (
        SELECT id,request_bytes,response_bytes,
          (request_body IS NOT NULL AND captured_at<=${requestCutoff}) request_eligible,
          (response_body IS NOT NULL AND captured_at<=${responseCutoff}) response_eligible
        FROM provider_payload_captures WHERE
          (request_body IS NOT NULL AND captured_at<=${requestCutoff}) OR
          (response_body IS NOT NULL AND captured_at<=${responseCutoff})
        ORDER BY captured_at,id FOR UPDATE SKIP LOCKED LIMIT ${limit}
      ) UPDATE provider_payload_captures p SET
        request_body=CASE WHEN c.request_eligible THEN NULL ELSE p.request_body END,
        response_body=CASE WHEN c.response_eligible THEN NULL ELSE p.response_body END,
        scrubbed_at=CASE WHEN (c.request_eligible OR p.request_body IS NULL) AND
          (c.response_eligible OR p.response_body IS NULL) THEN now() ELSE p.scrubbed_at END
        FROM candidates c WHERE p.id=c.id RETURNING c.request_eligible,c.response_eligible,
          c.request_bytes,c.response_bytes,(p.request_body IS NULL AND p.response_body IS NULL) fully_scrubbed`;
      const requests = scrubbed.filter((row) => row.request_eligible).length;
      const responses = scrubbed.filter((row) => row.response_eligible).length;
      const captures = scrubbed.filter((row) => row.fully_scrubbed).length;
      const bytes = scrubbed.reduce((sum, row) =>
        sum +
        (row.request_eligible ? number(row.request_bytes) : 0) +
        (row.response_eligible ? number(row.response_bytes) : 0), 0);
      const remaining = await tx<Row[]>`SELECT EXISTS(SELECT 1 FROM provider_payload_captures WHERE
        (request_body IS NOT NULL AND captured_at<=${requestCutoff}) OR
        (response_body IS NOT NULL AND captured_at<=${responseCutoff})) remaining`;
      const completed = !remaining[0].remaining;
      const updated = await tx<Row[]>`UPDATE retention_scrub_runs SET status=${
        completed ? "completed" : "running"
      },
        started_at=COALESCE(started_at,now()),completed_at=CASE WHEN ${completed} THEN now() ELSE NULL END,
        captures_scrubbed=captures_scrubbed+${captures},
        request_bodies_scrubbed=request_bodies_scrubbed+${requests},
        response_bodies_scrubbed=response_bodies_scrubbed+${responses},bytes_scrubbed=bytes_scrubbed+${bytes}
        WHERE id=${runId}::uuid RETURNING *`;
      if (completed) {
        await tx`INSERT INTO audit_events(action,target_type,target_id,metadata)
          VALUES('retention.scrub.completed','retention_scrub_run',${runId},
          ${
          tx.json(
            {
              capturesScrubbed: number(updated[0].captures_scrubbed),
              bytesScrubbed: number(updated[0].bytes_scrubbed),
            } as postgres.JSONValue,
          )
        })`;
      }
      return {
        run: retentionRun({
          ...updated[0],
          policy_updated_at: runs[0].policy_updated_at,
          policy_updated_by: runs[0].policy_updated_by,
        }),
        processed: scrubbed.length,
        completed,
      };
    });
  }
  async failRetentionScrubRun(runId: string, code: RetentionScrubFailureCode) {
    if (
      !UUID_PATTERN.test(runId) ||
      !["worker_retry_exhausted", "invalid_job_payload", "manual_recovery"].includes(code)
    ) {
      throw new DomainError("validation_error", "Retention scrub failure is invalid", 422);
    }
    const error = code === "worker_retry_exhausted"
      ? "Retention scrub exhausted its retry budget"
      : code === "invalid_job_payload"
      ? "Retention scrub job payload is invalid"
      : "Retention scrub requires manual recovery";
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`UPDATE retention_scrub_runs SET status='failed',
        error=${error.slice(0, 1000)},completed_at=now() WHERE id=${runId}::uuid
        AND status IN ('queued','running') RETURNING *`;
      if (!rows.length) {
        const prior = await tx<Row[]>`SELECT r.*,v.updated_at policy_updated_at,
          v.updated_by policy_updated_by FROM retention_scrub_runs r
          JOIN retention_policy_versions v ON v.version=r.policy_version
          WHERE r.id=${runId}::uuid`;
        if (!prior.length) throw new DomainError("not_found", "Retention scrub run not found", 404);
        if (prior[0].status === "completed") {
          throw new DomainError("conflict", "Completed retention scrub run cannot fail", 409);
        }
        return retentionRun(prior[0]);
      }
      const policyVersion = number(rows[0].policy_version);
      await tx`INSERT INTO audit_events(action,target_type,target_id,metadata)
        VALUES('retention.scrub.failed','retention_scrub_run',${runId},
        ${tx.json({ code } as postgres.JSONValue)})`;
      const policy = await tx<Row[]>`SELECT updated_at policy_updated_at,
        updated_by policy_updated_by FROM retention_policy_versions WHERE version=${policyVersion}`;
      return retentionRun({ ...rows[0], ...policy[0] });
    });
  }
  async readiness(signal?: AbortSignal) {
    const query = this.#sql`SELECT 1`;
    const abort = () => {
      try {
        query.cancel();
      } catch {
        // Cancellation is best effort; the readiness boundary has its own hard deadline.
      }
    };
    try {
      if (signal?.aborted) return { ready: false, storage: this.storageKind };
      signal?.addEventListener("abort", abort, { once: true });
      await query;
      return { ready: true, storage: this.storageKind };
    } catch {
      return { ready: false, storage: this.storageKind };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
