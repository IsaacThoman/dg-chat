import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

const accessGroupAudit = (
  actorId: string,
  action = "test.model_access_group.created",
  targetId?: string,
) => ({
  actorId,
  action,
  targetType: "model_access_group",
  targetId,
  requireEmailVerification: false,
  expectedAuthorityEpoch: 1,
});

Deno.test("token lineage migration restricts destructive generation deletion", async () => {
  const migration = await Deno.readTextFile(
    new URL("../migrations/0027_token_governance.sql", import.meta.url),
  );
  assertEquals(
    migration.match(/api_tokens_(?:rotated_from|replaced_by)_fk[^;]+ON DELETE RESTRICT/g)?.length,
    2,
  );
  assertEquals(
    /api_tokens_(?:rotated_from|replaced_by)_fk[^;]+ON DELETE CASCADE/.test(migration),
    false,
  );
  assertEquals(migration.includes("access_mode text NOT NULL DEFAULT 'inherit'"), true);
  assertEquals(migration.includes("api_tokens_access_mode_check"), true);
});

Deno.test("token rotation is versioned, overlap bounded, restriction preserving, and family revoked", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "token@example.com",
    name: "Token owner",
    role: "admin",
    approvalStatus: "approved",
  });
  const token = repo.createApiToken(user.id, {
    name: "automation",
    scopes: ["chat"],
    tokenHash: "old-hash",
    preview: "dg_old",
    rpmLimit: 60,
    burstLimit: 10,
  }, user.authorityEpoch);
  const group = repo.createAccessGroup({ name: "restricted" }, accessGroupAudit(user.id));
  const member = repo.replaceAccessGroupUsers(
    group.id,
    [user.id],
    group.version,
    accessGroupAudit(user.id, "model_access_group.users_replaced", group.id),
  );
  repo.setTokenAccessGroups(user.id, token.id, [group.id], token.version, {
    actorId: user.id,
    action: "api_token.access_groups_set",
    targetType: "api_token",
    targetId: token.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  const current = repo.listApiTokens(user.id)[0];
  const rotated = repo.rotateApiToken(user.id, token.id, {
    expectedVersion: current.version,
    tokenHash: "new-hash",
    preview: "dg_new",
    overlapSeconds: 60,
  }, user.authorityEpoch);
  assertEquals(rotated.replacement.rpmLimit, 60);
  assertEquals(rotated.replacement.burstLimit, 10);
  assertEquals(
    repo.listAccessGroups(accessGroupAudit(user.id))[0].tokenIds.sort(),
    [token.id, rotated.replacement.id].sort(),
  );
  assertEquals(repo.authenticateApiToken("old-hash")?.id, token.id);
  assertEquals(repo.authenticateApiToken("new-hash")?.id, rotated.replacement.id);
  const narrowed = repo.updateApiToken(user.id, rotated.replacement.id, {
    expectedVersion: rotated.replacement.version,
    scopes: [],
    rpmLimit: 1,
    burstLimit: 1,
  }, user.authorityEpoch);
  assertEquals(repo.authenticateApiToken("old-hash")?.scopes, []);
  assertEquals(repo.authenticateApiToken("old-hash")?.rpmLimit, 1);
  assertThrows(
    () =>
      repo.rotateApiToken(user.id, token.id, {
        expectedVersion: repo.listApiTokens(user.id).find((candidate) =>
          candidate.id === token.id
        )!.version,
        tokenHash: "third",
        preview: "third",
        overlapSeconds: 0,
      }, user.authorityEpoch),
    DomainError,
    "current active",
  );
  assertThrows(
    () =>
      repo.rotateApiToken(user.id, rotated.replacement.id, {
        expectedVersion: rotated.replacement.version,
        tokenHash: "third",
        preview: "third",
        overlapSeconds: 3601,
      }, user.authorityEpoch),
    DomainError,
    "3600",
  );
  repo.revokeApiTokenFamily(
    rotated.replacement.id,
    user.id,
    narrowed.version,
    user.authorityEpoch,
  );
  assertEquals(repo.authenticateApiToken("old-hash"), undefined);
  assertEquals(repo.authenticateApiToken("new-hash"), undefined);
  assertEquals(member.userIds, [user.id]);
});

