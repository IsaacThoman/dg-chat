import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0032 backfills and enforces temporary expiry lifecycle",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `temporary_lifecycle_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE conversations(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
          title text NOT NULL, temporary boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const owner = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${owner})`;
      await sql`INSERT INTO conversations(owner_id,title,temporary,created_at)
        VALUES(${owner},'old temporary',true,'2026-01-01T00:00:00Z'),(${owner},'saved',false,now())`;
      const migration = await Deno.readTextFile(
        new URL("../migrations/0032_temporary_conversation_lifecycle.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      const rows = await sql<{ temporary: boolean; temporary_expires_at: Date | null }[]>`
        SELECT temporary,temporary_expires_at FROM conversations ORDER BY temporary DESC`;
      assertEquals(rows[0].temporary_expires_at?.toISOString(), "2026-01-31T00:00:00.000Z");
      assertEquals(rows[1].temporary_expires_at, null);
      await assertRejects(() =>
        sql`INSERT INTO conversations(owner_id,title,temporary) VALUES(${owner},'invalid',true)`
      );
      const indexes = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname=${schema}`;
      assertEquals(
        indexes.some((row) => row.indexname === "conversations_owner_temporary_expiry_idx"),
        true,
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
