import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

type Outcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

function outcome<T>(operation: Promise<T>): Promise<Outcome<T>> {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function waitForWaiterBlockedBy(
  sql: postgres.Sql,
  blockerPid: number,
  label: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await sql<{ pid: number }[]>`
      SELECT pid::int pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ${blockerPid}=ANY(pg_blocking_pids(pid))
      ORDER BY pid LIMIT 1
    `;
    if (rows[0]) return Number(rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

Deno.test({
  name: "Better Auth password reset and lifecycle authority loss serialize in both lock orders",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const observer = postgres(databaseUrl!, { max: 1 });
    const blocker = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const releaseAccountLock = Promise.withResolvers<void>();
    const releaseSessionLock = Promise.withResolvers<void>();
    try {
      await runAuditTestMaintenanceSql(
        observer,
        "TRUNCATE auth_verifications,auth_users,users RESTART IDENTITY CASCADE",
      );

      const actorId = crypto.randomUUID();
      const resetWinsId = crypto.randomUUID();
      const lifecycleWinsId = crypto.randomUUID();
      await observer`INSERT INTO users(
        id,email,name,role,approval_status,state,email_verified_at
      ) VALUES
        (${actorId},'reset-race-admin@example.com','Reset race admin','admin','approved','active',now()),
        (${resetWinsId},'reset-wins@example.com','Reset wins','user','approved','active',now()),
        (${lifecycleWinsId},'lifecycle-wins@example.com','Lifecycle wins','user','approved','active',now())`;
      await observer`INSERT INTO auth_users(id,name,email,email_verified) VALUES
        (${resetWinsId},'Reset wins','reset-wins@example.com',true),
        (${lifecycleWinsId},'Lifecycle wins','lifecycle-wins@example.com',true)`;
      const resetWinsAccountId = crypto.randomUUID();
      const lifecycleWinsAccountId = crypto.randomUUID();
      await observer`INSERT INTO auth_accounts(
        id,account_id,provider_id,user_id,password,created_at,updated_at
      ) VALUES
        (${resetWinsAccountId},${resetWinsId},'credential',${resetWinsId},
          'old-reset-wins-hash',now(),now()),
        (${lifecycleWinsAccountId},${lifecycleWinsId},'credential',${lifecycleWinsId},
          'old-lifecycle-wins-hash',now(),now())`;
      await observer`INSERT INTO auth_verifications(identifier,value,expires_at,authority_epoch)
        VALUES
          ('reset-password:reset-wins-token',${resetWinsId},now()+interval '1 hour',1),
          ('reset-password:lifecycle-wins-token',${lifecycleWinsId},now()+interval '1 hour',1)`;

      // Reset wins: hold the credential row so resetBetterAuthPassword has already acquired the
      // user authority lock but cannot yet commit. The lifecycle command must queue behind that
      // exact reset backend, rather than merely appearing unsettled for a period of time.
      let accountBlockerPid = 0;
      const accountLocked = Promise.withResolvers<void>();
      const heldAccount = blocker.begin(async (tx) => {
        accountBlockerPid = Number((await tx`SELECT pg_backend_pid() pid`)[0].pid);
        await tx`SELECT id FROM auth_accounts WHERE id=${resetWinsAccountId} FOR UPDATE`;
        accountLocked.resolve();
        await releaseAccountLock.promise;
      });
      await accountLocked.promise;

      const resetWins = outcome(
        repository.resetBetterAuthPassword("reset-wins-token", "new-reset-wins-hash"),
      );
      const resetPid = await waitForWaiterBlockedBy(
        observer,
        accountBlockerPid,
        "password reset to wait on the credential-row lock",
      );
      const lifecycleAfterReset = repository.setAdminUserState({
        actorId,
        expectedAuthorityEpoch: 1,
        targetUserId: resetWinsId,
        expectedVersion: 1,
        state: "suspended",
        reason: "Prove reset-before-lifecycle serialization",
      });
      await waitForWaiterBlockedBy(
        observer,
        resetPid,
        "lifecycle mutation to wait on the reset user lock",
      );

      releaseAccountLock.resolve();
      await heldAccount;
      const resetWinsResult = await resetWins;
      assertEquals(resetWinsResult.status, "fulfilled");
      if (resetWinsResult.status !== "fulfilled") return;
      assertEquals(resetWinsResult.value.authorityEpoch, 2);
      const resetWinsLifecycle = await lifecycleAfterReset;
      assertEquals(resetWinsLifecycle.state, "suspended");
      assertEquals(
        Number(
          (await observer`SELECT authority_epoch FROM users WHERE id=${resetWinsId}`)[0]
            .authority_epoch,
        ),
        3,
      );
      assertEquals(
        (await observer<{ password: string }[]>`
          SELECT password FROM auth_accounts WHERE id=${resetWinsAccountId}`)[0].password,
        "new-reset-wins-hash",
      );
      assertEquals(
        Number(
          (await observer`SELECT count(*) count FROM auth_verifications
          WHERE value=${resetWinsId} AND identifier LIKE 'reset-password:%'`)[0].count,
        ),
        0,
      );

      // Lifecycle wins: pause suspension after it has changed the user's authority generation
      // but before commit. The reset must queue on that lifecycle backend. Once suspension
      // commits, reset rejects and never writes even one byte of the credential hash.
      const lifecycleSessionId = crypto.randomUUID();
      await observer`INSERT INTO sessions(id,user_id,token_hash,limited,authority_epoch,expires_at)
        VALUES(${lifecycleSessionId},${lifecycleWinsId},'lifecycle-wins-session',false,1,
          now()+interval '1 hour')`;
      let sessionBlockerPid = 0;
      const sessionLocked = Promise.withResolvers<void>();
      const heldSession = blocker.begin(async (tx) => {
        sessionBlockerPid = Number((await tx`SELECT pg_backend_pid() pid`)[0].pid);
        await tx`SELECT id FROM sessions WHERE id=${lifecycleSessionId} FOR UPDATE`;
        sessionLocked.resolve();
        await releaseSessionLock.promise;
      });
      await sessionLocked.promise;

      const lifecycleBeforeReset = repository.setAdminUserState({
        actorId,
        expectedAuthorityEpoch: 1,
        targetUserId: lifecycleWinsId,
        expectedVersion: 1,
        state: "suspended",
        reason: "Prove lifecycle-before-reset serialization",
      });
      const lifecyclePid = await waitForWaiterBlockedBy(
        observer,
        sessionBlockerPid,
        "lifecycle invalidation to wait on the session-row lock",
      );
      const unchangedPasswordHex = (await observer<{ hex: string }[]>`
        SELECT encode(convert_to(password,'UTF8'),'hex') hex
        FROM auth_accounts WHERE id=${lifecycleWinsAccountId}`)[0].hex;
      const lifecycleLosesReset = outcome(
        repository.resetBetterAuthPassword("lifecycle-wins-token", "must-never-be-written"),
      );
      await waitForWaiterBlockedBy(
        observer,
        lifecyclePid,
        "password reset to wait on the lifecycle user lock",
      );

      releaseSessionLock.resolve();
      await heldSession;
      const lifecycleWinsResult = await lifecycleBeforeReset;
      assertEquals(lifecycleWinsResult.state, "suspended");
      assertEquals(
        Number(
          (await observer`SELECT authority_epoch FROM users WHERE id=${lifecycleWinsId}`)[0]
            .authority_epoch,
        ),
        2,
      );
      const rejectedReset = await lifecycleLosesReset;
      assertEquals(rejectedReset.status, "rejected");
      assertEquals(
        rejectedReset.status === "rejected" && rejectedReset.reason instanceof DomainError &&
          rejectedReset.reason.code,
        "invalid_identity_token",
      );
      assertEquals(
        (await observer<{ hex: string }[]>`
          SELECT encode(convert_to(password,'UTF8'),'hex') hex
          FROM auth_accounts WHERE id=${lifecycleWinsAccountId}`)[0].hex,
        unchangedPasswordHex,
      );
      assertEquals(
        Number(
          (await observer`SELECT count(*) count FROM auth_verifications
          WHERE value=${lifecycleWinsId} AND identifier LIKE 'reset-password:%'`)[0].count,
        ),
        0,
      );
    } finally {
      releaseAccountLock.resolve();
      releaseSessionLock.resolve();
      await repository.close();
      await Promise.allSettled([
        observer.end({ timeout: 5 }),
        blocker.end({ timeout: 5 }),
      ]);
    }
  },
});
