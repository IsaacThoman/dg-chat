import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0034 creates hashed immutable share storage with restore fencing and constraints",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `conversation_sharing_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE conversations(
          id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),UNIQUE(id,owner_id)
        );
        CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RETURN NEW; END $$;
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0034_immutable_sharing_snapshots.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      const columns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema=${schema} AND table_name='conversation_share_snapshots'`;
      const names = columns.map((row) => row.column_name);
      assertEquals(names.includes("secret_hash"), true);
      assertEquals(
        names.some((name) => /secret|capability/.test(name) && name !== "secret_hash"),
        false,
      );
      const triggers = await sql<{ count: number }[]>`
        SELECT count(*)::int count FROM information_schema.triggers
        WHERE event_object_schema=${schema} AND event_object_table='conversation_share_snapshots'
          AND trigger_name='dg_chat_restore_maintenance_fence'`;
      // information_schema exposes INSERT/UPDATE/DELETE event rows but omits TRUNCATE. Inspect the
      // authoritative PostgreSQL trigger definition separately so the restore fence proves all
      // four events without relying on a view that intentionally hides one of them.
      assertEquals(triggers[0].count, 3);
      const definitions = await sql<{ definition: string }[]>`
        SELECT pg_get_triggerdef(t.oid) definition FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=${schema} AND c.relname='conversation_share_snapshots'
          AND t.tgname='dg_chat_restore_maintenance_fence' AND NOT t.tgisinternal`;
      assertEquals(definitions.length, 1);
      assertEquals(definitions[0].definition.includes("TRUNCATE"), true);

      const owner = crypto.randomUUID();
      const conversation = crypto.randomUUID();
      const leaf = crypto.randomUUID();
      const share = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${owner})`;
      await sql`INSERT INTO conversations(id,owner_id) VALUES(${conversation},${owner})`;
      const snapshot = {
        id: share,
        title: "Shared",
        conversationVersion: 1,
        identity: { visibility: "anonymous", displayName: null },
        attachmentPolicy: "redact",
        messages: [],
        attachments: [],
        createdAt: "2026-07-13T12:00:00.000Z",
        expiresAt: null,
      };
      await sql`INSERT INTO conversation_share_snapshots(
        id,owner_id,conversation_id,leaf_id,conversation_version,title,identity_visibility,
        attachment_policy,owner_name_snapshot,public_snapshot,source_attachments,secret_hash,
        idempotency_key,payload_hash,created_at
      ) VALUES(${share},${owner},${conversation},${leaf},1,'Shared','anonymous','redact',NULL,
        ${sql.json(snapshot)},${sql.json({})},${"a".repeat(64)},'create-1',${"b".repeat(64)},
        '2026-07-13T12:00:00.000Z')`;
      await assertRejects(() =>
        sql`INSERT INTO conversation_share_snapshots(
          owner_id,conversation_id,leaf_id,conversation_version,title,identity_visibility,
          attachment_policy,owner_name_snapshot,public_snapshot,secret_hash,idempotency_key,
          payload_hash
        ) VALUES(${owner},${conversation},${leaf},1,'Duplicate','anonymous','redact',NULL,
          ${sql.json(snapshot)},${"a".repeat(64)},'create-2',${"c".repeat(64)})`
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
