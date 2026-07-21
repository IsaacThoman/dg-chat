import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import type { ObjectStore, PutObjectInput, StoredObject } from "@dg-chat/database";
import { PostgresRepository } from "@dg-chat/database";
import {
  parseAttachmentObjectCleanupPayload,
  processAttachmentObjectCleanup,
} from "./attachment-object-cleanup.ts";
import { type ClaimedJob, failOrRetryJob } from "./job-queue.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

class CleanupStore implements ObjectStore {
  readonly implementation = "custom" as const;
  readonly deletes: string[] = [];
  failNextDelete = false;
  deleteStarted?: () => void;
  deleteGate?: Promise<void>;
  afterDelete?: () => void | Promise<void>;
  put(_input: PutObjectInput): Promise<{ etag: string | null }> {
    throw new Error("not implemented");
  }
  get(_key: string): Promise<StoredObject | undefined> {
    return Promise.resolve(undefined);
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("injected object delete failure");
    }
    this.deleteStarted?.();
    await this.deleteGate;
    await this.afterDelete?.();
  }
  readiness(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close() {}
}

class BlockingCleanupStore extends CleanupStore {
  #release: (() => void) | undefined;
  readonly started: Promise<void>;
  #started!: () => void;
  constructor() {
    super();
    this.started = new Promise((resolve) => this.#started = resolve);
  }
  override async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.#started();
    await new Promise<void>((resolve) => this.#release = resolve);
  }
  release() {
    this.#release?.();
  }
}

async function claimCleanup(
  sql: ReturnType<typeof postgres>,
  stageId: string,
  workerId: string,
): Promise<ClaimedJob> {
  const token = `${workerId}:${crypto.randomUUID()}`;
  const rows = await sql<{
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    idempotency_key: string;
  }[]>`UPDATE jobs SET status='running',locked_at=now(),locked_by=${token},
      attempts=attempts+1
    WHERE idempotency_key=${`attachment_object.cleanup:${stageId}`}
      AND (
        (status='queued' AND available_at<=now()) OR
        (status='running' AND locked_at<=now()-interval '30 seconds')
      )
    RETURNING id,type,payload,attempts,idempotency_key`;
  if (!rows[0]) throw new Error("Cleanup job was not claimable");
  return {
    id: String(rows[0].id),
    type: rows[0].type,
    payload: rows[0].payload,
    attempts: Number(rows[0].attempts),
    claimToken: token,
    idempotencyKey: rows[0].idempotency_key,
    externalDeadlineMonotonicMs: performance.now() + 30_000,
  };
}

Deno.test("browser attachment cleanup payload is owner and stage bound", () => {
  const value = { stageId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
  assertEquals(parseAttachmentObjectCleanupPayload(value), value);
});

Deno.test({
  name: "browser attachment orphan cleanup retries deletion and preserves a late attachment",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const owner = await repository.createUser({
      email: `ordinary-cleanup-${crypto.randomUUID()}@example.com`,
      name: "Ordinary cleanup",
      approvalStatus: "approved",
    });
    const uploadId = crypto.randomUUID();
    const objectId = crypto.randomUUID();
    const objectKey = `uploads/${owner.id}/${objectId.slice(0, 2)}/${objectId}.txt`;
    const store = new CleanupStore();
    try {
      const uploadStage = await repository.stageAttachmentUpload({
        id: uploadId,
        ownerId: owner.id,
        objectKey,
        filename: "orphan.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "a".repeat(64),
      }, 900);
      await repository.markAttachmentUploadStored(
        uploadId,
        owner.id,
        uploadStage.uploadLeaseToken,
        900,
      );
      await sql`UPDATE attachment_upload_staging SET upload_lease_expires_at=now()
        WHERE id=${uploadId}`;
      await repository.requestAttachmentUploadCleanup(
        uploadId,
        owner.id,
        uploadStage.uploadLeaseToken,
        "injected finalization",
      );
      const first = await claimCleanup(sql, uploadId, "ordinary-cleanup-a");
      store.failNextDelete = true;
      await assertRejects(
        () => processAttachmentObjectCleanup(sql, store, first, 30),
        Error,
        "injected object delete failure",
      );
      assertEquals(
        [...await sql`SELECT state FROM attachment_upload_staging WHERE id=${uploadId}`],
        [{ state: "cleaning" }],
      );
      assertEquals(await failOrRetryJob(sql, first, "injected object delete failure"), true);
      await sql`UPDATE jobs SET available_at=now()
        WHERE idempotency_key=${`attachment_object.cleanup:${uploadId}`}`;
      const second = await claimCleanup(sql, uploadId, "ordinary-cleanup-b");
      assertEquals(await processAttachmentObjectCleanup(sql, store, second, 30), "deleted");
      assertEquals(store.deletes, [objectKey, objectKey]);
      assertEquals(
        [...await sql`SELECT state FROM attachment_upload_staging WHERE id=${uploadId}`],
        [{ state: "cleaned" }],
      );
      // A backend is allowed to ignore cancellation and commit the PUT after the first cleanup
      // completed. The original opaque lease token must be able to reopen that same stage and
      // reschedule deletion; otherwise the late object would become an untracked retained blob.
      await repository.requestAttachmentUploadCleanup(
        uploadId,
        owner.id,
        uploadStage.uploadLeaseToken,
        "late PUT completed after the first cleanup",
      );
      assertEquals(
        [
          ...await sql`SELECT s.state,j.status,j.attempts
            FROM attachment_upload_staging s
            JOIN jobs j ON j.idempotency_key=${`attachment_object.cleanup:${uploadId}`}
            WHERE s.id=${uploadId}`,
        ],
        [{ state: "cleanup_pending", status: "queued", attempts: 0 }],
      );
      await sql`UPDATE attachment_upload_staging SET upload_lease_expires_at=now(),
        updated_at=now() WHERE id=${uploadId}`;
      await sql`UPDATE jobs SET available_at=now()
        WHERE idempotency_key=${`attachment_object.cleanup:${uploadId}`}`;
      const lateWrite = await claimCleanup(sql, uploadId, "ordinary-cleanup-late-write");
      assertEquals(await processAttachmentObjectCleanup(sql, store, lateWrite, 30), "deleted");
      assertEquals(store.deletes.filter((key) => key === objectKey), [
        objectKey,
        objectKey,
        objectKey,
      ]);
      assertEquals(
        [...await sql`SELECT state FROM attachment_upload_staging WHERE id=${uploadId}`],
        [{ state: "cleaned" }],
      );

      const ambiguousUploadId = crypto.randomUUID();
      const ambiguousObjectId = crypto.randomUUID();
      const ambiguousKey = `uploads/${owner.id}/${
        ambiguousObjectId.slice(0, 2)
      }/${ambiguousObjectId}.txt`;
      const ambiguousStage = await repository.stageAttachmentUpload({
        id: ambiguousUploadId,
        ownerId: owner.id,
        objectKey: ambiguousKey,
        filename: "ambiguous.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "e".repeat(64),
      }, 900);
      await repository.markAttachmentUploadStored(
        ambiguousUploadId,
        owner.id,
        ambiguousStage.uploadLeaseToken,
        900,
      );
      await sql`UPDATE attachment_upload_staging SET upload_lease_expires_at=now()
        WHERE id=${ambiguousUploadId}`;
      await repository.requestAttachmentUploadCleanup(
        ambiguousUploadId,
        owner.id,
        ambiguousStage.uploadLeaseToken,
        "ambiguous delete response",
      );
      const ambiguous = await claimCleanup(
        sql,
        ambiguousUploadId,
        "ordinary-cleanup-ambiguous-a",
      );
      store.afterDelete = () =>
        sql`UPDATE jobs SET locked_at=now()-interval '31 seconds' WHERE id=${ambiguous.id}`
          .then(() => undefined);
      await assertRejects(
        () => processAttachmentObjectCleanup(sql, store, ambiguous, 30),
        Error,
        "claim was reclaimed",
      );
      assertEquals(
        [...await sql`SELECT state FROM attachment_upload_staging WHERE id=${ambiguousUploadId}`],
        [{ state: "cleaning" }],
      );
      store.afterDelete = undefined;
      const replay = await claimCleanup(
        sql,
        ambiguousUploadId,
        "ordinary-cleanup-ambiguous-b",
      );
      assertEquals(await processAttachmentObjectCleanup(sql, store, replay, 30), "deleted");
      assertEquals(store.deletes.filter((key) => key === ambiguousKey).length, 2);
      assertEquals(
        [...await sql`SELECT state FROM attachment_upload_staging WHERE id=${ambiguousUploadId}`],
        [{ state: "cleaned" }],
      );
      assertEquals(
        [...await sql`SELECT status FROM jobs WHERE id=${ambiguous.id}`],
        [{ status: "completed" }],
      );

      const lateUploadId = crypto.randomUUID();
      const lateObjectId = crypto.randomUUID();
      const lateKey = `uploads/${owner.id}/${lateObjectId.slice(0, 2)}/${lateObjectId}.txt`;
      const lateStage = await repository.stageAttachmentUpload({
        id: lateUploadId,
        ownerId: owner.id,
        objectKey: lateKey,
        filename: "late.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "b".repeat(64),
      }, 900);
      await repository.markAttachmentUploadStored(
        lateUploadId,
        owner.id,
        lateStage.uploadLeaseToken,
        900,
      );
      const attachment = await repository.createAttachmentFromUploadStage(
        lateUploadId,
        owner.id,
        lateStage.uploadLeaseToken,
        {
          ownerId: owner.id,
          objectKey: lateKey,
          filename: "late.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
          sha256: "b".repeat(64),
          state: "ready",
          inspectionComplete: true,
        },
      );
      await repository.enqueueJob(
        "attachment_object.cleanup",
        { stageId: lateUploadId, ownerId: owner.id },
        new Date().toISOString(),
        `attachment_object.cleanup:${lateUploadId}`,
      );
      const late = await claimCleanup(sql, lateUploadId, "ordinary-cleanup-c");
      assertEquals(await processAttachmentObjectCleanup(sql, store, late, 30), "finalized");
      assertEquals(store.deletes.includes(lateKey), false);
      assertEquals(
        [
          ...await sql`SELECT state,attachment_id FROM attachment_upload_staging
          WHERE id=${lateUploadId}`,
        ],
        [{ state: "finalized", attachment_id: attachment.attachment.id }],
      );

      const racedUploadId = crypto.randomUUID();
      const racedObjectId = crypto.randomUUID();
      const racedKey = `uploads/${owner.id}/${racedObjectId.slice(0, 2)}/${racedObjectId}.txt`;
      const racedStage = await repository.stageAttachmentUpload({
        id: racedUploadId,
        ownerId: owner.id,
        objectKey: racedKey,
        filename: "raced.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "c".repeat(64),
      }, 900);
      await repository.markAttachmentUploadStored(
        racedUploadId,
        owner.id,
        racedStage.uploadLeaseToken,
        900,
      );
      await sql`UPDATE attachment_upload_staging SET upload_lease_expires_at=now()
        WHERE id=${racedUploadId}`;
      await repository.requestAttachmentUploadCleanup(
        racedUploadId,
        owner.id,
        racedStage.uploadLeaseToken,
        "stale upload",
      );
      const raced = await claimCleanup(sql, racedUploadId, "ordinary-cleanup-d");
      let releaseDelete!: () => void;
      let signalDelete!: () => void;
      store.deleteGate = new Promise<void>((resolve) => releaseDelete = resolve);
      const deleteStarted = new Promise<void>((resolve) => signalDelete = resolve);
      store.deleteStarted = signalDelete;
      const cleanup = processAttachmentObjectCleanup(sql, store, raced, 30);
      await deleteStarted;
      const create = assertRejects(
        () =>
          repository.createAttachmentFromUploadStage(
            racedUploadId,
            owner.id,
            racedStage.uploadLeaseToken,
            {
              ownerId: owner.id,
              objectKey: racedKey,
              filename: "raced.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
              sha256: "c".repeat(64),
              state: "ready",
              inspectionComplete: true,
            },
          ),
        Error,
        "stage differs",
      );
      const directCreate = assertRejects(
        () =>
          repository.createAttachment({
            ownerId: owner.id,
            objectKey: racedKey,
            filename: "raced.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            sha256: "c".repeat(64),
            state: "ready",
            inspectionComplete: true,
          }),
        Error,
        "controlled by a browser upload stage",
      );
      releaseDelete();
      assertEquals(await cleanup, "deleted");
      await create;
      await directCreate;
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM attachments WHERE object_key=${racedKey}`)[0].count,
        ),
        0,
      );
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "active browser upload lease defers stale cleanup without deleting object bytes",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const owner = await repository.createUser({
      email: `leased-cleanup-${crypto.randomUUID()}@example.com`,
      name: "Leased cleanup",
      approvalStatus: "approved",
    });
    const uploadId = crypto.randomUUID();
    const objectId = crypto.randomUUID();
    const objectKey = `uploads/${owner.id}/${objectId.slice(0, 2)}/${objectId}.txt`;
    const store = new CleanupStore();
    try {
      const stage = await repository.stageAttachmentUpload({
        id: uploadId,
        ownerId: owner.id,
        objectKey,
        filename: "slow-put.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "f".repeat(64),
      }, 900);
      await repository.requestAttachmentUploadCleanup(
        uploadId,
        owner.id,
        stage.uploadLeaseToken,
        "simulated lost PUT acknowledgement",
      );
      // Even a prematurely woken job must honor the database lease protecting the live PUT.
      await sql`UPDATE jobs SET available_at=now()
        WHERE idempotency_key=${`attachment_object.cleanup:${uploadId}`}`;
      const job = await claimCleanup(sql, uploadId, "ordinary-cleanup-active-lease");
      assertEquals(await processAttachmentObjectCleanup(sql, store, job, 30), "deferred");
      assertEquals(store.deletes, []);
      assertEquals(
        [
          ...await sql`SELECT state,upload_lease_expires_at>now() AS leased
          FROM attachment_upload_staging WHERE id=${uploadId}`,
        ],
        [{ state: "cleanup_pending", leased: true }],
      );
      assertEquals(
        [
          ...await sql`SELECT status,available_at>=(
            SELECT upload_lease_expires_at FROM attachment_upload_staging WHERE id=${uploadId}
          ) AS deferred_until_expiry FROM jobs WHERE id=${job.id}`,
        ],
        [{ status: "queued", deferred_until_expiry: true }],
      );
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "browser attachment cleanup releases SQL while deleting and cleaning fences late finalization",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!, { poolMax: 1 });
    const owner = await repository.createUser({
      email: `blocked-cleanup-${crypto.randomUUID()}@example.com`,
      name: "Blocked cleanup",
      approvalStatus: "approved",
    });
    const uploadId = crypto.randomUUID();
    const objectId = crypto.randomUUID();
    const objectKey = `uploads/${owner.id}/${objectId.slice(0, 2)}/${objectId}.txt`;
    const sha256 = "d".repeat(64);
    const store = new BlockingCleanupStore();
    try {
      const uploadStage = await repository.stageAttachmentUpload({
        id: uploadId,
        ownerId: owner.id,
        objectKey,
        filename: "blocked.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256,
      }, 900);
      await repository.markAttachmentUploadStored(
        uploadId,
        owner.id,
        uploadStage.uploadLeaseToken,
        900,
      );
      await sql`UPDATE attachment_upload_staging SET upload_lease_expires_at=now()
        WHERE id=${uploadId}`;
      await repository.requestAttachmentUploadCleanup(
        uploadId,
        owner.id,
        uploadStage.uploadLeaseToken,
        "cleanup test",
      );
      const job = await claimCleanup(sql, uploadId, "ordinary-cleanup-blocked");
      const cleanup = processAttachmentObjectCleanup(sql, store, job, 30);
      await store.started;

      // A one-connection pool remains immediately usable while object storage is blocked.
      assertEquals(Number((await sql`SELECT 1 AS ready`)[0].ready), 1);
      assertEquals(
        [...await sql`SELECT state FROM attachment_upload_staging WHERE id=${uploadId}`],
        [{ state: "cleaning" }],
      );
      await assertRejects(
        () =>
          repository.createAttachmentFromUploadStage(
            uploadId,
            owner.id,
            uploadStage.uploadLeaseToken,
            {
              ownerId: owner.id,
              objectKey,
              filename: "blocked.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
              sha256,
            },
          ),
        Error,
        "stage differs",
      );

      store.release();
      assertEquals(await cleanup, "deleted");
      assertEquals(store.deletes, [objectKey]);
      assertEquals(
        [...await sql`SELECT state FROM attachment_upload_staging WHERE id=${uploadId}`],
        [{ state: "cleaned" }],
      );
    } finally {
      store.release();
      await repository.close();
      await sql.end();
    }
  },
});
