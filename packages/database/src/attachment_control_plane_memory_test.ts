import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  ATTACHMENT_INSPECTION_REASON,
  attachmentReinspectionEligibility,
  type AuditEventInput,
} from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

function attachmentInput(ownerId: string, ordinal: number, sizeBytes = 40) {
  return {
    ownerId,
    objectKey: `attachments/${ownerId}/${ordinal}`,
    filename: `${ordinal}.txt`,
    mimeType: "text/plain",
    sizeBytes,
    sha256: ordinal.toString(16).padStart(64, "0"),
    state: "ready" as const,
    inspectionComplete: true,
  };
}

Deno.test("memory retained-blob quotas are cumulative and deduplication does not double count", () => {
  const repo = new MemoryRepository();
  const first = repo.createUser({ email: "storage-first@example.test", name: "First" });
  const second = repo.createUser({ email: "storage-second@example.test", name: "Second" });
  const quota = {
    perUserBytes: 70,
    perUserObjects: 2,
    installationBytes: 100,
    installationObjects: 3,
  };

  const created = repo.createAttachment(attachmentInput(first.id, 1, 60), quota).attachment;
  assertEquals(repo.attachmentStorageUsage(first.id), {
    ownerId: first.id,
    physicalBytes: 60,
    physicalObjects: 1,
  });
  assertEquals(
    repo.createAttachment(attachmentInput(first.id, 1, 60), quota).deduplicated,
    true,
  );
  repo.deleteAttachment(created.id, first.id);
  assertThrows(
    () => repo.createAttachment(attachmentInput(first.id, 2, 11), quota),
    DomainError,
    "storage quota",
  );
  repo.createAttachment(attachmentInput(second.id, 3, 40), quota);
  assertThrows(
    () => repo.createAttachment(attachmentInput(second.id, 4, 1), quota),
    DomainError,
    "storage quota",
  );
  const admin = repo.createUser({ email: "storage-summary-admin@example.test", name: "Admin" });
  Object.assign(repo.users.get(admin.id)!, {
    role: "admin",
    approvalStatus: "approved",
    state: "active",
  });
  assertThrows(
    () => repo.adminStorageSummary(first.id),
    DomainError,
    "Administrator authority",
  );
  assertEquals(repo.adminStorageSummary(admin.id), {
    physicalBytes: 100,
    physicalObjects: 2,
    attachmentRecords: 2,
    activeRecords: 1,
    deletedRecords: 1,
    quarantinedRecords: 0,
    ownersWithStorage: 2,
  });
});

Deno.test("memory retained-blob admission enforces owner and installation object counts", () => {
  const repo = new MemoryRepository();
  const first = repo.createUser({ email: "objects-first@example.test", name: "First" });
  const second = repo.createUser({ email: "objects-second@example.test", name: "Second" });
  const third = repo.createUser({ email: "objects-third@example.test", name: "Third" });
  const quota = {
    perUserBytes: 1_000,
    perUserObjects: 1,
    installationBytes: 10_000,
    installationObjects: 2,
  };
  repo.createAttachment(attachmentInput(first.id, 10, 1), quota);
  repo.createAttachment(attachmentInput(second.id, 20, 1), quota);
  assertThrows(
    () => repo.createAttachment(attachmentInput(first.id, 11, 1), quota),
    DomainError,
    "storage quota",
  );
  assertThrows(
    () => repo.createAttachment(attachmentInput(third.id, 30, 1), quota),
    DomainError,
    "storage quota",
  );
});

