import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";
import type { PrivilegedAuditEventInput } from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const SPOOFED_TARGET = "caller-controlled-target-must-not-win";

function audit(
  actorId: string,
  expectedAuthorityEpoch: number,
  action: string,
  targetType: "model_access_group" | "api_token" = "model_access_group",
): PrivilegedAuditEventInput {
  return {
    actorId,
    action,
    targetType,
    targetId: SPOOFED_TARGET,
    requireEmailVerification: false,
    expectedAuthorityEpoch,
  };
}

async function reset(sql: postgres.Sql) {
  await runAuditTestMaintenanceSql(
    sql,
    "TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups," +
      "audit_events,api_tokens,users RESTART IDENTITY CASCADE",
  );
}

async function waitForBlockedQuery(
  observer: postgres.Sql,
  blockerPid: number,
  queryPattern: string,
): Promise<number> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ pid: number }[]>`
      SELECT pid::int pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ${blockerPid}=ANY(pg_blocking_pids(pid))
        AND query ILIKE ${queryPattern}
      ORDER BY pid LIMIT 1
    `;
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked query matching ${queryPattern}`);
}

Deno.test({
  name: "Postgres membership removal and group deletion fence every token generation",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 4 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await reset(sql);
      const actor = await repository.createUser({
        email: "membership-cas-pg-admin@example.test",
        name: "Membership CAS PostgreSQL admin",
        role: "admin",
        approvalStatus: "approved",
      });
      const owner = await repository.createUser({
        email: "membership-cas-pg-owner@example.test",
        name: "Membership CAS PostgreSQL owner",
        approvalStatus: "approved",
      });
      const original = await repository.createApiToken(owner.id, {
        name: "membership CAS family",
        scopes: ["models:read"],
        tokenHash: "membership-cas-pg-old",
        preview: "dg_mcp…old",
      }, owner.authorityEpoch);
      const created = await repository.createAccessGroup(
        { name: "PostgreSQL membership CAS" },
        audit(actor.id, actor.authorityEpoch, "pg.membership.group_created"),
      );
      let group = await repository.replaceAccessGroupPolicy(created.id, {
        expectedVersion: created.version,
        userIds: [owner.id],
        modelIds: [],
        tokenIds: [original.id],
        acknowledgePublicModelIds: [],
      }, audit(actor.id, actor.authorityEpoch, "pg.membership.policy_assigned"));
      const currentOriginal = (await repository.listApiTokens(owner.id)).find((token) =>
        token.id === original.id
      )!;
      const rotation = await repository.rotateApiToken(owner.id, original.id, {
        expectedVersion: currentOriginal.version,
        tokenHash: "membership-cas-pg-new",
        preview: "dg_mcp…new",
        overlapSeconds: 30,
      }, owner.authorityEpoch);
      const beforeRemoval = new Map(
        (await repository.listApiTokens(owner.id)).map((token) => [token.id, token]),
      );

      group = await repository.replaceAccessGroupUsers(
        group.id,
        [],
        group.version,
        audit(actor.id, actor.authorityEpoch, "pg.membership.users_removed"),
      );
      assertEquals(group.tokenIds, []);
      for (const tokenId of [original.id, rotation.replacement.id]) {
        const before = beforeRemoval.get(tokenId)!;
        const after = (await repository.listApiTokens(owner.id)).find((token) =>
          token.id === tokenId
        )!;
        assertEquals(after.accessMode, "restricted");
        assertEquals(after.version, before.version + 1);
      }
      const staleRemovalCas = await assertRejects(
        () =>
          repository.setTokenAccessMode(
            owner.id,
            rotation.replacement.id,
            "inherit",
            beforeRemoval.get(rotation.replacement.id)!.version,
            audit(
              actor.id,
              actor.authorityEpoch,
              "pg.membership.stale_mode_after_removal",
              "api_token",
            ),
          ),
        DomainError,
      );
      assertEquals(staleRemovalCas.code, "version_conflict");

      group = await repository.replaceAccessGroupPolicy(group.id, {
        expectedVersion: group.version,
        userIds: [owner.id],
        modelIds: [],
        tokenIds: [rotation.replacement.id],
        acknowledgePublicModelIds: [],
      }, audit(actor.id, actor.authorityEpoch, "pg.membership.policy_reassigned"));
      const beforeDeletion = new Map(
        (await repository.listApiTokens(owner.id)).map((token) => [token.id, token]),
      );
      await repository.deleteAccessGroup(
        group.id,
        group.version,
        [],
        audit(actor.id, actor.authorityEpoch, "pg.membership.group_deleted"),
      );
      for (const tokenId of [original.id, rotation.replacement.id]) {
        const before = beforeDeletion.get(tokenId)!;
        const after = (await repository.listApiTokens(owner.id)).find((token) =>
          token.id === tokenId
        )!;
        assertEquals(after.accessMode, "restricted");
        assertEquals(after.version, before.version + 1);
      }
      const staleDeletionCas = await assertRejects(
        () =>
          repository.setTokenAccessGroups(
            owner.id,
            rotation.replacement.id,
            [],
            beforeDeletion.get(rotation.replacement.id)!.version,
            audit(
              actor.id,
              actor.authorityEpoch,
              "pg.membership.stale_groups_after_delete",
              "api_token",
            ),
          ),
        DomainError,
      );
      assertEquals(staleDeletionCas.code, "version_conflict");
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres committed membership removal wins over a queued stale token-policy CAS",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 5 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    let releaseUser: (() => void) | undefined;
    let userBlocker: Promise<unknown> | undefined;
    let removal: ReturnType<PostgresRepository["replaceAccessGroupUsers"]> | undefined;
    let stalePolicy: ReturnType<PostgresRepository["setTokenAccessMode"]> | undefined;
    try {
      await reset(sql);
      const actor = await repository.createUser({
        email: "membership-cas-race@example.test",
        name: "Membership CAS race admin",
        role: "admin",
        approvalStatus: "approved",
      });
      const token = await repository.createApiToken(actor.id, {
        name: "membership CAS race",
        scopes: ["models:read"],
        tokenHash: "membership-cas-race-token",
        preview: "dg_mcr",
      }, actor.authorityEpoch);
      const created = await repository.createAccessGroup(
        { name: "Membership CAS race" },
        audit(actor.id, actor.authorityEpoch, "pg.race.group_created"),
      );
      const group = await repository.replaceAccessGroupPolicy(created.id, {
        expectedVersion: created.version,
        userIds: [actor.id],
        modelIds: [],
        tokenIds: [token.id],
        acknowledgePublicModelIds: [],
      }, audit(actor.id, actor.authorityEpoch, "pg.race.policy_assigned"));
      const staleVersion = (await repository.listApiTokens(actor.id)).find((candidate) =>
        candidate.id === token.id
      )!.version;

      const locked = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      releaseUser = release.resolve;
      userBlocker = sql.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${actor.id} FOR UPDATE`;
        locked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
        await release.promise;
      });
      const blockerPid = await locked.promise;

      removal = repository.replaceAccessGroupUsers(
        group.id,
        [],
        group.version,
        audit(actor.id, actor.authorityEpoch, "pg.race.users_removed"),
      );
      const removalPid = await waitForBlockedQuery(
        sql,
        blockerPid,
        "%FROM users%FOR UPDATE%",
      );
      stalePolicy = repository.setTokenAccessMode(
        actor.id,
        token.id,
        "inherit",
        staleVersion,
        audit(actor.id, actor.authorityEpoch, "pg.race.stale_token_mode", "api_token"),
      );
      await waitForBlockedQuery(sql, removalPid, "%FROM users%FOR UPDATE%");

      releaseUser();
      releaseUser = undefined;
      await userBlocker;
      userBlocker = undefined;
      const [removalResult, policyResult] = await Promise.allSettled([removal, stalePolicy]);
      assertEquals(removalResult.status, "fulfilled");
      assertEquals(policyResult.status, "rejected");
      if (policyResult.status === "rejected") {
        assertEquals((policyResult.reason as DomainError).code, "version_conflict");
      }
      const after = (await repository.listApiTokens(actor.id)).find((candidate) =>
        candidate.id === token.id
      )!;
      assertEquals(after.accessMode, "restricted");
      assertEquals(after.version, staleVersion + 1);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM access_group_tokens
            WHERE group_id=${group.id} AND token_id=${token.id}`)[0].count,
        ),
        0,
      );
    } finally {
      releaseUser?.();
      await Promise.allSettled(
        [userBlocker, removal, stalePolicy].filter(
          (value): value is Promise<unknown> => value !== undefined,
        ),
      );
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres access-group and token-policy audits derive their mutation targets",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 3 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await reset(sql);
      const actor = await repository.createUser({
        email: "audit-target-pg@example.test",
        name: "Audit target PostgreSQL admin",
        role: "admin",
        approvalStatus: "approved",
      });
      const token = await repository.createApiToken(actor.id, {
        name: "audit target token",
        scopes: [],
        tokenHash: "audit-target-pg-token",
        preview: "dg_atp",
      }, actor.authorityEpoch);
      const actions: Array<[string, string]> = [];
      const created = await repository.createAccessGroup(
        { name: "Authoritative PostgreSQL audit target" },
        audit(actor.id, actor.authorityEpoch, "pg.audit.group_created"),
      );
      actions.push(["pg.audit.group_created", created.id]);
      let group = await repository.updateAccessGroup(
        created.id,
        { expectedVersion: created.version, description: "updated" },
        audit(actor.id, actor.authorityEpoch, "pg.audit.group_updated"),
      );
      actions.push(["pg.audit.group_updated", group.id]);
      group = await repository.replaceAccessGroupUsers(
        group.id,
        [actor.id],
        group.version,
        audit(actor.id, actor.authorityEpoch, "pg.audit.users_replaced"),
      );
      actions.push(["pg.audit.users_replaced", group.id]);
      group = await repository.replaceAccessGroupModels(
        group.id,
        [],
        group.version,
        [],
        audit(actor.id, actor.authorityEpoch, "pg.audit.models_replaced"),
      );
      actions.push(["pg.audit.models_replaced", group.id]);
      group = await repository.replaceAccessGroupPolicy(group.id, {
        expectedVersion: group.version,
        userIds: [actor.id],
        modelIds: [],
        tokenIds: [token.id],
        acknowledgePublicModelIds: [],
      }, audit(actor.id, actor.authorityEpoch, "pg.audit.policy_replaced"));
      actions.push(["pg.audit.policy_replaced", group.id]);
      let current = (await repository.listApiTokens(actor.id)).find((candidate) =>
        candidate.id === token.id
      )!;
      current = await repository.setTokenAccessGroups(
        actor.id,
        token.id,
        [group.id],
        current.version,
        audit(actor.id, actor.authorityEpoch, "pg.audit.token_groups", "api_token"),
      );
      actions.push(["pg.audit.token_groups", token.id]);
      await repository.setTokenAccessMode(
        actor.id,
        token.id,
        "restricted",
        current.version,
        audit(actor.id, actor.authorityEpoch, "pg.audit.token_mode", "api_token"),
      );
      actions.push(["pg.audit.token_mode", token.id]);
      await repository.deleteAccessGroup(
        group.id,
        group.version,
        [],
        audit(actor.id, actor.authorityEpoch, "pg.audit.group_deleted"),
      );
      actions.push(["pg.audit.group_deleted", group.id]);

      for (const [action, expectedTargetId] of actions) {
        const rows = await sql<{ target_id: string }[]>`
          SELECT target_id FROM audit_events WHERE action=${action}
        `;
        assertEquals(rows.length, 1);
        assertEquals(String(rows[0].target_id), expectedTargetId);
      }
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
            WHERE target_id::text=${SPOOFED_TARGET}`)[0].count,
        ),
        0,
      );
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
