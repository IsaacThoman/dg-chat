import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AuditEventInput } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

class FailingAccessGroupAuditRepository extends MemoryRepository {
  failAction: string | null = null;

  override recordAudit(input: AuditEventInput) {
    if (input.action === this.failAction) throw new Error("injected access-group audit failure");
    return super.recordAudit(input);
  }
}

const audit = (actorId: string, action: string) => ({
  actorId,
  action,
  targetType: "model_access_group",
  targetId: "caller-controlled-target-must-not-win",
  metadata: { source: "atomicity-test" },
  requireEmailVerification: false,
  expectedAuthorityEpoch: 1,
});

Deno.test("memory access-group create and metadata update require authority and atomic audit", () => {
  const repository = new FailingAccessGroupAuditRepository();
  const actor = repository.createUser({
    email: "access-group-atomicity@example.test",
    name: "Access group atomicity",
    role: "admin",
    approvalStatus: "approved",
  });

  repository.failAction = "model_access_group.created";
  assertThrows(
    () =>
      repository.createAccessGroup(
        { name: "Must roll back", description: "not durable" },
        audit(actor.id, "model_access_group.created"),
      ),
    Error,
    "injected access-group audit failure",
  );
  assertEquals(repository.listAccessGroups(audit(actor.id, "test.read")), []);

  repository.failAction = null;
  const created = repository.createAccessGroup(
    { name: "Durable", description: "before" },
    audit(actor.id, "model_access_group.created"),
  );
  const creationAudit = repository.auditEvents.find((event) =>
    event.action === "model_access_group.created"
  )!;
  assertEquals(creationAudit.actorId, actor.id);
  assertEquals(creationAudit.targetId, created.id);
  assertEquals(creationAudit.metadata, {
    source: "atomicity-test",
    after: {
      name: "Durable",
      description: "before",
      userIds: [],
      modelIds: [],
      tokenIds: [],
    },
  });

  const noOpError = assertThrows(
    () =>
      repository.updateAccessGroup(
        created.id,
        { expectedVersion: created.version },
        audit(actor.id, "model_access_group.updated"),
      ),
    DomainError,
  );
  assertEquals(noOpError.code, "validation_error");
  assertEquals(repository.listAccessGroups(audit(actor.id, "test.read")), [created]);

  repository.failAction = "model_access_group.updated";
  assertThrows(
    () =>
      repository.updateAccessGroup(
        created.id,
        {
          expectedVersion: created.version,
          name: "Must not persist",
          description: "must not persist",
        },
        audit(actor.id, "model_access_group.updated"),
      ),
    Error,
    "injected access-group audit failure",
  );
  assertEquals(repository.listAccessGroups(audit(actor.id, "test.read")), [created]);
  assertEquals(
    repository.auditEvents.some((event) => event.action === "model_access_group.updated"),
    false,
  );

  repository.failAction = null;
  const updated = repository.updateAccessGroup(
    created.id,
    {
      expectedVersion: created.version,
      name: "Renamed",
      description: "after",
    },
    audit(actor.id, "model_access_group.updated"),
  );
  const updateAudit = repository.auditEvents.find((event) =>
    event.action === "model_access_group.updated"
  )!;
  assertEquals(updateAudit.metadata, {
    source: "atomicity-test",
    before: { name: "Durable", description: "before" },
    after: { name: "Renamed", description: "after" },
  });

  repository.users.get(actor.id)!.role = "user";
  const authorityError = assertThrows(
    () =>
      repository.updateAccessGroup(
        created.id,
        { expectedVersion: updated.version, name: "Unauthorized" },
        audit(actor.id, "model_access_group.updated"),
      ),
    DomainError,
  );
  assertEquals(authorityError.code, "admin_authority_required");
  assertEquals(structuredClone([...repository.accessGroups.values()]), [updated]);

  const storedActor = repository.users.get(actor.id)!;
  storedActor.role = "admin";
  storedActor.authorityEpoch++;
  const staleEpochError = assertThrows(
    () =>
      repository.updateAccessGroup(
        created.id,
        { expectedVersion: updated.version, name: "Stale epoch" },
        audit(actor.id, "model_access_group.updated"),
      ),
    DomainError,
  );
  assertEquals(staleEpochError.code, "admin_authority_required");
  storedActor.passwordResetPending = true;
  const resetPendingError = assertThrows(
    () =>
      repository.updateAccessGroup(
        created.id,
        { expectedVersion: updated.version, name: "Reset pending" },
        {
          ...audit(actor.id, "model_access_group.updated"),
          expectedAuthorityEpoch: storedActor.authorityEpoch,
        },
      ),
    DomainError,
  );
  assertEquals(resetPendingError.code, "admin_authority_required");
  assertEquals(structuredClone([...repository.accessGroups.values()]), [updated]);
});
