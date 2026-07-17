import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0040 installs trigram and owner/lifecycle conversation search indexes",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `conversation_search_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE conversations(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
          title text NOT NULL, archived_at timestamptz, deleted_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE messages(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
          role text NOT NULL, status text NOT NULL, content text NOT NULL,
          metadata jsonb NOT NULL DEFAULT '{}'
        );
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0040_conversation_search.sql", import.meta.url),
      );
      assertEquals(migration.includes("SET lock_timeout = '5s';"), true);
      assertEquals(migration.includes("RESET lock_timeout;"), true);
      assertEquals(/^\s*CREATE INDEX CONCURRENTLY/m.test(migration), false);
      await sql.unsafe(migration);
      assertEquals((await sql<{ lock_timeout: string }[]>`SHOW lock_timeout`)[0].lock_timeout, "0");
      const indexRows = await sql<{ indexname: string; indexdef: string }[]>`
        SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=${schema}`;
      const indexes = indexRows.map((row) => row.indexname);
      assertEquals(indexes.includes("conversations_title_trgm_idx"), true);
      const titleDefinition = indexRows.find((row) =>
        row.indexname === "conversations_title_trgm_idx"
      )?.indexdef ?? "";
      assertEquals(titleDefinition.includes("USING gin (lower(title) gin_trgm_ops)"), true);
      assertEquals(indexes.includes("messages_search_content_trgm_idx"), true);
      const messageDefinition = indexRows.find((row) =>
        row.indexname === "messages_search_content_trgm_idx"
      )?.indexdef ?? "";
      assertEquals(messageDefinition.includes("authoredContent"), true);
      assertEquals(messageDefinition.includes("role = ANY"), true);
      assertEquals(messageDefinition.includes("status <> 'tombstoned'"), true);
      assertEquals(indexes.includes("conversations_owner_lifecycle_search_idx"), true);
      const lifecycleDefinition = indexRows.find((row) =>
        row.indexname === "conversations_owner_lifecycle_search_idx"
      )?.indexdef ?? "";
      assertEquals(
        lifecycleDefinition.includes(
          "(owner_id, deleted_at, archived_at, updated_at DESC, id DESC)",
        ),
        true,
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
