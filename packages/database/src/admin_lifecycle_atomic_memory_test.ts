import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AuditEventInput } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

class FaultInjectingAuditRepository extends MemoryRepository {
  failAuditAppend = false;

  override recordAudit(input: AuditEventInput) {
    if (this.failAuditAppend) throw new Error("injected audit append failure");
    return super.recordAudit(input);
  }
}

function fixture(repository = new FaultInjectingAuditRepository()) {
  const actor = repository.bootstrapAdmin({
    email: "atomic-admin@example.com",
    name: "Atomic Administrator",
    passwordHash: "test-only-hash",
  }, 0);
  return { repository, actor };
}

function assertDomainCode(operation: () => unknown, code: string) {
  const error = assertThrows(operation, DomainError);
  assertEquals(error.code, code);
}

Deno.test("memory admin lifecycle rolls back grants and authority revocation when audit append fails", () => {
  const { repository, actor } = fixture();
  const applicant = repository.createUser({
    email: "atomic-applicant@example.com",
    name: "Atomic Applicant",
  });
  const approved = repository.createUser({
    email: "atomic-approved@example.com",
    name: "Atomic Approved",
    approvalStatus: "approved",
    emailVerified: true,
  });
  const fullSession = repository.createSession(approved.id, "atomic-full-session", false);
  const token = repository.createApiToken(approved.id, {
    name: "Atomic token",
    scopes: ["chat:write"],
    tokenHash: "atomic-token-hash",
    preview: "atomic",
  }, approved.authorityEpoch);
  repository.createIdentityToken(
    approved.id,
    "password_reset",
    "atomic-reset-token",
    new Date(Date.now() + 60_000).toISOString(),
    approved.authorityEpoch,
  );
  const auditCount = repository.auditEvents.length;
  repository.failAuditAppend = true;

  assertThrows(
    () =>
      repository.decideUserApproval({
        actorId: actor.id,
        expectedAuthorityEpoch: 1,
        targetUserId: applicant.id,
        expectedVersion: applicant.version,
        status: "approved",
        startingCreditMicros: 500,
      }),
    Error,
    "injected audit append failure",
  );
  assertEquals(repository.getAdminUser(applicant.id).approvalStatus, "pending");
  assertEquals(repository.getAdminUser(applicant.id).balanceMicros, 0);
  assertEquals(repository.getAdminUser(applicant.id).version, 1);
  assertEquals(
    repository.ledger.some((entry) => entry.usageRunId === `approval:${applicant.id}`),
    false,
  );

  assertThrows(
    () =>
      repository.decideUserApproval({
        actorId: actor.id,
        expectedAuthorityEpoch: 1,
        targetUserId: approved.id,
        expectedVersion: approved.version,
        status: "rejected",
        startingCreditMicros: 0,
        reason: "Injected rollback coverage",
      }),
    Error,
    "injected audit append failure",
  );
  assertEquals(repository.getAdminUser(approved.id).approvalStatus, "approved");
  assertEquals(repository.getAdminUser(approved.id).version, 1);
  assertEquals(repository.listSessions(approved.id).map((session) => session.id), [fullSession.id]);
  assertEquals(token.revokedAt, null);
  assertEquals(token.version, 1);
  assertEquals(repository.identityTokens.get("atomic-reset-token")?.consumedAt, null);
  assertEquals(repository.auditEvents.length, auditCount);
});

Deno.test("memory repository enforces lifecycle reasons at the domain boundary", () => {
  const { repository, actor } = fixture();
  const user = repository.createUser({
    email: "reason-target@example.com",
    name: "Reason Target",
  });

  assertDomainCode(() =>
    repository.decideUserApproval({
      actorId: actor.id,
      expectedAuthorityEpoch: 1,
      targetUserId: user.id,
      expectedVersion: user.version,
      status: "rejected",
      startingCreditMicros: 0,
    }), "validation_error");
  assertDomainCode(() =>
    repository.setAdminUserState({
      actorId: actor.id,
      expectedAuthorityEpoch: 1,
      targetUserId: user.id,
      expectedVersion: user.version,
      state: "suspended",
    }), "validation_error");
  assertDomainCode(() =>
    repository.setAdminUserRole({
      actorId: actor.id,
      expectedAuthorityEpoch: 1,
      targetUserId: user.id,
      expectedVersion: user.version,
      role: "admin",
      reason: "   ",
    }), "validation_error");
  assertDomainCode(() =>
    repository.setAdminUserDeleted({
      actorId: actor.id,
      expectedAuthorityEpoch: 1,
      targetUserId: user.id,
      expectedVersion: user.version,
      deleted: true,
      reason: "   ",
    }), "validation_error");

  const approved = repository.decideUserApproval({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: user.id,
    expectedVersion: user.version,
    status: "approved",
    startingCreditMicros: 0,
  });
  const suspended = repository.setAdminUserState({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: user.id,
    expectedVersion: approved.version,
    state: "suspended",
    reason: "Reason supplied for authority loss",
  });
  const activated = repository.setAdminUserState({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: user.id,
    expectedVersion: suspended.version,
    state: "active",
  });
  assertEquals(activated.state, "active");
});

Deno.test("memory credits reject unsafe integer accounting without mutation", () => {
  const { repository } = fixture();
  const user = repository.createUser({
    email: "unsafe-credit@example.com",
    name: "Unsafe Credit",
  });
  user.balanceMicros = Number.MAX_SAFE_INTEGER - 100;

  assertDomainCode(
    () => repository.credit(user.id, "unsafe-credit", "grant", 101),
    "validation_error",
  );
  assertEquals(user.balanceMicros, Number.MAX_SAFE_INTEGER - 100);
  assertEquals(repository.ledger.some((entry) => entry.usageRunId === "unsafe-credit"), false);

  assertDomainCode(
    () => repository.credit(user.id, "fractional-credit", "grant", 0.5),
    "validation_error",
  );
  assertEquals(user.balanceMicros, Number.MAX_SAFE_INTEGER - 100);
  assertEquals(
    repository.ledger.some((entry) => entry.usageRunId === "fractional-credit"),
    false,
  );
});

Deno.test("memory approval rolls back when its grant would exceed safe integer accounting", () => {
  const { repository, actor } = fixture();
  const applicant = repository.createUser({
    email: "unsafe-approval@example.com",
    name: "Unsafe Approval",
  });
  const initialBalance = Number.MAX_SAFE_INTEGER - 100;
  applicant.balanceMicros = initialBalance;
  const auditCount = repository.auditEvents.length;

  assertDomainCode(() =>
    repository.decideUserApproval({
      actorId: actor.id,
      expectedAuthorityEpoch: 1,
      targetUserId: applicant.id,
      expectedVersion: applicant.version,
      status: "approved",
      startingCreditMicros: 101,
    }), "validation_error");

  const unchanged = repository.getAdminUser(applicant.id);
  assertEquals(unchanged.approvalStatus, "pending");
  assertEquals(unchanged.balanceMicros, initialBalance);
  assertEquals(unchanged.version, 1);
  assertEquals(
    repository.ledger.some((entry) => entry.usageRunId === `approval:${applicant.id}`),
    false,
  );
  assertEquals(repository.auditEvents.length, auditCount);
});
