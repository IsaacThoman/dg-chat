import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres creates metadata, initial policy, expanded token family, and audit atomically",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        `TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups,
          provider_models,providers,api_tokens,audit_events,users RESTART IDENTITY CASCADE`,
      );
      await sql.unsafe(`
        CREATE TABLE dg_test_failed_atomic_group_create_audits(action text PRIMARY KEY);
        CREATE FUNCTION dg_test_fail_atomic_group_create_audit()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF EXISTS(
            SELECT 1 FROM public.dg_test_failed_atomic_group_create_audits failed
            WHERE failed.action=NEW.action
          ) THEN
            RAISE EXCEPTION 'injected atomic group create audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_fail_atomic_group_create_audit
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION dg_test_fail_atomic_group_create_audit();
      `);
      const actor = await repository.createUser({
        email: "atomic-group-create-pg@example.test",
        name: "Atomic group PostgreSQL administrator",
        role: "admin",
        approvalStatus: "approved",
      });
      const providerId = crypto.randomUUID();
      const modelId = crypto.randomUUID();
      await sql`INSERT INTO providers(id,slug,display_name,base_url,protocol)
        VALUES(${providerId},'atomic-group-create','Atomic group create',
          'https://example.com/v1','responses')`;
      await sql`INSERT INTO provider_models(
          id,provider_id,public_model_id,upstream_model_id,display_name,
          capabilities,context_window,enabled
        ) VALUES(${modelId},${providerId},'atomic/create','atomic-create','Atomic create',
          '["chat"]',4096,true)`;
      const original = await repository.createApiToken(actor.id, {
        name: "PostgreSQL family",
        scopes: ["models:read"],
        tokenHash: "atomic-group-pg-old",
        preview: "dg_pg_old",
      }, actor.authorityEpoch);
      const rotated = await repository.rotateApiToken(actor.id, original.id, {
        expectedVersion: original.version,
        tokenHash: "atomic-group-pg-new",
        preview: "dg_pg_new",
        overlapSeconds: 60,
      }, actor.authorityEpoch);
      const audit = {
        actorId: actor.id,
        action: "model_access_group.created",
        targetType: "model_access_group",
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      };
      const beforeFailure = await repository.listApiTokens(actor.id);

      await sql`INSERT INTO dg_test_failed_atomic_group_create_audits(action)
        VALUES('model_access_group.created')`;
      await assertRejects(
        () =>
          repository.createAccessGroup({
            name: "Must roll back",
            userIds: [actor.id],
            modelIds: [modelId],
            tokenIds: [rotated.replacement.id],
          }, audit),
        Error,
        "injected atomic group create audit failure",
      );
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM access_groups`)[0].count,
        0,
      );
      assertEquals(await repository.listApiTokens(actor.id), beforeFailure);

      await sql`DELETE FROM dg_test_failed_atomic_group_create_audits`;
      const created = await repository.createAccessGroup({
        name: "Atomic PostgreSQL restriction",
        description: "Complete at version one",
        userIds: [actor.id, actor.id],
        modelIds: [modelId, modelId],
        tokenIds: [rotated.replacement.id],
      }, audit);
      assertEquals(created.version, 1);
      assertEquals(created.userIds, [actor.id]);
      assertEquals(created.modelIds, [modelId]);
      assertEquals(
        [...created.tokenIds].sort(),
        [original.id, rotated.replacement.id].sort(),
      );
      assertEquals(
        (await repository.listApiTokens(actor.id)).every((token) =>
          token.accessMode === "restricted"
        ),
        true,
      );
      const events = await sql<
        { target_id: string; metadata: { after: { tokenIds: string[] } } }[]
      >`SELECT target_id,metadata FROM audit_events
        WHERE action='model_access_group.created' ORDER BY created_at DESC LIMIT 1`;
      assertEquals(events[0].target_id, created.id);
      assertEquals(
        [...events[0].metadata.after.tokenIds].sort(),
        [...created.tokenIds].sort(),
      );

      const ownerError = await assertRejects(
        () =>
          repository.createAccessGroup({
            name: "Owner omitted",
            tokenIds: [original.id],
          }, audit),
        DomainError,
      );
      assertEquals(ownerError.code, "validation_error");
      assertEquals(
        (await repository.listAccessGroups({
          actorId: actor.id,
          requireEmailVerification: false,
          expectedAuthorityEpoch: actor.authorityEpoch,
        })).map((group) => group.name),
        ["Atomic PostgreSQL restriction"],
      );

      const empty = await repository.createAccessGroup({ name: "Legacy empty" }, audit);
      assertEquals(empty.userIds, []);
      assertEquals(empty.modelIds, []);
      assertEquals(empty.tokenIds, []);
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS dg_test_fail_atomic_group_create_audit ON audit_events;
        DROP FUNCTION IF EXISTS dg_test_fail_atomic_group_create_audit();
        DROP TABLE IF EXISTS dg_test_failed_atomic_group_create_audits;
      `).catch(() => undefined);
      await repository.close();
      await sql.end();
    }
  },
});
