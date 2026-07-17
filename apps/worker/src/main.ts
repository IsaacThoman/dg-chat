import postgres from "npm:postgres@3.4.7";
import {
  embeddingTokenUpperBound,
  INGESTIBLE_DOCUMENT_MIME_TYPES,
  type ObjectStore,
  objectStoreFromEnv,
  parseDocumentProcessingConfig,
  parseTemporaryLifecycleConfig,
  PostgresRepository,
  reserveEmbeddingMicros,
  validateDocumentChunkInputs,
} from "@dg-chat/database";
import {
  parseAttachmentInspectionPayload,
  processAttachmentInspection,
  recordAttachmentInspectionFailure,
  transitionClaimedAttachmentInspection,
} from "./attachment-inspection.ts";
import { parseMalwareScannerConfig } from "./malware-scanner.ts";
import {
  claimJob,
  completeJob,
  deferJob,
  failOrRetryJob,
  failOrRetryRetentionScrubJob,
  renewJobClaim,
  retentionRunIdFromJobAssociation,
} from "./job-queue.ts";
import {
  parseAttachmentIngestionPayload,
  recordIngestionFailure,
  requireVerifiedIngestionObject,
} from "./attachment-ingestion.ts";
import { buildDocumentChunks, DocumentPipelineTimeoutError } from "./document-pipeline.ts";
import type { DocumentExtractionLimits } from "./document-extraction.ts";
import {
  embedKnowledgeChunks,
  parseDocumentEmbeddingPayload,
  parseKnowledgeEmbeddingConfig,
  sha256,
} from "./knowledge-embedding.ts";
import { runAccountedEmbeddingCall } from "../../api/src/embedding-accounting.ts";
import {
  beginDurableEmbeddingDispatch,
  callEmbeddingProviderAfterFence,
  EmbeddingNotDispatchedError,
  markDurableEmbeddingDispatchRetrySafe,
  markDurableEmbeddingNoFetchRetrySafe,
  prepareDurableEmbeddingBatch,
  recordDurableEmbeddingResponse,
  recoverRetrySafeEmbeddingDispatch,
  terminalizeUncertainEmbeddingDispatch,
  UncertainEmbeddingDispatchError,
} from "./document-embedding-dispatch.ts";
import { EmbeddingsProviderError } from "../../api/src/embeddings.ts";
import { parseRetentionScrubPayload, processRetentionScrub } from "./retention-scrub.ts";
import {
  parseRetentionSchedulerConfig,
  scheduleAutomaticRetention,
} from "./retention-scheduler.ts";
import { processFileObjectCleanup } from "./file-object-cleanup.ts";
import { processAttachmentObjectCleanup } from "./attachment-object-cleanup.ts";
import { purgeTemporaryConversationBatch } from "./temporary-lifecycle.ts";
import { retryClaimSettlement, settleClaimedJobFault } from "./claimed-job-recovery.ts";
import { retryWorkerClaimedDatabaseOperation } from "./worker-database.ts";
import {
  abortableDelay,
  DatabaseOperationError,
  isWorkerRetryableDatabaseError,
  retryWithBoundedBackoff,
  runDatabaseOperation,
  runResilientLoop,
} from "./resilient-loop.ts";
import { operationSignal, raceAbort } from "./operation-signal.ts";
import {
  reconcileAttachmentUploadCleanupBatch,
  reconcileGeneratedCleanupBatch,
  reconcileStartupQueues,
} from "./startup-reconciliation.ts";
import { retryBeforeAbsoluteDeadline } from "./shutdown-settlement.ts";
import { armShutdownWatchdog } from "./shutdown-watchdog.ts";
import { closeResourcesBeforeDeadline } from "./resource-close.ts";
import { logOperationalFailure } from "@dg-chat/contracts";
import {
  markClaimedJobProgressOrNeutralDefer,
  newWorkerIdentity,
  parseWorkerLivenessConfig,
  WorkerInstanceLostError,
  WorkerLivenessTracker,
  writeWorkerInstanceFile,
} from "./worker-liveness.ts";
import { runWorkerHealthCommand } from "./worker-health-command.ts";
import {
  boundedJobType,
  createWorkerMetrics,
  metricsListenerConfig,
  startMetricsServer,
  startTelemetry,
  telemetryConfig,
  withOperationalSpan,
} from "@dg-chat/observability";

if (Deno.args.length > 0) {
  if (Deno.args.length !== 1 || Deno.args[0] !== "--health") {
    console.error("Usage: dg-chat-worker [--health]");
    Deno.exit(2);
  }
  Deno.exit(await runWorkerHealthCommand() ? 0 : 1);
}

