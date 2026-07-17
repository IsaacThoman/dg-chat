import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

async function code(operation: () => Promise<unknown>, expected: string) {
  const error = await assertRejects(operation, DomainError);
  assertEquals(error.code, expected);
}
function forgedCursor(resource: string, targetUserId: string, createdAt: string, id: string) {
  return btoa(JSON.stringify([1, resource, targetUserId, createdAt, id, '{"status":null}']));
}

Deno.test({
  name: "Postgres admin security and billing commands are atomic, target-bound, and replay safe",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 3 });
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE admin_balance_adjustments,audit_events,ledger_entries,identity_tokens,
        access_group_tokens,access_group_users,access_group_models,access_groups,api_tokens,
        auth_verifications,auth_sessions,auth_accounts,auth_users,sessions,users
        RESTART IDENTITY CASCADE`,
    );
    const actorId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await sql`INSERT INTO users(id,email,name,role,approval_status,state,email_verified_at)
      VALUES(${actorId},'security-actor@example.com','Actor','admin','approved','active',now()),
        (${targetId},'security-target@example.com','Target','user','approved','active',now())`;
    await sql`INSERT INTO auth_users(id,name,email,email_verified)
      VALUES(${actorId},'Actor','security-actor@example.com',true),
        (${targetId},'Target','security-target@example.com',true)`;
    const actorAuthSessionId = crypto.randomUUID();
    const targetAuthSessionId = crypto.randomUUID();
    const targetLegacySessionId = crypto.randomUUID();
    await sql`INSERT INTO auth_sessions(id,expires_at,token,updated_at,user_id,limited,ip_address,user_agent)
      VALUES(${actorAuthSessionId},now()+interval '1 day','actor-auth',now(),${actorId},false,
        '127.0.0.1','test actor'),
        (${targetAuthSessionId},now()+interval '1 day','target-auth',now(),${targetId},false,
        '192.0.2.1','test target')`;
    await sql`INSERT INTO sessions(id,user_id,token_hash,limited,expires_at)
      VALUES(${targetLegacySessionId},${targetId},'legacy-secret',true,now()+interval '1 day')`;
    const tokenId = crypto.randomUUID();
    const secondTokenId = crypto.randomUUID();
    await sql`INSERT INTO api_tokens(
      id,user_id,name,token_hash,preview,scopes,rotation_family_id,created_at)
      VALUES(${tokenId},${targetId},'Target token','api-secret','dg_test','["chat:write"]',
        ${tokenId},now()-interval '1 second'),
        (${secondTokenId},${targetId},'Second token','api-secret-two','dg_two','["models:read"]',
        ${secondTokenId},now())`;

    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      const sessions = await repository.listAdminUserSessions(
        actorId,
        targetId,
        { status: "active", limit: 1 },
        { source: "better_auth", id: actorAuthSessionId },
      );
      assertEquals(sessions.data.length, 1);
      assertEquals(sessions.data[0].id.includes(":"), true);
      assertEquals("token" in sessions.data[0], false);
      assertExists(sessions.nextCursor);
      const secondSessionPage = await repository.listAdminUserSessions(
        actorId,
        targetId,
        { status: "active", limit: 1, cursor: sessions.nextCursor! },
        { source: "better_auth", id: actorAuthSessionId },
      );
      assertEquals(secondSessionPage.data.length, 1);
      assertEquals(secondSessionPage.data[0].id === sessions.data[0].id, false);
      await code(
        () =>
          repository.listAdminUserSessions(actorId, targetId, {
            status: "expired",
            cursor: sessions.nextCursor!,
          }),
        "validation_error",
      );

      const precisionTargetId = crypto.randomUUID();
      await sql`INSERT INTO users(id,email,name,role,approval_status,state,email_verified_at)
        VALUES(${precisionTargetId},'precision-target@example.com','Precision target','user',
          'approved','active',now())`;
      await sql`INSERT INTO auth_users(id,name,email,email_verified)
        VALUES(${precisionTargetId},'Precision target','precision-target@example.com',true)`;
      const precisionSessionIds = Array.from({ length: 4 }, () => crypto.randomUUID());
      const precisionSessionTimestamps = [
        "2026-07-10T00:00:00.000900Z",
        "2026-07-10T00:00:00.000500Z",
        "2026-07-10T00:00:00.000100Z",
        "2026-07-10T00:00:00.000100Z",
      ];
      await sql`INSERT INTO auth_sessions(
        id,expires_at,token,created_at,updated_at,user_id,limited,ip_address,user_agent)
        VALUES(${precisionSessionIds[0]},now()+interval '1 day','precision-auth-one',
          ${precisionSessionTimestamps[0]}::text::timestamptz,now(),${precisionTargetId},false,
          '192.0.2.10','precision auth one'),
          (${precisionSessionIds[2]},now()+interval '1 day','precision-auth-two',
          ${precisionSessionTimestamps[2]}::text::timestamptz,now(),${precisionTargetId},false,
          '192.0.2.11','precision auth two')`;
      await sql`INSERT INTO sessions(id,user_id,token_hash,limited,expires_at,created_at)
        VALUES(${precisionSessionIds[1]},${precisionTargetId},'precision-legacy-one',false,
          now()+interval '1 day',${precisionSessionTimestamps[1]}::text::timestamptz),
          (${precisionSessionIds[3]},${precisionTargetId},'precision-legacy-two',false,
          now()+interval '1 day',${precisionSessionTimestamps[3]}::text::timestamptz)`;
      const expectedPrecisionSessions = await sql<{ sort_id: string }[]>`
        WITH all_sessions AS (
          SELECT created_at,'legacy:'||id::text sort_id FROM sessions
            WHERE user_id=${precisionTargetId}
          UNION ALL
          SELECT created_at,'better_auth:'||id::text sort_id FROM auth_sessions
            WHERE user_id=${precisionTargetId}
        ) SELECT sort_id FROM all_sessions ORDER BY created_at DESC,sort_id DESC`;
      const seenPrecisionSessions: string[] = [];
      let precisionSessionCursor: string | undefined;
      for (let index = 0; index < expectedPrecisionSessions.length; index++) {
        const page = await repository.listAdminUserSessions(actorId, precisionTargetId, {
          limit: 1,
          cursor: precisionSessionCursor,
        });
        assertEquals(page.data.length, 1);
        seenPrecisionSessions.push(page.data[0].id);
        precisionSessionCursor = page.nextCursor ?? undefined;
      }
      assertEquals(precisionSessionCursor, undefined);
      assertEquals(new Set(seenPrecisionSessions).size, expectedPrecisionSessions.length);
      assertEquals(
        seenPrecisionSessions,
        expectedPrecisionSessions.map((row) => row.sort_id),
      );

      const tokens = await repository.listAdminUserTokens(actorId, targetId, { limit: 1 });
      assertEquals(tokens.data.length, 1);
      assertEquals(tokens.data[0].ownerId, targetId);
      assertEquals("tokenHash" in tokens.data[0], false);
      assertExists(tokens.nextCursor);
      const secondTokenPage = await repository.listAdminUserTokens(actorId, targetId, {
        limit: 1,
        cursor: tokens.nextCursor!,
      });
      assertEquals(secondTokenPage.data.length, 1);
      assertEquals(secondTokenPage.data[0].id === tokens.data[0].id, false);
      await code(() =>
        repository.listAdminUserTokens(actorId, targetId, {
          cursor: forgedCursor("tokens", targetId, "0", tokenId),
        }), "validation_error");
      await code(() =>
        repository.listAdminUserTokens(actorId, targetId, {
          cursor: forgedCursor("tokens", targetId, "2020-02-30T00:00:00Z", tokenId),
        }), "validation_error");
      await code(() =>
        repository.listAdminUserTokens(actorId, targetId, {
          cursor: forgedCursor("tokens", targetId, new Date().toISOString(), "not-a-uuid"),
        }), "validation_error");

      const precisionTokenIds = Array.from({ length: 4 }, () => crypto.randomUUID());
      const precisionTokenTimestamps = [
        "2026-07-10T00:00:00.000900Z",
        "2026-07-10T00:00:00.000500Z",
        "2026-07-10T00:00:00.000100Z",
        "2026-07-10T00:00:00.000100Z",
      ];
      for (let index = 0; index < precisionTokenIds.length; index++) {
        const id = precisionTokenIds[index];
        await sql`INSERT INTO api_tokens(
          id,user_id,name,token_hash,preview,scopes,rotation_family_id,created_at)
          VALUES(${id},${precisionTargetId},${`Precision token ${index}`},
            ${`precision-token-hash-${index}`},${`dg_precision_${index}`},'[]',${id},
            ${precisionTokenTimestamps[index]}::text::timestamptz)`;
      }
      const expectedPrecisionTokens = await sql<{ id: string }[]>`
        SELECT id FROM api_tokens WHERE user_id=${precisionTargetId}
        ORDER BY created_at DESC,id DESC`;
      const seenPrecisionTokens: string[] = [];
      let precisionTokenCursor: string | undefined;
      for (let index = 0; index < expectedPrecisionTokens.length; index++) {
        const page = await repository.listAdminUserTokens(actorId, precisionTargetId, {
          limit: 1,
          cursor: precisionTokenCursor,
        });
        assertEquals(page.data.length, 1);
        seenPrecisionTokens.push(page.data[0].id);
        precisionTokenCursor = page.nextCursor ?? undefined;
      }
      assertEquals(precisionTokenCursor, undefined);
      assertEquals(new Set(seenPrecisionTokens).size, expectedPrecisionTokens.length);
      assertEquals(
        seenPrecisionTokens,
        expectedPrecisionTokens.map((row) => String(row.id)),
      );
      const ledgerBefore = await repository.listAdminUserLedger(actorId, targetId);
      assertEquals(ledgerBefore.data, []);

      await code(() =>
        repository.revokeAdminUserSession({
          actorId,
          targetUserId: actorId,
          source: "better_auth",
          sessionId: actorAuthSessionId,
          currentSession: { source: "better_auth", id: actorAuthSessionId },
          reason: "Current session must survive",
        }), "current_session_protected");
      await code(() =>
        repository.revokeAdminUserSession({
          actorId,
          targetUserId: actorId,
          source: "legacy",
          sessionId: targetLegacySessionId,
          currentSession: { source: "better_auth", id: actorAuthSessionId },
          reason: "Cross-target attempt",
        }), "not_found");
      await repository.revokeAdminUserSession({
        actorId,
        targetUserId: targetId,
        source: "better_auth",
        sessionId: targetAuthSessionId,
        currentSession: { source: "better_auth", id: actorAuthSessionId },
        reason: "Compromised browser",
      });
      assertEquals(
        (await sql`SELECT id FROM auth_sessions WHERE id=${targetAuthSessionId}`).length,
        0,
      );

      const rotating = await repository.createApiToken(targetId, {
        name: "Rotating family",
        scopes: ["chat:write"],
        tokenHash: "rotation-one",
        preview: "one",
      }, 1);
      const rotatedTwice = await repository.rotateApiToken(targetId, rotating.id, {
        expectedVersion: 1,
        tokenHash: "rotation-two",
        preview: "two",
        overlapSeconds: 3600,
      }, 1);
      const staleFirstVersion = rotatedTwice.previous.version;
      const rotatedThrice = await repository.rotateApiToken(
        targetId,
        rotatedTwice.replacement.id,
        {
          expectedVersion: 1,
          tokenHash: "rotation-three",
          preview: "three",
          overlapSeconds: 3600,
        },
        1,
      );
      await code(() =>
        repository.revokeAdminUserTokenFamily({
          actorId,
          targetUserId: targetId,
          tokenId: rotating.id,
          expectedVersion: staleFirstVersion,
          reason: "Stale overlap view",
        }), "version_conflict");
      assertExists(await repository.findApiTokenByHash("rotation-three"));
      assertEquals(rotatedThrice.replacement.version, 1);

      await code(() =>
        repository.revokeAdminUserTokenFamily({
          actorId,
          targetUserId: targetId,
          tokenId,
          expectedVersion: 2,
          reason: "Stale command",
        }), "version_conflict");
      await repository.revokeAdminUserTokenFamily({
        actorId,
        targetUserId: targetId,
        tokenId,
        expectedVersion: 1,
        reason: "Credential leaked",
      });
      assertEquals(
        (await sql`SELECT revoked_at FROM api_tokens WHERE id=${tokenId}`)[0].revoked_at !== null,
        true,
      );

      const command = {
        actorId,
        targetUserId: targetId,
        amountMicros: 900,
        expectedBalanceMicros: 0,
        idempotencyKeyHash: HASH_A,
        requestHash: HASH_B,
        reason: "Support credit",
      };
      const concurrentReplay = await Promise.all([
        repository.adjustAdminUserBalance(command),
        repository.adjustAdminUserBalance(command),
      ]);
      assertEquals(new Set(concurrentReplay.map((value) => value.id)).size, 1);
      assertEquals(concurrentReplay.map((value) => value.replayed).sort(), [false, true]);
      assertEquals(
        Number(
          (await sql`SELECT balance_micros FROM users WHERE id=${targetId}`)[0].balance_micros,
        ),
        900,
      );
      assertEquals(
        Number((await sql`SELECT count(*) count FROM admin_balance_adjustments`)[0].count),
        1,
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM ledger_entries WHERE kind='adjustment'`)[0].count,
        ),
        1,
      );

      await code(
        () => repository.adjustAdminUserBalance({ ...command, requestHash: HASH_C }),
        "idempotency_conflict",
      );
      const races = await Promise.allSettled([
        repository.adjustAdminUserBalance({
          ...command,
          amountMicros: 100,
          expectedBalanceMicros: 900,
          idempotencyKeyHash: HASH_B,
          requestHash: HASH_A,
        }),
        repository.adjustAdminUserBalance({
          ...command,
          amountMicros: 200,
          expectedBalanceMicros: 900,
          idempotencyKeyHash: HASH_C,
          requestHash: "d".repeat(64),
        }),
      ]);
      assertEquals(races.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = races.find((result) =>
        result.status === "rejected"
      ) as PromiseRejectedResult;
      assertEquals(
        rejected.reason instanceof DomainError && rejected.reason.code,
        "balance_conflict",
      );

      const ledger = await repository.listAdminUserLedger(actorId, targetId, {
        kind: "adjustment",
      });
      assertEquals(ledger.data.length, 2);
      assertEquals(ledger.data.every((entry) => entry.adjustment !== null), true);
      assertEquals(ledger.data.every((entry) => !("metadata" in entry)), true);
      const ledgerPage = await repository.listAdminUserLedger(actorId, targetId, {
        kind: "adjustment",
        limit: 1,
      });
      assertExists(ledgerPage.nextCursor);
      const secondLedgerPage = await repository.listAdminUserLedger(actorId, targetId, {
        kind: "adjustment",
        limit: 1,
        cursor: ledgerPage.nextCursor!,
      });
      assertEquals(secondLedgerPage.data.length, 1);
      assertEquals(secondLedgerPage.data[0].id === ledgerPage.data[0].id, false);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
          WHERE action IN ('user.session.revoked','user.api_token_family.revoked',
            'user.balance.adjusted')`)[0].count,
        ),
        4,
      );

      const rollbackBalance = Number(
        (await sql`SELECT balance_micros FROM users WHERE id=${targetId}`)[0].balance_micros,
      );
      const rollbackLedgerCount = Number(
        (await sql`SELECT count(*) count FROM ledger_entries`)[0].count,
      );
      const rollbackAdjustmentCount = Number(
        (await sql`SELECT count(*) count FROM admin_balance_adjustments`)[0].count,
      );
      await sql.unsafe(`CREATE OR REPLACE FUNCTION dg_chat_test_reject_admin_balance_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'injected audit failure';
        END $$`);
      await sql.unsafe(`CREATE TRIGGER dg_chat_test_reject_admin_balance_audit
        BEFORE INSERT ON audit_events FOR EACH ROW
        WHEN (NEW.action='user.balance.adjusted')
        EXECUTE FUNCTION dg_chat_test_reject_admin_balance_audit()`);
      try {
        await assertRejects(
          () =>
            repository.adjustAdminUserBalance({
              ...command,
              amountMicros: 1,
              expectedBalanceMicros: rollbackBalance,
              idempotencyKeyHash: "e".repeat(64),
              requestHash: "f".repeat(64),
              reason: "Exercise transaction rollback",
            }),
          Error,
          "injected audit failure",
        );
      } finally {
        await sql.unsafe(`DROP TRIGGER IF EXISTS dg_chat_test_reject_admin_balance_audit
          ON audit_events`);
        await sql.unsafe(`DROP FUNCTION IF EXISTS dg_chat_test_reject_admin_balance_audit()`);
      }
      assertEquals(
        Number(
          (await sql`SELECT balance_micros FROM users WHERE id=${targetId}`)[0].balance_micros,
        ),
        rollbackBalance,
      );
      assertEquals(
        Number((await sql`SELECT count(*) count FROM ledger_entries`)[0].count),
        rollbackLedgerCount,
      );
      assertEquals(
        Number((await sql`SELECT count(*) count FROM admin_balance_adjustments`)[0].count),
        rollbackAdjustmentCount,
      );
    } finally {
      await repository.close();
      await sql.end({ timeout: 5 });
    }
  },
});
