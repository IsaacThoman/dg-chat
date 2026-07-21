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
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ pid: number }[]>`
      SELECT pid::int pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ${blockerPid}=ANY(pg_blocking_pids(pid))
        AND query ILIKE ${queryPattern}
      LIMIT 1
    `;
    if (rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for access-group mutation to lock its actor");
}

const audit = (actorId: string, action: string) => ({
  actorId,
  action,
  targetType: "model_access_group",
  targetId: "caller-controlled-target-must-not-win",
  metadata: { source: "atomicity-test" },
  requireEmailVerification: false,
  expectedAuthorityEpoch: 1,
});

Deno.test({
  name: "Postgres access-group metadata mutations enforce authority and atomic audit",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        "TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups," +
          "audit_events,users RESTART IDENTITY CASCADE",
      );
      await sql.unsafe(`
        CREATE TABLE dg_test_failed_access_group_audits(action text PRIMARY KEY);
        CREATE FUNCTION dg_test_fail_access_group_audit()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF EXISTS(
            SELECT 1 FROM public.dg_test_failed_access_group_audits failed
            WHERE failed.action=NEW.action
          ) THEN
            RAISE EXCEPTION 'injected access-group audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_fail_access_group_audit
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION dg_test_fail_access_group_audit();
        CREATE FUNCTION dg_test_raise_unrelated_group_unique()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF NEW.name='Synthetic unrelated unique' THEN
            RAISE EXCEPTION USING
              ERRCODE='23505',
              MESSAGE='synthetic unrelated access-group uniqueness failure',
              CONSTRAINT='synthetic_access_group_uq';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_raise_unrelated_group_unique
          BEFORE INSERT OR UPDATE ON access_groups
          FOR EACH ROW EXECUTE FUNCTION dg_test_raise_unrelated_group_unique();
      `);
      const actor = await repository.createUser({
        email: "access-group-pg@example.test",
        name: "Access group PostgreSQL admin",
        role: "admin",
        approvalStatus: "approved",
      });
      const nonAdmin = await repository.createUser({
        email: "access-group-pg-user@example.test",
        name: "Access group PostgreSQL user",
        approvalStatus: "approved",
      });
      const fail = async (action: string) => {
        await sql`INSERT INTO dg_test_failed_access_group_audits(action) VALUES(${action})`;
      };
      const allow = async (action: string) => {
        await sql`DELETE FROM dg_test_failed_access_group_audits WHERE action=${action}`;
      };

      await fail("model_access_group.created");
      await assertRejects(
        () =>
          repository.createAccessGroup(
            { name: "Must roll back", description: "not durable" },
            audit(actor.id, "model_access_group.created"),
          ),
        Error,
        "injected access-group audit failure",
      );
      assertEquals(
        (await repository.listAccessGroups(audit(actor.id, "test.read"))).length,
        0,
      );

      await allow("model_access_group.created");
      const created = await repository.createAccessGroup(
        { name: "Durable", description: "before" },
        audit(actor.id, "model_access_group.created"),
      );
      const creationAudit = (await sql<{
        actor_id: string;
        target_id: string;
        metadata: {
          source: string;
          after: {
            name: string;
            description: string;
            userIds: string[];
            modelIds: string[];
            tokenIds: string[];
          };
        };
      }[]>`SELECT actor_id,target_id,metadata FROM audit_events
        WHERE action='model_access_group.created'`)[0];
      assertEquals(String(creationAudit.actor_id), actor.id);
      assertEquals(creationAudit.target_id, created.id);
      assertEquals(creationAudit.metadata, {
        source: "atomicity-test",
        after: {
          name: "Durable",
          description: "before",
          userIds: [],
          modelIds: [],
          tokenIds: [],
        },
      });

      const duplicateCreateError = await assertRejects(
        () =>
          repository.createAccessGroup(
            { name: "durable" },
            audit(actor.id, "model_access_group.created"),
          ),
        DomainError,
      );
      assertEquals(duplicateCreateError.code, "conflict");
      assertEquals(duplicateCreateError.status, 409);

      const noOpError = await assertRejects(
        () =>
          repository.updateAccessGroup(
            created.id,
            { expectedVersion: created.version },
            audit(actor.id, "model_access_group.updated"),
          ),
        DomainError,
      );
      assertEquals(noOpError.code, "validation_error");
      assertEquals(
        (await repository.listAccessGroups(audit(actor.id, "test.read")))[0],
        created,
      );

      await fail("model_access_group.updated");
      await assertRejects(
        () =>
          repository.updateAccessGroup(
            created.id,
            {
              expectedVersion: created.version,
              name: "Must not persist",
              description: "must not persist",
            },
            audit(actor.id, "model_access_group.updated"),
          ),
        Error,
        "injected access-group audit failure",
      );
      assertEquals(
        (await repository.listAccessGroups(audit(actor.id, "test.read")))[0],
        created,
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
            WHERE action='model_access_group.updated'`)[0].count,
        ),
        0,
      );

      await allow("model_access_group.updated");
      const updated = await repository.updateAccessGroup(
        created.id,
        {
          expectedVersion: created.version,
          name: "Renamed",
          description: "after",
        },
        audit(actor.id, "model_access_group.updated"),
      );
      const updateAudit = (await sql<{
        metadata: {
          source: string;
          before: { name: string; description: string };
          after: { name: string; description: string };
        };
      }[]>`SELECT metadata FROM audit_events
        WHERE action='model_access_group.updated'`)[0];
      assertEquals(updateAudit.metadata, {
        source: "atomicity-test",
        before: { name: "Durable", description: "before" },
        after: { name: "Renamed", description: "after" },
      });

      const assertUnrelatedUniqueError = (error: Error) => {
        const postgresError = error as Error & { code?: string; constraint_name?: string };
        assertEquals(error instanceof DomainError, false);
        assertEquals(postgresError.code, "23505");
        assertEquals(postgresError.constraint_name, "synthetic_access_group_uq");
      };
      assertUnrelatedUniqueError(
        await assertRejects(
          () =>
            repository.createAccessGroup(
              { name: "Synthetic unrelated unique" },
              audit(actor.id, "model_access_group.created"),
            ),
          Error,
        ),
      );
      assertUnrelatedUniqueError(
        await assertRejects(
          () =>
            repository.updateAccessGroup(
              created.id,
              {
                expectedVersion: updated.version,
                name: "Synthetic unrelated unique",
              },
              audit(actor.id, "model_access_group.updated"),
            ),
          Error,
        ),
      );
      assertUnrelatedUniqueError(
        await assertRejects(
          () =>
            repository.replaceAccessGroupPolicy(created.id, {
              expectedVersion: updated.version,
              name: "Synthetic unrelated unique",
              userIds: [],
              modelIds: [],
              tokenIds: [],
              acknowledgePublicModelIds: [],
            }, audit(actor.id, "model_access_group.policy_replaced")),
          Error,
        ),
      );
      assertEquals(
        (await repository.listAccessGroups(audit(actor.id, "test.read")))[0],
        updated,
      );

      const conflictingGroupId = crypto.randomUUID();
      await sql`INSERT INTO access_groups(id,name,description)
        VALUES(${conflictingGroupId},'Existing name','')`;
      const duplicateUpdateError = await assertRejects(
        () =>
          repository.updateAccessGroup(
            created.id,
            { expectedVersion: updated.version, name: "existing NAME" },
            audit(actor.id, "model_access_group.updated"),
          ),
        DomainError,
      );
      assertEquals(duplicateUpdateError.code, "conflict");
      assertEquals(duplicateUpdateError.status, 409);
      await sql`DELETE FROM access_groups WHERE id=${conflictingGroupId}`;

      const authorityError = await assertRejects(
        () =>
          repository.updateAccessGroup(
            created.id,
            { expectedVersion: updated.version, name: "Unauthorized" },
            audit(nonAdmin.id, "model_access_group.updated"),
          ),
        DomainError,
      );
      assertEquals(authorityError.code, "admin_authority_required");
      assertEquals(
        (await repository.listAccessGroups(audit(actor.id, "test.read")))[0],
        updated,
      );

      const actorLocked = Promise.withResolvers<number>();
      const releaseAuthorityChange = Promise.withResolvers<void>();
      const authorityChange = sql.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${actor.id} FOR UPDATE`;
        actorLocked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
        await releaseAuthorityChange.promise;
        await tx`UPDATE users SET password_reset_pending=true,
          authority_epoch=authority_epoch+1,updated_at=now() WHERE id=${actor.id}`;
      });
      const blockerPid = await actorLocked.promise;
      const racedCreate = repository.createAccessGroup(
        { name: "Must not survive authority loss" },
        audit(actor.id, "model_access_group.created"),
      );
      let authorityChangeResult!: PromiseSettledResult<unknown>;
      let racedCreateResult!: PromiseSettledResult<Awaited<typeof racedCreate>>;
      try {
        await waitForQueryBlockedBy(
          sql,
          blockerPid,
          "%SELECT * FROM users%FOR UPDATE%",
        );
      } finally {
        releaseAuthorityChange.resolve();
        const settled = await Promise.allSettled([authorityChange, racedCreate]);
        authorityChangeResult = settled[0];
        racedCreateResult = settled[1];
      }
      if (authorityChangeResult.status === "rejected") {
        throw authorityChangeResult.reason;
      }
      if (racedCreateResult.status === "fulfilled") {
        throw new Error("Access-group creation survived password-reset authority loss");
      }
      const racedAuthorityError = racedCreateResult.reason as DomainError;
      assertEquals(racedAuthorityError.code, "admin_authority_required");
      assertEquals(
        (await sql<{ name: string }[]>`SELECT name FROM access_groups ORDER BY name`).map((group) =>
          group.name
        ),
        ["Renamed"],
      );
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS dg_test_raise_unrelated_group_unique ON access_groups;
        DROP FUNCTION IF EXISTS dg_test_raise_unrelated_group_unique();
        DROP TRIGGER IF EXISTS dg_test_fail_access_group_audit ON audit_events;
        DROP FUNCTION IF EXISTS dg_test_fail_access_group_audit();
        DROP TABLE IF EXISTS dg_test_failed_access_group_audits;
      `).catch(() => undefined);
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres access-group membership uses FK-compatible group locks",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 3 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        "TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups," +
          "audit_events,users RESTART IDENTITY CASCADE",
      );
      const actor = await repository.createUser({
        email: "access-group-lock-admin@example.test",
        name: "Access group lock administrator",
        role: "admin",
        approvalStatus: "approved",
      });
      const member = await repository.createUser({
        email: "access-group-lock-member@example.test",
        name: "Access group lock member",
        approvalStatus: "approved",
      });
      const membershipGroup = await repository.createAccessGroup(
        { name: "Membership lock order" },
        audit(actor.id, "model_access_group.created"),
      );

      const memberLocked = Promise.withResolvers<number>();
      const releaseMember = Promise.withResolvers<void>();
      const memberBlocker = sql.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${member.id} FOR UPDATE`;
        memberLocked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
        await releaseMember.promise;
      });
      const blockerPid = await memberLocked.promise;
      const membershipUpdate = repository.replaceAccessGroupUsers(
        membershipGroup.id,
        [member.id],
        membershipGroup.version,
        audit(actor.id, "model_access_group.users_replaced"),
      );
      try {
        await waitForQueryBlockedBy(
          sql,
          blockerPid,
          "%SELECT * FROM users%FOR UPDATE%",
        );
        await sql.begin(async (tx) => {
          await tx`SELECT id FROM access_groups
            WHERE id=${membershipGroup.id} FOR KEY SHARE NOWAIT`;
        });
      } finally {
        releaseMember.resolve();
        await Promise.allSettled([memberBlocker, membershipUpdate]);
      }
      const updatedGroup = await membershipUpdate;
      assertEquals(updatedGroup.userIds, [member.id]);

      const token = await repository.createApiToken(member.id, {
        name: "group lock compatibility",
        scopes: ["models:read"],
        tokenHash: "group-lock-compatibility-token",
        preview: "dg_glc",
      }, member.authorityEpoch);
      const groupLocked = Promise.withResolvers<void>();
      const releaseGroup = Promise.withResolvers<void>();
      const groupBlocker = sql.begin(async (tx) => {
        await tx`SELECT id FROM access_groups
          WHERE id=${membershipGroup.id} FOR NO KEY UPDATE`;
        groupLocked.resolve();
        await releaseGroup.promise;
      });
      await groupLocked.promise;
      const tokenAssignment = repository.setTokenAccessGroups(
        member.id,
        token.id,
        [membershipGroup.id],
        token.version,
        audit(actor.id, "api_token.access_groups_replaced"),
      );
      let assignmentBeforeRelease:
        | { kind: "completed"; value: Awaited<typeof tokenAssignment> }
        | { kind: "timeout" }
        | undefined;
      try {
        assignmentBeforeRelease = await Promise.race([
          tokenAssignment.then((value) => ({ kind: "completed" as const, value })),
          new Promise<{ kind: "timeout" }>((resolve) =>
            setTimeout(() => resolve({ kind: "timeout" }), 5_000)
          ),
        ]);
      } finally {
        releaseGroup.resolve();
        await groupBlocker.catch(() => undefined);
        if (!assignmentBeforeRelease) await Promise.allSettled([tokenAssignment]);
      }
      if (assignmentBeforeRelease.kind === "timeout") {
        await Promise.allSettled([tokenAssignment]);
        throw new Error("Token group assignment blocked behind a non-key group update");
      }
      assertEquals(assignmentBeforeRelease.value.accessMode, "restricted");
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
