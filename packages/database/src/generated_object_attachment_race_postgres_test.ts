import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for generated attachment admission lock");
}

function applicationUrl(name: string): string {
  const url = new URL(databaseUrl!);
  url.searchParams.set("application_name", name);
  return url.toString();
}

Deno.test({
  name: "generated object attachment waits for cleanup fence and rejects a tombstoned object",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const suffix = crypto.randomUUID();
    const applicationName = `generated-attach-race-${suffix}`;
    const repo = await PostgresRepository.connect(applicationUrl(applicationName));
    const control = postgres(databaseUrl!, { max: 2 });
    const cleanup = postgres(databaseUrl!, { max: 1 });
    const owner = await repo.createUser({
      email: `generated-attach-race-${suffix}@example.com`,
      name: "Generated attachment race",
      approvalStatus: "approved",
    });
    const attachmentId = crypto.randomUUID();
    const usageRunId = `generated-attach-race-${suffix}`;
    const objectKey = `generated/${owner.id}/race-${suffix}.png`;
    try {
      await control`INSERT INTO usage_runs(
        id,user_id,model,provider,recovery_owner,status
      ) VALUES(
        ${usageRunId},${owner.id},'race/image','race','provider','completed'
      )`;
      await control`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,ingestion_status
      ) VALUES(
        ${attachmentId},${owner.id},${objectKey},'race.png','image/png',68,
        ${"a".repeat(64)},'ready','not_applicable'
      )`;
      const stage = await repo.stageGeneratedObject({
        ownerId: owner.id,
        usageRunId,
        purpose: "output",
        ordinal: 0,
        objectKey,
        mimeType: "image/png",
        sizeBytes: 68,
        sha256: "a".repeat(64),
      });
      await repo.markGeneratedObjectStored(stage.id, owner.id);

      let releaseCleanup!: () => void;
      let cleanupLocked!: () => void;
      const cleanupGate = new Promise<void>((resolve) => releaseCleanup = resolve);
      const cleanupHasLock = new Promise<void>((resolve) => cleanupLocked = resolve);
      const cleanupFence = cleanup.begin(async (tx) => {
        await tx`SELECT id FROM attachments WHERE id=${attachmentId} FOR UPDATE`;
        cleanupLocked();
        await cleanupGate;
        await tx`UPDATE attachments SET state='deleted',deleted_at=now(),updated_at=now()
          WHERE id=${attachmentId}`;
      });
      await cleanupHasLock;

      const attach = repo.attachGeneratedObject(stage.id, owner.id, attachmentId);
      await eventually(async () =>
        Boolean(
          (await control<{ waiting: boolean }[]>`SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity WHERE application_name=${applicationName}
              AND wait_event_type='Lock'
          ) waiting`)[0]?.waiting,
        )
      );
      releaseCleanup();
      await cleanupFence;

      await assertRejects(
        () => attach,
        DomainError,
        "Generated object attachment is not ready",
      );
      assertEquals(
        [
          ...await control`SELECT state,attachment_id FROM generated_object_staging
            WHERE id=${stage.id}`,
        ],
        [{ state: "stored", attachment_id: null }],
      );
      assertEquals(
        [
          ...await control`SELECT state,deleted_at IS NOT NULL AS deleted FROM attachments
            WHERE id=${attachmentId}`,
        ],
        [{ state: "deleted", deleted: true }],
      );
    } finally {
      await cleanup.end();
      await control.end();
      await repo.close();
    }
  },
});

