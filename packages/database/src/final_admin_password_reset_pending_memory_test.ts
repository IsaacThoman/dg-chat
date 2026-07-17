import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

function assertDomainCode(run: () => unknown, code: string) {
  const error = assertThrows(run, DomainError);
  assertEquals(error.code, code);
}

function fixture() {
  const repository = new MemoryRepository();
  const effectiveAdmin = repository.bootstrapAdmin({
    email: "effective-admin@example.com",
    name: "Effective administrator",
    passwordHash: "hash",
  }, 5_000_000);
  const resetPendingAdmin = repository.createUser({
    email: "reset-pending-admin@example.com",
    name: "Reset-pending administrator",
    role: "admin",
    approvalStatus: "approved",
    emailVerified: true,
  });
  resetPendingAdmin.passwordResetPending = true;
  return { repository, effectiveAdmin, resetPendingAdmin };
}

Deno.test("a reset-pending alternate admin cannot remove the sole effective memory admin", () => {
  const operations = [
    (
      repository: MemoryRepository,
      actorId: string,
      targetId: string,
      targetVersion: number,
    ) =>
      repository.decideUserApproval({
        actorId,
        expectedAuthorityEpoch: 1,
        targetUserId: targetId,
        expectedVersion: targetVersion,
        status: "rejected",
        startingCreditMicros: 0,
        reason: "Reject the administrator",
      }),
    (
      repository: MemoryRepository,
      actorId: string,
      targetId: string,
      targetVersion: number,
    ) =>
      repository.setAdminUserRole({
        actorId,
        expectedAuthorityEpoch: 1,
        targetUserId: targetId,
        expectedVersion: targetVersion,
        role: "user",
        reason: "Demote the administrator",
      }),
    (
      repository: MemoryRepository,
      actorId: string,
      targetId: string,
      targetVersion: number,
    ) =>
      repository.setAdminUserState({
        actorId,
        expectedAuthorityEpoch: 1,
        targetUserId: targetId,
        expectedVersion: targetVersion,
        state: "suspended",
        reason: "Suspend the administrator",
      }),
    (
      repository: MemoryRepository,
      actorId: string,
      targetId: string,
      targetVersion: number,
    ) =>
      repository.setAdminUserDeleted({
        actorId,
        expectedAuthorityEpoch: 1,
        targetUserId: targetId,
        expectedVersion: targetVersion,
        deleted: true,
        reason: "Delete the administrator",
      }),
  ];

  for (const operation of operations) {
    const { repository, effectiveAdmin, resetPendingAdmin } = fixture();
    assertDomainCode(
      () =>
        operation(
          repository,
          resetPendingAdmin.id,
          effectiveAdmin.id,
          effectiveAdmin.version,
        ),
      "admin_authority_required",
    );
    const unchanged = repository.getAdminUser(effectiveAdmin.id);
    assertEquals(unchanged.effectiveAdmin, true);
    assertEquals(unchanged.version, effectiveAdmin.version);
  }
});

Deno.test("memory promotion rejects a password-reset-pending user", () => {
  const { repository, effectiveAdmin } = fixture();
  const candidate = repository.createUser({
    email: "promotion-candidate@example.com",
    name: "Promotion candidate",
    approvalStatus: "approved",
    emailVerified: true,
  });
  candidate.passwordResetPending = true;

  assertDomainCode(() =>
    repository.setAdminUserRole({
      actorId: effectiveAdmin.id,
      expectedAuthorityEpoch: effectiveAdmin.authorityEpoch,
      targetUserId: candidate.id,
      expectedVersion: candidate.version,
      role: "admin",
      reason: "Attempt promotion during reset",
    }), "invalid_transition");
  assertEquals(repository.getAdminUser(candidate.id).role, "user");
  assertEquals(repository.getAdminUser(candidate.id).effectiveAdmin, false);
});
