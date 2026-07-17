export interface BoundedBackoffPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier?: number;
  /** Randomly subtract at most this fraction from the bounded delay. */
  jitterRatio?: number;
}

export interface RetryNotice {
  attempt: number;
  delayMs: number;
}

type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>;
type RetryPredicate = (error: unknown) => boolean;
type Random = () => number;

const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
]);

// PostgreSQL class 08 includes permanent connection rejection (08004) and a protocol violation
// (08P01). Keep the retry list explicit so authentication, server policy, driver mismatch, and
// future class additions fail closed instead of creating an infinite worker-start loop.
const TRANSIENT_DATABASE_SQLSTATES = new Set([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08007", // transaction_resolution_unknown
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

// These failures describe the contents or relational consistency of one claimed job's mutation.
// They are permanent for that job, but they do not mean the worker installation is misconfigured.
// Keep this deliberately class-based: PostgreSQL can add more-specific conditions without turning
// one poison payload into a process-wide restart loop.
const JOB_LOCAL_DATABASE_SQLSTATE_CLASSES = new Set([
  "21", // cardinality_violation
  "22", // data_exception
  "23", // integrity_constraint_violation
  "44", // with_check_option_violation
]);

/** Marks a failure as originating from an operation whose only remote dependency is PostgreSQL. */
export class DatabaseOperationError extends Error {
  constructor(cause: unknown) {
    super("Database operation failed", { cause });
    this.name = "DatabaseOperationError";
  }
}

export async function runDatabaseOperation<T>(
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DatabaseOperationError) throw error;
    // SQL callbacks can deliberately throw domain/validation errors. Mark only driver-shaped
    // failures; otherwise preserve the application error so it consumes the normal job budget.
    if (isDatabaseDriverFailure(error)) throw new DatabaseOperationError(error);
    throw error;
  }
}

function errorRecords(error: unknown): Array<{ code: string; message: string }> {
  const records: Array<{ code: string; message: string }> = [];
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    const record = value as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    records.push({
      code: typeof record.code === "string" ? record.code.toUpperCase() : "",
      message: typeof record.message === "string" ? record.message : "",
    });
    if (record.cause) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return records;
}

function isTransientDatabaseTransport(error: unknown): boolean {
  return errorRecords(error).some(({ code, message }) =>
    TRANSIENT_NETWORK_CODES.has(code) ||
    /(?:getaddrinfo|connection) (?:enotfound|eai_again|econnrefused|reset|closed|ended|terminated|timed out)/i
      .test(message)
  );
}

function isDatabaseDriverFailure(error: unknown): boolean {
  return errorRecords(error).some(({ code }) => /^[0-9A-Z]{5}$/u.test(code)) ||
    isTransientDatabaseTransport(error);
}

/** Fail closed: configuration, authentication, schema, and application errors must still exit. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (!(error instanceof DatabaseOperationError)) return false;
  return errorRecords(error.cause).some(({ code }) => TRANSIENT_DATABASE_SQLSTATES.has(code)) ||
    isTransientDatabaseTransport(error.cause);
}

/**
 * The worker configures PostgreSQL `statement_timeout` on every pool it owns. SQLSTATE 57014 from
 * those marked operations is therefore its own bounded cancellation, not a poison job or a fatal
 * installation error. API/user-cancelled queries deliberately continue using the narrower
 * classifier above.
 */
export function isWorkerRetryableDatabaseError(error: unknown): boolean {
  if (isTransientDatabaseError(error)) return true;
  return error instanceof DatabaseOperationError &&
    errorRecords(error.cause).some(({ code, message }) =>
      code === "57014" && /statement timeout/i.test(message)
    );
}

/**
 * Returns true only for a PostgreSQL failure local to the data being handled by one durable job.
 * Authentication, missing schema, protocol, resource-configuration, and other installation faults
 * intentionally remain false so callers can stop the worker and surface an operator-visible fault.
 */
export function isJobLocalDatabaseError(error: unknown): boolean {
  if (!(error instanceof DatabaseOperationError)) return false;
  const sqlstates = errorRecords(error.cause)
    .map(({ code }) => code)
    .filter((code) => code.length === 5);
  return sqlstates.length > 0 &&
    sqlstates.every((code) => JOB_LOCAL_DATABASE_SQLSTATE_CLASSES.has(code.slice(0, 2)));
}

