import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AuditEventInput, PrivilegedAuditEventInput } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

class FailingModelAliasAuditRepository extends MemoryRepository {
  failAction: string | null = null;

  override recordAudit(input: AuditEventInput) {
    if (input.action === this.failAction) throw new Error("injected model-alias audit failure");
    return super.recordAudit(input);
  }
}

const audit = (
  actorId: string,
  action: "model_alias.created" | "model_alias.updated" | "model_alias.deleted",
  expectedAuthorityEpoch = 1,
): PrivilegedAuditEventInput => ({
  actorId,
  action,
  targetType: "model_alias",
  targetId: "caller-controlled-target-must-not-win",
  metadata: { source: "model-alias-atomicity-test" },
  requireEmailVerification: false,
  expectedAuthorityEpoch,
});

Deno.test("memory model-alias create, update, and delete are authority-fenced atomic audits", () => {
  const repository = new FailingModelAliasAuditRepository();
  const actor = repository.createUser({
    email: "model-alias-memory@example.test",
    name: "Model alias memory admin",
    role: "admin",
    approvalStatus: "approved",
  });
  const now = new Date().toISOString();
  const modelId = crypto.randomUUID();
  repository.providerModels.set(modelId, {
    id: modelId,
    providerId: crypto.randomUUID(),
    publicModelId: "canonical/model",
    upstreamModelId: "canonical-upstream",
    displayName: "Canonical model",
    capabilities: ["chat"],
    contextWindow: 4_096,
    enabled: true,
    version: 1,
    customParams: {},
    createdAt: now,
    updatedAt: now,
  });

  repository.failAction = "model_alias.created";
  assertThrows(
    () =>
      repository.createModelAlias(
        { alias: "must-not-exist", targetModelId: modelId },
        audit(actor.id, "model_alias.created"),
      ),
    Error,
    "injected model-alias audit failure",
  );
  assertEquals(repository.listModelAliases(), []);

  repository.failAction = null;
  const created = repository.createModelAlias(
    { alias: "durable/alias", targetModelId: modelId, description: "before" },
    audit(actor.id, "model_alias.created"),
  );
  assertEquals(
    repository.auditEvents.find((event) => event.action === "model_alias.created")?.targetId,
    created.id,
  );

  repository.failAction = "model_alias.updated";
  assertThrows(
    () =>
      repository.updateModelAlias(
        created.id,
        { expectedVersion: created.version, alias: "must-not-persist", description: "after" },
        audit(actor.id, "model_alias.updated"),
      ),
    Error,
    "injected model-alias audit failure",
  );
  assertEquals(repository.listModelAliases(), [created]);

  repository.failAction = "model_alias.deleted";
  assertThrows(
    () =>
      repository.deleteModelAlias(
        created.id,
        created.version,
        audit(actor.id, "model_alias.deleted"),
      ),
    Error,
    "injected model-alias audit failure",
  );
  assertEquals(repository.listModelAliases(), [created]);

  repository.failAction = null;
  repository.users.get(actor.id)!.authorityEpoch++;
  for (
    const operation of [
      () =>
        repository.createModelAlias(
          { alias: "stale-create", targetModelId: modelId },
          audit(actor.id, "model_alias.created"),
        ),
      () =>
        repository.updateModelAlias(
          created.id,
          { expectedVersion: created.version, alias: "stale-update" },
          audit(actor.id, "model_alias.updated"),
        ),
      () =>
        repository.deleteModelAlias(
          created.id,
          created.version,
          audit(actor.id, "model_alias.deleted"),
        ),
    ]
  ) {
    const error = assertThrows(operation, DomainError);
    assertEquals(error.code, "admin_authority_required");
  }
  assertEquals(repository.listModelAliases(), [created]);
  assertEquals(
    repository.auditEvents.filter((event) => event.action.startsWith("model_alias.")).map(
      (event) => event.action,
    ),
    ["model_alias.created"],
  );
});
