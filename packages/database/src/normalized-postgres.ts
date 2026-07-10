import postgres from "npm:postgres@3.4.7";
import type { AccountState, Conversation, MessageNode, PublicUser } from "@dg-chat/contracts";
import { DomainError } from "./memory.ts";
import type { LedgerEntry, StoredApiToken, StoredSession, StoredUser, UsageRun } from "./memory.ts";
import type {
  AppendMessageInput,
  BeginGenerationInput,
  CompleteGenerationInput,
  ConversationPatch,
  CreateApiTokenInput,
  CreateUserInput,
  DomainRepository,
  FailGenerationInput,
} from "./repository.ts";

type Row = Record<string, unknown>;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const nullableIso = (value: unknown) => value == null ? null : iso(value);
const number = (value: unknown) => Number(value);

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
      >`INSERT INTO users (email,name,password_hash,role,approval_status,state,balance_micros) VALUES (${input.email},${input.name},${input.passwordHash},'admin','approved','active',${credit}) RETURNING *`;
      const userId = String(rows[0].id);
      await tx`INSERT INTO ledger_entries (user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES (${userId},${`bootstrap:${userId}`},'grant',${credit},${credit})`;
      return user(rows[0]);
    });
  }
  async createUser(input: CreateUserInput) {
    try {
      const rows = await this.#sql<
        Row[]
      >`INSERT INTO users (email,name,password_hash,role,approval_status,state) VALUES (${input.email},${input.name},${input.passwordHash},${
        input.role ?? "user"
      },${input.approvalStatus ?? "pending"},${input.state ?? "active"}) RETURNING *`;
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
      tokenHash: String(rows[0].token_hash),
      userId: String(rows[0].user_id),
      limited: Boolean(rows[0].limited),
      expiresAt: new Date(rows[0].expires_at as string).getTime(),
    };
  }
  async getSession(tokenHash: string): Promise<StoredSession | undefined> {
    const rows = await this.#sql<
      Row[]
    >`SELECT * FROM sessions WHERE token_hash=${tokenHash} AND invalidated_at IS NULL AND expires_at>now()`;
    return rows[0]
      ? {
        tokenHash,
        userId: String(rows[0].user_id),
        limited: Boolean(rows[0].limited),
        expiresAt: new Date(rows[0].expires_at as string).getTime(),
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

  async approveUser(id: string, status: "approved" | "rejected", credit: number) {
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-final-admin'))`;
      const rows = await tx<Row[]>`SELECT * FROM users WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "User not found", 404);
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
    return await this.#sql.begin(async (tx) => {
      const c = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.message.conversationId} AND owner_id=${input.message.ownerId} FOR UPDATE`;
      if (!c[0]) throw new DomainError("not_found", "Conversation not found", 404);
      const prior = await tx<
        Row[]
      >`SELECT * FROM messages WHERE conversation_id=${input.message.conversationId} AND idempotency_key=${input.message.idempotencyKey}`;
      const priorRun = await tx<Row[]>`SELECT * FROM usage_runs WHERE id=${input.runId}`;
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
        return {
          message: replay,
          conversation: conversation(c[0]),
          usageRun: run(priorRun[0]),
          replayed: true,
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
      const runs = await tx<
        Row[]
      >`INSERT INTO usage_runs(id,user_id,token_id,model,provider,status,reserved_micros) VALUES(${input.runId},${input.message.ownerId},${
        input.tokenId ?? null
      },${
        input.message.model ?? "unknown"
      },${input.provider},'reserved',${input.reserveMicros}) RETURNING *`;
      const after = balance - input.reserveMicros;
      await tx`UPDATE users SET balance_micros=${after} WHERE id=${input.message.ownerId}`;
      await tx`INSERT INTO ledger_entries(user_id,usage_run_id,kind,amount_micros,balance_after_micros) VALUES(${input.message.ownerId},${input.runId},'reserve',${-input
        .reserveMicros},${after})`;
      const updated = await tx<Row[]>`UPDATE conversations SET active_leaf_id=${
        String(nodes[0].id)
      },version=version+1,updated_at=now() WHERE id=${input.message.conversationId} RETURNING *`;
      return {
        message: message(nodes[0]),
        conversation: conversation(updated[0]),
        usageRun: run(runs[0]),
        replayed: false,
      };
    });
  }

  async completeGeneration(input: CompleteGenerationInput) {
    return await this.#sql.begin(async (tx) => {
      const c = await tx<
        Row[]
      >`SELECT * FROM conversations WHERE id=${input.conversationId} AND owner_id=${input.ownerId} FOR UPDATE`;
      const runs = await tx<
        Row[]
      >`SELECT * FROM usage_runs WHERE id=${input.runId} AND user_id=${input.ownerId} FOR UPDATE`;
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
      >`UPDATE usage_runs SET status='completed',cost_micros=${input.costMicros},input_tokens=${input.inputTokens},output_tokens=${input.outputTokens},latency_ms=${input.latencyMs},completed_at=now() WHERE id=${input.runId} RETURNING *`;
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
      >`SELECT * FROM usage_runs WHERE id=${input.runId} AND user_id=${input.ownerId} FOR UPDATE`;
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
      >`UPDATE usage_runs SET status='failed',error=${input.error},completed_at=now() WHERE id=${input.runId} RETURNING *`;
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
