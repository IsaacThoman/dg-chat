import postgres from "npm:postgres@3.4.7";
import type { AccountState, Conversation, MessageNode, PublicUser } from "@dg-chat/contracts";
import { DomainError } from "./memory.ts";
import type { LedgerEntry, StoredApiToken, StoredSession, StoredUser, UsageRun } from "./memory.ts";
import type {
  ApiIdempotencyEndpoint,
  ApiIdempotencyFrame,
  ApiIdempotencyRequest,
  ApiReplayQuota,
  ApiSseFrameInput,
  ApiUsageObservation,
  AppendMessageInput,
  AuditEvent,
  AuditEventInput,
  BeginApiRequestInput,
  BeginApiRequestResult,
  BeginGenerationInput,
  CompleteApiRequestInput,
  CompleteGenerationInput,
  ConversationPatch,
  CreateApiTokenInput,
  CreateUserInput,
  DomainRepository,
  FailApiRequestInput,
  FailGenerationInput,
  IdentityTokenPurpose,
  SessionSummary,
} from "./repository.ts";

type Row = Record<string, unknown>;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const nullableIso = (value: unknown) => value == null ? null : iso(value);
const number = (value: unknown) => Number(value);
const replayQuota = (quota?: ApiReplayQuota): ApiReplayQuota => {
  const value = quota ?? { maxRequests: 256, maxBytes: 67_108_864, maxEvents: 20_000 };
  if (
    !Number.isSafeInteger(value.maxRequests) || value.maxRequests < 1 ||
    !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 ||
    !Number.isSafeInteger(value.maxEvents) || value.maxEvents < 1
  ) throw new DomainError("validation_error", "Invalid replay quota", 422);
  return value;
};

function user(row: Row): StoredUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    passwordHash: String(row.password_hash),
    role: row.role as StoredUser["role"],
    approvalStatus: row.approval_status as StoredUser["approvalStatus"],
    state: row.state as StoredUser["state"],
    balanceMicros: number(row.balance_micros),
    emailVerifiedAt: nullableIso(row.email_verified_at),
    createdAt: iso(row.created_at),
  };
}
function publicUser(value: StoredUser): PublicUser {
  const { passwordHash: _passwordHash, ...safe } = value;
  return safe;
}
function conversation(row: Row): Conversation {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    title: String(row.title),
    activeLeafId: row.active_leaf_id == null ? null : String(row.active_leaf_id),
    version: number(row.version),
    pinned: Boolean(row.pinned),
    temporary: Boolean(row.temporary),
    archivedAt: nullableIso(row.archived_at),
    deletedAt: nullableIso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function message(row: Row): MessageNode {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    supersedesId: row.supersedes_id == null ? null : String(row.supersedes_id),
    generationId: row.generation_id == null ? null : String(row.generation_id),
    siblingIndex: number(row.sibling_index),
    role: row.role as MessageNode["role"],
    content: String(row.content),
    model: row.model == null ? null : String(row.model),
    status: row.status as MessageNode["status"],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: iso(row.created_at),
  };
}
function token(row: Row): StoredApiToken {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    preview: String(row.preview),
    scopes: row.scopes as string[],
    expiresAt: nullableIso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    lastUsedAt: nullableIso(row.last_used_at),
    createdAt: iso(row.created_at),
  };
}
function run(row: Row): UsageRun {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    model: String(row.model),
    status: row.status as UsageRun["status"],
    reservedMicros: number(row.reserved_micros),
    costMicros: number(row.cost_micros),
    inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens),
    latencyMs: number(row.latency_ms ?? 0),
    generationLeaseToken: row.generation_lease_token ? String(row.generation_lease_token) : null,
    generationLeaseExpiresAt: nullableIso(row.generation_lease_expires_at),
    createdAt: iso(row.created_at),
  };
}
function apiRequest(row: Row, frames: ApiIdempotencyFrame[] = []): ApiIdempotencyRequest {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    endpoint: row.endpoint as ApiIdempotencyEndpoint,
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    stream: Boolean(row.stream),
    model: String(row.model),
    state: row.state as ApiIdempotencyRequest["state"],
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    usageRunId: String(row.usage_run_id),
    responseStatus: row.response_status == null ? null : number(row.response_status),
    responseHeaders: (row.response_headers ?? {}) as Record<string, string>,
    responseBody: row.response_body == null ? null : String(row.response_body),
    failureStartedStream: Boolean(row.failure_started_stream),
    observedInputTokens: number(row.observed_input_tokens),
    observedOutputTokens: number(row.observed_output_tokens),
    observedCostMicros: number(row.observed_cost_micros),
    observedLatencyMs: number(row.observed_latency_ms),
    retentionSeconds: number(row.retention_seconds),
    frames,
    createdAt: iso(row.created_at),
    completedAt: nullableIso(row.completed_at),
    expiresAt: iso(row.expires_at),
  };
}
function apiFrame(row: Row): ApiIdempotencyFrame {
  return {
    sequence: number(row.sequence),
    frame: String(row.frame),
    createdAt: iso(row.created_at),
  };
}

export class PostgresRepository implements DomainRepository {
  readonly storageKind = "postgres" as const;
  readonly #sql: ReturnType<typeof postgres>;
  private constructor(sql: ReturnType<typeof postgres>) {
    this.#sql = sql;
  }
  static async connect(url: string) {
    const sql = postgres(url, { max: 10 });
    await sql`SELECT 1`;
    return new PostgresRepository(sql);
  }
  async close() {
    await this.#sql.end({ timeout: 5 });
  }

