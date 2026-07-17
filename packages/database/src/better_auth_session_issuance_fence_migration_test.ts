import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

function schemaDatabaseUrl(source: string, schema: string): string {
  const url = new URL(source);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function createFixture(sql: postgres.Sql, schema: string) {
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema},public`);
  await sql.unsafe(`
    CREATE TYPE approval_status AS ENUM ('pending','approved','rejected');
    CREATE TYPE account_state AS ENUM ('active','suspended');
    CREATE TABLE users(
      id uuid PRIMARY KEY,
      approval_status approval_status NOT NULL DEFAULT 'pending',
      state account_state NOT NULL DEFAULT 'active',
      deleted_at timestamptz,
      password_reset_pending boolean NOT NULL DEFAULT false
    );
    CREATE TABLE auth_users(id uuid PRIMARY KEY);
    CREATE TABLE auth_sessions(
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      limited boolean NOT NULL DEFAULT true
    );
  `);
  const migration = await Deno.readTextFile(
    new URL("../migrations/0042_better_auth_session_issuance_fence.sql", import.meta.url),
  );
  await sql.unsafe(migration);
  // Recovery/replay replaces the function and trigger without multiplying trigger execution.
  await sql.unsafe(migration);
}

Deno.test({
  name: "0042 installs a fail-closed Better Auth session issuance fence",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `auth_session_fence_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await createFixture(sql, schema);

      const triggers = await sql<{ enabled: string; definition: string }[]>`
        SELECT t.tgenabled enabled,pg_get_triggerdef(t.oid) definition
        FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=${schema} AND c.relname='auth_sessions'
          AND t.tgname='dg_chat_auth_session_issuance_fence' AND NOT t.tgisinternal
      `;
      assertEquals(triggers.length, 1);
      assertEquals(triggers[0].enabled, "O");
      assertEquals(triggers[0].definition.includes("BEFORE INSERT"), true);
      const functions = await sql<{ source: string; config: string[] | null }[]>`
        SELECT p.prosrc source,p.proconfig config
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=${schema} AND p.proname='dg_chat_fence_auth_session_issuance'
      `;
      assertEquals(functions.length, 1);
      assertEquals(functions[0].source.includes("FOR UPDATE"), true);
      assertEquals(functions[0].source.includes("TG_TABLE_SCHEMA"), true);
      assertEquals(functions[0].config, ["search_path=pg_catalog"]);

      const preProvisionId = crypto.randomUUID();
      await sql`INSERT INTO auth_users(id) VALUES(${preProvisionId})`;
      await sql`INSERT INTO auth_sessions(id,user_id,token,limited)
        VALUES(${crypto.randomUUID()},${preProvisionId},'pre-provision-status',true)`;
      await assertRejects(() =>
        sql`INSERT INTO auth_sessions(id,user_id,token,limited)
          VALUES(${crypto.randomUUID()},${preProvisionId},'pre-provision-full',false)`
      );

      const pendingId = crypto.randomUUID();
      const rejectedId = crypto.randomUUID();
      const approvedId = crypto.randomUUID();
      await sql`INSERT INTO auth_users(id) VALUES(${pendingId}),(${rejectedId}),(${approvedId})`;
      await sql`INSERT INTO users(id,approval_status) VALUES
        (${pendingId},'pending'),(${rejectedId},'rejected'),(${approvedId},'approved')`;
      await sql`INSERT INTO auth_sessions(id,user_id,token,limited) VALUES
        (${crypto.randomUUID()},${pendingId},'pending-status',true),
        (${crypto.randomUUID()},${rejectedId},'rejected-status',true),
        (${crypto.randomUUID()},${approvedId},'approved-full',false)`;
      await assertRejects(() =>
        sql`INSERT INTO auth_sessions(id,user_id,token,limited)
          VALUES(${crypto.randomUUID()},${pendingId},'pending-full',false)`
      );
      await assertRejects(() =>
        sql`INSERT INTO auth_sessions(id,user_id,token,limited)
          VALUES(${crypto.randomUUID()},${rejectedId},'rejected-full',false)`
      );

      for (
        const [column, value, token] of [
          ["state", "'suspended'", "suspended-status"],
          ["deleted_at", "now()", "deleted-status"],
          ["password_reset_pending", "true", "reset-status"],
        ] as const
      ) {
        await sql`UPDATE users SET state='active',deleted_at=NULL,password_reset_pending=false
          WHERE id=${approvedId}`;
        await sql.unsafe(`UPDATE users SET ${column}=${value} WHERE id=$1`, [approvedId]);
        await assertRejects(() =>
          sql`INSERT INTO auth_sessions(id,user_id,token,limited)
            VALUES(${crypto.randomUUID()},${approvedId},${token},true)`
        );
      }
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});

