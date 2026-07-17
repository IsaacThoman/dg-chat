import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AuditEventInput, PrivilegedAuditEventInput } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

class FailingModelAccessAuditRepository extends MemoryRepository {
  failAction: string | null = null;

  override recordAudit(input: AuditEventInput) {
    if (input.action === this.failAction) throw new Error("injected model access audit failure");
    return super.recordAudit(input);
  }
}

Deno.test("memory model-access widening, authority validation, and audit append are atomic", () => {
  const repository = new FailingModelAccessAuditRepository();
  const actor = repository.createUser({
    email: "model-access-admin@example.test",
    name: "Model access administrator",
    role: "admin",
    approvalStatus: "approved",
  });
  const readContext = {
    actorId: actor.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: actor.authorityEpoch,
  };
  const nonAdmin = repository.createUser({
    email: "model-access-user@example.test",
    name: "Model access user",
    approvalStatus: "approved",
  });
  const now = new Date().toISOString();
  const modelId = crypto.randomUUID();
  repository.providerModels.set(modelId, {
    id: modelId,
    providerId: crypto.randomUUID(),
    publicModelId: "atomic/private-model",
    upstreamModelId: "private-model",
    displayName: "Atomic private model",
    capabilities: ["chat"],
    contextWindow: 4_096,
    enabled: true,
    version: 1,
    customParams: {},
    createdAt: now,
    updatedAt: now,
  });
  const token = repository.createApiToken(actor.id, {
    name: "atomic policy token",
    scopes: ["models:read"],
    tokenHash: "atomic-model-policy-token",
    preview: "dg_atomic",
  }, actor.authorityEpoch);
  const group = repository.createAccessGroup({ name: "Atomic model restriction" }, {
    actorId: actor.id,
    action: "test.model_access_group.created",
    targetType: "model_access_group",
    requireEmailVerification: false,
    expectedAuthorityEpoch: actor.authorityEpoch,
  });
  const withUser = repository.replaceAccessGroupUsers(group.id, [actor.id], group.version, {
    actorId: actor.id,
    action: "model_access_group.users_replaced",
    targetType: "model_access_group",
    targetId: group.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: actor.authorityEpoch,
  });
  const restricted = repository.replaceAccessGroupModels(
    group.id,
    [modelId],
    withUser.version,
    [],
    {
      actorId: actor.id,
      action: "model_access_group.models_replaced",
      targetType: "model_access_group",
      targetId: group.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: actor.authorityEpoch,
    },
  );
  const baselineAuditCount = repository.auditEvents.length;
  const missingAudit = undefined as unknown as PrivilegedAuditEventInput;
  for (
    const operation of [
      () =>
        repository.deleteAccessGroup(
          group.id,
          restricted.version,
          [modelId],
          missingAudit,
        ),
      () =>
        repository.replaceAccessGroupUsers(
          group.id,
          [actor.id],
          restricted.version,
          missingAudit,
        ),
      () =>
        repository.replaceAccessGroupModels(
          group.id,
          [],
          restricted.version,
          [modelId],
          missingAudit,
        ),
      () =>
        repository.replaceAccessGroupPolicy(group.id, {
          expectedVersion: restricted.version,
          userIds: [actor.id],
          modelIds: [],
          tokenIds: [],
          acknowledgePublicModelIds: [modelId],
        }, missingAudit),
    ]
  ) {
    const error = assertThrows(operation, DomainError);
    assertEquals(error.code, "admin_authority_required");
  }
  assertEquals(repository.listAccessGroups(readContext)[0], restricted);
  assertEquals(repository.auditEvents.length, baselineAuditCount);
  const validAudit = {
    actorId: actor.id,
    action: "model_access_group.users_replaced",
    targetType: "model_access_group",
    targetId: group.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: actor.authorityEpoch,
  };
  for (
    const malformedAudit of [
      { ...validAudit, expectedAuthorityEpoch: undefined },
      { ...validAudit, requireEmailVerification: undefined },
      { ...validAudit, action: "" },
      { ...validAudit, targetType: "" },
      { ...validAudit, actorId: "" },
    ]
  ) {
    const error = assertThrows(
      () =>
        repository.replaceAccessGroupUsers(
          group.id,
          [actor.id],
          restricted.version,
          malformedAudit as unknown as PrivilegedAuditEventInput,
        ),
      DomainError,
    );
    assertEquals(error.code, "admin_authority_required");
  }
  assertEquals(repository.listAccessGroups(readContext)[0], restricted);
  assertEquals(repository.auditEvents.length, baselineAuditCount);

  repository.failAction = "model_access_group.users_replaced";
  assertThrows(
    () =>
      repository.replaceAccessGroupUsers(group.id, [nonAdmin.id], restricted.version, {
        actorId: actor.id,
        action: "model_access_group.users_replaced",
        targetType: "model_access_group",
        targetId: group.id,
        metadata: { userCount: 1 },
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      }),
    Error,
    "injected model access audit failure",
  );
  assertEquals(repository.listAccessGroups(readContext)[0], restricted);

  repository.failAction = null;
  assertThrows(
    () =>
      repository.deleteAccessGroup(group.id, restricted.version, [modelId], {
        actorId: nonAdmin.id,
        action: "model_access_group.deleted",
        targetType: "model_access_group",
        targetId: group.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      }),
    Error,
    "Administrator authority changed",
  );
  assertEquals(repository.listAccessGroups(readContext)[0], restricted);

  repository.failAction = "model_access_group.policy_replaced";
  assertThrows(
    () =>
      repository.replaceAccessGroupPolicy(group.id, {
        expectedVersion: restricted.version,
        userIds: [actor.id],
        modelIds: [],
        tokenIds: [token.id],
        acknowledgePublicModelIds: [modelId],
      }, {
        actorId: actor.id,
        action: "model_access_group.policy_replaced",
        targetType: "model_access_group",
        targetId: group.id,
        metadata: { modelCount: 0 },
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      }),
    Error,
    "injected model access audit failure",
  );
  assertEquals(repository.listAccessGroups(readContext)[0], restricted);
  assertEquals(repository.listApiTokens(actor.id)[0].version, token.version);
  assertEquals(repository.listApiTokens(actor.id)[0].accessMode, token.accessMode);

  repository.failAction = "model_access_group.models_replaced";
  assertThrows(
    () =>
      repository.replaceAccessGroupModels(group.id, [], restricted.version, [modelId], {
        actorId: actor.id,
        action: "model_access_group.models_replaced",
        targetType: "model_access_group",
        targetId: group.id,
        metadata: { modelCount: 0 },
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      }),
    Error,
    "injected model access audit failure",
  );
  assertEquals(repository.listAccessGroups(readContext)[0], restricted);

  repository.failAction = "model_access_group.deleted";
  assertThrows(
    () =>
      repository.deleteAccessGroup(group.id, restricted.version, [modelId], {
        actorId: actor.id,
        action: "model_access_group.deleted",
        targetType: "model_access_group",
        targetId: group.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: actor.authorityEpoch,
      }),
    Error,
    "injected model access audit failure",
  );
  assertEquals(repository.listAccessGroups(readContext)[0], restricted);
  assertEquals(repository.auditEvents.length, baselineAuditCount);
  assertEquals(
    repository.auditEvents
      .filter((event) => event.action.startsWith("model_access_group."))
      .map((event) => event.action),
    [
      "model_access_group.users_replaced",
      "model_access_group.models_replaced",
    ],
  );
});

