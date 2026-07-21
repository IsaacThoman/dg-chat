import type postgres from "npm:postgres@3.4.7";
import type { ObjectStore } from "@dg-chat/database";

type Sql = ReturnType<typeof postgres>;

export type WorkerState = "starting" | "running" | "draining" | "stopped";

export interface WorkerLivenessConfig {
  heartbeatIntervalMs: number;
  heartbeatStaleMs: number;
  progressStaleMs: number;
  healthTimeoutMs: number;
  healthClockToleranceMs: number;
  instanceFile: string;
  historyRetentionHours: number;
}

export interface WorkerInstanceSnapshot {
  instanceId: string;
  workerName: string;
  state: WorkerState;
  heartbeatAt: Date;
  progressAt: Date;
  currentJobId: string | null;
  currentJobType: string | null;
  lastCompletedAt: Date | null;
  lastCompletedJobId: string | null;
  lastCompletedJobType: string | null;
}

export class WorkerInstanceLostError extends Error {
  constructor() {
    super("The current worker boot no longer owns a durable liveness row");
    this.name = "WorkerInstanceLostError";
  }
}

function integerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function parseWorkerLivenessConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): WorkerLivenessConfig {
  const heartbeatIntervalMs = integerEnv(
    env,
    "WORKER_HEARTBEAT_INTERVAL_MS",
    5_000,
    250,
    60_000,
  );
  const heartbeatStaleMs = integerEnv(
    env,
    "WORKER_HEARTBEAT_STALE_MS",
    20_000,
    1_000,
    300_000,
  );
  const progressStaleMs = integerEnv(
    env,
    "WORKER_PROGRESS_STALE_MS",
    180_000,
    1_000,
    3_600_000,
  );
  const healthTimeoutMs = integerEnv(
    env,
    "WORKER_HEALTH_TIMEOUT_MS",
    4_000,
    250,
    30_000,
  );
  const healthClockToleranceMs = integerEnv(
    env,
    "WORKER_HEALTH_CLOCK_TOLERANCE_MS",
    5_000,
    0,
    60_000,
  );
  const historyRetentionHours = integerEnv(
    env,
    "WORKER_INSTANCE_RETENTION_HOURS",
    168,
    1,
    8_760,
  );
  if (heartbeatStaleMs < heartbeatIntervalMs * 2) {
    throw new Error("WORKER_HEARTBEAT_STALE_MS must be at least two heartbeat intervals");
  }
  return {
    heartbeatIntervalMs,
    heartbeatStaleMs,
    progressStaleMs,
    healthTimeoutMs,
    healthClockToleranceMs,
    historyRetentionHours,
    instanceFile: env.WORKER_INSTANCE_FILE?.trim() || "/tmp/dg-chat-worker-instance",
  };
}

function boundedWorkerName(value: string) {
  const name = value.trim();
  if (!name || name.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(name)) {
    throw new Error("WORKER_ID must contain 1-128 safe identifier characters");
  }
  return name;
}

export function newWorkerIdentity(workerName: string) {
  return { workerName: boundedWorkerName(workerName), instanceId: crypto.randomUUID() };
}

export async function writeWorkerInstanceFile(path: string, instanceId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) {
    throw new Error("Worker instance identity is invalid");
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temporary, `${instanceId}\n`, { mode: 0o600 });
  await Deno.rename(temporary, path);
}

export async function readWorkerInstanceFile(path: string) {
  const value = (await Deno.readTextFile(path)).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Worker instance file is invalid");
  }
  return value;
}

export class WorkerLivenessTracker {
  readonly #sql: Sql;
  readonly #instanceId: string;
  readonly #workerName: string;
  readonly #config: WorkerLivenessConfig;
  #heartbeatTimer?: ReturnType<typeof setInterval>;
  #heartbeatInFlight = false;
  #closed = false;

  constructor(
    sql: Sql,
    identity: { instanceId: string; workerName: string },
    config: WorkerLivenessConfig,
  ) {
    this.#sql = sql;
    this.#instanceId = identity.instanceId;
    this.#workerName = identity.workerName;
    this.#config = config;
  }

