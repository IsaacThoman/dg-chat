import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";
import type { PrivilegedAuditEventInput } from "./repository.ts";

const SPOOFED_TARGET = "caller-controlled-target-must-not-win";

function audit(
  actorId: string,
  expectedAuthorityEpoch: number,
  action: string,
  targetType: "model_access_group" | "api_token" = "model_access_group",
): PrivilegedAuditEventInput {
  return {
    actorId,
    action,
    targetType,
    targetId: SPOOFED_TARGET,
    requireEmailVerification: false,
    expectedAuthorityEpoch,
  };
}

function tokenById(repository: MemoryRepository, ownerId: string, tokenId: string) {
  const value = repository.listApiTokens(ownerId).find((token) => token.id === tokenId);
  if (!value) throw new Error(`Token ${tokenId} disappeared`);
  return value;
}

Deno.test("memory membership removal and group deletion fence every token generation", () => {
  const repository = new MemoryRepository();
  const actor = repository.createUser({
    email: "membership-cas-memory-admin@example.test",
    name: "Membership CAS memory admin",
    role: "admin",
    approvalStatus: "approved",
  });
  const owner = repository.createUser({
    email: "membership-cas-memory-owner@example.test",
    name: "Membership CAS memory owner",
    approvalStatus: "approved",
  });
  const original = repository.createApiToken(owner.id, {
    name: "membership CAS family",
    scopes: ["models:read"],
    tokenHash: "membership-cas-memory-old",
    preview: "dg_mcm…old",
  }, owner.authorityEpoch);
  const created = repository.createAccessGroup(
    { name: "Memory membership CAS" },
    audit(actor.id, actor.authorityEpoch, "memory.membership.group_created"),
  );
  let group = repository.replaceAccessGroupPolicy(created.id, {
    expectedVersion: created.version,
    userIds: [owner.id],
    modelIds: [],
    tokenIds: [original.id],
    acknowledgePublicModelIds: [],
  }, audit(actor.id, actor.authorityEpoch, "memory.membership.policy_assigned"));
  const currentOriginal = tokenById(repository, owner.id, original.id);
  const rotation = repository.rotateApiToken(owner.id, original.id, {
    expectedVersion: currentOriginal.version,
    tokenHash: "membership-cas-memory-new",
    preview: "dg_mcm…new",
    overlapSeconds: 30,
  }, owner.authorityEpoch);
  const beforeRemoval = new Map(
    repository.listApiTokens(owner.id).map((token) => [token.id, token]),
  );

  group = repository.replaceAccessGroupUsers(
    group.id,
    [],
    group.version,
    audit(actor.id, actor.authorityEpoch, "memory.membership.users_removed"),
  );
  assertEquals(group.tokenIds, []);
  for (const tokenId of [original.id, rotation.replacement.id]) {
    const before = beforeRemoval.get(tokenId)!;
    const after = tokenById(repository, owner.id, tokenId);
    assertEquals(after.accessMode, "restricted");
    assertEquals(after.version, before.version + 1);
  }
  const staleRemovalCas = assertThrows(
    () =>
      repository.setTokenAccessMode(
        owner.id,
        rotation.replacement.id,
        "inherit",
        beforeRemoval.get(rotation.replacement.id)!.version,
        audit(
          actor.id,
          actor.authorityEpoch,
          "memory.membership.stale_mode_after_removal",
          "api_token",
        ),
      ),
    DomainError,
  );
  assertEquals(staleRemovalCas.code, "version_conflict");

  group = repository.replaceAccessGroupPolicy(group.id, {
    expectedVersion: group.version,
    userIds: [owner.id],
    modelIds: [],
    tokenIds: [rotation.replacement.id],
    acknowledgePublicModelIds: [],
  }, audit(actor.id, actor.authorityEpoch, "memory.membership.policy_reassigned"));
  const beforeDeletion = new Map(
    repository.listApiTokens(owner.id).map((token) => [token.id, token]),
  );
  repository.deleteAccessGroup(
    group.id,
    group.version,
    [],
    audit(actor.id, actor.authorityEpoch, "memory.membership.group_deleted"),
  );
  for (const tokenId of [original.id, rotation.replacement.id]) {
    const before = beforeDeletion.get(tokenId)!;
    const after = tokenById(repository, owner.id, tokenId);
    assertEquals(after.accessMode, "restricted");
    assertEquals(after.version, before.version + 1);
  }
  const staleDeletionCas = assertThrows(
    () =>
      repository.setTokenAccessGroups(
        owner.id,
        rotation.replacement.id,
        [],
        beforeDeletion.get(rotation.replacement.id)!.version,
        audit(
          actor.id,
          actor.authorityEpoch,
          "memory.membership.stale_groups_after_delete",
          "api_token",
        ),
      ),
    DomainError,
  );
  assertEquals(staleDeletionCas.code, "version_conflict");
});

