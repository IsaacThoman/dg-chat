import type {
  AccessGroupPolicyImpact,
  AdminAnalyticsData,
  AdminAnalyticsFilters,
  AdminJobFilters,
  AdminJobPage,
  AdminModel,
  AdminProvider,
  AdminTokenAccessItem,
  Attachment,
  AuditEvent,
  AuditFilters,
  BackupExport,
  BackupExportPage,
  BackupRestorePreview,
  BackupRestoreResult,
  BackupRestoreStatus,
  BackupRestoreStatusCapability,
  BackupRestoreUpload,
  Conversation,
  ConversationKnowledge,
  DiscoveredProviderModel,
  KnowledgeCollection,
  KnowledgeMode,
  Message,
  Model,
  ModelAccessGroup,
  ModelAlias,
  ModelPriceVersion,
  ProviderProtocol,
  RetentionPolicy,
  RetentionPreview,
  RetentionScrubRun,
  RetentionScrubRunPage,
  RetriedAdminJob,
  Token,
  TokenRotation,
  TokenSecret,
  User,
} from "./types.ts";
import { demoConversations, demoMessages, demoModels, demoTokens, demoUser } from "./demo.ts";
import type { SetupStatus } from "./setupDiscovery.ts";
import type { ModelCapability } from "../../../packages/contracts/src/types.ts";

const json = { "Content-Type": "application/json" };
const demoMode = import.meta.env.VITE_DEMO_MODE === "true";

type RawUser = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  approvalStatus: "pending" | "approved" | "rejected";
  state: "active" | "suspended" | "deleted";
  balanceMicros: number;
};
type RawConversation = {
  id: string;
  title: string;
  activeLeafId: string | null;
  version: number;
  pinned: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
  messages?: RawMessage[];
};
type RawMessage = {
  id: string;
  parentId: string | null;
  supersedesId: string | null;
  siblingIndex: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  model: string | null;
  status?: "complete" | "stopped" | "error";
  metadata: Record<string, unknown>;
  createdAt: string;
  attachments?: Attachment[];
};
type RawModel = {
  id: string;
  displayName: string;
  provider: string;
  capabilities: ModelCapability[];
  contextWindow: number;
};
export type ToolDefinition = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
};
export type ToolPolicy = {
  toolId: string;
  allowed: boolean;
  allowedDomains: string[];
  allowPrivateNetwork: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string;
};
export type AdminTool = { definition: ToolDefinition; policy: ToolPolicy | null };
export type ToolExecution = {
  id: string;
  ownerId: string;
  toolId: string;
  input: unknown;
  status:
    | "pending_approval"
    | "queued_pending_reservation"
    | "queued"
    | "running"
    | "succeeded_pending_settlement"
    | "succeeded"
    | "failed"
    | "cancelled";
  result: unknown | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};