Deno.test({
  name:
    "generated object attachment rejects a mismatched staged identity without publishing a cleanup reference",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const suffix = crypto.randomUUID();
    const repo = await PostgresRepository.connect(databaseUrl!);
    const control = postgres(databaseUrl!, { max: 1 });
    const owner = await repo.createUser({
      email: `generated-attach-identity-${suffix}@example.com`,
      name: "Generated attachment identity",
      approvalStatus: "approved",
    });
    const usageRunId = `generated-attach-identity-${suffix}`;
    const stagedAttachmentId = crypto.randomUUID();
    const unrelatedAttachmentId = crypto.randomUUID();
    const nonphysicalAttachmentId = crypto.randomUUID();
    const stagedObjectKey = `generated/${owner.id}/staged-${suffix}.png`;
    const unrelatedObjectKey = `generated/${owner.id}/unrelated-${suffix}.png`;
    const nonphysicalObjectKey = `imports/${owner.id}/${nonphysicalAttachmentId}/manifest-only`;
    try {
      await control`INSERT INTO usage_runs(
        id,user_id,model,provider,recovery_owner,status
      ) VALUES(
        ${usageRunId},${owner.id},'identity/image','identity','provider','completed'
      )`;
      await control`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,ingestion_status,
        physical_object
      ) VALUES
        (${stagedAttachmentId},${owner.id},${stagedObjectKey},'staged.png','image/png',68,
          ${"d".repeat(64)},'ready','not_applicable',true),
        (${unrelatedAttachmentId},${owner.id},${unrelatedObjectKey},'unrelated.png',
          'image/png',69,${"e".repeat(64)},'ready','not_applicable',true),
        (${nonphysicalAttachmentId},${owner.id},${nonphysicalObjectKey},'manifest.png',
          'image/png',70,${"f".repeat(64)},'ready','not_applicable',false)`;
      const stage = await repo.stageGeneratedObject({
        ownerId: owner.id,
        usageRunId,
        purpose: "output",
        ordinal: 0,
        objectKey: stagedObjectKey,
        mimeType: "image/png",
        sizeBytes: 68,
        sha256: "d".repeat(64),
      });
      await repo.markGeneratedObjectStored(stage.id, owner.id);

      await assertRejects(
        () => repo.attachGeneratedObject(stage.id, owner.id, unrelatedAttachmentId),
        DomainError,
        "Generated object stage changed",
      );
      assertEquals(
        [
          ...await control`SELECT state,attachment_id FROM generated_object_staging
            WHERE id=${stage.id}`,
        ],
        [{ state: "stored", attachment_id: null }],
      );
      assertEquals(
        [
          ...await control`SELECT id,state,deleted_at IS NOT NULL AS deleted
            FROM attachments WHERE id IN(${stagedAttachmentId},${unrelatedAttachmentId})
            ORDER BY id`,
        ],
        [
          {
            id: [stagedAttachmentId, unrelatedAttachmentId].sort()[0],
            state: "ready",
            deleted: false,
          },
          {
            id: [stagedAttachmentId, unrelatedAttachmentId].sort()[1],
            state: "ready",
            deleted: false,
          },
        ],
      );

      const nonphysicalStage = await repo.stageGeneratedObject({
        ownerId: owner.id,
        usageRunId,
        purpose: "output",
        ordinal: 1,
        objectKey: nonphysicalObjectKey,
        mimeType: "image/png",
        sizeBytes: 70,
        sha256: "f".repeat(64),
      });
      await repo.markGeneratedObjectStored(nonphysicalStage.id, owner.id);
      await assertRejects(
        () => repo.attachGeneratedObject(nonphysicalStage.id, owner.id, nonphysicalAttachmentId),
        DomainError,
        "differs from the staged object",
      );
      assertEquals(
        [
          ...await control`SELECT state,attachment_id FROM generated_object_staging
            WHERE id=${nonphysicalStage.id}`,
        ],
        [{ state: "stored", attachment_id: null }],
      );

      assertEquals(
        await repo.requestGeneratedObjectCleanup(owner.id, usageRunId, "identity mismatch"),
        2,
      );
      assertEquals(
        [
          ...await control`SELECT state,attachment_id FROM generated_object_staging
            WHERE id=${stage.id}`,
        ],
        [{ state: "cleanup_pending", attachment_id: null }],
      );
      assertEquals(
        [
          ...await control`SELECT state,deleted_at IS NOT NULL AS deleted
            FROM attachments WHERE id=${unrelatedAttachmentId}`,
        ],
        [{ state: "ready", deleted: false }],
      );
    } finally {
      await control.end();
      await repo.close();
    }
  },
});

Deno.test({
  name:
    "generated attachment admission rolls back attachment and storage accounting on attach failure",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const suffix = crypto.randomUUID();
    const repo = await PostgresRepository.connect(databaseUrl!);
    const control = postgres(databaseUrl!, { max: 1 });
    const owner = await repo.createUser({
      email: `generated-atomic-rollback-${suffix}@example.com`,
      name: "Generated atomic rollback",
      approvalStatus: "approved",
    });
    const usageRunId = `generated-atomic-rollback-${suffix}`;
    const objectKey = `generated/${owner.id}/atomic-rollback-${suffix}.png`;
    try {
      await control`INSERT INTO usage_runs(
        id,user_id,model,provider,recovery_owner,status
      ) VALUES(
        ${usageRunId},${owner.id},'atomic/image','atomic','provider','completed'
      )`;
      const stage = await repo.stageGeneratedObject({
        ownerId: owner.id,
        usageRunId,
        purpose: "output",
        ordinal: 0,
        objectKey,
        mimeType: "image/png",
        sizeBytes: 68,
        sha256: "7".repeat(64),
      });
      await repo.markGeneratedObjectStored(stage.id, owner.id);

      await assertRejects(
        () =>
          repo.createAttachmentFromGeneratedObjectStage(stage.id, owner.id, {
            ownerId: owner.id,
            objectKey,
            filename: "must-rollback.png",
            mimeType: "image/png",
            sizeBytes: 68,
            sha256: "7".repeat(64),
            state: "pending",
            inspectionComplete: true,
          }),
        DomainError,
        "Generated object attachment is not ready",
      );
      assertEquals(
        [...await control`SELECT id FROM attachments WHERE object_key=${objectKey}`],
        [],
      );
      assertEquals(
        [
          ...await control`SELECT owner_id FROM attachment_storage_blobs
          WHERE owner_id=${owner.id} AND object_key=${objectKey}`,
        ],
        [],
      );
      assertEquals(
        [
          ...await control`SELECT state,attachment_id FROM generated_object_staging
          WHERE id=${stage.id}`,
        ],
        [{ state: "stored", attachment_id: null }],
      );
      assertEquals(
        [
          ...await control`SELECT physical_bytes::int,physical_objects::int
          FROM attachment_storage_usage WHERE owner_id=${owner.id}`,
        ],
        [],
      );
    } finally {
      await control.end();
      await repo.close();
    }
  },
});