Deno.test("model aliases cannot bypass user and explicit token entitlements", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "entitled@example.com",
    name: "Entitled",
    role: "admin",
    approvalStatus: "approved",
  });
  const other = repo.createUser({ email: "other@example.com", name: "Other" });
  const now = new Date().toISOString();
  const modelId = crypto.randomUUID();
  repo.providerModels.set(modelId, {
    id: modelId,
    providerId: crypto.randomUUID(),
    publicModelId: "private/model",
    upstreamModelId: "m",
    displayName: "Private",
    capabilities: ["chat"],
    contextWindow: 1000,
    enabled: true,
    version: 1,
    customParams: {},
    createdAt: now,
    updatedAt: now,
  });
  const alias = repo.createModelAlias(
    { alias: "friendly", targetModelId: modelId },
    {
      actorId: user.id,
      action: "test.model_alias.created",
      targetType: "model_alias",
      requireEmailVerification: false,
      expectedAuthorityEpoch: user.authorityEpoch,
    },
  );
  const group = repo.createAccessGroup({ name: "members" }, accessGroupAudit(user.id));
  const withUser = repo.replaceAccessGroupUsers(
    group.id,
    [user.id],
    group.version,
    accessGroupAudit(user.id, "model_access_group.users_replaced", group.id),
  );
  repo.replaceAccessGroupModels(
    group.id,
    [modelId],
    withUser.version,
    [],
    accessGroupAudit(user.id, "model_access_group.models_replaced", group.id),
  );
  assertEquals(
    repo.resolveEntitledProviderModel({ userId: user.id }, alias.alias)?.model.id,
    modelId,
  );
  assertEquals(repo.resolveEntitledProviderModel({ userId: other.id }, alias.alias), undefined);
  const apiToken = repo.createApiToken(user.id, {
    name: "api",
    scopes: ["chat"],
    tokenHash: "entitled-hash",
    preview: "dg_ent",
  }, user.authorityEpoch);
  assertEquals(
    repo.resolveEntitledProviderModel({ userId: user.id, tokenId: apiToken.id }, alias.alias)?.model
      .id,
    modelId,
  );
  const second = repo.createAccessGroup(
    { name: "other restriction" },
    accessGroupAudit(user.id),
  );
  const secondMember = repo.replaceAccessGroupUsers(
    second.id,
    [user.id],
    second.version,
    accessGroupAudit(user.id, "model_access_group.users_replaced", second.id),
  );
  repo.setTokenAccessGroups(user.id, apiToken.id, [second.id], apiToken.version, {
    actorId: user.id,
    action: "api_token.access_groups_set",
    targetType: "api_token",
    targetId: apiToken.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  assertEquals(secondMember.userIds, [user.id]);
  assertEquals(
    repo.resolveEntitledProviderModel({ userId: user.id, tokenId: apiToken.id }, alias.alias),
    undefined,
  );
});

