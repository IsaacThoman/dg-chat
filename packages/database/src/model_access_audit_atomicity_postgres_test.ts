import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";
import type { PrivilegedAuditEventInput } from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function waitForWaiterBlockedBy(
  observer: postgres.Sql,
  blockerPid: number,
  queryPattern: string,
  label: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ pid: number }[]>`
      SELECT pid::int pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ${blockerPid}=ANY(pg_blocking_pids(pid))
        AND query ILIKE ${queryPattern}
      ORDER BY pid LIMIT 1
    `;
    if (rows[0]) return Number(rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

Deno.test({
  name: "Postgres model-access widening and mandatory audit append roll back together",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        `TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups,
          provider_models,providers,api_tokens,audit_events,users RESTART IDENTITY CASCADE`,
      );
      const actor = await repository.createUser({
        email: "model-access-audit-admin@example.test",
        name: "Model access audit administrator",
        role: "admin",
        approvalStatus: "approved",
      });
      const readContext = {
        actorId: actor.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      };
      const target = await repository.createUser({
        email: "model-access-audit-target@example.test",
        name: "Model access audit target",
        approvalStatus: "approved",
      });
      const providerId = crypto.randomUUID();
      const modelId = crypto.randomUUID();
      await sql`INSERT INTO providers(id,slug,display_name,base_url,protocol)
        VALUES(${providerId},'model-access-audit','Model access audit',
          'https://example.com/v1','responses')`;
      await sql`INSERT INTO provider_models(
          id,provider_id,public_model_id,upstream_model_id,display_name,
          capabilities,context_window,enabled
        ) VALUES(${modelId},${providerId},'audit/private','private','Audit private',
          '["chat"]',4096,true)`;
      const token = await repository.createApiToken(actor.id, {
        name: "model access audit token",
        scopes: ["models:read"],
        tokenHash: "postgres-model-access-audit-token",
        preview: "dg_audit",
      }, actor.authorityEpoch);
      const group = await repository.createAccessGroup({ name: "Audit restriction" }, {
        actorId: actor.id,
        action: "test.model_access_group.created",
        targetType: "model_access_group",
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      });
      const withUser = await repository.replaceAccessGroupUsers(
        group.id,
        [actor.id],
        group.version,
        {
          actorId: actor.id,
          action: "test.model_access_group.users_replaced",
          targetType: "model_access_group",
          targetId: group.id,
          requireEmailVerification: false,
          expectedAuthorityEpoch: actor.authorityEpoch,
        },
      );
      const restricted = await repository.replaceAccessGroupModels(
        group.id,
        [modelId],
        withUser.version,
        [],
        {
          actorId: actor.id,
          action: "test.model_access_group.models_replaced",
          targetType: "model_access_group",
          targetId: group.id,
          requireEmailVerification: false,
          expectedAuthorityEpoch: actor.authorityEpoch,
        },
      );
      const missingAudit = undefined as unknown as PrivilegedAuditEventInput;
      for (
        const operation of [
          () =>
            repository.deleteAccessGroup(
              group.id,
              restricted.version,
              [modelId],
              missingAudit,
            ),
          () =>
            repository.replaceAccessGroupUsers(
              group.id,
              [actor.id],
              restricted.version,
              missingAudit,
            ),
          () =>
            repository.replaceAccessGroupModels(
              group.id,
              [],
              restricted.version,
              [modelId],
              missingAudit,
            ),
          () =>
            repository.replaceAccessGroupPolicy(group.id, {
              expectedVersion: restricted.version,
              userIds: [actor.id],
              modelIds: [],
              tokenIds: [],
              acknowledgePublicModelIds: [modelId],
            }, missingAudit),
        ]
      ) {
        const error = await assertRejects(operation, DomainError);
        assertEquals(error.code, "admin_authority_required");
      }
      assertEquals(
        (await repository.listAccessGroups(readContext)).find((candidate) =>
          candidate.id === group.id
        ),
        restricted,
      );
      const validAudit = {
        actorId: actor.id,
        action: "model_access_group.users_replaced",
        targetType: "model_access_group",
        targetId: group.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      };
      for (
        const malformedAudit of [
          { ...validAudit, expectedAuthorityEpoch: undefined },
          { ...validAudit, requireEmailVerification: undefined },
          { ...validAudit, action: "" },
          { ...validAudit, targetType: "" },
          { ...validAudit, actorId: "" },
        ]
      ) {
        const error = await assertRejects(
          () =>
            repository.replaceAccessGroupUsers(
              group.id,
              [actor.id],
              restricted.version,
              malformedAudit as unknown as PrivilegedAuditEventInput,
            ),
          DomainError,
        );
        assertEquals(error.code, "admin_authority_required");
      }
      assertEquals(
        (await repository.listAccessGroups(readContext)).find((candidate) =>
          candidate.id === group.id
        ),
        restricted,
      );

      await sql.unsafe(`
        CREATE TABLE dg_test_failed_model_access_audits(action text PRIMARY KEY);
        CREATE FUNCTION dg_test_fail_model_access_audit()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF EXISTS(
            SELECT 1 FROM public.dg_test_failed_model_access_audits failed
            WHERE failed.action=NEW.action
          ) THEN
            RAISE EXCEPTION 'injected model access audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_fail_model_access_audit
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION dg_test_fail_model_access_audit();
      `);
      const fail = async (action: string) => {
        await sql`INSERT INTO dg_test_failed_model_access_audits(action) VALUES(${action})`;
      };
      const allow = async (action: string) => {
        await sql`DELETE FROM dg_test_failed_model_access_audits WHERE action=${action}`;
      };
      const audit = (action: string, metadata: Record<string, unknown> = {}) => ({
        actorId: actor.id,
        action,
        targetType: "model_access_group",
        targetId: group.id,
        metadata,
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      });

      await fail("model_access_group.users_replaced");
      await assertRejects(
        () =>
          repository.replaceAccessGroupUsers(
            group.id,
            [target.id],
            restricted.version,
            audit("model_access_group.users_replaced", { userCount: 1 }),
          ),
        Error,
        "injected model access audit failure",
      );
      assertEquals(
        (await repository.listAccessGroups(readContext)).find((candidate) =>
          candidate.id === group.id
        ),
        restricted,
      );

      await fail("model_access_group.policy_replaced");
      await assertRejects(
        () =>
          repository.replaceAccessGroupPolicy(group.id, {
            expectedVersion: restricted.version,
            userIds: [actor.id],
            modelIds: [],
            tokenIds: [token.id],
            acknowledgePublicModelIds: [modelId],
          }, audit("model_access_group.policy_replaced", { modelCount: 0 })),
        Error,
        "injected model access audit failure",
      );
      assertEquals(
        (await repository.listAccessGroups(readContext)).find((candidate) =>
          candidate.id === group.id
        ),
        restricted,
      );
      assertEquals((await repository.listApiTokens(actor.id))[0].version, token.version);

      await fail("model_access_group.models_replaced");
      await assertRejects(
        () =>
          repository.replaceAccessGroupModels(
            group.id,
            [],
            restricted.version,
            [modelId],
            audit("model_access_group.models_replaced", { modelCount: 0 }),
          ),
        Error,
        "injected model access audit failure",
      );
      assertEquals(
        (await repository.listAccessGroups(readContext)).find((candidate) =>
          candidate.id === group.id
        ),
        restricted,
      );

      await fail("model_access_group.deleted");
      await assertRejects(
        () =>
          repository.deleteAccessGroup(
            group.id,
            restricted.version,
            [modelId],
            audit("model_access_group.deleted"),
          ),
        Error,
        "injected model access audit failure",
      );
      assertEquals(
        (await repository.listAccessGroups(readContext)).find((candidate) =>
          candidate.id === group.id
        ),
        restricted,
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
            WHERE action LIKE 'model_access_group.%'`)[0].count,
        ),
        0,
      );

      await allow("model_access_group.models_replaced");
      const widened = await repository.replaceAccessGroupModels(
        group.id,
        [],
        restricted.version,
        [modelId],
        audit("model_access_group.models_replaced", { modelCount: 0 }),
      );
      assertEquals(widened.modelIds, []);
      const recorded = (await sql<{ metadata: { modelIdsBecomingPublic: string[] } }[]>`
        SELECT metadata FROM audit_events
        WHERE action='model_access_group.models_replaced' ORDER BY created_at DESC,id DESC LIMIT 1
      `)[0];
      assertEquals(recorded.metadata.modelIdsBecomingPublic, [modelId]);
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS dg_test_fail_model_access_audit ON audit_events;
        DROP FUNCTION IF EXISTS dg_test_fail_model_access_audit();
        DROP TABLE IF EXISTS dg_test_failed_model_access_audits;
      `).catch(() => undefined);
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres model-access widening is serialized with administrator authority loss",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const observer = postgres(databaseUrl!, { max: 1 });
    const blocker = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const tokenLocked = Promise.withResolvers<number>();
    const releaseToken = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    try {
      await runAuditTestMaintenanceSql(
        observer,
        `TRUNCATE access_group_models,access_groups,provider_models,providers,api_tokens,
          audit_events,users RESTART IDENTITY CASCADE`,
      );
      const actor = await repository.createUser({
        email: "widening-race-admin@example.test",
        name: "Widening race administrator",
        role: "admin",
        approvalStatus: "approved",
      });
      const controller = await repository.createUser({
        email: "widening-race-controller@example.test",
        name: "Widening race controller",
        role: "admin",
        approvalStatus: "approved",
      });
      const providerId = crypto.randomUUID();
      const modelId = crypto.randomUUID();
      await observer`INSERT INTO providers(id,slug,display_name,base_url,protocol)
        VALUES(${providerId},'widening-authority-race','Widening authority race',
          'https://example.com/v1','responses')`;
      await observer`INSERT INTO provider_models(
          id,provider_id,public_model_id,upstream_model_id,display_name,
          capabilities,context_window,enabled
        ) VALUES(${modelId},${providerId},'race/private','private','Race private',
          '["chat"]',4096,true)`;
      const token = await repository.createApiToken(actor.id, {
        name: "authority race token",
        scopes: ["models:read"],
        tokenHash: "model-access-authority-race",
        preview: "dg_race",
      }, actor.authorityEpoch);
      const group = await repository.createAccessGroup({ name: "Authority race restriction" }, {
        actorId: actor.id,
        action: "test.model_access_group.created",
        targetType: "model_access_group",
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      });
      const restricted = await repository.replaceAccessGroupModels(
        group.id,
        [modelId],
        group.version,
        [],
        {
          actorId: actor.id,
          action: "test.model_access_group.models_replaced",
          targetType: "model_access_group",
          targetId: group.id,
          requireEmailVerification: false,
          expectedAuthorityEpoch: actor.authorityEpoch,
        },
      );

      const heldToken = blocker.begin(async (tx) => {
        await tx`SELECT id FROM api_tokens WHERE id=${token.id} FOR UPDATE`;
        tokenLocked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
        await releaseToken.promise;
      });
      pending.push(heldToken);
      const tokenBlockerPid = await tokenLocked.promise;
      const authorityLoss = repository.setAdminUserRole({
        actorId: controller.id,
        expectedAuthorityEpoch: 1,
        targetUserId: actor.id,
        expectedVersion: actor.version,
        role: "user",
        reason: "Exercise widening authorization serialization",
        requireEmailVerification: false,
      });
      pending.push(authorityLoss);
      const authorityLossPid = await waitForWaiterBlockedBy(
        observer,
        tokenBlockerPid,
        "%UPDATE api_tokens SET revoked_at%",
        "administrator demotion to hold the actor row while waiting on its token",
      );
      const widening = repository.replaceAccessGroupModels(
        group.id,
        [],
        restricted.version,
        [modelId],
        {
          actorId: actor.id,
          action: "model_access_group.models_replaced",
          targetType: "model_access_group",
          targetId: group.id,
          metadata: { modelCount: 0 },
          requireEmailVerification: false,
          expectedAuthorityEpoch: actor.authorityEpoch,
        },
      );
      pending.push(widening);
      await waitForWaiterBlockedBy(
        observer,
        authorityLossPid,
        "%SELECT * FROM users%FOR UPDATE%",
        "model-access widening to wait on current administrator authority",
      );
      releaseToken.resolve();
      await heldToken;
      await authorityLoss;
      const error = await assertRejects(() => widening, DomainError);
      assertEquals(error.code, "admin_authority_required");
      assertEquals(
        (await repository.listAccessGroups({
          actorId: controller.id,
          requireEmailVerification: false,
          expectedAuthorityEpoch: controller.authorityEpoch,
        })).find((candidate) => candidate.id === group.id),
        restricted,
      );
    } finally {
      releaseToken.resolve();
      await Promise.allSettled(pending);
      await repository.close();
      await blocker.end();
      await observer.end();
    }
  },
});