function mapUser(user: RawUser): User {
  const status = user.state === "suspended" || user.state === "deleted"
    ? user.state
    : user.approvalStatus;
  return { ...user, status, balance: user.balanceMicros / 1_000_000 };
}
export function mapConversation(value: RawConversation): Conversation {
  return {
    id: value.id,
    title: value.title,
    preview: "",
    updatedAt: new Date(value.updatedAt).toLocaleString(),
    pinned: value.pinned,
    archived: Boolean(value.archivedAt),
    deleted: Boolean(value.deletedAt),
    activeLeafId: value.activeLeafId,
    version: value.version,
  };
}
export function mapMessage(value: RawMessage): Message {
  const toolExecutionIds = Array.isArray(value.metadata?.toolExecutionIds)
    ? value.metadata.toolExecutionIds.filter((id): id is string => typeof id === "string")
    : [];
  const duration = typeof value.metadata?.durationMs === "number"
    ? `${value.metadata.durationMs}ms`
    : undefined;
  const tokens = typeof value.metadata?.outputTokens === "number"
    ? `${value.metadata.outputTokens} tokens`
    : undefined;
  const reasoning = typeof value.metadata?.reasoning === "string" && value.metadata.reasoning
    ? value.metadata.reasoning
    : undefined;
  const toolCalls = Array.isArray(value.metadata?.toolCalls) ? value.metadata.toolCalls.length : 0;
  const knowledgeSources = Array.isArray(value.metadata?.knowledgeSources)
    ? value.metadata.knowledgeSources.filter((source): source is {
      label: string;
      collectionName: string;
      filename: string;
    } => {
      if (!source || typeof source !== "object") return false;
      const item = source as Record<string, unknown>;
      return typeof item.label === "string" && typeof item.collectionName === "string" &&
        typeof item.filename === "string";
    })
    : undefined;
  return {
    id: value.id,
    parentId: value.parentId,
    supersedesId: value.supersedesId,
    siblingIndex: value.siblingIndex,
    role: value.role === "assistant" ? "assistant" : "user",
    content: value.role === "user" && typeof value.metadata?.authoredContent === "string"
      ? value.metadata.authoredContent
      : value.content,
    createdAtIso: value.createdAt,
    createdAt: new Date(value.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    model: value.model ?? undefined,
    latency: [duration, tokens].filter(Boolean).join(" · ") || undefined,
    reasoning,
    toolStatus: toolCalls ? `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}` : undefined,
    toolExecutionIds,
    knowledgeSources,
    status: value.status ?? "complete",
    attachments: value.attachments,
  };
}
function mapModel(value: RawModel): Model {
  return {
    id: value.id,
    name: value.displayName,
    provider: value.provider,
    context: value.contextWindow >= 1_000_000
      ? `${value.contextWindow / 1_000_000}M`
      : `${Math.round(value.contextWindow / 1_000)}K`,
    capabilities: value.capabilities,
    healthy: true,
  };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function responseError(response: Response): Promise<ApiError> {
  const fallback = `Request failed (${response.status})`;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return new ApiError(response.status, "request_failed", fallback);
  }
  try {
    const value = await response.json() as {
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    const rawCode = value.error?.code ?? value.code;
    const rawMessage = value.error?.message ?? value.message;
    const code = typeof rawCode === "string" && rawCode.length <= 120 ? rawCode : "request_failed";
    const message = typeof rawMessage === "string" && rawMessage.length <= 500
      ? rawMessage
      : fallback;
    return new ApiError(response.status, code, message);
  } catch {
    return new ApiError(response.status, "request_failed", fallback);
  }
}

async function request<T>(path: string, init?: RequestInit, fallback?: T): Promise<T> {
  try {
    const response = await fetch(`/api${path}`, {
      credentials: "include",
      ...init,
      headers: { ...json, ...init?.headers },
    });
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (demoMode && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
}

function uploadError(xhr: XMLHttpRequest): Error {
  try {
    const payload = JSON.parse(xhr.responseText) as { error?: { message?: string } };
    if (payload.error?.message) return new Error(payload.error.message);
  } catch {
    // Preserve a stable, non-HTML error when the server did not return JSON.
  }
  return new Error(xhr.status ? `Upload failed (${xhr.status})` : "Upload failed");
}

function auditQuery(filters: AuditFilters, cursor?: string, limit = 50) {
  const query = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export function adminAnalyticsQuery(filters: AdminAnalyticsFilters) {
  const query = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    bucket: filters.bucket,
  });
  for (const key of ["userId", "model", "provider", "status"] as const) {
    const value = filters[key];
    if (value) query.set(key, value);
  }
  return query.toString();
}

export function adminJobsQuery(
  filters: AdminJobFilters = {},
  cursor?: string,
  limit = 50,
) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (filters.status) query.set("status", filters.status);
  if (filters.type) query.set("type", filters.type);
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export function uploadAttachment(
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<Attachment> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const xhr = createRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.open("POST", "/api/attachments");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
      }
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(uploadError(xhr));
        return;
      }
      try {
        const payload = JSON.parse(xhr.responseText) as { attachment?: Attachment };
        if (!payload.attachment?.id) throw new Error("Upload returned an invalid attachment");
        onProgress(100);
        resolve(payload.attachment);
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(uploadError(xhr));
    };
    xhr.onabort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Upload cancelled", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export const api = {
  setupStatus: () =>
    request<SetupStatus>("/setup/status", undefined, {
      bootstrapRequired: false,
      setupEnabled: true,
      oidcEnabled: false,
    }),
  me: async () =>
    demoMode ? demoUser : mapUser((await request<{ user: RawUser }>("/auth/me")).user),
  status: () => request<{ approvalStatus: string; state: string }>("/auth/status"),
  conversations: async () =>
    demoMode
      ? structuredClone(demoConversations)
      : (await request<{ data: RawConversation[] }>("/conversations")).data.map(mapConversation),
  deletedConversations: async () =>
    demoMode
      ? structuredClone(demoConversations.filter((conversation) => conversation.deleted))
      : (await request<{ data: RawConversation[] }>("/conversations?deleted=true")).data
        .map(mapConversation).filter((conversation) => conversation.deleted),
  attachments: async () => {
    const result = await request<{ data?: Attachment[]; attachments?: Attachment[] }>(
      "/attachments",
    );
    return result.data ?? result.attachments ?? [];
  },
  collections: async () => (await request<{ data: KnowledgeCollection[] }>("/collections")).data,
  collection: (id: string) =>
    request<{ collection: KnowledgeCollection; attachments: Attachment[] }>(
      `/collections/${encodeURIComponent(id)}`,
    ),
  createCollection: (name: string) =>
    request<KnowledgeCollection>("/collections", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ name }),
    }),
  updateCollection: (collection: KnowledgeCollection, name: string) =>
    request<KnowledgeCollection>(
      `/collections/${encodeURIComponent(collection.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name, expectedVersion: collection.version }),
      },
    ),
  deleteCollection: (collection: KnowledgeCollection) =>
    request<void>(`/collections/${encodeURIComponent(collection.id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: collection.version }),
    }),
  addCollectionAttachment: (collection: KnowledgeCollection, attachmentId: string) =>
    request<{ collection: KnowledgeCollection }>(
      `/collections/${encodeURIComponent(collection.id)}/attachments/${
        encodeURIComponent(attachmentId)
      }`,
      { method: "POST", body: JSON.stringify({ expectedVersion: collection.version }) },
    ),
  removeCollectionAttachment: (collection: KnowledgeCollection, attachmentId: string) =>
    request<{ collection: KnowledgeCollection }>(
      `/collections/${encodeURIComponent(collection.id)}/attachments/${
        encodeURIComponent(attachmentId)
      }`,
      { method: "DELETE", body: JSON.stringify({ expectedVersion: collection.version }) },
    ),
  conversationKnowledge: (conversationId: string) =>
    request<ConversationKnowledge>(
      `/conversations/${encodeURIComponent(conversationId)}/knowledge`,
    ),
  setConversationKnowledge: (
    conversationId: string,
    collectionIds: string[],
    mode: KnowledgeMode,
  ) =>
    request<ConversationKnowledge>(
      `/conversations/${encodeURIComponent(conversationId)}/knowledge`,
      { method: "PUT", body: JSON.stringify({ collectionIds, mode }) },
    ),
  uploadAttachment,
  deleteAttachment: (id: string) =>
    request<unknown>(`/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  retryAttachmentIngestion: (id: string) =>
    request<{ attachment: Attachment }>(
      `/attachments/${encodeURIComponent(id)}/ingestion/retry`,
      { method: "POST" },
    ).then((result) => result.attachment),
  updateConversation: async (
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
  ) =>
    mapConversation(
      await request<RawConversation>(`/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    ),
  conversation: async (id: string) =>
    mapConversation(await request<RawConversation>(`/conversations/${id}`)),
  conversationGraph: async (id: string) => {
    const detail = await request<RawConversation>(`/conversations/${id}`);
    return {
      conversation: mapConversation(detail),
      messages: detail.messages?.map(mapMessage) ?? [],
    };
  },
  messages: async (id: string) =>
    demoMode
      ? structuredClone(demoMessages)
      : (await request<RawConversation>(`/conversations/${id}`)).messages?.map(mapMessage) ?? [],
  models: async () =>
    demoMode
      ? structuredClone(demoModels)
      : (await request<{ data: RawModel[] }>("/models")).data.map(mapModel),
  tokens: async () =>
    demoMode ? structuredClone(demoTokens) : (await request<{ data: Token[] }>("/tokens")).data,
  usage: () =>
    request<{
      balanceMicros: number;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      spentMicros: number;
    }>("/usage"),
  adminUsers: async () => (await request<{ data: RawUser[] }>("/admin/users")).data.map(mapUser),
  approveUser: async (id: string, status: "approved" | "rejected") =>
    mapUser(
      await request<RawUser>(`/admin/users/${id}/approval`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    ),
  setUserState: async (id: string, state: "active" | "suspended" | "deleted") =>
    mapUser(
      await request<RawUser>(`/admin/users/${id}/state`, {
        method: "PATCH",
        body: JSON.stringify({ state }),
      }),
    ),
  signIn: async (email: string, password: string) => {
    await request<{ user: { id: string } }>("/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return await api.me();
  },
  signUp: async (name: string, email: string, password: string) => {
    await request<{ user: { id: string } }>("/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    });
    return await api.me();
  },
  signOut: () => request<void>("/auth/sign-out", { method: "POST" }),
  startOidc: () =>
    request<{ url: string; redirect: true }>("/auth/sign-in/oidc", {
      method: "POST",
      body: "{}",
    }),
  setup: (setupToken: string, name: string, email: string, password: string) =>
    request<{ user: RawUser }>("/setup/bootstrap", {
      method: "POST",
      headers: { "x-setup-token": setupToken },
      body: JSON.stringify({ name, email, password }),
    }),
  createConversation: async (title = "New chat", idempotencyKey: string = crypto.randomUUID()) =>
    mapConversation(
      await request<RawConversation>("/conversations", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ title, idempotencyKey }),
      }),
    ),
  createToken: (input: {
    name: string;
    scopes: string[];
    expiresAt: string | null;
    rpmLimit: number | null;
    burstLimit: number | null;
  }) =>
    request<TokenSecret>("/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateToken: (token: Token, input: {
    name: string;
    scopes: string[];
    expiresAt: string | null;
    rpmLimit: number | null;
    burstLimit: number | null;
  }) =>
    request<Token>(`/tokens/${encodeURIComponent(token.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: token.version, ...input }),
    }),
  rotateToken: (token: Token, overlapSeconds: number) =>
    request<TokenRotation>(`/tokens/${encodeURIComponent(token.id)}/rotate`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: token.version, overlapSeconds }),
    }),
  revokeToken: (token: Token) =>
    request<void>(`/tokens/${encodeURIComponent(token.id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: token.version }),
    }),
  generate: async (
    conversation: Conversation,
    content: string,
    model: string,
    edit?: Message,
    idempotencyKey: string = crypto.randomUUID(),
    attachmentIds: string[] = [],
    signal?: AbortSignal,
    toolExecutionIds: string[] = [],
  ) => {
    const result = await request<
      { user: RawMessage; assistant: RawMessage; conversation: RawConversation }
    >(`/conversations/${conversation.id}/generate`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        content,
        model,
        parentId: edit ? edit.parentId : conversation.activeLeafId,
        supersedesId: edit?.id ?? null,
        expectedVersion: conversation.version,
        idempotencyKey,
        attachmentIds,
        toolExecutionIds,
      }),
    });
    return {
      user: mapMessage(result.user),
      assistant: mapMessage(result.assistant),
      conversation: mapConversation(result.conversation),
    };
  },
  setActiveLeaf: async (conversation: Conversation, leafId: string) =>
    demoMode
      ? { ...conversation, activeLeafId: leafId, version: (conversation.version ?? 0) + 1 }
      : mapConversation(
        await request<RawConversation>(`/conversations/${conversation.id}/active-leaf`, {
          method: "POST",
          body: JSON.stringify({ leafId, expectedVersion: conversation.version ?? 0 }),
        }),
      ),
  adminUsage: () =>
    request<{ calls: number; users: number; balanceMicros: number; ledger: unknown[] }>(
      "/admin/usage",
    ),
  adminAnalytics: (filters: AdminAnalyticsFilters) =>
    request<AdminAnalyticsData>(`/admin/analytics?${adminAnalyticsQuery(filters)}`),
  adminAnalyticsCsvUrl: (filters: AdminAnalyticsFilters) =>
    `/api/admin/analytics.csv?${adminAnalyticsQuery(filters)}`,
  adminProviders: async () => (await request<{ data: AdminProvider[] }>("/admin/providers")).data,
  createAdminProvider: (input: {
    slug: string;
    displayName: string;
    baseUrl: string;
    protocol: ProviderProtocol;
    enabled: boolean;
  }) => request<AdminProvider>("/admin/providers", { method: "POST", body: JSON.stringify(input) }),
  updateAdminProvider: (
    provider: AdminProvider,
    patch: Partial<Pick<AdminProvider, "displayName" | "baseUrl" | "protocol" | "enabled">>,
  ) =>
    request<AdminProvider>(`/admin/providers/${encodeURIComponent(provider.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: provider.version, ...patch }),
    }),
  replaceAdminProviderCredential: (provider: AdminProvider, credential: string) =>
    request<AdminProvider>(`/admin/providers/${encodeURIComponent(provider.id)}/credential`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: provider.version, credential }),
    }),
  testAdminProvider: (provider: AdminProvider) =>
    request<{ provider: AdminProvider; latencyMs: number; modelCount: number }>(
      `/admin/providers/${encodeURIComponent(provider.id)}/test`,
      { method: "POST", body: JSON.stringify({ expectedVersion: provider.version }) },
    ),
  discoverAdminProvider: (provider: AdminProvider) =>
    request<{ provider: AdminProvider; latencyMs: number; models: DiscoveredProviderModel[] }>(
      `/admin/providers/${encodeURIComponent(provider.id)}/discover`,
      { method: "POST", body: JSON.stringify({ expectedVersion: provider.version }) },
    ),
  adminModels: async () => (await request<{ data: AdminModel[] }>("/admin/models")).data,
  adminModelAccessGroups: async () =>
    (await request<{ data: ModelAccessGroup[] }>("/admin/model-access/groups")).data,
  createAdminModelAccessGroup: (input: { name: string; description: string }) =>
    request<ModelAccessGroup>("/admin/model-access/groups", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAdminModelAccessGroup: (
    group: ModelAccessGroup,
    input: { name: string; description: string },
  ) =>
    request<ModelAccessGroup>(`/admin/model-access/groups/${encodeURIComponent(group.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: group.version, ...input }),
    }),
  replaceAdminModelAccessGroupMembers: (group: ModelAccessGroup, userIds: string[]) =>
    request<ModelAccessGroup>(
      `/admin/model-access/groups/${encodeURIComponent(group.id)}/users`,
      {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: group.version, ids: userIds }),
      },
    ),
  replaceAdminModelAccessGroupModels: (group: ModelAccessGroup, modelIds: string[]) =>
    request<ModelAccessGroup>(
      `/admin/model-access/groups/${encodeURIComponent(group.id)}/models`,
      {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: group.version, ids: modelIds }),
      },
    ),
  previewAdminModelAccessGroupPolicy: (
    group: ModelAccessGroup,
    proposal: { userIds: string[]; modelIds: string[]; tokenIds: string[] } | null,
  ) =>
    request<AccessGroupPolicyImpact>(
      `/admin/model-access/groups/${encodeURIComponent(group.id)}/impact`,
      { method: "POST", body: JSON.stringify({ proposal }) },
    ),
  replaceAdminModelAccessGroupPolicy: (
    group: ModelAccessGroup,
    input: {
      name: string;
      description: string;
      userIds: string[];
      modelIds: string[];
      tokenIds: string[];
    },
  ) =>
    request<ModelAccessGroup>(
      `/admin/model-access/groups/${encodeURIComponent(group.id)}/policy`,
      {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: group.version, ...input }),
      },
    ),
  deleteAdminModelAccessGroup: (group: ModelAccessGroup) =>
    request<void>(`/admin/model-access/groups/${encodeURIComponent(group.id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: group.version }),
    }),
  adminModelAccessTokens: (query = "", cursor?: string, limit = 100, signal?: AbortSignal) => {
    const params = new URLSearchParams({ query, limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return request<{ data: AdminTokenAccessItem[]; nextCursor: string | null }>(
      `/admin/model-access/tokens?${params}`,
      { signal },
    );
  },
  setAdminTokenAccessGroups: (token: AdminTokenAccessItem, groupIds: string[]) =>
    request<Token>(`/admin/model-access/tokens/${encodeURIComponent(token.id)}/groups`, {
      method: "PUT",
      body: JSON.stringify({
        ownerId: token.ownerId,
        expectedVersion: token.version,
        groupIds,
      }),
    }),
  setAdminTokenAccessMode: (
    token: AdminTokenAccessItem,
    accessMode: "inherit" | "restricted",
  ) =>
    request<Token>(`/admin/model-access/tokens/${encodeURIComponent(token.id)}/access-mode`, {
      method: "PUT",
      body: JSON.stringify({
        ownerId: token.ownerId,
        expectedVersion: token.version,
        accessMode,
      }),
    }),
  adminModelAliases: async () =>
    (await request<{ data: ModelAlias[] }>("/admin/model-access/aliases")).data,
  createAdminModelAlias: (input: {
    alias: string;
    targetModelId: string;
    description: string;
  }) =>
    request<ModelAlias>("/admin/model-access/aliases", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAdminModelAlias: (alias: ModelAlias, input: {
    alias: string;
    targetModelId: string;
    description: string;
  }) =>
    request<ModelAlias>(`/admin/model-access/aliases/${encodeURIComponent(alias.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: alias.version, ...input }),
    }),
  deleteAdminModelAlias: (alias: ModelAlias) =>
    request<void>(`/admin/model-access/aliases/${encodeURIComponent(alias.id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: alias.version }),
    }),
  adminTools: async () => (await request<{ data: AdminTool[] }>("/admin/tools")).data,
  updateAdminTool: (
    tool: AdminTool,
    input: Pick<ToolPolicy, "allowed" | "allowedDomains" | "allowPrivateNetwork">,
  ) =>
    request<ToolPolicy>(`/admin/tools/${encodeURIComponent(tool.definition.id)}/policy`, {
      method: "PUT",
      body: JSON.stringify({ ...input, expectedVersion: tool.policy?.version ?? 0 }),
    }),
  tools: async () => (await request<{ data: ToolDefinition[] }>("/tools")).data,
  requestToolExecution: (toolId: string, input: unknown) =>
    request<ToolExecution>("/tools/executions", {
      method: "POST",
      body: JSON.stringify({ toolId, input }),
    }),
  toolExecution: (id: string) =>
    request<ToolExecution>(`/tools/executions/${encodeURIComponent(id)}`),
  approveToolExecution: (id: string) =>
    request<ToolExecution>(`/tools/executions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    }),
  cancelToolExecution: (id: string) =>
    request<ToolExecution>(`/tools/executions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  createAdminModel: (input: {
    providerId: string;
    publicModelId: string;
    upstreamModelId: string;
    displayName: string;
    capabilities: string[];
    contextWindow: number;
    enabled: boolean;
  }) => request<AdminModel>("/admin/models", { method: "POST", body: JSON.stringify(input) }),
  updateAdminModel: (
    model: AdminModel,
    patch: Partial<Pick<AdminModel, "displayName" | "capabilities" | "contextWindow" | "enabled">>,
  ) =>
    request<AdminModel>(`/admin/models/${encodeURIComponent(model.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: model.version, ...patch }),
    }),
  createModelPrice: (
    model: AdminModel,
    input: Omit<ModelPriceVersion, "id" | "providerModelId" | "createdAt">,
  ) =>
    request<ModelPriceVersion>(`/admin/models/${encodeURIComponent(model.id)}/prices`, {
      method: "POST",
      body: JSON.stringify({
        ...input,
        providerModelId: model.id,
        expectedModelVersion: model.version,
      }),
    }),
  adminJobs: (filters: AdminJobFilters = {}, cursor?: string, limit = 50) =>
    request<AdminJobPage>(`/admin/jobs?${adminJobsQuery(filters, cursor, limit)}`),
  retryAdminJob: (id: string) =>
    request<RetriedAdminJob>(`/admin/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  adminRetentionPolicy: () => request<RetentionPolicy>("/admin/retention/policy"),
  updateAdminRetentionPolicy: (
    input: Pick<RetentionPolicy, "captureEnabled" | "requestBodyDays" | "responseBodyDays"> & {
      expectedVersion: number;
    },
  ) =>
    request<RetentionPolicy>("/admin/retention/policy", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  previewAdminRetention: (expectedPolicyVersion: number) =>
    request<RetentionPreview>("/admin/retention/previews", {
      method: "POST",
      body: JSON.stringify({ expectedPolicyVersion }),
    }),
  createAdminRetentionScrub: (idempotencyKey: string, preview: RetentionPreview) =>
    request<RetentionScrubRun>("/admin/retention/scrub-runs", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey,
        expectedPolicyVersion: preview.policyVersion,
        requestCutoffAt: preview.requestCutoffAt,
        responseCutoffAt: preview.responseCutoffAt,
      }),
    }),
  adminRetentionScrubRun: (id: string) =>
    request<RetentionScrubRun>(`/admin/retention/scrub-runs/${encodeURIComponent(id)}`),
  adminRetentionScrubRuns: () => request<RetentionScrubRunPage>("/admin/retention/scrub-runs"),
  adminBackups: () => request<BackupExportPage>("/admin/backups"),
  createAdminBackupExport: (idempotencyKey: string) =>
    request<BackupExport>("/admin/backups/exports", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ includeDiagnostics: false }),
    }),
  createAdminPrivilegedBackupExport: (idempotencyKey: string, confirmation: string) =>
    request<BackupExport>("/admin/backups/privileged-exports", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ includeDiagnostics: false, confirmation }),
    }),
  adminBackupContentUrl: (id: string) => `/api/admin/backups/${encodeURIComponent(id)}/content`,
  adminProviderSecretsContentUrl: (id: string) =>
    `/api/admin/backups/${encodeURIComponent(id)}/provider-secrets/content`,
  downloadAdminProviderSecrets: async (
    id: string,
    destination?: WritableStream<Uint8Array>,
  ): Promise<Blob | undefined> => {
    let pipingStarted = false;
    try {
      const response = await fetch(
        `/api/admin/backups/${encodeURIComponent(id)}/provider-secrets/content`,
        { credentials: "include", headers: { Accept: "application/octet-stream" } },
      );
      if (!response.ok) {
        let body: { error?: { code?: string; message?: string } } = {};
        try {
          body = await response.json();
        } catch {
          // Preserve a useful status-based error when an intermediary returned a non-JSON body.
        }
        throw new ApiError(
          response.status,
          body.error?.code ?? "request_failed",
          body.error?.message ?? `Request failed (${response.status})`,
        );
      }
      if (destination) {
        if (!response.body) {
          throw new ApiError(502, "empty_download", "The provider-secret download was empty");
        }
        pipingStarted = true;
        await response.body.pipeTo(destination);
        return;
      }

      // Browsers without the File System Access API cannot stream a download to a chosen file while
      // retaining structured recent-auth errors. Keep that compatibility path strictly bounded.
      const maxFallbackBytes = 32 * 1024 * 1024;
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxFallbackBytes) {
        await response.body?.cancel();
        throw new ApiError(
          413,
          "download_too_large_for_browser",
          "This encrypted sidecar is too large for this browser's safe download fallback. Use a Chromium-based browser with direct file saving enabled.",
        );
      }
      if (!response.body) return new Blob();
      const reader = response.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxFallbackBytes) {
            await reader.cancel();
            throw new ApiError(
              413,
              "download_too_large_for_browser",
              "This encrypted sidecar is too large for this browser's safe download fallback. Use a Chromium-based browser with direct file saving enabled.",
            );
          }
          const copy = new Uint8Array(value.byteLength);
          copy.set(value);
          chunks.push(copy.buffer);
        }
        return new Blob(chunks, { type: "application/vnd.dg-chat.provider-secrets" });
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      // A picker-created destination exists before fetch begins. Close it on authentication,
      // transport, or response-validation failure; pipeTo owns aborting once piping has started.
      if (destination && !pipingStarted) {
        try {
          await destination.abort(error);
        } catch {
          // Never replace the authoritative network/API error with cleanup failure.
        }
      }
      throw error;
    }
  },
  uploadAdminBackupRestore: (
    file: File,
    idempotencyKey: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<BackupRestoreUpload> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("file", file);
      xhr.open("POST", "/api/admin/backups/restore-uploads");
      xhr.withCredentials = true;
      xhr.setRequestHeader("Idempotency-Key", idempotencyKey);
      const abort = () => xhr.abort();
      const cleanup = () => signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
      };
      xhr.onerror = () => {
        cleanup();
        reject(uploadError(xhr));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException("Upload cancelled", "AbortError"));
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status < 200 || xhr.status >= 300) return reject(uploadError(xhr));
        try {
          resolve(JSON.parse(xhr.responseText) as BackupRestoreUpload);
        } catch {
          reject(new Error("The server returned an invalid upload response."));
        }
      };
      xhr.send(form);
    }),
  previewAdminBackupRestore: (id: string) =>
    request<BackupRestorePreview>(
      `/admin/backups/restores/${encodeURIComponent(id)}/dry-run`,
      { method: "POST" },
    ),
  issueAdminBackupRestoreStatusCapability: (id: string) =>
    request<BackupRestoreStatusCapability>(
      `/admin/backups/restores/${encodeURIComponent(id)}/status-capability`,
      { method: "POST", body: "{}" },
    ),
  adminBackupRestoreStatus: (id: string, capability: string, signal?: AbortSignal) =>
    request<BackupRestoreStatus>(`/backup-restore-status/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${capability}` },
      signal,
    }),
  applyAdminBackupRestore: (id: string, fingerprint: string, signal?: AbortSignal) =>
    request<BackupRestoreResult>(`/admin/backups/restores/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      body: JSON.stringify({ fingerprint }),
      signal,
    }),
  adminAudit: (filters: AuditFilters = {}, cursor?: string, limit = 50) =>
    request<{ data: AuditEvent[]; nextCursor: string | null }>(
      `/admin/audit?${auditQuery(filters, cursor, limit)}`,
    ),
  adminAuditCsvUrl: (filters: AuditFilters = {}, cursor?: string, limit = 50) =>
    `/api/admin/audit.csv?${auditQuery(filters, cursor, limit)}`,
};
