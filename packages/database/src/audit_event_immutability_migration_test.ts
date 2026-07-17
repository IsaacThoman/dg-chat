import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0048 makes audit history append-only with exact restore and test transaction gates",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `audit_immutability_${crypto.randomUUID().replaceAll("-", "")}`;
    const restrictedRole = `audit_immutability_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE backup_operations(
          id uuid PRIMARY KEY,
          kind text NOT NULL,
          status text NOT NULL,
          stage text NOT NULL
        );
        CREATE TABLE installation_state(
          singleton_id smallint PRIMARY KEY,
          maintenance_enabled boolean NOT NULL DEFAULT false,
          active_restore_id uuid,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE audit_events(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          action text NOT NULL,
          target_type text NOT NULL,
          target_id text,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const restoreFence = await Deno.readTextFile(
        new URL("../migrations/0044_restore_transaction_fence.sql", import.meta.url),
      );
      await sql.unsafe(restoreFence);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0048_audit_event_immutability.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      await sql`INSERT INTO installation_state(singleton_id) VALUES(1)`;

      const firstId = crypto.randomUUID();
      await sql`INSERT INTO audit_events(id,action,target_type,target_id)
        VALUES(${firstId},'fixture.created','fixture','one')`;
      for (
        const mutation of [
          () => sql`UPDATE audit_events SET target_id='changed' WHERE id=${firstId}`,
          () => sql`DELETE FROM audit_events WHERE id=${firstId}`,
          () => sql`TRUNCATE audit_events`,
        ]
      ) {
        await assertRejects(mutation, Error, "audit_events is append-only");
      }
      assertEquals(
        (await sql<
          { target_id: string }[]
        >`SELECT target_id FROM audit_events WHERE id=${firstId}`)[0].target_id,
        "one",
      );

      // Neither a forged value nor a value copied from an already-ended transaction is authority.
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx`SELECT set_config(
              'dg_chat.audit_test_maintenance_transaction',
              pg_current_xact_id()::text,
              true
            )`;
            await tx`DELETE FROM audit_events WHERE id=${firstId}`;
          }),
        Error,
        "audit_events is append-only",
      );

      await sql.unsafe(`CREATE ROLE ${restrictedRole} NOLOGIN`);
      await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${restrictedRole}`);
      await sql.unsafe(
        `GRANT SELECT ON ${schema}.backup_operations,${schema}.installation_state
          TO ${restrictedRole}`,
      );
      await sql.unsafe(`GRANT ALL ON ${schema}.audit_events TO ${restrictedRole}`);
      await sql.unsafe(
        `GRANT EXECUTE ON FUNCTION ${schema}.dg_chat_restore_transaction_authorized(name),
          ${schema}.dg_chat_enforce_audit_event_immutability() TO ${restrictedRole}`,
      );
      // The helper ACL is closed by default.
      await assertRejects(() =>
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${restrictedRole}`);
          await tx.unsafe(`SELECT ${schema}.dg_chat_begin_audit_test_maintenance()`);
        })
      );
      // Even an explicit grant cannot turn a non-superuser into test-maintenance authority.
      await sql.unsafe(
        `GRANT EXECUTE ON FUNCTION ${schema}.dg_chat_begin_audit_test_maintenance()
          TO ${restrictedRole}`,
      );
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL ROLE ${restrictedRole}`);
            await tx.unsafe(`SELECT ${schema}.dg_chat_begin_audit_test_maintenance()`);
          }),
        Error,
        "restricted to disposable test databases",
      );
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL ROLE ${restrictedRole}`);
            await tx`SELECT pg_advisory_xact_lock(
              hashtext('dg-chat-audit-test-maintenance')
            )`;
            await tx`SELECT set_config(
              'dg_chat.audit_test_maintenance_transaction',
              pg_current_xact_id()::text,
              true
            )`;
            await tx`DELETE FROM audit_events WHERE id=${firstId}`;
          }),
        Error,
        "audit_events is append-only",
      );

      await sql.begin(async (tx) => {
        await tx`SELECT ${sql(schema)}.dg_chat_begin_audit_test_maintenance()`;
        await tx`UPDATE audit_events SET target_id='test-maintained' WHERE id=${firstId}`;
      });
      await assertRejects(
        () => sql`DELETE FROM audit_events WHERE id=${firstId}`,
        Error,
        "audit_events is append-only",
      );

      const restoreId = crypto.randomUUID();
      await sql`INSERT INTO backup_operations(id,kind,status,stage)
        VALUES(${restoreId},'restore','running','restore_staging')`;
      await sql`UPDATE installation_state SET maintenance_enabled=true,
        active_restore_id=${restoreId} WHERE singleton_id=1`;
      await sql.begin(async (tx) => {
        await tx`UPDATE installation_state SET restore_transaction_id=pg_current_xact_id()
          WHERE singleton_id=1`;
        await tx`SELECT set_config('dg_chat.restore_bypass',${restoreId},true)`;
        await tx`TRUNCATE audit_events`;
        await tx`INSERT INTO audit_events(action,target_type,target_id)
          VALUES('backup.restore.database_committed','backup_operation',${restoreId})`;
        await tx`UPDATE installation_state SET restore_transaction_id=NULL
          WHERE singleton_id=1 AND restore_transaction_id=pg_current_xact_id()`;
      });
      assertEquals(Number((await sql`SELECT count(*) count FROM audit_events`)[0].count), 1);
      await assertRejects(
        () => sql`TRUNCATE audit_events`,
        Error,
        "audit_events is append-only",
      );

      const [guard] = await sql<{ definition: string }[]>`
        SELECT pg_get_triggerdef(t.oid) definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=${schema} AND c.relname='audit_events'
          AND t.tgname='dg_chat_audit_events_append_only' AND NOT t.tgisinternal`;
      assertEquals(guard.definition.includes("BEFORE"), true);
      assertEquals(guard.definition.includes("UPDATE"), true);
      assertEquals(guard.definition.includes("DELETE"), true);
      assertEquals(guard.definition.includes("TRUNCATE"), true);
      assertEquals(
        guard.definition.includes("dg_chat_enforce_audit_event_immutability"),
        true,
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.unsafe(`DROP ROLE IF EXISTS ${restrictedRole}`);
      await sql.end();
    }
  },
});