  async register() {
    await this.#sql.begin(async (tx) => {
      const registered = await tx<{ instance_id: string }[]>`INSERT INTO worker_instances(
        instance_id,worker_name,state,started_at,heartbeat_at,progress_at,
        heartbeat_stale_ms,progress_stale_ms,health_clock_tolerance_ms,updated_at
      ) VALUES(${this.#instanceId},${this.#workerName},'starting',now(),now(),now(),
        ${this.#config.heartbeatStaleMs},${this.#config.progressStaleMs},
        ${this.#config.healthClockToleranceMs},now())
      ON CONFLICT(instance_id) DO UPDATE SET
        heartbeat_at=now(),progress_at=now(),updated_at=now()
      WHERE worker_instances.worker_name=EXCLUDED.worker_name
        AND worker_instances.state='starting'
      RETURNING instance_id`;
      this.#assertOwnRow(registered);
      await tx`DELETE FROM worker_instances
        WHERE instance_id<>${this.#instanceId}
          AND (
            (state='stopped' AND stopped_at < now() - ${this.#config.historyRetentionHours} * interval '1 hour')
            OR heartbeat_at < now() - ${this.#config.historyRetentionHours} * interval '1 hour'
          )`;
    });
  }

  startHeartbeat(onError: (error: unknown) => void) {
    if (this.#heartbeatTimer !== undefined) return;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#closed || this.#heartbeatInFlight) return;
      this.#heartbeatInFlight = true;
      this.#sql<{ instance_id: string }[]>`UPDATE worker_instances
        SET heartbeat_at=now(),updated_at=now()
        WHERE instance_id=${this.#instanceId} AND state IN ('starting','running','draining')
        RETURNING instance_id`
        .then((rows) => this.#assertOwnRow(rows))
        .catch(onError)
        .finally(() => this.#heartbeatInFlight = false);
    }, this.#config.heartbeatIntervalMs);
  }

  async markRunning() {
    const rows = await this.#sql<{ instance_id: string }[]>`UPDATE worker_instances
      SET state='running',heartbeat_at=now(),progress_at=now(),stopped_at=NULL,updated_at=now()
      WHERE instance_id=${this.#instanceId} AND state IN ('starting','running')
      RETURNING instance_id`;
    this.#assertOwnRow(rows);
  }

  async markDraining() {
    const rows = await this.#sql<{ instance_id: string }[]>`UPDATE worker_instances
      SET state='draining',heartbeat_at=now(),progress_at=now(),stopped_at=NULL,updated_at=now()
      WHERE instance_id=${this.#instanceId} AND state IN ('starting','running','draining')
      RETURNING instance_id`;
    this.#assertOwnRow(rows);
  }

  async markStopped() {
    this.stopHeartbeat();
    const rows = await this.#sql<{ instance_id: string }[]>`UPDATE worker_instances
      SET state='stopped',
      heartbeat_at=CASE WHEN state='stopped' THEN heartbeat_at ELSE now() END,
      progress_at=CASE WHEN state='stopped' THEN progress_at ELSE now() END,
      current_job_id=NULL,current_job_type=NULL,stopped_at=COALESCE(stopped_at,now()),updated_at=now()
      WHERE instance_id=${this.#instanceId}
        AND state IN ('starting','running','draining','stopped')
      RETURNING instance_id`;
    this.#assertOwnRow(rows);
  }

  async markProgress(job?: { id: string; type: string }, completed = false) {
    if (job && (job.type.length < 1 || job.type.length > 100)) {
      throw new Error("Worker job type is outside the durable liveness bound");
    }
    const rows = await this.#sql<{ instance_id: string }[]>`UPDATE worker_instances
      SET progress_at=now(),heartbeat_at=now(),
      current_job_id=${job?.id ?? null},current_job_type=${job?.type ?? null},
      last_completed_at=CASE WHEN ${completed} THEN now() ELSE last_completed_at END,
      last_completed_job_id=CASE WHEN ${completed} THEN current_job_id ELSE last_completed_job_id END,
      last_completed_job_type=CASE WHEN ${completed} THEN current_job_type ELSE last_completed_job_type END,
      updated_at=now() WHERE instance_id=${this.#instanceId}
      AND state IN ('starting','running','draining')
      AND (${!completed} OR current_job_id IS NOT NULL)
      RETURNING instance_id`;
    this.#assertOwnRow(rows);
  }

  stopHeartbeat() {
    this.#closed = true;
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #assertOwnRow(rows: readonly unknown[]) {
    if (rows.length !== 1) throw new WorkerInstanceLostError();
  }
}

/** A claimed job must never be stranded merely because operational bookkeeping failed. */
export async function markClaimedJobProgressOrNeutralDefer(options: {
  markProgress: () => Promise<void>;
  neutralDefer: () => Promise<boolean>;
}) {
  try {
    await options.markProgress();
  } catch (error) {
    await options.neutralDefer().catch(() => false);
    throw error;
  }
}

export function evaluateWorkerHealth(
  snapshot: WorkerInstanceSnapshot | undefined,
  now: Date,
  config: Pick<WorkerLivenessConfig, "heartbeatStaleMs" | "progressStaleMs">,
) {
  if (!snapshot || snapshot.state !== "running") return false;
  const heartbeatAge = now.getTime() - snapshot.heartbeatAt.getTime();
  const progressAge = now.getTime() - snapshot.progressAt.getTime();
  return heartbeatAge >= 0 && heartbeatAge <= config.heartbeatStaleMs &&
    progressAge >= 0 && progressAge <= config.progressStaleMs;
}

export async function probeWorkerHealth(options: {
  sql: Sql;
  objectStore: ObjectStore;
  instanceId: string;
  config: WorkerLivenessConfig;
}) {
  const rows = await options.sql<{
    instance_id: string;
    worker_name: string;
    state: WorkerState;
    heartbeat_at: Date;
    progress_at: Date;
    current_job_id: string | null;
    current_job_type: string | null;
    last_completed_at: Date | null;
    last_completed_job_id: string | null;
    last_completed_job_type: string | null;
    heartbeat_fresh: boolean;
    progress_fresh: boolean;
  }[]>`SELECT instance_id,worker_name,state,heartbeat_at,progress_at,current_job_id,
    current_job_type,last_completed_at,last_completed_job_id,last_completed_job_type,
    heartbeat_at BETWEEN
      clock_timestamp()-heartbeat_stale_ms*interval '1 millisecond'
      AND clock_timestamp()+health_clock_tolerance_ms*interval '1 millisecond'
      AS heartbeat_fresh,
    progress_at BETWEEN
      clock_timestamp()-progress_stale_ms*interval '1 millisecond'
      AND clock_timestamp()+health_clock_tolerance_ms*interval '1 millisecond'
      AS progress_fresh
    FROM worker_instances WHERE instance_id=${options.instanceId}`;
  const row = rows[0];
  const healthy = Boolean(
    row && row.state === "running" && row.heartbeat_fresh && row.progress_fresh,
  );
  if (!healthy) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.config.healthTimeoutMs);
  try {
    return await options.objectStore.readiness(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
