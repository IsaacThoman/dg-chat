import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

Deno.test("memory admin lifecycle rejects an admitted command after the actor epoch changes", () => {
  const repository = new MemoryRepository();
  const actor = repository.createUser({
    email: "stale-lifecycle-actor@example.test",
    name: "Stale lifecycle actor",
    role: "admin",
    approvalStatus: "approved",
  });
  const approvalTarget = repository.createUser({
    email: "stale-approval-target@example.test",
    name: "Stale approval target",
  });
  const roleTarget = repository.createUser({
    email: "stale-role-target@example.test",
    name: "Stale role target",
    approvalStatus: "approved",
  });
  const stateTarget = repository.createUser({
    email: "stale-state-target@example.test",
    name: "Stale state target",
    approvalStatus: "approved",
  });
  const deletionTarget = repository.createUser({
    email: "stale-deletion-target@example.test",
    name: "Stale deletion target",
    approvalStatus: "approved",
  });
  const admittedEpoch = actor.authorityEpoch;

  // Model a password reset that completes after middleware admission: the actor is once again an
  // otherwise-effective administrator, but every credential from the admitted epoch is stale.
  repository.users.get(actor.id)!.authorityEpoch++;
  const assertStale = (operation: () => unknown) => {
    const error = assertThrows(operation, DomainError);
    assertEquals(error.code, "admin_authority_required");
  };

  assertStale(() =>
    repository.decideUserApproval({
      actorId: actor.id,
      expectedAuthorityEpoch: admittedEpoch,
      targetUserId: approvalTarget.id,
      expectedVersion: approvalTarget.version,
      status: "approved",
      startingCreditMicros: 500,
    })
  );
  assertStale(() =>
    repository.setAdminUserRole({
      actorId: actor.id,
      expectedAuthorityEpoch: admittedEpoch,
      targetUserId: roleTarget.id,
      expectedVersion: roleTarget.version,
      role: "admin",
      reason: "Must reject stale authority",
    })
  );
  assertStale(() =>
    repository.setAdminUserState({
      actorId: actor.id,
      expectedAuthorityEpoch: admittedEpoch,
      targetUserId: stateTarget.id,
      expectedVersion: stateTarget.version,
      state: "suspended",
      reason: "Must reject stale authority",
    })
  );
  assertStale(() =>
    repository.setAdminUserDeleted({
      actorId: actor.id,
      expectedAuthorityEpoch: admittedEpoch,
      targetUserId: deletionTarget.id,
      expectedVersion: deletionTarget.version,
      deleted: true,
      reason: "Must reject stale authority",
    })
  );

  assertEquals(repository.getAdminUser(approvalTarget.id).approvalStatus, "pending");
  assertEquals(repository.getAdminUser(roleTarget.id).role, "user");
  assertEquals(repository.getAdminUser(stateTarget.id).state, "active");
  assertEquals(repository.getAdminUser(deletionTarget.id).deletedAt, null);
  assertEquals(repository.auditEvents.length, 0);

  const malformed = assertThrows(
    () =>
      repository.setAdminUserState({
        actorId: actor.id,
        expectedAuthorityEpoch: 0,
        targetUserId: stateTarget.id,
        expectedVersion: stateTarget.version,
        state: "suspended",
        reason: "Must reject a malformed authority epoch",
      }),
    DomainError,
  );
  assertEquals(malformed.code, "validation_error");

  const omitted = assertThrows(
    () =>
      repository.setAdminUserState(
        {
          actorId: actor.id,
          targetUserId: stateTarget.id,
          expectedVersion: stateTarget.version,
          state: "suspended",
          reason: "Must reject an omitted authority epoch",
        } as unknown as Parameters<MemoryRepository["setAdminUserState"]>[0],
      ),
    DomainError,
  );
  assertEquals(omitted.code, "validation_error");
});
