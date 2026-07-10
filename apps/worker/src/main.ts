import postgres from "npm:postgres@3.4.7";
import { type ObjectStore, objectStoreFromEnv } from "@dg-chat/database";
import {
  assertAttachmentInspectionTerminal,
  AttachmentInspectionPendingError,
  parseAttachmentInspectionPayload,
} from "./attachment-inspection.ts";
import { claimJob, completeJob, deferJob, failOrRetryJob } from "./job-queue.ts";
import {
  deterministicChunks,
  parseAttachmentIngestionPayload,
  readIngestionText,
  recordIngestionFailure,
  requireIngestionObject,
} from "./attachment-ingestion.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const workerId = Deno.env.get("WORKER_ID") ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
const pollMs = Number(Deno.env.get("WORKER_POLL_MS") ?? 1000);
const jobLeaseSeconds = Number(Deno.env.get("WORKER_JOB_LEASE_SECONDS") ?? 120);
if (!Number.isSafeInteger(pollMs) || pollMs < 10) {
  throw new Error("WORKER_POLL_MS must be an integer of at least 10 milliseconds");
}
if (!Number.isSafeInteger(jobLeaseSeconds) || jobLeaseSeconds < 1) {
  throw new Error("WORKER_JOB_LEASE_SECONDS must be a positive integer");
}
let stopping = false;

const abort = () => {
  stopping = true;
};
Deno.addSignalListener("SIGINT", abort);
if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", abort);

if (!databaseUrl) {
  console.log(
    JSON.stringify({ level: "warn", message: "DATABASE_URL not set; worker is idle", workerId }),
  );
  while (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
  Deno.exit(0);
}

const sql = postgres(databaseUrl, { max: 4 });
const discoveredObjectStore = objectStoreFromEnv();
if (!discoveredObjectStore) {
  await sql.end({ timeout: 5 });
  throw new Error("S3 object storage configuration is required by the ingestion worker");
}
const objectStore: ObjectStore = discoveredObjectStore;
console.log(JSON.stringify({ level: "info", message: "Worker started", workerId }));

async function processJob(
  job: { id: string; type: string; payload: unknown; attempts: number; claimToken: string },
) {
  switch (job.type) {
    case "attachment.inspect": {
      const { attachmentId, ownerId } = parseAttachmentInspectionPayload(job.payload);
      const rows = await sql<{ state: string }[]>`
        SELECT state FROM attachments WHERE id=${attachmentId} AND owner_id=${ownerId}
      `;
      const state = rows[0]?.state;
      assertAttachmentInspectionTerminal(state);
      console.log(
        JSON.stringify({
          level: "info",
          message: "Attachment inspection result acknowledged",
          jobId: job.id,
          attachmentId,
          state,
        }),
      );
      break;
    }
    case "attachment.ingest": {
      const { attachmentId, ownerId } = parseAttachmentIngestionPayload(job.payload);
      const rows = await sql<{
        object_key: string;
        mime_type: string;
        filename: string;
        sha256: string;
        size_bytes: number;
      }[]>`
        UPDATE attachments a SET ingestion_status='processing',ingestion_error=NULL,updated_at=now()
        FROM jobs j WHERE a.id=${attachmentId} AND a.owner_id=${ownerId}
          AND a.deleted_at IS NULL AND a.state='ready'
          AND a.mime_type IN ('text/plain','application/json')
          AND a.ingestion_status IN ('queued','processing')
          AND j.id=${job.id} AND j.status='running' AND j.locked_by=${job.claimToken}
        RETURNING a.object_key,a.mime_type,a.filename,a.sha256,a.size_bytes`;
      const source = rows[0];
      if (!source) throw new Error("Attachment ingestion claim is stale or invalid");
      const object = await requireIngestionObject(objectStore, source.object_key);
      if (object.contentLength !== null && object.contentLength !== Number(source.size_bytes)) {
        throw new Error("Attachment object size does not match its record");
      }
      if (object.metadata.sha256 && object.metadata.sha256 !== source.sha256) {
        throw new Error("Attachment object digest metadata does not match its record");
      }
      if (object.metadata.owner && object.metadata.owner !== ownerId) {
        throw new Error("Attachment object owner metadata does not match its record");
      }
      const text = await readIngestionText(
        object,
        source.mime_type,
        4 * 1024 * 1024,
        30_000,
        source.sha256,
      );
      const chunks = await deterministicChunks({
        attachmentId,
        filename: source.filename,
        mimeType: source.mime_type,
        sha256: source.sha256,
        text,
      });
      const committed = await sql.begin(async (tx) => {
        const fence = await tx`SELECT id FROM jobs WHERE id=${job.id} AND status='running'
          AND locked_by=${job.claimToken} FOR UPDATE`;
        if (!fence.length) return false;
        const current = await tx`SELECT id FROM attachments WHERE id=${attachmentId}
          AND owner_id=${ownerId} AND deleted_at IS NULL AND ingestion_status='processing' FOR UPDATE`;
        if (!current.length) return false;
        await tx`DELETE FROM document_chunks WHERE attachment_id=${attachmentId}`;
        for (const chunk of chunks) {
          await tx`INSERT INTO document_chunks(id,attachment_id,ordinal,content,metadata)
            VALUES(${chunk.id},${attachmentId},${chunk.ordinal},${chunk.content},${
            tx.json(chunk.metadata as never)
          })`;
        }
        await tx`UPDATE attachments SET ingestion_status='ready',ingestion_error=NULL,
          ingested_at=now(),updated_at=now() WHERE id=${attachmentId}`;
        await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL
          WHERE id=${job.id}`;
        return true;
      });
      if (!committed) throw new Error("Attachment ingestion claim was reclaimed");
      return true;
    }
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

while (!stopping) {
  const job = await claimJob(sql, workerId, jobLeaseSeconds);
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    continue;
  }
  try {
    const completedAtomically = await processJob(job);
    if (!completedAtomically) await completeJob(sql, job);
  } catch (error) {
    if (error instanceof AttachmentInspectionPendingError) {
      await deferJob(sql, job, 5);
      continue;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (job.type === "attachment.ingest") {
      let payload;
      try {
        payload = parseAttachmentIngestionPayload(job.payload);
      } catch {
        await failOrRetryJob(sql, job, message);
        continue;
      }
      await recordIngestionFailure(sql, job, payload, message);
    } else await failOrRetryJob(sql, job, message);
  }
}
await sql.end({ timeout: 5 });
objectStore.close();
console.log(JSON.stringify({ level: "info", message: "Worker stopped", workerId }));
