import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0049 creates a singleton bounded automatic retention schedule and permits system runs",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `automatic_retention_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE retention_policy_versions(version integer PRIMARY KEY);
        INSERT INTO retention_policy_versions(version) VALUES(1);
        CREATE TABLE retention_scrub_runs(
          id uuid PRIMARY KEY,
          requested_by uuid NOT NULL REFERENCES users(id)
        );
        CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0049_automatic_retention_schedule.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      const runId = crypto.randomUUID();
      await sql`INSERT INTO retention_scrub_runs(id,requested_by) VALUES(${runId},NULL)`;
      const state = await sql<{
        singleton_id: number;
        interval_seconds: number;
        last_run_id: string | null;
      }[]>`SELECT singleton_id,interval_seconds,last_run_id FROM retention_schedule_state`;
      assertEquals([...state], [{ singleton_id: 1, interval_seconds: 86_400, last_run_id: null }]);
      await assertRejects(() =>
        sql`UPDATE retention_schedule_state SET interval_seconds=299 WHERE singleton_id=1`
      );
      await assertRejects(() => sql`INSERT INTO retention_schedule_state(singleton_id) VALUES(2)`);
      const triggers = await sql<{ count: number }[]>`
        SELECT count(*)::int count FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=${schema} AND c.relname='retention_schedule_state'
          AND t.tgname='dg_chat_restore_maintenance_fence' AND NOT t.tgisinternal`;
      assertEquals(triggers[0].count, 1);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
