import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0033 adds durable import replay state and a global temporary sweep index",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `conversation_portability_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TYPE message_role AS ENUM ('system','user','assistant','tool');
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE conversations(
          id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
          temporary boolean NOT NULL, temporary_expires_at timestamptz
        );
        CREATE TABLE messages(id uuid PRIMARY KEY);
        CREATE TABLE attachments(id uuid PRIMARY KEY);
        CREATE TABLE message_attachments(
          message_id uuid NOT NULL REFERENCES messages(id),
          attachment_id uuid NOT NULL REFERENCES attachments(id),
          PRIMARY KEY(message_id,attachment_id)
        );
        CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RETURN NULL; END $$;
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0033_conversation_portability.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      const roles = await sql<{ enumlabel: string }[]>`
        SELECT enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid=e.enumtypid
        JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE t.typname='message_role' AND n.nspname=${schema}
        ORDER BY enumsortorder`;
      assertEquals(roles.map((row) => row.enumlabel), [
        "system",
        "user",
        "assistant",
        "tool",
        "developer",
      ]);
      const indexes = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname=${schema}`;
      assertEquals(
        indexes.some((row) => row.indexname === "conversations_temporary_expiry_global_idx"),
        true,
      );
      const owner = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${owner})`;
      await sql`INSERT INTO conversation_portability_imports(
        owner_id,idempotency_key,payload_hash,result
      ) VALUES(${owner},'one',${"a".repeat(64)},${sql.json({ conversations: 0 })})`;
      await assertRejects(() =>
        sql`INSERT INTO conversation_portability_imports(
          owner_id,idempotency_key,payload_hash,result
        ) VALUES(${owner},'one',${"b".repeat(64)},${sql.json({ conversations: 1 })})`
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
