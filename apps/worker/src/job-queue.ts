import postgres from "npm:postgres@3.4.7";

type Sql = ReturnType<typeof postgres>;

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  claimToken: string;
  idempotencyKey: string | null;
  /** Local monotonic boundary conservatively derived from the database lease budget. */
  externalDeadlineMonotonicMs: number;
}

export function conservativeClaimDeadline(input: {
  claimStartedMonotonicMs: number;
  claimFinishedMonotonicMs: number;
  databaseRemainingLeaseMs: number;
}): number {
  const { claimStartedMonotonicMs, claimFinishedMonotonicMs, databaseRemainingLeaseMs } = input;
  if (
    ![claimStartedMonotonicMs, claimFinishedMonotonicMs, databaseRemainingLeaseMs].every(
      Number.isFinite,
    ) || claimFinishedMonotonicMs < claimStartedMonotonicMs || databaseRemainingLeaseMs < 0
  ) throw new TypeError("Claim lease timing is invalid");
  const fullRoundTripMs = claimFinishedMonotonicMs - claimStartedMonotonicMs;
  return claimFinishedMonotonicMs + Math.max(0, databaseRemainingLeaseMs - fullRoundTripMs);
}

export async function claimJob(
  sql: Sql,
  workerId: string,
  leaseSeconds: number,
): Promise<ClaimedJob | undefined> {
  const claimToken = `${workerId}:${crypto.randomUUID()}`;
  const claimStartedMonotonicMs = performance.now();
  const result = await sql.begin(async (tx) => {
    const rows = await tx<
      {
        id: string;
        type: string;
        payload: unknown;
        attempts: number;
        idempotency_key: string | null;
      }[]
    >`
      SELECT id, type, payload, attempts, idempotency_key FROM jobs
      WHERE
        (status = 'queued' AND available_at <= now())
        OR
        (status = 'running' AND (locked_at IS NULL OR locked_at <= now() - ${leaseSeconds} * interval '1 second'))
      ORDER BY
        CASE WHEN status = 'queued' THEN available_at ELSE locked_at END NULLS FIRST,
        created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
    `;
    const job = rows[0];
    if (!job) return undefined;
    const claimed = await tx<{ id: string; remaining_lease_ms: number | string }[]>`
      UPDATE jobs
      SET status = 'running', locked_at = now(), locked_by = ${claimToken},
          attempts = attempts + 1
      WHERE id = ${job.id}
      RETURNING id,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM
        ((locked_at + ${leaseSeconds} * interval '1 second') - clock_timestamp())) * 1000))::bigint
        AS remaining_lease_ms
    `;
    if (!claimed[0]) return undefined;
    return {
      ...job,
      idempotencyKey: job.idempotency_key,
      claimToken,
      databaseRemainingLeaseMs: Number(claimed[0].remaining_lease_ms),
    };
  });
  if (!result) return undefined;
  const claimFinishedMonotonicMs = performance.now();
  const externalDeadlineMonotonicMs = conservativeClaimDeadline({
    claimStartedMonotonicMs,
    claimFinishedMonotonicMs,
    databaseRemainingLeaseMs: result.databaseRemainingLeaseMs,
  });
  return {
    id: result.id,
    type: result.type,
    payload: result.payload,
    attempts: result.attempts,
    claimToken: result.claimToken,
    idempotencyKey: result.idempotencyKey,
    externalDeadlineMonotonicMs,
  };
}

export async function completeJob(sql: Sql, job: ClaimedJob): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE jobs
    SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL
    WHERE id = ${job.id} AND status = 'running' AND locked_by = ${job.claimToken}
    RETURNING id
  `;
  return Boolean(rows[0]);
}

/**
 * Renews only the database reclaim fence; a reclaimed job can never be resurrected by stale work.
 * `job.externalDeadlineMonotonicMs` deliberately remains the original external-operation
 * deadline, so renewal cannot authorize a new or longer provider/object-store operation.
 */
export async function renewJobClaim(sql: Sql, job: ClaimedJob): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE jobs SET locked_at=now()
    WHERE id=${job.id} AND status='running' AND locked_by=${job.claimToken}
    RETURNING id
  `;
  return Boolean(rows[0]);
}

