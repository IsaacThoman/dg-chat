import postgres from "npm:postgres@3.4.7";
import {
  DomainError,
  INGESTIBLE_DOCUMENT_MIME_TYPES,
  type ObjectStore,
  objectStoreFromEnv,
  parseDocumentProcessingConfig,
  PostgresRepository,
  validateDocumentChunkInputs,
} from "@dg-chat/database";
import {
  estimateInputTokens,
  MemoryCircuitBreaker,
  ProviderExecutionEngine,
  ProviderSecretKeyring,
  RedisCircuitBreaker,
} from "@dg-chat/provider-runtime";
import {
  assertAttachmentInspectionTerminal,
  AttachmentInspectionPendingError,
  parseAttachmentInspectionPayload,
} from "./attachment-inspection.ts";
import { claimJob, completeJob, deferJob, failOrRetryJob, heartbeatJob } from "./job-queue.ts";
import {
  parseAttachmentIngestionPayload,
  recordIngestionFailure,
  requireIngestionObject,
} from "./attachment-ingestion.ts";
import { buildDocumentChunks, raceJobDeadline } from "./document-pipeline.ts";
import type { DocumentExtractionLimits } from "./document-extraction.ts";
import {
  documentChunkSetSha256,
  embeddingHeartbeatIntervalMs,
  parseDocumentEmbeddingConfig,
  validateWorkerJobLeaseSeconds,
} from "./document-embedding.ts";
import { runDocumentEmbeddingJob } from "./document-embedding-runner.ts";

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
const documentEmbeddingConfig = parseDocumentEmbeddingConfig();
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
const embeddingRecoveryIntervalMs = positiveInteger(
  "DOCUMENT_EMBEDDING_RECOVERY_INTERVAL_MS",
  60_000,
  1_000,
);
if (!Number.isSafeInteger(pollMs) || pollMs < 10) {
  throw new Error("WORKER_POLL_MS must be an integer of at least 10 milliseconds");
}
validateWorkerJobLeaseSeconds(jobLeaseSeconds);
if (jobDeadlineMarginMs >= jobLeaseSeconds * 1000) {
  throw new Error("WORKER_JOB_DEADLINE_MARGIN_MS must be shorter than WORKER_JOB_LEASE_SECONDS");
}
let stopping = false;
const processAbort = new AbortController();

