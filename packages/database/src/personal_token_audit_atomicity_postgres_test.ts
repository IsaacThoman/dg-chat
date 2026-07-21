import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function waitForQueryBlockedBy(
  observer: postgres.Sql,
  blockerPid: number,
  queryPattern: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ pid: number }[]>`
      SELECT pid::int pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ${blockerPid}=ANY(pg_blocking_pids(pid))
        AND query ILIKE ${queryPattern}
      ORDER BY pid LIMIT 1
    `;
    if (rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function signalBeforeCompletion<T>(
  signal: Promise<T>,
  operation: Promise<unknown>,
  label: string,
): Promise<T> {
  return Promise.race([
    signal,
    operation.then(() => {
      throw new Error(`${label} completed before emitting its required signal`);
    }),
  ]);
}

Deno.test({
  name: "Postgres personal token mutations and mandatory audits roll back together",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        "TRUNCATE access_group_tokens,access_groups,api_tokens,audit_events,users " +
          "RESTART IDENTITY CASCADE",
      );
      await sql.unsafe(`
        CREATE TABLE dg_test_failed_token_audits(action text PRIMARY KEY);
        CREATE FUNCTION dg_test_fail_token_audit()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF EXISTS(
            SELECT 1 FROM public.dg_test_failed_token_audits failed
            WHERE failed.action=NEW.action
          ) THEN
            RAISE EXCEPTION 'injected token audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_fail_token_audit
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION dg_test_fail_token_audit();
      `);
      const fail = async (action: string) => {
        await sql`INSERT INTO dg_test_failed_token_audits(action) VALUES(${action})`;
      };
      const allow = async (action: string) => {
        await sql`DELETE FROM dg_test_failed_token_audits WHERE action=${action}`;
      };
      const owner = await repository.createUser({
        email: "atomic-token-postgres@example.test",
        name: "Atomic token owner",
        role: "admin",
        approvalStatus: "approved",
      });
      const readContext = {
        actorId: owner.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: owner.authorityEpoch,
      };

      await fail("api_token.created");
      await assertRejects(
        () =>
          repository.createApiToken(owner.id, {
            name: "must-not-survive",
            scopes: ["models:read"],
            tokenHash: "pg-create-secret-hash",
            preview: "dg_pg_create",
          }, owner.authorityEpoch),
        Error,
        "injected token audit failure",
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM api_tokens WHERE user_id=${owner.id}`)[0].count,
        ),
        0,
      );

      await allow("api_token.created");
      const original = await repository.createApiToken(owner.id, {
        name: "atomic family",
        scopes: ["models:read"],
        tokenHash: "pg-original-secret-hash",
        preview: "dg_pg_original",
      }, owner.authorityEpoch);
      const group = await repository.createAccessGroup({ name: "Atomic token audit group" }, {
        actorId: owner.id,
        action: "test.model_access_group.created",
        targetType: "model_access_group",
        requireEmailVerification: false,
        expectedAuthorityEpoch: owner.authorityEpoch,
      });
      await repository.replaceAccessGroupUsers(group.id, [owner.id], group.version, {
        actorId: owner.id,
        action: "model_access_group.users_replaced",
        targetType: "model_access_group",
        targetId: group.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: owner.authorityEpoch,
      });

      await fail("api_token.access_groups_set");
      await assertRejects(
        () =>
          repository.setTokenAccessGroups(owner.id, original.id, [group.id], original.version, {
            actorId: owner.id,
            action: "api_token.access_groups_set",
            targetType: "api_token",
            targetId: original.id,
            requireEmailVerification: false,
            expectedAuthorityEpoch: owner.authorityEpoch,
          }),
        Error,
        "injected token audit failure",
      );
      assertEquals((await repository.listApiTokens(owner.id))[0].version, original.version);
      assertEquals((await repository.listAccessGroups(readContext))[0].tokenIds, []);

      await allow("api_token.access_groups_set");
      const assigned = await repository.setTokenAccessGroups(
        owner.id,
        original.id,
        [group.id],
        original.version,
        {
          actorId: owner.id,
          action: "api_token.access_groups_set",
          targetType: "api_token",
          targetId: original.id,
          requireEmailVerification: false,
          expectedAuthorityEpoch: owner.authorityEpoch,
        },
      );
      await fail("api_token.access_mode_set");
      await assertRejects(
        () =>
          repository.setTokenAccessMode(owner.id, original.id, "inherit", assigned.version, {
            actorId: owner.id,
            action: "api_token.access_mode_set",
            targetType: "api_token",
            targetId: original.id,
            requireEmailVerification: false,
            expectedAuthorityEpoch: owner.authorityEpoch,
          }),
        Error,
        "injected token audit failure",
      );
      assertEquals((await repository.listApiTokens(owner.id))[0].accessMode, "restricted");
      assertEquals((await repository.listApiTokens(owner.id))[0].version, assigned.version);
      assertEquals((await repository.listAccessGroups(readContext))[0].tokenIds, [original.id]);

      await fail("api_token.updated");
      await assertRejects(
        () =>
          repository.updateApiToken(owner.id, original.id, {
            expectedVersion: assigned.version,
            name: "must roll back",
            scopes: [],
          }, owner.authorityEpoch),
        Error,
        "injected token audit failure",
      );
      const afterUpdate = (await repository.listApiTokens(owner.id))[0];
      assertEquals(afterUpdate.name, "atomic family");
      assertEquals(afterUpdate.scopes, ["models:read"]);
      assertEquals(afterUpdate.version, assigned.version);

      await fail("api_token.rotated");
      await assertRejects(
        () =>
          repository.rotateApiToken(owner.id, original.id, {
            expectedVersion: assigned.version,
            tokenHash: "pg-replacement-secret-hash",
            preview: "dg_pg_replace",
            overlapSeconds: 60,
          }, owner.authorityEpoch),
        Error,
        "injected token audit failure",
      );
      assertEquals(await repository.findApiTokenByHash("pg-replacement-secret-hash"), undefined);
      const afterRotation = (await repository.listApiTokens(owner.id))[0];
      assertEquals(afterRotation.replacedByTokenId, null);
      assertEquals(afterRotation.version, assigned.version);

      await fail("api_token.revoked");
      await assertRejects(
        () =>
          repository.revokeApiTokenFamily(
            original.id,
            owner.id,
            assigned.version,
            owner.authorityEpoch,
          ),
        Error,
        "injected token audit failure",
      );
      const afterRevoke = (await repository.listApiTokens(owner.id))[0];
      assertEquals(afterRevoke.revokedAt, null);
      assertEquals(afterRevoke.version, assigned.version);
      assertEquals(
        (await repository.authenticateApiToken("pg-original-secret-hash"))?.id,
        original.id,
      );

      const auditText = JSON.stringify(
        await sql`SELECT action,target_id,metadata FROM audit_events ORDER BY created_at,id`,
      );
      assertEquals(auditText.includes("pg-original-secret-hash"), false);
      assertEquals(auditText.includes("pg-replacement-secret-hash"), false);
      assertEquals(auditText.includes("dg_pg_original"), false);
      assertEquals(
        (await sql<{ action: string }[]>`
          SELECT action FROM audit_events WHERE action LIKE 'api_token.%' ORDER BY created_at,id
        `).map((row) => row.action),
        ["api_token.created", "api_token.access_groups_set"],
      );
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS dg_test_fail_token_audit ON audit_events;
        DROP FUNCTION IF EXISTS dg_test_fail_token_audit();
        DROP TABLE IF EXISTS dg_test_failed_token_audits;
      `).catch(() => undefined);
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres personal token update and revoke lose deterministic lifecycle races",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const observer = postgres(databaseUrl!, { max: 1 });
    const blocker = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const releaseGates: Array<() => void> = [];
    const pendingOperations: Promise<unknown>[] = [];
    try {
      await runAuditTestMaintenanceSql(
        observer,
        "TRUNCATE api_tokens,audit_events,users RESTART IDENTITY CASCADE",
      );
      const updateOwner = await repository.createUser({
        email: "token-update-race@example.test",
        name: "Token update race",
        approvalStatus: "approved",
      });
      const updateToken = await repository.createApiToken(updateOwner.id, {
        name: "unchanged update token",
        scopes: ["models:read"],
        tokenHash: "update-authority-race-secret",
        preview: "dg_update",
      }, updateOwner.authorityEpoch);

      const updateUserLocked = Promise.withResolvers<number>();
      const releaseUpdateLifecycle = Promise.withResolvers<void>();
      const lifecycleUpdateLock = blocker.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${updateOwner.id} FOR UPDATE`;
        updateUserLocked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
        await releaseUpdateLifecycle.promise;
        await tx`UPDATE users SET state='suspended',authority_epoch=authority_epoch+1,
          updated_at=now() WHERE id=${updateOwner.id}`;
      });
      releaseGates.push(() => releaseUpdateLifecycle.resolve());
      pendingOperations.push(lifecycleUpdateLock);
      const updateBlockerPid = await signalBeforeCompletion(
        updateUserLocked.promise,
        lifecycleUpdateLock,
        "update lifecycle transaction",
      );
      const update = repository.updateApiToken(updateOwner.id, updateToken.id, {
        expectedVersion: updateToken.version,
        name: "must not update",
      }, updateOwner.authorityEpoch);
      pendingOperations.push(update);
      let updateTransitionResult!: PromiseSettledResult<unknown>;
      let updateResult!: PromiseSettledResult<Awaited<typeof update>>;
      try {
        await waitForQueryBlockedBy(
          observer,
          updateBlockerPid,
          "%FROM users WHERE id=%FOR UPDATE%",
          "token update to wait on its owning user row",
        );
      } finally {
        releaseUpdateLifecycle.resolve();
        const settled = await Promise.allSettled([lifecycleUpdateLock, update]);
        updateTransitionResult = settled[0];
        updateResult = settled[1];
      }
      if (updateTransitionResult.status === "rejected") throw updateTransitionResult.reason;
      if (updateResult.status === "fulfilled") {
        throw new Error("Token update survived suspension authority loss");
      }
      assertEquals((updateResult.reason as DomainError).code, "account_unavailable");
      assertEquals(
        (await repository.listApiTokens(updateOwner.id))[0].name,
        "unchanged update token",
      );
      assertEquals(
        Number(
          (await observer`SELECT count(*) count FROM audit_events
            WHERE action='api_token.updated' AND target_id=${updateToken.id}`)[0].count,
        ),
        0,
      );

      const revokeOwner = await repository.createUser({
        email: "token-revoke-race@example.test",
        name: "Token revoke race",
        approvalStatus: "approved",
      });
      const revokeToken = await repository.createApiToken(revokeOwner.id, {
        name: "unchanged revoke token",
        scopes: ["models:read"],
        tokenHash: "revoke-authority-race-secret",
        preview: "dg_revoke",
      }, revokeOwner.authorityEpoch);
      const revokeUserLocked = Promise.withResolvers<number>();
      const releaseRevokeLifecycle = Promise.withResolvers<void>();
      const lifecycleRevokeLock = blocker.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${revokeOwner.id} FOR UPDATE`;
        revokeUserLocked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
        await releaseRevokeLifecycle.promise;
        await tx`UPDATE users SET password_reset_pending=true,
          authority_epoch=authority_epoch+1,updated_at=now() WHERE id=${revokeOwner.id}`;
      });
      releaseGates.push(() => releaseRevokeLifecycle.resolve());
      pendingOperations.push(lifecycleRevokeLock);
      const revokeBlockerPid = await signalBeforeCompletion(
        revokeUserLocked.promise,
        lifecycleRevokeLock,
        "revoke lifecycle transaction",
      );
      const revoke = repository.revokeApiTokenFamily(
        revokeToken.id,
        revokeOwner.id,
        revokeToken.version,
        revokeOwner.authorityEpoch,
      );
      pendingOperations.push(revoke);
      let revokeTransitionResult!: PromiseSettledResult<unknown>;
      let revokeResult!: PromiseSettledResult<Awaited<typeof revoke>>;
      try {
        await waitForQueryBlockedBy(
          observer,
          revokeBlockerPid,
          "%FROM users WHERE id=%FOR UPDATE%",
          "token revocation to wait on its owning user row",
        );
      } finally {
        releaseRevokeLifecycle.resolve();
        const settled = await Promise.allSettled([lifecycleRevokeLock, revoke]);
        revokeTransitionResult = settled[0];
        revokeResult = settled[1];
      }
      if (revokeTransitionResult.status === "rejected") throw revokeTransitionResult.reason;
      if (revokeResult.status === "fulfilled") {
        throw new Error("Token revocation survived password-reset authority loss");
      }
      assertEquals((revokeResult.reason as DomainError).code, "account_unavailable");
      assertEquals(
        (await repository.listApiTokens(revokeOwner.id))[0].revokedAt,
        null,
      );
      assertEquals(
        Number(
          (await observer`SELECT count(*) count FROM audit_events
            WHERE action='api_token.revoked' AND target_id=${revokeToken.id}`)[0].count,
        ),
        0,
      );
    } finally {
      for (const release of releaseGates) release();
      await Promise.allSettled(pendingOperations);
      await repository.close();
      await blocker.end();
      await observer.end();
    }
  },
});