Deno.test({
  name: "0042 serializes a delayed full session behind lifecycle authority loss",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const bootstrap = postgres(databaseUrl!, { max: 1 });
    const schema = `auth_session_race_${crypto.randomUUID().replaceAll("-", "")}`;
    let lifecycle: postgres.Sql | undefined;
    let issuance: postgres.Sql | undefined;
    const releaseLifecycle = Promise.withResolvers<void>();
    try {
      await createFixture(bootstrap, schema);
      const scopedUrl = schemaDatabaseUrl(databaseUrl!, schema);
      const issuanceApplication = `dg-chat-auth-session-fence-${schema.slice(-12)}`;
      lifecycle = postgres(scopedUrl, { max: 1 });
      issuance = postgres(scopedUrl, {
        max: 1,
        connection: { application_name: issuanceApplication },
      });
      const userId = crypto.randomUUID();
      await bootstrap`INSERT INTO auth_users(id) VALUES(${userId})`;
      await bootstrap`INSERT INTO users(id,approval_status,state)
        VALUES(${userId},'approved','active')`;

      const rowLocked = Promise.withResolvers<void>();
      const transition = lifecycle.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
        rowLocked.resolve();
        await releaseLifecycle.promise;
        await tx`UPDATE users SET state='suspended' WHERE id=${userId}`;
        await tx`DELETE FROM auth_sessions WHERE user_id=${userId} AND limited=false`;
      });
      await rowLocked.promise;

      // This models the Better Auth adapter insert after session.create.before already approved
      // the request. The trigger must wait on the lifecycle lock and then revalidate fresh state.
      let delayedSettled = false;
      const delayedInsert = issuance`
        /* dg-chat:auth-session-issuance-fence */
        INSERT INTO auth_sessions(id,user_id,token,limited)
        VALUES(${crypto.randomUUID()},${userId},'delayed-full',false)
      `.then(
        () => ({ status: "fulfilled" as const }),
        (reason) => ({ status: "rejected" as const, reason }),
      ).finally(() => {
        delayedSettled = true;
      });
      let observedLockWait = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await bootstrap<{ count: number }[]>`
          SELECT count(*)::integer count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND application_name=${issuanceApplication}
            AND state='active' AND wait_event_type='Lock'
            AND query LIKE '%/* dg-chat:auth-session-issuance-fence */%'
        `;
        if (Number(waiting[0]?.count) === 1) {
          observedLockWait = true;
          break;
        }
        if (delayedSettled) throw new Error("Delayed session insert settled before lifecycle lock");
        if (attempt === 199) throw new Error("Delayed session insert never reached lifecycle lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(observedLockWait, true);

      releaseLifecycle.resolve();
      await transition;
      const delayedOutcome = await delayedInsert;
      assertEquals(delayedOutcome.status, "rejected");
      assertEquals(
        Number(
          (await bootstrap`SELECT count(*) count FROM auth_sessions WHERE user_id=${userId}`)[0]
            .count,
        ),
        0,
      );

      // Restoring the account cannot revive the rejected delayed insert; only a new insert may
      // acquire authority. The reverse ordering is safe because suspension deletes that session.
      await bootstrap`UPDATE users SET state='active' WHERE id=${userId}`;
      await bootstrap`INSERT INTO auth_sessions(id,user_id,token,limited)
        VALUES(${crypto.randomUUID()},${userId},'post-restore-full',false)`;
      await bootstrap.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
        await tx`UPDATE users SET state='suspended' WHERE id=${userId}`;
        await tx`DELETE FROM auth_sessions WHERE user_id=${userId} AND limited=false`;
      });
      await bootstrap`UPDATE users SET state='active' WHERE id=${userId}`;
      assertEquals(
        Number(
          (await bootstrap`SELECT count(*) count FROM auth_sessions WHERE user_id=${userId}`)[0]
            .count,
        ),
        0,
      );
    } finally {
      releaseLifecycle.resolve();
      await Promise.allSettled([
        lifecycle?.end({ timeout: 5 }),
        issuance?.end({ timeout: 5 }),
      ]);
      await bootstrap.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await bootstrap.end();
    }
  },
});
