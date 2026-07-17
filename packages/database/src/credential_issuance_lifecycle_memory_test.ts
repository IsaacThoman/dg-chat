import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

Deno.test("credential issuance requires current lifecycle authority while preserving status sessions", () => {
  const repository = new MemoryRepository();
  const actor = repository.bootstrapAdmin({
    email: "credential-memory-admin@example.com",
    name: "Credential memory admin",
    passwordHash: "test-only",
  }, 0);
  const applicant = repository.createUser({
    email: "credential-memory-applicant@example.com",
    name: "Credential memory applicant",
    passwordHash: "test-only",
  });

  const statusSession = repository.createSession(applicant.id, "pending-limited", true);
  assertEquals(statusSession.limited, true);
  assertThrows(
    () => repository.createSession(applicant.id, "pending-full", false),
    DomainError,
    "cannot create this session",
  );
  assertThrows(
    () =>
      repository.createApiToken(applicant.id, {
        name: "pending token",
        scopes: ["chat:write"],
        tokenHash: "pending-token",
        preview: "pending",
      }, applicant.authorityEpoch),
    DomainError,
    "cannot create API tokens",
  );

  let managed = repository.decideUserApproval({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: applicant.id,
    expectedVersion: applicant.version,
    status: "approved",
    startingCreditMicros: 0,
  });
  const fullSession = repository.createSession(applicant.id, "approved-full", false);
  const token = repository.createApiToken(applicant.id, {
    name: "approved token",
    scopes: ["chat:write"],
    tokenHash: "approved-token",
    preview: "approved",
  }, repository.findUser(applicant.id)!.authorityEpoch);
  managed = repository.setAdminUserState({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: applicant.id,
    expectedVersion: managed.version,
    state: "suspended",
    reason: "Exercise credential issuance authority",
  });
  assertEquals(repository.getSession(fullSession.tokenHash), undefined);
  assertEquals(repository.authenticateApiToken(token.tokenHash), undefined);
  const staleEpoch = fullSession.authorityEpoch;
  assertThrows(
    () => repository.createSession(applicant.id, "suspended-limited", true),
    DomainError,
    "cannot create this session",
  );
  assertThrows(
    () =>
      repository.createApiToken(applicant.id, {
        name: "suspended token",
        scopes: ["chat:write"],
        tokenHash: "suspended-token",
        preview: "suspended",
      }, staleEpoch),
    DomainError,
    "cannot create API tokens",
  );
  assertThrows(
    () =>
      repository.rotateApiToken(applicant.id, token.id, {
        expectedVersion: token.version,
        overlapSeconds: 0,
        tokenHash: "suspended-rotation",
        preview: "suspended",
      }, staleEpoch),
    DomainError,
    "cannot rotate API tokens",
  );

  managed = repository.setAdminUserState({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: applicant.id,
    expectedVersion: managed.version,
    state: "active",
    reason: "Restore credential issuance authority",
  });
  assertEquals(repository.getSession(fullSession.tokenHash), undefined);
  assertEquals(repository.authenticateApiToken(token.tokenHash), undefined);

  assertThrows(
    () => repository.createSession(applicant.id, "stale-restored-session", false, staleEpoch),
    DomainError,
    "cannot create this session",
  );
  assertThrows(
    () =>
      repository.createApiToken(applicant.id, {
        name: "stale restored token",
        scopes: ["chat:write"],
        tokenHash: "stale-restored-token",
        preview: "stale",
      }, staleEpoch),
    DomainError,
    "cannot create API tokens",
  );
  const currentEpoch = repository.findUser(applicant.id)!.authorityEpoch;

  const rotatable = repository.createApiToken(applicant.id, {
    name: "post-suspension token",
    scopes: ["chat:write"],
    tokenHash: "post-suspension-token",
    preview: "post-suspension",
  }, currentEpoch);
  const rotated = repository.rotateApiToken(applicant.id, rotatable.id, {
    expectedVersion: rotatable.version,
    overlapSeconds: 30,
    tokenHash: "post-suspension-rotated",
    preview: "post-suspension-rotated",
  }, currentEpoch);

  managed = repository.decideUserApproval({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: applicant.id,
    expectedVersion: managed.version,
    status: "rejected",
    startingCreditMicros: 0,
    reason: "Exercise rotation authority after rejection",
  });
  assertThrows(
    () =>
      repository.createIdentityToken(
        applicant.id,
        "password_reset",
        "rejected-password-reset",
        new Date(Date.now() + 60_000).toISOString(),
        repository.findUser(applicant.id)!.authorityEpoch,
      ),
    DomainError,
    "Identity authority changed",
  );
  repository.createIdentityToken(
    applicant.id,
    "email_verification",
    "rejected-email-verification",
    new Date(Date.now() + 60_000).toISOString(),
    repository.findUser(applicant.id)!.authorityEpoch,
  );
  assertThrows(
    () =>
      repository.rotateApiToken(applicant.id, rotated.replacement.id, {
        expectedVersion: rotated.replacement.version,
        overlapSeconds: 0,
        tokenHash: "rejected-rotation",
        preview: "rejected",
      }, repository.findUser(applicant.id)!.authorityEpoch),
    DomainError,
    "cannot rotate API tokens",
  );
  managed = repository.decideUserApproval({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: applicant.id,
    expectedVersion: managed.version,
    status: "approved",
    startingCreditMicros: 0,
  });
  assertEquals(repository.authenticateApiToken("post-suspension-token"), undefined);
  assertEquals(repository.authenticateApiToken("post-suspension-rotated"), undefined);
  const reapprovedEpoch = repository.findUser(applicant.id)!.authorityEpoch;

  const beforeDeletion = repository.createApiToken(applicant.id, {
    name: "pre-deletion token",
    scopes: ["chat:write"],
    tokenHash: "pre-deletion-token",
    preview: "pre-deletion",
  }, reapprovedEpoch);
  managed = repository.setAdminUserDeleted({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: applicant.id,
    expectedVersion: managed.version,
    deleted: true,
    reason: "Exercise rotation authority after deletion",
  });
  assertThrows(
    () =>
      repository.rotateApiToken(applicant.id, beforeDeletion.id, {
        expectedVersion: beforeDeletion.version,
        overlapSeconds: 0,
        tokenHash: "deleted-rotation",
        preview: "deleted",
      }, repository.findUser(applicant.id)!.authorityEpoch),
    DomainError,
    "cannot rotate API tokens",
  );
  repository.setAdminUserDeleted({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: applicant.id,
    expectedVersion: managed.version,
    deleted: false,
    reason: "Restore after deletion rotation test",
  });
  assertEquals(repository.authenticateApiToken("pre-deletion-token"), undefined);
});