Deno.test("memory generated-orphan settlement is append-only, idempotent, and releases active quota", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "release-owner@example.test", name: "Release owner" });
  const created = repo.createAttachment(attachmentInput(owner.id, 50, 19)).attachment;
  const stageId = crypto.randomUUID();
  const now = new Date().toISOString();
  repo.generatedObjectStages.set(stageId, {
    id: stageId,
    ownerId: owner.id,
    usageRunId: "generated-release-run",
    ordinal: 0,
    purpose: "output",
    objectKey: created.objectKey,
    mimeType: created.mimeType,
    sizeBytes: created.sizeBytes,
    sha256: created.sha256,
    attachmentId: created.id,
    cleanupAttachment: true,
    state: "cleaning",
    cleanupError: "cleanup in progress",
    createdAt: now,
    updatedAt: now,
  });
  repo.deleteAttachment(created.id, owner.id);

  const settled = repo.settleGeneratedObjectCleanup(stageId, owner.id);
  assertEquals(settled.storageReleased, true);
  assertEquals(settled.stage.state, "cleaned");
  assertEquals(repo.attachmentStorageUsage(owner.id).physicalBytes, 0);
  assertEquals(repo.attachmentStorageUsage(owner.id).physicalObjects, 0);
  assertEquals(repo.attachmentStorageBlobs.size, 1);
  assertEquals(repo.attachmentStorageReleases.get(stageId)?.usageRunId, "generated-release-run");
  assertEquals(
    repo.auditEvents.find((event) => event.action === "attachment.storage_reclaimed")?.metadata,
    { sizeBytes: 19, stageId },
  );

  assertEquals(repo.settleGeneratedObjectCleanup(stageId, owner.id).storageReleased, false);
  assertEquals(repo.attachmentStorageUsage(owner.id).physicalBytes, 0);
  const reuse = assertThrows(
    () => repo.createAttachment(attachmentInput(owner.id, 50, 19)),
    DomainError,
    "already exists",
  );
  assertEquals(reuse.code, "object_key_taken");
});

