import type {
  AccountState,
  ApiTokenSummary,
  ApprovalStatus,
  Conversation,
  ConversationDetail,
  MessageNode,
  MessageRole,
  PublicUser,
  UsageSummary,
  UserRole,
} from "@dg-chat/contracts";
import type {
  BeginGenerationInput,
  CompleteGenerationInput,
  CreateUserInput,
  FailGenerationInput,
  GenerationResult,
} from "./repository.ts";

export interface StoredUser extends PublicUser {
  passwordHash: string;
}
export interface StoredSession {
  tokenHash: string;
  userId: string;
  limited: boolean;
  expiresAt: number;
}
export interface StoredApiToken extends ApiTokenSummary {
  userId: string;
  tokenHash: string;
}
export interface LedgerEntry {
  id: string;
  userId: string;
  usageRunId: string;
  kind: "grant" | "reserve" | "settle" | "refund" | "adjustment";
  amountMicros: number;
  balanceAfterMicros: number;
  createdAt: string;
}
export interface UsageRun {
  id: string;
  userId: string;
  model: string;
  status: "reserved" | "completed" | "failed";
  reservedMicros: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: string;
}

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export class MemoryRepository {
  readonly storageKind: "memory" | "postgres" = "memory";
  readonly users = new Map<string, StoredUser>();
  readonly sessions = new Map<string, StoredSession>();
  readonly tokens = new Map<string, StoredApiToken>();
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, MessageNode>();
  readonly idempotency = new Map<string, string>();
  readonly ledger: LedgerEntry[] = [];
  readonly usageRuns = new Map<string, UsageRun>();
  readonly jobs: Array<
    {
      id: string;
      type: string;
      payload: unknown;
      status: string;
      attempts: number;
      createdAt: string;
    }
  > = [];

  async flush(): Promise<void> {
    // Memory mode is intentionally ephemeral; durable adapters override this hook.
  }

  async close(): Promise<void> {
    await this.flush();
  }

  bootstrapAdmin(
    input: CreateUserInput,
    startingCreditMicros: number,
  ): StoredUser {
    if ([...this.users.values()].some((user) => user.role === "admin")) {
      throw new DomainError("already_bootstrapped", "An administrator already exists", 409);
    }
    const user = this.createUser({ ...input, role: "admin", approvalStatus: "approved" });
    this.credit(user.id, `bootstrap:${user.id}`, "grant", startingCreditMicros);
    return user;
  }

  createUser(
    input: {
      email: string;
      name: string;
      passwordHash: string;
      role?: UserRole;
      approvalStatus?: ApprovalStatus;
      state?: AccountState;
    },
  ): StoredUser {
    if ([...this.users.values()].some((u) => u.email === input.email)) {
      throw new DomainError("email_taken", "An account with that email already exists", 409);
    }
    const user: StoredUser = {
      id: crypto.randomUUID(),
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? "user",
      approvalStatus: input.approvalStatus ?? "pending",
      state: input.state ?? "active",
      balanceMicros: 0,
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    return user;
  }

  publicUser(user: StoredUser): PublicUser {
    const { passwordHash: _passwordHash, ...safe } = user;
    return safe;
  }

  findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email);
  }
  findUser(id: string) {
    return this.users.get(id);
  }

  listUsers(): PublicUser[] {
    return [...this.users.values()].map((user) => this.publicUser(user));
  }

  createSession(userId: string, tokenHash: string, limited: boolean): StoredSession {
    const session = {
      tokenHash,
      userId,
      limited,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };
    this.sessions.set(tokenHash, session);
    return session;
  }

  getSession(tokenHash: string) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= Date.now()) return undefined;
    return session;
  }

  invalidateUserSessions(userId: string) {
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(hash);
    }
  }
  deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  approveUser(id: string, status: "approved" | "rejected", creditMicros: number): StoredUser {
    const user = this.users.get(id);
    if (!user) throw new DomainError("not_found", "User not found", 404);
    if (user.role === "admin" && status === "rejected") {
      const availableAdmins = [...this.users.values()].filter((candidate) =>
        candidate.role === "admin" && candidate.state === "active" &&
        candidate.approvalStatus === "approved"
      );
      if (availableAdmins.length === 1 && availableAdmins[0].id === id) {
        throw new DomainError("final_admin", "The final approved administrator is protected", 409);
      }
    }
    user.approvalStatus = status;
    const alreadyGranted = this.ledger.some((entry) =>
      entry.usageRunId === `approval:${id}` && entry.kind === "grant"
    );
    if (status === "approved" && creditMicros > 0 && !alreadyGranted) {
      this.credit(id, `approval:${id}`, "grant", creditMicros);
    }
    if (status === "rejected") {
      this.invalidateUserSessions(id);
      for (const token of this.tokens.values()) {
        if (token.userId === id && !token.revokedAt) token.revokedAt = new Date().toISOString();
      }
    }
    return user;
  }

  setUserState(id: string, state: AccountState) {
    const user = this.users.get(id);
    if (!user) throw new DomainError("not_found", "User not found", 404);
    if (user.role === "admin" && state !== "active") {
      const activeAdmins = [...this.users.values()].filter((u) =>
        u.role === "admin" && u.state === "active"
      );
      if (activeAdmins.length === 1) {
        throw new DomainError("final_admin", "The final active administrator is protected", 409);
      }
    }
    user.state = state;
    if (state !== "active") {
      this.invalidateUserSessions(id);
      for (const token of this.tokens.values()) {
        if (token.userId === id && !token.revokedAt) token.revokedAt = new Date().toISOString();
      }
    }
    return user;
  }

  createConversation(
    ownerId: string,
    title: string,
    temporary = false,
    idempotencyKey?: string,
  ): Conversation {
    if (idempotencyKey) {
      const priorId = this.idempotency.get(`conversation:${ownerId}:${idempotencyKey}`);
      if (priorId) {
        const prior = this.conversations.get(priorId)!;
        if (prior.title !== title || prior.temporary !== temporary) {
          throw new DomainError("idempotency_conflict", "Conversation replay payload differs", 409);
        }
        return prior;
      }
    }
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      ownerId,
      title,
      activeLeafId: null,
      version: 0,
      pinned: false,
      temporary,
      archivedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    if (idempotencyKey) {
      this.idempotency.set(`conversation:${ownerId}:${idempotencyKey}`, conversation.id);
    }
    return conversation;
  }

  listConversations(ownerId: string, includeDeleted = false) {
    return [...this.conversations.values()].filter((c) =>
      c.ownerId === ownerId && (includeDeleted || !c.deletedAt)
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  updateConversation(
    ownerId: string,
    id: string,
    patch: import("./repository.ts").ConversationPatch,
  ) {
    const value = this.conversations.get(id);
    if (!value || value.ownerId !== ownerId) {
      throw new DomainError("not_found", "Conversation not found", 404);
    }
    if (patch.title !== undefined) value.title = patch.title.trim().slice(0, 200);
    if (patch.pinned !== undefined) value.pinned = patch.pinned;
    if (patch.archived !== undefined) {
      value.archivedAt = patch.archived ? new Date().toISOString() : null;
    }
    if (patch.deleted !== undefined) {
      value.deletedAt = patch.deleted ? new Date().toISOString() : null;
    }
    value.version++;
    value.updatedAt = new Date().toISOString();
    return value;
  }

  detail(id: string, ownerId: string): ConversationDetail {
    const conversation = this.conversations.get(id);
    if (!conversation || conversation.ownerId !== ownerId) {
      throw new DomainError("not_found", "Conversation not found", 404);
    }
    const messages = [...this.messages.values()].filter((m) => m.conversationId === id).sort((
      a,
      b,
    ) => a.createdAt.localeCompare(b.createdAt));
    return { ...conversation, messages };
  }

  appendMessage(
    input: {
      conversationId: string;
      ownerId: string;
      parentId: string | null;
      supersedesId?: string | null;
      role: MessageRole;
      content: string;
      model?: string;
      expectedVersion: number;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
    },
  ): MessageNode {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation || conversation.ownerId !== input.ownerId) {
      throw new DomainError("not_found", "Conversation not found", 404);
    }
    const idemKey = `${input.conversationId}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(idemKey);
    if (existing) {
      const prior = this.messages.get(existing)!;
      if (
        prior.parentId !== input.parentId ||
        prior.supersedesId !== (input.supersedesId ?? null) || prior.role !== input.role ||
        prior.content !== input.content || prior.model !== (input.model ?? null)
      ) {
        throw new DomainError(
          "idempotency_conflict",
          "This idempotency key was used with a different message",
          409,
        );
      }
      return prior;
    }
    if (conversation.version !== input.expectedVersion) {
      throw new DomainError(
        "version_conflict",
        "Conversation changed in another tab; refresh and retry",
        409,
      );
    }
    if (input.parentId) {
      const parent = this.messages.get(input.parentId);
      if (!parent || parent.conversationId !== input.conversationId) {
        throw new DomainError("invalid_parent", "Parent is not in this conversation", 422);
      }
    }
    if (input.supersedesId) {
      const superseded = this.messages.get(input.supersedesId);
      if (
        !superseded || superseded.conversationId !== input.conversationId ||
        superseded.parentId !== input.parentId
      ) {
        throw new DomainError(
          "invalid_supersedes",
          "Edited messages must branch beside the original",
          422,
        );
      }
    }
    const siblings = [...this.messages.values()].filter((m) =>
      m.conversationId === input.conversationId && m.parentId === input.parentId
    );
    const message: MessageNode = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      parentId: input.parentId,
      supersedesId: input.supersedesId ?? null,
      generationId: input.role === "assistant" ? crypto.randomUUID() : null,
      siblingIndex: siblings.length,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
      status: "complete",
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    this.messages.set(message.id, message);
    this.idempotency.set(idemKey, message.id);
    conversation.activeLeafId = message.id;
    conversation.version++;
    conversation.updatedAt = message.createdAt;
    return message;
  }

  beginGeneration(input: BeginGenerationInput): GenerationResult {
    const conversation = this.conversations.get(input.message.conversationId);
    if (!conversation || conversation.ownerId !== input.message.ownerId) {
      throw new DomainError("not_found", "Conversation not found", 404);
    }
    const existingId = this.idempotency.get(
      `${input.message.conversationId}:${input.message.idempotencyKey}`,
    );
    const existingRun = this.usageRuns.get(input.runId);
    if (existingId && existingRun) {
      const existing = this.messages.get(existingId)!;
      if (
        existing.content !== input.message.content || existingRun.userId !== input.message.ownerId
      ) {
        throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
      }
      if (existingRun.status === "failed") {
        throw new DomainError(
          "generation_failed_replay",
          "Failed generations require a new idempotency key",
          409,
        );
      }
      return { message: existing, conversation, usageRun: existingRun, replayed: true };
    }
    const account = this.users.get(input.message.ownerId);
    if (!account || account.balanceMicros < input.reserveMicros) {
      throw new DomainError("insufficient_credit", "Insufficient credit", 402);
    }
    const message = this.appendMessage(input.message);
    const usageRun = this.reserve(
      input.message.ownerId,
      input.runId,
      input.message.model ?? "unknown",
      input.reserveMicros,
    );
    return { message, conversation, usageRun, replayed: false };
  }

  completeGeneration(input: CompleteGenerationInput): GenerationResult {
    const conversation = this.conversations.get(input.conversationId);
    const parent = this.messages.get(input.userMessageId);
    const usageRun = this.usageRuns.get(input.runId);
    if (!conversation || conversation.ownerId !== input.ownerId || !parent || !usageRun) {
      throw new DomainError("not_found", "Generation not found", 404);
    }
    const existingId = this.idempotency.get(`${input.conversationId}:${input.idempotencyKey}`);
    if (existingId) {
      const existing = this.messages.get(existingId)!;
      if (existing.content !== input.content || existing.parentId !== input.userMessageId) {
        throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
      }
      if (usageRun.status !== "completed") {
        throw new DomainError("invalid_usage_state", "Generation is not completed", 409);
      }
      return { message: existing, conversation, usageRun };
    }
    if (usageRun.status !== "reserved") {
      throw new DomainError("invalid_usage_state", "Generation is not reserved", 409);
    }
    const balanceAfterSettlement = this.users.get(input.ownerId)!.balanceMicros +
      usageRun.reservedMicros - input.costMicros;
    if (balanceAfterSettlement < 0) {
      throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
    }
    const previousActive = conversation.activeLeafId;
    const settled = this.settle(
      input.runId,
      input.costMicros,
      input.inputTokens,
      input.outputTokens,
      input.latencyMs,
    );
    const message = this.appendMessage({
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      parentId: input.userMessageId,
      role: "assistant",
      content: input.content,
      model: input.model,
      expectedVersion: conversation.version,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    });
    if (previousActive !== input.userMessageId) conversation.activeLeafId = previousActive;
    return { message, conversation, usageRun: settled };
  }

  failGeneration(input: FailGenerationInput): GenerationResult {
    const conversation = this.conversations.get(input.conversationId);
    const parent = this.messages.get(input.userMessageId);
    if (!conversation || conversation.ownerId !== input.ownerId || !parent) {
      throw new DomainError("not_found", "Generation not found", 404);
    }
    const previousActive = conversation.activeLeafId;
    const usageRun = this.refund(input.runId)!;
    const message = this.appendMessage({
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      parentId: input.userMessageId,
      role: "assistant",
      content: input.error,
      model: input.model,
      expectedVersion: conversation.version,
      idempotencyKey: input.idempotencyKey,
      metadata: { generationError: input.error, retryable: true },
    });
    message.status = "error";
    if (previousActive !== input.userMessageId) conversation.activeLeafId = previousActive;
    return { message, conversation, usageRun };
  }

  setActiveLeaf(conversationId: string, ownerId: string, leafId: string, expectedVersion: number) {
    const conversation = this.conversations.get(conversationId);
    const leaf = this.messages.get(leafId);
    if (
      !conversation || conversation.ownerId !== ownerId || !leaf ||
      leaf.conversationId !== conversationId
    ) throw new DomainError("not_found", "Conversation or branch not found", 404);
    if (conversation.version !== expectedVersion) {
      throw new DomainError("version_conflict", "Conversation changed in another tab", 409);
    }
    if ([...this.messages.values()].some((message) => message.parentId === leafId)) {
      throw new DomainError("invalid_leaf", "Active branch must end at a leaf", 422);
    }
    conversation.activeLeafId = leafId;
    conversation.version++;
    conversation.updatedAt = new Date().toISOString();
    return conversation;
  }

  createApiToken(
    userId: string,
    input: {
      name: string;
      scopes: string[];
      tokenHash: string;
      preview: string;
      expiresAt?: string | null;
    },
  ): StoredApiToken {
    const now = new Date().toISOString();
    const token: StoredApiToken = {
      id: crypto.randomUUID(),
      userId,
      name: input.name,
      scopes: input.scopes,
      tokenHash: input.tokenHash,
      preview: input.preview,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now,
    };
    this.tokens.set(token.id, token);
    return token;
  }

  findApiTokenByHash(hash: string) {
    return [...this.tokens.values()].find((t) => t.tokenHash === hash);
  }
  listApiTokens(userId: string): ApiTokenSummary[] {
    return [...this.tokens.values()].filter((t) => t.userId === userId).map((
      { userId: _u, tokenHash: _h, ...t },
    ) => t);
  }
  revokeApiToken(id: string, userId: string) {
    const token = this.tokens.get(id);
    if (!token || token.userId !== userId) {
      throw new DomainError("not_found", "Token not found", 404);
    }
    token.revokedAt = new Date().toISOString();
  }

  credit(userId: string, usageRunId: string, kind: LedgerEntry["kind"], amountMicros: number) {
    const duplicate = this.ledger.find((e) => e.usageRunId === usageRunId && e.kind === kind);
    if (duplicate) return duplicate;
    const user = this.users.get(userId);
    if (!user) throw new DomainError("not_found", "User not found", 404);
    if (user.balanceMicros + amountMicros < 0) {
      throw new DomainError("insufficient_credit", "Insufficient credit", 402);
    }
    user.balanceMicros += amountMicros;
    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      userId,
      usageRunId,
      kind,
      amountMicros,
      balanceAfterMicros: user.balanceMicros,
      createdAt: new Date().toISOString(),
    };
    this.ledger.push(entry);
    return entry;
  }

  reserve(userId: string, runId: string, model: string, amountMicros: number) {
    const existing = this.usageRuns.get(runId);
    if (existing) {
      throw new DomainError(
        "idempotency_conflict",
        "This idempotency key has already been used",
        409,
      );
    }
    this.credit(userId, runId, "reserve", -amountMicros);
    const run: UsageRun = {
      id: runId,
      userId,
      model,
      status: "reserved",
      reservedMicros: amountMicros,
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      createdAt: new Date().toISOString(),
    };
    this.usageRuns.set(runId, run);
    return run;
  }

  settle(
    runId: string,
    costMicros: number,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
  ) {
    const run = this.usageRuns.get(runId);
    if (!run) throw new DomainError("not_found", "Usage reservation not found", 404);
    if (run.status === "completed") return run;
    if (costMicros > run.reservedMicros) {
      this.credit(run.userId, runId, "settle", -(costMicros - run.reservedMicros));
    } else if (run.reservedMicros > costMicros) {
      this.credit(run.userId, runId, "refund", run.reservedMicros - costMicros);
    }
    run.status = "completed";
    run.costMicros = costMicros;
    run.inputTokens = inputTokens;
    run.outputTokens = outputTokens;
    run.latencyMs = latencyMs;
    return run;
  }

  refund(runId: string) {
    const run = this.usageRuns.get(runId);
    if (!run || run.status !== "reserved") return run;
    this.credit(run.userId, runId, "refund", run.reservedMicros);
    run.status = "failed";
    return run;
  }

  usage(userId: string): UsageSummary {
    const user = this.users.get(userId);
    if (!user) throw new DomainError("not_found", "User not found", 404);
    const runs = [...this.usageRuns.values()].filter((r) =>
      r.userId === userId && r.status === "completed"
    );
    return {
      balanceMicros: user.balanceMicros,
      calls: runs.length,
      inputTokens: runs.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: runs.reduce((n, r) => n + r.outputTokens, 0),
      spentMicros: runs.reduce((n, r) => n + r.costMicros, 0),
    };
  }
  adminSummary() {
    return {
      calls: this.usageRuns.size,
      users: this.users.size,
      balanceMicros: [...this.users.values()].reduce((sum, value) => sum + value.balanceMicros, 0),
      ledger: [...this.ledger],
    };
  }
  listJobs() {
    return [...this.jobs];
  }
  readiness() {
    return { ready: true, storage: this.storageKind };
  }

  listLedger(userId: string): LedgerEntry[] {
    return this.ledger.filter((entry) => entry.userId === userId);
  }

  enqueueJob(type: string, payload: unknown): string {
    const id = crypto.randomUUID();
    this.jobs.push({
      id,
      type,
      payload,
      status: "queued",
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
    return id;
  }
}
