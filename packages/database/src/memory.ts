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
  AttachmentRecord,
  AttachmentState,
  AuditEvent,
  AuditEventInput,
  AuditPage,
  AuditQuery,
  BeginApiRequestInput,
  BeginApiRequestResult,
  BeginGenerationInput,
  BeginGenerationResult,
  CompleteApiRequestInput,
  CompleteGenerationInput,
  CreateAttachmentInput,
  CreateAttachmentResult,
  CreateModelPriceVersionInput,
  CreateProviderInput,
  CreateProviderModelInput,
  CreateProviderRetryPolicyInput,
  CreateUserInput,
  DocumentChunk,
  DocumentChunkInput,
  FailApiRequestInput,
  FailGenerationInput,
  FinalizeProviderUsageInput,
  FinishProviderAttemptInput,
  GenerationResult,
  IdentityTokenPurpose,
  ModelPriceVersion,
  ProviderAttempt,
  ProviderCredentialEnvelope,
  ProviderCredentialMutation,
  ProviderExecutionClaim,
  ProviderExecutionPlan,
  ProviderModelRecord,
  ProviderModelRoute,
  ProviderRecord,
  ProviderRetryPolicy,
  RegistryMutationContext,
  SessionSummary,
  SetProviderModelRouteInput,
  StartProviderAttemptInput,
  StoredProviderCredential,
  UpdateProviderInput,
  UpdateProviderModelInput,
  UpdateProviderRetryPolicyInput,
  UsagePricingSnapshot,
} from "./repository.ts";
import { decodeAuditCursor, encodeAuditCursor, isUsagePricingSnapshot } from "./repository.ts";

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
  executionEpoch: number;
  executionOwnerLeaseToken: string | null;
  runLeaseToken: string | null;
  runLeaseExpiresAt: string | null;
  actualProviderCostMicros: number;
  actualProviderInputTokens: number;
  actualProviderCachedInputTokens: number;
  actualProviderReasoningTokens: number;
  actualProviderOutputTokens: number;
  pricingSnapshot: UsagePricingSnapshot | null;
  generationLeaseToken: string | null;
  generationLeaseExpiresAt: string | null;
  createdAt: string;
}

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const isIngestibleMime = (mime: string) => mime === "text/plain" || mime === "application/json";

function validateDocumentChunks(chunks: DocumentChunkInput[]) {
  const ids = new Set<string>();
  for (const [index, chunk] of chunks.entries()) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        chunk.id,
      ) || chunk.ordinal !== index || !chunk.content || chunk.content.length > 20_000 ||
      ids.has(chunk.id)
    ) throw new DomainError("invalid_document_chunks", "Document chunks are invalid", 422);
    ids.add(chunk.id);
  }
}

interface StoredProvider extends ProviderRecord {
  credentialEnvelope: ProviderCredentialEnvelope | null;
}

const registryConflict = () =>
  new DomainError("version_conflict", "The registry record changed; reload and try again", 409);

function normalizeProviderBaseUrl(value: string): string {
  if (value !== value.trim() || value.length > 2048) {
    throw new DomainError("validation_error", "Provider base URL is invalid", 422);
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.port === "0"
    ) {
      throw new Error();
    }
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    throw new DomainError("validation_error", "Provider base URL is invalid", 422);
  }
}

function validateProviderInput(input: Partial<CreateProviderInput & UpdateProviderInput>) {
  if (input.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
    throw new DomainError("validation_error", "Provider slug is invalid", 422);
  }
  if (
    input.displayName !== undefined &&
    (input.displayName.trim().length < 1 || input.displayName.trim().length > 120)
  ) throw new DomainError("validation_error", "Provider display name is invalid", 422);
  if (input.baseUrl !== undefined) normalizeProviderBaseUrl(input.baseUrl);
  if (input.protocol !== undefined && !["chat_completions", "responses"].includes(input.protocol)) {
    throw new DomainError("validation_error", "Provider protocol is invalid", 422);
  }
  if (
    input.healthStatus !== undefined &&
    !["unknown", "healthy", "unhealthy", "disabled"].includes(input.healthStatus)
  ) throw new DomainError("validation_error", "Provider health status is invalid", 422);
  if (
    input.healthLatencyMs !== undefined && input.healthLatencyMs !== null &&
    (!Number.isSafeInteger(input.healthLatencyMs) || input.healthLatencyMs < 0)
  ) throw new DomainError("validation_error", "Provider health latency is invalid", 422);
  if (
    input.healthError !== undefined && input.healthError !== null && input.healthError.length > 1000
  ) {
    throw new DomainError("validation_error", "Provider health error is too long", 422);
  }
  if (
    input.healthCheckedAt !== undefined && input.healthCheckedAt !== null &&
    !Number.isFinite(Date.parse(input.healthCheckedAt))
  ) throw new DomainError("validation_error", "Provider health timestamp is invalid", 422);
}

function validateProviderModelInput(
  input: Partial<CreateProviderModelInput & UpdateProviderModelInput>,
) {
  if (
    input.publicModelId !== undefined &&
    (input.publicModelId.length < 3 || input.publicModelId.length > 255 ||
      input.publicModelId.indexOf("/") < 1)
  ) throw new DomainError("validation_error", "Public model ID must be namespaced", 422);
  for (
    const [value, maximum] of [[input.upstreamModelId, 255], [input.displayName, 120]] as const
  ) {
    if (value !== undefined && (value.trim().length < 1 || value.length > maximum)) {
      throw new DomainError("validation_error", "Provider model text is invalid", 422);
    }
  }
  if (
    input.contextWindow !== undefined &&
    (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 1)
  ) throw new DomainError("validation_error", "Model context window is invalid", 422);
  if (
    input.capabilities !== undefined &&
    (input.capabilities.length > 64 ||
      new Set(input.capabilities).size !== input.capabilities.length ||
      input.capabilities.some((value) => !value || value.length > 64))
  ) throw new DomainError("validation_error", "Model capabilities are invalid", 422);
  if (
    input.customParams !== undefined &&
    (input.customParams === null || Array.isArray(input.customParams))
  ) throw new DomainError("validation_error", "Model custom parameters are invalid", 422);
}

function validatePriceInput(input: CreateModelPriceVersionInput) {
  if (!Number.isFinite(Date.parse(input.effectiveAt))) {
    throw new DomainError("validation_error", "Price effective timestamp is invalid", 422);
  }
  for (
    const value of [
      input.inputMicrosPerMillion,
      input.cachedInputMicrosPerMillion,
      input.reasoningMicrosPerMillion,
      input.outputMicrosPerMillion,
      input.fixedCallMicros,
    ]
  ) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DomainError("validation_error", "Price amounts must be non-negative integers", 422);
    }
  }
  if (!input.source.trim() || input.source.length > 120) {
    throw new DomainError("validation_error", "Price source is invalid", 422);
  }
}

