import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import {
  runAuditTestMaintenanceSql,
  withAuditTestMaintenance,
} from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function assertDomainCode(operation: () => Promise<unknown>, code: string) {
  const error = await assertRejects(operation, DomainError);
  assertEquals(error.code, code);
}

Deno.test({
  name: "Postgres excludes reset-pending admins from authority and promotion",
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
    const effectiveAdminId = crypto.randomUUID();
    const resetPendingAdminId = crypto.randomUUID();
    const candidateId = crypto.randomUUID();
    await withAuditTestMaintenance(sql, async (tx) => {
      await tx`INSERT INTO users(
          id,email,name,role,approval_status,state,email_verified_at,password_reset_pending
        ) VALUES
          (
            ${effectiveAdminId},'effective-admin@example.com','Effective administrator',
            'admin','approved','active',now(),false
          ),
          (
            ${resetPendingAdminId},'reset-pending-admin@example.com',
            'Reset-pending administrator','admin','approved','active',now(),true
          ),
          (
            ${candidateId},'promotion-candidate@example.com','Promotion candidate',
            'user','approved','active',now(),true
          )`;
    });

    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      const operations = [
        () =>
          repository.decideUserApproval({
            actorId: resetPendingAdminId,
            expectedAuthorityEpoch: 1,
            targetUserId: effectiveAdminId,
            expectedVersion: 1,
            status: "rejected",
            startingCreditMicros: 0,
            reason: "Reject the administrator",
          }),
        () =>
          repository.setAdminUserRole({
            actorId: resetPendingAdminId,
            expectedAuthorityEpoch: 1,
            targetUserId: effectiveAdminId,
            expectedVersion: 1,
            role: "user",
            reason: "Demote the administrator",
          }),
        () =>
          repository.setAdminUserState({
            actorId: resetPendingAdminId,
            expectedAuthorityEpoch: 1,
            targetUserId: effectiveAdminId,
            expectedVersion: 1,
            state: "suspended",
            reason: "Suspend the administrator",
          }),
        () =>
          repository.setAdminUserDeleted({
            actorId: resetPendingAdminId,
            expectedAuthorityEpoch: 1,
            targetUserId: effectiveAdminId,
            expectedVersion: 1,
            deleted: true,
            reason: "Delete the administrator",
          }),
      ];

      for (const operation of operations) {
        await assertDomainCode(operation, "admin_authority_required");
        const unchanged = await repository.getAdminUser(effectiveAdminId);
        assertEquals(unchanged.effectiveAdmin, true);
        assertEquals(unchanged.version, 1);
      }

      await assertDomainCode(() =>
        repository.setAdminUserRole({
          actorId: effectiveAdminId,
          expectedAuthorityEpoch: 1,
          targetUserId: candidateId,
          expectedVersion: 1,
          role: "admin",
          reason: "Attempt promotion during reset",
        }), "invalid_transition");
      const candidate = await repository.getAdminUser(candidateId);
      assertEquals(candidate.role, "user");
      assertEquals(candidate.effectiveAdmin, false);
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
