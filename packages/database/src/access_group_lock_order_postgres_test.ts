import { assertEquals } from "jsr:@std/assert@1.0.14";
import type { ApiTokenSummary } from "@dg-chat/contracts";
import postgres from "npm:postgres@3.4.7";
import type { StoredUser } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";
import type { AccessGroup, PrivilegedAuditEventInput } from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const ROTATION_PAUSE_LOCK = 8_104_202_607_170_001;

const audit = (
  actor: StoredUser,
  action: string,
  targetId?: string,
): PrivilegedAuditEventInput => ({
  actorId: actor.id,
  action,
  targetType: "model_access_group",
  targetId,
  metadata: { source: "access-group-lock-order-test" },
  requireEmailVerification: false,
  expectedAuthorityEpoch: actor.authorityEpoch,
});

async function reset(sql: postgres.Sql) {
  await runAuditTestMaintenanceSql(
    sql,
    "TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups," +
      "audit_events,api_tokens,users RESTART IDENTITY CASCADE",
  );
}

async function waitForBlockedQueries(
  observer: postgres.Sql,
  blockerPid: number,
  count: number,
  queryPattern: string,
): Promise<number[]> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ pid: number }[]>`
      SELECT pid::int pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ${blockerPid}=ANY(pg_blocking_pids(pid))
        AND query ILIKE ${queryPattern}
      ORDER BY pid
    `;
    if (rows.length >= count) return rows.map((row) => row.pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${count} blocked PostgreSQL quer${count === 1 ? "y" : "ies"}`,
  );
}

function holdUserRow(sql: postgres.Sql, userId: string) {
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const transaction = sql.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
    locked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
    await release.promise;
  });
  return { locked: locked.promise, release: release.resolve, transaction };
}

function holdAdvisoryLock(sql: postgres.Sql, key: number) {
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const transaction = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${key})`;
    locked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
    await release.promise;
  });
  return { locked: locked.promise, release: release.resolve, transaction };
}

async function createAdmin(
  repository: PostgresRepository,
  email: string,
): Promise<StoredUser> {
  return await repository.createUser({
    email,
    name: email,
    role: "admin",
    approvalStatus: "approved",
  });
}

async function createOwner(
  repository: PostgresRepository,
  email: string,
): Promise<StoredUser> {
  return await repository.createUser({
    email,
    name: email,
    approvalStatus: "approved",
  });
}

async function createAssignedToken(
  repository: PostgresRepository,
  actor: StoredUser,
  owner: StoredUser,
  name: string,
): Promise<{ group: AccessGroup; token: ApiTokenSummary }> {
  const token = await repository.createApiToken(owner.id, {
    name,
    scopes: ["models:read"],
    tokenHash: `${name}-initial-hash`,
    preview: `${name.slice(0, 5)}…old`,
  }, owner.authorityEpoch);
  const created = await repository.createAccessGroup(
    { name },
    audit(actor, "model_access_group.created"),
  );
  const group = await repository.replaceAccessGroupPolicy(
    created.id,
    {
      expectedVersion: created.version,
      name: created.name,
      description: created.description,
      userIds: [owner.id],
      modelIds: [],
      tokenIds: [token.id],
      acknowledgePublicModelIds: [],
    },
    audit(actor, "model_access_group.policy_replaced", created.id),
  );
  const current = (await repository.listApiTokens(owner.id)).find((item) => item.id === token.id);
  if (!current) throw new Error("Assigned token disappeared during test setup");
  return { group, token: current };
}

