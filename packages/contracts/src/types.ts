export type ApprovalStatus = "pending" | "approved" | "rejected";
export type UserRole = "user" | "admin";
/** Whether an account may obtain authority. Soft deletion is tracked independently. */
export type AccountState = "active" | "suspended";

/** Canonical provider-model capabilities shared by persistence, API validation, and clients. */
export const MODEL_CAPABILITIES = [
  "chat",
  "streaming",
  "vision",
  "tools",
  "reasoning",
  "embeddings",
  "audio_input",
  "transcription",
  "translation",
  "speech",
  "image_generation",
  "image_editing",
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
export const isModelCapability = (value: string): value is ModelCapability =>
  (MODEL_CAPABILITIES as readonly string[]).includes(value);

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  approvalStatus: ApprovalStatus;
  state: AccountState;
  balanceMicros: number;
  emailVerifiedAt?: string | null;
  /** Independent soft-deletion marker. A deleted account is never eligible for authority. */
  deletedAt: string | null;
  /** Optimistic lifecycle version used by administrative mutations. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Administrative projection with an explicit derived authority invariant. */
export interface AdminUser extends PublicUser {
  effectiveAdmin: boolean;
}

export type AdminUserDeletionFilter = "present" | "deleted" | "all";

export interface AdminUserQuery {
  search?: string;
  role?: UserRole;
  approvalStatus?: ApprovalStatus;
  state?: AccountState;
  deletion?: AdminUserDeletionFilter;
  emailVerified?: boolean;
  cursor?: string;
  limit?: number;
}

export interface AdminUserPage {
  data: AdminUser[];
  nextCursor: string | null;
}

export type AdminSessionSource = "better_auth" | "legacy";
export type AdminSessionStatus = "active" | "expired" | "revoked";

/** Credential-free administrative projection of one browser session. */
export interface AdminSessionSummary {
  /** Source-prefixed opaque identifier; never a cookie or session token. */
  id: string;
  userId: string;
  source: AdminSessionSource;
  current: boolean;
  limited: boolean;
  status: AdminSessionStatus;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  invalidatedAt: string | null;
}

export interface AdminSessionQuery {
  source?: AdminSessionSource;
  status?: AdminSessionStatus;
  cursor?: string;
  limit?: number;
}

export interface AdminSessionPage {
  data: AdminSessionSummary[];
  nextCursor: string | null;
}

export interface AdminSessionRevocationRequest {
  reason: string;
}

/** Persistence command for a target-bound, audited administrative session revocation. */
export interface AdminSessionRevocationCommand extends AdminSessionRevocationRequest {
  actorId: string;
  targetUserId: string;
  source: AdminSessionSource;
  sessionId: string;
  currentSession: Pick<AdminSessionSummary, "source" | "id"> | null;
}

export interface SessionResponse {
  user: PublicUser;
  limited: boolean;
}

/** Authoritative account and current-session state used by approval/verification screens. */
export interface AuthStatusResponse {
  approvalStatus: ApprovalStatus;
  state: AccountState;
  emailVerified: boolean;
  /** Whether this deployment requires verified email before a full session may be issued. */
  emailVerificationRequired: boolean;
  /** The presented session remains status-only and can never gain workspace privilege in place. */
  sessionLimited: boolean;
  /** The account may obtain a full session by signing in again. */
  fullSessionEligible: boolean;
  /** The presented session currently has full workspace eligibility and privilege. */
  fullAccess: boolean;
}

export type MessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface MessageNode {
  id: string;
  conversationId: string;
  parentId: string | null;
  supersedesId: string | null;
  generationId: string | null;
  siblingIndex: number;
  role: MessageRole;
  content: string;
  model: string | null;
  status: "complete" | "streaming" | "stopped" | "error" | "tombstoned";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Conversation {
  id: string;
  ownerId: string;
  title: string;
  activeLeafId: string | null;
  version: number;
  pinned: boolean;
  temporary: boolean;
  /** Exact lifecycle deadline for temporary chats; null for saved chats. */
  temporaryExpiresAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends Conversation {
  messages: MessageNode[];
}

/** Visibility of the conversation owner's identity on an immutable public share. */
export type ConversationShareIdentityVisibility = "owner" | "anonymous";
/** Attachment materialization policy selected when a share is created. */
export type ConversationShareAttachmentPolicy = "include" | "redact" | "selected";

/** Immutable attachment metadata exposed by a public share. Object-store keys are never public. */
export interface PublicConversationShareAttachment {
  /** Share-local identifier; never the private attachment identifier. */
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/** One share-local node on the exact root-to-leaf path captured at share creation. */
export interface PublicConversationShareMessage {
  /** Share-local identifier; never the private message identifier. */
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool";
  content: string;
  status: "complete" | "stopped" | "error";
  attachmentIds: string[];
  createdAt: string;
}

/** Read-only materialized public snapshot. It never follows later conversation edits. */
export interface PublicConversationShare {
  id: string;
  title: string;
  conversationVersion: number;
  identity: {
    visibility: ConversationShareIdentityVisibility;
    displayName: string | null;
  };
  attachmentPolicy: ConversationShareAttachmentPolicy;
  messages: PublicConversationShareMessage[];
  attachments: PublicConversationShareAttachment[];
  createdAt: string;
  expiresAt: string | null;
}

/** Owner-only lifecycle metadata. Private graph identifiers never enter the public contract. */
export interface ConversationShareSummary {
  id: string;
  conversationId: string;
  leafId: string;
  conversationVersion: number;
  title: string;
  identityVisibility: ConversationShareIdentityVisibility;
  attachmentPolicy: ConversationShareAttachmentPolicy;
  attachmentCount: number;
  messageCount: number;
  version: number;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export type ThemePreference = "light" | "dark" | "system";
export interface UserPreferences {
  userId: string;
  version: number;
  theme: ThemePreference;
  compactConversations: boolean;
  reduceMotion: boolean;
  customInstructions: string;
  useMemory: boolean;
  saveHistory: boolean;
  preferredModelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationFolder {
  id: string;
  ownerId: string;
  name: string;
  position: number;
  version: number;
  membershipVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationFolderMembership {
  folderId: string;
  conversationId: string;
  ownerId: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTag {
  id: string;
  ownerId: string;
  name: string;
  color: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTagBinding {
  conversationId: string;
  tagId: string;
  ownerId: string;
  createdAt: string;
}

export interface ConversationTagSet {
  conversationId: string;
  ownerId: string;
  version: number;
  updatedAt: string;
}

export type WebGenerationEvent =
  | {
    type: "generation.started";
    generationId: string;
    sequence: number;
    user: MessageNode;
    conversation: Conversation;
    replay: boolean;
  }
  | {
    type:
      | "response.text.delta"
      | "response.reasoning.delta"
      | "response.refusal.delta";
    generationId: string;
    sequence: number;
    delta: string;
  }
  | {
    type: "response.tool_call.delta";
    generationId: string;
    sequence: number;
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }
  | {
    type: "response.usage";
    generationId: string;
    sequence: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  }
  | {
    type: "generation.completed" | "generation.stopped" | "generation.error";
    generationId: string;
    sequence: number;
    assistant: MessageNode;
    conversation: Conversation;
  };

export interface ApiTokenSummary {
  id: string;
  name: string;
  preview: string;
  scopes: string[];
  version: number;
  rpmLimit: number | null;
  burstLimit: number | null;
  accessMode: "inherit" | "restricted";
  rotationFamilyId: string;
  rotationGeneration: number;
  rotatedFromTokenId: string | null;
  replacedByTokenId: string | null;
  overlapEndsAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type AdminApiTokenStatus = "active" | "overlap" | "expired" | "revoked" | "replaced";

/** Complete non-secret administrative token projection, including rotation and access policy. */
export interface AdminApiTokenSummary extends ApiTokenSummary {
  ownerId: string;
  groupIds: string[];
  status: AdminApiTokenStatus;
}

export interface AdminApiTokenQuery {
  status?: AdminApiTokenStatus;
  cursor?: string;
  limit?: number;
}

export interface AdminApiTokenPage {
  data: AdminApiTokenSummary[];
  nextCursor: string | null;
}

export interface AdminApiTokenRevocationRequest {
  expectedVersion: number;
  reason: string;
}

/** Persistence command for a target-bound, versioned token-family revocation. */
export interface AdminApiTokenRevocationCommand extends AdminApiTokenRevocationRequest {
  actorId: string;
  targetUserId: string;
  tokenId: string;
}

export type AdminLedgerKind = "grant" | "reserve" | "settle" | "refund" | "adjustment";

export interface AdminLedgerAdjustmentDetail {
  id: string;
  actorId: string;
  reason: string;
}

/** Administrative ledger projection that deliberately excludes arbitrary stored metadata. */
export interface AdminLedgerEntry {
  id: string;
  userId: string;
  usageRunId: string;
  kind: AdminLedgerKind;
  amountMicros: number;
  balanceAfterMicros: number;
  adjustment: AdminLedgerAdjustmentDetail | null;
  createdAt: string;
}

export interface AdminLedgerQuery {
  kind?: AdminLedgerKind;
  cursor?: string;
  limit?: number;
}

export interface AdminLedgerPage {
  data: AdminLedgerEntry[];
  nextCursor: string | null;
}

export interface AdminBalanceAdjustmentRequest {
  amountMicros: number;
  expectedBalanceMicros: number;
  reason: string;
}

/** Internal durable-command input; only hashes of HTTP replay material may cross this boundary. */
export interface AdminBalanceAdjustmentCommand extends AdminBalanceAdjustmentRequest {
  actorId: string;
  targetUserId: string;
  idempotencyKeyHash: string;
  requestHash: string;
}

export interface AdminBalanceAdjustment {
  id: string;
  targetUserId: string;
  actorId: string;
  amountMicros: number;
  balanceBeforeMicros: number;
  balanceAfterMicros: number;
  reason: string;
  ledgerEntryId: string;
  auditEventId: string;
  createdAt: string;
  replayed: boolean;
}

export interface UsageSummary {
  balanceMicros: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  spentMicros: number;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  capabilities: ModelCapability[];
  contextWindow: number;
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion?: number;
  reasoningMicrosPerMillion?: number;
  outputMicrosPerMillion: number;
  fixedCallMicros?: number;
  pricingVersionId?: string;
}

export interface OpenAIMessage {
  role: MessageRole;
  content: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream_options?: { include_usage?: boolean };
  tool_choice?: unknown;
  response_format?: unknown;
  parallel_tool_calls?: boolean;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  n?: number;
  tools?: unknown[];
  user?: string;
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Internal canonical bridge for Responses reasoning summaries. */
  reasoning_summary?: "none" | "auto" | "concise" | "detailed";
}

export interface ApiErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}