Deno.test("every administrator role transition advances authority and revokes full credentials", () => {
  const repository = new MemoryRepository();
  const actor = repository.bootstrapAdmin({
    email: "epoch-demotion-actor@example.com",
    name: "Epoch demotion actor",
    passwordHash: "test-only",
  }, 0);
  const target = repository.createUser({
    email: "epoch-demotion-target@example.com",
    name: "Epoch demotion target",
    passwordHash: "test-only",
    approvalStatus: "approved",
  });
  const beforePromotionSession = repository.createSession(
    target.id,
    "pre-promotion-session",
    false,
    1,
  );
  const beforePromotionToken = repository.createApiToken(target.id, {
    name: "pre-promotion token",
    scopes: ["models:read"],
    tokenHash: "pre-promotion-token",
    preview: "promote",
  }, 1);
  let managed = repository.setAdminUserRole({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: target.id,
    expectedVersion: target.version,
    role: "admin",
    reason: "Promote for demotion test",
  });
  assertEquals(repository.findUser(target.id)!.authorityEpoch, 2);
  assertEquals(repository.getSession(beforePromotionSession.tokenHash), undefined);
  assertEquals(repository.authenticateApiToken(beforePromotionToken.tokenHash), undefined);
  const session = repository.createSession(target.id, "demoted-session", false, 2);
  const token = repository.createApiToken(target.id, {
    name: "demoted token",
    scopes: ["models:read"],
    tokenHash: "demoted-token",
    preview: "demoted",
  }, 2);
  managed = repository.setAdminUserRole({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: target.id,
    expectedVersion: managed.version,
    role: "user",
    reason: "Exercise demotion authority loss",
  });
  assertEquals(repository.findUser(target.id)!.authorityEpoch, 3);
  assertEquals(repository.getSession(session.tokenHash), undefined);
  assertEquals(repository.authenticateApiToken(token.tokenHash), undefined);
  repository.setAdminUserRole({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: target.id,
    expectedVersion: managed.version,
    role: "admin",
    reason: "Restore administrator role",
  });
  assertEquals(repository.findUser(target.id)!.authorityEpoch, 4);
});

Deno.test("memory token authentication independently enforces owner eligibility", () => {
  const repository = new MemoryRepository();
  const user = repository.createUser({
    email: "memory-token-eligibility@example.com",
    name: "Memory token eligibility",
    passwordHash: "test-only",
    approvalStatus: "approved",
  });
  const token = repository.createApiToken(user.id, {
    name: "Eligibility token",
    scopes: ["models:read"],
    tokenHash: "memory-token-eligibility",
    preview: "eligibility",
  }, user.authorityEpoch);
  assertEquals(repository.authenticateApiToken(token.tokenHash)?.id, token.id);

  repository.users.get(user.id)!.passwordResetPending = true;
  assertEquals(repository.authenticateApiToken(token.tokenHash), undefined);
  repository.users.get(user.id)!.passwordResetPending = false;
  repository.users.get(user.id)!.state = "suspended";
  assertEquals(repository.authenticateApiToken(token.tokenHash), undefined);
  repository.users.get(user.id)!.state = "active";
  repository.users.get(user.id)!.approvalStatus = "rejected";
  assertEquals(repository.authenticateApiToken(token.tokenHash), undefined);
  repository.users.get(user.id)!.approvalStatus = "approved";
  repository.users.get(user.id)!.deletedAt = new Date().toISOString();
  assertEquals(repository.authenticateApiToken(token.tokenHash), undefined);
});
