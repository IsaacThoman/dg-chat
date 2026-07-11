import postgres from "npm:postgres@3.4.7";

type Sql = ReturnType<typeof postgres>;

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  claimToken: string;
}

export async function claimJob(
  sql: Sql,
  workerId: string,
  leaseSeconds: number,
): Promise<ClaimedJob | undefined> {
  const claimToken = `${workerId}:${crypto.randomUUID()}`;
  return await sql.begin(async (tx) => {
    const rows = await tx<{ id: string; type: string; payload: unknown; attempts: number }[]>`
      SELECT id, type, payload, attempts FROM jobs
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
    const claimed = await tx<{ id: string }[]>`
      UPDATE jobs
      SET status = 'running', locked_at = now(), locked_by = ${claimToken},
          attempts = attempts + 1
      WHERE id = ${job.id}
      RETURNING id
    `;
    if (!claimed[0]) return undefined;
    return { ...job, claimToken };
  });
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

export async function heartbeatJob(sql: Sql, job: ClaimedJob): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`UPDATE jobs SET locked_at=now()
    WHERE id=${job.id} AND status='running' AND locked_by=${job.claimToken} RETURNING id`;
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
  const retry = job.attempts + 1 < maxAttempts;
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
