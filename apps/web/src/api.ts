import type { Conversation, Message, Model, Token, User } from "./types.ts";
import { demoConversations, demoMessages, demoModels, demoTokens, demoUser } from "./demo.ts";
import type { SetupStatus } from "./setupDiscovery.ts";

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
  metadata: Record<string, unknown>;
  createdAt: string;
};
type RawModel = {
  id: string;
  displayName: string;
  provider: string;
  capabilities: string[];
  contextWindow: number;
};

function mapUser(user: RawUser): User {
  const status = user.state === "suspended" || user.state === "deleted"
    ? user.state
    : user.approvalStatus;
  return { ...user, status, balance: user.balanceMicros / 1_000_000 };
}
function mapConversation(value: RawConversation): Conversation {
  return {
    id: value.id,
    title: value.title,
    preview: "",
    updatedAt: new Date(value.updatedAt).toLocaleString(),
    pinned: value.pinned,
    archived: Boolean(value.archivedAt),
    activeLeafId: value.activeLeafId,
    version: value.version,
  };
}
function mapMessage(value: RawMessage): Message {
  const duration = typeof value.metadata?.durationMs === "number"
    ? `${value.metadata.durationMs}ms`
    : undefined;
  const tokens = typeof value.metadata?.outputTokens === "number"
    ? `${value.metadata.outputTokens} tokens`
    : undefined;
  return {
    id: value.id,
    parentId: value.parentId,
    supersedesId: value.supersedesId,
    siblingIndex: value.siblingIndex,
    role: value.role === "assistant" ? "assistant" : "user",
    content: value.content,
    createdAtIso: value.createdAt,
    createdAt: new Date(value.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    model: value.model ?? undefined,
    latency: [duration, tokens].filter(Boolean).join(" · ") || undefined,
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

async function request<T>(path: string, init?: RequestInit, fallback?: T): Promise<T> {
  try {
    const response = await fetch(`/api${path}`, {
      credentials: "include",
      ...init,
      headers: { ...json, ...init?.headers },
    });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json() as T;
  } catch (error) {
    if (demoMode && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
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
  signIn: async (email: string, password: string) =>
    mapUser(
      (await request<{ user: RawUser }>("/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      })).user,
    ),
  signUp: async (name: string, email: string, password: string) =>
    mapUser(
      (await request<{ user: RawUser }>("/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
      })).user,
    ),
  signOut: () => request<void>("/auth/sign-out", { method: "POST" }),
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
  createToken: (name: string) =>
    request<{ token: string }>("/tokens", {
      method: "POST",
      body: JSON.stringify({ name, scopes: ["chat:write", "models:read"] }),
    }),
  generate: async (
    conversation: Conversation,
    content: string,
    model: string,
    edit?: Message,
    idempotencyKey: string = crypto.randomUUID(),
  ) => {
    const result = await request<
      { user: RawMessage; assistant: RawMessage; conversation: RawConversation }
    >(`/conversations/${conversation.id}/generate`, {
      method: "POST",
      body: JSON.stringify({
        content,
        model,
        parentId: edit ? edit.parentId : conversation.activeLeafId,
        supersedesId: edit?.id ?? null,
        expectedVersion: conversation.version,
        idempotencyKey,
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
  adminProviders: async () =>
    (await request<{
      data: Array<{ id: string; status: string; configured: boolean }>;
    }>("/admin/providers")).data,
  adminJobs: async () => (await request<{ data: unknown[] }>("/admin/jobs")).data,
};