Deno.test("restricted access mode fails closed when its last group assignment disappears", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "closed@example.com",
    name: "Fail closed",
    role: "admin",
    approvalStatus: "approved",
  });
  const now = new Date().toISOString();
  const model1 = crypto.randomUUID(), model2 = crypto.randomUUID();
  for (const [id, publicModelId] of [[model1, "group/one"], [model2, "group/two"]]) {
    repo.providerModels.set(id, {
      id,
      providerId: crypto.randomUUID(),
      publicModelId,
      upstreamModelId: id,
      displayName: publicModelId,
      capabilities: ["chat"],
      contextWindow: 1000,
      enabled: true,
      version: 1,
      customParams: {},
      createdAt: now,
      updatedAt: now,
    });
  }
  const g1 = repo.createAccessGroup({ name: "G1" }, accessGroupAudit(user.id)),
    g2 = repo.createAccessGroup({ name: "G2" }, accessGroupAudit(user.id));
  const p1 = repo.replaceAccessGroupPolicy(g1.id, {
    expectedVersion: g1.version,
    userIds: [user.id],
    modelIds: [model1],
    tokenIds: [],
    acknowledgePublicModelIds: [],
  }, accessGroupAudit(user.id, "model_access_group.policy_replaced", g1.id));
  repo.replaceAccessGroupPolicy(g2.id, {
    expectedVersion: g2.version,
    userIds: [user.id],
    modelIds: [model2],
    tokenIds: [],
    acknowledgePublicModelIds: [],
  }, accessGroupAudit(user.id, "model_access_group.policy_replaced", g2.id));
  const apiToken = repo.createApiToken(user.id, {
    name: "restricted",
    scopes: ["chat"],
    tokenHash: "closed-hash",
    preview: "closed",
  }, user.authorityEpoch);
  repo.setTokenAccessGroups(user.id, apiToken.id, [g1.id], apiToken.version, {
    actorId: user.id,
    action: "api_token.access_groups_set",
    targetType: "api_token",
    targetId: apiToken.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  assertEquals(
    repo.resolveEntitledProviderModel({ userId: user.id, tokenId: apiToken.id }, "group/one")?.model
      .id,
    model1,
  );
  repo.replaceAccessGroupPolicy(g1.id, {
    expectedVersion: p1.version,
    userIds: [],
    modelIds: [],
    tokenIds: [],
    acknowledgePublicModelIds: [model1],
  }, accessGroupAudit(user.id, "model_access_group.policy_replaced", g1.id));
  assertEquals(repo.listApiTokens(user.id)[0].accessMode, "restricted");
  assertEquals(
    repo.resolveEntitledProviderModel({ userId: user.id, tokenId: apiToken.id }, "group/two"),
    undefined,
  );
  const latest = repo.listApiTokens(user.id)[0];
  repo.setTokenAccessMode(user.id, apiToken.id, "inherit", latest.version, {
    actorId: user.id,
    action: "api_token.access_mode_set",
    targetType: "api_token",
    targetId: apiToken.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  assertEquals(
    repo.resolveEntitledProviderModel({ userId: user.id, tokenId: apiToken.id }, "group/two")?.model
      .id,
    model2,
  );
});

Deno.test("atomic access group policy validates owners and previews widening", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "owner@example.com",
    name: "Owner",
    role: "admin",
    approvalStatus: "approved",
  });
  const token = repo.createApiToken(owner.id, {
    name: "t",
    scopes: [],
    tokenHash: "policy-hash",
    preview: "p",
  }, owner.authorityEpoch);
  const modelId = crypto.randomUUID(), now = new Date().toISOString();
  repo.providerModels.set(modelId, {
    id: modelId,
    providerId: crypto.randomUUID(),
    publicModelId: "policy/model",
    upstreamModelId: "p",
    displayName: "Policy",
    capabilities: ["chat"],
    contextWindow: 1,
    enabled: true,
    version: 1,
    customParams: {},
    createdAt: now,
    updatedAt: now,
  });
  const group = repo.createAccessGroup({ name: "Policy" }, accessGroupAudit(owner.id));
  assertThrows(
    () =>
      repo.replaceAccessGroupPolicy(group.id, {
        expectedVersion: group.version,
        userIds: [],
        modelIds: [modelId],
        tokenIds: [token.id],
        acknowledgePublicModelIds: [],
      }, accessGroupAudit(owner.id, "model_access_group.policy_replaced", group.id)),
    DomainError,
    "owner",
  );
  assertEquals(repo.listAccessGroups(accessGroupAudit(owner.id))[0].version, group.version);
  const saved = repo.replaceAccessGroupPolicy(group.id, {
    expectedVersion: group.version,
    name: "Policy 2",
    userIds: [owner.id],
    modelIds: [modelId],
    tokenIds: [token.id],
    acknowledgePublicModelIds: [],
  }, accessGroupAudit(owner.id, "model_access_group.policy_replaced", group.id));
  assertEquals(saved.tokenIds, [token.id]);
  const rotated = repo.rotateApiToken(owner.id, token.id, {
    expectedVersion: repo.listApiTokens(owner.id).find((candidate) => candidate.id === token.id)!
      .version,
    tokenHash: "policy-hash-next",
    preview: "p2",
    overlapSeconds: 30,
  }, owner.authorityEpoch);
  assertEquals(
    repo.previewAccessGroupPolicyImpact(accessGroupAudit(owner.id), group.id, {
      userIds: [owner.id],
      modelIds: [modelId],
      tokenIds: [rotated.replacement.id],
    }).tokenIdsLosingGroupAccess,
    [],
  );
  assertEquals(repo.previewAccessGroupPolicyImpact(accessGroupAudit(owner.id), group.id, null), {
    modelIdsBecomingPublic: [modelId],
    tokenIdsLosingGroupAccess: [token.id, rotated.replacement.id],
    tokenIdsRevertingToOwnerInheritance: [],
  });
});

