import postgres from "npm:postgres@3.4.7";
import type { ClaimedJob } from "./job-queue.ts";

type Sql = ReturnType<typeof postgres>;
type BatchPhase = "pre_dispatch" | "dispatched" | "succeeded" | "committed";

export interface DurableEmbeddingBatch {
  jobId: string;
  batchOrdinal: number;
  dispatchEpoch: number;
  usageRunId: string;
  requestSha256: string;
  itemCount: number;
  batchSize: number;
  maximumInputTokens: number;
  phase: BatchPhase;
  embeddings: number[][] | null;
  inputTokens: number | null;
  latencyMs: number | null;
  usageStatus: "missing" | "reserved" | "completed" | "failed";
  retrySafe: boolean;
  dispatchClaimToken: string | null;
  dispatchedAt: string | null;
}

export class UncertainEmbeddingDispatchError extends Error {
  constructor(readonly usageRunId: string, cause?: unknown) {
    super("Embedding provider dispatch outcome is uncertain; refusing a duplicate request", {
      cause,
    });
    this.name = "UncertainEmbeddingDispatchError";
  }
}

/** The job deadline fired before fetch was invoked; no provider charge is possible. */
export class EmbeddingNotDispatchedError extends Error {
  constructor(readonly usageRunId: string, cause?: unknown) {
    super("Embedding deadline elapsed before provider dispatch", { cause });
    this.name = "EmbeddingNotDispatchedError";
  }
}

/**
 * The only gateway from a durable dispatch marker to provider I/O. An already-elapsed deadline is
 * made retry-safe before `call` is even evaluated, providing a directly testable no-fetch proof.
 */
export async function callEmbeddingProviderAfterFence<T>(options: {
  signal: AbortSignal;
  usageRunId: string;
  markNoFetchRetrySafe: () => Promise<void>;
  call: () => Promise<T>;
}): Promise<T> {
  try {
    options.signal.throwIfAborted();
  } catch (error) {
    await options.markNoFetchRetrySafe();
    throw new EmbeddingNotDispatchedError(options.usageRunId, error);
  }
  return await options.call();
}

/**
 * Makes an ambiguous provider dispatch durably operator-visible without ever replaying it. The
 * accounting lease reaper remains responsible for conservative settlement if the provider result
 * could not be recorded. This transition deliberately does not consume the ordinary application
 * retry budget: retrying cannot make an unknowable provider outcome safe.
 */
export async function terminalizeUncertainEmbeddingDispatch(
  sql: Sql,
  job: ClaimedJob,
  usageRunId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`UPDATE jobs j SET status='failed',
    last_error='Embedding provider outcome is uncertain; manual reconciliation may be required',
    completed_at=now(),locked_at=NULL,locked_by=NULL
    WHERE j.id=${job.id} AND j.type='document.embed' AND j.status='running'
      AND j.locked_by=${job.claimToken}
      AND EXISTS(SELECT 1 FROM document_embedding_batches b
        WHERE b.job_id=j.id AND b.usage_run_id=${usageRunId}
          AND b.phase='dispatched' AND b.retry_safe=false)
    RETURNING j.id`;
  return Boolean(rows[0]);
}

export interface RetrySafeEmbeddingSettlement {
  usageRunId: string;
  status: "failed";
  inputTokens: 0;
  costMicros: 0;
  tokenSource: "none";
  costSource: "none";
  latencyMs: number;
  error: string;
}

/**
 * Closes the only safe dispatch-recovery window: the provider durably rejected the request, but
 * the worker stopped before its zero-cost accounting settlement committed. Settlement is
 * idempotent, and the reload advances the durable batch epoch only after accounting proves that no
 * charge occurred. No provider operation belongs inside either callback.
 */
