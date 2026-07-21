import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import type { ObjectStore, PutObjectInput, StoredObject } from "@dg-chat/database";
import { ATTACHMENT_INSPECTION_POLICY_VERSION, PostgresRepository } from "@dg-chat/database";
import { runAuditTestMaintenanceSql } from "../../../packages/database/src/postgres-test-maintenance.ts";
import type { ClaimedJob } from "./job-queue.ts";
import { parseFileObjectCleanupPayload, processFileObjectCleanup } from "./file-object-cleanup.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

class CleanupStore implements ObjectStore {
  readonly implementation = "custom" as const;
  readonly objects = new Set<string>();
  readonly deletes: string[] = [];
  failNextDelete = false;
  put(_input: PutObjectInput): Promise<{ etag: string | null }> {
    throw new Error("not implemented");
  }
  get(_key: string): Promise<StoredObject | undefined> {
    return Promise.resolve(undefined);
  }
  delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failNextDelete) {
      this.failNextDelete = false;
      return Promise.reject(new Error("injected object delete failure"));
    }
    this.objects.delete(key);
    return Promise.resolve();
  }
  readiness(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close() {}
}

Deno.test("file cleanup payload binds the owner to a content-addressed upload key", () => {
  const ownerId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const objectKey = `uploads/${ownerId}/blobs/aa/${"a".repeat(64)}.txt`;
  assertEquals(parseFileObjectCleanupPayload({ requestId, ownerId, objectKey }), {
    requestId,
    ownerId,
    objectKey,
  });
  for (
    const hostile of [
      `uploads/${crypto.randomUUID()}/blobs/aa/${"a".repeat(64)}.txt`,
      `uploads/${ownerId}/../${"a".repeat(64)}.txt`,
      `uploads/${ownerId}/blobs/aa/not-a-digest.txt`,
      `uploads/${ownerId}/blobs/ff/${"a".repeat(64)}.txt`,
    ]
  ) {
    let rejected = false;
    try {
      parseFileObjectCleanupPayload({ requestId, ownerId, objectKey: hostile });
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  }
});

Deno.test({
  name: "file cleanup is retry-safe and skips a newly referenced blob",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE audit_events,ledger_entries,usage_runs,api_tokens,sessions,messages,
        conversations,auth_sessions,auth_accounts,auth_verifications,auth_users,users
        RESTART IDENTITY CASCADE`,
    );
    const store = new CleanupStore();
    try {
      const owner = await repository.bootstrapAdmin({
        email: "file-cleanup-worker@example.test",
        name: "File cleanup worker",
        passwordHash: "test-only",
      }, 0);
      const abandon = async (suffix: string) => {
        const digest = suffix.repeat(64);
        const objectKey = `uploads/${owner.id}/blobs/${suffix.repeat(2)}/${digest}.txt`;
        const input = {
          userId: owner.id,
          endpoint: "files" as const,
          idempotencyKey: `cleanup-${suffix}`,
          requestHash: digest,
          stream: false,
          model: "files/upload",
          runId: `${owner.id}:files:${crypto.randomUUID()}`,
          reserveMicros: 0,
          provider: "local",
          replayReservedBytes: 16 * 1024,
        };
        const begun = await repository.beginApiRequest(input);
        if (begun.kind !== "started") throw new Error("expected started upload");
        await repository.stageFileUpload({
          requestId: begun.request.id,
          ownerId: owner.id,
          objectKey,
          filename: `${suffix}.txt`,
          mimeType: "text/plain",
          sizeBytes: 4,
          sha256: digest,
          purpose: "assistants",
          attachmentState: "ready",
          inspectionError: null,
          requiredInspectionMode: "local",
          inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
        });
        await repository.markFileUploadStored(begun.request.id, begun.leaseToken);
        await repository.releaseApiRequestLease(begun.request.id, begun.leaseToken);
        assertEquals(await repository.reapStaleApiRequests(), 0);
        const reclaimed = await repository.reclaimApiRequest(
          begun.request.id,
          begun.leaseToken,
          30,
        );
        await repository.failApiRequest({
          id: begun.request.id,
          leaseToken: reclaimed.leaseToken,
          responseStatus: 500,
          responseHeaders: { "content-type": "application/json" },
          responseBody: JSON.stringify({ error: { code: "upload_interrupted" } }),
          billing: { mode: "refund" },
        });
        await sql`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
          VALUES(
            'file_object.cleanup',
            ${sql.json({ requestId: begun.request.id, ownerId: owner.id, objectKey })},
            ${`file_object.cleanup:${begun.request.id}`},
            'queued',
            0,
            now()
          )`;
        return { begun, objectKey, digest };
      };
      const claimCleanup = async (requestId: string): Promise<ClaimedJob> => {
        const claimToken = `file-cleanup-test:${crypto.randomUUID()}`;
        const rows = await sql<{
          id: string;
          type: string;
          payload: unknown;
          attempts: number;
          idempotency_key: string | null;
        }[]>`UPDATE jobs SET status='running',locked_at=now(),locked_by=${claimToken},
          attempts=attempts+1 WHERE idempotency_key=${`file_object.cleanup:${requestId}`}
          AND status='queued' RETURNING id,type,payload,attempts,idempotency_key`;
        if (!rows[0]) throw new Error("missing cleanup job");
        return {
          id: rows[0].id,
          type: rows[0].type,
          payload: rows[0].payload,
          attempts: rows[0].attempts,
          claimToken,
          idempotencyKey: rows[0].idempotency_key,
          externalDeadlineMonotonicMs: performance.now() + 60_000,
        };
      };

      const orphan = await abandon("a");
      store.objects.add(orphan.objectKey);
      const firstClaim = await claimCleanup(orphan.begun.request.id);
      store.failNextDelete = true;
      await assertRejects(
        () => processFileObjectCleanup(sql, store, firstClaim),
        Error,
        "injected object delete failure",
      );
      assertEquals(await processFileObjectCleanup(sql, store, firstClaim), "deleted");
      assertEquals(store.objects.has(orphan.objectKey), false);
      assertEquals(store.deletes, [orphan.objectKey, orphan.objectKey]);

      const referenced = await abandon("b");
      store.objects.add(referenced.objectKey);
      await repository.createAttachment({
        ownerId: owner.id,
        objectKey: referenced.objectKey,
        filename: "keep.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: referenced.digest,
        state: "ready",
        inspectionComplete: true,
      });
      // Soft deletion preserves immutable history and is not an object-purge authorization.
      await sql`UPDATE attachments SET state='deleted',deleted_at=now()
        WHERE owner_id=${owner.id} AND object_key=${referenced.objectKey}`;
      const secondClaim = await claimCleanup(referenced.begun.request.id);
      assertEquals(await processFileObjectCleanup(sql, store, secondClaim), "skipped");
      assertEquals(store.objects.has(referenced.objectKey), true);
      assertEquals(store.deletes.includes(referenced.objectKey), false);

      const active = await abandon("c");
      store.objects.add(active.objectKey);
      const activePeer = await repository.beginApiRequest({
        userId: owner.id,
        endpoint: "files",
        idempotencyKey: "cleanup-c-active-peer",
        requestHash: "d".repeat(64),
        stream: false,
        model: "files/upload",
        runId: `${owner.id}:files:${crypto.randomUUID()}`,
        reserveMicros: 0,
        provider: "local",
        replayReservedBytes: 16 * 1024,
      });
      if (activePeer.kind !== "started") throw new Error("expected active peer upload");
      await repository.stageFileUpload({
        requestId: activePeer.request.id,
        ownerId: owner.id,
        objectKey: active.objectKey,
        filename: "active-peer.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: active.digest,
        purpose: "assistants",
        attachmentState: "ready",
        inspectionError: null,
        requiredInspectionMode: "local",
        inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      });
      const activeClaim = await claimCleanup(active.begun.request.id);
      assertEquals(await processFileObjectCleanup(sql, store, activeClaim), "deferred");
      assertEquals(store.objects.has(active.objectKey), true);
      assertEquals(store.deletes.includes(active.objectKey), false);
      await repository.failApiRequest({
        id: activePeer.request.id,
        leaseToken: activePeer.leaseToken,
        responseStatus: 500,
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify({ error: { code: "upload_interrupted" } }),
        billing: { mode: "refund" },
      });
      const resumedActiveClaim = await claimCleanup(active.begun.request.id);
      assertEquals(
        await processFileObjectCleanup(sql, store, resumedActiveClaim),
        "deleted",
      );
      assertEquals(store.objects.has(active.objectKey), false);

      const pruned = await abandon("d");
      store.objects.add(pruned.objectKey);
      // Replay retention is independent from worker backlog. Its cascading stage deletion must
      // not strand a content-addressed blob when the exact cleanup job remains durable.
      await sql`DELETE FROM api_idempotency_requests WHERE id=${pruned.begun.request.id}`;
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM file_upload_staging
          WHERE request_id=${pruned.begun.request.id}`)[0].count,
        ),
        0,
      );
      const prunedClaim = await claimCleanup(pruned.begun.request.id);
      assertEquals(await processFileObjectCleanup(sql, store, prunedClaim), "deleted");
      assertEquals(store.objects.has(pruned.objectKey), false);

      const jobs = await sql<{ status: string }[]>`
        SELECT status FROM jobs WHERE idempotency_key IN (
          ${`file_object.cleanup:${orphan.begun.request.id}`},
          ${`file_object.cleanup:${referenced.begun.request.id}`},
          ${`file_object.cleanup:${active.begun.request.id}`},
          ${`file_object.cleanup:${pruned.begun.request.id}`}
        ) ORDER BY created_at`;
      assertEquals(jobs.map(({ status }) => status), [
        "completed",
        "completed",
        "completed",
        "completed",
      ]);
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