Deno.test("memory generated-orphan settlement fences every durable reference class", () => {
  const setup = (ordinal: number) => {
    const repo = new MemoryRepository();
    const owner = repo.createUser({
      email: `release-fence-${ordinal}@example.test`,
      name: "Release fence",
    });
    const created = repo.createAttachment(attachmentInput(owner.id, ordinal, 7)).attachment;
    const stageId = crypto.randomUUID();
    const now = new Date().toISOString();
    repo.generatedObjectStages.set(stageId, {
      id: stageId,
      ownerId: owner.id,
      usageRunId: `generated-fence-${ordinal}`,
      ordinal: 0,
      purpose: "output",
      objectKey: created.objectKey,
      mimeType: created.mimeType,
      sizeBytes: created.sizeBytes,
      sha256: created.sha256,
      attachmentId: created.id,
      cleanupAttachment: true,
      state: "cleaning",
      cleanupError: null,
      createdAt: now,
      updatedAt: now,
    });
    repo.deleteAttachment(created.id, owner.id);
    return { repo, owner, created, stageId };
  };
  const fences: Array<(value: ReturnType<typeof setup>) => void> = [
    ({ repo, created }) => repo.messageAttachments.set(crypto.randomUUID(), new Set([created.id])),
    ({ repo, created }) =>
      repo.knowledgeAttachments.set(crypto.randomUUID(), new Set([created.id])),
    ({ repo, created }) =>
      repo.documentChunks.set(created.id, [{
        id: crypto.randomUUID(),
        attachmentId: created.id,
        ordinal: 0,
        content: "retained",
        metadata: {},
      }]),
    ({ repo, owner, created, stageId }) =>
      repo.generatedObjectStages.set(crypto.randomUUID(), {
        ...repo.generatedObjectStages.get(stageId)!,
        id: crypto.randomUUID(),
        ownerId: owner.id,
        attachmentId: created.id,
        state: "attached",
      }),
    ({ repo, owner, created }) =>
      repo.fileUploadStages.set(crypto.randomUUID(), {
        requestId: crypto.randomUUID(),
        ownerId: owner.id,
        objectKey: created.objectKey,
        filename: created.filename,
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes,
        sha256: created.sha256,
        purpose: "assistants",
        attachmentState: "ready",
        inspectionError: null,
        requiredInspectionMode: "local",
        inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
        state: "finalized",
        attachmentId: created.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
  ];
  fences.forEach((fence, index) => {
    const value = setup(60 + index);
    fence(value);
    assertThrows(
      () => value.repo.settleGeneratedObjectCleanup(value.stageId, value.owner.id),
      DomainError,
      "durable reference",
    );
    assertEquals(value.repo.attachmentStorageUsage(value.owner.id).physicalBytes, 7);
    assertEquals(value.repo.attachmentStorageReleases.size, 0);
  });
});

Deno.test("memory reinspection is versioned, audited, epoch-fenced, and filter cursors are bound", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "storage-owner@example.test", name: "Owner" });
  const admin = repo.createUser({ email: "storage-admin@example.test", name: "Admin" });
  Object.assign(repo.users.get(admin.id)!, {
    role: "admin",
    approvalStatus: "approved",
    state: "active",
  });
  const first = repo.createAttachment(attachmentInput(owner.id, 10), undefined).attachment;
  const second = repo.createAttachment({
    ...attachmentInput(owner.id, 11),
    state: "pending",
  }).attachment;
  repo.transitionAttachmentInspection({
    attachmentId: second.id,
    ownerId: owner.id,
    inspectionEpoch: second.inspectionEpoch,
    expectedState: "pending",
    nextState: "inspecting",
  });
  assertThrows(
    () =>
      repo.transitionAttachmentInspection({
        attachmentId: second.id,
        ownerId: owner.id,
        inspectionEpoch: second.inspectionEpoch,
        expectedState: "inspecting",
        nextState: "failed",
      }),
    DomainError,
    "transition is invalid",
  );
  repo.transitionAttachmentInspection({
    attachmentId: second.id,
    ownerId: owner.id,
    inspectionEpoch: second.inspectionEpoch,
    expectedState: "inspecting",
    nextState: "failed",
    inspectionError: "scanner unavailable after retry limit",
  });
  const priorEpoch = second.inspectionEpoch;
  const priorVersion = second.version;

  const result = repo.requestAttachmentReinspection({
    actorId: admin.id,
    attachmentId: second.id,
    expectedVersion: priorVersion,
    reason: "  Policy definition 2026-07 changed  ",
    requiredInspectionMode: "external",
    inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
  });
  assertEquals(result.attachment.inspectionEpoch, priorEpoch + 1);
  assertEquals(result.attachment.version, priorVersion + 1);
  assertEquals(result.attachment.state, "pending");
  assertEquals(result.attachment.requiredInspectionMode, "external");
  assertEquals(
    result.attachment.inspectionPolicyVersion,
    ATTACHMENT_INSPECTION_POLICY_VERSION,
  );
  assertEquals(
    repo.jobs.find((job) => job.id === result.inspectionJobId)?.idempotencyKey,
    `attachment.inspect:${second.id}:${priorEpoch + 1}`,
  );
  assertEquals(
    repo.jobs.find((job) => job.id === result.inspectionJobId)?.payload,
    {
      attachmentId: second.id,
      ownerId: owner.id,
      inspectionEpoch: priorEpoch + 1,
      requiredInspectionMode: "external",
      inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    },
  );
  assertThrows(
    () =>
      repo.transitionAttachmentInspection({
        attachmentId: second.id,
        ownerId: owner.id,
        inspectionEpoch: 1,
        expectedState: "pending",
        nextState: "inspecting",
      }),
    DomainError,
    "epoch",
  );
  repo.transitionAttachmentInspection({
    attachmentId: second.id,
    ownerId: owner.id,
    inspectionEpoch: 2,
    expectedState: "pending",
    nextState: "inspecting",
  });
  const ready = repo.transitionAttachmentInspection({
    attachmentId: second.id,
    ownerId: owner.id,
    inspectionEpoch: 2,
    expectedState: "inspecting",
    nextState: "ready",
  });
  assertEquals(ready.version, priorVersion + 3);
  const terminalAudits = repo.auditEvents.filter((event) =>
    event.action === "attachment.inspection.completed" && event.targetId === second.id
  );
  assertEquals(terminalAudits.length, 2);
  assertEquals(terminalAudits.map((event) => event.metadata?.outcome), ["failed", "ready"]);
  assertEquals(terminalAudits.map((event) => event.metadata?.inspectionEpoch), [1, 2]);
  assertThrows(
    () =>
      repo.transitionAttachmentInspection({
        attachmentId: second.id,
        ownerId: owner.id,
        inspectionEpoch: 2,
        expectedState: "inspecting",
        nextState: "ready",
      }),
    DomainError,
    "epoch or state changed",
  );
  assertEquals(
    repo.auditEvents.filter((event) =>
      event.action === "attachment.inspection.completed" && event.targetId === second.id
    ).length,
    2,
  );
  assertEquals(
    repo.auditEvents.find((event) =>
      event.action === "attachment.reinspection_requested" && event.targetId === second.id
    )?.metadata?.reason,
    "Policy definition 2026-07 changed",
  );

  const page = repo.listAdminAttachments(admin.id, { ownerId: owner.id, limit: 1 });
  assertThrows(
    () => repo.listAdminAttachments(owner.id, { ownerId: owner.id, limit: 1 }),
    DomainError,
    "Administrator authority",
  );
  assertEquals(page.data.length, 1);
  assertEquals(page.nextCursor !== null, true);
  assertThrows(
    () =>
      repo.listAdminAttachments(admin.id, {
        ownerId: owner.id,
        state: "quarantined",
        limit: 1,
        cursor: page.nextCursor!,
      }),
    DomainError,
    "cursor",
  );
  const next = repo.listAdminAttachments(admin.id, {
    ownerId: owner.id,
    limit: 1,
    cursor: page.nextCursor!,
  }).data[0];
  assertEquals(new Set([page.data[0].id, next.id]), new Set([first.id, second.id]));
});