export async function recoverRetrySafeEmbeddingDispatch(
  interrupted: DurableEmbeddingBatch,
  settle: (input: RetrySafeEmbeddingSettlement) => Promise<unknown>,
  reload: () => Promise<DurableEmbeddingBatch>,
): Promise<DurableEmbeddingBatch> {
  if (interrupted.phase !== "dispatched" || !interrupted.retrySafe) {
    throw new TypeError("Only a definitively rejected embedding dispatch can be recovered");
  }
  const dispatchedAt = interrupted.dispatchedAt === null
    ? Number.NaN
    : Date.parse(interrupted.dispatchedAt);
  const latencyMs = Number.isFinite(dispatchedAt)
    ? Math.min(2_147_483_647, Math.max(0, Date.now() - dispatchedAt))
    : 0;
  await settle({
    usageRunId: interrupted.usageRunId,
    status: "failed",
    inputTokens: 0,
    costMicros: 0,
    tokenSource: "none",
    costSource: "none",
    latencyMs,
    error: "Definitive embedding rejection recovered after worker interruption",
  });
  const recovered = await reload();
  if (
    recovered.phase !== "pre_dispatch" || recovered.retrySafe ||
    recovered.dispatchEpoch !== interrupted.dispatchEpoch + 1 ||
    recovered.usageRunId === interrupted.usageRunId
  ) throw new Error("Retry-safe embedding dispatch did not advance after zero-cost settlement");
  return recovered;
}

type Row = Record<string, unknown>;
const integer = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Durable embedding batch is corrupt");
  return parsed;
};

function batch(row: Row): DurableEmbeddingBatch {
  const response = row.provider_response as { embeddings?: unknown } | null;
  const embeddings = response?.embeddings;
  if (embeddings !== undefined && !Array.isArray(embeddings)) {
    throw new Error("Durable embedding response is corrupt");
  }
  return {
    jobId: String(row.job_id),
    batchOrdinal: integer(row.batch_ordinal),
    dispatchEpoch: integer(row.dispatch_epoch),
    usageRunId: String(row.usage_run_id),
    requestSha256: String(row.request_sha256),
    itemCount: integer(row.item_count),
    batchSize: integer(row.batch_size),
    maximumInputTokens: integer(row.maximum_input_tokens),
    phase: String(row.phase) as BatchPhase,
    embeddings: embeddings === undefined ? null : embeddings as number[][],
    inputTokens: row.input_tokens === null ? null : integer(row.input_tokens),
    latencyMs: row.latency_ms === null ? null : integer(row.latency_ms),
    usageStatus: ["reserved", "completed", "failed"].includes(String(row.usage_status))
      ? String(row.usage_status) as "reserved" | "completed" | "failed"
      : "missing",
    retrySafe: row.retry_safe === true,
    dispatchClaimToken: row.dispatch_claim_token === null ? null : String(row.dispatch_claim_token),
    dispatchedAt: row.dispatched_at === null
      ? null
      : row.dispatched_at instanceof Date
      ? row.dispatched_at.toISOString()
      : String(row.dispatched_at),
  };
}

