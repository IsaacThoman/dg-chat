import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function assertDomainCode(operation: () => Promise<unknown>, code: string) {
  const error = await assertRejects(operation, DomainError);
  assertEquals(error.code, code);
}

Deno.test({
  name: "Postgres repository enforces lifecycle reasons at the domain boundary",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE audit_events,ledger_entries,identity_tokens,api_tokens,auth_verifications,
        auth_sessions,auth_accounts,auth_users,sessions,users RESTART IDENTITY CASCADE`,
    );
    const actorId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await sql`INSERT INTO users(id,email,name,role,approval_status,state,email_verified_at)
      VALUES
        (${actorId},'reason-admin@example.com','Reason Admin','admin','approved','active',now()),
        (${targetId},'reason-target@example.com','Reason Target','user','pending','active',now())`;
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await assertDomainCode(() =>
        repository.decideUserApproval({
          actorId,
          targetUserId: targetId,
          expectedVersion: 1,
          status: "rejected",
          startingCreditMicros: 0,
        }), "validation_error");
      await assertDomainCode(() =>
        repository.setAdminUserState({
          actorId,
          targetUserId: targetId,
          expectedVersion: 1,
          state: "suspended",
        }), "validation_error");
      await assertDomainCode(() =>
        repository.setAdminUserRole({
          actorId,
          targetUserId: targetId,
          expectedVersion: 1,
          role: "admin",
          reason: "   ",
        }), "validation_error");
      await assertDomainCode(() =>
        repository.setAdminUserDeleted({
          actorId,
          targetUserId: targetId,
          expectedVersion: 1,
          deleted: true,
          reason: "   ",
        }), "validation_error");

      const approved = await repository.decideUserApproval({
        actorId,
        targetUserId: targetId,
        expectedVersion: 1,
        status: "approved",
        startingCreditMicros: 0,
      });
      const suspended = await repository.setAdminUserState({
        actorId,
        targetUserId: targetId,
        expectedVersion: approved.version,
        state: "suspended",
        reason: "Reason supplied for authority loss",
      });
      const activated = await repository.setAdminUserState({
        actorId,
        targetUserId: targetId,
        expectedVersion: suspended.version,
        state: "active",
      });
      assertEquals(activated.state, "active");
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
