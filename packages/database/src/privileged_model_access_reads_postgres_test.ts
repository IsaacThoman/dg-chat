import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";
import type { PrivilegedReadContext } from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function waitUntilBlocked(observer: postgres.Sql, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ blocked: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ILIKE '%SELECT * FROM users%'
      ) blocked
    `;
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label} to block on administrator authority`);
}

Deno.test({
  name: "Postgres model-access reads wait for and revalidate concurrent authority loss",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const observer = postgres(databaseUrl!, { max: 1 });
    const blocker = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        observer,
        `TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups,
          api_tokens,audit_events,users RESTART IDENTITY CASCADE`,
      );
      const actor = await repository.createUser({
        email: "privileged-read-postgres@example.test",
        name: "Privileged read PostgreSQL administrator",
        role: "admin",
        approvalStatus: "approved",
      });
      const group = await repository.createAccessGroup({ name: "Sensitive group" }, {
        actorId: actor.id,
        action: "test.model_access_group.created",
        targetType: "model_access_group",
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      });
      await repository.createApiToken(actor.id, {
        name: "Sensitive token",
        scopes: ["models:read"],
        tokenHash: "sensitive-postgres-token-hash",
        preview: "dg_sensitive",
      }, actor.authorityEpoch);

      const reads = [
        {
          label: "group list",
          run: (context: PrivilegedReadContext) => repository.listAccessGroups(context),
        },
        {
          label: "policy impact",
          run: (context: PrivilegedReadContext) =>
            repository.previewAccessGroupPolicyImpact(context, group.id, null),
        },
        {
          label: "token search",
          run: (context: PrivilegedReadContext) => repository.searchApiTokens(context),
        },
      ];

      const validContext: PrivilegedReadContext = {
        actorId: actor.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      };
      for (
        const malformed of [
          { ...validContext, expectedAuthorityEpoch: undefined },
          { ...validContext, requireEmailVerification: undefined },
          { ...validContext, actorId: "" },
        ]
      ) {
        for (const read of reads) {
          const error = await assertRejects(
            () => read.run(malformed as unknown as PrivilegedReadContext),
            DomainError,
          );
          assertEquals(error.code, "admin_authority_required");
        }
      }

      for (const read of reads) {
        const epochRows = await observer<{ authority_epoch: number }[]>`
          SELECT authority_epoch::int authority_epoch FROM users WHERE id=${actor.id}
        `;
        const admitted: PrivilegedReadContext = {
          actorId: actor.id,
          requireEmailVerification: false,
          expectedAuthorityEpoch: Number(epochRows[0].authority_epoch),
        };
        const authorityChanged = Promise.withResolvers<void>();
        const releaseAuthorityChange = Promise.withResolvers<void>();
        const authorityLoss = blocker.begin(async (tx) => {
          await tx`UPDATE users SET authority_epoch=authority_epoch+1 WHERE id=${actor.id}`;
          authorityChanged.resolve();
          await releaseAuthorityChange.promise;
        });
        await authorityChanged.promise;

        const pendingRead = read.run(admitted);
        await waitUntilBlocked(observer, read.label);
        releaseAuthorityChange.resolve();
        await authorityLoss;
        const error = await assertRejects(() => pendingRead, DomainError);
        assertEquals(error.code, "admin_authority_required");
      }
    } finally {
      await repository.close();
      await blocker.end();
      await observer.end();
    }
  },
});
