import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AuditEventInput, PrivilegedAuditEventInput } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

class FailingTokenAuditRepository extends MemoryRepository {
  failAction: string | null = null;

  override recordAudit(input: AuditEventInput) {
    if (input.action === this.failAction) throw new Error("injected token audit failure");
    return super.recordAudit(input);
  }
}

Deno.test("memory personal token mutations and mandatory audits roll back together", () => {
  const repository = new FailingTokenAuditRepository();
  const owner = repository.createUser({
    email: "atomic-token-memory@example.test",
    name: "Atomic token owner",
    role: "admin",
    approvalStatus: "approved",
  });
  const readContext = {
    actorId: owner.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: owner.authorityEpoch,
  };

  repository.failAction = "api_token.created";
  assertThrows(
    () =>
      repository.createApiToken(owner.id, {
        name: "must-not-survive",
        scopes: ["models:read"],
        tokenHash: "create-secret-hash",
        preview: "dg_create",
      }, owner.authorityEpoch),
    Error,
    "injected token audit failure",
  );
  assertEquals(repository.listApiTokens(owner.id), []);
  assertEquals(repository.findApiTokenByHash("create-secret-hash"), undefined);

  repository.failAction = null;
  const original = repository.createApiToken(owner.id, {
    name: "atomic family",
    scopes: ["models:read"],
    tokenHash: "original-secret-hash",
    preview: "dg_original",
  }, owner.authorityEpoch);
  const group = repository.createAccessGroup({ name: "atomic token group" }, {
    actorId: owner.id,
    action: "test.model_access_group.created",
    targetType: "model_access_group",
    requireEmailVerification: false,
    expectedAuthorityEpoch: owner.authorityEpoch,
  });
  repository.replaceAccessGroupUsers(group.id, [owner.id], group.version, {
    actorId: owner.id,
    action: "model_access_group.users_replaced",
    targetType: "model_access_group",
    targetId: group.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: owner.authorityEpoch,
  });
  repository.setTokenAccessGroups(owner.id, original.id, [group.id], original.version, {
    actorId: owner.id,
    action: "api_token.access_groups_set",
    targetType: "api_token",
    targetId: original.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: owner.authorityEpoch,
  });
  const current = repository.listApiTokens(owner.id)[0];
  const missingAudit = undefined as unknown as PrivilegedAuditEventInput;
  const omittedEpochAudit = {
    actorId: owner.id,
    action: "api_token.access_policy_set",
    targetType: "api_token",
    targetId: original.id,
    requireEmailVerification: false,
  } as unknown as PrivilegedAuditEventInput;
  for (
    const mutation of [
      () =>
        repository.setTokenAccessGroups(
          owner.id,
          original.id,
          [],
          current.version,
          missingAudit,
        ),
      () =>
        repository.setTokenAccessMode(
          owner.id,
          original.id,
          "inherit",
          current.version,
          missingAudit,
        ),
      () =>
        repository.setTokenAccessGroups(
          owner.id,
          original.id,
          [],
          current.version,
          omittedEpochAudit,
        ),
      () =>
        repository.setTokenAccessMode(
          owner.id,
          original.id,
          "inherit",
          current.version,
          omittedEpochAudit,
        ),
    ]
  ) {
    const error = assertThrows(mutation, DomainError);
    assertEquals(error.code, "admin_authority_required");
  }
  assertEquals(repository.listApiTokens(owner.id)[0], current);
  assertEquals(repository.listAccessGroups(readContext)[0].tokenIds, [original.id]);

  repository.failAction = "api_token.access_groups_set";
  assertThrows(
    () =>
      repository.setTokenAccessGroups(owner.id, original.id, [], current.version, {
        actorId: owner.id,
        action: "api_token.access_groups_set",
        targetType: "api_token",
        targetId: original.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: owner.authorityEpoch,
      }),
    Error,
    "injected token audit failure",
  );
  assertEquals(repository.listApiTokens(owner.id)[0].version, current.version);
  assertEquals(repository.listAccessGroups(readContext)[0].tokenIds, [original.id]);

  repository.failAction = "api_token.access_mode_set";
  assertThrows(
    () =>
      repository.setTokenAccessMode(owner.id, original.id, "inherit", current.version, {
        actorId: owner.id,
        action: "api_token.access_mode_set",
        targetType: "api_token",
        targetId: original.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: owner.authorityEpoch,
      }),
    Error,
    "injected token audit failure",
  );
  assertEquals(repository.listApiTokens(owner.id)[0].accessMode, "restricted");
  assertEquals(repository.listApiTokens(owner.id)[0].version, current.version);
  assertEquals(repository.listAccessGroups(readContext)[0].tokenIds, [original.id]);

  repository.failAction = "api_token.updated";
  assertThrows(
    () =>
      repository.updateApiToken(owner.id, original.id, {
        expectedVersion: current.version,
        name: "must roll back",
        scopes: [],
      }, owner.authorityEpoch),
    Error,
    "injected token audit failure",
  );
  assertEquals(repository.listApiTokens(owner.id)[0].name, "atomic family");
  assertEquals(repository.listApiTokens(owner.id)[0].scopes, ["models:read"]);
  assertEquals(repository.listApiTokens(owner.id)[0].version, current.version);

  repository.failAction = "api_token.rotated";
  assertThrows(
    () =>
      repository.rotateApiToken(owner.id, original.id, {
        expectedVersion: current.version,
        tokenHash: "replacement-secret-hash",
        preview: "dg_replace",
        overlapSeconds: 60,
      }, owner.authorityEpoch),
    Error,
    "injected token audit failure",
  );
  assertEquals(repository.findApiTokenByHash("replacement-secret-hash"), undefined);
  assertEquals(repository.listApiTokens(owner.id).length, 1);
  assertEquals(repository.listApiTokens(owner.id)[0].replacedByTokenId, null);
  assertEquals(repository.listAccessGroups(readContext)[0].tokenIds, [original.id]);

  repository.failAction = "api_token.revoked";
  assertThrows(
    () =>
      repository.revokeApiTokenFamily(
        original.id,
        owner.id,
        current.version,
        owner.authorityEpoch,
      ),
    Error,
    "injected token audit failure",
  );
  assertEquals(repository.listApiTokens(owner.id)[0].revokedAt, null);
  assertEquals(repository.listApiTokens(owner.id)[0].version, current.version);
  assertEquals(repository.authenticateApiToken("original-secret-hash")?.id, original.id);

  const auditJson = JSON.stringify(repository.auditEvents);
  assertEquals(auditJson.includes("original-secret-hash"), false);
  assertEquals(auditJson.includes("replacement-secret-hash"), false);
  assertEquals(auditJson.includes("dg_original"), false);
  assertEquals(
    repository.auditEvents.filter((event) => event.action.startsWith("api_token.")).map((
      event,
    ) => event.action),
    ["api_token.created", "api_token.access_groups_set"],
  );
});

