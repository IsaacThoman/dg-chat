export type ApprovalStatus = "pending" | "approved" | "rejected";
export type UserRole = "user" | "admin";
export type AccountState = "active" | "suspended" | "deleted";

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
  createdAt: string;
}

export interface SessionResponse {
  user: PublicUser;
  limited: boolean;
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
}

export interface ApiErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}