Deno.test("memory access-group mutations validate authority before target existence or version", () => {
  const repository = new MemoryRepository();
  const actor = repository.createUser({
    email: "stale-access-group-admin@example.test",
    name: "Stale access-group administrator",
    role: "admin",
    approvalStatus: "approved",
  });
  const group = repository.createAccessGroup({ name: "Authority-first group" }, {
    actorId: actor.id,
    action: "model_access_group.created",
    targetType: "model_access_group",
    requireEmailVerification: false,
    expectedAuthorityEpoch: actor.authorityEpoch,
  });
  const baselineAuditCount = repository.auditEvents.length;
  const admittedAuthorityEpoch = actor.authorityEpoch;
  repository.users.get(actor.id)!.authorityEpoch++;
  const staleAudit = (action: string) => ({
    actorId: actor.id,
    action,
    targetType: "model_access_group",
    targetId: group.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: admittedAuthorityEpoch,
  });

  const operations = [
    () =>
      repository.deleteAccessGroup(
        crypto.randomUUID(),
        999,
        [],
        staleAudit("model_access_group.deleted"),
      ),
    () =>
      repository.replaceAccessGroupModels(
        crypto.randomUUID(),
        [],
        999,
        [],
        staleAudit("model_access_group.models_replaced"),
      ),
    () =>
      repository.replaceAccessGroupPolicy(crypto.randomUUID(), {
        expectedVersion: 999,
        userIds: [],
        modelIds: [],
        tokenIds: [],
        acknowledgePublicModelIds: [],
      }, staleAudit("model_access_group.policy_replaced")),
    () =>
      repository.deleteAccessGroup(
        group.id,
        group.version + 1,
        [],
        staleAudit("model_access_group.deleted"),
      ),
    () =>
      repository.replaceAccessGroupModels(
        group.id,
        [],
        group.version + 1,
        [],
        staleAudit("model_access_group.models_replaced"),
      ),
    () =>
      repository.replaceAccessGroupPolicy(group.id, {
        expectedVersion: group.version + 1,
        userIds: [],
        modelIds: [],
        tokenIds: [],
        acknowledgePublicModelIds: [],
      }, staleAudit("model_access_group.policy_replaced")),
  ];

  for (const operation of operations) {
    const error = assertThrows(operation, DomainError);
    assertEquals(error.code, "admin_authority_required");
  }
  assertEquals(
    repository.listAccessGroups({
      actorId: actor.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: repository.users.get(actor.id)!.authorityEpoch,
    }),
    [group],
  );
  assertEquals(repository.auditEvents.length, baselineAuditCount);
});