Deno.test("memory reinspection rolls back its mutation and job when the audit append fails", () => {
  class AuditFailureRepository extends MemoryRepository {
    failAudit = false;
    override recordAudit(input: AuditEventInput) {
      if (this.failAudit && input.action === "attachment.reinspection_requested") {
        throw new Error("injected audit failure");
      }
      return super.recordAudit(input);
    }
  }
  const repo = new AuditFailureRepository();
  const owner = repo.createUser({ email: "storage-fault-owner@example.test", name: "Owner" });
  const admin = repo.createUser({ email: "storage-fault-admin@example.test", name: "Admin" });
  Object.assign(repo.users.get(admin.id)!, {
    role: "admin",
    approvalStatus: "approved",
    state: "active",
  });
  const original = repo.createAttachment(attachmentInput(owner.id, 20)).attachment;
  const jobsBefore = repo.jobs.length;
  const auditsBefore = repo.auditEvents.length;
  repo.failAudit = true;

  assertThrows(
    () =>
      repo.requestAttachmentReinspection({
        actorId: admin.id,
        attachmentId: original.id,
        expectedVersion: original.version,
        reason: "Exercise transaction rollback",
        requiredInspectionMode: "external",
        inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      }),
    Error,
    "injected audit failure",
  );

  assertEquals(repo.getAttachment(original.id, owner.id, true), original);
  assertEquals(repo.jobs.length, jobsBefore);
  assertEquals(repo.auditEvents.length, auditsBefore);
});

Deno.test("reinspection eligibility admits only worker-owned quarantines", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "reason-owner@example.test", name: "Reason owner" });
  const admin = repo.createUser({ email: "reason-admin@example.test", name: "Reason admin" });
  Object.assign(repo.users.get(admin.id)!, {
    role: "admin",
    approvalStatus: "approved",
    state: "active",
  });
  const synchronous = repo.createAttachment({
    ...attachmentInput(owner.id, 91),
    state: "quarantined",
    inspectionError: "image_guard_animation_rejected",
  }).attachment;
  assertEquals(attachmentReinspectionEligibility(synchronous), {
    eligible: false,
    blockedReason: "policy_quarantine",
  });
  const rejected = assertThrows(
    () =>
      repo.requestAttachmentReinspection({
        actorId: admin.id,
        attachmentId: synchronous.id,
        expectedVersion: synchronous.version,
        reason: "try bypassing synchronous policy",
        requiredInspectionMode: "external",
        inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      }),
    DomainError,
  );
  assertEquals(rejected.code, "attachment_state_conflict");

  const workerOwned = repo.createAttachment({
    ...attachmentInput(owner.id, 92),
    state: "quarantined",
    inspectionError: ATTACHMENT_INSPECTION_REASON.malwareDetected,
  }).attachment;
  assertEquals(attachmentReinspectionEligibility(workerOwned).eligible, true);
  assertEquals(
    repo.requestAttachmentReinspection({
      actorId: admin.id,
      attachmentId: workerOwned.id,
      expectedVersion: workerOwned.version,
      reason: "scanner signatures were corrected",
      requiredInspectionMode: "external",
      inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    }).attachment.state,
    "pending",
  );
});

