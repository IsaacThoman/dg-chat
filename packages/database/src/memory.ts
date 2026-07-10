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
  ApiIdempotencyEndpoint,
  ApiIdempotencyRequest,
  ApiReplayQuota,
  ApiUsageObservation,
  AuditEvent,
  AuditEventInput,
  BeginApiRequestInput,
  BeginApiRequestResult,
  BeginGenerationInput,
  BeginGenerationResult,
  CompleteApiRequestInput,
  CompleteGenerationInput,
  CreateUserInput,
  FailApiRequestInput,
  FailGenerationInput,
  GenerationResult,
  IdentityTokenPurpose,
  SessionSummary,
} from "./repository.ts";

export interface StoredUser extends PublicUser {
  passwordHash: string;
}
export interface StoredSession {
  id: string;
  tokenHash: string;
  userId: string;
  limited: boolean;
  expiresAt: number;
  createdAt: string;
  invalidatedAt: string | null;
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
  generationLeaseToken: string | null;
  generationLeaseExpiresAt: string | null;
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
  readonly identityTokens = new Map<string, {
    userId: string;
    purpose: IdentityTokenPurpose;
    expiresAt: string;
    consumedAt: string | null;
  }>();
  readonly auditEvents: AuditEvent[] = [];
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, MessageNode>();
  readonly idempotency = new Map<string, string>();
  readonly ledger: LedgerEntry[] = [];
  readonly usageRuns = new Map<string, UsageRun>();
  readonly apiIdempotencyRequests = new Map<string, ApiIdempotencyRequest>();
  readonly apiIdempotencyKeys = new Map<string, string>();
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
    const user = this.createUser({
      ...input,
      role: "admin",
      approvalStatus: "approved",
      emailVerified: true,
    });
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
      emailVerified?: boolean;
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
      emailVerifiedAt: input.emailVerified || input.approvalStatus === "approved"
        ? new Date().toISOString()
        : null,
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
    const now = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      tokenHash,
      userId,
      limited,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      createdAt: now,
      invalidatedAt: null,
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
  listSessions(userId: string): SessionSummary[] {
    return [...this.sessions.values()].filter((session) => session.userId === userId).map((
      session,
    ) => ({
      id: session.id,
      userId: session.userId,
      limited: session.limited,
      expiresAt: new Date(session.expiresAt).toISOString(),
      createdAt: session.createdAt,
      invalidatedAt: session.invalidatedAt,
    }));
  }
  revokeSession(id: string, ownerId?: string) {
    const entry = [...this.sessions.entries()].find(([, session]) =>
      session.id === id && (!ownerId || session.userId === ownerId)
    );
    if (!entry) throw new DomainError("not_found", "Session not found", 404);
    this.sessions.delete(entry[0]);
  }
  createIdentityToken(
    userId: string,
    purpose: IdentityTokenPurpose,
    tokenHash: string,
    expiresAt: string,
  ) {
    this.identityTokens.set(tokenHash, { userId, purpose, expiresAt, consumedAt: null });
  }
  verifyEmail(tokenHash: string) {
    const token = this.identityTokens.get(tokenHash);
    if (
      !token || token.purpose !== "email_verification" || token.consumedAt ||
      Date.parse(token.expiresAt) <= Date.now()
    ) {
      throw new DomainError(
        "invalid_identity_token",
        "Verification token is invalid or expired",
        400,
      );
    }
    token.consumedAt = new Date().toISOString();
    const user = this.users.get(token.userId)!;
    user.emailVerifiedAt = new Date().toISOString();
    return user;
  }
  resetPassword(tokenHash: string, passwordHash: string) {
    const token = this.identityTokens.get(tokenHash);
    if (
      !token || token.purpose !== "password_reset" || token.consumedAt ||
      Date.parse(token.expiresAt) <= Date.now()
    ) throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
    token.consumedAt = new Date().toISOString();
    const user = this.users.get(token.userId)!;
    user.passwordHash = passwordHash;
    this.invalidateUserSessions(user.id);
    for (const apiToken of this.tokens.values()) {
      if (apiToken.userId === user.id && !apiToken.revokedAt) {
        apiToken.revokedAt = new Date().toISOString();
      }
    }
    const consumedAt = new Date().toISOString();
    for (const identityToken of this.identityTokens.values()) {
      if (identityToken.userId === user.id && !identityToken.consumedAt) {
        identityToken.consumedAt = consumedAt;
      }
    }
    return user;
  }
  recordAudit(input: AuditEventInput): AuditEvent {
    const event = {
      ...input,
      id: crypto.randomUUID(),
      actorId: input.actorId ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    this.auditEvents.push(event);
    return event;
  }
  listAudit(limit = 100) {
    return [...this.auditEvents].reverse().slice(0, limit);
  }

  approveUser(
    id: string,
    status: "approved" | "rejected",
    creditMicros: number,
    requireEmailVerification = false,
  ): StoredUser {
    const user = this.users.get(id);
    if (!user) throw new DomainError("not_found", "User not found", 404);
    if (status === "approved" && requireEmailVerification && !user.emailVerifiedAt) {
      throw new DomainError("email_not_verified", "Email must be verified before approval", 409);
    }
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
    if (conversation.deletedAt) {
      throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
    }
    if (conversation.archivedAt) {
      throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
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

  beginGeneration(input: BeginGenerationInput): BeginGenerationResult {
    const conversation = this.conversations.get(input.message.conversationId);
    if (!conversation || conversation.ownerId !== input.message.ownerId) {
      throw new DomainError("not_found", "Conversation not found", 404);
    }
    if (conversation.deletedAt) {
      throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
    }
    if (conversation.archivedAt) {
      throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
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
      if (existingRun.status === "completed") {
        return { kind: "completed", message: existing, conversation, usageRun: existingRun };
      }
      if (
        existingRun.generationLeaseToken && existingRun.generationLeaseExpiresAt &&
        Date.parse(existingRun.generationLeaseExpiresAt) > Date.now()
      ) {
        return {
          kind: "in_progress",
          message: existing,
          conversation,
          usageRun: existingRun,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((Date.parse(existingRun.generationLeaseExpiresAt) - Date.now()) / 1000),
          ),
        };
      }
      const leaseToken = crypto.randomUUID();
      existingRun.generationLeaseToken = leaseToken;
      existingRun.generationLeaseExpiresAt = new Date(
        Date.now() + (input.leaseSeconds ?? 120) * 1000,
      ).toISOString();
      return {
        kind: "claimed",
        leaseToken,
        message: existing,
        conversation,
        usageRun: existingRun,
      };
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
    const leaseToken = crypto.randomUUID();
    usageRun.generationLeaseToken = leaseToken;
    usageRun.generationLeaseExpiresAt = new Date(
      Date.now() + (input.leaseSeconds ?? 120) * 1000,
    ).toISOString();
    return { kind: "started", leaseToken, message, conversation, usageRun };
  }

  heartbeatGeneration(
    runId: string,
    ownerId: string,
    leaseToken: string,
    leaseSeconds = 120,
  ) {
    const run = this.usageRuns.get(runId);
    if (
      !run || run.userId !== ownerId || run.status !== "reserved" ||
      run.generationLeaseToken !== leaseToken || !run.generationLeaseExpiresAt ||
      Date.parse(run.generationLeaseExpiresAt) <= Date.now()
    ) throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
    run.generationLeaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
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
    if (
      usageRun.generationLeaseToken !== input.leaseToken ||
      !usageRun.generationLeaseExpiresAt ||
      Date.parse(usageRun.generationLeaseExpiresAt) <= Date.now()
    ) throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
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
    settled.generationLeaseToken = null;
    settled.generationLeaseExpiresAt = null;
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
    const reserved = this.usageRuns.get(input.runId);
    if (
      !reserved || reserved.status !== "reserved" ||
      reserved.generationLeaseToken !== input.leaseToken ||
      !reserved.generationLeaseExpiresAt ||
      Date.parse(reserved.generationLeaseExpiresAt) <= Date.now()
    ) throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
    const previousActive = conversation.activeLeafId;
    const usageRun = this.refund(input.runId)!;
    usageRun.generationLeaseToken = null;
    usageRun.generationLeaseExpiresAt = null;
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

  reapStaleGenerations(limit = 100) {
    let reaped = 0;
    for (const run of this.usageRuns.values()) {
      if (reaped >= limit) break;
      if (
        run.status !== "reserved" || !run.generationLeaseToken ||
        !run.generationLeaseExpiresAt || Date.parse(run.generationLeaseExpiresAt) > Date.now()
      ) continue;
      const refunded = this.refund(run.id);
      if (refunded) {
        refunded.generationLeaseToken = null;
        refunded.generationLeaseExpiresAt = null;
        reaped++;
      }
    }
    return reaped;
  }

  setActiveLeaf(conversationId: string, ownerId: string, leafId: string, expectedVersion: number) {
    const conversation = this.conversations.get(conversationId);
    const leaf = this.messages.get(leafId);
    if (
      !conversation || conversation.ownerId !== ownerId || !leaf ||
      leaf.conversationId !== conversationId
    ) throw new DomainError("not_found", "Conversation or branch not found", 404);
    if (conversation.deletedAt) {
      throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
    }
    if (conversation.archivedAt) {
      throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
    }
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
      generationLeaseToken: null,
      generationLeaseExpiresAt: null,
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

  #apiKey(userId: string, endpoint: ApiIdempotencyEndpoint, key: string) {
    return `${userId}:${endpoint}:${key}`;
  }
  #apiRequest(id: string) {
    const request = this.apiIdempotencyRequests.get(id);
    if (!request) throw new DomainError("not_found", "Idempotent request not found", 404);
    return request;
  }
  #replayQuota(quota?: ApiReplayQuota): ApiReplayQuota {
    const value = quota ?? { maxRequests: 256, maxBytes: 67_108_864, maxEvents: 20_000 };
    if (
      !Number.isSafeInteger(value.maxRequests) || value.maxRequests < 1 ||
      !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 ||
      !Number.isSafeInteger(value.maxEvents) || value.maxEvents < 1
    ) throw new DomainError("validation_error", "Invalid replay quota", 422);
    return value;
  }
  #replayTotals(userId: string) {
    const encoder = new TextEncoder();
    let requests = 0;
    let events = 0;
    let bytes = 0;
    for (const request of this.apiIdempotencyRequests.values()) {
      if (request.userId !== userId || Date.parse(request.expiresAt) <= Date.now()) continue;
      requests++;
      events += request.frames.length;
      bytes += request.frames.reduce((sum, item) => sum + encoder.encode(item.frame).length, 0);
      if (request.responseBody) bytes += encoder.encode(request.responseBody).length;
    }
    return { requests, events, bytes };
  }
  #assertLease(request: ApiIdempotencyRequest, leaseToken: string) {
    if (
      request.state !== "in_progress" || request.leaseToken !== leaseToken ||
      !request.leaseExpiresAt || Date.parse(request.leaseExpiresAt) <= Date.now()
    ) {
      throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
    }
  }
  beginApiRequest(input: BeginApiRequestInput): BeginApiRequestResult {
    if (
      input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 ||
      !/^[0-9a-f]{64}$/.test(input.requestHash) || input.reserveMicros < 0 ||
      (input.leaseSeconds ?? 120) < 1 ||
      (input.retentionSeconds ?? 86400) < 60 || (input.retentionSeconds ?? 86400) > 2_592_000
    ) throw new DomainError("validation_error", "Invalid idempotent request parameters", 422);
    const key = this.#apiKey(input.userId, input.endpoint, input.idempotencyKey);
    let priorId = this.apiIdempotencyKeys.get(key);
    if (priorId) {
      const prior = this.#apiRequest(priorId);
      if (prior.state !== "in_progress" && Date.parse(prior.expiresAt) <= Date.now()) {
        this.apiIdempotencyRequests.delete(prior.id);
        this.apiIdempotencyKeys.delete(key);
        priorId = undefined;
      }
    }
    if (priorId) {
      const prior = this.#apiRequest(priorId);
      if (prior.requestHash !== input.requestHash || prior.stream !== input.stream) {
        throw new DomainError("idempotency_conflict", "Idempotency key payload differs", 409);
      }
      if (prior.state === "completed" || prior.state === "failed") {
        return { kind: prior.state, request: structuredClone(prior) };
      }
      return {
        kind: "in_progress",
        request: structuredClone(prior),
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((Date.parse(prior.leaseExpiresAt!) - Date.now()) / 1000),
        ),
      };
    }
    const quota = this.#replayQuota(input.quota);
    if (this.#replayTotals(input.userId).requests >= quota.maxRequests) {
      throw new DomainError("replay_quota_exceeded", "Replay request quota exceeded", 429);
    }
    const usageRun = this.reserve(
      input.userId,
      input.runId,
      input.model,
      input.reserveMicros,
    );
    const now = new Date();
    const leaseToken = crypto.randomUUID();
    const request: ApiIdempotencyRequest = {
      id: crypto.randomUUID(),
      userId: input.userId,
      endpoint: input.endpoint,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      stream: input.stream,
      model: input.model,
      state: "in_progress",
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + (input.leaseSeconds ?? 120) * 1000).toISOString(),
      usageRunId: input.runId,
      responseStatus: null,
      responseHeaders: {},
      responseBody: null,
      failureStartedStream: false,
      observedInputTokens: 0,
      observedOutputTokens: 0,
      observedCostMicros: 0,
      observedLatencyMs: 0,
      retentionSeconds: input.retentionSeconds ?? 86400,
      frames: [],
      createdAt: now.toISOString(),
      completedAt: null,
      expiresAt: new Date(now.getTime() + (input.retentionSeconds ?? 86400) * 1000).toISOString(),
    };
    this.apiIdempotencyRequests.set(request.id, request);
    this.apiIdempotencyKeys.set(key, request.id);
    return { kind: "started", request: structuredClone(request), leaseToken, usageRun };
  }
  getApiRequest(userId: string, endpoint: ApiIdempotencyEndpoint, idempotencyKey: string) {
    const id = this.apiIdempotencyKeys.get(this.#apiKey(userId, endpoint, idempotencyKey));
    return id ? structuredClone(this.#apiRequest(id)) : undefined;
  }
  appendApiSseFrame(
    id: string,
    leaseToken: string,
    sequence: number,
    frame: string,
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
    quota?: ApiReplayQuota,
  ) {
    return this.appendApiSseFrames(
      id,
      leaseToken,
      [{ sequence, frame }],
      leaseSeconds,
      observation,
      quota,
    );
  }
  appendApiSseFrames(
    id: string,
    leaseToken: string,
    frames: Array<{ sequence: number; frame: string }>,
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
    quotaInput?: ApiReplayQuota,
  ) {
    const request = this.#apiRequest(id);
    this.#assertLease(request, leaseToken);
    if (frames.length === 0) return structuredClone(request);
    const encoder = new TextEncoder();
    const encodedBytes = frames.map(({ frame }) => encoder.encode(frame).length);
    if (encodedBytes.some((bytes) => bytes > 1_048_576)) {
      throw new DomainError("response_too_large", "SSE frame exceeds replay limit", 413);
    }
    const total = request.frames.reduce(
      (sum, item) => sum + encoder.encode(item.frame).length,
      0,
    );
    const pending: Array<{ sequence: number; frame: string; createdAt: string }> = [];
    for (const item of frames) {
      const existing = request.frames[item.sequence];
      if (existing) {
        if (existing.frame !== item.frame) {
          throw new DomainError("sequence_conflict", "SSE frame sequence payload differs", 409);
        }
        continue;
      }
      if (item.sequence !== request.frames.length + pending.length) {
        throw new DomainError("sequence_conflict", "SSE replay sequence is not contiguous", 409);
      }
      pending.push({ ...item, createdAt: new Date().toISOString() });
    }
    const pendingBytes = pending.reduce(
      (sum, item) => sum + encoder.encode(item.frame).length,
      0,
    );
    if (request.frames.length + pending.length > 10_000 || total + pendingBytes > 16_777_216) {
      throw new DomainError("response_too_large", "SSE replay exceeds storage limit", 413);
    }
    const quota = this.#replayQuota(quotaInput);
    const aggregate = this.#replayTotals(request.userId);
    if (
      aggregate.events + pending.length > quota.maxEvents ||
      aggregate.bytes + pendingBytes > quota.maxBytes
    ) throw new DomainError("replay_quota_exceeded", "User replay storage quota exceeded", 429);
    request.frames.push(...pending);
    if (observation) {
      request.observedInputTokens = Math.max(request.observedInputTokens, observation.inputTokens);
      request.observedOutputTokens = Math.max(
        request.observedOutputTokens,
        observation.outputTokens,
      );
      request.observedCostMicros = Math.max(request.observedCostMicros, observation.costMicros);
      request.observedLatencyMs = Math.max(request.observedLatencyMs, observation.latencyMs);
    }
    request.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return structuredClone(request);
  }
  heartbeatApiRequest(
    id: string,
    leaseToken: string,
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
  ) {
    const request = this.#apiRequest(id);
    this.#assertLease(request, leaseToken);
    if (observation) {
      request.observedInputTokens = Math.max(request.observedInputTokens, observation.inputTokens);
      request.observedOutputTokens = Math.max(
        request.observedOutputTokens,
        observation.outputTokens,
      );
      request.observedCostMicros = Math.max(request.observedCostMicros, observation.costMicros);
      request.observedLatencyMs = Math.max(request.observedLatencyMs, observation.latencyMs);
    }
    request.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  }
  #completeApi(input: CompleteApiRequestInput, stream: boolean) {
    const request = this.#apiRequest(input.id);
    if (request.state === "completed") return structuredClone(request);
    this.#assertLease(request, input.leaseToken);
    const encoder = new TextEncoder();
    const quota = this.#replayQuota(input.quota);
    const aggregate = this.#replayTotals(request.userId);
    if (!stream && input.frames?.length) {
      throw new DomainError("validation_error", "JSON completion cannot include SSE frames", 422);
    }
    const pending: Array<{ sequence: number; frame: string; createdAt: string }> = [];
    for (const item of input.frames ?? []) {
      const bytes = encoder.encode(item.frame).length;
      if (bytes > 1_048_576) {
        throw new DomainError("response_too_large", "SSE frame exceeds replay limit", 413);
      }
      const existing = request.frames[item.sequence];
      if (existing) {
        if (existing.frame !== item.frame) {
          throw new DomainError("sequence_conflict", "SSE frame sequence payload differs", 409);
        }
        continue;
      }
      if (item.sequence !== request.frames.length + pending.length) {
        throw new DomainError("sequence_conflict", "SSE replay sequence is not contiguous", 409);
      }
      pending.push({ ...item, createdAt: new Date().toISOString() });
    }
    const pendingBytes = pending.reduce(
      (sum, item) => sum + encoder.encode(item.frame).length,
      0,
    );
    const responseBytes = input.responseBody ? encoder.encode(input.responseBody).length : 0;
    const terminalBytes = input.terminalFrame ? encoder.encode(input.terminalFrame).length : 0;
    const existingBytes = request.frames.reduce(
      (sum, item) => sum + encoder.encode(item.frame).length,
      0,
    );
    if (terminalBytes > 1_048_576) {
      throw new DomainError("response_too_large", "Terminal SSE frame exceeds replay limit", 413);
    }
    if (
      request.frames.length + pending.length + (input.terminalFrame ? 1 : 0) > 10_000 ||
      existingBytes + pendingBytes + terminalBytes > 16_777_216
    ) throw new DomainError("response_too_large", "SSE replay exceeds storage limit", 413);
    if (
      aggregate.events + pending.length + (input.terminalFrame ? 1 : 0) > quota.maxEvents ||
      aggregate.bytes + responseBytes + pendingBytes + terminalBytes > quota.maxBytes
    ) throw new DomainError("replay_quota_exceeded", "User replay storage quota exceeded", 429);
    const run = this.usageRuns.get(request.usageRunId);
    if (!run || run.status !== "reserved") {
      throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
    }
    if (this.users.get(request.userId)!.balanceMicros + run.reservedMicros - input.costMicros < 0) {
      throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
    }
    this.settle(
      request.usageRunId,
      input.costMicros,
      input.inputTokens,
      input.outputTokens,
      input.latencyMs,
    );
    request.frames.push(...pending);
    if (stream && input.terminalFrame !== undefined) {
      request.frames.push({
        sequence: request.frames.length,
        frame: input.terminalFrame,
        createdAt: new Date().toISOString(),
      });
    }
    request.state = "completed";
    request.leaseToken = null;
    request.leaseExpiresAt = null;
    request.responseStatus = input.responseStatus;
    request.responseHeaders = input.responseHeaders ?? {};
    request.responseBody = input.responseBody ?? null;
    request.completedAt = new Date().toISOString();
    request.expiresAt = new Date(Date.now() + request.retentionSeconds * 1000).toISOString();
    return structuredClone(request);
  }
  completeApiJson(input: CompleteApiRequestInput) {
    return this.#completeApi(input, false);
  }
  completeApiStream(input: CompleteApiRequestInput) {
    return this.#completeApi(input, true);
  }
  failApiRequest(input: FailApiRequestInput) {
    const request = this.#apiRequest(input.id);
    if (request.state === "failed") return structuredClone(request);
    this.#assertLease(request, input.leaseToken);
    if (input.billing.mode === "settle") {
      const run = this.usageRuns.get(request.usageRunId);
      if (!run || run.status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      if (
        this.users.get(request.userId)!.balanceMicros + run.reservedMicros -
            input.billing.costMicros < 0
      ) throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
    }
    const failureStartedStream = request.frames.length > 0 || input.terminalFrame !== undefined;
    if (input.terminalFrame !== undefined) {
      this.appendApiSseFrame(
        request.id,
        input.leaseToken,
        request.frames.length,
        input.terminalFrame,
      );
    }
    if (input.billing.mode === "refund") this.refund(request.usageRunId);
    else {
      this.settle(
        request.usageRunId,
        input.billing.costMicros,
        input.billing.inputTokens,
        input.billing.outputTokens,
        input.billing.latencyMs,
      );
    }
    request.state = "failed";
    request.failureStartedStream = failureStartedStream;
    request.leaseToken = null;
    request.leaseExpiresAt = null;
    request.responseStatus = input.responseStatus;
    request.responseHeaders = input.responseHeaders ?? {};
    request.responseBody = input.responseBody;
    request.completedAt = new Date().toISOString();
    request.expiresAt = new Date(Date.now() + request.retentionSeconds * 1000).toISOString();
    return structuredClone(request);
  }
  reapStaleApiRequests(limit = 100) {
    let count = 0;
    for (const request of this.apiIdempotencyRequests.values()) {
      if (count >= limit) break;
      if (
        request.state !== "in_progress" || !request.leaseExpiresAt ||
        Date.parse(request.leaseExpiresAt) > Date.now()
      ) continue;
      if (request.observedCostMicros > 0) {
        this.settle(
          request.usageRunId,
          request.observedCostMicros,
          request.observedInputTokens,
          request.observedOutputTokens,
          request.observedLatencyMs,
        );
      } else this.refund(request.usageRunId);
      request.state = "failed";
      request.responseStatus = 500;
      request.responseBody = JSON.stringify({
        error: {
          message: "Request interrupted before completion",
          type: "server_error",
          code: "request_abandoned",
        },
      });
      request.failureStartedStream = request.frames.length > 0;
      if (request.failureStartedStream) {
        const frame = request.endpoint === "responses"
          ? `event: error\ndata: ${request.responseBody}\n\n`
          : `data: ${request.responseBody}\n\n`;
        request.frames.push({
          sequence: request.frames.length,
          frame,
          createdAt: new Date().toISOString(),
        });
      }
      request.leaseToken = null;
      request.leaseExpiresAt = null;
      request.completedAt = new Date().toISOString();
      request.expiresAt = new Date(Date.now() + request.retentionSeconds * 1000).toISOString();
      count++;
    }
    return count;
  }
  pruneExpiredApiRequests(limit = 100) {
    let count = 0;
    for (const [id, request] of this.apiIdempotencyRequests) {
      if (count >= limit) break;
      if (request.state === "in_progress" || Date.parse(request.expiresAt) > Date.now()) continue;
      this.apiIdempotencyRequests.delete(id);
      this.apiIdempotencyKeys.delete(
        this.#apiKey(request.userId, request.endpoint, request.idempotencyKey),
      );
      count++;
    }
    return count;
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