function validatePreparation(
  batchOrdinal: number,
  requestSha256: string,
  itemCount: number,
  batchSize: number,
  maximumInputTokens: number,
): void {
  if (
    !Number.isSafeInteger(batchOrdinal) || batchOrdinal < 0 ||
    !/^[0-9a-f]{64}$/.test(requestSha256) || !Number.isSafeInteger(itemCount) ||
    itemCount < 1 || itemCount > 256 || !Number.isSafeInteger(batchSize) || batchSize < 1 ||
    batchSize > 256 || batchOrdinal % batchSize !== 0 || itemCount > batchSize ||
    !Number.isSafeInteger(maximumInputTokens) || maximumInputTokens < 0
  ) throw new TypeError("Durable embedding batch identity is invalid");
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (part) => part.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Creates the stable batch identity under the job fence. A definitively failed, zero-cost request
 * may advance to a new epoch; an unaccounted dispatch remains permanently uncertain.
 */
export async function prepareDurableEmbeddingBatch(
  sql: Sql,
  job: ClaimedJob,
  batchOrdinal: number,
  requestSha256: string,
  itemCount: number,
  batchSize: number,
  maximumInputTokens: number,
): Promise<DurableEmbeddingBatch> {
  validatePreparation(batchOrdinal, requestSha256, itemCount, batchSize, maximumInputTokens);
  return await sql.begin(async (tx) => {
    const fence = await tx`SELECT id FROM jobs WHERE id=${job.id} AND type='document.embed'
      AND status='running' AND locked_by=${job.claimToken} FOR UPDATE`;
    if (!fence.length) throw new Error("Document embedding claim was reclaimed");
    let rows = await tx<Row[]>`SELECT * FROM document_embedding_batches
      WHERE job_id=${job.id} AND batch_ordinal=${batchOrdinal} FOR UPDATE`;
    if (!rows[0]) {
      const usageRunId = `${job.id}:embedding:${batchOrdinal}:0`;
      rows = await tx<Row[]>`INSERT INTO document_embedding_batches(
        job_id,batch_ordinal,usage_run_id,request_sha256,item_count,batch_size,maximum_input_tokens)
        VALUES(${job.id},${batchOrdinal},${usageRunId},${requestSha256},${itemCount},${batchSize},
          ${maximumInputTokens})
        RETURNING *`;
    }
    let current = rows[0];
    if (
      String(current.request_sha256) !== requestSha256 ||
      integer(current.item_count) !== itemCount || integer(current.batch_size) !== batchSize ||
      integer(current.maximum_input_tokens) !== maximumInputTokens
    ) throw new Error("Document embedding batch input changed after durable preparation");

    // A completed job is only enqueued again when its published vectors are missing. Its compacted
    // response is no longer available, so create a new, explicitly billed dispatch epoch.
    if (String(current.phase) === "committed") {
      const epoch = integer(current.dispatch_epoch) + 1;
      const usageRunId = `${job.id}:embedding:${batchOrdinal}:${epoch}`;
      const reset = await tx<Row[]>`UPDATE document_embedding_batches SET
        dispatch_epoch=${epoch},usage_run_id=${usageRunId},phase='pre_dispatch',retry_safe=false,
        dispatch_claim_token=NULL,provider_response=NULL,provider_response_sha256=NULL,
        input_tokens=NULL,latency_ms=NULL,dispatched_at=NULL,responded_at=NULL,committed_at=NULL,
        updated_at=now() WHERE job_id=${job.id} AND batch_ordinal=${batchOrdinal} RETURNING *`;
      current = reset[0];
    }

    if (["pre_dispatch", "dispatched"].includes(String(current.phase))) {
      const terminal = await tx<Row[]>`SELECT r.status AS run_status,a.status AS attempt_status,
        a.cost_micros FROM usage_runs r
        JOIN embedding_provider_attempts a ON a.usage_run_id=r.id
        WHERE r.id=${String(current.usage_run_id)}`;
      // A pre_dispatch failure proves fetch was never eligible. A dispatched failure advances only
      // with the explicit retry-safe marker. Both must also have durable zero-cost accounting;
      // reaper cancellation charges the reservation and therefore never enters this branch.
      if (
        (String(current.phase) === "pre_dispatch" || current.retry_safe === true) &&
        terminal[0]?.run_status === "failed" &&
        terminal[0]?.attempt_status === "failed" &&
        integer(terminal[0]?.cost_micros) === 0
      ) {
        const epoch = integer(current.dispatch_epoch) + 1;
        const usageRunId = `${job.id}:embedding:${batchOrdinal}:${epoch}`;
        const reset = await tx<Row[]>`UPDATE document_embedding_batches SET
          dispatch_epoch=${epoch},usage_run_id=${usageRunId},phase='pre_dispatch',retry_safe=false,
          dispatch_claim_token=NULL,dispatched_at=NULL,updated_at=now()
          WHERE job_id=${job.id} AND batch_ordinal=${batchOrdinal} RETURNING *`;
        current = reset[0];
      }
    }
    const usage = await tx<Row[]>`SELECT status FROM usage_runs
      WHERE id=${String(current.usage_run_id)}`;
    return batch({ ...current, usage_status: usage[0]?.status ?? null });
  });
}

/** The committed transition is the point of no return before the network call. */
export async function beginDurableEmbeddingDispatch(
  sql: Sql,
  job: ClaimedJob,
  prepared: DurableEmbeddingBatch,
): Promise<DurableEmbeddingBatch> {
  return await sql.begin(async (tx) => {
    const rows = await tx<Row[]>`UPDATE document_embedding_batches b SET
      phase='dispatched',dispatch_claim_token=${job.claimToken},dispatched_at=now(),updated_at=now()
      FROM jobs j WHERE b.job_id=${job.id} AND b.batch_ordinal=${prepared.batchOrdinal}
        AND b.usage_run_id=${prepared.usageRunId} AND b.phase='pre_dispatch'
        AND j.id=b.job_id AND j.status='running' AND j.locked_by=${job.claimToken}
      RETURNING b.*`;
    if (rows[0]) return batch(rows[0]);
    const existing = await tx<Row[]>`SELECT * FROM document_embedding_batches
      WHERE job_id=${job.id} AND batch_ordinal=${prepared.batchOrdinal}`;
    if (!existing[0]) throw new Error("Durable embedding batch was removed");
    const value = batch(existing[0]);
    if (value.usageRunId !== prepared.usageRunId) {
      throw new Error("Durable embedding batch epoch changed");
    }
    if (value.phase === "dispatched" && value.dispatchClaimToken === job.claimToken) return value;
    if (value.phase === "dispatched") throw new UncertainEmbeddingDispatchError(value.usageRunId);
    if (value.phase === "succeeded" || value.phase === "committed") return value;
    throw new Error("Document embedding claim was reclaimed before dispatch");
  });
}

/** Persists the complete response under the same job claim before usage is settled. */
export async function recordDurableEmbeddingResponse(
  sql: Sql,
  job: ClaimedJob,
  prepared: DurableEmbeddingBatch,
  embeddings: number[][],
  inputTokens: number,
  latencyMs: number,
): Promise<DurableEmbeddingBatch> {
  if (
    embeddings.length !== prepared.itemCount || !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 || !Number.isSafeInteger(latencyMs) || latencyMs < 0
  ) throw new TypeError("Durable embedding response is invalid");
  const responseSha256 = await sha256Json(embeddings);
  return await sql.begin(async (tx) => {
    const jobs = await tx<Row[]>`SELECT status FROM jobs WHERE id=${job.id} FOR UPDATE`;
    const rows = await tx<Row[]>`SELECT * FROM document_embedding_batches
      WHERE job_id=${job.id} AND batch_ordinal=${prepared.batchOrdinal} FOR UPDATE`;
    const existing = rows[0];
    const matches = existing && String(existing.usage_run_id) === prepared.usageRunId &&
      String(existing.dispatch_claim_token) === job.claimToken;
    if (
      matches && existing.phase === "succeeded" && Number(existing.input_tokens) === inputTokens &&
      Number(existing.latency_ms) === latencyMs &&
      String(existing.provider_response_sha256) === responseSha256
    ) return batch(existing);
    if (
      !matches || existing.phase !== "dispatched" ||
      !["queued", "running"].includes(String(jobs[0]?.status))
    ) throw new Error("Embedding response arrived after its durable dispatch became terminal");
    const updated = await tx<Row[]>`UPDATE document_embedding_batches SET
      phase='succeeded',retry_safe=false,provider_response=${tx.json({ embeddings })},
      provider_response_sha256=${responseSha256},input_tokens=${inputTokens},
      latency_ms=${latencyMs},responded_at=now(),updated_at=now()
      WHERE job_id=${job.id} AND batch_ordinal=${prepared.batchOrdinal} RETURNING *`;
    return batch(updated[0]);
  });
}

/** Records that an explicit HTTP rejection made a later dispatch safe; transport loss never does. */
export async function markDurableEmbeddingDispatchRetrySafe(
  sql: Sql,
  job: ClaimedJob,
  prepared: DurableEmbeddingBatch,
): Promise<void> {
  const rows = await sql`UPDATE document_embedding_batches b SET retry_safe=true,updated_at=now()
    FROM jobs j WHERE b.job_id=${job.id} AND b.batch_ordinal=${prepared.batchOrdinal}
      AND b.usage_run_id=${prepared.usageRunId} AND b.phase='dispatched'
      AND j.id=b.job_id AND j.status='running' AND j.locked_by=${job.claimToken}
    RETURNING b.job_id`;
  if (!rows[0]) throw new Error("Embedding rejection arrived after the job claim was reclaimed");
}

/**
 * Persists the stronger fact available before `fetch`: irrespective of whether the dispatch-marker
 * commit response was lost, the provider call was never invoked. This makes zero-cost settlement
 * and a later epoch safe without weakening post-fetch uncertainty handling.
 */
export async function markDurableEmbeddingNoFetchRetrySafe(
  sql: Sql,
  job: ClaimedJob,
  prepared: DurableEmbeddingBatch,
): Promise<void> {
  const rows = await sql`UPDATE document_embedding_batches b SET
    retry_safe=CASE WHEN b.phase='dispatched' THEN true ELSE false END,updated_at=now()
    FROM jobs j WHERE b.job_id=${job.id} AND b.batch_ordinal=${prepared.batchOrdinal}
      AND b.usage_run_id=${prepared.usageRunId} AND b.phase IN ('pre_dispatch','dispatched')
      AND j.id=b.job_id AND j.status='running' AND j.locked_by=${job.claimToken}
    RETURNING b.job_id`;
  if (!rows[0]) throw new Error("Embedding no-fetch state arrived after the job was reclaimed");
}
