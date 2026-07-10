export type ApprovalStatus = "pending" | "approved" | "rejected";
export type UserRole = "user" | "admin";
export type AccountState = "active" | "suspended" | "deleted";

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  approvalStatus: ApprovalStatus;
  state: AccountState;
  balanceMicros: number;
  createdAt: string;
}

export interface SessionResponse {
  user: PublicUser;
  limited: boolean;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

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
  archivedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends Conversation {
  messages: MessageNode[];
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  preview: string;
  scopes: string[];
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
  capabilities: string[];
  contextWindow: number;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}

export interface OpenAIMessage {
  role: MessageRole;
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  user?: string;
}

export interface ApiErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}
