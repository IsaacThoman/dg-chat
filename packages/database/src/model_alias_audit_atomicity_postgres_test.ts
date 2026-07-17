import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

const audit = (
  actorId: string,
  action: "model_alias.created" | "model_alias.updated" | "model_alias.deleted",
  expectedAuthorityEpoch = 1,
) => ({
  actorId,
  action,
  targetType: "model_alias",
  targetId: "caller-controlled-target-must-not-win",
  metadata: { source: "model-alias-atomicity-test" },
  requireEmailVerification: false,
  expectedAuthorityEpoch,
});

Deno.test({
  name: "Postgres model-alias create, update, and delete are authority-fenced atomic audits",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        `TRUNCATE model_aliases,model_price_versions,provider_models,providers,
          audit_events,users RESTART IDENTITY CASCADE`,
      );
      await sql.unsafe(`
        CREATE TABLE dg_test_failed_model_alias_audits(action text PRIMARY KEY);
        CREATE FUNCTION dg_test_fail_model_alias_audit()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF EXISTS(
            SELECT 1 FROM public.dg_test_failed_model_alias_audits failed
            WHERE failed.action=NEW.action
          ) THEN
            RAISE EXCEPTION 'injected model-alias audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_fail_model_alias_audit
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION dg_test_fail_model_alias_audit();
      `);
      const actor = await repository.createUser({
        email: "model-alias-postgres@example.test",
        name: "Model alias PostgreSQL admin",
        role: "admin",
        approvalStatus: "approved",
      });
      const providerId = crypto.randomUUID();
      const modelId = crypto.randomUUID();
      await sql`INSERT INTO providers(id,slug,display_name,base_url,protocol)
        VALUES(${providerId},'model-alias-atomicity','Model alias atomicity',
          'https://example.test/v1','responses')`;
      await sql`INSERT INTO provider_models(
          id,provider_id,public_model_id,upstream_model_id,display_name,capabilities,
          context_window,enabled
        ) VALUES(
          ${modelId},${providerId},'canonical/model','canonical-upstream','Canonical model',
          '["chat"]',4096,true
        )`;
      const fail = async (action: string) => {
        await sql`INSERT INTO dg_test_failed_model_alias_audits(action) VALUES(${action})`;
      };
      const allow = async (action: string) => {
        await sql`DELETE FROM dg_test_failed_model_alias_audits WHERE action=${action}`;
      };

      await fail("model_alias.created");
      await assertRejects(
        () =>
          repository.createModelAlias(
            { alias: "must-not-exist", targetModelId: modelId },
            audit(actor.id, "model_alias.created"),
          ),
        Error,
        "injected model-alias audit failure",
      );
      assertEquals(await repository.listModelAliases(), []);

      await allow("model_alias.created");
      const created = await repository.createModelAlias(
        { alias: "durable/alias", targetModelId: modelId, description: "before" },
        audit(actor.id, "model_alias.created"),
      );
      assertEquals(
        String(
          (await sql`SELECT target_id FROM audit_events WHERE action='model_alias.created'`)[0]
            .target_id,
        ),
        created.id,
      );

      await fail("model_alias.updated");
      await assertRejects(
        () =>
          repository.updateModelAlias(
            created.id,
            { expectedVersion: created.version, alias: "must-not-persist" },
            audit(actor.id, "model_alias.updated"),
          ),
        Error,
        "injected model-alias audit failure",
      );
      assertEquals(await repository.listModelAliases(), [created]);

      await fail("model_alias.deleted");
      await assertRejects(
        () =>
          repository.deleteModelAlias(
            created.id,
            created.version,
            audit(actor.id, "model_alias.deleted"),
          ),
        Error,
        "injected model-alias audit failure",
      );
      assertEquals(await repository.listModelAliases(), [created]);

      await allow("model_alias.updated");
      await allow("model_alias.deleted");
      await sql`UPDATE users SET authority_epoch=authority_epoch+1 WHERE id=${actor.id}`;
      for (
        const operation of [
          () =>
            repository.createModelAlias(
              { alias: "stale-create", targetModelId: modelId },
              audit(actor.id, "model_alias.created"),
            ),
          () =>
            repository.updateModelAlias(
              created.id,
              { expectedVersion: created.version, alias: "stale-update" },
              audit(actor.id, "model_alias.updated"),
            ),
          () =>
            repository.deleteModelAlias(
              created.id,
              created.version,
              audit(actor.id, "model_alias.deleted"),
            ),
        ]
      ) {
        const error = await assertRejects(operation, DomainError);
        assertEquals(error.code, "admin_authority_required");
      }
      assertEquals(await repository.listModelAliases(), [created]);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
          WHERE action LIKE 'model_alias.%'`)[0].count,
        ),
        1,
      );
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS dg_test_fail_model_alias_audit ON audit_events;
        DROP FUNCTION IF EXISTS dg_test_fail_model_alias_audit();
        DROP TABLE IF EXISTS dg_test_failed_model_alias_audits;
      `).catch(() => undefined);
      await repository.close();
      await sql.end();
    }
  },
});
