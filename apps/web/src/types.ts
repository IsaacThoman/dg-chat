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
  capabilities: string[];
  healthy: boolean;
}
export interface Token {
  id: string;
  name: string;
  preview: string;
  scopes: string[];
  createdAt: string;
  lastUsed?: string;
  expires?: string;
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
