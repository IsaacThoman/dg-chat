import postgres from "npm:postgres@3.4.7";
import type { Conversation, MessageNode } from "@dg-chat/contracts";
import type { LedgerEntry, StoredApiToken, StoredSession, StoredUser, UsageRun } from "./memory.ts";
import { DomainError } from "./memory.ts";

type LegacySnapshot = {
  users?: Array<[string, StoredUser]>;
  sessions?: Array<[string, StoredSession]>;
  tokens?: Array<[string, StoredApiToken]>;
  conversations?: Array<[string, Conversation]>;
  messages?: Array<[string, MessageNode]>;
  idempotency?: Array<[string, string]>;
  ledger?: LedgerEntry[];
  usageRuns?: Array<[string, UsageRun]>;
  jobs?: Array<
    {
      id: string;
      type: string;
      payload: unknown;
      status: string;
      attempts: number;
      createdAt: string;
    }
  >;
};

export interface LegacyBackfillResult {
  status: "imported" | "already_imported" | "no_snapshot";
  users: number;
  conversations: number;
  messages: number;
}

/**
 * Explicit one-time bridge from the legacy runtime_snapshots row to normalized tables.
 * Refuses mixed state instead of merging two sources of truth.
 */
export async function backfillLegacyRuntimeSnapshot(url: string): Promise<LegacyBackfillResult> {
  const sql = postgres(url, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-legacy-backfill'))`;
      const applied =
        await tx`SELECT name FROM repository_migrations WHERE name='legacy-runtime-snapshot-v1'`;
      if (applied.length) {
        return { status: "already_imported", users: 0, conversations: 0, messages: 0 };
      }
      const snapshots = await tx<
        { payload: LegacySnapshot }[]
      >`SELECT payload FROM runtime_snapshots WHERE id='primary'`;
      if (!snapshots[0]) return { status: "no_snapshot", users: 0, conversations: 0, messages: 0 };
      const occupied = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM users`;
      if (occupied[0].count !== 0) {
        throw new DomainError(
          "backfill_mixed_state",
          "Normalized users already exist; refusing legacy snapshot merge",
          409,
        );
      }
      const snapshot = snapshots[0].payload;
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      for (const [, value] of snapshot.users ?? []) {
        await tx`INSERT INTO users(id,email,name,password_hash,role,approval_status,state,balance_micros,created_at,updated_at) VALUES(${value.id},${value.email},${value.name},${value.passwordHash},${value.role},${value.approvalStatus},${value.state},${value.balanceMicros},${value.createdAt},${value.createdAt})`;
      }
      for (const [hash, value] of snapshot.sessions ?? []) {
        await tx`INSERT INTO sessions(user_id,token_hash,limited,expires_at) VALUES(${value.userId},${hash},${value.limited},${new Date(
          value.expiresAt,
        )})`;
      }
      for (const [, value] of snapshot.tokens ?? []) {
        await tx`INSERT INTO api_tokens(id,user_id,name,token_hash,preview,scopes,expires_at,revoked_at,last_used_at,created_at) VALUES(${value.id},${value.userId},${value.name},${value.tokenHash},${value.preview},${
          tx.json(value.scopes as postgres.JSONValue)
        },${value.expiresAt},${value.revokedAt},${value.lastUsedAt},${value.createdAt})`;
      }
      for (const [, value] of snapshot.conversations ?? []) {
        await tx`INSERT INTO conversations(id,owner_id,title,active_leaf_id,version,pinned,temporary,archived_at,deleted_at,created_at,updated_at) VALUES(${value.id},${value.ownerId},${value.title},NULL,${value.version},${value.pinned},${
          value.temporary ?? false
        },${value.archivedAt},${value.deletedAt},${value.createdAt},${value.updatedAt})`;
      }
      const idempotencyByMessage = new Map<string, string>();
      for (const [compound, messageId] of snapshot.idempotency ?? []) {
        idempotencyByMessage.set(messageId, compound.slice(compound.indexOf(":") + 1));
      }
      for (const [, value] of snapshot.messages ?? []) {
        await tx`INSERT INTO messages(id,conversation_id,parent_id,supersedes_id,generation_id,sibling_index,role,content,model,status,metadata,idempotency_key,created_at) VALUES(${value.id},${value.conversationId},${value.parentId},${value.supersedesId},${value.generationId},${value.siblingIndex},${value.role},${value.content},${value.model},${value.status},${
          tx.json(value.metadata as postgres.JSONValue)
        },${idempotencyByMessage.get(value.id) ?? `legacy:${value.id}`},${value.createdAt})`;
      }
      for (const [, value] of snapshot.conversations ?? []) {
        if (value.activeLeafId) {
          await tx`UPDATE conversations SET active_leaf_id=${value.activeLeafId} WHERE id=${value.id}`;
        }
      }
      for (const value of snapshot.ledger ?? []) {
        await tx`INSERT INTO ledger_entries(id,user_id,usage_run_id,kind,amount_micros,balance_after_micros,created_at) VALUES(${value.id},${value.userId},${value.usageRunId},${value.kind},${value.amountMicros},${value.balanceAfterMicros},${value.createdAt})`;
      }
      for (const [, value] of snapshot.usageRuns ?? []) {
        await tx`INSERT INTO usage_runs(id,user_id,model,provider,status,reserved_micros,input_tokens,output_tokens,cost_micros,latency_ms,created_at,completed_at) VALUES(${value.id},${value.userId},${value.model},'legacy',${value.status},${value.reservedMicros},${value.inputTokens},${value.outputTokens},${value.costMicros},${value.latencyMs},${value.createdAt},${
          value.status === "reserved" ? null : value.createdAt
        })`;
      }
      for (const value of snapshot.jobs ?? []) {
        await tx`INSERT INTO jobs(id,type,payload,status,attempts,created_at) VALUES(${value.id},${value.type},${
          tx.json(value.payload as postgres.JSONValue)
        },${value.status},${value.attempts},${value.createdAt})`;
      }
      await tx`INSERT INTO repository_migrations(name,metadata) VALUES('legacy-runtime-snapshot-v1',${
        tx.json({ revision: "primary" })
      })`;
      return {
        status: "imported",
        users: snapshot.users?.length ?? 0,
        conversations: snapshot.conversations?.length ?? 0,
        messages: snapshot.messages?.length ?? 0,
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
