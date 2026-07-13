import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0037 separates soft deletion from activation and versions user mutations",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `admin_lifecycle_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TYPE account_state AS ENUM ('active','suspended','deleted');
        CREATE TABLE users(
          id uuid PRIMARY KEY,
          state account_state NOT NULL DEFAULT 'active',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz
        );
      `);
      const legacyDeleted = crypto.randomUUID();
      const alreadyDeleted = crypto.randomUUID();
      const independentlyDeleted = crypto.randomUUID();
      await sql`INSERT INTO users(id,state,created_at,updated_at) VALUES(
        ${legacyDeleted},'deleted','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z'
      )`;
      await sql`INSERT INTO users(id,state,created_at,updated_at,deleted_at) VALUES(
        ${alreadyDeleted},'deleted','2026-02-01T00:00:00Z','2026-02-02T00:00:00Z',
        '2026-02-03T00:00:00Z'
      ),(
        ${independentlyDeleted},'active','2026-03-01T00:00:00Z','2026-03-02T00:00:00Z',
        '2026-03-03T00:00:00Z'
      )`;

      const migration = await Deno.readTextFile(
        new URL("../migrations/0037_admin_account_lifecycle.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      // The migration is safe to replay during recovery and does not rewrite normalized rows.
      await sql.unsafe(migration);

      assertEquals(
        [
          ...await sql<{ id: string; state: string; version: number; deleted_at: Date | null }[]>`
          SELECT id,state,version,deleted_at FROM users ORDER BY id
        `,
        ].map((row) => ({
          ...row,
          deleted_at: row.deleted_at?.toISOString() ?? null,
        })),
        [
          {
            id: legacyDeleted,
            state: "suspended",
            version: 1,
            deleted_at: "2026-01-02T00:00:00.000Z",
          },
          {
            id: alreadyDeleted,
            state: "suspended",
            version: 1,
            deleted_at: "2026-02-03T00:00:00.000Z",
          },
          {
            id: independentlyDeleted,
            state: "active",
            version: 1,
            deleted_at: "2026-03-03T00:00:00.000Z",
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );

      await assertRejects(() => sql`UPDATE users SET state='deleted' WHERE id=${legacyDeleted}`);
      await assertRejects(() => sql`UPDATE users SET version=0 WHERE id=${legacyDeleted}`);

      const indexes = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname=${schema} AND indexname='users_created_cursor_idx'
      `;
      assertEquals(indexes.length, 1);
      assertEquals(indexes[0].indexdef.includes("created_at DESC, id DESC"), true);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
