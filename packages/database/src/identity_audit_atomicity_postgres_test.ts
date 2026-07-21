import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres identity mutations roll back when their transactional audit append fails",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        "TRUNCATE auth_verifications,auth_sessions,auth_accounts,auth_users,identity_tokens," +
          "sessions,api_tokens,ledger_entries,audit_events,users RESTART IDENTITY CASCADE",
      );
      await sql.unsafe(`
        CREATE TABLE dg_test_failed_identity_audits(action text PRIMARY KEY);
        CREATE FUNCTION dg_test_fail_identity_audit()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF EXISTS(
            SELECT 1 FROM public.dg_test_failed_identity_audits failed
            WHERE failed.action=NEW.action
          ) THEN
            RAISE EXCEPTION 'injected identity audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_fail_identity_audit
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION dg_test_fail_identity_audit();
      `);
      const fail = async (action: string) => {
        await sql`INSERT INTO dg_test_failed_identity_audits(action) VALUES(${action})`;
      };
      const allow = async (action: string) => {
        await sql`DELETE FROM dg_test_failed_identity_audits WHERE action=${action}`;
      };

      await fail("identity.bootstrap_admin");
      await assertRejects(
        () =>
          repository.bootstrapAdmin({
            email: "atomic-pg-admin@example.test",
            name: "Atomic PG admin",
            passwordHash: "bootstrap-password-hash",
          }, 5_000_000),
        Error,
        "injected identity audit failure",
      );
      assertEquals(Number((await sql`SELECT count(*) count FROM users`)[0].count), 0);
      assertEquals(Number((await sql`SELECT count(*) count FROM ledger_entries`)[0].count), 0);
      await allow("identity.bootstrap_admin");
      const administrator = await repository.bootstrapAdmin({
        email: "atomic-pg-admin@example.test",
        name: "Atomic PG admin",
        passwordHash: "bootstrap-password-hash",
      }, 5_000_000);

      const verificationUser = await repository.createUser({
        email: "atomic-pg-verification@example.test",
        name: "Atomic PG verification",
      });
      await repository.createIdentityToken(
        verificationUser.id,
        "email_verification",
        "atomic-pg-verification-token-hash",
        new Date(Date.now() + 60_000).toISOString(),
        verificationUser.authorityEpoch,
      );
      await fail("identity.email_verified");
      await assertRejects(
        () => repository.verifyEmail("atomic-pg-verification-token-hash"),
        Error,
        "injected identity audit failure",
      );
      assertEquals((await repository.findUser(verificationUser.id))?.emailVerifiedAt, null);
      assertEquals(
        (await sql`
          SELECT consumed_at FROM identity_tokens
          WHERE token_hash='atomic-pg-verification-token-hash'
        `)[0].consumed_at,
        null,
      );
      await allow("identity.email_verified");
      await repository.verifyEmail("atomic-pg-verification-token-hash");

      const resetUser = await repository.createUser({
        email: "atomic-pg-reset@example.test",
        name: "Atomic PG reset",
        approvalStatus: "approved",
      });
      await sql`INSERT INTO auth_users(id,name,email,email_verified)
        VALUES(${resetUser.id},${resetUser.name},${resetUser.email},true)`;
      await sql`INSERT INTO auth_accounts(
        id,account_id,provider_id,user_id,password,created_at,updated_at
      ) VALUES(
        ${crypto.randomUUID()},${resetUser.id},'credential',${resetUser.id},
        'original-password-hash',now(),now()
      )`;
      await repository.createIdentityToken(
        resetUser.id,
        "password_reset",
        "atomic-pg-reset-token-hash",
        new Date(Date.now() + 60_000).toISOString(),
        resetUser.authorityEpoch,
      );
      await fail("identity.password_reset_completed");
      await assertRejects(
        () => repository.resetPassword("atomic-pg-reset-token-hash", "replacement-password-hash"),
        Error,
        "injected identity audit failure",
      );
      assertEquals((await repository.findUser(resetUser.id))?.authorityEpoch, 1);
      assertEquals(
        (await sql`SELECT password FROM auth_accounts WHERE user_id=${resetUser.id}`)[0].password,
        "original-password-hash",
      );
      assertEquals(
        (await sql`
          SELECT consumed_at FROM identity_tokens
          WHERE token_hash='atomic-pg-reset-token-hash'
        `)[0].consumed_at,
        null,
      );
      await allow("identity.password_reset_completed");
      await repository.resetPassword(
        "atomic-pg-reset-token-hash",
        "replacement-password-hash",
      );

      const betterAuthUser = await repository.createUser({
        email: "atomic-pg-better-auth-reset@example.test",
        name: "Atomic PG Better Auth reset",
        approvalStatus: "approved",
      });
      await sql`INSERT INTO auth_users(id,name,email,email_verified)
        VALUES(${betterAuthUser.id},${betterAuthUser.name},${betterAuthUser.email},true)`;
      await sql`INSERT INTO auth_accounts(
        id,account_id,provider_id,user_id,password,created_at,updated_at
      ) VALUES(
        ${crypto.randomUUID()},${betterAuthUser.id},'credential',${betterAuthUser.id},
        'original-better-auth-password-hash',now(),now()
      )`;
      await sql`INSERT INTO auth_verifications(identifier,value,expires_at,authority_epoch)
        VALUES(
          'reset-password:atomic-pg-better-auth-token',${betterAuthUser.id},
          now()+interval '1 hour',${betterAuthUser.authorityEpoch}
        )`;
      await fail("identity.password_reset_completed");
      await assertRejects(
        () =>
          repository.resetBetterAuthPassword(
            "atomic-pg-better-auth-token",
            "replacement-better-auth-password-hash",
          ),
        Error,
        "injected identity audit failure",
      );
      assertEquals((await repository.findUser(betterAuthUser.id))?.authorityEpoch, 1);
      assertEquals(
        (await sql`SELECT password FROM auth_accounts WHERE user_id=${betterAuthUser.id}`)[0]
          .password,
        "original-better-auth-password-hash",
      );
      assertEquals(
        Number(
          (await sql`
            SELECT count(*) count FROM auth_verifications
            WHERE identifier='reset-password:atomic-pg-better-auth-token'
          `)[0].count,
        ),
        1,
      );
      await allow("identity.password_reset_completed");
      await repository.resetBetterAuthPassword(
        "atomic-pg-better-auth-token",
        "replacement-better-auth-password-hash",
      );

      assertEquals(
        (await repository.listAudit({ action: "identity.bootstrap_admin" })).data.length,
        1,
      );
      assertEquals(
        (await repository.listAudit({ action: "identity.email_verified" })).data.length,
        1,
      );
      assertEquals(
        (await repository.listAudit({ action: "identity.password_reset_completed" })).data.length,
        2,
      );
      assertEquals(administrator.role, "admin");
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS dg_test_fail_identity_audit ON audit_events;
        DROP FUNCTION IF EXISTS dg_test_fail_identity_audit();
        DROP TABLE IF EXISTS dg_test_failed_identity_audits;
      `).catch(() => undefined);
      await repository.close();
      await sql.end({ timeout: 5 });
    }
  },
});
