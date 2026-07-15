import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0038 installs exact, idempotent admin billing commands and page indexes",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `admin_security_billing_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(
          id uuid PRIMARY KEY,
          balance_micros bigint NOT NULL DEFAULT 0 CHECK(balance_micros >= 0)
        );
        CREATE TABLE auth_users(id uuid PRIMARY KEY);
        CREATE TABLE auth_sessions(
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES auth_users(id),
          token text NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE sessions(
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id),
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE api_tokens(
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id),
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE ledger_entries(
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id),
          usage_run_id text NOT NULL,
          kind text NOT NULL,
          amount_micros bigint NOT NULL,
          balance_after_micros bigint NOT NULL CHECK(balance_after_micros >= 0),
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE audit_events(
          id uuid PRIMARY KEY,
          actor_id uuid REFERENCES users(id),
          action text NOT NULL
        );
        CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('dg_chat.test_restore_fence',true)='on' THEN
            RAISE EXCEPTION 'installation restore maintenance is active' USING ERRCODE='55000';
          END IF;
          RETURN NULL;
        END;
        $$;
      `);

      const actorId = crypto.randomUUID();
      const targetId = crypto.randomUUID();
      const authUserId = crypto.randomUUID();
      await sql`INSERT INTO users(id,balance_micros) VALUES(${actorId},0),(${targetId},1000)`;
      await sql`INSERT INTO auth_users(id) VALUES(${authUserId})`;

      const migration = await Deno.readTextFile(
        new URL("../migrations/0038_admin_user_security_billing.sql", import.meta.url),
      );
      await sql.unsafe(migration);

      assertEquals(
        Number(
          (await sql`SELECT balance_micros FROM users WHERE id=${targetId}`)[0].balance_micros,
        ),
        1000,
      );

      const ledgerId = crypto.randomUUID();
      const auditId = crypto.randomUUID();
      const adjustmentId = crypto.randomUUID();
      const keyHash = "a".repeat(64);
      const requestHash = "b".repeat(64);
      await sql`INSERT INTO ledger_entries(
        id,user_id,usage_run_id,kind,amount_micros,balance_after_micros
      ) VALUES(${ledgerId},${targetId},${`admin-adjustment:${adjustmentId}`},'adjustment',250,1250)`;
      await sql`INSERT INTO audit_events(id,actor_id,action)
        VALUES(${auditId},${actorId},'billing.balance_adjusted')`;
      await sql`INSERT INTO admin_balance_adjustments(
        id,actor_id,target_user_id,idempotency_key_hash,request_hash,amount_micros,
        balance_before_micros,balance_after_micros,reason,ledger_entry_id,audit_event_id
      ) VALUES(
        ${adjustmentId},${actorId},${targetId},${keyHash},${requestHash},250,
        1000,1250,'Correction',${ledgerId},${auditId}
      )`;

      assertEquals(
        Number((await sql`SELECT count(*) count FROM admin_balance_adjustments`)[0].count),
        1,
      );

      const anotherLedger = crypto.randomUUID();
      const anotherAudit = crypto.randomUUID();
      await sql`INSERT INTO ledger_entries(
        id,user_id,usage_run_id,kind,amount_micros,balance_after_micros
      ) VALUES(${anotherLedger},${targetId},'other-adjustment','adjustment',1,1251)`;
      await sql`INSERT INTO audit_events(id,actor_id,action)
        VALUES(${anotherAudit},${actorId},'billing.balance_adjusted')`;
      await assertRejects(() =>
        sql`INSERT INTO admin_balance_adjustments(
        actor_id,target_user_id,idempotency_key_hash,request_hash,amount_micros,
        balance_before_micros,balance_after_micros,reason,ledger_entry_id,audit_event_id
      ) VALUES(
        ${actorId},${targetId},${keyHash},${"c".repeat(64)},1,
        1250,1251,'Another correction',${anotherLedger},${anotherAudit}
      )`
      );

      await assertRejects(() =>
        sql`UPDATE users SET balance_micros=9007199254740992 WHERE id=${targetId}`
      );
      await assertRejects(() =>
        sql`UPDATE ledger_entries SET amount_micros=9007199254740992 WHERE id=${ledgerId}`
      );
      await assertRejects(() =>
        sql`UPDATE admin_balance_adjustments SET request_hash='not-a-hash' WHERE id=${adjustmentId}`
      );
      await assertRejects(() =>
        sql`UPDATE admin_balance_adjustments SET reason=' padded ' WHERE id=${adjustmentId}`
      );
      await assertRejects(() =>
        sql`UPDATE admin_balance_adjustments SET balance_after_micros=1252 WHERE id=${adjustmentId}`
      );

      const expectedIndexes = [
        "admin_balance_adjustments_actor_page_idx",
        "admin_balance_adjustments_target_page_idx",
        "api_tokens_user_page_idx",
        "auth_sessions_user_page_idx",
        "ledger_user_page_idx",
        "sessions_user_page_idx",
      ];
      const indexes = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname=${schema} AND indexname=ANY(${expectedIndexes})
        ORDER BY indexname
      `;
      assertEquals(indexes.map((row) => row.indexname), expectedIndexes);

      const fence = await sql<{ enabled: string }[]>`
        SELECT t.tgenabled enabled FROM pg_trigger t
        WHERE t.tgrelid='admin_balance_adjustments'::regclass
          AND t.tgname='dg_chat_restore_maintenance_fence'
          AND NOT t.tgisinternal
      `;
      assertEquals(fence.map((row) => ({ enabled: row.enabled })), [{ enabled: "O" }]);
      await sql`SELECT set_config('dg_chat.test_restore_fence','on',false)`;
      await assertRejects(() => sql`UPDATE admin_balance_adjustments SET reason='Blocked'`);
      await sql`SELECT set_config('dg_chat.test_restore_fence','off',false)`;
      assertEquals(
        String(
          (await sql`SELECT reason FROM admin_balance_adjustments WHERE id=${adjustmentId}`)[0]
            .reason,
        ),
        "Correction",
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