const abort = () => {
  stopping = true;
  processAbort.abort(new DOMException("Worker is shutting down", "AbortError"));
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
const embeddingKeyring = documentEmbeddingConfig ? ProviderSecretKeyring.fromEnv() : undefined;
if (documentEmbeddingConfig && !embeddingKeyring) {
  throw new Error("Provider encryption keyring is required for document embeddings");
}
const embeddingCircuit = Deno.env.get("REDIS_URL")
  ? new RedisCircuitBreaker(Deno.env.get("REDIS_URL")!)
  : new MemoryCircuitBreaker();
if (
  documentEmbeddingConfig && Deno.env.get("DENO_ENV") === "production" &&
  !Deno.env.get("REDIS_URL")
) {
  throw new Error("REDIS_URL is required for document embeddings in production");
}
const embeddingEngine = embeddingKeyring
  ? new ProviderExecutionEngine({
    repository,
    keyring: embeddingKeyring,
    circuitBreaker: embeddingCircuit,
    breakerPolicy: {
      failureThreshold: positiveInteger("PROVIDER_BREAKER_FAILURE_THRESHOLD", 3),
      failureWindowSeconds: positiveInteger("PROVIDER_BREAKER_FAILURE_WINDOW_SECONDS", 60),
      openSeconds: positiveInteger("PROVIDER_BREAKER_OPEN_SECONDS", 30),
      halfOpenLeaseSeconds: positiveInteger("PROVIDER_BREAKER_HALF_OPEN_LEASE_SECONDS", 10),
    },
  })
  : undefined;
const discoveredObjectStore = objectStoreFromEnv();
if (!discoveredObjectStore) {
  await sql.end({ timeout: 5 });
  throw new Error("S3 object storage configuration is required by the ingestion worker");
}
const objectStore: ObjectStore = discoveredObjectStore;
console.log(JSON.stringify({ level: "info", message: "Worker started", workerId }));
console.log(JSON.stringify({
  level: "info",
  message: documentEmbeddingConfig ? "Document embeddings enabled" : "Document embeddings disabled",
  modelId: documentEmbeddingConfig?.modelId,
  configVersion: documentEmbeddingConfig?.configVersion,
}));

async function ensureDocumentEmbedding(
  attachmentId: string,
  ownerId: string,
): Promise<void> {
  if (!documentEmbeddingConfig || !embeddingEngine) return;
  const chunks = await repository.listDocumentChunks(attachmentId, ownerId);
  const chunkSetDigest = await documentChunkSetSha256(chunks);
  const plan = await embeddingEngine.resolvePlan(documentEmbeddingConfig.modelId);
  const inputTokens = estimateInputTokens({ input: chunks.map((chunk) => chunk.content) });
  const reserveMicros = embeddingEngine.reservationMicros(plan, inputTokens, 0);
  const identity = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${chunkSetDigest}:${documentEmbeddingConfig.modelId}:${documentEmbeddingConfig.configVersion}`,
    ),
  );
  const suffix = [...new Uint8Array(identity)].map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  await repository.beginDocumentEmbedding({
    ownerId,
    attachmentId,
    chunkSetDigest,
    modelId: documentEmbeddingConfig.modelId,
    configVersion: documentEmbeddingConfig.configVersion,
    provider: plan.targets[0].providerSlug,
    usageRunId: `document-embedding:${attachmentId}:${suffix}`,
    reserveMicros,
    pricingSnapshot: plan.targets[0].pricing,
    planSnapshot: plan,
  });
}

async function tryEnsureDocumentEmbedding(attachmentId: string, ownerId: string): Promise<void> {
  try {
    await ensureDocumentEmbedding(attachmentId, ownerId);
  } catch (error) {
    const terminal = error instanceof DomainError && error.code === "insufficient_credit";
    console.log(JSON.stringify({
      level: terminal ? "warn" : "error",
      message: terminal
        ? "Document embedding enqueue skipped"
        : "Document embedding enqueue will be retried by reconciliation",
      attachmentId,
      ownerId,
      code: error instanceof DomainError
        ? error.code
        : error instanceof Error
        ? error.name
        : "error",
      error: error instanceof Error ? error.message : String(error),
    }));
    embeddingRecoveryBackoff.set(
      attachmentId,
      Date.now() + (terminal ? 15 * 60_000 : embeddingRecoveryIntervalMs),
    );
  }
}

let lastEmbeddingRecoveryAt = 0;
let embeddingRecoveryCursor = "00000000-0000-0000-0000-000000000000";
const embeddingRecoveryBackoff = new Map<string, number>();
async function recoverPendingDocumentEmbeddings(): Promise<void> {
  if (
    !documentEmbeddingConfig || Date.now() - lastEmbeddingRecoveryAt < embeddingRecoveryIntervalMs
  ) {
    return;
  }
  lastEmbeddingRecoveryAt = Date.now();
  const pending = await sql<{ id: string; owner_id: string }[]>`
    SELECT DISTINCT a.id,a.owner_id FROM attachments a JOIN document_chunks d
      ON d.attachment_id=a.id
    WHERE a.deleted_at IS NULL AND a.state='ready' AND a.ingestion_status='ready'
      AND d.embedding_status='pending'
      AND a.id>${embeddingRecoveryCursor}
      AND NOT EXISTS (SELECT 1 FROM document_embedding_executions e
        WHERE e.attachment_id=a.id AND e.model_id=${documentEmbeddingConfig.modelId}
          AND e.config_version=${documentEmbeddingConfig.configVersion})
    ORDER BY a.id LIMIT 20`;
  if (!pending.length) {
    embeddingRecoveryCursor = "00000000-0000-0000-0000-000000000000";
    return;
  }
  embeddingRecoveryCursor = pending.at(-1)!.id;
  for (const item of pending) {
    if ((embeddingRecoveryBackoff.get(item.id) ?? 0) > Date.now()) continue;
    embeddingRecoveryBackoff.delete(item.id);
    await tryEnsureDocumentEmbedding(item.id, item.owner_id);
  }
  if (embeddingRecoveryBackoff.size > 10_000) {
    for (const [id, until] of embeddingRecoveryBackoff) {
      if (until <= Date.now()) embeddingRecoveryBackoff.delete(id);
    }
  }
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
      if (!source) {
        const ready = await sql`SELECT id FROM attachments WHERE id=${attachmentId}
          AND owner_id=${ownerId} AND deleted_at IS NULL AND ingestion_status='ready'`;
        if (!ready.length) throw new Error("Attachment ingestion claim is stale or invalid");
        await tryEnsureDocumentEmbedding(attachmentId, ownerId);
        return false;
      }
      const object = await raceJobDeadline(
        requireIngestionObject(objectStore, source.object_key),
        deadlineAt,
        processAbort.signal,
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
          processAbort.signal,
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
        return true;
      });
      if (!committed) throw new Error("Attachment ingestion claim was reclaimed");
      await tryEnsureDocumentEmbedding(attachmentId, ownerId);
      return false;
    }
    case "document.embed": {
      if (!embeddingEngine) throw new Error("Document embedding runtime is not configured");
      const controller = new AbortController();
      const signal = AbortSignal.any([processAbort.signal, controller.signal]);
      const heartbeatMs = embeddingHeartbeatIntervalMs(jobLeaseSeconds);
      const heartbeat = setInterval(() => {
        void heartbeatJob(sql, job).then((alive) => {
          if (!alive) {
            controller.abort(new DOMException("Embedding job lease was lost", "AbortError"));
          }
        }).catch((error) => controller.abort(error));
      }, heartbeatMs);
      try {
        await runDocumentEmbeddingJob({ job, repository, engine: embeddingEngine, signal });
      } finally {
        clearInterval(heartbeat);
      }
      return true;
    }
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

while (!stopping) {
  await recoverPendingDocumentEmbeddings().catch((error) =>
    console.log(JSON.stringify({
      level: "error",
      message: "Document embedding reconciliation failed",
      error: error instanceof Error ? error.message : String(error),
    }))
  );
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
await Promise.all([repository.close(), embeddingCircuit.close()]);
objectStore.close();
console.log(JSON.stringify({ level: "info", message: "Worker stopped", workerId }));
