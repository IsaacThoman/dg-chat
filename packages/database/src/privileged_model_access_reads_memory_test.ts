import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { PrivilegedReadContext } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

Deno.test("memory model-access reads revalidate exact administrator authority before disclosure", () => {
  const repository = new MemoryRepository();
  const actor = repository.createUser({
    email: "privileged-read-memory@example.test",
    name: "Privileged read administrator",
    role: "admin",
    approvalStatus: "approved",
  });
  const admitted: PrivilegedReadContext = {
    actorId: actor.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: actor.authorityEpoch,
  };
  const group = repository.createAccessGroup({ name: "Sensitive group" }, {
    ...admitted,
    action: "test.model_access_group.created",
    targetType: "model_access_group",
  });
  repository.createApiToken(actor.id, {
    name: "Sensitive token",
    scopes: ["models:read"],
    tokenHash: "sensitive-memory-token-hash",
    preview: "dg_sensitive",
  }, actor.authorityEpoch);

  assertEquals(repository.listAccessGroups(admitted)[0].id, group.id);
  assertEquals(repository.searchApiTokens(admitted).data.length, 1);
  assertEquals(
    repository.previewAccessGroupPolicyImpact(admitted, group.id, null),
    {
      modelIdsBecomingPublic: [],
      tokenIdsLosingGroupAccess: [],
      tokenIdsRevertingToOwnerInheritance: [],
    },
  );

  for (
    const malformed of [
      { ...admitted, expectedAuthorityEpoch: undefined },
      { ...admitted, requireEmailVerification: undefined },
      { ...admitted, actorId: "" },
    ]
  ) {
    for (
      const read of [
        () => repository.listAccessGroups(malformed as unknown as PrivilegedReadContext),
        () => repository.searchApiTokens(malformed as unknown as PrivilegedReadContext),
        () =>
          repository.previewAccessGroupPolicyImpact(
            malformed as unknown as PrivilegedReadContext,
            group.id,
            null,
          ),
      ]
    ) {
      const error = assertThrows(read, DomainError);
      assertEquals(error.code, "admin_authority_required");
    }
  }

  repository.users.get(actor.id)!.authorityEpoch++;
  for (
    const read of [
      () => repository.listAccessGroups(admitted),
      () => repository.searchApiTokens(admitted),
      () => repository.previewAccessGroupPolicyImpact(admitted, crypto.randomUUID(), null),
    ]
  ) {
    const error = assertThrows(read, DomainError);
    assertEquals(error.code, "admin_authority_required");
  }

  const currentEpoch = repository.users.get(actor.id)!.authorityEpoch;
  repository.users.get(actor.id)!.emailVerifiedAt = null;
  const verificationRequired = {
    ...admitted,
    requireEmailVerification: true,
    expectedAuthorityEpoch: currentEpoch,
  };
  for (
    const read of [
      () => repository.listAccessGroups(verificationRequired),
      () => repository.searchApiTokens(verificationRequired),
      () => repository.previewAccessGroupPolicyImpact(verificationRequired, group.id, null),
    ]
  ) {
    const error = assertThrows(read, DomainError);
    assertEquals(error.code, "admin_authority_required");
  }
});