Deno.test("memory access-group and token-policy audits derive their mutation targets", () => {
  const repository = new MemoryRepository();
  const actor = repository.createUser({
    email: "audit-target-memory@example.test",
    name: "Audit target memory admin",
    role: "admin",
    approvalStatus: "approved",
  });
  const token = repository.createApiToken(actor.id, {
    name: "audit target token",
    scopes: [],
    tokenHash: "audit-target-memory-token",
    preview: "dg_atm",
  }, actor.authorityEpoch);
  const actions: Array<[string, string]> = [];
  const created = repository.createAccessGroup(
    { name: "Authoritative memory audit target" },
    audit(actor.id, actor.authorityEpoch, "memory.audit.group_created"),
  );
  actions.push(["memory.audit.group_created", created.id]);
  let group = repository.updateAccessGroup(
    created.id,
    { expectedVersion: created.version, description: "updated" },
    audit(actor.id, actor.authorityEpoch, "memory.audit.group_updated"),
  );
  actions.push(["memory.audit.group_updated", group.id]);
  group = repository.replaceAccessGroupUsers(
    group.id,
    [actor.id],
    group.version,
    audit(actor.id, actor.authorityEpoch, "memory.audit.users_replaced"),
  );
  actions.push(["memory.audit.users_replaced", group.id]);
  group = repository.replaceAccessGroupModels(
    group.id,
    [],
    group.version,
    [],
    audit(actor.id, actor.authorityEpoch, "memory.audit.models_replaced"),
  );
  actions.push(["memory.audit.models_replaced", group.id]);
  group = repository.replaceAccessGroupPolicy(group.id, {
    expectedVersion: group.version,
    userIds: [actor.id],
    modelIds: [],
    tokenIds: [token.id],
    acknowledgePublicModelIds: [],
  }, audit(actor.id, actor.authorityEpoch, "memory.audit.policy_replaced"));
  actions.push(["memory.audit.policy_replaced", group.id]);
  let current = tokenById(repository, actor.id, token.id);
  current = repository.setTokenAccessGroups(
    actor.id,
    token.id,
    [group.id],
    current.version,
    audit(actor.id, actor.authorityEpoch, "memory.audit.token_groups", "api_token"),
  );
  actions.push(["memory.audit.token_groups", token.id]);
  repository.setTokenAccessMode(
    actor.id,
    token.id,
    "restricted",
    current.version,
    audit(actor.id, actor.authorityEpoch, "memory.audit.token_mode", "api_token"),
  );
  actions.push(["memory.audit.token_mode", token.id]);
  repository.deleteAccessGroup(
    group.id,
    group.version,
    [],
    audit(actor.id, actor.authorityEpoch, "memory.audit.group_deleted"),
  );
  actions.push(["memory.audit.group_deleted", group.id]);

  for (const [action, expectedTargetId] of actions) {
    const events = repository.listAudit({ action }).data;
    assertEquals(events.length, 1);
    assertEquals(events[0].targetId, expectedTargetId);
  }
  assertEquals(repository.listAudit({ targetId: SPOOFED_TARGET }).data, []);
});
