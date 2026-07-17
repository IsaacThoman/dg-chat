import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

type Outcome =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: unknown };

function outcome(operation: Promise<unknown>): Promise<Outcome> {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

function assertAccountUnavailable(result: Outcome) {
  assertEquals(result.status, "rejected");
  const reason = result.status === "rejected" ? result.reason : undefined;
  assertEquals(reason instanceof DomainError && reason.code, "account_unavailable");
}

Deno.test({
  name: "Postgres credential issuance is serialized with lifecycle authority loss",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const transitionSql = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const releaseTransition = Promise.withResolvers<void>();
    try {
      const currentEpoch = async () =>
        Number(
          (await sql<{ authority_epoch: string }[]>`
          SELECT authority_epoch FROM users WHERE id=${targetId}`)[0].authority_epoch,
        );
      const waitForCredentialIssuanceWaiters = async (minimum: number) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const rows = await sql<{ count: number }[]>`
            SELECT count(*)::int count FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND wait_event_type='Lock'
              AND query ILIKE '%password_reset_pending%FROM users%FOR UPDATE%'
          `;
          if (Number(rows[0].count) >= minimum) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Expected at least ${minimum} credential issuance user-lock waiters`);
      };
      await runAuditTestMaintenanceSql(
        sql,
        `TRUNCATE audit_events,ledger_entries,identity_tokens,api_tokens,
          auth_verifications,auth_sessions,auth_accounts,auth_users,sessions,users
          RESTART IDENTITY CASCADE`,
      );
      const actorId = crypto.randomUUID();
      const targetId = crypto.randomUUID();
      await sql`INSERT INTO users(
        id,email,name,role,approval_status,state,email_verified_at
      ) VALUES
        (${actorId},'credential-race-admin@example.com','Credential race admin','admin',
          'approved','active',now()),
        (${targetId},'credential-race-target@example.com','Credential race target','user',
          'approved','active',now())`;
      const rotationSeed = await repository.createApiToken(targetId, {
        name: "Rotation race seed",
        scopes: ["chat:write"],
        tokenHash: "credential-race-rotation-seed",
        preview: "rotation-seed",
      });

      const rowLocked = Promise.withResolvers<void>();
      const transition = transitionSql.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${targetId} FOR UPDATE`;
        rowLocked.resolve();
        await releaseTransition.promise;
        await tx`UPDATE users SET state='suspended',version=version+1,
          authority_epoch=authority_epoch+1 WHERE id=${targetId}`;
        await tx`UPDATE sessions SET invalidated_at=now()
          WHERE user_id=${targetId} AND limited=false AND invalidated_at IS NULL`;
        await tx`UPDATE api_tokens SET revoked_at=now(),version=version+1
          WHERE user_id=${targetId} AND revoked_at IS NULL`;
      });
      await rowLocked.promise;

      // All operations have passed any route-level authorization by this point. Their durable
      // issuance must wait for the same user-row lock held by the lifecycle transition.
      const tokenAttempt = outcome(repository.createApiToken(targetId, {
        name: "Raced token",
        scopes: ["chat:write"],
        tokenHash: "credential-race-token",
        preview: "race…token",
      }));
      const sessionAttempt = outcome(
        repository.createSession(targetId, "credential-race-session", false),
      );
      const rotationAttempt = outcome(repository.rotateApiToken(targetId, rotationSeed.id, {
        expectedVersion: rotationSeed.version,
        overlapSeconds: 30,
        tokenHash: "credential-race-rotated",
        preview: "race-rotated",
      }));
      await waitForCredentialIssuanceWaiters(3);

      releaseTransition.resolve();
      await transition;
      assertAccountUnavailable(await tokenAttempt);
      assertAccountUnavailable(await sessionAttempt);
      assertAccountUnavailable(await rotationAttempt);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM api_tokens
            WHERE user_id=${targetId} AND token_hash IN (
              'credential-race-token','credential-race-rotated'
            )`)[0].count,
        ),
        0,
      );
      assertEquals(
        Number((await sql`SELECT count(*) count FROM sessions WHERE user_id=${targetId}`)[0].count),
        0,
      );

      // Restoring the account must not resurrect a credential that was attempted after authority
      // loss began. Fresh, post-restore credentials remain compatible.
      await sql`UPDATE users SET state='active',version=version+1 WHERE id=${targetId}`;
      assertEquals(
        await repository.authenticateApiToken("credential-race-rotation-seed"),
        undefined,
      );
      assertAccountUnavailable(
        await outcome(repository.createApiToken(targetId, {
          name: "Stale admitted request",
          scopes: ["chat:write"],
          tokenHash: "credential-stale-after-restore",
          preview: "stale",
        }, 1)),
      );
      const restoredToken = await repository.createApiToken(targetId, {
        name: "Post-restore token",
        scopes: ["chat:write"],
        tokenHash: "credential-post-restore-token",
        preview: "post…token",
      }, await currentEpoch());
      const restoredSession = await repository.createSession(
        targetId,
        "credential-post-restore-session",
        false,
        await currentEpoch(),
      );
      assertEquals(restoredToken.revokedAt, null);
      assertEquals(restoredSession.invalidatedAt, null);

      // The opposite serialization order is safe too: credentials committed before suspension
      // are included in the lifecycle transaction's revocation set and stay dead after restore.
      const beforeSuspend = await repository.getAdminUser(targetId);
      await repository.setAdminUserState({
        actorId,
        targetUserId: targetId,
        expectedVersion: beforeSuspend.version,
        state: "suspended",
        reason: "Exercise credential issuance serialization",
      });
      assertEquals(
        await repository.authenticateApiToken("credential-post-restore-token"),
        undefined,
      );
      assertEquals(await repository.getSession("credential-post-restore-session"), undefined);
      const suspended = await repository.getAdminUser(targetId);
      await repository.setAdminUserState({
        actorId,
        targetUserId: targetId,
        expectedVersion: suspended.version,
        state: "active",
        reason: "Restore after credential issuance serialization test",
      });
      assertEquals(
        await repository.authenticateApiToken("credential-post-restore-token"),
        undefined,
      );
      assertEquals(await repository.getSession("credential-post-restore-session"), undefined);

      const raceRotationAgainstAuthorityLoss = async (
        loss: "rejected" | "deleted",
        suffix: string,
      ) => {
        const seedHash = `credential-${suffix}-rotation-seed`;
        const replacementHash = `credential-${suffix}-rotated`;
        const seed = await repository.createApiToken(targetId, {
          name: `${loss} rotation seed`,
          scopes: ["chat:write"],
          tokenHash: seedHash,
          preview: `${suffix}-seed`,
        }, await currentEpoch());
        const release = Promise.withResolvers<void>();
        const locked = Promise.withResolvers<void>();
        const lifecycle = transitionSql.begin(async (tx) => {
          await tx`SELECT id FROM users WHERE id=${targetId} FOR UPDATE`;
          locked.resolve();
          await release.promise;
          if (loss === "rejected") {
            await tx`UPDATE users SET approval_status='rejected',version=version+1,
              authority_epoch=authority_epoch+1
              WHERE id=${targetId}`;
          } else {
            await tx`UPDATE users SET deleted_at=now(),version=version+1,
              authority_epoch=authority_epoch+1 WHERE id=${targetId}`;
          }
          await tx`UPDATE api_tokens SET revoked_at=now(),version=version+1
            WHERE user_id=${targetId} AND revoked_at IS NULL`;
        });
        await locked.promise;
        const rotation = outcome(repository.rotateApiToken(targetId, seed.id, {
          expectedVersion: seed.version,
          overlapSeconds: 30,
          tokenHash: replacementHash,
          preview: `${suffix}-rotated`,
        }, seed.authorityEpoch));
        try {
          await waitForCredentialIssuanceWaiters(1);
          release.resolve();
          await lifecycle;
          assertAccountUnavailable(await rotation);
          assertEquals(
            Number(
              (await sql`SELECT count(*) count FROM api_tokens
                WHERE user_id=${targetId} AND token_hash=${replacementHash}`)[0].count,
            ),
            0,
          );
          if (loss === "rejected") {
            await sql`UPDATE users SET approval_status='approved',version=version+1
              WHERE id=${targetId}`;
          } else {
            await sql`UPDATE users SET deleted_at=NULL,version=version+1 WHERE id=${targetId}`;
          }
          assertEquals(await repository.authenticateApiToken(seedHash), undefined);
        } finally {
          release.resolve();
          await Promise.allSettled([lifecycle]);
        }
      };

      await raceRotationAgainstAuthorityLoss("rejected", "rejection");
      await raceRotationAgainstAuthorityLoss("deleted", "deletion");

      const beforeResetRejection = await repository.getAdminUser(targetId);
      const resetRejected = await repository.decideUserApproval({
        actorId,
        targetUserId: targetId,
        expectedVersion: beforeResetRejection.version,
        status: "rejected",
        startingCreditMicros: 0,
        reason: "Exercise rejected password-reset issuance",
      });
      const rejectedEpoch = await currentEpoch();
      assertAccountUnavailable(
        await outcome(repository.createIdentityToken(
          targetId,
          "password_reset",
          "credential-rejected-password-reset",
          new Date(Date.now() + 60_000).toISOString(),
          rejectedEpoch,
        )),
      );
      await repository.createIdentityToken(
        targetId,
        "email_verification",
        "credential-rejected-email-verification",
        new Date(Date.now() + 60_000).toISOString(),
        rejectedEpoch,
      );
      await repository.decideUserApproval({
        actorId,
        targetUserId: targetId,
        expectedVersion: resetRejected.version,
        status: "approved",
        startingCreditMicros: 0,
      });

      const finalFresh = await repository.createApiToken(targetId, {
        name: "Fresh token after lifecycle restoration",
        scopes: ["chat:write"],
        tokenHash: "credential-final-fresh",
        preview: "final-fresh",
      }, await currentEpoch());
      const finalRotation = await repository.rotateApiToken(targetId, finalFresh.id, {
        expectedVersion: finalFresh.version,
        overlapSeconds: 0,
        tokenHash: "credential-final-rotated",
        preview: "final-rotated",
      }, finalFresh.authorityEpoch);
      assertEquals(finalRotation.replacement.revokedAt, null);
      await sql`UPDATE api_tokens SET last_used_at=NULL WHERE id=${finalRotation.replacement.id}`;
      const identityEpoch = await currentEpoch();
      await repository.createIdentityToken(
        targetId,
        "email_verification",
        "credential-cross-epoch-identity",
        new Date(Date.now() + 60_000).toISOString(),
        identityEpoch,
      );
      await sql`UPDATE users SET authority_epoch=authority_epoch+1 WHERE id=${targetId}`;
      const crossEpochIdentity = await outcome(repository.createIdentityToken(
        targetId,
        "email_verification",
        "credential-cross-epoch-identity",
        new Date(Date.now() + 60_000).toISOString(),
        identityEpoch + 1,
      ));
      assertEquals(crossEpochIdentity.status, "rejected");
      assertEquals(
        crossEpochIdentity.status === "rejected" &&
          crossEpochIdentity.reason instanceof DomainError && crossEpochIdentity.reason.code,
        "identity_token_conflict",
      );
      assertEquals(await repository.authenticateApiToken("credential-final-rotated"), undefined);
      assertEquals(
        (await sql<{ last_used_at: Date | null }[]>`
          SELECT last_used_at FROM api_tokens WHERE id=${finalRotation.replacement.id}`)[0]
          .last_used_at,
        null,
      );
    } finally {
      releaseTransition.resolve();
      await repository.close();
      await Promise.allSettled([sql.end({ timeout: 5 }), transitionSql.end({ timeout: 5 })]);
    }
  },
});