function validateRetryPolicy(input: CreateProviderRetryPolicyInput) {
  const integer = (value: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  if (
    !input.name.trim() || input.name.length > 120 ||
    !integer(input.maxAttempts, 1, 8) ||
    !integer(input.maxRetries, 0, 3) || input.maxRetries >= input.maxAttempts ||
    !integer(input.baseDelayMs, 0, 60_000) ||
    !integer(input.maxDelayMs, input.baseDelayMs, 300_000) ||
    !integer(input.backoffMultiplierBps, 10_000, 40_000) ||
    !integer(input.jitterBps, 0, 10_000) ||
    !integer(input.firstTokenTimeoutMs, 250, 300_000) ||
    !integer(input.idleTimeoutMs, 250, 300_000) ||
    !integer(
      input.totalTimeoutMs,
      Math.max(input.firstTokenTimeoutMs, input.idleTimeoutMs),
      900_000,
    ) ||
    input.retryableStatuses.length > 32 ||
    new Set(input.retryableStatuses).size !== input.retryableStatuses.length ||
    input.retryableStatuses.some((status) => ![408, 425, 429, 500, 502, 503, 504].includes(status))
  ) {
    throw new DomainError("validation_error", "Provider retry policy is invalid", 422);
  }
}

function validateAttemptFinish(input: FinishProviderAttemptInput) {
  const count = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
  if (
    ![input.inputTokens, input.cachedInputTokens, input.reasoningTokens, input.outputTokens].every(
      count,
    ) ||
    input.cachedInputTokens > input.inputTokens || input.reasoningTokens > input.outputTokens ||
    !Number.isSafeInteger(input.costMicros) || input.costMicros < 0 ||
    !Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 ||
    (input.ttftMs != null &&
      (!Number.isSafeInteger(input.ttftMs) || input.ttftMs < 0 ||
        input.ttftMs > input.latencyMs)) ||
    (input.httpStatus != null &&
      (!Number.isSafeInteger(input.httpStatus) || input.httpStatus < 100 ||
        input.httpStatus > 599)) ||
    (input.errorCode != null && !/^[a-z0-9][a-z0-9_.-]{0,119}$/.test(input.errorCode)) ||
    !["succeeded", "failed", "cancelled", "skipped"].includes(input.status) ||
    !["planning", "connect", "headers", "first_token", "streaming", "complete"].includes(
      input.phase,
    ) ||
    !["provider", "estimated", "none"].includes(input.tokenSource) ||
    !["provider", "calculated", "none"].includes(input.costSource) ||
    (input.status === "succeeded" &&
      (input.phase !== "complete" || input.errorCode != null ||
        (input.httpStatus != null && (input.httpStatus < 200 || input.httpStatus > 299)))) ||
    (["failed", "cancelled", "skipped"].includes(input.status) && input.errorCode == null) ||
    (input.status === "skipped" &&
      (input.visibleOutput || input.inputTokens + input.outputTokens + input.costMicros !== 0 ||
        input.tokenSource !== "none" || input.costSource !== "none")) ||
    (input.breakerAfter != null &&
      !["closed", "open", "half_open", "unavailable"].includes(input.breakerAfter)) ||
    (input.upstreamRequestId != null &&
      !/^[A-Za-z0-9._:-]{1,255}$/.test(input.upstreamRequestId)) ||
    (input.tokensPerSecond != null &&
      (!Number.isFinite(input.tokensPerSecond) || input.tokensPerSecond < 0 ||
        input.tokensPerSecond > 1_000_000))
  ) {
    throw new DomainError("validation_error", "Provider attempt telemetry is invalid", 422);
  }
}

function validateCredentialEnvelope(envelope: ProviderCredentialEnvelope) {
  const strings = [
    envelope.wrappedKeyNonce,
    envelope.wrappedKey,
    envelope.contentNonce,
    envelope.ciphertext,
  ];
  if (
    envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(envelope.keyId) ||
    !Number.isSafeInteger(envelope.credentialVersion) || envelope.credentialVersion < 1 ||
    strings.some((value) =>
      typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 65_536
    )
  ) throw new DomainError("validation_error", "Provider credential envelope is invalid", 422);
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
  readonly attachments = new Map<string, AttachmentRecord>();
  readonly messageAttachments = new Map<string, Set<string>>();
  readonly documentChunks = new Map<string, DocumentChunk[]>();
  readonly providers = new Map<string, StoredProvider>();
  readonly providerModels = new Map<string, ProviderModelRecord>();
  readonly modelPriceVersions = new Map<string, ModelPriceVersion[]>();
  readonly providerRetryPolicies = new Map<string, ProviderRetryPolicy>();
  readonly providerModelRoutes = new Map<string, ProviderModelRoute>();
  readonly providerAttempts = new Map<string, ProviderAttempt>();
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
      idempotencyKey?: string;
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
  listAudit(query: AuditQuery = {}): AuditPage {
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new DomainError("validation_error", "Audit limit must be between 1 and 200", 422);
    }
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : undefined;
    if (query.cursor && (!cursor || cursor.kind !== "timestamp")) {
      throw new DomainError("validation_error", "Invalid audit cursor", 422);
    }
    const timestampCursor = cursor?.kind === "timestamp" ? cursor : undefined;
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    if ((query.from && !Number.isFinite(from)) || (query.to && !Number.isFinite(to))) {
      throw new DomainError("validation_error", "Invalid audit date range", 422);
    }
    if (from !== undefined && to !== undefined && from > to) {
      throw new DomainError("validation_error", "Audit date range is reversed", 422);
    }
    const matches = this.auditEvents
      .filter((event) =>
        (!query.action || event.action === query.action) &&
        (!query.actorId || event.actorId === query.actorId) &&
        (!query.targetType || event.targetType === query.targetType) &&
        (!query.targetId || event.targetId === query.targetId) &&
        (from === undefined || Date.parse(event.createdAt) >= from) &&
        (to === undefined || Date.parse(event.createdAt) <= to) &&
        (!timestampCursor || event.createdAt < timestampCursor.createdAt ||
          (event.createdAt === timestampCursor.createdAt && event.id < timestampCursor.id))
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const data = matches.slice(0, limit);
    return {
      data,
      nextCursor: matches.length > limit ? encodeAuditCursor(data[data.length - 1]) : null,
    };
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
    if (input.pricingSnapshot !== undefined && !isUsagePricingSnapshot(input.pricingSnapshot)) {
      throw new DomainError("validation_error", "Usage pricing snapshot is invalid", 422);
    }
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
    const attachmentIds = [...(input.attachmentIds ?? [])].sort();
    if (new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.length > 10) {
      throw new DomainError("validation_error", "Attachment identifiers are invalid", 422);
    }
    const existingId = this.idempotency.get(
      `${input.message.conversationId}:${input.message.idempotencyKey}`,
    );
    const existingRun = this.usageRuns.get(input.runId);
    if (existingId && existingRun) {
      const existing = this.messages.get(existingId)!;
      const priorAttachments = [...(this.messageAttachments.get(existing.id) ?? [])].sort();
      if (
        existing.content !== input.message.content ||
        existingRun.userId !== input.message.ownerId ||
        priorAttachments.join("\0") !== [...attachmentIds].sort().join("\0")
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
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId, input.message.ownerId);
      if (attachment.state !== "ready") {
        throw new DomainError("attachment_not_ready", "Attachment is not ready", 409);
      }
    }
    const message = this.appendMessage(input.message);
    const usageRun = this.reserve(
      input.message.ownerId,
      input.runId,
      input.message.model ?? "unknown",
      input.reserveMicros,
      input.provider,
      input.tokenId,
      input.pricingSnapshot,
    );
    const leaseToken = crypto.randomUUID();
    usageRun.runLeaseToken = null;
    usageRun.runLeaseExpiresAt = null;
    usageRun.generationLeaseToken = leaseToken;
    usageRun.generationLeaseExpiresAt = new Date(
      Date.now() + (input.leaseSeconds ?? 120) * 1000,
    ).toISOString();
    if (attachmentIds.length) this.messageAttachments.set(message.id, new Set(attachmentIds));
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
    const effectiveCost = usageRun.executionEpoch > 0
      ? usageRun.actualProviderCostMicros
      : input.costMicros;
    const balanceAfterSettlement = this.users.get(input.ownerId)!.balanceMicros +
      usageRun.reservedMicros - effectiveCost;
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
      for (const attempt of this.providerAttempts.values()) {
        if (attempt.usageRunId !== run.id || attempt.status !== "running") continue;
        attempt.status = "cancelled";
        attempt.phase = "planning";
        attempt.errorCode = "generation_lease_expired";
        attempt.breakerAfter = "unavailable";
        attempt.retryable = true;
        attempt.latencyMs = Math.max(0, Date.now() - Date.parse(attempt.startedAt));
        attempt.completedAt = new Date().toISOString();
      }
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

  createAttachment(input: CreateAttachmentInput): CreateAttachmentResult {
    this.validateAttachmentInput(input);
    if (!this.users.has(input.ownerId)) throw new DomainError("not_found", "User not found", 404);
    const prior = [...this.attachments.values()].find((attachment) =>
      attachment.ownerId === input.ownerId && attachment.sha256 === input.sha256 &&
      attachment.state !== "deleted"
    );
    if (prior) {
      if (prior.sizeBytes !== input.sizeBytes || prior.mimeType !== input.mimeType) {
        throw new DomainError(
          "attachment_hash_conflict",
          "Attachment digest metadata differs",
          409,
        );
      }
      return {
        attachment: prior,
        inspectionJobId: this.enqueueAttachmentInspection(prior),
        deduplicated: true,
      };
    }
    if (
      [...this.attachments.values()].some((attachment) => attachment.objectKey === input.objectKey)
    ) {
      throw new DomainError("object_key_taken", "Attachment object key already exists", 409);
    }
    const now = new Date().toISOString();
    const attachment: AttachmentRecord = {
      ...input,
      id: crypto.randomUUID(),
      state: input.state ?? "pending",
      inspectionError: input.inspectionError ?? null,
      ingestionStatus: input.state === "ready" && isIngestibleMime(input.mimeType)
        ? "queued"
        : "not_applicable",
      ingestionError: null,
      ingestedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.attachments.set(attachment.id, attachment);
    this.enqueueAttachmentIngestion(attachment);
    return {
      attachment,
      inspectionJobId: this.enqueueAttachmentInspection(attachment),
      deduplicated: false,
    };
  }

  listAttachments(ownerId: string, includeDeleted = false) {
    return [...this.attachments.values()].filter((attachment) =>
      attachment.ownerId === ownerId && (includeDeleted || attachment.state !== "deleted")
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getAttachment(id: string, ownerId: string, includeDeleted = false) {
    const attachment = this.attachments.get(id);
    if (
      !attachment || attachment.ownerId !== ownerId ||
      (!includeDeleted && attachment.state === "deleted")
    ) throw new DomainError("not_found", "Attachment not found", 404);
    return attachment;
  }

  deleteAttachment(id: string, ownerId: string) {
    const attachment = this.getAttachment(id, ownerId, true);
    if (attachment.state === "deleted") return attachment;
    const now = new Date().toISOString();
    attachment.state = "deleted";
    attachment.deletedAt = now;
    attachment.updatedAt = now;
    return attachment;
  }

  transitionAttachment(
    id: string,
    ownerId: string,
    expectedState: AttachmentState,
    nextState: AttachmentState,
    inspectionError: string | null = null,
  ) {
    const attachment = this.getAttachment(id, ownerId, true);
    if (attachment.state !== expectedState) {
      throw new DomainError("attachment_state_conflict", "Attachment state changed", 409);
    }
    const allowed: Record<AttachmentState, AttachmentState[]> = {
      pending: ["inspecting", "deleted"],
      inspecting: ["ready", "quarantined", "failed", "deleted"],
      ready: ["deleted"],
      quarantined: ["deleted"],
      failed: ["pending", "deleted"],
      deleted: [],
    };
    if (!allowed[expectedState].includes(nextState)) {
      throw new DomainError(
        "invalid_attachment_transition",
        "Attachment transition is invalid",
        422,
      );
    }
    attachment.state = nextState;
    attachment.inspectionError = inspectionError;
    attachment.updatedAt = new Date().toISOString();
    if (nextState === "deleted") attachment.deletedAt = attachment.updatedAt;
    if (nextState === "ready" && isIngestibleMime(attachment.mimeType)) {
      attachment.ingestionStatus = "queued";
      attachment.ingestionError = null;
      this.enqueueAttachmentIngestion(attachment);
    }
    return attachment;
  }

  linkAttachmentToMessage(messageId: string, attachmentId: string, ownerId: string) {
    const message = this.messages.get(messageId);
    const conversation = message ? this.conversations.get(message.conversationId) : undefined;
    if (!message || !conversation || conversation.ownerId !== ownerId) {
      throw new DomainError("not_found", "Message not found", 404);
    }
    const attachment = this.getAttachment(attachmentId, ownerId);
    if (attachment.state !== "ready") {
      throw new DomainError("attachment_not_ready", "Attachment is not ready", 409);
    }
    const links = this.messageAttachments.get(messageId) ?? new Set<string>();
    links.add(attachmentId);
    this.messageAttachments.set(messageId, links);
  }

  listMessageAttachments(messageId: string, ownerId: string) {
    const message = this.messages.get(messageId);
    const conversation = message ? this.conversations.get(message.conversationId) : undefined;
    if (!message || !conversation || conversation.ownerId !== ownerId) {
      throw new DomainError("not_found", "Message not found", 404);
    }
    return [...(this.messageAttachments.get(messageId) ?? [])].map((id) =>
      this.getAttachment(id, ownerId, true)
    );
  }

  beginAttachmentIngestion(id: string, ownerId: string) {
    const attachment = this.getAttachment(id, ownerId);
    if (!isIngestibleMime(attachment.mimeType) || attachment.state !== "ready") {
      throw new DomainError("attachment_not_ingestible", "Attachment cannot be ingested", 422);
    }
    if (!["queued", "processing"].includes(attachment.ingestionStatus)) {
      throw new DomainError("ingestion_state_conflict", "Attachment ingestion is not queued", 409);
    }
    attachment.ingestionStatus = "processing";
    attachment.ingestionError = null;
    attachment.updatedAt = new Date().toISOString();
    return attachment;
  }

  completeAttachmentIngestion(
    id: string,
    ownerId: string,
    chunks: DocumentChunkInput[],
  ) {
    const attachment = this.getAttachment(id, ownerId);
    if (attachment.ingestionStatus !== "processing") {
      throw new DomainError(
        "ingestion_state_conflict",
        "Attachment ingestion is not processing",
        409,
      );
    }
    validateDocumentChunks(chunks);
    const next = chunks.map((chunk) => ({ ...chunk, attachmentId: id }));
    this.documentChunks.set(id, next);
    const now = new Date().toISOString();
    attachment.ingestionStatus = "ready";
    attachment.ingestionError = null;
    attachment.ingestedAt = now;
    attachment.updatedAt = now;
    return attachment;
  }

  failAttachmentIngestion(id: string, ownerId: string, error: string) {
    const attachment = this.getAttachment(id, ownerId);
    if (!["queued", "processing"].includes(attachment.ingestionStatus)) {
      throw new DomainError("ingestion_state_conflict", "Attachment ingestion is not active", 409);
    }
    attachment.ingestionStatus = "failed";
    attachment.ingestionError = error.slice(0, 1000);
    attachment.updatedAt = new Date().toISOString();
    return attachment;
  }

  retryAttachmentIngestion(id: string, ownerId: string) {
    const attachment = this.getAttachment(id, ownerId);
    const key = `attachment.ingest:${attachment.id}`;
    const prior = this.jobs.find((job) => job.idempotencyKey === key);
    const legacySplit = attachment.ingestionStatus === "queued" && prior?.status === "failed";
    if (attachment.ingestionStatus !== "failed" && !legacySplit) {
      throw new DomainError(
        "ingestion_state_conflict",
        "Only failed ingestion can be retried",
        409,
      );
    }
    attachment.ingestionStatus = "queued";
    attachment.ingestionError = null;
    attachment.ingestedAt = null;
    attachment.updatedAt = new Date().toISOString();
    if (prior) {
      prior.status = "queued";
      prior.attempts = 0;
    } else this.enqueueAttachmentIngestion(attachment);
    return attachment;
  }

  listDocumentChunks(id: string, ownerId: string) {
    this.getAttachment(id, ownerId);
    return [...(this.documentChunks.get(id) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  }

  private enqueueAttachmentInspection(attachment: AttachmentRecord) {
    const idempotencyKey = `attachment.inspect:${attachment.id}`;
    const prior = this.jobs.find((job) => job.idempotencyKey === idempotencyKey);
    if (prior) return prior.id;
    const id = crypto.randomUUID();
    this.jobs.push({
      id,
      type: "attachment.inspect",
      payload: { attachmentId: attachment.id, ownerId: attachment.ownerId },
      status: "queued",
      attempts: 0,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  private enqueueAttachmentIngestion(attachment: AttachmentRecord) {
    if (attachment.ingestionStatus !== "queued") return undefined;
    const idempotencyKey = `attachment.ingest:${attachment.id}`;
    const prior = this.jobs.find((job) => job.idempotencyKey === idempotencyKey);
    if (prior) return prior.id;
    const id = crypto.randomUUID();
    this.jobs.push({
      id,
      type: "attachment.ingest",
      payload: { attachmentId: attachment.id, ownerId: attachment.ownerId },
      status: "queued",
      attempts: 0,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  private validateAttachmentInput(input: CreateAttachmentInput) {
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new DomainError("validation_error", "Attachment SHA-256 is invalid", 422);
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new DomainError("validation_error", "Attachment size is invalid", 422);
    }
    if (
      !input.filename || input.filename.length > 255 || /[\\/\0]/.test(input.filename) ||
      !input.mimeType || input.mimeType.length > 255 ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ||
      !input.objectKey || input.objectKey.length > 1024 || input.objectKey.startsWith("/") ||
      input.objectKey.split("/").some((part) => part === ".." || part === "")
    ) throw new DomainError("validation_error", "Attachment metadata is invalid", 422);
  }

  private publicProvider(value: StoredProvider): ProviderRecord {
    const { credentialEnvelope: _credentialEnvelope, ...safe } = value;
    return structuredClone(safe);
  }

  private registryAudit(
    mutation: RegistryMutationContext,
    targetType:
      | "provider"
      | "provider_model"
      | "model_price_version"
      | "provider_retry_policy"
      | "provider_model_route",
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    this.recordAudit({
      actorId: mutation.actorId,
      action: mutation.action,
      targetType,
      targetId,
      metadata: { ...mutation.metadata, ...metadata },
    });
  }

  private validateRegistryMutation(mutation: RegistryMutationContext) {
    if (!mutation.action.trim() || mutation.action.length > 255) {
      throw new DomainError("validation_error", "Registry audit action is invalid", 422);
    }
    if (mutation.actorId && !this.users.has(mutation.actorId)) {
      throw new DomainError("not_found", "Registry actor not found", 404);
    }
  }

  createProvider(input: CreateProviderInput, mutation: RegistryMutationContext): ProviderRecord {
    this.validateRegistryMutation(mutation);
    validateProviderInput(input);
    if ([...this.providers.values()].some((provider) => provider.slug === input.slug)) {
      throw new DomainError("provider_slug_taken", "Provider slug already exists", 409);
    }
    const now = new Date().toISOString();
    const stored: StoredProvider = {
      id: crypto.randomUUID(),
      slug: input.slug,
      displayName: input.displayName.trim(),
      baseUrl: normalizeProviderBaseUrl(input.baseUrl),
      protocol: input.protocol,
      enabled: input.enabled ?? true,
      version: 1,
      credentialEnvelope: null,
      hasCredential: false,
      credentialUpdatedAt: null,
      healthStatus: input.enabled === false ? "disabled" : "unknown",
      healthCheckedAt: null,
      healthLatencyMs: null,
      healthError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.providers.set(stored.id, stored);
    this.registryAudit(mutation, "provider", stored.id, { version: stored.version });
    return this.publicProvider(stored);
  }

  updateProvider(
    id: string,
    expectedVersion: number,
    input: UpdateProviderInput,
    mutation: RegistryMutationContext,
  ): ProviderRecord {
    this.validateRegistryMutation(mutation);
    validateProviderInput(input);
    const stored = this.providers.get(id);
    if (!stored) throw new DomainError("not_found", "Provider not found", 404);
    if (stored.version !== expectedVersion) throw registryConflict();
    if (
      input.slug !== undefined &&
      [...this.providers.values()].some((provider) =>
        provider.id !== id && provider.slug === input.slug
      )
    ) throw new DomainError("provider_slug_taken", "Provider slug already exists", 409);
    if (input.slug !== undefined) stored.slug = input.slug;
    if (input.displayName !== undefined) stored.displayName = input.displayName.trim();
    if (input.baseUrl !== undefined) stored.baseUrl = normalizeProviderBaseUrl(input.baseUrl);
    if (input.protocol !== undefined) stored.protocol = input.protocol;
    if (input.enabled !== undefined) {
      stored.enabled = input.enabled;
      if (!input.enabled) stored.healthStatus = "disabled";
      else if (stored.healthStatus === "disabled") stored.healthStatus = "unknown";
    }
    if (input.healthStatus !== undefined) stored.healthStatus = input.healthStatus;
    if (input.healthCheckedAt !== undefined) {
      stored.healthCheckedAt = input.healthCheckedAt === null
        ? null
        : new Date(input.healthCheckedAt).toISOString();
    }
    if (input.healthLatencyMs !== undefined) stored.healthLatencyMs = input.healthLatencyMs;
    if (input.healthError !== undefined) stored.healthError = input.healthError;
    if (!stored.enabled) stored.healthStatus = "disabled";
    stored.version += 1;
    stored.updatedAt = new Date().toISOString();
    this.registryAudit(mutation, "provider", stored.id, { version: stored.version });
    return this.publicProvider(stored);
  }

  listProviders(enabledOnly = false): ProviderRecord[] {
    return [...this.providers.values()]
      .filter((provider) => !enabledOnly || provider.enabled)
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id)
      )
      .map((provider) => this.publicProvider(provider));
  }

  findProvider(idOrSlug: string): ProviderRecord | undefined {
    const stored = this.providers.get(idOrSlug) ??
      [...this.providers.values()].find((provider) => provider.slug === idOrSlug);
    return stored ? this.publicProvider(stored) : undefined;
  }

  setProviderCredential(
    id: string,
    expectedVersion: number,
    credential: ProviderCredentialMutation | null,
    mutation: RegistryMutationContext,
  ): ProviderRecord {
    this.validateRegistryMutation(mutation);
    const stored = this.providers.get(id);
    if (!stored) throw new DomainError("not_found", "Provider not found", 404);
    if (stored.version !== expectedVersion) throw registryConflict();
    if (credential) validateCredentialEnvelope(credential.envelope);
    stored.credentialEnvelope = credential ? structuredClone(credential.envelope) : null;
    stored.credentialUpdatedAt = credential ? new Date().toISOString() : null;
    stored.hasCredential = credential !== null;
    stored.healthStatus = stored.enabled ? "unknown" : "disabled";
    stored.healthCheckedAt = null;
    stored.healthLatencyMs = null;
    stored.healthError = null;
    stored.version += 1;
    stored.updatedAt = new Date().toISOString();
    this.registryAudit(mutation, "provider", stored.id, {
      version: stored.version,
      credentialChanged: true,
      hasCredential: stored.hasCredential,
    });
    return this.publicProvider(stored);
  }

  getProviderCredential(id: string): StoredProviderCredential | undefined {
    const stored = this.providers.get(id);
    if (!stored?.credentialEnvelope) return undefined;
    return {
      providerId: stored.id,
      envelope: structuredClone(stored.credentialEnvelope),
    };
  }

  createProviderModel(
    input: CreateProviderModelInput,
    mutation: RegistryMutationContext,
  ): ProviderModelRecord {
    this.validateRegistryMutation(mutation);
    validateProviderModelInput(input);
    if (!this.providers.has(input.providerId)) {
      throw new DomainError("not_found", "Provider not found", 404);
    }
    if (
      [...this.providerModels.values()].some((model) => model.publicModelId === input.publicModelId)
    ) {
      throw new DomainError("model_id_taken", "Public model ID already exists", 409);
    }
    const now = new Date().toISOString();
    const model: ProviderModelRecord = {
      id: crypto.randomUUID(),
      providerId: input.providerId,
      publicModelId: input.publicModelId,
      upstreamModelId: input.upstreamModelId.trim(),
      displayName: input.displayName.trim(),
      capabilities: [...input.capabilities],
      contextWindow: input.contextWindow,
      enabled: input.enabled ?? true,
      version: 1,
      customParams: structuredClone(input.customParams ?? {}),
      createdAt: now,
      updatedAt: now,
    };
    this.providerModels.set(model.id, model);
    this.registryAudit(mutation, "provider_model", model.id, {
      providerId: model.providerId,
      version: model.version,
    });
    return structuredClone(model);
  }

  updateProviderModel(
    id: string,
    expectedVersion: number,
    input: UpdateProviderModelInput,
    mutation: RegistryMutationContext,
  ): ProviderModelRecord {
    this.validateRegistryMutation(mutation);
    validateProviderModelInput(input);
    const model = this.providerModels.get(id);
    if (!model) throw new DomainError("not_found", "Provider model not found", 404);
    if (model.version !== expectedVersion) throw registryConflict();
    if (
      input.publicModelId !== undefined &&
      [...this.providerModels.values()].some((candidate) =>
        candidate.id !== id && candidate.publicModelId === input.publicModelId
      )
    ) throw new DomainError("model_id_taken", "Public model ID already exists", 409);
    if (input.publicModelId !== undefined) model.publicModelId = input.publicModelId;
    if (input.upstreamModelId !== undefined) model.upstreamModelId = input.upstreamModelId.trim();
    if (input.displayName !== undefined) model.displayName = input.displayName.trim();
    if (input.capabilities !== undefined) model.capabilities = [...input.capabilities];
    if (input.contextWindow !== undefined) model.contextWindow = input.contextWindow;
    if (input.enabled !== undefined) model.enabled = input.enabled;
    if (input.customParams !== undefined) model.customParams = structuredClone(input.customParams);
    model.version += 1;
    model.updatedAt = new Date().toISOString();
    this.registryAudit(mutation, "provider_model", model.id, {
      providerId: model.providerId,
      version: model.version,
    });
    return structuredClone(model);
  }

  listProviderModels(providerId?: string, enabledOnly = false): ProviderModelRecord[] {
    return [...this.providerModels.values()]
      .filter((model) =>
        (!providerId || model.providerId === providerId) && (!enabledOnly || model.enabled)
      )
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id)
      )
      .map((model) => structuredClone(model));
  }

  findProviderModel(idOrPublicModelId: string): ProviderModelRecord | undefined {
    const model = this.providerModels.get(idOrPublicModelId) ??
      [...this.providerModels.values()].find((candidate) =>
        candidate.publicModelId === idOrPublicModelId
      );
    return model ? structuredClone(model) : undefined;
  }

  createModelPriceVersion(
    input: CreateModelPriceVersionInput,
    mutation: RegistryMutationContext,
  ): ModelPriceVersion {
    this.validateRegistryMutation(mutation);
    validatePriceInput(input);
    const model = this.providerModels.get(input.providerModelId);
    if (!model) throw new DomainError("not_found", "Provider model not found", 404);
    if (model.version !== input.expectedModelVersion) throw registryConflict();
    const effectiveAt = new Date(input.effectiveAt).toISOString();
    const versions = this.modelPriceVersions.get(model.id) ?? [];
    if (versions.some((price) => price.effectiveAt === effectiveAt)) {
      throw new DomainError("price_effective_at_taken", "A price already starts at that time", 409);
    }
    const price: ModelPriceVersion = {
      id: crypto.randomUUID(),
      providerModelId: model.id,
      effectiveAt,
      inputMicrosPerMillion: input.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: input.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: input.reasoningMicrosPerMillion,
      outputMicrosPerMillion: input.outputMicrosPerMillion,
      fixedCallMicros: input.fixedCallMicros,
      source: input.source.trim(),
      createdAt: new Date().toISOString(),
    };
    versions.push(price);
    this.modelPriceVersions.set(model.id, versions);
    model.version += 1;
    model.updatedAt = new Date().toISOString();
    this.registryAudit(mutation, "model_price_version", price.id, {
      providerModelId: model.id,
      effectiveAt,
      modelVersion: model.version,
    });
    return structuredClone(price);
  }

  listModelPriceVersions(providerModelId: string): ModelPriceVersion[] {
    if (!this.providerModels.has(providerModelId)) {
      throw new DomainError("not_found", "Provider model not found", 404);
    }
    return [...(this.modelPriceVersions.get(providerModelId) ?? [])]
      .sort((left, right) =>
        right.effectiveAt.localeCompare(left.effectiveAt) ||
        right.id.localeCompare(left.id)
      )
      .map((price) => structuredClone(price));
  }

  effectiveModelPrice(providerModelId: string, at = new Date().toISOString()) {
    if (!Number.isFinite(Date.parse(at))) {
      throw new DomainError("validation_error", "Price lookup timestamp is invalid", 422);
    }
    const lookup = new Date(at).toISOString();
    return this.listModelPriceVersions(providerModelId).find((price) =>
      price.effectiveAt <= lookup
    );
  }

  createProviderRetryPolicy(
    input: CreateProviderRetryPolicyInput,
    mutation: RegistryMutationContext,
  ): ProviderRetryPolicy {
    this.validateRegistryMutation(mutation);
    validateRetryPolicy(input);
    if (
      [...this.providerRetryPolicies.values()].some((policy) => policy.name === input.name.trim())
    ) {
      throw new DomainError("retry_policy_name_taken", "Retry policy name already exists", 409);
    }
    const now = new Date().toISOString();
    const policy: ProviderRetryPolicy = {
      id: crypto.randomUUID(),
      ...structuredClone(input),
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      retryableStatuses: [...input.retryableStatuses].sort((a, b) => a - b),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.providerRetryPolicies.set(policy.id, policy);
    this.registryAudit(mutation, "provider_retry_policy", policy.id, { version: 1 });
    return structuredClone(policy);
  }

  updateProviderRetryPolicy(
    id: string,
    expectedVersion: number,
    input: UpdateProviderRetryPolicyInput,
    mutation: RegistryMutationContext,
  ): ProviderRetryPolicy {
    this.validateRegistryMutation(mutation);
    const current = this.providerRetryPolicies.get(id);
    if (!current) throw new DomainError("not_found", "Retry policy not found", 404);
    if (current.version !== expectedVersion) throw registryConflict();
    const next = {
      ...current,
      ...structuredClone(input),
      name: input.name?.trim() ?? current.name,
    };
    validateRetryPolicy(next);
    if (
      [...this.providerRetryPolicies.values()].some((policy) =>
        policy.id !== id && policy.name === next.name
      )
    ) {
      throw new DomainError("retry_policy_name_taken", "Retry policy name already exists", 409);
    }
    next.retryableStatuses = [...next.retryableStatuses].sort((a, b) => a - b);
    next.version += 1;
    next.updatedAt = new Date().toISOString();
    this.providerRetryPolicies.set(id, next);
    this.registryAudit(mutation, "provider_retry_policy", id, { version: next.version });
    return structuredClone(next);
  }

  listProviderRetryPolicies(enabledOnly = false): ProviderRetryPolicy[] {
    return [...this.providerRetryPolicies.values()]
      .filter((policy) => !enabledOnly || policy.enabled)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((policy) => structuredClone(policy));
  }

  private assertAcyclicRoutes(candidate: ProviderModelRoute) {
    const routes = new Map(this.providerModelRoutes);
    routes.set(candidate.sourceModelId, candidate);
    const visit = (modelId: string, path: Set<string>) => {
      if (path.has(modelId)) {
        throw new DomainError("fallback_cycle", "Fallback routes must be acyclic", 422);
      }
      const route = routes.get(modelId);
      if (!route) return;
      const next = new Set(path).add(modelId);
      for (const target of route.fallbackModelIds) visit(target, next);
    };
    for (const source of routes.keys()) visit(source, new Set());
    for (const source of routes.keys()) {
      const reachable = new Set<string>([source]);
      const expand = (modelId: string) => {
        for (const target of routes.get(modelId)?.fallbackModelIds ?? []) {
          if (reachable.has(target)) continue;
          reachable.add(target);
          expand(target);
        }
      };
      expand(source);
      if (reachable.size > 8) {
        throw new DomainError(
          "fallback_depth",
          "Execution plans may contain at most eight targets",
          422,
        );
      }
    }
  }

  setProviderModelRoute(
    input: SetProviderModelRouteInput,
    mutation: RegistryMutationContext,
  ): ProviderModelRoute {
    this.validateRegistryMutation(mutation);
    const source = this.providerModels.get(input.sourceModelId);
    if (!source) throw new DomainError("not_found", "Source model not found", 404);
    const current = this.providerModelRoutes.get(input.sourceModelId);
    if ((current?.version ?? 0) !== input.expectedVersion) throw registryConflict();
    if (
      input.fallbackModelIds.length > 8 ||
      new Set(input.fallbackModelIds).size !== input.fallbackModelIds.length ||
      input.fallbackModelIds.includes(input.sourceModelId) ||
      input.fallbackModelIds.some((id) => !this.providerModels.has(id))
    ) {
      throw new DomainError("validation_error", "Fallback targets are invalid", 422);
    }
    if (input.retryPolicyId != null && !this.providerRetryPolicies.has(input.retryPolicyId)) {
      throw new DomainError("not_found", "Retry policy not found", 404);
    }
    const sourceProvider = this.providers.get(source.providerId);
    const compatible = input.fallbackModelIds.every((id) => {
      const target = this.providerModels.get(id)!;
      const provider = this.providers.get(target.providerId);
      return target.enabled && provider?.enabled && provider.hasCredential &&
        this.effectiveModelPrice(target.id) !== undefined && sourceProvider &&
        provider.protocol === sourceProvider.protocol &&
        target.contextWindow >= source.contextWindow &&
        source.capabilities.every((capability) => target.capabilities.includes(capability));
    });
    if (!compatible) {
      throw new DomainError(
        "fallback_incompatible",
        "Fallback targets must be available and compatible with the source model",
        422,
      );
    }
    const now = new Date().toISOString();
    const route: ProviderModelRoute = {
      id: current?.id ?? crypto.randomUUID(),
      sourceModelId: input.sourceModelId,
      retryPolicyId: input.retryPolicyId ?? null,
      fallbackModelIds: [...input.fallbackModelIds],
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.assertAcyclicRoutes(route);
    this.providerModelRoutes.set(input.sourceModelId, route);
    this.registryAudit(mutation, "provider_model_route", route.id, {
      sourceModelId: route.sourceModelId,
      version: route.version,
      fallbackCount: route.fallbackModelIds.length,
    });
    return structuredClone(route);
  }

  findProviderModelRoute(sourceModelId: string): ProviderModelRoute | undefined {
    const route = this.providerModelRoutes.get(sourceModelId);
    return route ? structuredClone(route) : undefined;
  }

  resolveProviderExecutionPlan(
    sourceModelId: string,
    at = new Date().toISOString(),
  ): ProviderExecutionPlan {
    if (!Number.isFinite(Date.parse(at))) {
      throw new DomainError("validation_error", "Plan timestamp is invalid", 422);
    }
    const route = this.providerModelRoutes.get(sourceModelId);
    const ids: string[] = [];
    const seen = new Set<string>();
    const flatten = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
      for (const fallback of this.providerModelRoutes.get(id)?.fallbackModelIds ?? []) {
        flatten(fallback);
      }
    };
    flatten(sourceModelId);
    const source = this.providerModels.get(sourceModelId);
    const sourceProvider = source ? this.providers.get(source.providerId) : undefined;
    const targets: ProviderExecutionPlan["targets"] = [];
    for (const id of ids) {
      const model = this.providerModels.get(id);
      const provider = model ? this.providers.get(model.providerId) : undefined;
      const price = model ? this.effectiveModelPrice(model.id, at) : undefined;
      const compatible = source && sourceProvider && model && provider &&
        provider.protocol === sourceProvider.protocol &&
        model.contextWindow >= source.contextWindow &&
        source.capabilities.every((capability) => model.capabilities.includes(capability));
      const unavailable = !model || !provider || !model.enabled || !provider.enabled ||
        !provider.hasCredential ||
        !price || !compatible;
      if (unavailable) {
        if (id !== sourceModelId) continue;
        throw new DomainError(
          "execution_plan_unavailable",
          "Provider execution target is unavailable",
          409,
        );
      }
      targets.push({
        ordinal: targets.length,
        providerId: provider.id,
        providerSlug: provider.slug,
        providerVersion: provider.version,
        protocol: provider.protocol,
        providerModelId: model.id,
        publicModelId: model.publicModelId,
        upstreamModelId: model.upstreamModelId,
        modelVersion: model.version,
        pricing: {
          pricingVersionId: price.id,
          inputMicrosPerMillion: price.inputMicrosPerMillion,
          cachedInputMicrosPerMillion: price.cachedInputMicrosPerMillion,
          reasoningMicrosPerMillion: price.reasoningMicrosPerMillion,
          outputMicrosPerMillion: price.outputMicrosPerMillion,
          fixedCallMicros: price.fixedCallMicros,
          source: price.source,
        },
      });
    }
    return {
      sourceModelId,
      routeId: route?.id ?? null,
      routeVersion: route?.version ?? 0,
      retryPolicy: route?.retryPolicyId &&
          this.providerRetryPolicies.get(route.retryPolicyId)?.enabled
        ? structuredClone(this.providerRetryPolicies.get(route.retryPolicyId)!)
        : null,
      targets,
      resolvedAt: new Date(at).toISOString(),
    };
  }

  private providerExecutionRun(usageRunId: string, ownerLeaseToken: string) {
    const run = this.usageRuns.get(usageRunId);
    if (!run) throw new DomainError("not_found", "Usage run not found", 404);
    if (run.status !== "reserved") {
      throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
    }
    const generationLease = run.generationLeaseToken === ownerLeaseToken &&
      run.generationLeaseExpiresAt !== null &&
      Date.parse(run.generationLeaseExpiresAt) > Date.now();
    const api = [...this.apiIdempotencyRequests.values()].find((request) =>
      request.usageRunId === usageRunId
    );
    const apiLease = api?.state === "in_progress" && api.leaseToken === ownerLeaseToken &&
      api.leaseExpiresAt !== null && Date.parse(api.leaseExpiresAt) > Date.now();
    const runLease = run.runLeaseToken === ownerLeaseToken && run.runLeaseExpiresAt !== null &&
      Date.parse(run.runLeaseExpiresAt) > Date.now();
    if (!generationLease && !apiLease && !runLease) {
      throw new DomainError("stale_lease", "Provider execution lease is stale", 409);
    }
    return run;
  }

  heartbeatProviderExecutionLease(
    usageRunId: string,
    ownerLeaseToken: string,
    leaseSeconds = 120,
  ) {
    const run = this.usageRuns.get(usageRunId);
    if (
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900 || !run ||
      run.status !== "reserved" || run.runLeaseToken !== ownerLeaseToken ||
      !run.runLeaseExpiresAt || Date.parse(run.runLeaseExpiresAt) <= Date.now()
    ) {
      throw new DomainError("stale_lease", "Provider execution lease is no longer active", 409);
    }
    run.runLeaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return { leaseToken: ownerLeaseToken, leaseExpiresAt: run.runLeaseExpiresAt };
  }

  reclaimProviderExecutionLease(
    usageRunId: string,
    expiredLeaseToken: string,
    leaseSeconds = 120,
  ) {
    const run = this.usageRuns.get(usageRunId);
    if (
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900 || !run ||
      run.status !== "reserved" || run.runLeaseToken !== expiredLeaseToken ||
      !run.runLeaseExpiresAt || Date.parse(run.runLeaseExpiresAt) > Date.now()
    ) {
      throw new DomainError(
        "lease_not_reclaimable",
        "Provider execution lease cannot be reclaimed",
        409,
      );
    }
    run.runLeaseToken = crypto.randomUUID();
    run.runLeaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return { leaseToken: run.runLeaseToken, leaseExpiresAt: run.runLeaseExpiresAt };
  }

  claimProviderExecution(
    usageRunId: string,
    ownerLeaseToken: string,
  ): ProviderExecutionClaim {
    const run = this.providerExecutionRun(usageRunId, ownerLeaseToken);
    const reconciledAttemptIds: string[] = [];
    if (run.executionOwnerLeaseToken !== ownerLeaseToken) {
      run.executionEpoch += 1;
      run.executionOwnerLeaseToken = ownerLeaseToken;
      for (const attempt of this.providerAttempts.values()) {
        if (attempt.usageRunId !== usageRunId || attempt.status !== "running") continue;
        attempt.status = "cancelled";
        attempt.phase = "planning";
        attempt.errorCode = "execution_reclaimed";
        attempt.breakerAfter = "unavailable";
        attempt.retryable = true;
        attempt.latencyMs = Math.max(0, Date.now() - Date.parse(attempt.startedAt));
        attempt.completedAt = new Date().toISOString();
        reconciledAttemptIds.push(attempt.id);
      }
    }
    const nextAttemptNumber = Math.max(
      1,
      ...[...this.providerAttempts.values()].filter((attempt) => attempt.usageRunId === usageRunId)
        .map((attempt) => attempt.attemptNumber + 1),
    );
    const consumedAttempts =
      [...this.providerAttempts.values()].filter((attempt) =>
        attempt.usageRunId === usageRunId && attempt.status !== "skipped"
      ).length;
    if (nextAttemptNumber > 16) {
      throw new DomainError(
        "execution_path_exhausted",
        "Provider execution path is exhausted",
        409,
      );
    }
    return {
      usageRunId,
      executionEpoch: run.executionEpoch,
      nextAttemptNumber,
      consumedAttempts,
      reconciledAttemptIds,
    };
  }

  private exactAttemptCost(attempt: ProviderAttempt, input: FinishProviderAttemptInput): number {
    if (input.status === "skipped") return 0;
    if (
      input.costSource === "none" && input.costMicros === 0 && input.inputTokens === 0 &&
      input.outputTokens === 0 && input.status !== "succeeded"
    ) return 0;
    const uncached = input.inputTokens - input.cachedInputTokens;
    const ordinaryOutput = input.outputTokens - input.reasoningTokens;
    const numerator = BigInt(uncached) * BigInt(attempt.pricing.inputMicrosPerMillion) +
      BigInt(input.cachedInputTokens) * BigInt(attempt.pricing.cachedInputMicrosPerMillion) +
      BigInt(input.reasoningTokens) * BigInt(attempt.pricing.reasoningMicrosPerMillion) +
      BigInt(ordinaryOutput) * BigInt(attempt.pricing.outputMicrosPerMillion);
    const cost = BigInt(attempt.pricing.fixedCallMicros) + (numerator + 999_999n) / 1_000_000n;
    if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DomainError(
        "accounting_overflow",
        "Provider attempt cost exceeds accounting bounds",
        422,
      );
    }
    return Number(cost);
  }

  startProviderAttempt(input: StartProviderAttemptInput): ProviderAttempt {
    if (
      !Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1 ||
      input.attemptNumber > 16 ||
      !Number.isSafeInteger(input.executionEpoch) || input.executionEpoch < 1 ||
      !/^[0-9a-f-]{36}$/i.test(input.ownerLeaseToken) ||
      !isUsagePricingSnapshot(input.pricing) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.providerSlug) ||
      input.publicModelId.length < 3 || input.publicModelId.length > 255 ||
      !input.upstreamModelId || input.upstreamModelId.length > 255 ||
      !Number.isSafeInteger(input.providerVersion) || input.providerVersion < 1 ||
      !Number.isSafeInteger(input.modelVersion) || input.modelVersion < 1 ||
      !["chat_completions", "responses"].includes(input.protocol) ||
      !Number.isSafeInteger(input.targetOrdinal) || input.targetOrdinal < 0 ||
      input.targetOrdinal > 7 || !Number.isSafeInteger(input.retryNumber) ||
      input.retryNumber < 0 || input.retryNumber > 3 ||
      !["primary", "retry", "fallback", "circuit_skip", "half_open"].includes(input.reason) ||
      (input.breakerBefore != null &&
        !["closed", "open", "half_open", "unavailable"].includes(input.breakerBefore))
    ) {
      throw new DomainError("validation_error", "Provider attempt start is invalid", 422);
    }
    const run = this.providerExecutionRun(input.usageRunId, input.ownerLeaseToken);
    if (
      run.executionEpoch !== input.executionEpoch ||
      run.executionOwnerLeaseToken !== input.ownerLeaseToken
    ) {
      throw new DomainError("stale_lease", "Provider execution epoch is stale", 409);
    }
    const model = this.providerModels.get(input.providerModelId);
    const price = (this.modelPriceVersions.get(input.providerModelId) ?? []).find((candidate) =>
      candidate.id === input.pricing.pricingVersionId
    );
    if (
      !model || model.providerId !== input.providerId || !price ||
      JSON.stringify({
          pricingVersionId: price.id,
          inputMicrosPerMillion: price.inputMicrosPerMillion,
          cachedInputMicrosPerMillion: price.cachedInputMicrosPerMillion,
          reasoningMicrosPerMillion: price.reasoningMicrosPerMillion,
          outputMicrosPerMillion: price.outputMicrosPerMillion,
          fixedCallMicros: price.fixedCallMicros,
          source: price.source,
        }) !== JSON.stringify(input.pricing)
    ) {
      throw new DomainError("validation_error", "Provider attempt target snapshot is invalid", 422);
    }
    const existing = [...this.providerAttempts.values()].find((attempt) =>
      attempt.usageRunId === input.usageRunId && attempt.attemptNumber === input.attemptNumber
    );
    const immutable = {
      usageRunId: input.usageRunId,
      attemptNumber: input.attemptNumber,
      executionEpoch: input.executionEpoch,
      targetOrdinal: input.targetOrdinal,
      retryNumber: input.retryNumber,
      reason: input.reason,
      breakerBefore: input.breakerBefore ?? null,
      providerId: input.providerId,
      providerSlug: input.providerSlug,
      providerVersion: input.providerVersion,
      protocol: input.protocol,
      providerModelId: input.providerModelId,
      publicModelId: input.publicModelId,
      upstreamModelId: input.upstreamModelId,
      modelVersion: input.modelVersion,
      pricing: structuredClone(input.pricing),
    };
    if (existing) {
      const comparable = ((
        {
          usageRunId,
          attemptNumber,
          executionEpoch,
          targetOrdinal,
          retryNumber,
          reason,
          breakerBefore,
          providerId,
          providerSlug,
          providerVersion,
          protocol,
          providerModelId,
          publicModelId,
          upstreamModelId,
          modelVersion,
          pricing,
        },
      ) => ({
        usageRunId,
        attemptNumber,
        executionEpoch,
        targetOrdinal,
        retryNumber,
        reason,
        breakerBefore,
        providerId,
        providerSlug,
        providerVersion,
        protocol,
        providerModelId,
        publicModelId,
        upstreamModelId,
        modelVersion,
        pricing,
      }))(existing);
      if (JSON.stringify(comparable) !== JSON.stringify(immutable)) {
        throw new DomainError(
          "idempotency_conflict",
          "Attempt number already has different target data",
          409,
        );
      }
      return structuredClone(existing);
    }
    const attempt: ProviderAttempt = {
      id: crypto.randomUUID(),
      ...immutable,
      status: "running",
      phase: "planning",
      breakerAfter: null,
      retryable: false,
      errorCode: null,
      httpStatus: null,
      visibleOutput: false,
      inputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
      costMicros: 0,
      tokenSource: "none",
      costSource: "none",
      latencyMs: null,
      ttftMs: null,
      upstreamRequestId: null,
      tokensPerSecond: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.providerAttempts.set(attempt.id, attempt);
    return structuredClone(attempt);
  }

  finishProviderAttempt(input: FinishProviderAttemptInput): ProviderAttempt {
    validateAttemptFinish(input);
    const attempt = this.providerAttempts.get(input.id);
    if (!attempt) throw new DomainError("not_found", "Provider attempt not found", 404);
    const run = this.providerExecutionRun(attempt.usageRunId, input.ownerLeaseToken);
    if (
      attempt.executionEpoch !== input.executionEpoch ||
      run.executionEpoch !== input.executionEpoch ||
      run.executionOwnerLeaseToken !== input.ownerLeaseToken
    ) {
      throw new DomainError("stale_lease", "Provider execution epoch is stale", 409);
    }
    const { ownerLeaseToken: _ownerLeaseToken, executionEpoch: _executionEpoch, ...terminalInput } =
      input;
    const terminal = {
      ...terminalInput,
      errorCode: input.errorCode ?? null,
      httpStatus: input.httpStatus ?? null,
      ttftMs: input.ttftMs ?? null,
      breakerAfter: input.breakerAfter ?? null,
      upstreamRequestId: input.upstreamRequestId ?? null,
      tokensPerSecond: input.tokensPerSecond ?? null,
    };
    if (attempt.status !== "running") {
      const current = ((
        {
          id,
          status,
          phase,
          errorCode,
          httpStatus,
          visibleOutput,
          inputTokens,
          cachedInputTokens,
          reasoningTokens,
          outputTokens,
          costMicros,
          tokenSource,
          costSource,
          latencyMs,
          ttftMs,
          breakerAfter,
          retryable,
          upstreamRequestId,
          tokensPerSecond,
        },
      ) => ({
        id,
        status,
        phase,
        errorCode,
        httpStatus,
        visibleOutput,
        inputTokens,
        cachedInputTokens,
        reasoningTokens,
        outputTokens,
        costMicros,
        tokenSource,
        costSource,
        latencyMs,
        ttftMs,
        breakerAfter,
        retryable,
        upstreamRequestId,
        tokensPerSecond,
      }))(attempt);
      if (JSON.stringify(current) !== JSON.stringify(terminal)) {
        throw new DomainError(
          "attempt_terminal_conflict",
          "Provider attempt is already terminal",
          409,
        );
      }
      return structuredClone(attempt);
    }
    const exactCost = this.exactAttemptCost(attempt, input);
    if (input.costMicros !== exactCost) {
      throw new DomainError(
        "invalid_attempt_cost",
        "Provider attempt cost does not match its pricing snapshot",
        422,
      );
    }
    const aggregates = [
      ["actualProviderCostMicros", exactCost],
      ["actualProviderInputTokens", input.inputTokens],
      ["actualProviderCachedInputTokens", input.cachedInputTokens],
      ["actualProviderReasoningTokens", input.reasoningTokens],
      ["actualProviderOutputTokens", input.outputTokens],
    ] as const;
    const totals = new Map<
      typeof aggregates[number][0],
      number
    >();
    for (const [field, amount] of aggregates) {
      const total = run[field] + amount;
      if (!Number.isSafeInteger(total) || total < 0) {
        throw new DomainError(
          "accounting_overflow",
          "Provider usage aggregate exceeds accounting bounds",
          422,
        );
      }
      totals.set(field, total);
    }
    Object.assign(attempt, terminal, { completedAt: new Date().toISOString() });
    for (const [field, total] of totals) run[field] = total;
    return structuredClone(attempt);
  }

  listProviderAttempts(usageRunId: string): ProviderAttempt[] {
    return [...this.providerAttempts.values()].filter((attempt) =>
      attempt.usageRunId === usageRunId
    )
      .sort((a, b) => a.attemptNumber - b.attemptNumber).map((attempt) => structuredClone(attempt));
  }

  private finalizeProviderUsage(input: FinalizeProviderUsageInput, refundOnly: boolean): UsageRun {
    const run = this.usageRuns.get(input.usageRunId);
    if (!run) throw new DomainError("not_found", "Usage run not found", 404);
    if (run.status !== "reserved") {
      if (
        run.executionEpoch === input.executionEpoch &&
        run.executionOwnerLeaseToken === input.ownerLeaseToken
      ) return structuredClone(run);
      throw new DomainError("invalid_usage_state", "Usage run is already terminal", 409);
    }
    this.providerExecutionRun(input.usageRunId, input.ownerLeaseToken);
    if (
      run.executionEpoch !== input.executionEpoch ||
      run.executionOwnerLeaseToken !== input.ownerLeaseToken
    ) {
      throw new DomainError("stale_lease", "Provider execution epoch is stale", 409);
    }
    if (refundOnly) {
      return structuredClone(this.refund(run.id)!);
    }
    const settled = this.settle(
      run.id,
      run.actualProviderCostMicros,
      run.actualProviderInputTokens,
      run.actualProviderOutputTokens,
      input.latencyMs,
    );
    settled.runLeaseToken = null;
    settled.runLeaseExpiresAt = null;
    return structuredClone(settled);
  }

  settleProviderUsage(input: FinalizeProviderUsageInput): UsageRun {
    return this.finalizeProviderUsage(input, false);
  }

  refundProviderUsage(input: FinalizeProviderUsageInput): UsageRun {
    return this.finalizeProviderUsage(input, true);
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

  reserve(
    userId: string,
    runId: string,
    model: string,
    amountMicros: number,
    _provider = "unknown",
    _tokenId?: string,
    pricingSnapshot?: UsagePricingSnapshot,
  ) {
    if (pricingSnapshot !== undefined && !isUsagePricingSnapshot(pricingSnapshot)) {
      throw new DomainError("validation_error", "Usage pricing snapshot is invalid", 422);
    }
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
      executionEpoch: 0,
      executionOwnerLeaseToken: null,
      runLeaseToken: crypto.randomUUID(),
      runLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      actualProviderCostMicros: 0,
      actualProviderInputTokens: 0,
      actualProviderCachedInputTokens: 0,
      actualProviderReasoningTokens: 0,
      actualProviderOutputTokens: 0,
      pricingSnapshot: pricingSnapshot ? structuredClone(pricingSnapshot) : null,
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
    if (run.executionEpoch > 0) {
      costMicros = run.actualProviderCostMicros;
      inputTokens = run.actualProviderInputTokens;
      outputTokens = run.actualProviderOutputTokens;
    }
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
    run.runLeaseToken = null;
    run.runLeaseExpiresAt = null;
    run.generationLeaseToken = null;
    run.generationLeaseExpiresAt = null;
    return run;
  }

  refund(runId: string) {
    const run = this.usageRuns.get(runId);
    if (!run || run.status !== "reserved") return run;
    if (run.executionEpoch > 0) {
      const cost = run.actualProviderCostMicros;
      const delta = run.reservedMicros - cost;
      if (delta !== 0) this.credit(run.userId, runId, delta > 0 ? "refund" : "settle", delta);
      run.status = "failed";
      run.costMicros = cost;
      run.inputTokens = run.actualProviderInputTokens;
      run.outputTokens = run.actualProviderOutputTokens;
      run.runLeaseToken = null;
      run.runLeaseExpiresAt = null;
      return run;
    }
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
      input.provider,
      input.tokenId,
      input.pricingSnapshot,
    );
    usageRun.runLeaseToken = null;
    usageRun.runLeaseExpiresAt = null;
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
      const usageRun = this.usageRuns.get(request.usageRunId);
      for (const attempt of this.providerAttempts.values()) {
        if (attempt.usageRunId !== request.usageRunId || attempt.status !== "running") continue;
        attempt.status = "cancelled";
        attempt.phase = "planning";
        attempt.errorCode = "api_lease_expired";
        attempt.breakerAfter = "unavailable";
        attempt.retryable = true;
        attempt.latencyMs = Math.max(0, Date.now() - Date.parse(attempt.startedAt));
        attempt.completedAt = new Date().toISOString();
      }
      if ((usageRun?.executionEpoch ?? 0) > 0) {
        this.refund(request.usageRunId);
      } else if (request.observedCostMicros > 0) {
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

  reapStaleProviderExecutionLeases(limit = 100) {
    let count = 0;
    for (const run of this.usageRuns.values()) {
      if (count >= limit) break;
      const belongsToApiReplay = [...this.apiIdempotencyRequests.values()].some((request) =>
        request.usageRunId === run.id
      );
      if (
        run.status !== "reserved" || !run.runLeaseToken || !run.runLeaseExpiresAt ||
        Date.parse(run.runLeaseExpiresAt) > Date.now() || run.generationLeaseToken ||
        belongsToApiReplay
      ) continue;
      for (const attempt of this.providerAttempts.values()) {
        if (attempt.usageRunId !== run.id || attempt.status !== "running") continue;
        attempt.status = "cancelled";
        attempt.phase = "planning";
        attempt.errorCode = "execution_lease_expired";
        attempt.breakerAfter = "unavailable";
        attempt.retryable = true;
        attempt.latencyMs = Math.max(0, Date.now() - Date.parse(attempt.startedAt));
        attempt.completedAt = new Date().toISOString();
      }
      this.refund(run.id);
      run.runLeaseToken = null;
      run.runLeaseExpiresAt = null;
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