Deno.test("memory upload staging enforces object identity and hides soft-deleted placeholders", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "stage-parity@example.test", name: "Stage parity" });
  const objectKey = `uploads/${owner.id}/aa/${crypto.randomUUID()}.txt`;
  const first = repo.stageAttachmentUpload({
    id: crypto.randomUUID(),
    ownerId: owner.id,
    objectKey,
    filename: "first.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    sha256: "d".repeat(64),
  }, 900);
  assertEquals(first.uploadLeaseToken.length > 0, true);
  assertThrows(
    () =>
      repo.stageAttachmentUpload({
        id: crypto.randomUUID(),
        ownerId: owner.id,
        objectKey,
        filename: "second.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "e".repeat(64),
      }, 900),
    DomainError,
    "object key",
  );
  first.state = "cleaned";
  repo.attachmentUploadStages.set(first.id, first);
  assertThrows(
    () =>
      repo.createAttachment({
        ...attachmentInput(owner.id, 998),
        objectKey,
      }),
    DomainError,
    "controlled by a browser upload stage",
  );
  repo.requestAttachmentUploadCleanup(
    first.id,
    owner.id,
    first.uploadLeaseToken,
    "late PUT may recreate the object",
  );
  const cleanupJob = repo.jobs.find((job) =>
    job.idempotencyKey === `attachment_object.cleanup:${first.id}`
  )!;
  cleanupJob.status = "completed";
  cleanupJob.completedAt = new Date().toISOString();
  repo.attachmentUploadStages.get(first.id)!.state = "cleaned";
  repo.requestAttachmentUploadCleanup(
    first.id,
    owner.id,
    first.uploadLeaseToken,
    "second late PUT must reactivate cleanup",
  );
  assertEquals(cleanupJob.status, "queued");
  assertEquals(cleanupJob.completedAt, null);

  const placeholder = repo.createAttachment(attachmentInput(owner.id, 999)).attachment;
  placeholder.state = "failed";
  placeholder.deletedAt = new Date().toISOString();
  assertEquals(repo.listAttachments(owner.id).some((value) => value.id === placeholder.id), false);
  assertEquals(
    repo.listAttachmentPage(owner.id, { limit: 100, order: "desc" }).data.some((value) =>
      value.id === placeholder.id
    ),
    false,
  );
  assertThrows(
    () => repo.getAttachment(placeholder.id, owner.id),
    DomainError,
    "not found",
  );
  assertEquals(repo.getAttachment(placeholder.id, owner.id, true).id, placeholder.id);
});

Deno.test("attachment inspection requirements are durable and copied into every job", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "policy-owner@example.test", name: "Policy owner" });
  const created = repo.createAttachment({
    ...attachmentInput(owner.id, 93),
    state: "pending",
    inspectionComplete: false,
    requiredInspectionMode: "external",
    inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
  });
  assertEquals(created.attachment.requiredInspectionMode, "external");
  assertEquals(created.attachment.inspectionPolicyVersion, ATTACHMENT_INSPECTION_POLICY_VERSION);
  assertEquals(
    attachmentReinspectionEligibility({
      state: "failed",
      inspectionError: ATTACHMENT_INSPECTION_REASON.externalScannerUnavailable,
      deletedAt: null,
    }).eligible,
    true,
  );
  assertEquals(
    repo.jobs.find((job) => job.id === created.inspectionJobId)?.payload,
    {
      attachmentId: created.attachment.id,
      ownerId: owner.id,
      inspectionEpoch: 1,
      requiredInspectionMode: "external",
      inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    },
  );
  assertThrows(
    () =>
      repo.createAttachment({
        ...attachmentInput(owner.id, 94),
        inspectionPolicyVersion: "unknown-policy" as typeof ATTACHMENT_INSPECTION_POLICY_VERSION,
      }),
    DomainError,
    "inspection policy",
  );
});
