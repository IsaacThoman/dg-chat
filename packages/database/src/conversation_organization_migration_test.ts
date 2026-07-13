import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0031 enforces owner-scoped organization and independent versions",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `conversation_organization_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE conversations(
          id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), title text NOT NULL,
          temporary boolean NOT NULL DEFAULT false, deleted_at timestamptz
        );
        CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RETURN NULL; END $$;
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0031_conversation_organization.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      const owner = crypto.randomUUID();
      const other = crypto.randomUUID();
      const chat = crypto.randomUUID();
      const temporary = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${owner}),(${other})`;
      await sql`INSERT INTO conversations(id,owner_id,title) VALUES(${chat},${owner},'chat')`;
      await sql`INSERT INTO conversations(id,owner_id,title,temporary) VALUES(${temporary},${owner},'temp',true)`;
      const folder = (await sql<
        { id: string }[]
      >`INSERT INTO conversation_folders(owner_id,name,normalized_name,position) VALUES(${owner},'Work','work',0) RETURNING id`)[
        0
      ].id;
      await assertRejects(() =>
        sql`INSERT INTO conversation_folder_memberships(folder_id,conversation_id,owner_id,position) VALUES(${folder},${chat},${other},0)`
      );
      await assertRejects(() =>
        sql`INSERT INTO conversation_folder_memberships(folder_id,conversation_id,owner_id,position) VALUES(${folder},${temporary},${owner},0)`
      );
      const tag = (await sql<
        { id: string }[]
      >`INSERT INTO conversation_tags(owner_id,name,normalized_name,color) VALUES(${owner},'Red','red','#ff0000') RETURNING id`)[
        0
      ].id;
      await sql`INSERT INTO conversation_tag_sets(conversation_id,owner_id) VALUES(${chat},${owner})`;
      await sql`INSERT INTO conversation_tag_bindings(conversation_id,tag_id,owner_id) VALUES(${chat},${tag},${owner})`;
      await assertRejects(() =>
        sql`INSERT INTO conversation_tag_bindings(conversation_id,tag_id,owner_id) VALUES(${chat},${tag},${other})`
      );
      const triggers = await sql<
        { table_name: string }[]
      >`SELECT event_object_table table_name FROM information_schema.triggers WHERE trigger_name='dg_chat_restore_maintenance_fence' ORDER BY event_object_table`;
      assertEquals(
        new Set(triggers.map((row) => row.table_name)),
        new Set([
          "conversation_folder_memberships",
          "conversation_folders",
          "conversation_tag_bindings",
          "conversation_tag_sets",
          "conversation_tags",
          "user_preferences",
        ]),
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
