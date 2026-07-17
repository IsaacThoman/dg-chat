import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function waitForActorLock(observer: postgres.Sql, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ pid: number }[]>`
      SELECT pid::int pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ${blockerPid}=ANY(pg_blocking_pids(pid))
        AND query ILIKE '%FROM users%FOR UPDATE%'
      LIMIT 1
    `;
    if (rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for lifecycle command to lock its actor");
}

Deno.test({
  name: "Postgres admin lifecycle rechecks the admitted authority epoch under the actor lock",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 3 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const actorLocked = Promise.withResolvers<number>();
    const completeReset = Promise.withResolvers<void>();
    let reset: Promise<unknown> | undefined;
    let mutation: ReturnType<PostgresRepository["setAdminUserState"]> | undefined;
    try {
      await runAuditTestMaintenanceSql(
        sql,
        "TRUNCATE audit_events,api_tokens,sessions,users RESTART IDENTITY CASCADE",
      );
      const actor = await repository.createUser({
        email: "stale-lifecycle-pg-actor@example.test",
        name: "Stale lifecycle PostgreSQL actor",
        role: "admin",
        approvalStatus: "approved",
      });
      const target = await repository.createUser({
        email: "stale-lifecycle-pg-target@example.test",
        name: "Stale lifecycle PostgreSQL target",
        approvalStatus: "approved",
      });
      reset = sql.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${actor.id} FOR UPDATE`;
        actorLocked.resolve(Number((await tx`SELECT pg_backend_pid() pid`)[0].pid));
        await completeReset.promise;
        await tx`UPDATE users SET password_reset_pending=false,
          authority_epoch=authority_epoch+1,updated_at=now() WHERE id=${actor.id}`;
      });
      const blockerPid = await actorLocked.promise;
      mutation = repository.setAdminUserState({
        actorId: actor.id,
        expectedAuthorityEpoch: actor.authorityEpoch,
        targetUserId: target.id,
        expectedVersion: target.version,
        state: "suspended",
        reason: "Must reject a completed-reset epoch",
      });
      try {
        await waitForActorLock(sql, blockerPid);
      } finally {
        completeReset.resolve();
      }
      await reset;
      const error = await assertRejects(() => mutation!, DomainError);
      assertEquals(error.code, "admin_authority_required");
      assertEquals((await repository.getAdminUser(target.id)).state, "active");
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
            WHERE action='user.state.suspended' AND target_id=${target.id}`)[0].count,
        ),
        0,
      );
      const malformed = await assertRejects(
        () =>
          repository.setAdminUserState({
            actorId: actor.id,
            expectedAuthorityEpoch: 0,
            targetUserId: target.id,
            expectedVersion: target.version,
            state: "suspended",
            reason: "Must reject a malformed authority epoch",
          }),
        DomainError,
      );
      assertEquals(malformed.code, "validation_error");
      const omitted = await assertRejects(
        () =>
          repository.setAdminUserState(
            {
              actorId: actor.id,
              targetUserId: target.id,
              expectedVersion: target.version,
              state: "suspended",
              reason: "Must reject an omitted authority epoch",
            } as unknown as Parameters<PostgresRepository["setAdminUserState"]>[0],
          ),
        DomainError,
      );
      assertEquals(omitted.code, "validation_error");
    } finally {
      completeReset.resolve();
      await Promise.allSettled(
        [reset, mutation].filter((value): value is Promise<unknown> => value !== undefined),
      );
      await repository.close();
      await sql.end();
    }
  },
});
