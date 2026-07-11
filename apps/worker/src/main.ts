import postgres from "npm:postgres@3.4.7";
import {
  INGESTIBLE_DOCUMENT_MIME_TYPES,
  type ObjectStore,
  objectStoreFromEnv,
  parseDocumentProcessingConfig,
  PostgresRepository,
  validateDocumentChunkInputs,
} from "@dg-chat/database";
import {
  assertAttachmentInspectionTerminal,
  AttachmentInspectionPendingError,
  parseAttachmentInspectionPayload,
} from "./attachment-inspection.ts";
import { claimJob, completeJob, deferJob, failOrRetryJob } from "./job-queue.ts";
import {
  parseAttachmentIngestionPayload,
  recordIngestionFailure,
  requireIngestionObject,
} from "./attachment-ingestion.ts";
import { buildDocumentChunks, raceJobDeadline } from "./document-pipeline.ts";
import type { DocumentExtractionLimits } from "./document-extraction.ts";
import {
  embedKnowledgeChunks,
  parseDocumentEmbeddingPayload,
  parseKnowledgeEmbeddingConfig,
  sha256,
} from "./knowledge-embedding.ts";
import { runAccountedEmbeddingCall } from "../../api/src/embedding-accounting.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const workerId = Deno.env.get("WORKER_ID") ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
const pollMs = Number(Deno.env.get("WORKER_POLL_MS") ?? 1000);
const jobLeaseSeconds = Number(Deno.env.get("WORKER_JOB_LEASE_SECONDS") ?? 120);
const documentProcessingConfig = parseDocumentProcessingConfig({
  DOCUMENT_CHUNK_SIZE_CHARS: Deno.env.get("DOCUMENT_CHUNK_SIZE_CHARS"),
  DOCUMENT_CHUNK_OVERLAP_CHARS: Deno.env.get("DOCUMENT_CHUNK_OVERLAP_CHARS"),
  DOCUMENT_EXTRACTOR_VERSION: Deno.env.get("DOCUMENT_EXTRACTOR_VERSION"),
  DOCUMENT_CHUNKER_VERSION: Deno.env.get("DOCUMENT_CHUNKER_VERSION"),
});
const knowledgeEmbeddingConfig = parseKnowledgeEmbeddingConfig({
  KNOWLEDGE_EMBEDDING_BASE_URL: Deno.env.get("KNOWLEDGE_EMBEDDING_BASE_URL"),
  KNOWLEDGE_EMBEDDING_API_KEY: Deno.env.get("KNOWLEDGE_EMBEDDING_API_KEY"),
  KNOWLEDGE_EMBEDDING_MODEL: Deno.env.get("KNOWLEDGE_EMBEDDING_MODEL"),
  KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL: Deno.env.get("KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL"),
  KNOWLEDGE_EMBEDDING_VERSION: Deno.env.get("KNOWLEDGE_EMBEDDING_VERSION"),
  KNOWLEDGE_EMBEDDING_BATCH_SIZE: Deno.env.get("KNOWLEDGE_EMBEDDING_BATCH_SIZE"),
  KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION: Deno.env.get(
    "KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION",
  ),
  KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS: Deno.env.get(
    "KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS",
  ),
});
function positiveInteger(name: string, fallback: number, minimum = 1): number {
  const raw = Deno.env.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}
