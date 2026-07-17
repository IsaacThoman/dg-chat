import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AuditEventInput, CreateAccessGroupInput } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

class FailingCreateAuditRepository extends MemoryRepository {
  failCreateAudit = false;

  override recordAudit(input: AuditEventInput) {
    if (this.failCreateAudit && input.action === "model_access_group.created") {
      throw new Error("injected access-group create audit failure");
    }
    return super.recordAudit(input);
  }
}

function audit(actorId: string, expectedAuthorityEpoch: number) {
  return {
    actorId,
    action: "model_access_group.created",
    targetType: "model_access_group",
    requireEmailVerification: false,
    expectedAuthorityEpoch,
  };
}

Deno.test("memory creates an initial access-group policy and mandatory audit atomically", () => {
  const repository = new FailingCreateAuditRepository();
  const actor = repository.createUser({
    email: "atomic-group-create@example.test",
    name: "Atomic group administrator",
    role: "admin",
    approvalStatus: "approved",
  });
  const now = new Date().toISOString();
  const modelId = crypto.randomUUID();
  repository.providerModels.set(modelId, {
    id: modelId,
    providerId: crypto.randomUUID(),
    publicModelId: "atomic/create",
    upstreamModelId: "atomic-create",
    displayName: "Atomic create",
    capabilities: ["chat"],
    contextWindow: 4_096,
    enabled: true,
    version: 1,
    customParams: {},
    createdAt: now,
    updatedAt: now,
  });
  const original = repository.createApiToken(actor.id, {
    name: "group family",
    scopes: ["models:read"],
    tokenHash: "atomic-group-old",
    preview: "dg_old",
  }, actor.authorityEpoch);
  const rotated = repository.rotateApiToken(actor.id, original.id, {
    expectedVersion: original.version,
    tokenHash: "atomic-group-new",
    preview: "dg_new",
    overlapSeconds: 60,
  }, actor.authorityEpoch);
  const beforeFailure = repository.listApiTokens(actor.id);

  repository.failCreateAudit = true;
  assertThrows(
    () =>
      repository.createAccessGroup({
        name: "Must roll back",
        userIds: [actor.id],
        modelIds: [modelId],
        tokenIds: [rotated.replacement.id],
      }, audit(actor.id, actor.authorityEpoch)),
    Error,
    "injected access-group create audit failure",
  );
  assertEquals(
    repository.listAccessGroups({
      actorId: actor.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: actor.authorityEpoch,
    }),
    [],
  );
  assertEquals(repository.listApiTokens(actor.id), beforeFailure);

  repository.failCreateAudit = false;
  const created = repository.createAccessGroup({
    name: "Atomic restriction",
    description: "Created with its complete policy",
    userIds: [actor.id, actor.id],
    modelIds: [modelId, modelId],
    tokenIds: [rotated.replacement.id],
  }, audit(actor.id, actor.authorityEpoch));
  assertEquals(created.version, 1);
  assertEquals(created.userIds, [actor.id]);
  assertEquals(created.modelIds, [modelId]);
  assertEquals(
    [...created.tokenIds].sort(),
    [original.id, rotated.replacement.id].sort(),
  );
  assertEquals(created.tokenOwners.every((entry) => entry.ownerId === actor.id), true);
  assertEquals(
    repository.listApiTokens(actor.id).every((token) => token.accessMode === "restricted"),
    true,
  );
  const event = repository.auditEvents.at(-1)!;
  assertEquals(event.action, "model_access_group.created");
  assertEquals(event.targetId, created.id);
  assertEquals(
    [...((event.metadata?.after as { tokenIds: string[] }).tokenIds)].sort(),
    [...created.tokenIds].sort(),
  );

  const empty = repository.createAccessGroup(
    { name: "Legacy empty group" },
    audit(actor.id, actor.authorityEpoch),
  );
  assertEquals(empty.userIds, []);
  assertEquals(empty.modelIds, []);
  assertEquals(empty.tokenIds, []);
});

Deno.test("memory rejects invalid initial access-group policy without leaving an orphan", () => {
  const repository = new MemoryRepository();
  const actor = repository.createUser({
    email: "invalid-group-create@example.test",
    name: "Invalid group administrator",
    role: "admin",
    approvalStatus: "approved",
  });
  const token = repository.createApiToken(actor.id, {
    name: "owner must be a member",
    scopes: ["models:read"],
    tokenHash: "invalid-group-token",
    preview: "dg_invalid",
  }, actor.authorityEpoch);
  const context = {
    actorId: actor.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: actor.authorityEpoch,
  };
  const invalidCases: Array<[CreateAccessGroupInput, string]> = [
    [{ name: "Missing user", userIds: [crypto.randomUUID()] }, "not_found"],
    [{ name: "Missing model", modelIds: [crypto.randomUUID()] }, "not_found"],
    [{ name: "Missing token", tokenIds: [crypto.randomUUID()] }, "not_found"],
    [{ name: "Owner absent", tokenIds: [token.id] }, "validation_error"],
  ];
  for (const [input, code] of invalidCases) {
    const error = assertThrows(
      () => repository.createAccessGroup(input, audit(actor.id, actor.authorityEpoch)),
      DomainError,
    );
    assertEquals(error.code, code);
  }
  assertEquals(repository.listAccessGroups(context), []);
});
