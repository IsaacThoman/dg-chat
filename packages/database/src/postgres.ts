import postgres from "npm:postgres@3.4.7";
import { MemoryRepository } from "./memory.ts";
import { logOperationalFailure } from "@dg-chat/contracts";

type Snapshot = {
  users: unknown[][];
  sessions: unknown[][];
  tokens: unknown[][];
  conversations: unknown[][];
  communityProfiles: unknown[][];
  messages: unknown[][];
  idempotency: unknown[][];
  ledger: unknown[];
  usageRuns: unknown[][];
  jobs: unknown[];
};

/**
 * Durable single-install repository adapter. Domain mutations stay synchronous and are checkpointed
 * as a serialized revision. This makes local self-hosting durable while the normalized schema remains
 * available for the multi-replica transactional adapter.
 */
export class PostgresStateRepository extends MemoryRepository {
  override readonly storageKind = "postgres";
  #sql: ReturnType<typeof postgres>;
  #revision = 0;
  #timer?: number;
  #lastPayload = "";

  private constructor(sql: ReturnType<typeof postgres>) {
    super();
    this.#sql = sql;
  }

  static async connect(url: string): Promise<PostgresStateRepository> {
    const sql = postgres(url, { max: 1 });
    try {
      const [lock] = await sql<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext('dg-chat-primary')) AS acquired
      `;
      if (!lock?.acquired) {
        throw new Error("Another DG Chat API replica already owns this database");
      }
      const repository = new PostgresStateRepository(sql);
      await sql`CREATE TABLE IF NOT EXISTS runtime_snapshots (id text PRIMARY KEY, payload jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`;
      const rows = await sql<
        { payload: Snapshot; revision: number }[]
      >`SELECT payload, revision FROM runtime_snapshots WHERE id = 'primary'`;
      if (rows[0]) repository.#restore(rows[0].payload, Number(rows[0].revision));
      repository.#timer = setInterval(
        () =>
          repository.flush().catch(() => logOperationalFailure("database_repository_checkpoint")),
        250,
      ) as unknown as number;
      return repository;
    } catch (error) {
      await sql.end({ timeout: 0 }).catch(() => undefined);
      throw error;
    }
  }

  #restore(snapshot: Snapshot, revision: number) {
    for (const [key, value] of snapshot.users ?? []) this.users.set(String(key), value as never);
    for (const [key, value] of snapshot.sessions ?? []) {
      this.sessions.set(String(key), value as never);
    }
    for (const [key, value] of snapshot.tokens ?? []) this.tokens.set(String(key), value as never);
    for (const [key, value] of snapshot.conversations ?? []) {
      this.conversations.set(String(key), value as never);
    }
    for (const [key, value] of snapshot.communityProfiles ?? []) {
      this.communityProfiles.set(String(key), value as never);
    }
    for (const [key, value] of snapshot.messages ?? []) {
      this.messages.set(String(key), value as never);
    }
    for (const [key, value] of snapshot.idempotency ?? []) {
      this.idempotency.set(String(key), String(value));
    }
    this.ledger.push(...(snapshot.ledger ?? []) as never[]);
    this.jobs.push(...(snapshot.jobs ?? []) as never[]);
    for (const [key, value] of snapshot.usageRuns ?? []) {
      this.usageRuns.set(String(key), value as never);
    }
    this.#revision = revision;
  }

  override async flush() {
    const snapshot: Snapshot = {
      users: [...this.users],
      sessions: [...this.sessions],
      tokens: [...this.tokens],
      conversations: [...this.conversations],
      communityProfiles: [...this.communityProfiles],
      messages: [...this.messages],
      idempotency: [...this.idempotency],
      ledger: this.ledger,
      usageRuns: [...this.usageRuns],
      jobs: this.jobs,
    };
    const payload = JSON.stringify(snapshot);
    if (payload === this.#lastPayload) return;
    this.#revision++;
    await this
      .#sql`INSERT INTO runtime_snapshots (id, payload, revision) VALUES ('primary', ${payload}::jsonb, ${this.#revision}) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, revision = EXCLUDED.revision, updated_at = now()`;
    this.#lastPayload = payload;
  }

  override async close() {
    if (this.#timer) clearInterval(this.#timer);
    await this.flush();
    await this.#sql.end({ timeout: 5 });
  }
}