  async bootstrapAdmin(input: CreateUserInput, credit: number) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-bootstrap'))`;
      const existing = await tx<Row[]>`SELECT id FROM users WHERE role = 'admin' LIMIT 1`;
      if (existing.length) {
        throw new DomainError("already_bootstrapped", "An administrator already exists", 409);
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO users (email,name,password_hash,role,approval_status,state,balance_micros,email_verified_at) VALUES (${input.email},${input.name},${input.passwordHash},'admin','approved','active',${credit},now()) RETURNING *`;
      const userId = String(rows[0].id);
      await tx`INSERT INTO ledger_entries (user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES (${userId},${`bootstrap:${userId}`},'grant',${credit},${credit})`;
      return user(rows[0]);
    });
  }
  async createUser(input: CreateUserInput) {
    try {
      const rows = await this.#sql<
        Row[]
      >`INSERT INTO users (email,name,password_hash,role,approval_status,state,email_verified_at) VALUES (${input.email},${input.name},${input.passwordHash},${
        input.role ?? "user"
      },${input.approvalStatus ?? "pending"},${input.state ?? "active"},${
        input.emailVerified || input.approvalStatus === "approved" ? new Date().toISOString() : null
      }) RETURNING *`;
      return user(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("email_taken", "An account with that email already exists", 409);
      }
      throw error;
    }
  }
  async findUser(id: string) {
    const rows = await this.#sql<Row[]>`SELECT * FROM users WHERE id=${id}`;
    return rows[0] ? user(rows[0]) : undefined;
  }
  async findUserByEmail(email: string) {
    const rows = await this.#sql<Row[]>`SELECT * FROM users WHERE email=${email}`;
    return rows[0] ? user(rows[0]) : undefined;
  }
  async listUsers() {
    return (await this.#sql<Row[]>`SELECT * FROM users ORDER BY created_at`).map(user).map(
      publicUser,
    );
  }
  async createSession(userId: string, tokenHash: string, limited: boolean) {
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO sessions (user_id,token_hash,limited,expires_at) VALUES (${userId},${tokenHash},${limited},now()+interval '30 days') RETURNING *`;
    return {
      id: String(rows[0].id),
      tokenHash: String(rows[0].token_hash),
      userId: String(rows[0].user_id),
      limited: Boolean(rows[0].limited),
      expiresAt: new Date(rows[0].expires_at as string).getTime(),
      createdAt: iso(rows[0].created_at),
      invalidatedAt: nullableIso(rows[0].invalidated_at),
    };
  }
  async getSession(tokenHash: string): Promise<StoredSession | undefined> {
    const rows = await this.#sql<
      Row[]
    >`SELECT * FROM sessions WHERE token_hash=${tokenHash} AND invalidated_at IS NULL AND expires_at>now()`;
    return rows[0]
      ? {
        id: String(rows[0].id),
        tokenHash,
        userId: String(rows[0].user_id),
        limited: Boolean(rows[0].limited),
        expiresAt: new Date(rows[0].expires_at as string).getTime(),
        createdAt: iso(rows[0].created_at),
        invalidatedAt: nullableIso(rows[0].invalidated_at),
      }
      : undefined;
  }
  async invalidateUserSessions(userId: string) {
    await this
      .#sql`UPDATE sessions SET invalidated_at=now() WHERE user_id=${userId} AND invalidated_at IS NULL`;
  }
  async deleteSession(tokenHash: string) {
    await this.#sql`UPDATE sessions SET invalidated_at=now() WHERE token_hash=${tokenHash}`;
  }
  async listSessions(userId: string): Promise<SessionSummary[]> {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM sessions WHERE user_id=${userId} ORDER BY created_at DESC`).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      limited: Boolean(row.limited),
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      invalidatedAt: nullableIso(row.invalidated_at),
    }));
  }
  async revokeSession(id: string, ownerId?: string) {
    const rows = ownerId
      ? await this
        .#sql`UPDATE sessions SET invalidated_at=now() WHERE id=${id} AND user_id=${ownerId} AND invalidated_at IS NULL RETURNING id`
      : await this
        .#sql`UPDATE sessions SET invalidated_at=now() WHERE id=${id} AND invalidated_at IS NULL RETURNING id`;
    if (!rows.length) throw new DomainError("not_found", "Session not found", 404);
  }
  async createIdentityToken(
    userId: string,
    purpose: IdentityTokenPurpose,
    tokenHash: string,
    expiresAt: string,
  ) {
    await this
      .#sql`INSERT INTO identity_tokens(user_id,purpose,token_hash,expires_at) VALUES(${userId},${purpose},${tokenHash},${expiresAt})`;
  }
  async verifyEmail(tokenHash: string) {
    return await this.#sql.begin(async (tx) => {
      const tokens = await tx<
        Row[]
      >`UPDATE identity_tokens SET consumed_at=now() WHERE token_hash=${tokenHash} AND purpose='email_verification' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`;
      if (!tokens[0]) {
        throw new DomainError(
          "invalid_identity_token",
          "Verification token is invalid or expired",
          400,
        );
      }
      const rows = await tx<
        Row[]
      >`UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=${
        String(tokens[0].user_id)
      } RETURNING *`;
      return user(rows[0]);
    });
  }
  async resetPassword(tokenHash: string, passwordHash: string) {
    return await this.#sql.begin(async (tx) => {
      const tokens = await tx<
        Row[]
      >`UPDATE identity_tokens SET consumed_at=now() WHERE token_hash=${tokenHash} AND purpose='password_reset' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`;
      if (!tokens[0]) {
        throw new DomainError("invalid_identity_token", "Reset token is invalid or expired", 400);
      }
      const userId = String(tokens[0].user_id);
      const rows = await tx<
        Row[]
      >`UPDATE users SET password_hash=${passwordHash},updated_at=now() WHERE id=${userId} RETURNING *`;
      await tx`UPDATE sessions SET invalidated_at=now() WHERE user_id=${userId} AND invalidated_at IS NULL`;
      await tx`UPDATE api_tokens SET revoked_at=now() WHERE user_id=${userId} AND revoked_at IS NULL`;
      await tx`UPDATE identity_tokens SET consumed_at=now() WHERE user_id=${userId} AND consumed_at IS NULL`;
      return user(rows[0]);
    });
  }
  async recordAudit(input: AuditEventInput): Promise<AuditEvent> {
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata) VALUES(${
      input.actorId ?? null
    },${input.action},${input.targetType},${input.targetId ?? null},${
      this.#sql.json((input.metadata ?? {}) as postgres.JSONValue)
    }) RETURNING *`;
    const row = rows[0];
    return {
      id: String(row.id),
      actorId: row.actor_id ? String(row.actor_id) : null,
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: row.target_id ? String(row.target_id) : null,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: iso(row.created_at),
    };
  }
  async listAudit(limit = 100): Promise<AuditEvent[]> {
    const safeLimit = Math.max(1, Math.min(500, limit));
    return (await this.#sql<
      Row[]
    >`SELECT * FROM audit_events ORDER BY created_at DESC,id DESC LIMIT ${safeLimit}`).map((
      row,
    ) => ({
      id: String(row.id),
      actorId: row.actor_id ? String(row.actor_id) : null,
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: row.target_id ? String(row.target_id) : null,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: iso(row.created_at),
    }));
  }

  async approveUser(
    id: string,
    status: "approved" | "rejected",
    credit: number,
    requireEmailVerification = false,
  ) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await tx<Row[]>`SELECT * FROM users WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
      if (status === "approved" && requireEmailVerification && !rows[0].email_verified_at) {
        throw new DomainError("email_not_verified", "Email must be verified before approval", 409);
      }
      if (rows[0].role === "admin" && status === "rejected") {
        const count = await tx<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM users WHERE role='admin' AND state='active' AND approval_status='approved'`;
        if (count[0].count <= 1) {
          throw new DomainError(
            "final_admin",
            "The final approved administrator is protected",
            409,
          );
        }
      }
      let balance = number(rows[0].balance_micros);
      if (status === "approved" && credit > 0) {
        const balanceAfterGrant = balance + credit;
        const grant =
          await tx`INSERT INTO ledger_entries (user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES (${id},${`approval:${id}`},'grant',${credit},${balanceAfterGrant}) ON CONFLICT DO NOTHING RETURNING id`;
        if (grant.length) balance = balanceAfterGrant;
      }
      const updated = await tx<
        Row[]
      >`UPDATE users SET approval_status=${status},balance_micros=${balance},updated_at=now() WHERE id=${id} RETURNING *`;
      if (status === "rejected") {
        await tx`UPDATE sessions SET invalidated_at=now() WHERE user_id=${id} AND invalidated_at IS NULL`;
        await tx`UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${id}`;
      }
      return user(updated[0]);
    });
  }
  async setUserState(id: string, state: AccountState) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await tx<Row[]>`SELECT * FROM users WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
      if (rows[0].role === "admin" && state !== "active") {
        const count = await tx<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM users WHERE role='admin' AND state='active' AND approval_status='approved'`;
        if (count[0].count <= 1) {
          throw new DomainError("final_admin", "The final active administrator is protected", 409);
        }
      }
      const updated = await tx<Row[]>`UPDATE users SET state=${state},deleted_at=${
        state === "deleted" ? new Date() : null
      },updated_at=now() WHERE id=${id} RETURNING *`;
      if (state !== "active") {
        await tx`UPDATE sessions SET invalidated_at=now() WHERE user_id=${id}`;
        await tx`UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${id}`;
      }
      return user(updated[0]);
    });
  }

  async createConversation(
    ownerId: string,
    title: string,
    temporary = false,
    idempotencyKey?: string,
  ) {
    return await this.#sql.begin(async (tx) => {
      const fingerprint = JSON.stringify({ title, temporary });
      if (idempotencyKey) {
        const prior = await tx<
          Row[]
        >`SELECT payload_hash,result_id FROM operation_idempotency WHERE owner_id=${ownerId} AND operation='conversation.create' AND idempotency_key=${idempotencyKey}`;
        if (prior[0]) {
          if (prior[0].payload_hash !== fingerprint) {
            throw new DomainError(
              "idempotency_conflict",
              "Conversation replay payload differs",
              409,
            );
          }
          const rows = await tx<Row[]>`SELECT * FROM conversations WHERE id=${
            String(prior[0].result_id)
          } AND owner_id=${ownerId}`;
          return conversation(rows[0]);
        }
      }
      const rows = await tx<
        Row[]
      >`INSERT INTO conversations(owner_id,title,temporary) VALUES(${ownerId},${title},${temporary}) RETURNING *`;
      if (idempotencyKey) {
        await tx`INSERT INTO operation_idempotency(owner_id,operation,idempotency_key,payload_hash,result_id) VALUES(${ownerId},'conversation.create',${idempotencyKey},${fingerprint},${
          String(rows[0].id)
        })`;
      }
      return conversation(rows[0]);
    });
  }
  async listConversations(ownerId: string, includeDeleted = false) {
    const rows = includeDeleted
      ? await this.#sql<
        Row[]
      >`SELECT * FROM conversations WHERE owner_id=${ownerId} ORDER BY updated_at DESC`
      : await this.#sql<
        Row[]
      >`SELECT * FROM conversations WHERE owner_id=${ownerId} AND deleted_at IS NULL ORDER BY updated_at DESC`;
    return rows.map(conversation);
  }
  async updateConversation(ownerId: string, id: string, patch: ConversationPatch) {
    const rows = await this.#sql<Row[]>`UPDATE conversations SET title=COALESCE(${
      patch.title ?? null
    },title),pinned=COALESCE(${patch.pinned ?? null},pinned),archived_at=CASE WHEN ${
      patch.archived ?? null
    }::boolean IS NULL THEN archived_at WHEN ${
      patch.archived ?? false
    } THEN now() ELSE NULL END,deleted_at=CASE WHEN ${
      patch.deleted ?? null
    }::boolean IS NULL THEN deleted_at WHEN ${
      patch.deleted ?? false
    } THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=${id} AND owner_id=${ownerId} RETURNING *`;
    if (!rows[0]) throw new DomainError("not_found", "Conversation not found", 404);
    return conversation(rows[0]);
  }
  async detail(id: string, ownerId: string) {
    const rows = await this.#sql<
      Row[]
    >`SELECT * FROM conversations WHERE id=${id} AND owner_id=${ownerId}`;
    if (!rows[0]) throw new DomainError("not_found", "Conversation not found", 404);
    const nodes = await this.#sql<
      Row[]
    >`SELECT * FROM messages WHERE conversation_id=${id} ORDER BY created_at,id`;
    return { ...conversation(rows[0]), messages: nodes.map(message) };
  }
  async appendMessage(input: AppendMessageInput) {
    return await this.#sql.begin(async (tx) => {
      const conversations = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.conversationId} AND owner_id=${input.ownerId} FOR UPDATE`;
      if (!conversations[0]) throw new DomainError("not_found", "Conversation not found", 404);
      if (conversations[0].deleted_at) {
        throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
      }
      if (conversations[0].archived_at) {
        throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
      }
      const existing = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.conversationId} AND idempotency_key=${input.idempotencyKey}`;
      if (existing[0]) {
        const prior = message(existing[0]);
        if (
          prior.parentId !== input.parentId ||
          prior.supersedesId !== (input.supersedesId ?? null) ||
          prior.role !== input.role || prior.content !== input.content ||
          prior.model !== (input.model ?? null)
        ) {
          throw new DomainError(
            "idempotency_conflict",
            "This idempotency key was used with a different message",
            409,
          );
        }
        return prior;
      }
      if (number(conversations[0].version) !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Conversation changed in another tab", 409);
      }
      if (input.parentId) {
        const parent = await tx<
          Row[]
        >`SELECT id FROM messages WHERE id=${input.parentId} AND conversation_id=${input.conversationId}`;
        if (!parent[0]) {
          throw new DomainError("invalid_parent", "Parent is not in this conversation", 422);
        }
      }
      if (input.supersedesId) {
        const sibling = await tx<
          Row[]
        >`SELECT id FROM messages WHERE id=${input.supersedesId} AND conversation_id=${input.conversationId} AND parent_id IS NOT DISTINCT FROM ${input.parentId}`;
        if (!sibling[0]) {
          throw new DomainError(
            "invalid_supersedes",
            "Edited messages must branch beside the original",
            422,
          );
        }
      }
      const indexRows = await tx<
        { next: number }[]
      >`SELECT count(*)::int AS next FROM messages WHERE conversation_id=${input.conversationId} AND parent_id IS NOT DISTINCT FROM ${input.parentId}`;
      const inserted = await tx<
        Row[]
      >`INSERT INTO messages(conversation_id,parent_id,supersedes_id,generation_id,sibling_index,role,content,model,metadata,idempotency_key) VALUES(${input.conversationId},${input.parentId},${
        input.supersedesId ?? null
      },${input.role === "assistant" ? crypto.randomUUID() : null},${
        indexRows[0].next
      },${input.role},${input.content},${input.model ?? null},${
        this.#sql.json((input.metadata ?? {}) as postgres.JSONValue)
      },${input.idempotencyKey}) RETURNING *`;
      const insertedId = String(inserted[0].id);
      await tx`UPDATE conversations SET active_leaf_id=${insertedId},version=version+1,updated_at=now() WHERE id=${input.conversationId}`;
      return message(inserted[0]);
    });
  }
  async beginGeneration(input: BeginGenerationInput) {
    const leaseSeconds = input.leaseSeconds ?? 120;
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new DomainError("validation_error", "Generation lease duration is invalid", 422);
    }
    return await this.#sql.begin(async (tx) => {
      const c = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.message.conversationId} AND owner_id=${input.message.ownerId} FOR UPDATE`;
      if (!c[0]) throw new DomainError("not_found", "Conversation not found", 404);
      if (c[0].deleted_at) {
        throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
      }
      if (c[0].archived_at) {
        throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
      }
      const prior = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.message.conversationId} AND idempotency_key=${input.message.idempotencyKey}`;
      const priorRun = await tx<
        Row[]
      >`SELECT *,generation_lease_expires_at>now() AS generation_lease_active,GREATEST(1,ceil(extract(epoch FROM (generation_lease_expires_at-now()))))::int AS generation_lease_retry_seconds FROM usage_runs WHERE id=${input.runId} FOR UPDATE`;
      if (prior[0] && priorRun[0]) {
        const replay = message(prior[0]);
        if (
          replay.content !== input.message.content || replay.parentId !== input.message.parentId ||
          replay.model !== (input.message.model ?? null) ||
          String(priorRun[0].user_id) !== input.message.ownerId
        ) {
          throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
        }
        if (priorRun[0].status === "failed") {
          throw new DomainError(
            "generation_failed_replay",
            "Failed generations require a new idempotency key",
            409,
          );
        }
        if (priorRun[0].status === "completed") {
          return {
            kind: "completed" as const,
            message: replay,
            conversation: conversation(c[0]),
            usageRun: run(priorRun[0]),
          };
        }
        if (priorRun[0].generation_lease_active === true) {
          return {
            kind: "in_progress" as const,
            message: replay,
            conversation: conversation(c[0]),
            usageRun: run(priorRun[0]),
            retryAfterSeconds: number(priorRun[0].generation_lease_retry_seconds),
          };
        }
        const leaseToken = crypto.randomUUID();
        const claimed = await tx<
          Row[]
        >`UPDATE usage_runs SET generation_lease_token=${leaseToken},generation_lease_expires_at=now()+${leaseSeconds}*interval '1 second' WHERE id=${input.runId} AND status='reserved' RETURNING *`;
        return {
          kind: "claimed" as const,
          leaseToken,
          message: replay,
          conversation: conversation(c[0]),
          usageRun: run(claimed[0]),
        };
      }
      if (prior[0] || priorRun[0]) {
        throw new DomainError("idempotency_conflict", "Incomplete generation replay", 409);
      }
      if (number(c[0].version) !== input.message.expectedVersion) {
        throw new DomainError("version_conflict", "Conversation changed in another tab", 409);
      }
      if (input.message.parentId) {
        const p =
          await tx`SELECT id FROM messages WHERE id=${input.message.parentId} AND conversation_id=${input.message.conversationId}`;
        if (!p.length) {
          throw new DomainError("invalid_parent", "Parent is not in this conversation", 422);
        }
      }
      if (input.message.supersedesId) {
        const s =
          await tx`SELECT id FROM messages WHERE id=${input.message.supersedesId} AND conversation_id=${input.message.conversationId} AND parent_id IS NOT DISTINCT FROM ${input.message.parentId}`;
        if (!s.length) {
          throw new DomainError(
            "invalid_supersedes",
            "Edited messages must branch beside the original",
            422,
          );
        }
      }
      const account = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.message.ownerId} FOR UPDATE`;
      const balance = number(account[0].balance_micros);
      if (balance < input.reserveMicros) {
        throw new DomainError("insufficient_credit", "Insufficient credit", 402);
      }
      const idx = await tx<
        { next: number }[]
      >`SELECT count(*)::int next FROM messages WHERE conversation_id=${input.message.conversationId} AND parent_id IS NOT DISTINCT FROM ${input.message.parentId}`;
      const nodes = await tx<
        Row[]
      >`INSERT INTO messages(conversation_id,parent_id,supersedes_id,sibling_index,role,content,model,metadata,idempotency_key) VALUES(${input.message.conversationId},${input.message.parentId},${
        input.message.supersedesId ?? null
      },${idx[0].next},${input.message.role},${input.message.content},${
        input.message.model ?? null
      },${
        tx.json((input.message.metadata ?? {}) as postgres.JSONValue)
      },${input.message.idempotencyKey}) RETURNING *`;
      const leaseToken = crypto.randomUUID();
      const runs = await tx<
        Row[]
      >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,status,reserved_micros,generation_lease_token,generation_lease_expires_at) VALUES(${input.runId},${input.message.ownerId},${
        input.tokenId ?? null
      },${
        input.message.model ?? "unknown"
      },${input.provider},'reserved',${input.reserveMicros},${leaseToken},now()+${leaseSeconds}*interval '1 second') RETURNING *`;
      const after = balance - input.reserveMicros;
      await tx`UPDATE users SET balance_micros=${after} WHERE id=${input.message.ownerId}`;
      await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.message.ownerId},${input.runId},'reserve',${-input
        .reserveMicros},${after})`;
      const updated = await tx<Row[]>`UPDATE conversations SET active_leaf_id=${
        String(nodes[0].id)
      },version=version+1,updated_at=now() WHERE id=${input.message.conversationId} RETURNING *`;
      return {
        kind: "started" as const,
        leaseToken,
        message: message(nodes[0]),
        conversation: conversation(updated[0]),
        usageRun: run(runs[0]),
      };
    });
  }

  async heartbeatGeneration(
    runId: string,
    ownerId: string,
    leaseToken: string,
    leaseSeconds = 120,
  ) {
    const rows = await this
      .#sql`UPDATE usage_runs SET generation_lease_expires_at=now()+${leaseSeconds}*interval '1 second' WHERE id=${runId} AND user_id=${ownerId} AND status='reserved' AND generation_lease_token=${leaseToken} AND generation_lease_expires_at>now() RETURNING id`;
    if (!rows.length) {
      throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
    }
  }

  async completeGeneration(input: CompleteGenerationInput) {
    return await this.#sql.begin(async (tx) => {
      const c = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.conversationId} AND owner_id=${input.ownerId} FOR UPDATE`;
      const runs = await tx<
        Row[]
      >`SELECT *,generation_lease_expires_at>now() AS generation_lease_active FROM usage_runs WHERE id=${input.runId} AND user_id=${input.ownerId} FOR UPDATE`;
      if (!c[0] || !runs[0]) throw new DomainError("not_found", "Generation not found", 404);
      const existing = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.conversationId} AND idempotency_key=${input.idempotencyKey}`;
      if (existing[0] && runs[0].status === "completed") {
        const replay = message(existing[0]);
        if (
          replay.content !== input.content || replay.parentId !== input.userMessageId ||
          replay.model !== input.model
        ) throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
        return {
          message: replay,
          conversation: conversation(c[0]),
          usageRun: run(runs[0]),
        };
      }
      if (runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Generation is not reserved", 409);
      }
      if (
        String(runs[0].generation_lease_token) !== input.leaseToken ||
        runs[0].generation_lease_active !== true
      ) throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
      const parent =
        await tx`SELECT id FROM messages WHERE id=${input.userMessageId} AND conversation_id=${input.conversationId}`;
      if (!parent.length) throw new DomainError("not_found", "Generation message not found", 404);
      const account = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.ownerId} FOR UPDATE`;
      const delta = number(runs[0].reserved_micros) - input.costMicros;
      const after = number(account[0].balance_micros) + delta;
      if (after < 0) {
        throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
      }
      const idx = await tx<
        { next: number }[]
      >`SELECT count(*)::int next FROM messages WHERE conversation_id=${input.conversationId} AND parent_id=${input.userMessageId}`;
      const nodes = await tx<
        Row[]
      >`INSERT INTO messages(conversation_id,parent_id,generation_id,sibling_index,role,content,model,metadata,idempotency_key) VALUES(${input.conversationId},${input.userMessageId},${crypto.randomUUID()},${
        idx[0].next
      },'assistant',${input.content},${input.model},${
        tx.json((input.metadata ?? {}) as postgres.JSONValue)
      },${input.idempotencyKey}) RETURNING *`;
      await tx`UPDATE users SET balance_micros=${after} WHERE id=${input.ownerId}`;
      if (delta !== 0) {
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.ownerId},${input.runId},${
          delta > 0 ? "refund" : "settle"
        },${delta},${after})`;
      }
      const finished = await tx<
        Row[]
      >`UPDATE usage_runs SET status='completed',generation_lease_token=NULL,generation_lease_expires_at=NULL,cost_micros=${input.costMicros},input_tokens=${input.inputTokens},output_tokens=${input.outputTokens},latency_ms=${input.latencyMs},completed_at=now() WHERE id=${input.runId} RETURNING *`;
      const updated = await tx<
        Row[]
      >`UPDATE conversations SET active_leaf_id=CASE WHEN active_leaf_id=${input.userMessageId} THEN ${
        String(nodes[0].id)
      } ELSE active_leaf_id END,version=version+1,updated_at=now() WHERE id=${input.conversationId} RETURNING *`;
      return {
        message: message(nodes[0]),
        conversation: conversation(updated[0]),
        usageRun: run(finished[0]),
      };
    });
  }

  async failGeneration(input: FailGenerationInput) {
    return await this.#sql.begin(async (tx) => {
      const c = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.conversationId} AND owner_id=${input.ownerId} FOR UPDATE`;
      const runs = await tx<
        Row[]
      >`SELECT *,generation_lease_expires_at>now() AS generation_lease_active FROM usage_runs WHERE id=${input.runId} AND user_id=${input.ownerId} FOR UPDATE`;
      if (!c[0] || !runs[0]) throw new DomainError("not_found", "Generation not found", 404);
      const existing = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.conversationId} AND idempotency_key=${input.idempotencyKey}`;
      if (existing[0] && runs[0].status === "failed") {
        const replay = message(existing[0]);
        if (
          replay.content !== input.error || replay.parentId !== input.userMessageId ||
          replay.model !== input.model
        ) throw new DomainError("idempotency_conflict", "Generation replay payload differs", 409);
        return {
          message: replay,
          conversation: conversation(c[0]),
          usageRun: run(runs[0]),
        };
      }
      if (runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Generation is not reserved", 409);
      }
      if (
        String(runs[0].generation_lease_token) !== input.leaseToken ||
        runs[0].generation_lease_active !== true
      ) throw new DomainError("stale_lease", "Generation lease is no longer active", 409);
      const account = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.ownerId} FOR UPDATE`;
      const after = number(account[0].balance_micros) + number(runs[0].reserved_micros);
      const idx = await tx<
        { next: number }[]
      >`SELECT count(*)::int next FROM messages WHERE conversation_id=${input.conversationId} AND parent_id=${input.userMessageId}`;
      const nodes = await tx<
        Row[]
      >`INSERT INTO messages(conversation_id,parent_id,generation_id,sibling_index,role,content,model,status,metadata,idempotency_key) VALUES(${input.conversationId},${input.userMessageId},${crypto.randomUUID()},${
        idx[0].next
      },'assistant',${input.error},${input.model},'error',${
        tx.json({ generationError: input.error, retryable: true })
      },${input.idempotencyKey}) RETURNING *`;
      await tx`UPDATE users SET balance_micros=${after} WHERE id=${input.ownerId}`;
      await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.ownerId},${input.runId},'refund',${
        number(runs[0].reserved_micros)
      },${after})`;
      const failed = await tx<
        Row[]
      >`UPDATE usage_runs SET status='failed',generation_lease_token=NULL,generation_lease_expires_at=NULL,error=${input.error},completed_at=now() WHERE id=${input.runId} RETURNING *`;
      const updated = await tx<
        Row[]
      >`UPDATE conversations SET active_leaf_id=CASE WHEN active_leaf_id=${input.userMessageId} THEN ${
        String(nodes[0].id)
      } ELSE active_leaf_id END,version=version+1,updated_at=now() WHERE id=${input.conversationId} RETURNING *`;
      return {
        message: message(nodes[0]),
        conversation: conversation(updated[0]),
        usageRun: run(failed[0]),
      };
    });
  }
  async reapStaleGenerations(limit = 100) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT * FROM usage_runs WHERE status='reserved' AND generation_lease_token IS NOT NULL AND generation_lease_expires_at<=now() ORDER BY generation_lease_expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      for (const row of rows) {
        const userId = String(row.user_id);
        const account = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        const amount = number(row.reserved_micros);
        const after = number(account[0].balance_micros) + amount;
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
          String(row.id)
        },'refund',${amount},${after})`;
        await tx`UPDATE usage_runs SET status='failed',generation_lease_token=NULL,generation_lease_expires_at=NULL,error='generation lease expired',completed_at=now() WHERE id=${
          String(row.id)
        }`;
      }
      return rows.length;
    });
  }
  async setActiveLeaf(
    conversationId: string,
    ownerId: string,
    leafId: string,
    expectedVersion: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${conversationId} AND owner_id=${ownerId} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Conversation not found", 404);
      if (rows[0].deleted_at) {
        throw new DomainError("conversation_deleted", "Deleted conversations are read-only", 409);
      }
      if (rows[0].archived_at) {
        throw new DomainError("conversation_archived", "Archived conversations are read-only", 409);
      }
      if (number(rows[0].version) !== expectedVersion) {
        throw new DomainError("version_conflict", "Conversation changed in another tab", 409);
      }
      const leaves = await tx<
        Row[]
      >`SELECT m.id FROM messages m WHERE m.id=${leafId} AND m.conversation_id=${conversationId} AND NOT EXISTS(SELECT 1 FROM messages child WHERE child.parent_id=m.id)`;
      if (!leaves[0]) {
        throw new DomainError("invalid_leaf", "Active branch must end at a leaf", 422);
      }
      const updated = await tx<
        Row[]
      >`UPDATE conversations SET active_leaf_id=${leafId},version=version+1,updated_at=now() WHERE id=${conversationId} RETURNING *`;
      return conversation(updated[0]);
    });
  }

  async createApiToken(userId: string, input: CreateApiTokenInput) {
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO api_tokens(user_id,name,token_hash,preview,scopes,expires_at) VALUES(${userId},${input.name},${input.tokenHash},${input.preview},${
      this.#sql.json(input.scopes)
    },${input.expiresAt ?? null}) RETURNING *`;
    return token(rows[0]);
  }
  async findApiTokenByHash(hash: string) {
    const rows = await this.#sql<
      Row[]
    >`UPDATE api_tokens SET last_used_at=now() WHERE token_hash=${hash} RETURNING *`;
    return rows[0] ? token(rows[0]) : undefined;
  }
  async listApiTokens(userId: string) {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM api_tokens WHERE user_id=${userId} ORDER BY created_at DESC`).map((row) => {
      const { tokenHash: _hash, userId: _userId, ...summary } = token(row);
      return summary;
    });
  }
  async revokeApiToken(id: string, userId: string) {
    const rows = await this
      .#sql`UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id} AND user_id=${userId} RETURNING id`;
    if (!rows.length) throw new DomainError("not_found", "Token not found", 404);
  }

  async reserve(
    userId: string,
    runId: string,
    model: string,
    amount: number,
    provider = "unknown",
    tokenId?: string,
  ) {
    return await this.#sql.begin(async (tx) => {
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      if (!users[0]) throw new DomainError("not_found", "User not found", 404);
      const balance = number(users[0].balance_micros);
      if (balance < amount) {
        throw new DomainError("insufficient_credit", "Insufficient credit", 402);
      }
      try {
        const runs = await tx<
          Row[]
        >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,status,reserved_micros) VALUES(${runId},${userId},${
          tokenId ?? null
        },${model},${provider},'reserved',${amount}) RETURNING *`;
        const after = balance - amount;
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${runId},'reserve',${-amount},${after})`;
        return run(runs[0]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new DomainError(
            "idempotency_conflict",
            "This idempotency key has already been used",
            409,
          );
        }
        throw error;
      }
    });
  }
  async settle(
    runId: string,
    cost: number,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
  ) {
    return await this.#sql.begin(async (tx) => {
      const runs = await tx<Row[]>`SELECT * FROM usage_runs WHERE id=${runId} FOR UPDATE`;
      if (!runs[0]) throw new DomainError("not_found", "Usage reservation not found", 404);
      if (runs[0].status === "completed") return run(runs[0]);
      if (runs[0].status !== "reserved") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      const reserved = number(runs[0].reserved_micros);
      const delta = reserved - cost;
      const userId = String(runs[0].user_id);
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      const after = number(users[0].balance_micros) + delta;
      if (after < 0) {
        throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
      }
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
      if (delta !== 0) {
        await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${runId},${
          delta > 0 ? "refund" : "settle"
        },${delta},${after})`;
      }
      const updated = await tx<
        Row[]
      >`UPDATE usage_runs SET status='completed',cost_micros=${cost},input_tokens=${inputTokens},output_tokens=${outputTokens},latency_ms=${latencyMs},completed_at=now() WHERE id=${runId} RETURNING *`;
      return run(updated[0]);
    });
  }
  async refund(runId: string, error?: string) {
    return await this.#sql.begin(async (tx) => {
      const runs = await tx<Row[]>`SELECT * FROM usage_runs WHERE id=${runId} FOR UPDATE`;
      if (!runs[0]) return undefined;
      if (runs[0].status !== "reserved") return run(runs[0]);
      const userId = String(runs[0].user_id);
      const users = await tx<Row[]>`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
      const after = number(users[0].balance_micros) + number(runs[0].reserved_micros);
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
      await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${runId},'refund',${
        number(runs[0].reserved_micros)
      },${after})`;
      const updated = await tx<Row[]>`UPDATE usage_runs SET status='failed',error=${
        error ?? null
      },completed_at=now() WHERE id=${runId} RETURNING *`;
      return run(updated[0]);
    });
  }
  async beginApiRequest(input: BeginApiRequestInput): Promise<BeginApiRequestResult> {
    const leaseSeconds = input.leaseSeconds ?? 120;
    const retentionSeconds = input.retentionSeconds ?? 86400;
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new DomainError("validation_error", "Idempotency key length is invalid", 422);
    }
    if (!/^[0-9a-f]{64}$/.test(input.requestHash)) {
      throw new DomainError("validation_error", "Request fingerprint must be SHA-256 hex", 422);
    }
    if (
      input.reserveMicros < 0 || leaseSeconds < 1 || retentionSeconds < 60 ||
      retentionSeconds > 2_592_000
    ) throw new DomainError("validation_error", "Invalid idempotent request parameters", 422);
    return await this.#sql.begin(async (tx) => {
      const users = await tx<
        Row[]
      >`SELECT balance_micros FROM users WHERE id=${input.userId} FOR UPDATE`;
      if (!users[0]) throw new DomainError("not_found", "User not found", 404);
      await tx`DELETE FROM api_idempotency_requests WHERE user_id=${input.userId} AND endpoint=${input.endpoint} AND idempotency_key=${input.idempotencyKey} AND state<>'in_progress' AND expires_at<=now()`;
      const leaseToken = crypto.randomUUID();
      const id = crypto.randomUUID();
      const inserted = await tx<
        Row[]
      >`INSERT INTO api_idempotency_requests(id,user_id,endpoint,idempotency_key,request_hash,stream,model,state,lease_token,lease_expires_at,usage_run_id,retention_seconds,expires_at) VALUES(${id},${input.userId},${input.endpoint},${input.idempotencyKey},${input.requestHash},${input.stream},${input.model},'in_progress',${leaseToken},now()+${leaseSeconds}*interval '1 second',${input.runId},${retentionSeconds},now()+${retentionSeconds}*interval '1 second') ON CONFLICT(user_id,endpoint,idempotency_key) DO NOTHING RETURNING *`;
      if (!inserted[0]) {
        const rows = await tx<
          Row[]
        >`SELECT * FROM api_idempotency_requests WHERE user_id=${input.userId} AND endpoint=${input.endpoint} AND idempotency_key=${input.idempotencyKey}`;
        const row = rows[0];
        if (
          String(row.request_hash) !== input.requestHash || Boolean(row.stream) !== input.stream
        ) {
          throw new DomainError("idempotency_conflict", "Idempotency key payload differs", 409);
        }
        const events = await tx<Row[]>`SELECT * FROM api_idempotency_events WHERE request_id=${
          String(row.id)
        } ORDER BY sequence`;
        const request = apiRequest(row, events.map(apiFrame));
        if (request.state === "completed" || request.state === "failed") {
          return { kind: request.state, request };
        }
        return {
          kind: "in_progress",
          request,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((Date.parse(request.leaseExpiresAt!) - Date.now()) / 1000),
          ),
        };
      }
      const quota = replayQuota(input.quota);
      const live = await tx<
        { count: number }[]
      >`SELECT count(*)::int count FROM api_idempotency_requests WHERE user_id=${input.userId} AND expires_at>now()`;
      if (live[0].count > quota.maxRequests) {
        throw new DomainError("replay_quota_exceeded", "Replay request quota exceeded", 429);
      }
      const balance = number(users[0].balance_micros);
      if (balance < input.reserveMicros) {
        throw new DomainError("insufficient_credit", "Insufficient credit", 402);
      }
      const runs = await tx<
        Row[]
      >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,status,reserved_micros) VALUES(${input.runId},${input.userId},${
        input.tokenId ?? null
      },${input.model},${input.provider},'reserved',${input.reserveMicros}) RETURNING *`;
      const after = balance - input.reserveMicros;
      await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${input.userId}`;
      await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.userId},${input.runId},'reserve',${-input
        .reserveMicros},${after})`;
      return {
        kind: "started",
        request: apiRequest(inserted[0]),
        leaseToken,
        usageRun: run(runs[0]),
      };
    });
  }
  async getApiRequest(userId: string, endpoint: ApiIdempotencyEndpoint, idempotencyKey: string) {
    const rows = await this.#sql<
      Row[]
    >`SELECT * FROM api_idempotency_requests WHERE user_id=${userId} AND endpoint=${endpoint} AND idempotency_key=${idempotencyKey} AND expires_at>now()`;
    if (!rows[0]) return undefined;
    const events = await this.#sql<Row[]>`SELECT * FROM api_idempotency_events WHERE request_id=${
      String(rows[0].id)
    } ORDER BY sequence`;
    return apiRequest(rows[0], events.map(apiFrame));
  }
  async appendApiSseFrame(
    id: string,
    leaseToken: string,
    sequence: number,
    frame: string,
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
    quota?: ApiReplayQuota,
  ) {
    return await this.appendApiSseFrames(
      id,
      leaseToken,
      [{ sequence, frame }],
      leaseSeconds,
      observation,
      quota,
    );
  }
  async appendApiSseFrames(
    id: string,
    leaseToken: string,
    frames: ApiSseFrameInput[],
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
    quotaInput?: ApiReplayQuota,
  ) {
    if (frames.length === 0) {
      const request = await this.#sql<Row[]>`SELECT * FROM api_idempotency_requests WHERE id=${id}`;
      if (!request[0]) throw new DomainError("not_found", "Idempotent request not found", 404);
      const events = await this.#sql<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${id} ORDER BY sequence`;
      return apiRequest(request[0], events.map(apiFrame));
    }
    const encoder = new TextEncoder();
    const frameBytes = frames.map(({ frame }) => encoder.encode(frame).length);
    if (frameBytes.some((bytes) => bytes > 1_048_576)) {
      throw new DomainError("response_too_large", "SSE frame exceeds replay limit", 413);
    }
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT *,lease_expires_at>now() AS lease_active FROM api_idempotency_requests WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Idempotent request not found", 404);
      if (
        rows[0].state !== "in_progress" || String(rows[0].lease_token) !== leaseToken ||
        rows[0].lease_active !== true
      ) {
        throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
      }
      await tx`SELECT id FROM users WHERE id=${String(rows[0].user_id)} FOR UPDATE`;
      const stats = await tx<
        { count: number; bytes: number }[]
      >`SELECT count(*)::int count,COALESCE(sum(octet_length(frame)),0)::int bytes FROM api_idempotency_events WHERE request_id=${id}`;
      const firstSequence = Math.min(...frames.map(({ sequence }) => sequence));
      const lastSequence = Math.max(...frames.map(({ sequence }) => sequence));
      const existing = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${id} AND sequence BETWEEN ${firstSequence} AND ${lastSequence} ORDER BY sequence`;
      const existingBySequence = new Map(existing.map((row) => [number(row.sequence), row]));
      const pending: ApiSseFrameInput[] = [];
      for (const item of frames) {
        const prior = existingBySequence.get(item.sequence);
        if (prior) {
          if (String(prior.frame) !== item.frame) {
            throw new DomainError("sequence_conflict", "SSE frame sequence payload differs", 409);
          }
          continue;
        }
        if (item.sequence !== stats[0].count + pending.length) {
          throw new DomainError("sequence_conflict", "SSE replay sequence is not contiguous", 409);
        }
        pending.push(item);
      }
      const pendingBytes = pending.reduce(
        (sum, item) => sum + encoder.encode(item.frame).length,
        0,
      );
      if (stats[0].count + pending.length > 10_000 || stats[0].bytes + pendingBytes > 16_777_216) {
        throw new DomainError("response_too_large", "SSE replay exceeds storage limit", 413);
      }
      const quota = replayQuota(quotaInput);
      const aggregate = await tx<
        { events: number; bytes: number }[]
      >`SELECT
        (SELECT count(*)::int FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${
        String(rows[0].user_id)
      } AND r.expires_at>now()) events,
        ((SELECT COALESCE(sum(octet_length(e.frame)),0)::bigint FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${
        String(rows[0].user_id)
      } AND r.expires_at>now()) +
         (SELECT COALESCE(sum(octet_length(response_body)),0)::bigint FROM api_idempotency_requests WHERE user_id=${
        String(rows[0].user_id)
      } AND expires_at>now())) bytes`;
      if (
        number(aggregate[0].events) + pending.length > quota.maxEvents ||
        number(aggregate[0].bytes) + pendingBytes > quota.maxBytes
      ) throw new DomainError("replay_quota_exceeded", "User replay storage quota exceeded", 429);
      if (pending.length > 0) {
        await tx`INSERT INTO api_idempotency_events ${
          tx(
            pending.map((item) => ({ request_id: id, sequence: item.sequence, frame: item.frame })),
            "request_id",
            "sequence",
            "frame",
          )
        }`;
      }
      const updated = await tx<
        Row[]
      >`UPDATE api_idempotency_requests SET lease_expires_at=now()+${leaseSeconds}*interval '1 second',observed_input_tokens=GREATEST(observed_input_tokens,${
        observation?.inputTokens ?? 0
      }),observed_output_tokens=GREATEST(observed_output_tokens,${
        observation?.outputTokens ?? 0
      }),observed_cost_micros=GREATEST(observed_cost_micros,${
        observation?.costMicros ?? 0
      }),observed_latency_ms=GREATEST(observed_latency_ms,${
        observation?.latencyMs ?? 0
      }),updated_at=now() WHERE id=${id} RETURNING *`;
      const events = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${id} ORDER BY sequence`;
      return apiRequest(updated[0], events.map(apiFrame));
    });
  }
  async heartbeatApiRequest(
    id: string,
    leaseToken: string,
    leaseSeconds = 120,
    observation?: ApiUsageObservation,
  ) {
    const rows = await this
      .#sql`UPDATE api_idempotency_requests SET lease_expires_at=now()+${leaseSeconds}*interval '1 second',observed_input_tokens=GREATEST(observed_input_tokens,${
      observation?.inputTokens ?? 0
    }),observed_output_tokens=GREATEST(observed_output_tokens,${
      observation?.outputTokens ?? 0
    }),observed_cost_micros=GREATEST(observed_cost_micros,${
      observation?.costMicros ?? 0
    }),observed_latency_ms=GREATEST(observed_latency_ms,${
      observation?.latencyMs ?? 0
    }),updated_at=now() WHERE id=${id} AND state='in_progress' AND lease_token=${leaseToken} AND lease_expires_at>now() RETURNING id`;
    if (!rows.length) {
      throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
    }
  }
  async #completeApi(input: CompleteApiRequestInput, stream: boolean) {
    if (input.responseBody && new TextEncoder().encode(input.responseBody).length > 16_777_216) {
      throw new DomainError("response_too_large", "Replay response exceeds storage limit", 413);
    }
    return await this.#sql.begin(async (tx) => {
      const requests = await tx<
        Row[]
      >`SELECT *,lease_expires_at>now() AS lease_active FROM api_idempotency_requests WHERE id=${input.id} FOR UPDATE`;
      if (!requests[0]) throw new DomainError("not_found", "Idempotent request not found", 404);
      const row = requests[0];
      if (row.state === "completed") {
        if (
          number(row.response_status) !== input.responseStatus ||
          String(row.response_body ?? "") !== (input.responseBody ?? "")
        ) throw new DomainError("idempotency_conflict", "Completion replay payload differs", 409);
        const events = await tx<
          Row[]
        >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} ORDER BY sequence`;
        return apiRequest(row, events.map(apiFrame));
      }
      if (
        row.state !== "in_progress" || String(row.lease_token) !== input.leaseToken ||
        row.lease_active !== true
      ) {
        throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
      }
      if (!stream && input.frames?.length) {
        throw new DomainError("validation_error", "JSON completion cannot include SSE frames", 422);
      }
      const encoder = new TextEncoder();
      const stats = await tx<
        { count: number; bytes: number }[]
      >`SELECT count(*)::int count,COALESCE(sum(octet_length(frame)),0)::int bytes FROM api_idempotency_events WHERE request_id=${input.id}`;
      const frameInputs = input.frames ?? [];
      if (frameInputs.some(({ frame }) => encoder.encode(frame).length > 1_048_576)) {
        throw new DomainError("response_too_large", "SSE frame exceeds replay limit", 413);
      }
      const existingBySequence = new Map<number, Row>();
      if (frameInputs.length > 0) {
        const first = Math.min(...frameInputs.map(({ sequence }) => sequence));
        const last = Math.max(...frameInputs.map(({ sequence }) => sequence));
        const existing = await tx<
          Row[]
        >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} AND sequence BETWEEN ${first} AND ${last}`;
        for (const event of existing) existingBySequence.set(number(event.sequence), event);
      }
      const pending: ApiSseFrameInput[] = [];
      for (const item of frameInputs) {
        const prior = existingBySequence.get(item.sequence);
        if (prior) {
          if (String(prior.frame) !== item.frame) {
            throw new DomainError("sequence_conflict", "SSE frame sequence payload differs", 409);
          }
          continue;
        }
        if (item.sequence !== stats[0].count + pending.length) {
          throw new DomainError("sequence_conflict", "SSE replay sequence is not contiguous", 409);
        }
        pending.push(item);
      }
      const pendingBytes = pending.reduce(
        (sum, item) => sum + encoder.encode(item.frame).length,
        0,
      );
      const terminalBytes = input.terminalFrame ? encoder.encode(input.terminalFrame).length : 0;
      if (terminalBytes > 1_048_576) {
        throw new DomainError("response_too_large", "Terminal SSE frame exceeds replay limit", 413);
      }
      if (
        stats[0].count + pending.length + (input.terminalFrame ? 1 : 0) > 10_000 ||
        stats[0].bytes + pendingBytes + terminalBytes > 16_777_216
      ) throw new DomainError("response_too_large", "SSE replay exceeds storage limit", 413);
      const quota = replayQuota(input.quota);
      await tx`SELECT id FROM users WHERE id=${String(row.user_id)} FOR UPDATE`;
      const aggregate = await tx<
        { events: number; bytes: number }[]
      >`SELECT
        (SELECT count(*)::int FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${
        String(row.user_id)
      } AND r.expires_at>now()) events,
        ((SELECT COALESCE(sum(octet_length(e.frame)),0)::bigint FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${
        String(row.user_id)
      } AND r.expires_at>now()) +
         (SELECT COALESCE(sum(octet_length(response_body)),0)::bigint FROM api_idempotency_requests WHERE user_id=${
        String(row.user_id)
      } AND expires_at>now())) bytes`;
      const responseBytes = input.responseBody
        ? new TextEncoder().encode(input.responseBody).length
        : 0;
      if (
        number(aggregate[0].events) + pending.length + (input.terminalFrame ? 1 : 0) >
          quota.maxEvents ||
        number(aggregate[0].bytes) + responseBytes + pendingBytes + terminalBytes > quota.maxBytes
      ) throw new DomainError("replay_quota_exceeded", "User replay storage quota exceeded", 429);
      const completingFrames = [...pending];
      if (stream && input.terminalFrame !== undefined) {
        completingFrames.push({
          sequence: stats[0].count + pending.length,
          frame: input.terminalFrame,
        });
      }
      if (completingFrames.length > 0) {
        await tx`INSERT INTO api_idempotency_events ${
          tx(
            completingFrames.map((item) => ({
              request_id: input.id,
              sequence: item.sequence,
              frame: item.frame,
            })),
            "request_id",
            "sequence",
            "frame",
          )
        }`;
      }
      const runs = await tx<Row[]>`SELECT * FROM usage_runs WHERE id=${
        String(row.usage_run_id)
      } FOR UPDATE`;
      if (!runs[0]) throw new DomainError("not_found", "Usage reservation not found", 404);
      if (runs[0].status === "reserved") {
        const reserved = number(runs[0].reserved_micros);
        const delta = reserved - input.costMicros;
        const userId = String(row.user_id);
        const users = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        const after = number(users[0].balance_micros) + delta;
        if (after < 0) {
          throw new DomainError("insufficient_credit", "Actual cost exceeds available credit", 402);
        }
        await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
        if (delta !== 0) {
          await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
            String(row.usage_run_id)
          },${delta > 0 ? "refund" : "settle"},${delta},${after})`;
        }
        await tx`UPDATE usage_runs SET status='completed',cost_micros=${input.costMicros},input_tokens=${input.inputTokens},output_tokens=${input.outputTokens},latency_ms=${input.latencyMs},completed_at=now() WHERE id=${
          String(row.usage_run_id)
        }`;
      } else if (runs[0].status !== "completed") {
        throw new DomainError("invalid_usage_state", "Usage run is not reserved", 409);
      }
      const updated = await tx<
        Row[]
      >`UPDATE api_idempotency_requests SET state='completed',lease_token=NULL,lease_expires_at=NULL,response_status=${input.responseStatus},response_headers=${
        tx.json((input.responseHeaders ?? {}) as postgres.JSONValue)
      },response_body=${
        input.responseBody ?? null
      },completed_at=now(),updated_at=now(),expires_at=now()+retention_seconds*interval '1 second' WHERE id=${input.id} RETURNING *`;
      const events = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} ORDER BY sequence`;
      return apiRequest(updated[0], events.map(apiFrame));
    });
  }
  completeApiJson(input: CompleteApiRequestInput) {
    return this.#completeApi(input, false);
  }
  completeApiStream(input: CompleteApiRequestInput) {
    return this.#completeApi(input, true);
  }
  async failApiRequest(input: FailApiRequestInput) {
    if (new TextEncoder().encode(input.responseBody).length > 16_777_216) {
      throw new DomainError("response_too_large", "Replay response exceeds storage limit", 413);
    }
    return await this.#sql.begin(async (tx) => {
      const requests = await tx<
        Row[]
      >`SELECT *,lease_expires_at>now() AS lease_active FROM api_idempotency_requests WHERE id=${input.id} FOR UPDATE`;
      if (!requests[0]) throw new DomainError("not_found", "Idempotent request not found", 404);
      const row = requests[0];
      if (row.state === "failed") {
        const events = await tx<
          Row[]
        >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} ORDER BY sequence`;
        return apiRequest(row, events.map(apiFrame));
      }
      if (
        row.state !== "in_progress" || String(row.lease_token) !== input.leaseToken ||
        row.lease_active !== true
      ) {
        throw new DomainError("stale_lease", "Idempotent request lease is no longer active", 409);
      }
      let eventCount = 0;
      const stats = await tx<
        { count: number; bytes: number }[]
      >`SELECT count(*)::int count,COALESCE(sum(octet_length(frame)),0)::int bytes FROM api_idempotency_events WHERE request_id=${input.id}`;
      eventCount = stats[0].count;
      const failureStartedStream = eventCount > 0 || input.terminalFrame !== undefined;
      if (input.terminalFrame !== undefined) {
        const terminalBytes = new TextEncoder().encode(input.terminalFrame).length;
        if (terminalBytes > 1_048_576 || stats[0].bytes + terminalBytes > 16_777_216) {
          throw new DomainError(
            "response_too_large",
            "Terminal SSE frame exceeds replay limit",
            413,
          );
        }
        await tx`INSERT INTO api_idempotency_events(request_id,sequence,frame) VALUES(${input.id},${eventCount},${input.terminalFrame})`;
        eventCount++;
      }
      const runs = await tx<Row[]>`SELECT * FROM usage_runs WHERE id=${
        String(row.usage_run_id)
      } FOR UPDATE`;
      if (runs[0]?.status === "reserved") {
        const userId = String(row.user_id);
        const users = await tx<
          Row[]
        >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
        if (input.billing.mode === "refund") {
          const amount = number(runs[0].reserved_micros);
          const after = number(users[0].balance_micros) + amount;
          await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
          await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
            String(row.usage_run_id)
          },'refund',${amount},${after})`;
          await tx`UPDATE usage_runs SET status='failed',error='idempotent request failed',completed_at=now() WHERE id=${
            String(row.usage_run_id)
          }`;
        } else {
          const delta = number(runs[0].reserved_micros) - input.billing.costMicros;
          const after = number(users[0].balance_micros) + delta;
          if (after < 0) {
            throw new DomainError(
              "insufficient_credit",
              "Actual cost exceeds available credit",
              402,
            );
          }
          await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
          if (delta !== 0) {
            await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
              String(row.usage_run_id)
            },${delta > 0 ? "refund" : "settle"},${delta},${after})`;
          }
          await tx`UPDATE usage_runs SET status='completed',cost_micros=${input.billing.costMicros},input_tokens=${input.billing.inputTokens},output_tokens=${input.billing.outputTokens},latency_ms=${input.billing.latencyMs},error='request failed after partial usage',completed_at=now() WHERE id=${
            String(row.usage_run_id)
          }`;
        }
      }
      const updated = await tx<
        Row[]
      >`UPDATE api_idempotency_requests SET state='failed',lease_token=NULL,lease_expires_at=NULL,response_status=${input.responseStatus},response_headers=${
        tx.json((input.responseHeaders ?? {}) as postgres.JSONValue)
      },response_body=${input.responseBody},failure_started_stream=${failureStartedStream},completed_at=now(),updated_at=now(),expires_at=now()+retention_seconds*interval '1 second' WHERE id=${input.id} RETURNING *`;
      const events = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_events WHERE request_id=${input.id} ORDER BY sequence`;
      return apiRequest(updated[0], events.map(apiFrame));
    });
  }
  async reapStaleApiRequests(limit = 100) {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT * FROM api_idempotency_requests WHERE state='in_progress' AND lease_expires_at<=now() ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      for (const row of rows) {
        const id = String(row.id);
        const runs = await tx<Row[]>`SELECT * FROM usage_runs WHERE id=${
          String(row.usage_run_id)
        } FOR UPDATE`;
        if (runs[0]?.status === "reserved") {
          const userId = String(row.user_id);
          const users = await tx<
            Row[]
          >`SELECT balance_micros FROM users WHERE id=${userId} FOR UPDATE`;
          const reserved = number(runs[0].reserved_micros);
          const observedCost = number(row.observed_cost_micros);
          const delta = observedCost > 0 ? reserved - observedCost : reserved;
          const after = number(users[0].balance_micros) + delta;
          if (after < 0) {
            throw new DomainError(
              "insufficient_credit",
              "Observed cost exceeds available credit",
              402,
            );
          }
          await tx`UPDATE users SET balance_micros=${after},updated_at=now() WHERE id=${userId}`;
          if (delta !== 0) {
            await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${userId},${
              String(row.usage_run_id)
            },${delta > 0 ? "refund" : "settle"},${delta},${after})`;
          }
          if (observedCost > 0) {
            await tx`UPDATE usage_runs SET status='completed',cost_micros=${observedCost},input_tokens=${
              number(row.observed_input_tokens)
            },output_tokens=${number(row.observed_output_tokens)},latency_ms=${
              number(row.observed_latency_ms)
            },error='request lease expired after partial usage',completed_at=now() WHERE id=${
              String(row.usage_run_id)
            }`;
          } else {
            await tx`UPDATE usage_runs SET status='failed',error='request lease expired',completed_at=now() WHERE id=${
              String(row.usage_run_id)
            }`;
          }
        }
        const stats = await tx<
          { count: number }[]
        >`SELECT count(*)::int count FROM api_idempotency_events WHERE request_id=${id}`;
        const errorBody = JSON.stringify({
          error: {
            message: "Request interrupted before completion",
            type: "server_error",
            param: null,
            code: "request_abandoned",
          },
        });
        if (stats[0].count > 0) {
          const frame = row.endpoint === "responses"
            ? `event: error\ndata: ${errorBody}\n\n`
            : `data: ${errorBody}\n\n`;
          await tx`INSERT INTO api_idempotency_events(request_id,sequence,frame) VALUES(${id},${
            stats[0].count
          },${frame})`;
        }
        await tx`UPDATE api_idempotency_requests SET state='failed',lease_token=NULL,lease_expires_at=NULL,response_status=500,response_headers='{"content-type":"application/json"}'::jsonb,response_body=${errorBody},failure_started_stream=${
          stats[0].count > 0
        },completed_at=now(),updated_at=now(),expires_at=now()+retention_seconds*interval '1 second' WHERE id=${id}`;
      }
      return rows.length;
    });
  }
  async pruneExpiredApiRequests(limit = 100) {
    const rows = await this
      .#sql`WITH doomed AS (SELECT id FROM api_idempotency_requests WHERE state<>'in_progress' AND expires_at<=now() ORDER BY expires_at LIMIT ${limit}) DELETE FROM api_idempotency_requests r USING doomed WHERE r.id=doomed.id RETURNING r.id`;
    return rows.length;
  }
  async usage(userId: string) {
    const rows = await this.#sql<
      Row[]
    >`SELECT u.balance_micros,count(r.id) FILTER(WHERE r.status='completed')::int calls,COALESCE(sum(r.input_tokens) FILTER(WHERE r.status='completed'),0)::bigint input_tokens,COALESCE(sum(r.output_tokens) FILTER(WHERE r.status='completed'),0)::bigint output_tokens,COALESCE(sum(r.cost_micros) FILTER(WHERE r.status='completed'),0)::bigint spent_micros FROM users u LEFT JOIN usage_runs r ON r.user_id=u.id WHERE u.id=${userId} GROUP BY u.id`;
    if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
    return {
      balanceMicros: number(rows[0].balance_micros),
      calls: number(rows[0].calls),
      inputTokens: number(rows[0].input_tokens),
      outputTokens: number(rows[0].output_tokens),
      spentMicros: number(rows[0].spent_micros),
    };
  }
  async listLedger(userId: string): Promise<LedgerEntry[]> {
    return (await this.#sql<
      Row[]
    >`SELECT * FROM ledger_entries WHERE user_id=${userId} ORDER BY created_at,id`).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      usageRunId: String(row.usage_run_id),
      kind: row.kind as LedgerEntry["kind"],
      amountMicros: number(row.amount_micros),
      balanceAfterMicros: number(row.balance_after_micros),
      createdAt: iso(row.created_at),
    }));
  }
  async enqueueJob(type: string, payload: unknown, availableAt?: string) {
    const rows = await this.#sql<
      Row[]
    >`INSERT INTO jobs(type,payload,available_at) VALUES(${type},${
      this.#sql.json(payload as postgres.JSONValue)
    },${availableAt ?? new Date().toISOString()}) RETURNING id`;
    return String(rows[0].id);
  }
  async adminSummary() {
    const totals = await this.#sql<
      Row[]
    >`SELECT (SELECT count(*)::int FROM usage_runs) calls,(SELECT count(*)::int FROM users) users,COALESCE((SELECT sum(balance_micros) FROM users),0)::bigint balance_micros`;
    return {
      calls: number(totals[0].calls),
      users: number(totals[0].users),
      balanceMicros: number(totals[0].balance_micros),
      ledger: await this.listAllLedger(),
    };
  }
  private async listAllLedger(): Promise<LedgerEntry[]> {
    return (await this.#sql<Row[]>`SELECT * FROM ledger_entries ORDER BY created_at,id`).map((
      row,
    ) => ({
      id: String(row.id),
      userId: String(row.user_id),
      usageRunId: String(row.usage_run_id),
      kind: row.kind as LedgerEntry["kind"],
      amountMicros: number(row.amount_micros),
      balanceAfterMicros: number(row.balance_after_micros),
      createdAt: iso(row.created_at),
    }));
  }
  async listJobs() {
    return (await this.#sql<Row[]>`SELECT * FROM jobs ORDER BY created_at DESC`).map((row) => ({
      id: String(row.id),
      type: String(row.type),
      payload: row.payload,
      status: String(row.status),
      attempts: number(row.attempts),
      createdAt: iso(row.created_at),
    }));
  }
  async readiness() {
    try {
      await this.#sql`SELECT 1`;
      return { ready: true, storage: this.storageKind };
    } catch {
      return { ready: false, storage: this.storageKind };
    }
  }
}
