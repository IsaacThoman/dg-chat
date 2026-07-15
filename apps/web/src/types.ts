import type {
  ConversationFolder,
  ConversationFolderMembership,
  ConversationShareAttachmentPolicy,
  ConversationShareIdentityVisibility,
  ConversationShareSummary,
  ConversationTag,
  ConversationTagBinding,
  ConversationTagSet,
  ModelCapability,
  PublicConversationShare,
  PublicConversationShareAttachment,
  PublicConversationShareMessage,
  UserPreferences,
} from "../../../packages/contracts/src/types.ts";
export type {
  ConversationFolder,
  ConversationFolderMembership,
  ConversationTag,
  ConversationTagBinding,
  ConversationTagSet,
  UserPreferences,
};
export type { ConversationShareSummary, PublicConversationShare };

export type Role = "user" | "admin";
export type UserStatus = "pending" | "approved" | "suspended" | "rejected" | "deleted";
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  approvalStatus: "pending" | "approved" | "rejected";
  state: "active" | "suspended";
  deletedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  effectiveAdmin?: boolean;
  status: UserStatus;
  balance: number;
  limited: boolean;
  emailVerifiedAt: string | null;
  avatar?: string;
}

export interface UserSession {
  id: string;
  userId: string;
  source?: "better_auth" | "legacy";
  limited: boolean;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  invalidatedAt: string | null;
}
export interface Conversation {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  temporary?: boolean;
  temporaryExpiresAt?: string | null;
  project?: string;
  activeLeafId?: string | null;
  version?: number;
}
export type ShareIdentityVisibility = ConversationShareIdentityVisibility;
export type ShareAttachmentPolicy = ConversationShareAttachmentPolicy;
export type PublicShareAttachment = PublicConversationShareAttachment;
export type PublicShareMessage = PublicConversationShareMessage;
export interface ConversationShareCreated {
  share: ConversationShareSummary;
  capability: string;
  path: string;
  replayed: boolean;
}
export interface Branch {
  index: number;
  total: number;
  labels: string[];
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  createdAtIso?: string;
  model?: string;
  latency?: string;
  reasoning?: string;
  toolStatus?: string;
  toolExecutionIds?: string[];
  knowledgeSources?: Array<{ label: string; collectionName: string; filename: string }>;
  status?: "complete" | "stopped" | "error";
  branch?: Branch;
  attachments?: Attachment[];
  parentId?: string | null;
  supersedesId?: string | null;
  siblingIndex?: number;
}
export interface Model {
  id: string;
  name: string;
  provider: string;
  context: string;
  capabilities: ModelCapability[];
  healthy: boolean;
}
export type ProviderProtocol = "chat_completions" | "responses";
export type ProviderHealthStatus = "unknown" | "healthy" | "unhealthy" | "disabled";
export interface AdminProvider {
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
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface DiscoveredProviderModel {
  id: string;
  ownedBy: string | null;
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
export interface AdminModel {
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
  prices: ModelPriceVersion[];
  createdAt: string;
  updatedAt: string;
}
export interface Token {
  id: string;
  name: string;
  preview: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  version: number;
  rpmLimit: number | null;
  burstLimit: number | null;
  accessMode: "inherit" | "restricted";
  rotatedFromTokenId: string | null;
  replacedByTokenId: string | null;
  overlapEndsAt: string | null;
  rotationFamilyId: string;
  rotationGeneration: number;
}

export interface TokenSecret extends Token {
  token: string;
}

export interface TokenRotation {
  token: string;
  previous: Token;
  replacement: Token;
}

export interface ModelAccessGroup {
  id: string;
  name: string;
  description: string;
  version: number;
  userIds: string[];
  tokenIds: string[];
  tokenOwners: Array<{ tokenId: string; ownerId: string }>;
  modelIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AccessGroupPolicyImpact {
  modelIdsBecomingPublic: string[];
  tokenIdsLosingGroupAccess: string[];
  tokenIdsRevertingToOwnerInheritance: string[];
}

export interface AdminTokenAccessItem {
  id: string;
  name: string;
  preview: string;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  version: number;
  groupIds: string[];
  accessMode: "inherit" | "restricted";
  revokedAt: string | null;
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

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  state: string;
  ingestionStatus?: "not_applicable" | "queued" | "processing" | "ready" | "failed";
  ingestionError?: string | null;
  ingestedAt?: string | null;
  createdAt: string;
}

export interface KnowledgeCollection {
  id: string;
  name: string;
  description?: string | null;
  attachmentCount?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeMode = "retrieval" | "full_context";

export interface ConversationKnowledge {
  bindings: Array<{
    collectionId: string;
    mode: KnowledgeMode;
    version: number;
  }>;
}

export interface AuditEvent {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditFilters {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

export type AnalyticsBucket = "hour" | "day";
export type AdminAnalyticsStatus = "reserved" | "completed" | "failed";
export interface AdminAnalyticsFilters {
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
export interface AdminAnalyticsData {
  query: AdminAnalyticsFilters;
  summary: AdminAnalyticsSummary;
  points: AdminAnalyticsPoint[];
  models: AdminAnalyticsDistribution[];
  providers: AdminAnalyticsDistribution[];
  statuses: AdminAnalyticsDistribution[];
}
export type AdminJobStatus = "queued" | "running" | "completed" | "failed";
export interface AdminJobFilters {
  status?: AdminJobStatus;
  type?: string;
}
export interface AdminJob {
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
  items: AdminJob[];
  nextCursor: string | null;
  previousCursor: string | null;
  hasPrevious: boolean;
}
export interface RetriedAdminJob {
  job: AdminJob;
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
export interface RetentionScrubRunPage {
  items: RetentionScrubRun[];
}

export type BackupExportStatus = "queued" | "running" | "completed" | "failed";
export interface BackupExport {
  id: string;
  status: BackupExportStatus;
  formatVersion: number;
  includesDiagnostics: boolean;
  secretsRedacted: boolean;
  bytes: number | null;
  fingerprint: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  providerSecrets?: {
    status: BackupExportStatus;
    encrypted: true;
    providerCount: number | null;
    bytes: number | null;
    fingerprint: string | null;
    recoveryKeyId: string | null;
  };
}
export interface BackupExportPage {
  items: BackupExport[];
  restoreEnabled: boolean;
  privilegedSecretBackupsEnabled: boolean;
  providerSecretRestoreEnabled: boolean;
}
export interface ProviderSecretRestoreUpload {
  id: string;
  restoreId: string;
  status: "uploaded";
  version: number;
  filename: string;
  bytes: number;
  baseFingerprint: string;
  sidecarFingerprint: string;
  recoveryKeyId: string;
  createdAt: string;
}
export interface ProviderSecretRestoreImpact {
  providerId: string;
  displayName: string;
  action: "restore" | "skip" | "blocked";
  reason: string | null;
}
export interface ProviderSecretRestorePreview {
  id: string;
  restoreId: string;
  status: "validated";
  version: number;
  baseFingerprint: string;
  sidecarFingerprint: string;
  recoveryKeyId: string;
  recordCount: number;
  providers: ProviderSecretRestoreImpact[];
  warnings: string[];
  blockingErrors: string[];
  providersRemainDisabled: true;
}
export interface ProviderSecretRestoreResult {
  id: string;
  restoreId: string;
  status: "applied";
  providerCount: number;
  providersRemainDisabled: true;
  appliedAt: string;
}
export interface ProviderSecretRestoreState {
  id: string;
  restoreId: string;
  status: "staging" | "uploaded" | "validated" | "applied" | "failed" | "cancelled";
  version: number;
  filename: "provider-secrets.dgsecrets";
  bytes: number;
  baseFingerprint: string;
  sidecarFingerprint: string;
  recoveryKeyId: string;
  recordCount: number | null;
  providers: ProviderSecretRestoreImpact[];
  warnings: string[];
  blockingErrors: string[];
  providersRemainDisabled: true;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  expiresAt: string | null;
  canCancel: boolean;
}
export interface BackupRestoreUpload {
  id: string;
  filename: string;
  bytes: number;
  fingerprint: string;
  createdAt: string;
}
export interface BackupRestoreCount {
  resource: string;
  create: number;
  update: number;
  skip: number;
}
export interface BackupRestorePreview {
  restoreId: string;
  fingerprint: string;
  formatVersion: number;
  createdAt: string;
  counts: BackupRestoreCount[];
  warnings: string[];
  blockingErrors: string[];
  secretsRedacted: boolean;
  attachmentsMissing: number;
}
export interface BackupRestoreResult {
  restoreId: string;
  status: "completed";
  completedAt: string;
  counts: BackupRestoreCount[];
}
export interface BackupRestoreStatusCapability {
  token: string;
  expiresAt: string;
}
export interface BackupRestoreStatus {
  restoreId: string;
  status: "validated" | "running" | "completed" | "failed";
  stage: string;
  completedAt: string | null;
  error: string | null;
}

export interface ConversationPortabilityImportResult {
  dryRun: boolean;
  replayed: boolean;
  conversations: number;
  messages: number;
  attachments: number;
  folders: number;
  tags: number;
  idMap: Record<string, string>;
}

export interface ConversationPortabilityDownload {
  blob: Blob;
  filename: string;
}
