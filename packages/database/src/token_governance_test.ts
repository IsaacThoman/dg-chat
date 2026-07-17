import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

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
    approvalStatus: "approved",
  });
  const token = repo.createApiToken(user.id, {
    name: "automation",
    scopes: ["chat"],
    tokenHash: "old-hash",
    preview: "dg_old",
    rpmLimit: 60,
    burstLimit: 10,
  });
  const group = repo.createAccessGroup({ name: "restricted" });
  const member = repo.replaceAccessGroupUsers(group.id, [user.id], group.version);
  repo.setTokenAccessGroups(user.id, token.id, [group.id], token.version);
  const current = repo.listApiTokens(user.id)[0];
  const rotated = repo.rotateApiToken(user.id, token.id, {
    expectedVersion: current.version,
    tokenHash: "new-hash",
    preview: "dg_new",
    overlapSeconds: 60,
  });
  assertEquals(rotated.replacement.rpmLimit, 60);
  assertEquals(rotated.replacement.burstLimit, 10);
  assertEquals(
    repo.listAccessGroups()[0].tokenIds.sort(),
    [token.id, rotated.replacement.id].sort(),
  );
  assertEquals(repo.authenticateApiToken("old-hash")?.id, token.id);
  assertEquals(repo.authenticateApiToken("new-hash")?.id, rotated.replacement.id);
  const narrowed = repo.updateApiToken(user.id, rotated.replacement.id, {
    expectedVersion: rotated.replacement.version,
    scopes: [],
    rpmLimit: 1,
    burstLimit: 1,
  });
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
      }),
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
      }),
    DomainError,
    "3600",
  );
  repo.revokeApiTokenFamily(rotated.replacement.id, user.id, narrowed.version);
  assertEquals(repo.authenticateApiToken("old-hash"), undefined);
  assertEquals(repo.authenticateApiToken("new-hash"), undefined);
  assertEquals(member.userIds, [user.id]);
});

Deno.test("model aliases cannot bypass user and explicit token entitlements", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "entitled@example.com",
    name: "Entitled",
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
  const alias = repo.createModelAlias({ alias: "friendly", targetModelId: modelId });
  const group = repo.createAccessGroup({ name: "members" });
  const withUser = repo.replaceAccessGroupUsers(group.id, [user.id], group.version);
  repo.replaceAccessGroupModels(group.id, [modelId], withUser.version);
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
  });
  assertEquals(
    repo.resolveEntitledProviderModel({ userId: user.id, tokenId: apiToken.id }, alias.alias)?.model
      .id,
    modelId,
  );
  const second = repo.createAccessGroup({ name: "other restriction" });
  const secondMember = repo.replaceAccessGroupUsers(second.id, [user.id], second.version);
  repo.setTokenAccessGroups(user.id, apiToken.id, [second.id], apiToken.version);
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
  const g1 = repo.createAccessGroup({ name: "G1" }), g2 = repo.createAccessGroup({ name: "G2" });
  const p1 = repo.replaceAccessGroupPolicy(g1.id, {
    expectedVersion: g1.version,
    userIds: [user.id],
    modelIds: [model1],
    tokenIds: [],
  });
  repo.replaceAccessGroupPolicy(g2.id, {
    expectedVersion: g2.version,
    userIds: [user.id],
    modelIds: [model2],
    tokenIds: [],
  });
  const apiToken = repo.createApiToken(user.id, {
    name: "restricted",
    scopes: ["chat"],
    tokenHash: "closed-hash",
    preview: "closed",
  });
  repo.setTokenAccessGroups(user.id, apiToken.id, [g1.id], apiToken.version);
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
  });
  assertEquals(repo.listApiTokens(user.id)[0].accessMode, "restricted");
  assertEquals(
    repo.resolveEntitledProviderModel({ userId: user.id, tokenId: apiToken.id }, "group/two"),
    undefined,
  );
  const latest = repo.listApiTokens(user.id)[0];
  repo.setTokenAccessMode(user.id, apiToken.id, "inherit", latest.version);
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
    approvalStatus: "approved",
  });
  const token = repo.createApiToken(owner.id, {
    name: "t",
    scopes: [],
    tokenHash: "policy-hash",
    preview: "p",
  });
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
  const group = repo.createAccessGroup({ name: "Policy" });
  assertThrows(
    () =>
      repo.replaceAccessGroupPolicy(group.id, {
        expectedVersion: group.version,
        userIds: [],
        modelIds: [modelId],
        tokenIds: [token.id],
      }),
    DomainError,
    "owner",
  );
  assertEquals(repo.listAccessGroups()[0].version, group.version);
  const saved = repo.replaceAccessGroupPolicy(group.id, {
    expectedVersion: group.version,
    name: "Policy 2",
    userIds: [owner.id],
    modelIds: [modelId],
    tokenIds: [token.id],
  });
  assertEquals(saved.tokenIds, [token.id]);
  const rotated = repo.rotateApiToken(owner.id, token.id, {
    expectedVersion: repo.listApiTokens(owner.id).find((candidate) => candidate.id === token.id)!
      .version,
    tokenHash: "policy-hash-next",
    preview: "p2",
    overlapSeconds: 30,
  });
  assertEquals(
    repo.previewAccessGroupPolicyImpact(group.id, {
      userIds: [owner.id],
      modelIds: [modelId],
      tokenIds: [rotated.replacement.id],
    }).tokenIdsLosingGroupAccess,
    [],
  );
  assertEquals(repo.previewAccessGroupPolicyImpact(group.id, null), {
    modelIdsBecomingPublic: [modelId],
    tokenIdsLosingGroupAccess: [token.id, rotated.replacement.id],
    tokenIdsRevertingToOwnerInheritance: [],
  });
});