const documentExtractionLimits: DocumentExtractionLimits = {
  maxRawBytes: positiveInteger("DOCUMENT_EXTRACTION_MAX_RAW_BYTES", 20 * 1024 * 1024),
  timeoutMs: positiveInteger("DOCUMENT_EXTRACTION_TIMEOUT_MS", 30_000),
  maxOutputCharacters: positiveInteger("DOCUMENT_EXTRACTION_MAX_OUTPUT_CHARACTERS", 2_000_000),
  maxPdfPages: positiveInteger("DOCUMENT_EXTRACTION_MAX_PDF_PAGES", 1_000),
  maxZipEntries: positiveInteger("DOCUMENT_EXTRACTION_MAX_ZIP_ENTRIES", 2_000),
  maxZipEntryBytes: positiveInteger("DOCUMENT_EXTRACTION_MAX_ZIP_ENTRY_BYTES", 25 * 1024 * 1024),
  maxZipExpandedBytes: positiveInteger(
    "DOCUMENT_EXTRACTION_MAX_ZIP_EXPANDED_BYTES",
    100 * 1024 * 1024,
  ),
  maxZipCompressionRatio: positiveInteger("DOCUMENT_EXTRACTION_MAX_ZIP_RATIO", 200),
};
const jobDeadlineMarginMs = positiveInteger("WORKER_JOB_DEADLINE_MARGIN_MS", 5_000);
const generatedCleanupGraceSeconds = positiveInteger("GENERATED_OBJECT_CLEANUP_GRACE_SECONDS", 600);
const generatedCleanupSweepMs = positiveInteger("GENERATED_OBJECT_CLEANUP_SWEEP_MS", 60_000);
if (!Number.isSafeInteger(pollMs) || pollMs < 10) {
  throw new Error("WORKER_POLL_MS must be an integer of at least 10 milliseconds");
}
if (!Number.isSafeInteger(jobLeaseSeconds) || jobLeaseSeconds < 1) {
  throw new Error("WORKER_JOB_LEASE_SECONDS must be a positive integer");
}
if (jobDeadlineMarginMs >= jobLeaseSeconds * 1000) {
  throw new Error("WORKER_JOB_DEADLINE_MARGIN_MS must be shorter than WORKER_JOB_LEASE_SECONDS");
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
const repository = await PostgresRepository.connect(databaseUrl);
const discoveredObjectStore = objectStoreFromEnv();
if (!discoveredObjectStore) {
  await sql.end({ timeout: 5 });
  throw new Error("S3 object storage configuration is required by the ingestion worker");
}
const objectStore: ObjectStore = discoveredObjectStore;
console.log(JSON.stringify({ level: "info", message: "Worker started", workerId }));
async function enqueueStaleGeneratedObjectCleanup() {
  await sql.begin(async (tx) => {
    const rows = await tx<{ id: string; owner_id: string }[]>`
      UPDATE generated_object_staging s SET state='cleanup_pending',
        cleanup_error=COALESCE(cleanup_error,'stale generated object stage'),updated_at=now()
      WHERE s.state IN ('pending','stored','attached','cleaning')
        AND s.updated_at < now() - ${generatedCleanupGraceSeconds} * interval '1 second'
        AND NOT EXISTS(SELECT 1 FROM generated_assets ga WHERE ga.usage_run_id=s.usage_run_id)
        AND NOT EXISTS(SELECT 1 FROM api_idempotency_requests r
          WHERE r.usage_run_id=s.usage_run_id AND r.state='in_progress'
            AND r.lease_expires_at>now())
        AND NOT EXISTS(SELECT 1 FROM usage_runs u WHERE u.id=s.usage_run_id
          AND u.status='reserved' AND u.run_lease_expires_at>now())
      RETURNING s.id,s.owner_id`;
    for (const row of rows) {
      await tx`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
        VALUES('generated_object.cleanup',${
        tx.json({ stageId: String(row.id), ownerId: String(row.owner_id) })
      },${`generated_object.cleanup:${String(row.id)}`},'queued',0,now())
        ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',attempts=0,available_at=now(),
          last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL
          WHERE jobs.status IN ('completed','failed')`;
    }
  });
}
await enqueueStaleGeneratedObjectCleanup();
if (knowledgeEmbeddingConfig) {
  await sql`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
    SELECT 'document.embed',jsonb_build_object(
      'attachmentId',a.id,'ownerId',a.owner_id,'version',${knowledgeEmbeddingConfig.version}::text
    ),'document.embed:' || a.id || ':' || ${knowledgeEmbeddingConfig.version},'queued',0,now()
    FROM attachments a
    WHERE a.deleted_at IS NULL AND a.state='ready' AND a.ingestion_status='ready'
      AND EXISTS (SELECT 1 FROM document_chunks dc WHERE dc.attachment_id=a.id)
      AND EXISTS (
        SELECT 1 FROM document_chunks dc WHERE dc.attachment_id=a.id AND NOT EXISTS (
          SELECT 1 FROM document_chunk_embeddings dce WHERE dce.chunk_id=dc.id
            AND dce.owner_id=a.owner_id
            AND dce.model=${knowledgeEmbeddingConfig.model}::text
            AND dce.embedding_version=${knowledgeEmbeddingConfig.version}::text
        )
      )
    ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',attempts=0,available_at=now(),
      last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL
      WHERE jobs.status IN ('completed','failed')`;
}

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
      const deadlineAt = Date.now() + Math.min(
        documentExtractionLimits.timeoutMs!,
        jobLeaseSeconds * 1000 - jobDeadlineMarginMs,
      );
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
          AND a.mime_type = ANY(${[...INGESTIBLE_DOCUMENT_MIME_TYPES]})
          AND a.ingestion_status IN ('queued','processing')
          AND j.id=${job.id} AND j.status='running' AND j.locked_by=${job.claimToken}
        RETURNING a.object_key,a.mime_type,a.filename,a.sha256,a.size_bytes`;
      const source = rows[0];
      if (!source) throw new Error("Attachment ingestion claim is stale or invalid");
      const object = await raceJobDeadline(
        requireIngestionObject(objectStore, source.object_key),
        deadlineAt,
      );
      if (object.contentLength !== null && object.contentLength !== Number(source.size_bytes)) {
        throw new Error("Attachment object size does not match its record");
      }
      if (object.metadata.sha256 && object.metadata.sha256 !== source.sha256) {
        throw new Error("Attachment object digest metadata does not match its record");
      }
      if (object.metadata.owner && object.metadata.owner !== ownerId) {
        throw new Error("Attachment object owner metadata does not match its record");
      }
      const chunks = validateDocumentChunkInputs(
        await buildDocumentChunks(
          {
            attachmentId,
            filename: source.filename,
            mimeType: source.mime_type,
            sha256: source.sha256,
            object,
          },
          documentProcessingConfig,
          documentExtractionLimits,
          deadlineAt,
        ),
        attachmentId,
      );
      const committed = await sql.begin(async (tx) => {
        if (Date.now() >= deadlineAt) return false;
        const fence = await tx`SELECT id FROM jobs WHERE id=${job.id} AND status='running'
          AND locked_by=${job.claimToken}
          AND locked_at > now() - ${jobLeaseSeconds} * interval '1 second' FOR UPDATE`;
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
        if (knowledgeEmbeddingConfig) {
          const idempotencyKey =
            `document.embed:${attachmentId}:${knowledgeEmbeddingConfig.version}`;
          await tx`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
            VALUES('document.embed',${
            tx.json({ attachmentId, ownerId, version: knowledgeEmbeddingConfig.version })
          },
              ${idempotencyKey},'queued',0,now())
            ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',attempts=0,
              available_at=now(),last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL`;
        }
        await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL
          WHERE id=${job.id}`;
        return true;
      });
      if (!committed) throw new Error("Attachment ingestion claim was reclaimed");
      return true;
    }
    case "document.embed": {
      if (!knowledgeEmbeddingConfig) {
        throw new Error("Knowledge embedding provider is not configured");
      }
      const payload = parseDocumentEmbeddingPayload(job.payload);
      if (payload.version !== knowledgeEmbeddingConfig.version) {
        throw new Error("Document embedding job version is no longer active");
      }
      const deadlineAt = Date.now() + jobLeaseSeconds * 1000 - jobDeadlineMarginMs;
      const rows = await sql<{ id: string; content: string }[]>`
        SELECT dc.id,dc.content FROM document_chunks dc
        JOIN attachments a ON a.id=dc.attachment_id
        JOIN jobs j ON j.id=${job.id} AND j.status='running' AND j.locked_by=${job.claimToken}
        WHERE dc.attachment_id=${payload.attachmentId} AND a.owner_id=${payload.ownerId}
          AND a.deleted_at IS NULL AND a.state='ready' AND a.ingestion_status='ready'
        ORDER BY dc.ordinal,dc.id`;
      if (!rows.length) throw new Error("Document embedding source is stale or unavailable");
      const values: Array<{ id: string; contentSha256: string; embedding: number[] }> = [];
      for (let offset = 0; offset < rows.length; offset += knowledgeEmbeddingConfig.batchSize) {
        const batch = rows.slice(offset, offset + knowledgeEmbeddingConfig.batchSize);
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new Error("Document embedding deadline exceeded");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), remaining);
        try {
          const content = batch.map((row) => row.content);
          const embeddings = await runAccountedEmbeddingCall({
            repository,
            userId: payload.ownerId,
            usageRunId: `${job.id}:embedding:${job.attempts + 1}:${offset}`,
            purpose: "document",
            provider: new URL(knowledgeEmbeddingConfig.baseUrl).host,
            model: knowledgeEmbeddingConfig.model,
            upstreamModel: knowledgeEmbeddingConfig.upstreamModel,
            content,
            billing: knowledgeEmbeddingConfig.billing,
            call: async () => {
              const result = await embedKnowledgeChunks(
                content,
                knowledgeEmbeddingConfig,
                controller.signal,
              );
              return { value: result.embeddings, inputTokens: result.inputTokens };
            },
          });
          const hashes = await Promise.all(batch.map((row) => sha256(row.content)));
          batch.forEach((row, index) =>
            values.push({ id: row.id, contentSha256: hashes[index], embedding: embeddings[index] })
          );
        } finally {
          clearTimeout(timeout);
        }
      }
      const committed = await sql.begin(async (tx) => {
        if (Date.now() >= deadlineAt) return false;
        const fence = await tx`SELECT id FROM jobs WHERE id=${job.id} AND status='running'
          AND locked_by=${job.claimToken}
          AND locked_at > now() - ${jobLeaseSeconds} * interval '1 second' FOR UPDATE`;
        if (!fence.length) return false;
        const current = await tx<{ id: string; content: string }[]>`
          SELECT dc.id,dc.content FROM document_chunks dc JOIN attachments a ON a.id=dc.attachment_id
          WHERE dc.attachment_id=${payload.attachmentId} AND a.owner_id=${payload.ownerId}
            AND a.deleted_at IS NULL AND a.ingestion_status='ready' ORDER BY dc.ordinal,dc.id
          FOR UPDATE OF dc`;
        if (current.length !== values.length) return false;
        for (let index = 0; index < current.length; index++) {
          if (
            current[index].id !== values[index].id ||
            await sha256(current[index].content) !== values[index].contentSha256
          ) return false;
        }
        for (const value of values) {
          await tx`INSERT INTO document_chunk_embeddings(
            chunk_id,owner_id,model,embedding_version,content_sha256,embedding
          ) VALUES(${value.id},${payload.ownerId},${knowledgeEmbeddingConfig.model},
            ${knowledgeEmbeddingConfig.version},${value.contentSha256},
            ${JSON.stringify(value.embedding)}::vector)
          ON CONFLICT(chunk_id,embedding_version) DO UPDATE SET model=EXCLUDED.model,
            owner_id=EXCLUDED.owner_id,content_sha256=EXCLUDED.content_sha256,
            embedding=EXCLUDED.embedding,updated_at=now()`;
        }
        await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL,
          last_error=NULL
          WHERE id=${job.id} AND status='running' AND locked_by=${job.claimToken}`;
        return true;
      });
      if (!committed) throw new Error("Document embedding claim was reclaimed or changed");
      return true;
    }
    case "generated_object.cleanup": {
      const value = job.payload as { stageId?: unknown; ownerId?: unknown };
      if (
        !value || typeof value !== "object" || typeof value.stageId !== "string" ||
        typeof value.ownerId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.stageId) ||
        !/^[0-9a-f-]{36}$/i.test(value.ownerId)
      ) throw new Error("Generated object cleanup payload is invalid");
      const stageId = value.stageId as string;
      const ownerId = value.ownerId as string;
      const claimed = await sql.begin(async (tx) => {
        const candidates = await tx<{
          state: string;
          object_key: string;
          attachment_id: string | null;
          cleanup_attachment: boolean;
        }[]>`SELECT state,object_key,attachment_id,cleanup_attachment
          FROM generated_object_staging
          WHERE id=${stageId} AND owner_id=${ownerId}`;
        const candidate = candidates[0];
        if (candidate?.attachment_id && candidate.cleanup_attachment) {
          // Reference writers take the same attachment row lock and require ready/not-deleted.
          // Fencing the attachment before the external delete closes the check/delete race.
          await tx`SELECT id FROM attachments WHERE id=${candidate.attachment_id}
            AND owner_id=${ownerId} FOR UPDATE`;
        }
        const rows = await tx<{
          object_key: string;
          attachment_id: string | null;
          cleanup_attachment: boolean;
        }[]>`
          UPDATE generated_object_staging s SET state='cleaning',updated_at=now()
          FROM jobs j WHERE s.id=${stageId} AND s.owner_id=${ownerId}
            AND s.state IN ('cleanup_pending','cleaning')
            AND j.id=${job.id} AND j.status='running' AND j.locked_by=${job.claimToken}
            AND (NOT s.cleanup_attachment OR NOT EXISTS(SELECT 1 FROM generated_assets ga
              WHERE ga.usage_run_id=s.usage_run_id OR ga.attachment_id=s.attachment_id))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(SELECT 1 FROM message_attachments ma
              WHERE ma.attachment_id=s.attachment_id))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(SELECT 1 FROM generated_asset_inputs gai
              WHERE gai.attachment_id=s.attachment_id))
          RETURNING s.object_key,s.attachment_id,s.cleanup_attachment`;
        if (rows[0]) {
          if (rows[0].attachment_id && rows[0].cleanup_attachment) {
            const fenced = await tx`UPDATE attachments SET state='deleted',
              deleted_at=COALESCE(deleted_at,now()),updated_at=now()
              WHERE id=${rows[0].attachment_id} AND owner_id=${ownerId}
                AND state='ready' AND deleted_at IS NULL RETURNING id`;
            if (!fenced.length) {
              throw new Error("Generated object cleanup attachment is not ready to fence");
            }
          }
          return rows[0];
        }
        const stage = candidate ? [candidate] : [];
        if (!stage.length || ["finalized", "cleaned"].includes(stage[0].state)) {
          await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,
            locked_by=NULL,last_error=NULL WHERE id=${job.id} AND status='running'
            AND locked_by=${job.claimToken}`;
          return null;
        }
        throw new Error("Generated object cleanup is fenced by a durable reference");
      });
      if (!claimed) return true;
      await objectStore.delete(claimed.object_key);
      const committed = await sql.begin(async (tx) => {
        const fence = await tx`SELECT id FROM jobs WHERE id=${job.id} AND status='running'
          AND locked_by=${job.claimToken} FOR UPDATE`;
        if (!fence.length) return false;
        const stages = await tx`SELECT id FROM generated_object_staging
          WHERE id=${stageId} AND owner_id=${ownerId} AND state='cleaning'
          FOR UPDATE`;
        if (!stages.length) return false;
        await tx`UPDATE generated_object_staging SET state='cleaned',cleanup_error=NULL,
          updated_at=now() WHERE id=${stageId}`;
        await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,
          locked_by=NULL,last_error=NULL WHERE id=${job.id}`;
        return true;
      });
      if (!committed) throw new Error("Generated object cleanup claim was reclaimed");
      return true;
    }
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

let nextGeneratedCleanupSweep = Date.now() + generatedCleanupSweepMs;
while (!stopping) {
  if (Date.now() >= nextGeneratedCleanupSweep) {
    await enqueueStaleGeneratedObjectCleanup();
    nextGeneratedCleanupSweep = Date.now() + generatedCleanupSweepMs;
  }
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
await repository.close();
objectStore.close();
console.log(JSON.stringify({ level: "info", message: "Worker stopped", workerId }));
