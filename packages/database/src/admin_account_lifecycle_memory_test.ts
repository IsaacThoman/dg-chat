import { assertEquals, assertExists, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";
import { encodeAdminUserCursor } from "./repository.ts";

function adminRepository() {
  const repo = new MemoryRepository();
  const admin = repo.bootstrapAdmin({
    email: "admin@example.com",
    name: "Administrator",
    passwordHash: "hash",
  }, 5_000_000);
  return { repo, admin };
}

function assertDomainCode(run: () => unknown, code: string) {
  const error = assertThrows(run, DomainError);
  assertEquals(error.code, code);
}

Deno.test("admin lifecycle protects the exact final effective administrator", () => {
  const { repo, admin } = adminRepository();
  const pendingAdmin = repo.createUser({
    email: "pending-admin@example.com",
    name: "Pending administrator",
    role: "admin",
  });

  assertDomainCode(() =>
    repo.setAdminUserState({
      actorId: admin.id,
      targetUserId: admin.id,
      expectedVersion: admin.version,
      state: "suspended",
      reason: "test",
    }), "self_action_forbidden");

  assertDomainCode(() =>
    repo.setAdminUserState({
      actorId: pendingAdmin.id,
      targetUserId: admin.id,
      expectedVersion: admin.version,
      state: "suspended",
      reason: "test",
    }), "admin_authority_required");

  const second = repo.createUser({
    email: "second@example.com",
    name: "Second administrator",
    approvalStatus: "approved",
    emailVerified: true,
  });
  const promoted = repo.setAdminUserRole({
    actorId: admin.id,
    targetUserId: second.id,
    expectedVersion: second.version,
    role: "admin",
    reason: "Coverage",
  });
  assertEquals(promoted.effectiveAdmin, true);

  const suspended = repo.setAdminUserState({
    actorId: second.id,
    targetUserId: admin.id,
    expectedVersion: admin.version,
    state: "suspended",
    reason: "Security review",
  });
  assertEquals(suspended.effectiveAdmin, false);
  assertEquals(suspended.version, 2);
  assertEquals(repo.listAudit({ targetId: admin.id }).data[0].action, "user.state.suspended");
});

Deno.test("admin lifecycle uses optimistic versions and keeps deletion independent", () => {
  const { repo, admin } = adminRepository();
  const user = repo.createUser({
    email: "person@example.com",
    name: "Person",
    approvalStatus: "approved",
    emailVerified: true,
  });
  const full = repo.createSession(user.id, "full", false);
  const limited = repo.createSession(user.id, "limited", true);
  const apiToken = repo.createApiToken(user.id, {
    name: "Lifecycle token",
    scopes: ["chat:write"],
    tokenHash: "lifecycle-token",
    preview: "dg_life",
  });
  repo.createIdentityToken(
    user.id,
    "password_reset",
    "pending-password-reset",
    new Date(Date.now() + 60_000).toISOString(),
    user.authorityEpoch,
  );
  const originalVersion = user.version;

  const deleted = repo.setAdminUserDeleted({
    actorId: admin.id,
    targetUserId: user.id,
    expectedVersion: user.version,
    deleted: true,
    reason: "Requested deletion",
  });
  assertEquals(deleted.deletedAt !== null, true);
  assertEquals(deleted.state, "active");
  assertEquals(repo.listSessions(user.id).map((session) => session.id), [limited.id]);
  assertEquals(repo.listSessions(user.id).some((session) => session.id === full.id), false);
  assertEquals(apiToken.revokedAt !== null, true);
  assertEquals(apiToken.version, 2);
  assertEquals(repo.identityTokens.get("pending-password-reset")?.consumedAt !== null, true);

  assertDomainCode(() =>
    repo.setAdminUserState({
      actorId: admin.id,
      targetUserId: user.id,
      expectedVersion: originalVersion,
      state: "suspended",
      reason: "Stale request",
    }), "version_conflict");

  const restored = repo.setAdminUserDeleted({
    actorId: admin.id,
    targetUserId: user.id,
    expectedVersion: deleted.version,
    deleted: false,
    reason: "Restore approved",
  });
  assertEquals(restored.deletedAt, null);
  assertEquals(restored.state, "active");
  assertEquals(restored.version, deleted.version + 1);
});

Deno.test("admin lifecycle fails closed after actor authority is revoked", () => {
  const { repo, admin } = adminRepository();
  const second = repo.createUser({
    email: "security-admin@example.com",
    name: "Security administrator",
    approvalStatus: "approved",
    emailVerified: true,
  });
  repo.setAdminUserRole({
    actorId: admin.id,
    targetUserId: second.id,
    expectedVersion: second.version,
    role: "admin",
    reason: "Add independent administrator",
  });
  repo.setAdminUserRole({
    actorId: second.id,
    targetUserId: admin.id,
    expectedVersion: admin.version,
    role: "user",
    reason: "Revoke stale administrator",
  });
  const applicant = repo.createUser({ email: "stale-target@example.com", name: "Applicant" });
  const auditCount = repo.auditEvents.length;

  assertDomainCode(() =>
    repo.decideUserApproval({
      actorId: admin.id,
      targetUserId: applicant.id,
      expectedVersion: applicant.version,
      status: "approved",
      startingCreditMicros: 500,
    }), "admin_authority_required");
  assertEquals(applicant.approvalStatus, "pending");
  assertEquals(applicant.balanceMicros, 0);
  assertEquals(repo.auditEvents.length, auditCount);
});

Deno.test("admin user directory has stable filter-bound cursor pagination", () => {
  const { repo } = adminRepository();
  const createdAt = "2026-07-13T12:00:00.000Z";
  for (let index = 0; index < 4; index++) {
    const user = repo.createUser({
      email: `person-${index}@example.com`,
      name: `Person ${index}`,
      approvalStatus: index % 2 === 0 ? "approved" : "pending",
    });
    user.createdAt = createdAt;
  }

  const first = repo.listAdminUsers({ search: "person", limit: 2 });
  const second = repo.listAdminUsers({ search: "person", limit: 2, cursor: first.nextCursor! });
  assertEquals(first.data.length, 2);
  assertEquals(second.data.length, 2);
  assertEquals(new Set([...first.data, ...second.data].map((user) => user.id)).size, 4);

  assertDomainCode(() =>
    repo.listAdminUsers({
      search: "person",
      approvalStatus: "approved",
      limit: 2,
      cursor: first.nextCursor!,
    }), "validation_error");
});

Deno.test("admin user directory cursors support non-Latin filter text", () => {
  const repo = new MemoryRepository();
  const actor = repo.createUser({
    email: "unicode-admin@example.com",
    name: "Unicode admin",
    role: "admin",
    approvalStatus: "approved",
  });
  for (let index = 0; index < 3; index++) {
    repo.createUser({
      email: `unicode-${index}@example.com`,
      name: `漢字 ${index}`,
      approvalStatus: "approved",
    });
  }

  const first = repo.listAdminUsers({ search: "漢字", limit: 1 });
  assertEquals(first.data.length, 1);
  assertExists(first.nextCursor);
  const second = repo.listAdminUsers({ search: "漢字", limit: 1, cursor: first.nextCursor });
  assertEquals(second.data.length, 1);
  assertEquals(second.data[0].id === first.data[0].id, false);
  assertEquals(repo.getAdminUser(actor.id).role, "admin");
  assertThrows(
    () => encodeAdminUserCursor(first.data[0], { search: "漢字" }, "999999999999999999"),
    TypeError,
  );
});

Deno.test("approval grant is append-only and never repeated on reapproval", () => {
  const { repo, admin } = adminRepository();
  const user = repo.createUser({ email: "applicant@example.com", name: "Applicant" });
  const approved = repo.decideUserApproval({
    actorId: admin.id,
    targetUserId: user.id,
    expectedVersion: user.version,
    status: "approved",
    startingCreditMicros: 5_000_000,
  });
  const rejected = repo.decideUserApproval({
    actorId: admin.id,
    targetUserId: user.id,
    expectedVersion: approved.version,
    status: "rejected",
    startingCreditMicros: 5_000_000,
    reason: "Review",
  });
  const reapproved = repo.decideUserApproval({
    actorId: admin.id,
    targetUserId: user.id,
    expectedVersion: rejected.version,
    status: "approved",
    startingCreditMicros: 5_000_000,
  });
  assertEquals(reapproved.balanceMicros, 5_000_000);
  assertEquals(
    repo.ledger.filter((entry) => entry.usageRunId === `approval:${user.id}`).length,
    1,
  );
});