Deno.test("memory personal token update and revoke fence lifecycle authority before lookup", () => {
  const repository = new MemoryRepository();
  const owner = repository.createUser({
    email: "token-authority-memory@example.test",
    name: "Token authority owner",
    approvalStatus: "approved",
  });
  const updateToken = repository.createApiToken(owner.id, {
    name: "unchanged update token",
    scopes: ["models:read"],
    tokenHash: "memory-authority-update",
    preview: "dg_update",
  }, owner.authorityEpoch);
  const baselineAuditCount = repository.auditEvents.length;

  const staleLookupError = assertThrows(
    () =>
      repository.updateApiToken(owner.id, crypto.randomUUID(), {
        expectedVersion: 99,
        name: "must not leak lookup state",
      }, owner.authorityEpoch - 1),
    DomainError,
  );
  assertEquals(staleLookupError.code, "account_unavailable");

  repository.users.get(owner.id)!.state = "suspended";
  const suspendedError = assertThrows(
    () =>
      repository.updateApiToken(owner.id, updateToken.id, {
        expectedVersion: updateToken.version,
        name: "must not update",
      }, owner.authorityEpoch),
    DomainError,
  );
  assertEquals(suspendedError.code, "account_unavailable");
  assertEquals(repository.listApiTokens(owner.id)[0].name, "unchanged update token");

  repository.users.get(owner.id)!.state = "active";
  repository.users.get(owner.id)!.passwordResetPending = true;
  const resetError = assertThrows(
    () =>
      repository.revokeApiTokenFamily(
        updateToken.id,
        owner.id,
        updateToken.version,
        owner.authorityEpoch,
      ),
    DomainError,
  );
  assertEquals(resetError.code, "account_unavailable");
  assertEquals(repository.listApiTokens(owner.id)[0].revokedAt, null);
  assertEquals(repository.auditEvents.length, baselineAuditCount);
});