const telemetry = startTelemetry(telemetryConfig(Deno.env.toObject(), "dg-chat-worker"));
const workerMetrics = createWorkerMetrics();
const workerMetricsServer = startMetricsServer(
  workerMetrics.registry,
  metricsListenerConfig(Deno.env.toObject(), {
    port: 9091,
    enabled: Deno.env.get("DENO_ENV") === "production",
  }),
);
const databaseUrl = Deno.env.get("DATABASE_URL");
const workerIdentity = newWorkerIdentity(Deno.env.get("WORKER_ID") ?? "worker");
const workerId = `${workerIdentity.workerName}:${workerIdentity.instanceId}`;
const workerLivenessConfig = parseWorkerLivenessConfig();
const pollMs = Number(Deno.env.get("WORKER_POLL_MS") ?? 1000);
const jobLeaseSeconds = Number(Deno.env.get("WORKER_JOB_LEASE_SECONDS") ?? 120);
const documentProcessingConfig = parseDocumentProcessingConfig({
  DOCUMENT_CHUNK_SIZE_CHARS: Deno.env.get("DOCUMENT_CHUNK_SIZE_CHARS"),
  DOCUMENT_CHUNK_OVERLAP_CHARS: Deno.env.get("DOCUMENT_CHUNK_OVERLAP_CHARS"),
  DOCUMENT_EXTRACTOR_VERSION: Deno.env.get("DOCUMENT_EXTRACTOR_VERSION"),
  DOCUMENT_CHUNKER_VERSION: Deno.env.get("DOCUMENT_CHUNKER_VERSION"),
});
const knowledgeEmbeddingConfig = parseKnowledgeEmbeddingConfig({
  DENO_ENV: Deno.env.get("DENO_ENV"),
  OPENAI_TEST_ALLOW_HTTP_HOST: Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST"),
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
const attachmentInspectionMaxBytes = positiveInteger(
  "ATTACHMENT_INSPECTION_MAX_BYTES",
  25 * 1024 * 1024,
);
const malwareScannerConfig = parseMalwareScannerConfig();
const databaseRetryInitialMs = positiveInteger("WORKER_DATABASE_RETRY_INITIAL_MS", 250, 10);
const databaseRetryMaxMs = positiveInteger("WORKER_DATABASE_RETRY_MAX_MS", 10_000, 10);
const databaseRetryJitterRatio = Number(
  Deno.env.get("WORKER_DATABASE_RETRY_JITTER_RATIO") ?? "0.2",
);
const databaseOperationTimeoutMs = positiveInteger(
  "WORKER_DATABASE_OPERATION_TIMEOUT_MS",
  5_000,
  100,
);
const shutdownSettlementTimeoutMs = positiveInteger(
  "WORKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS",
  10_000,
  100,
);
if (databaseOperationTimeoutMs >= shutdownSettlementTimeoutMs) {
  throw new Error(
    "WORKER_DATABASE_OPERATION_TIMEOUT_MS must be shorter than WORKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS",
  );
}
if (databaseRetryMaxMs < databaseRetryInitialMs) {
  throw new Error("WORKER_DATABASE_RETRY_MAX_MS must not be shorter than the initial retry delay");
}
if (databaseRetryMaxMs > 2_147_483_647) {
  throw new Error("WORKER_DATABASE_RETRY_MAX_MS exceeds the platform timer limit");
}
if (
  !Number.isFinite(databaseRetryJitterRatio) || databaseRetryJitterRatio < 0 ||
  databaseRetryJitterRatio > 1
) {
  throw new Error("WORKER_DATABASE_RETRY_JITTER_RATIO must be from 0 to 1");
}
const databaseRetryPolicy = {
  initialDelayMs: databaseRetryInitialMs,
  maxDelayMs: databaseRetryMaxMs,
  multiplier: 2,
  jitterRatio: databaseRetryJitterRatio,
};
const temporaryLifecycle = parseTemporaryLifecycleConfig({
  TEMPORARY_CHAT_RETENTION_DAYS: Deno.env.get("TEMPORARY_CHAT_RETENTION_DAYS"),
  TEMPORARY_CHAT_PURGE_INTERVAL_SECONDS: Deno.env.get("TEMPORARY_CHAT_PURGE_INTERVAL_SECONDS"),
  TEMPORARY_CHAT_PURGE_BATCH_SIZE: Deno.env.get("TEMPORARY_CHAT_PURGE_BATCH_SIZE"),
});
const retentionScheduler = parseRetentionSchedulerConfig({
  RETENTION_SCRUB_INTERVAL_SECONDS: Deno.env.get("RETENTION_SCRUB_INTERVAL_SECONDS"),
  RETENTION_SCHEDULER_POLL_SECONDS: Deno.env.get("RETENTION_SCHEDULER_POLL_SECONDS"),
});
if (!Number.isSafeInteger(pollMs) || pollMs < 10) {
  throw new Error("WORKER_POLL_MS must be an integer of at least 10 milliseconds");
}
if (!Number.isSafeInteger(jobLeaseSeconds) || jobLeaseSeconds < 1) {
  throw new Error("WORKER_JOB_LEASE_SECONDS must be a positive integer");
}
if (jobDeadlineMarginMs >= jobLeaseSeconds * 1000) {
  throw new Error("WORKER_JOB_DEADLINE_MARGIN_MS must be shorter than WORKER_JOB_LEASE_SECONDS");
}
const shutdownController = new AbortController();
const shutdownSignal = shutdownController.signal;
let stopping = false;
let shutdownSettlementDeadlineAt: number | undefined;
let disposeShutdownWatchdog: (() => void) | undefined;
let forceCloseForShutdown = () => {};
const workerLiveness: { current?: WorkerLivenessTracker } = {};
let signalDrainPromise: Promise<void> | undefined;

const abort = () => {
  if (stopping) return;
  stopping = true;
  workerMetrics.setReady(false);
  shutdownSettlementDeadlineAt = Date.now() + shutdownSettlementTimeoutMs;
  shutdownController.abort(new DOMException("Worker stopping", "AbortError"));
  if (workerLiveness.current && !signalDrainPromise) {
    signalDrainPromise = workerLiveness.current.markDraining().catch(() => undefined);
  }
  // The graceful path races all remaining work against the same deadline. This watchdog is the
  // final process boundary for a blackholed driver/pool close that ignores both AbortSignal and
  // PostgreSQL statement_timeout. Compose grants a larger stop_grace_period (30s by default).
  disposeShutdownWatchdog = armShutdownWatchdog(
    shutdownSettlementTimeoutMs,
    forceCloseForShutdown,
  );
};
Deno.addSignalListener("SIGINT", abort);
if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", abort);

// Overwrite any prior boot's identity before the first dependency wait. Health can never inherit
// a successful row from an old process while this boot is still starting or retrying PostgreSQL.
await writeWorkerInstanceFile(workerLivenessConfig.instanceFile, workerIdentity.instanceId);

if (!databaseUrl) {
  console.log(
    JSON.stringify({ level: "warn", message: "DATABASE_URL not set; worker is idle", workerId }),
  );
  while (!stopping) {
    try {
      await abortableDelay(pollMs, shutdownSignal);
    } catch {
      if (!stopping) throw new Error("Idle worker wait failed");
    }
  }
  await workerMetricsServer?.close();
  await telemetry.shutdown();
  Deno.exit(0);
}

const discoveredObjectStore = objectStoreFromEnv();
if (!discoveredObjectStore) {
  throw new Error("S3 object storage configuration is required by the ingestion worker");
}
const objectStore: ObjectStore = discoveredObjectStore;
const connections = await retryWithBoundedBackoff({
  operation: () =>
    runDatabaseOperation(async () => {
      const candidateSql = postgres(databaseUrl, {
        max: 2,
        connect_timeout: 5,
        connection: { statement_timeout: databaseOperationTimeoutMs },
      });
      let candidateRepository: PostgresRepository | undefined;
      try {
        await candidateSql`SELECT 1`;
        candidateRepository = await PostgresRepository.connect(databaseUrl, {
          connectTimeoutSeconds: 5,
          statementTimeoutMs: databaseOperationTimeoutMs,
          conversationSearch: false,
          poolMax: 2,
        });
        return { sql: candidateSql, repository: candidateRepository };
      } catch (error) {
        await candidateRepository?.close().catch(() => undefined);
        await candidateSql.end({ timeout: 0 }).catch(() => undefined);
        throw error;
      }
    }),
  signal: shutdownSignal,
  policy: databaseRetryPolicy,
  shouldRetry: isWorkerRetryableDatabaseError,
  onRetry: ({ attempt, delayMs }) => {
    console.warn(JSON.stringify({
      level: "warn",
      message: "Worker database unavailable during startup; retrying",
      attempt,
      retryDelayMs: delayMs,
      workerId,
    }));
  },
}).catch((error) => {
  if (shutdownSignal.aborted) {
    objectStore.close();
    console.log(JSON.stringify({ level: "info", message: "Worker stopped", workerId }));
    Deno.exit(0);
  }
  throw error;
});
const { sql, repository } = connections;
workerLiveness.current = new WorkerLivenessTracker(sql, workerIdentity, workerLivenessConfig);
await retryWithBoundedBackoff({
  operation: () => runDatabaseOperation(() => workerLiveness.current!.register()),
  signal: shutdownSignal,
  policy: databaseRetryPolicy,
  shouldRetry: isWorkerRetryableDatabaseError,
});
workerLiveness.current.startHeartbeat((error) => {
  workerMetrics.recordLoopFailure("heartbeat");
  console.warn(JSON.stringify({
    level: "warn",
    message: "Worker heartbeat update failed",
    workerId,
  }));
  if (error instanceof WorkerInstanceLostError) abort();
});
if (stopping && !signalDrainPromise) {
  signalDrainPromise = workerLiveness.current.markDraining().catch(() => undefined);
}
forceCloseForShutdown = () => {
  objectStore.close();
  void sql.end({ timeout: 0 }).catch(() => undefined);
  void repository.forceClose().catch(() => undefined);
};

/**
 * Provider cancellation and the process-stop signal must not prevent the final, fenced durable
 * transition. This window has its own deadline and every underlying statement is independently
 * bounded by the pool's statement_timeout.
 */
async function runShutdownDatabaseOperation<T>(operation: () => T | PromiseLike<T>): Promise<T> {
  const deadlineAt = shutdownSettlementDeadlineAt ?? Date.now() + shutdownSettlementTimeoutMs;
  return await retryBeforeAbsoluteDeadline({
    operation: () => runDatabaseOperation(operation),
    deadlineAt,
    attemptWindowMs: databaseOperationTimeoutMs,
    policy: databaseRetryPolicy,
    shouldRetry: isWorkerRetryableDatabaseError,
  });
}

async function enqueueStaleGeneratedObjectCleanup() {
  await reconcileGeneratedCleanupBatch(sql, generatedCleanupGraceSeconds);
  await reconcileAttachmentUploadCleanupBatch(sql, generatedCleanupGraceSeconds);
}
async function initializeDurableQueues() {
  await reconcileStartupQueues(sql, {
    generatedCleanupGraceSeconds,
    embedding: knowledgeEmbeddingConfig && {
      model: knowledgeEmbeddingConfig.model,
      version: knowledgeEmbeddingConfig.version,
    },
    signal: shutdownSignal,
  });
}
await retryWithBoundedBackoff({
  operation: () => runDatabaseOperation(initializeDurableQueues),
  signal: shutdownSignal,
  policy: databaseRetryPolicy,
  shouldRetry: isWorkerRetryableDatabaseError,
  onRetry: ({ attempt, delayMs }) => {
    console.warn(JSON.stringify({
      level: "warn",
      message: "Worker queue initialization unavailable; retrying",
      attempt,
      retryDelayMs: delayMs,
      workerId,
    }));
  },
}).catch((error) => {
  if (!shutdownSignal.aborted) throw error;
});
if (!shutdownSignal.aborted) {
  await runDatabaseOperation(() => workerLiveness.current!.markRunning());
  workerMetrics.setDependencyReady("postgres", true);
  workerMetrics.setDependencyReady("s3", true);
  workerMetrics.setReady(true);
  console.log(JSON.stringify({ level: "info", message: "Worker started", workerId }));
}

let collectingOperationalMetrics = false;
async function collectOperationalMetrics(): Promise<void> {
  if (collectingOperationalMetrics || shutdownSignal.aborted) return;
  collectingOperationalMetrics = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const rows = await sql<
      { status: "queued" | "running" | "failed"; count: number; age: number }[]
    >`
      SELECT status,count(*)::integer AS count,
        COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-MIN(
          CASE WHEN status='queued' THEN LEAST(available_at,clock_timestamp())
            ELSE COALESCE(locked_at,completed_at,created_at) END
        )),0)::double precision AS age
      FROM jobs WHERE status IN ('queued','running','failed') GROUP BY status`;
    for (const status of ["queued", "running", "failed"] as const) {
      const row = rows.find((candidate) => candidate.status === status);
      workerMetrics.setQueue(status, Number(row?.count ?? 0), Number(row?.age ?? 0));
    }
    workerMetrics.setDependencyReady("postgres", true);
    workerMetrics.setReady(true);
  } catch {
    workerMetrics.setDependencyReady("postgres", false);
    workerMetrics.setReady(false);
    workerMetrics.recordLoopFailure("database");
  }
  try {
    const storageReady = await objectStore.readiness(controller.signal);
    workerMetrics.setDependencyReady("s3", storageReady);
    if (!storageReady) workerMetrics.recordLoopFailure("storage");
  } catch {
    workerMetrics.setDependencyReady("s3", false);
    workerMetrics.recordLoopFailure("storage");
  } finally {
    clearTimeout(timeout);
    collectingOperationalMetrics = false;
  }
}
await collectOperationalMetrics();
const operationalMetricsInterval = setInterval(() => void collectOperationalMetrics(), 15_000);
Deno.unrefTimer(operationalMetricsInterval);

type ProcessJobOutcome = "completed" | "deferred" | "requires_completion";

async function processJob(
  job: {
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    claimToken: string;
    idempotencyKey: string | null;
    externalDeadlineMonotonicMs: number;
  },
): Promise<ProcessJobOutcome> {
  switch (job.type) {
    case "attachment.inspect": {
      const payload = parseAttachmentInspectionPayload(job.payload);
      const remainingLeaseMs = Math.max(
        0,
        job.externalDeadlineMonotonicMs - performance.now() - jobDeadlineMarginMs,
      );
      const inspectionOperation = operationSignal(
        shutdownSignal,
        Date.now() + remainingLeaseMs,
        () => new DOMException("Attachment inspection deadline exceeded", "TimeoutError"),
      );
      const outcome = await processAttachmentInspection({
        payload,
        repository,
        objectStore,
        limits: { maxBytes: attachmentInspectionMaxBytes },
        scanner: malwareScannerConfig,
        signal: inspectionOperation.signal,
        transition: (input, audit) =>
          runDatabaseOperation(() =>
            transitionClaimedAttachmentInspection(
              sql,
              repository,
              job,
              input,
              audit,
              jobLeaseSeconds,
            )
          ),
      }).finally(inspectionOperation.dispose);
      console.log(
        JSON.stringify({
          level: "info",
          message: outcome.status === "superseded"
            ? "Attachment inspection job superseded"
            : "Attachment inspection completed",
          jobId: job.id,
          attachmentId: payload.attachmentId,
          inspectionEpoch: payload.inspectionEpoch,
          outcome: outcome.status,
        }),
      );
      return "requires_completion";
    }
    case "attachment.ingest": {
      const remainingLeaseMs = Math.max(
        0,
        job.externalDeadlineMonotonicMs - performance.now() - jobDeadlineMarginMs,
      );
      const deadlineAt = Date.now() + Math.min(
        documentExtractionLimits.timeoutMs!,
        remainingLeaseMs,
      );
      const { attachmentId, ownerId } = parseAttachmentIngestionPayload(job.payload);
      const rows = await runDatabaseOperation(() =>
        sql<{
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
        RETURNING a.object_key,a.mime_type,a.filename,a.sha256,a.size_bytes`
      );
      const source = rows[0];
      if (!source) throw new Error("Attachment ingestion claim is stale or invalid");
      const acquisition = operationSignal(
        shutdownSignal,
        deadlineAt,
        () => new DocumentPipelineTimeoutError(),
      );
      const object = await requireVerifiedIngestionObject(
        objectStore,
        source.object_key,
        {
          ownerId,
          sha256: source.sha256,
          sizeBytes: Number(source.size_bytes),
          maxBytes: documentExtractionLimits.maxRawBytes!,
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
        },
        acquisition.signal,
      ).finally(acquisition.dispose);
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
          shutdownSignal,
        ),
        attachmentId,
      );
      const committed = await retryWorkerClaimedDatabaseOperation(
        () =>
          sql.begin(async (tx) => {
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
              // Re-ingestion replaces the immutable chunk set. The old job id is intentionally
              // reused, so its completed dispatch ledger must be retired in the same transaction.
              // Usage/ledger history remains immutable because batches do not own usage runs.
              await tx`DELETE FROM document_embedding_batches b USING jobs j
                WHERE b.job_id=j.id AND j.idempotency_key=${idempotencyKey}`;
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
          }),
        () => renewJobClaim(sql, job),
        {
          signal: shutdownSignal,
          policy: databaseRetryPolicy,
          onDatabaseRetry: ({ attempt, delayMs }) => {
            console.warn(JSON.stringify({
              level: "warn",
              message: "Attachment ingestion commit unavailable; retrying under claim",
              attempt,
              retryDelayMs: delayMs,
              jobId: job.id,
              workerId,
            }));
          },
        },
      );
      if (!committed) throw new Error("Attachment ingestion claim was reclaimed");
      return "completed";
    }
    case "document.embed": {
      if (!knowledgeEmbeddingConfig) {
        throw new Error("Knowledge embedding provider is not configured");
      }
      const payload = parseDocumentEmbeddingPayload(job.payload);
      if (payload.version !== knowledgeEmbeddingConfig.version) {
        throw new Error("Document embedding job version is no longer active");
      }
      const deadlineMonotonicMs = job.externalDeadlineMonotonicMs - jobDeadlineMarginMs;
      const sourceOperation = operationSignal(
        shutdownSignal,
        Date.now() + Math.max(0, deadlineMonotonicMs - performance.now()),
        () => new DOMException("Document embedding deadline exceeded", "TimeoutError"),
      );
      const rows = await raceAbort(
        runDatabaseOperation(() =>
          sql<{ id: string; content: string }[]>`
        SELECT dc.id,dc.content FROM document_chunks dc
        JOIN attachments a ON a.id=dc.attachment_id
        JOIN jobs j ON j.id=${job.id} AND j.status='running' AND j.locked_by=${job.claimToken}
        WHERE dc.attachment_id=${payload.attachmentId} AND a.owner_id=${payload.ownerId}
          AND a.deleted_at IS NULL AND a.state='ready' AND a.ingestion_status='ready'
        ORDER BY dc.ordinal,dc.id`
        ),
        sourceOperation.signal,
      ).finally(sourceOperation.dispose);
      if (!rows.length) throw new Error("Document embedding source is stale or unavailable");
      const values: Array<{ id: string; contentSha256: string; embedding: number[] }> = [];
      for (let offset = 0; offset < rows.length; offset += knowledgeEmbeddingConfig.batchSize) {
        const batch = rows.slice(offset, offset + knowledgeEmbeddingConfig.batchSize);
        const remaining = deadlineMonotonicMs - performance.now();
        if (remaining <= 0) throw new Error("Document embedding deadline exceeded");
        const providerOperation = operationSignal(
          shutdownSignal,
          Date.now() + Math.max(0, remaining),
          () => new DOMException("Document embedding deadline exceeded", "TimeoutError"),
        );
        try {
          const content = batch.map((row) => row.content);
          const requestSha256 = await sha256(JSON.stringify(content));
          let durableBatch = await raceAbort(
            runDatabaseOperation(() =>
              prepareDurableEmbeddingBatch(
                sql,
                job,
                offset,
                requestSha256,
                content.length,
                knowledgeEmbeddingConfig.batchSize,
                embeddingTokenUpperBound(content),
              )
            ),
            providerOperation.signal,
          );
          if (
            durableBatch.phase === "dispatched" &&
            durableBatch.dispatchClaimToken !== job.claimToken
          ) {
            if (!durableBatch.retrySafe) {
              throw new UncertainEmbeddingDispatchError(durableBatch.usageRunId);
            }
            const interrupted = durableBatch;
            durableBatch = await recoverRetrySafeEmbeddingDispatch(
              interrupted,
              (terminal) =>
                retryWorkerClaimedDatabaseOperation(
                  () => repository.finalizeEmbeddingProviderUsage(terminal),
                  () => renewJobClaim(sql, job),
                  { signal: providerOperation.signal, policy: databaseRetryPolicy },
                ),
              () =>
                retryWorkerClaimedDatabaseOperation(
                  () =>
                    prepareDurableEmbeddingBatch(
                      sql,
                      job,
                      offset,
                      requestSha256,
                      content.length,
                      knowledgeEmbeddingConfig.batchSize,
                      embeddingTokenUpperBound(content),
                    ),
                  () => renewJobClaim(sql, job),
                  { signal: providerOperation.signal, policy: databaseRetryPolicy },
                ),
            );
          }
          const embeddings = durableBatch.phase === "succeeded" &&
              durableBatch.usageStatus === "completed"
            ? durableBatch.embeddings!
            : await runAccountedEmbeddingCall({
              repository,
              userId: payload.ownerId,
              usageRunId: durableBatch.usageRunId,
              purpose: "document",
              provider: new URL(knowledgeEmbeddingConfig.baseUrl).host,
              model: knowledgeEmbeddingConfig.model,
              upstreamModel: knowledgeEmbeddingConfig.upstreamModel,
              content,
              billing: knowledgeEmbeddingConfig.billing,
              isDispatchOutcomeUncertain: (error) =>
                !(error instanceof EmbeddingNotDispatchedError) &&
                (!(error instanceof EmbeddingsProviderError) ||
                  error.dispatchOutcome !== "rejected"),
              databaseOperation: async (operation) => {
                try {
                  return await retryWorkerClaimedDatabaseOperation(
                    operation,
                    () => renewJobClaim(sql, job),
                    {
                      signal: providerOperation.signal,
                      policy: databaseRetryPolicy,
                      onDatabaseRetry: ({ attempt, delayMs }) => {
                        console.warn(JSON.stringify({
                          level: "warn",
                          message:
                            "Embedding accounting database unavailable; retrying under claim",
                          attempt,
                          retryDelayMs: delayMs,
                          jobId: job.id,
                          workerId,
                        }));
                      },
                    },
                  );
                } catch (error) {
                  if (!providerOperation.signal.aborted) throw error;
                  // Reservation or attempt creation may have committed even when its response
                  // lost the deadline race. Re-run both idempotently, persist the no-fetch fact,
                  // and refund immediately so a pre-network timeout cannot become uncertain/billed.
                  await runShutdownDatabaseOperation(async () => {
                    await repository.ensureIdempotentReservation({
                      userId: payload.ownerId,
                      usageRunId: durableBatch.usageRunId,
                      model: knowledgeEmbeddingConfig.model,
                      reservedMicros: reserveEmbeddingMicros(
                        content,
                        knowledgeEmbeddingConfig.billing,
                      ),
                      provider: `embedding:${new URL(knowledgeEmbeddingConfig.baseUrl).host}`,
                      recoveryOwner: "document_embedding",
                    });
                    await repository.startEmbeddingProviderAttempt({
                      usageRunId: durableBatch.usageRunId,
                      purpose: "document",
                      provider: new URL(knowledgeEmbeddingConfig.baseUrl).host,
                      model: knowledgeEmbeddingConfig.model,
                      upstreamModel: knowledgeEmbeddingConfig.upstreamModel,
                      itemCount: content.length,
                    });
                    await markDurableEmbeddingNoFetchRetrySafe(sql, job, durableBatch);
                    await repository.finalizeEmbeddingProviderUsage({
                      usageRunId: durableBatch.usageRunId,
                      status: "failed",
                      inputTokens: 0,
                      costMicros: 0,
                      tokenSource: "none",
                      costSource: "none",
                      latencyMs: 0,
                      error: "Embedding deadline elapsed before provider dispatch",
                    });
                  });
                  throw new EmbeddingNotDispatchedError(durableBatch.usageRunId, error);
                }
              },
              terminalDatabaseOperation: (operation) =>
                providerOperation.signal.aborted
                  ? runShutdownDatabaseOperation(operation)
                  : retryWorkerClaimedDatabaseOperation(
                    operation,
                    () => renewJobClaim(sql, job),
                    { signal: providerOperation.signal, policy: databaseRetryPolicy },
                  ),
              call: async () => {
                let dispatched;
                try {
                  providerOperation.signal.throwIfAborted();
                  dispatched = await retryWorkerClaimedDatabaseOperation(
                    () => beginDurableEmbeddingDispatch(sql, job, durableBatch),
                    () => renewJobClaim(sql, job),
                    { signal: providerOperation.signal, policy: databaseRetryPolicy },
                  );
                } catch (error) {
                  if (!providerOperation.signal.aborted) throw error;
                  await runShutdownDatabaseOperation(() =>
                    markDurableEmbeddingNoFetchRetrySafe(sql, job, durableBatch)
                  );
                  throw new EmbeddingNotDispatchedError(durableBatch.usageRunId, error);
                }
                if (dispatched.phase === "succeeded" || dispatched.phase === "committed") {
                  if (
                    !dispatched.embeddings || dispatched.inputTokens === null ||
                    dispatched.latencyMs === null
                  ) throw new Error("Durable embedding response is incomplete");
                  return {
                    value: dispatched.embeddings,
                    inputTokens: dispatched.inputTokens,
                    latencyMs: dispatched.latencyMs,
                  };
                }
                const providerStarted = performance.now();
                let result;
                try {
                  result = await callEmbeddingProviderAfterFence({
                    signal: providerOperation.signal,
                    usageRunId: durableBatch.usageRunId,
                    markNoFetchRetrySafe: () =>
                      runShutdownDatabaseOperation(() =>
                        markDurableEmbeddingNoFetchRetrySafe(sql, job, durableBatch)
                      ),
                    call: () =>
                      embedKnowledgeChunks(
                        content,
                        knowledgeEmbeddingConfig,
                        providerOperation.signal,
                      ),
                  });
                } catch (error) {
                  const rejected = error instanceof EmbeddingsProviderError &&
                    error.dispatchOutcome === "rejected";
                  if (rejected) {
                    const markRejected = () =>
                      markDurableEmbeddingDispatchRetrySafe(sql, job, durableBatch);
                    if (providerOperation.signal.aborted) {
                      await runShutdownDatabaseOperation(markRejected);
                    } else {
                      await retryWorkerClaimedDatabaseOperation(
                        markRejected,
                        () => renewJobClaim(sql, job),
                        { signal: providerOperation.signal, policy: databaseRetryPolicy },
                      );
                    }
                  } else {
                    throw new UncertainEmbeddingDispatchError(durableBatch.usageRunId, error);
                  }
                  throw error;
                }
                const latencyMs = Math.max(0, Math.round(performance.now() - providerStarted));
                const recorded = await retryWorkerClaimedDatabaseOperation(
                  () =>
                    recordDurableEmbeddingResponse(
                      sql,
                      job,
                      durableBatch,
                      result.embeddings,
                      result.inputTokens,
                      latencyMs,
                    ),
                  () => renewJobClaim(sql, job),
                  { signal: providerOperation.signal, policy: databaseRetryPolicy },
                );
                return {
                  value: recorded.embeddings!,
                  inputTokens: recorded.inputTokens!,
                  latencyMs: recorded.latencyMs!,
                };
              },
            });
          const hashes = await Promise.all(batch.map((row) => sha256(row.content)));
          batch.forEach((row, index) =>
            values.push({ id: row.id, contentSha256: hashes[index], embedding: embeddings[index] })
          );
        } finally {
          providerOperation.dispose();
        }
      }
      const committed = await retryWorkerClaimedDatabaseOperation(
        () =>
          sql.begin(async (tx) => {
            if (performance.now() >= deadlineMonotonicMs) return false;
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
            await tx`UPDATE document_embedding_batches SET phase='committed',committed_at=now(),
              provider_response=NULL,updated_at=now()
              WHERE job_id=${job.id} AND phase='succeeded'`;
            return true;
          }),
        () => renewJobClaim(sql, job),
        {
          signal: shutdownSignal,
          policy: databaseRetryPolicy,
          onDatabaseRetry: ({ attempt, delayMs }) => {
            console.warn(JSON.stringify({
              level: "warn",
              message: "Embedding commit database unavailable; retrying under claim",
              attempt,
              retryDelayMs: delayMs,
              jobId: job.id,
              workerId,
            }));
          },
        },
      );
      if (!committed) throw new Error("Document embedding claim was reclaimed or changed");
      return "completed";
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
      const claimed = await runDatabaseOperation(() =>
        sql.begin(async (tx) => {
          const candidates = await tx<{
            state: string;
            object_key: string;
            attachment_id: string | null;
            cleanup_attachment: boolean;
            usage_run_id: string;
          }[]>`SELECT state,object_key,attachment_id,cleanup_attachment,usage_run_id
          FROM generated_object_staging
          WHERE id=${stageId} AND owner_id=${ownerId}`;
          const candidate = candidates[0];
          let attachmentFence: {
            state: string;
            deleted_at: Date | null;
            object_key: string;
          } | undefined;
          if (candidate?.attachment_id && candidate.cleanup_attachment) {
            // Reference writers take the same attachment row lock and require ready/not-deleted.
            // Fencing the attachment before the external delete closes the check/delete race.
            const attachments = await tx<{
              state: string;
              deleted_at: Date | null;
              object_key: string;
            }[]>`SELECT state,deleted_at,object_key FROM attachments
            WHERE id=${candidate.attachment_id} AND owner_id=${ownerId} FOR UPDATE`;
            attachmentFence = attachments[0];
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
            AND (NOT s.cleanup_attachment OR NOT EXISTS(
              SELECT 1 FROM knowledge_collection_attachments ka
              WHERE ka.attachment_id=s.attachment_id))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(SELECT 1 FROM document_chunks dc
              WHERE dc.attachment_id=s.attachment_id))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(SELECT 1 FROM generated_asset_inputs gai
              WHERE gai.attachment_id=s.attachment_id))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(SELECT 1 FROM attachments peer
              WHERE peer.owner_id=s.owner_id AND peer.object_key=s.object_key
                AND peer.id<>s.attachment_id))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(SELECT 1
              FROM generated_object_staging peer
              WHERE peer.id<>s.id AND peer.state<>'cleaned'
                AND (peer.attachment_id=s.attachment_id OR
                  peer.owner_id=s.owner_id AND peer.object_key=s.object_key)))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(SELECT 1 FROM file_upload_staging upload
              WHERE upload.attachment_id=s.attachment_id OR
                upload.owner_id=s.owner_id AND upload.object_key=s.object_key))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(
              SELECT 1 FROM attachment_upload_staging upload
              WHERE upload.attachment_id=s.attachment_id OR
                upload.owner_id=s.owner_id AND upload.object_key=s.object_key))
            AND (NOT s.cleanup_attachment OR NOT EXISTS(
              SELECT 1 FROM conversation_share_snapshots snapshot
              CROSS JOIN LATERAL jsonb_each(snapshot.source_attachments) source
              WHERE source.value->>'attachmentId'=s.attachment_id::text))
          RETURNING s.object_key,s.attachment_id,s.cleanup_attachment`;
          if (rows[0]) {
            if (rows[0].attachment_id && rows[0].cleanup_attachment) {
              const fenced = await tx`UPDATE attachments SET state='deleted',
              deleted_at=COALESCE(deleted_at,now()),updated_at=now()
              WHERE id=${rows[0].attachment_id} AND owner_id=${ownerId}
                AND state='ready' AND deleted_at IS NULL RETURNING id`;
              if (!fenced.length) {
                // The first fencing transaction may have committed even if its response was lost.
                // In that exact replay state the stage and attachment already form the durable
                // fence, so resume the idempotent object delete instead of poison-looping the job.
                const replayedFence = ["cleaning", "cleanup_pending"].includes(
                  candidate?.state ?? "",
                ) &&
                  attachmentFence?.state === "deleted" &&
                  attachmentFence.deleted_at !== null &&
                  attachmentFence.object_key === rows[0].object_key;
                if (!replayedFence) {
                  throw new Error("Generated object cleanup attachment is not ready to fence");
                }
              }
            }
            return rows[0];
          }
          const stage = candidate ? [candidate] : [];
          if (!stage.length || ["finalized", "cleaned"].includes(stage[0].state)) {
            const completed = await tx`UPDATE jobs
            SET status='completed',completed_at=now(),locked_at=NULL,
            locked_by=NULL,last_error=NULL WHERE id=${job.id} AND status='running'
            AND locked_by=${job.claimToken} RETURNING id`;
            if (!completed.length) {
              throw new Error("Generated object cleanup claim was reclaimed");
            }
            return null;
          }
          throw new Error("Generated object cleanup is fenced by a durable reference");
        })
      );
      if (!claimed) return "completed";
      const deletion = operationSignal(
        shutdownSignal,
        Date.now() + Math.max(
          0,
          job.externalDeadlineMonotonicMs - performance.now() - jobDeadlineMarginMs,
        ),
      );
      await objectStore.delete(claimed.object_key, deletion.signal).finally(deletion.dispose);
      const settlement = await runDatabaseOperation(() =>
        repository.settleGeneratedObjectCleanup(stageId, ownerId)
      );
      const completed = await runDatabaseOperation(() => completeJob(sql, job));
      if (!completed) throw new Error("Generated object cleanup claim was reclaimed");
      console.log(JSON.stringify({
        level: "info",
        message: "Generated object cleanup settled",
        jobId: job.id,
        stageId,
        storageReleased: settlement.storageReleased,
      }));
      return "completed";
    }
    case "file_object.cleanup": {
      const deletion = operationSignal(
        shutdownSignal,
        Date.now() + Math.max(
          0,
          job.externalDeadlineMonotonicMs - performance.now() - jobDeadlineMarginMs,
        ),
      );
      const outcome = await runDatabaseOperation(() =>
        processFileObjectCleanup(sql, objectStore, job, deletion.signal)
      ).finally(deletion.dispose);
      return outcome === "deferred" ? "deferred" : "completed";
    }
    case "attachment_object.cleanup": {
      const deletion = operationSignal(
        shutdownSignal,
        Date.now() + Math.max(
          0,
          job.externalDeadlineMonotonicMs - performance.now() - jobDeadlineMarginMs,
        ),
      );
      const outcome = await runDatabaseOperation(() =>
        processAttachmentObjectCleanup(
          sql,
          objectStore,
          job,
          jobLeaseSeconds,
          deletion.signal,
        )
      ).finally(deletion.dispose);
      return outcome === "deferred" ? "deferred" : "completed";
    }
    case "retention.scrub": {
      const payload = parseRetentionScrubPayload(job.payload);
      const result = await runDatabaseOperation(() => processRetentionScrub(repository, payload));
      if (!result.completed) {
        if (
          !await retryClaimSettlement(
            () => deferJob(sql, job, result.processed === 0 ? 1 : 0),
            claimSettlementOptions,
          )
        ) {
          throw new Error("Retention scrub claim was reclaimed before continuation");
        }
        return "deferred";
      }
      return "requires_completion";
    }
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

let nextGeneratedCleanupSweep = Date.now() + generatedCleanupSweepMs;
let nextTemporaryChatPurge = Date.now();
let nextRetentionScheduleCheck = Date.now();

const claimSettlementOptions = {
  signal: shutdownSignal,
  policy: databaseRetryPolicy,
  isRetryableDatabaseFault: isWorkerRetryableDatabaseError,
  onDatabaseRetry: ({ attempt, delayMs }: { attempt: number; delayMs: number }) => {
    console.warn(JSON.stringify({
      level: "warn",
      message: "Worker job settlement unavailable; retrying under claim",
      attempt,
      retryDelayMs: delayMs,
      workerId,
    }));
  },
};

async function recordApplicationJobFailure(
  job: Parameters<typeof processJob>[0],
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  if (job.type === "attachment.ingest") {
    let payload;
    try {
      payload = parseAttachmentIngestionPayload(job.payload);
    } catch {
      return await failOrRetryJob(sql, job, message);
    }
    return await recordIngestionFailure(sql, job, payload, message);
  }
  if (job.type === "attachment.inspect") {
    let payload;
    try {
      payload = parseAttachmentInspectionPayload(job.payload);
    } catch {
      return await failOrRetryJob(
        sql,
        job,
        "Attachment inspection job payload is invalid",
        1,
      );
    }
    return await recordAttachmentInspectionFailure(sql, job, payload, jobLeaseSeconds);
  }
  if (job.type === "retention.scrub") {
    let payload;
    try {
      payload = parseRetentionScrubPayload(job.payload);
    } catch {
      const associatedRunId = retentionRunIdFromJobAssociation(job);
      return associatedRunId
        ? await failOrRetryRetentionScrubJob(
          sql,
          job,
          associatedRunId,
          "invalid_job_payload",
          1,
        )
        : await failOrRetryJob(sql, job, "Retention scrub job association is invalid", 1);
    }
    return await failOrRetryRetentionScrubJob(
      sql,
      job,
      payload.runId,
      "worker_retry_exhausted",
    );
  }
  return await failOrRetryJob(sql, job, message);
}

try {
  await runResilientLoop({
    signal: shutdownSignal,
    policy: databaseRetryPolicy,
    shouldRetry: isWorkerRetryableDatabaseError,
    onRetry: ({ attempt, delayMs }) => {
      console.warn(JSON.stringify({
        level: "warn",
        message: "Worker durable loop unavailable; retrying",
        attempt,
        retryDelayMs: delayMs,
        workerId,
      }));
    },
    iteration: async () => {
      await runDatabaseOperation(() => workerLiveness.current!.markProgress());
      if (Date.now() >= nextGeneratedCleanupSweep) {
        await runDatabaseOperation(enqueueStaleGeneratedObjectCleanup);
        nextGeneratedCleanupSweep = Date.now() + generatedCleanupSweepMs;
      }
      if (Date.now() >= nextTemporaryChatPurge) {
        try {
          const purge = await runDatabaseOperation(() =>
            purgeTemporaryConversationBatch(repository, temporaryLifecycle.purgeBatchSize)
          );
          console.log(JSON.stringify({
            level: "info",
            message: "Temporary conversation purge completed",
            purged: purge.conversationIds.length,
            hasMore: purge.hasMore,
          }));
          nextTemporaryChatPurge = Date.now() +
            (purge.hasMore ? pollMs : temporaryLifecycle.purgeIntervalMs);
        } catch (error) {
          if (error instanceof DatabaseOperationError) throw error;
          logOperationalFailure("worker_temporary_conversation_purge");
          nextTemporaryChatPurge = Date.now() + temporaryLifecycle.purgeIntervalMs;
        }
      }
      if (Date.now() >= nextRetentionScheduleCheck) {
        try {
          const schedule = await runDatabaseOperation(() =>
            scheduleAutomaticRetention(repository, retentionScheduler)
          );
          workerMetrics.setRetentionScheduleOverdue(schedule.overdueSeconds);
          workerMetrics.recordRetentionScheduleOutcome(
            schedule.scheduled ? "scheduled" : "not_due",
          );
          if (schedule.scheduled) {
            console.log(JSON.stringify({
              level: "info",
              message: "Automatic retention scrub enqueued",
              runId: schedule.run?.id,
              reason: schedule.reason,
              policyVersion: schedule.run?.policy.version,
              overdueSeconds: schedule.overdueSeconds,
              nextDueAt: schedule.nextDueAt,
            }));
          }
          nextRetentionScheduleCheck = Date.now() + retentionScheduler.pollIntervalMs;
        } catch (error) {
          workerMetrics.recordRetentionScheduleOutcome("failed");
          nextRetentionScheduleCheck = Date.now() + retentionScheduler.pollIntervalMs;
          if (error instanceof DatabaseOperationError) throw error;
          logOperationalFailure("worker_retention_scheduler");
        }
      }
      const job = await runDatabaseOperation(() => claimJob(sql, workerId, jobLeaseSeconds));
      if (!job) {
        await abortableDelay(pollMs, shutdownSignal);
        return;
      }
      await markClaimedJobProgressOrNeutralDefer({
        markProgress: () =>
          runDatabaseOperation(() =>
            workerLiveness.current!.markProgress({ id: job.id, type: job.type })
          ),
        neutralDefer: () =>
          shutdownSignal.aborted
            ? runShutdownDatabaseOperation(() => deferJob(sql, job, 0))
            : retryClaimSettlement(() => deferJob(sql, job, 0), claimSettlementOptions),
      });
      let durablyCompleted = false;
      const jobMetricStarted = performance.now();
      let jobMetricOutcome = "failed";
      try {
        const outcome = await withOperationalSpan(
          "worker.job.process",
          { "job.type": boundedJobType(job.type) },
          () => processJob(job),
        );
        if (outcome === "completed") {
          durablyCompleted = true;
          jobMetricOutcome = "completed";
        } else if (outcome === "deferred") {
          jobMetricOutcome = "deferred";
        } else if (outcome === "requires_completion") {
          durablyCompleted = await retryClaimSettlement(
            () => completeJob(sql, job),
            claimSettlementOptions,
          );
          jobMetricOutcome = durablyCompleted ? "completed" : "failed";
        }
      } catch (error) {
        if (error instanceof UncertainEmbeddingDispatchError) {
          const terminalized = await runShutdownDatabaseOperation(() =>
            terminalizeUncertainEmbeddingDispatch(sql, job, error.usageRunId)
          );
          if (!terminalized) {
            console.warn(JSON.stringify({
              level: "warn",
              message: "Uncertain embedding dispatch was already reclaimed or terminalized",
              jobId: job.id,
              usageRunId: error.usageRunId,
              workerId,
            }));
          }
          return;
        }
        if (shutdownSignal.aborted) {
          jobMetricOutcome = "cancelled";
          const deferred = await runShutdownDatabaseOperation(() => deferJob(sql, job, 0));
          if (!deferred) {
            console.warn(JSON.stringify({
              level: "warn",
              message: "Shutdown could not neutrally release an already-reclaimed job",
              jobId: job.id,
              workerId,
            }));
          }
          return;
        }
        if (error instanceof EmbeddingNotDispatchedError) {
          jobMetricOutcome = "deferred";
          // Avoid a hot reclaim loop when the lease-derived deadline is consistently too short.
          await runShutdownDatabaseOperation(() => deferJob(sql, job, 1));
          return;
        }
        const disposition = await settleClaimedJobFault({
          ...claimSettlementOptions,
          fault: error,
          neutralDefer: () => deferJob(sql, job, 5),
          recordApplicationFailure: () => recordApplicationJobFailure(job, error),
        });
        if (disposition === "database_fault_deferred") {
          jobMetricOutcome = "deferred";
          console.warn(JSON.stringify({
            level: "warn",
            message: "Worker deferred job after transient database fault",
            jobId: job.id,
            workerId,
          }));
        }
      } finally {
        workerMetrics.recordJobOutcome(
          job.type,
          jobMetricOutcome,
          (performance.now() - jobMetricStarted) / 1_000,
        );
        const recordProgress = () =>
          workerLiveness.current!.markProgress(undefined, durablyCompleted);
        await (shutdownSignal.aborted
          ? runShutdownDatabaseOperation(recordProgress)
          : runDatabaseOperation(recordProgress)).catch(() => undefined);
      }
    },
  });
} finally {
  workerMetrics.setReady(false);
  clearInterval(operationalMetricsInterval);
  const closeDeadline = shutdownSettlementDeadlineAt ?? Date.now() + shutdownSettlementTimeoutMs;
  // Natural fatal exits need the same hard boundary as SIGTERM. Keep either watchdog armed until
  // every graceful or forced closure has positively resolved; rejection is not proof of closure.
  disposeShutdownWatchdog ??= armShutdownWatchdog(
    Math.max(1, closeDeadline - Date.now()),
    forceCloseForShutdown,
  );
  let closureProven = false;
  try {
    workerLiveness.current?.stopHeartbeat();
    await signalDrainPromise;
    await runShutdownDatabaseOperation(() => workerLiveness.current!.markDraining()).catch(() =>
      undefined
    );
    await runShutdownDatabaseOperation(() => workerLiveness.current!.markStopped()).catch(() =>
      undefined
    );
    await closeResourcesBeforeDeadline({
      graceful: [
        () => sql.end({ timeout: 5 }),
        () => repository.close(),
        () => objectStore.close(),
        () => workerMetricsServer?.close(),
        () => telemetry.shutdown(),
      ],
      forced: [
        () => sql.end({ timeout: 0 }),
        () => repository.forceClose(),
        () => objectStore.close(),
        () => workerMetricsServer?.close(),
        () => telemetry.shutdown(),
      ],
      deadlineAt: closeDeadline,
      forcedWindowMs: Math.min(
        databaseOperationTimeoutMs,
        Math.max(1, Math.floor((closeDeadline - Date.now()) / 2)),
      ),
    });
    closureProven = true;
  } finally {
    if (closureProven) disposeShutdownWatchdog?.();
  }
  console.log(JSON.stringify({ level: "info", message: "Worker stopped", workerId }));
}