function assertPolicy(policy: BoundedBackoffPolicy): Required<BoundedBackoffPolicy> {
  const multiplier = policy.multiplier ?? 2;
  const jitterRatio = policy.jitterRatio ?? 0;
  if (!Number.isSafeInteger(policy.initialDelayMs) || policy.initialDelayMs < 1) {
    throw new TypeError("initialDelayMs must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs ||
    policy.maxDelayMs > 2_147_483_647
  ) {
    throw new TypeError(
      "maxDelayMs must be at least initialDelayMs and no greater than the platform timer limit",
    );
  }
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
    throw new TypeError("multiplier must be from 1 to 10");
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new TypeError("jitterRatio must be from 0 to 1");
  }
  return { ...policy, multiplier, jitterRatio };
}

export function boundedBackoffDelay(
  failureCount: number,
  policy: BoundedBackoffPolicy,
  random: Random = Math.random,
): number {
  if (!Number.isSafeInteger(failureCount) || failureCount < 1) {
    throw new TypeError("failureCount must be a positive safe integer");
  }
  const validated = assertPolicy(policy);
  const delay = validated.initialDelayMs * validated.multiplier ** (failureCount - 1);
  const bounded = Math.min(
    validated.maxDelayMs,
    Number.isFinite(delay) ? Math.floor(delay) : Infinity,
  );
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new TypeError("random must return a finite value from 0 to 1");
  }
  // Jitter only downward: an operator's maximum delay remains a hard upper bound and a random
  // sample can never make outage recovery slower than the documented exponential schedule.
  return Math.max(1, Math.floor(bounded * (1 - validated.jitterRatio * sample)));
}

/** Wait without making shutdown wait for the timer to expire. */
export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", abort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    function finish() {
      cleanup();
      resolve();
    }
    function abort() {
      cleanup();
      reject(signal.reason);
    }
  });
}

/** Retry a startup operation indefinitely, with a bounded delay, until success or shutdown. */
export async function retryWithBoundedBackoff<T>(options: {
  operation: () => Promise<T>;
  signal: AbortSignal;
  policy: BoundedBackoffPolicy;
  onRetry?: (notice: RetryNotice) => void;
  sleep?: Sleep;
  shouldRetry?: RetryPredicate;
  random?: Random;
}): Promise<T> {
  const sleep = options.sleep ?? abortableDelay;
  let failureCount = 0;
  while (true) {
    options.signal.throwIfAborted();
    try {
      return await options.operation();
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason ?? error;
      if (options.shouldRetry && !options.shouldRetry(error)) throw error;
      failureCount += 1;
      const delayMs = boundedBackoffDelay(failureCount, options.policy, options.random);
      options.onRetry?.({ attempt: failureCount, delayMs });
      await sleep(delayMs, options.signal);
    }
  }
}

/**
 * Run independent durable-work iterations forever. A failed iteration is not replayed directly:
 * the durable job lease remains the recovery boundary and a later claim safely resumes it.
 */
export async function runResilientLoop(options: {
  iteration: () => Promise<void>;
  signal: AbortSignal;
  policy: BoundedBackoffPolicy;
  onRetry?: (notice: RetryNotice) => void;
  sleep?: Sleep;
  shouldRetry?: RetryPredicate;
  random?: Random;
}): Promise<void> {
  const sleep = options.sleep ?? abortableDelay;
  let consecutiveFailures = 0;
  while (!options.signal.aborted) {
    try {
      await options.iteration();
      consecutiveFailures = 0;
    } catch (error) {
      if (options.signal.aborted) return;
      if (options.shouldRetry && !options.shouldRetry(error)) throw error;
      consecutiveFailures += 1;
      const delayMs = boundedBackoffDelay(
        consecutiveFailures,
        options.policy,
        options.random,
      );
      options.onRetry?.({ attempt: consecutiveFailures, delayMs });
      try {
        await sleep(delayMs, options.signal);
      } catch (sleepError) {
        if (options.signal.aborted) return;
        throw sleepError;
      }
    }
  }
}
