import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0053 creates private-by-default community profiles with database consent guards",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `community_profile_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RETURN NEW; END $$;
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0053_community_profiles.sql", import.meta.url),
      );
      await sql.unsafe(migration);

      const ownerId = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${ownerId})`;
      const [initial] = await sql`
        INSERT INTO community_profiles(user_id) VALUES(${ownerId}) RETURNING *
      `;
      assertEquals(initial.opted_in, false);
      assertEquals(initial.identity_mode, "anonymous");
      assertEquals(initial.nickname, null);
      assertEquals(initial.color, "slate");
      assertEquals(initial.share_balance, false);
      assertEquals(Number(initial.version), 1);

      for (
        const statement of [
          `UPDATE community_profiles SET opted_in=false,share_balance=true WHERE user_id='${ownerId}'`,
          `UPDATE community_profiles SET identity_mode='nickname',nickname='<script>' WHERE user_id='${ownerId}'`,
          `UPDATE community_profiles SET identity_mode='anonymous',nickname='Visible' WHERE user_id='${ownerId}'`,
          `UPDATE community_profiles SET color='#ff00ff' WHERE user_id='${ownerId}'`,
        ]
      ) {
        await assertRejects(() => sql.unsafe(statement));
      }

      const [trigger] = await sql<{ definition: string }[]>`
        SELECT pg_get_triggerdef(t.oid) definition FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=${schema} AND c.relname='community_profiles'
          AND t.tgname='dg_chat_restore_maintenance_fence' AND NOT t.tgisinternal
      `;
      assertEquals(trigger.definition.includes("INSERT"), true);
      assertEquals(trigger.definition.includes("UPDATE"), true);
      assertEquals(trigger.definition.includes("DELETE"), true);
      assertEquals(trigger.definition.includes("TRUNCATE"), true);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
