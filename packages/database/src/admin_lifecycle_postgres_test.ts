import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function domainError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await assertRejects(operation, DomainError);
  assertEquals(error.code, code);
}

Deno.test({
  name: "Postgres admin lifecycle is paginated, versioned, audited, and credential-safe",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    await sql`TRUNCATE audit_events,ledger_entries,identity_tokens,api_tokens,auth_verifications,
      auth_sessions,auth_accounts,auth_users,sessions,users RESTART IDENTITY CASCADE`;
    const actorId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await sql`INSERT INTO users(id,email,name,role,approval_status,state,email_verified_at)
      VALUES
        (${actorId},'actor@example.com','Actor','admin','approved','active',now()),
        (${targetId},'target@example.com','Target','user','pending','active',now()),
        (${secondId},'second@example.com','Second','user','pending','active',NULL)`;
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const firstPage = await repo.listAdminUsers({ search: "example.com", limit: 2 });
      assertEquals(firstPage.data.length, 2);
      assertExists(firstPage.nextCursor);
      const secondPage = await repo.listAdminUsers({
        search: "example.com",
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      assertEquals(secondPage.data.length, 1);
      assertEquals(
        new Set([...firstPage.data, ...secondPage.data].map((user) => user.id)).size,
        3,
      );
      await domainError(
        () => repo.listAdminUsers({ search: "different", cursor: firstPage.nextCursor! }),
        "validation_error",
      );

      const approved = await repo.decideUserApproval({
        actorId,
        targetUserId: targetId,
        expectedVersion: 1,
        status: "approved",
        startingCreditMicros: 500,
        reason: "Approved by test",
      });
      assertEquals(approved.approvalStatus, "approved");
      assertEquals(approved.balanceMicros, 500);
      assertEquals(approved.version, 2);
      await domainError(
        () =>
          repo.setAdminUserRole({
            actorId,
            targetUserId: targetId,
            expectedVersion: 1,
            role: "admin",
            reason: "Exercise stale-version rejection",
          }),
        "version_conflict",
      );
      const promoted = await repo.setAdminUserRole({
        actorId,
        targetUserId: targetId,
        expectedVersion: 2,
        role: "admin",
        reason: "Promote lifecycle administrator",
      });
      assertEquals(promoted.effectiveAdmin, true);
      assertEquals(promoted.version, 3);

      await sql`INSERT INTO sessions(user_id,token_hash,limited,expires_at) VALUES
        (${targetId},'full-session',false,now()+interval '1 day'),
        (${targetId},'limited-session',true,now()+interval '1 day')`;
      await sql`INSERT INTO auth_users(id,name,email,email_verified)
        VALUES(${targetId},'Target','target@example.com',true)`;
      await sql`INSERT INTO auth_sessions(id,expires_at,token,updated_at,user_id,limited) VALUES
        (${crypto.randomUUID()},now()+interval '1 day','auth-full',now(),${targetId},false),
        (${crypto.randomUUID()},now()+interval '1 day','auth-limited',now(),${targetId},true)`;
      const tokenId = crypto.randomUUID();
      await sql`INSERT INTO api_tokens(id,user_id,name,token_hash,preview,scopes,rotation_family_id)
        VALUES(${tokenId},${targetId},'test','token-hash','dg_test','["chat"]',${tokenId})`;
      await sql`INSERT INTO identity_tokens(user_id,purpose,token_hash,expires_at)
        VALUES(${targetId},'password_reset','pending-reset',now()+interval '1 hour')`;
      await sql`INSERT INTO auth_verifications(id,identifier,value,expires_at)
        VALUES(${crypto.randomUUID()},'reset-password:pending-better-auth',${targetId},
          now()+interval '1 hour')`;
      const suspended = await repo.setAdminUserState({
        actorId,
        targetUserId: targetId,
        expectedVersion: 3,
        state: "suspended",
        reason: "Credential invalidation",
      });
      assertEquals(suspended.state, "suspended");
      assertEquals(suspended.deletedAt, null);
      assertEquals(
        await sql`SELECT id FROM sessions WHERE token_hash='full-session'
        AND invalidated_at IS NULL`.then((rows) => rows.length),
        0,
      );
      assertEquals(
        await sql`SELECT id FROM sessions WHERE token_hash='limited-session'
        AND invalidated_at IS NULL`.then((rows) => rows.length),
        1,
      );
      assertEquals(
        await sql`SELECT token FROM auth_sessions ORDER BY token`.then((rows) =>
          rows.map((row) => row.token)
        ),
        ["auth-limited"],
      );
      assertEquals(
        await sql`SELECT id FROM api_tokens WHERE revoked_at IS NULL`.then((rows) => rows.length),
        0,
      );
      assertEquals(
        await sql`SELECT version FROM api_tokens WHERE id=${tokenId}`.then((rows) =>
          Number(rows[0].version)
        ),
        2,
      );
      assertEquals(
        await sql`SELECT id FROM identity_tokens WHERE user_id=${targetId}
          AND consumed_at IS NULL`.then((rows) => rows.length),
        0,
      );
      assertEquals(
        await sql`SELECT id FROM auth_verifications WHERE value=${targetId}`.then((rows) =>
          rows.length
        ),
        0,
      );

      const deleted = await repo.setAdminUserDeleted({
        actorId,
        targetUserId: targetId,
        expectedVersion: 4,
        deleted: true,
        reason: "Exercise account deletion",
      });
      assertExists(deleted.deletedAt);
      assertEquals(deleted.state, "suspended");
      const restored = await repo.setAdminUserDeleted({
        actorId,
        targetUserId: targetId,
        expectedVersion: 5,
        deleted: false,
        reason: "Exercise account restoration",
      });
      assertEquals(restored.deletedAt, null);
      assertEquals(restored.state, "suspended");

      const beforeAuditFailure = await repo.getAdminUser(secondId);
      await domainError(
        () =>
          repo.decideUserApproval({
            actorId: crypto.randomUUID(),
            targetUserId: secondId,
            expectedVersion: beforeAuditFailure.version,
            status: "approved",
            startingCreditMicros: 700,
          }),
        "admin_authority_required",
      );
      const afterAuditFailure = await repo.getAdminUser(secondId);
      assertEquals(afterAuditFailure, beforeAuditFailure);
      assertEquals(
        await sql`SELECT id FROM ledger_entries
        WHERE usage_run_id=${`approval:${secondId}`}`.then((rows) => rows.length),
        0,
      );

      const audits = await repo.listAudit({ targetId, limit: 20 });
      assertEquals(audits.data.map((event) => event.action), [
        "user.restored",
        "user.deleted",
        "user.state.suspended",
        "user.role.admin",
        "user.approval.approved",
      ]);

      await sql`UPDATE users SET role='user' WHERE id=${actorId}`;
      await domainError(
        () =>
          repo.decideUserApproval({
            actorId,
            targetUserId: secondId,
            expectedVersion: beforeAuditFailure.version,
            status: "approved",
            startingCreditMicros: 700,
          }),
        "admin_authority_required",
      );
      assertEquals((await repo.getAdminUser(secondId)).approvalStatus, "pending");
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres admin lifecycle serializes concurrent final-admin mutations",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE audit_events,ledger_entries,identity_tokens,api_tokens,auth_verifications,
      auth_sessions,auth_accounts,auth_users,sessions,users RESTART IDENTITY CASCADE`;
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await sql`INSERT INTO users(id,email,name,role,approval_status,state,email_verified_at)
      VALUES
        (${firstId},'first-admin@example.com','First','admin','approved','active',now()),
        (${secondId},'second-admin@example.com','Second','admin','approved','active',now())`;
    const first = await PostgresRepository.connect(databaseUrl!);
    const second = await PostgresRepository.connect(databaseUrl!);
    try {
      const outcomes = await Promise.allSettled([
        first.setAdminUserDeleted({
          actorId: firstId,
          targetUserId: secondId,
          expectedVersion: 1,
          deleted: true,
          reason: "Concurrent final-admin coverage",
        }),
        second.setAdminUserRole({
          actorId: secondId,
          targetUserId: firstId,
          expectedVersion: 1,
          role: "user",
          reason: "Concurrent final-admin coverage",
        }),
      ]);
      assertEquals(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const rejection = outcomes.find((outcome) => outcome.status === "rejected");
      assertExists(rejection);
      assertEquals(
        (rejection as PromiseRejectedResult).reason.code,
        "admin_authority_required",
      );
      assertEquals(
        (await first.listAdminUsers({ deletion: "all" })).data.filter((user) => user.effectiveAdmin)
          .length,
        1,
      );
      assertEquals((await first.listAudit({ limit: 10 })).data.length, 1);
    } finally {
      await first.close();
      await second.close();
      await sql.end();
    }
  },
});