Deno.test("memory access-group mutations require the exact locked widening acknowledgement", () => {
  const repo = new MemoryRepository();
  const actor = repo.createUser({
    email: "widening-ack@example.com",
    name: "Widening acknowledgement admin",
    role: "admin",
    approvalStatus: "approved",
  });
  const now = new Date().toISOString();
  const restrictedModelId = crypto.randomUUID();
  const unrelatedModelId = crypto.randomUUID();
  for (
    const [id, publicModelId] of [
      [restrictedModelId, "ack/restricted"],
      [unrelatedModelId, "ack/unrelated"],
    ]
  ) {
    repo.providerModels.set(id, {
      id,
      providerId: crypto.randomUUID(),
      publicModelId,
      upstreamModelId: id,
      displayName: publicModelId,
      capabilities: ["chat"],
      contextWindow: 1,
      enabled: true,
      version: 1,
      customParams: {},
      createdAt: now,
      updatedAt: now,
    });
  }
  const group = repo.createAccessGroup(
    { name: "Exact acknowledgement" },
    accessGroupAudit(actor.id),
  );
  let current = repo.replaceAccessGroupModels(
    group.id,
    [restrictedModelId],
    group.version,
    [],
    accessGroupAudit(actor.id, "model_access_group.models_replaced", group.id),
  );

  for (const acknowledgement of [[], [restrictedModelId, unrelatedModelId]]) {
    const error = assertThrows(
      () =>
        repo.replaceAccessGroupModels(
          group.id,
          [],
          current.version,
          acknowledgement,
          accessGroupAudit(actor.id, "model_access_group.models_replaced", group.id),
        ),
      DomainError,
    );
    assertEquals(error.code, "model_access_widening_acknowledgement_required");
    assertEquals(repo.listAccessGroups(accessGroupAudit(actor.id))[0], current);
  }

  current = repo.replaceAccessGroupModels(
    group.id,
    [],
    current.version,
    [restrictedModelId, restrictedModelId],
    accessGroupAudit(actor.id, "model_access_group.models_replaced", group.id),
  );
  current = repo.replaceAccessGroupModels(
    group.id,
    [restrictedModelId],
    current.version,
    [],
    accessGroupAudit(actor.id, "model_access_group.models_replaced", group.id),
  );
  const policyError = assertThrows(
    () =>
      repo.replaceAccessGroupPolicy(group.id, {
        expectedVersion: current.version,
        name: "Must not persist",
        userIds: [],
        modelIds: [],
        tokenIds: [],
        acknowledgePublicModelIds: [],
      }, accessGroupAudit(actor.id, "model_access_group.policy_replaced", group.id)),
    DomainError,
  );
  assertEquals(policyError.code, "model_access_widening_acknowledgement_required");
  assertEquals(repo.listAccessGroups(accessGroupAudit(actor.id))[0], current);

  const deleteError = assertThrows(
    () =>
      repo.deleteAccessGroup(
        group.id,
        current.version,
        [],
        accessGroupAudit(actor.id, "model_access_group.deleted", group.id),
      ),
    DomainError,
  );
  assertEquals(deleteError.code, "model_access_widening_acknowledgement_required");
  assertEquals(repo.listAccessGroups(accessGroupAudit(actor.id))[0], current);
  repo.deleteAccessGroup(
    group.id,
    current.version,
    [restrictedModelId],
    accessGroupAudit(actor.id, "model_access_group.deleted", group.id),
  );
  assertEquals(repo.listAccessGroups(accessGroupAudit(actor.id)), []);
});
