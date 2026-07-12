import type { ModelCapability } from "../../../packages/contracts/src/types.ts";

export type Role = "user" | "admin";
export type UserStatus = "pending" | "approved" | "suspended" | "rejected" | "deleted";
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  balance: number;
  avatar?: string;
}
export interface Conversation {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  project?: string;
  activeLeafId?: string | null;
  version?: number;
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
}
export interface BackupExportPage {
  items: BackupExport[];
  restoreEnabled: boolean;
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