export async function deferJob(
  sql: Sql,
  job: ClaimedJob,
  delaySeconds: number,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE jobs
    SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
        available_at = now() + ${delaySeconds} * interval '1 second',
        last_error = NULL, locked_at = NULL, locked_by = NULL
    WHERE id = ${job.id} AND status = 'running' AND locked_by = ${job.claimToken}
    RETURNING id
  `;
  return Boolean(rows[0]);
}

export async function failOrRetryJob(
  sql: Sql,
  job: ClaimedJob,
  message: string,
  maxAttempts = 5,
): Promise<boolean> {
  const retry = jobFailureWillRetry(job, maxAttempts);
  const rows = await sql<{ id: string }[]>`
    UPDATE jobs
    SET status = ${retry ? "queued" : "failed"}, last_error = ${message},
        available_at = now() + ${Math.min(300, 2 ** job.attempts)} * interval '1 second',
        locked_at = NULL, locked_by = NULL
    WHERE id = ${job.id} AND status = 'running' AND locked_by = ${job.claimToken}
    RETURNING id
  `;
  return Boolean(rows[0]);
}

/** Atomically fences the claimed job and its scrub run when the retry budget is exhausted. */
export type RetentionScrubJobFailureCode = "worker_retry_exhausted" | "invalid_job_payload";

const retentionFailure = (code: RetentionScrubJobFailureCode) =>
  code === "invalid_job_payload"
    ? {
      job: "Retention scrub job payload is invalid",
      run: "Retention scrub stopped because its durable job payload was invalid",
    }
    : {
      job: "Retention scrub attempt failed",
      run: "Retention scrub failed after the retry limit",
    };

export function retentionRunIdFromJobAssociation(
  job: Pick<ClaimedJob, "type" | "idempotencyKey">,
): string | undefined {
  if (job.type !== "retention.scrub" || !job.idempotencyKey) return undefined;
  return job.idempotencyKey.match(
    /^retention\.scrub:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu,
  )?.[1];
}

export async function failOrRetryRetentionScrubJob(
  sql: Sql,
  job: ClaimedJob,
  runId: string,
  code: RetentionScrubJobFailureCode,
  maxAttempts = 5,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
    throw new TypeError("Retention scrub run id is invalid");
  }
  const message = retentionFailure(code);
  const retry = jobFailureWillRetry(job, maxAttempts);
  return await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      UPDATE jobs SET status=${retry ? "queued" : "failed"},last_error=${message.job},
        available_at=now()+${Math.min(300, 2 ** job.attempts)}*interval '1 second',
        locked_at=NULL,locked_by=NULL
      WHERE id=${job.id} AND type='retention.scrub' AND status='running'
        AND locked_by=${job.claimToken} RETURNING id`;
    if (!rows[0]) return false;
    if (!retry) {
      const failed = await tx<{ id: string; policy_version: number }[]>`
        UPDATE retention_scrub_runs SET status='failed',
          error=${message.run},completed_at=now()
        WHERE id=${runId}::uuid AND status IN ('queued','running')
        RETURNING id,policy_version`;
      if (failed[0]) {
        await tx`INSERT INTO audit_events(action,target_type,target_id,metadata)
          VALUES('retention.scrub.failed','retention_scrub_run',${runId},
            ${tx.json({ policyVersion: failed[0].policy_version, code })})`;
      }
    }
    return true;
  });
}

export function jobFailureWillRetry(job: Pick<ClaimedJob, "attempts">, maxAttempts = 5): boolean {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("Maximum job attempts must be a positive integer");
  }
  return job.attempts + 1 < maxAttempts;
}