Deno.test({
  name: "Postgres access-group policy and token rotation share user-before-family lock order",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 4 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    let releaseUser: (() => void) | undefined;
    let userBlocker: Promise<unknown> | undefined;
    let rotation: ReturnType<PostgresRepository["rotateApiToken"]> | undefined;
    let policy: ReturnType<PostgresRepository["replaceAccessGroupPolicy"]> | undefined;
    try {
      await reset(sql);
      const actor = await createAdmin(repository, "policy-lock-admin@example.test");
      const owner = await createOwner(repository, "policy-lock-owner@example.test");
      const assigned = await createAssignedToken(
        repository,
        actor,
        owner,
        "Policy rotation ordering",
      );

      const held = holdUserRow(sql, owner.id);
      releaseUser = held.release;
      userBlocker = held.transaction;
      const blockerPid = await held.locked;

      // Queue rotation first. With the old family-before-user policy order, releasing this row
      // handed the user lock to rotation while policy held the family lock, forming a cycle.
      rotation = repository.rotateApiToken(owner.id, assigned.token.id, {
        expectedVersion: assigned.token.version,
        overlapSeconds: 30,
        tokenHash: "policy-rotation-replacement-hash",
        preview: "dg_pol…new",
      }, owner.authorityEpoch);
      const [rotationPid] = await waitForBlockedQueries(
        sql,
        blockerPid,
        1,
        "%FROM users%FOR UPDATE%",
      );

      policy = repository.replaceAccessGroupPolicy(
        assigned.group.id,
        {
          expectedVersion: assigned.group.version,
          name: assigned.group.name,
          description: assigned.group.description,
          userIds: [owner.id],
          modelIds: [],
          tokenIds: [assigned.token.id],
          acknowledgePublicModelIds: [],
        },
        audit(actor, "model_access_group.policy_replaced", assigned.group.id),
      );
      // PostgreSQL reports a queued waiter as soft-blocked by the waiter ahead of it, rather than
      // by the original row-lock holder. Following that edge also proves policy is waiting at the
      // canonical user-lock query instead of holding the family lock.
      await waitForBlockedQueries(sql, rotationPid, 1, "%FROM users%FOR UPDATE%");

      releaseUser();
      releaseUser = undefined;
      await userBlocker;
      userBlocker = undefined;
      const [rotated, saved] = await Promise.all([rotation, policy]);
      assertEquals(saved.userIds, [owner.id]);
      assertEquals(
        new Set(saved.tokenIds),
        new Set([assigned.token.id, rotated.replacement.id]),
      );
    } finally {
      releaseUser?.();
      await Promise.allSettled(
        [userBlocker, rotation, policy].filter(
          (value): value is Promise<unknown> => value !== undefined,
        ),
      );
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres membership removal waits for rotation before cascading token assignments",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 5 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    let releasePause: (() => void) | undefined;
    let pauseBlocker: Promise<unknown> | undefined;
    let rotation: ReturnType<PostgresRepository["rotateApiToken"]> | undefined;
    let removal: ReturnType<PostgresRepository["replaceAccessGroupUsers"]> | undefined;
    try {
      await reset(sql);
      const actor = await createAdmin(repository, "membership-lock-admin@example.test");
      const owner = await createOwner(repository, "membership-lock-owner@example.test");
      const assigned = await createAssignedToken(
        repository,
        actor,
        owner,
        "Membership rotation ordering",
      );
      await sql.unsafe(`
        CREATE FUNCTION dg_test_pause_group_token_insert()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ROTATION_PAUSE_LOCK});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_pause_group_token_insert
          BEFORE INSERT ON access_group_tokens
          FOR EACH ROW EXECUTE FUNCTION dg_test_pause_group_token_insert();
      `);

      const held = holdAdvisoryLock(sql, ROTATION_PAUSE_LOCK);
      releasePause = held.release;
      pauseBlocker = held.transaction;
      const pausePid = await held.locked;

      rotation = repository.rotateApiToken(owner.id, assigned.token.id, {
        expectedVersion: assigned.token.version,
        overlapSeconds: 30,
        tokenHash: "membership-rotation-replacement-hash",
        preview: "dg_mem…new",
      }, owner.authorityEpoch);
      const [rotationPid] = await waitForBlockedQueries(
        sql,
        pausePid,
        1,
        "%INSERT INTO access_group_tokens%",
      );

      removal = repository.replaceAccessGroupUsers(
        assigned.group.id,
        [],
        assigned.group.version,
        audit(actor, "model_access_group.users_replaced", assigned.group.id),
      );
      await waitForBlockedQueries(sql, rotationPid, 1, "%FROM users%FOR UPDATE%");

      releasePause();
      releasePause = undefined;
      await pauseBlocker;
      pauseBlocker = undefined;
      await rotation;
      const saved = await removal;
      assertEquals(saved.userIds, []);
      assertEquals(saved.tokenIds, []);
    } finally {
      releasePause?.();
      await Promise.allSettled(
        [pauseBlocker, rotation, removal].filter(
          (value): value is Promise<unknown> => value !== undefined,
        ),
      );
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS dg_test_pause_group_token_insert ON access_group_tokens;
        DROP FUNCTION IF EXISTS dg_test_pause_group_token_insert();
      `).catch(() => undefined);
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres cross-admin membership replacements lock every user in canonical order",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 4 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    let releaseUser: (() => void) | undefined;
    let userBlocker: Promise<unknown> | undefined;
    let lowerMutation: ReturnType<PostgresRepository["replaceAccessGroupUsers"]> | undefined;
    let higherMutation: ReturnType<PostgresRepository["replaceAccessGroupUsers"]> | undefined;
    try {
      await reset(sql);
      const first = await createAdmin(repository, "cross-admin-one@example.test");
      const second = await createAdmin(repository, "cross-admin-two@example.test");
      const [lower, higher] = [first, second].sort((left, right) =>
        left.id.localeCompare(right.id)
      );
      const lowerGroup = await repository.createAccessGroup(
        { name: "Lower actor group" },
        audit(lower, "model_access_group.created"),
      );
      const higherGroup = await repository.createAccessGroup(
        { name: "Higher actor group" },
        audit(higher, "model_access_group.created"),
      );

      const held = holdUserRow(sql, lower.id);
      releaseUser = held.release;
      userBlocker = held.transaction;
      const blockerPid = await held.locked;

      // Queue the lower actor first. An actor-first implementation then lets the higher actor
      // retain its own row while waiting behind this request for the lower row, recreating the
      // classic A->B / B->A cycle when the external lock is released.
      lowerMutation = repository.replaceAccessGroupUsers(
        lowerGroup.id,
        [higher.id],
        lowerGroup.version,
        audit(lower, "model_access_group.users_replaced", lowerGroup.id),
      );
      const [lowerMutationPid] = await waitForBlockedQueries(
        sql,
        blockerPid,
        1,
        "%FROM users%FOR UPDATE%",
      );

      higherMutation = repository.replaceAccessGroupUsers(
        higherGroup.id,
        [lower.id],
        higherGroup.version,
        audit(higher, "model_access_group.users_replaced", higherGroup.id),
      );
      await waitForBlockedQueries(
        sql,
        lowerMutationPid,
        1,
        "%FROM users%FOR UPDATE%",
      );

      releaseUser();
      releaseUser = undefined;
      await userBlocker;
      userBlocker = undefined;
      const [lowerSaved, higherSaved] = await Promise.all([lowerMutation, higherMutation]);
      assertEquals(lowerSaved.userIds, [higher.id]);
      assertEquals(higherSaved.userIds, [lower.id]);
    } finally {
      releaseUser?.();
      await Promise.allSettled(
        [userBlocker, lowerMutation, higherMutation].filter(
          (value): value is Promise<unknown> => value !== undefined,
        ),
      );
      await repository.close();
      await sql.end();
    }
  },
});
