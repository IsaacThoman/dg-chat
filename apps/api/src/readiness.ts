export interface ReadinessTimeouts {
  postgresMs: number;
  redisMs: number;
  objectStoreMs: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const MAX_READINESS_TIMEOUT_MS = 30_000;

function timeoutFromEnv(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_READINESS_TIMEOUT_MS) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_READINESS_TIMEOUT_MS}`);
  }
  return timeout;
}

export function readinessTimeoutsFromEnv(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): ReadinessTimeouts {
  const common = timeoutFromEnv(
    env.READINESS_TIMEOUT_MS,
    "READINESS_TIMEOUT_MS",
    DEFAULT_READINESS_TIMEOUT_MS,
  );
  return {
    postgresMs: timeoutFromEnv(
      env.POSTGRES_READINESS_TIMEOUT_MS,
      "POSTGRES_READINESS_TIMEOUT_MS",
      common,
    ),
    redisMs: timeoutFromEnv(env.REDIS_READINESS_TIMEOUT_MS, "REDIS_READINESS_TIMEOUT_MS", common),
    objectStoreMs: timeoutFromEnv(
      env.S3_READINESS_TIMEOUT_MS,
      "S3_READINESS_TIMEOUT_MS",
      common,
    ),
  };
}

/** Run a readiness probe within a hard deadline and request best-effort adapter cancellation. */
export async function boundedReadiness<T>(
  timeoutMs: number,
  fallback: T,
  probe: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("Readiness deadline exceeded", "TimeoutError"));
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    const result = Promise.resolve().then(() => probe(controller.signal)).catch(() => fallback);
    return await Promise.race([result, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
