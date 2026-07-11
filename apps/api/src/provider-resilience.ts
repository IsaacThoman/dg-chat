export type CircuitState = "closed" | "open" | "half_open" | "unavailable";

export interface ProviderCandidate {
  id: string;
  fallbackId?: string | null;
}

export interface ResiliencePolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterRatio?: number;
  maxAttempts: number;
  maxHops: number;
  totalTimeoutMs: number;
  firstVisibleTimeoutMs: number;
  idleTimeoutMs: number;
  maxPreVisibleChunks: number;
  maxPreVisibleBytes: number;
  slowWindowMs?: number;
  minimumVisibleUnitsPerSecond?: number;
  circuitFailureThreshold: number;
  circuitOpenMs: number;
}

export interface CircuitPermit {
  allowed: boolean;
  state: CircuitState;
  retryAt?: number;
  lease?: unknown;
}

export interface CircuitStore {
  acquire(candidateId: string, policy: ResiliencePolicy): CircuitPermit | Promise<CircuitPermit>;
  success(
    candidateId: string,
    permit: CircuitPermit,
  ): CircuitState | void | Promise<CircuitState | void>;
  failure(
    candidateId: string,
    permit: CircuitPermit,
    policy: ResiliencePolicy,
  ): CircuitState | void | Promise<CircuitState | void>;
}

export type AttemptEvent = {
  type: "started" | "succeeded" | "failed" | "skipped";
  candidateId: string;
  attempt: number;
  hop: number;
  retry: number;
  circuitState: CircuitState;
  durationMs?: number;
  visibleOutput?: boolean;
  errorCategory?: ProviderErrorCategory;
  httpStatus?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  reason?: "circuit_open";
  breakerAfter?: CircuitState;
};

export interface AttemptContext {
  attempt: number;
  hop: number;
  retry: number;
  circuitState: CircuitState;
}

export type ProviderErrorCategory =
  | "aborted"
  | "timeout"
  | "rate_limited"
  | "upstream_unavailable"
  | "network"
  | "authentication"
  | "invalid_request"
  | "invalid_response"
  | "unknown";

export interface ClassifiedProviderError {
  category: ProviderErrorCategory;
  transient: boolean;
  status?: number;
}

export class ProviderAttemptError extends Error {
  constructor(
    message: string,
    public readonly options: {
      category?: ProviderErrorCategory;
      status?: number;
      transient?: boolean;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = "ProviderAttemptError";
  }
}

export class ResilienceExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError?: unknown,
  ) {
    super(message);
    this.name = "ResilienceExhaustedError";
  }
}

const integer = (
  value: number,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
};

export function validateResiliencePolicy(policy: ResiliencePolicy): ResiliencePolicy {
  integer(policy.maxRetries, "maxRetries", 0, 3);
  integer(policy.baseDelayMs, "baseDelayMs", 0, 300_000);
  integer(policy.maxDelayMs, "maxDelayMs", 0, 300_000);
  if (
    !Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier < 1 ||
    policy.backoffMultiplier > 4
  ) {
    throw new TypeError("backoffMultiplier must be from 1 to 4");
  }
  integer(policy.maxAttempts, "maxAttempts", 1, 8);
  integer(policy.maxHops, "maxHops", 0, 7);
  integer(policy.totalTimeoutMs, "totalTimeoutMs", 1, 900_000);
  integer(policy.firstVisibleTimeoutMs, "firstVisibleTimeoutMs", 1, 300_000);
  integer(policy.idleTimeoutMs, "idleTimeoutMs", 1, 300_000);
  integer(policy.maxPreVisibleChunks, "maxPreVisibleChunks", 1, 1_024);
  integer(policy.maxPreVisibleBytes, "maxPreVisibleBytes", 1, 16_777_216);
  integer(policy.circuitFailureThreshold, "circuitFailureThreshold", 1, 100);
  integer(policy.circuitOpenMs, "circuitOpenMs", 1, 86_400_000);
  if (policy.maxRetries >= policy.maxAttempts) {
    throw new TypeError("maxRetries must be less than maxAttempts");
  }
  if (
    policy.firstVisibleTimeoutMs > policy.totalTimeoutMs ||
    policy.idleTimeoutMs > policy.totalTimeoutMs ||
    policy.maxDelayMs >= policy.totalTimeoutMs
  ) {
    throw new TypeError("Per-attempt timeouts and delays must fit within totalTimeoutMs");
  }
  if (policy.maxDelayMs < policy.baseDelayMs) {
    throw new TypeError("maxDelayMs must be greater than or equal to baseDelayMs");
  }
  const jitter = policy.jitterRatio ?? 0;
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new TypeError("jitterRatio must be between 0 and 1");
  }
  const hasSlowWindow = policy.slowWindowMs !== undefined;
  const hasSlowRate = policy.minimumVisibleUnitsPerSecond !== undefined;
  if (hasSlowWindow !== hasSlowRate) {
    throw new TypeError(
      "slowWindowMs and minimumVisibleUnitsPerSecond must be configured together",
    );
  }
  if (hasSlowWindow) {
    integer(policy.slowWindowMs!, "slowWindowMs", 1, 300_000);
    if (policy.slowWindowMs! > policy.totalTimeoutMs) {
      throw new TypeError("slowWindowMs must fit within totalTimeoutMs");
    }
    if (
      !Number.isFinite(policy.minimumVisibleUnitsPerSecond) ||
      policy.minimumVisibleUnitsPerSecond! <= 0
    ) throw new TypeError("minimumVisibleUnitsPerSecond must be positive");
  }
  return { ...policy, jitterRatio: jitter };
}

export function classifyProviderError(error: unknown): ClassifiedProviderError {
  if (error instanceof ProviderAttemptError) {
    const status = safeHttpStatus(error.options.status);
    if (error.options.category || error.options.transient !== undefined || status !== undefined) {
      const inferred = status === undefined ? undefined : classifyProviderError({ status });
      return {
        category: error.options.category ?? inferred?.category ?? "unknown",
        transient: error.options.transient ?? inferred?.transient ?? false,
        status,
      };
    }
  }
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = safeHttpStatus(record.status);
  const name = error instanceof Error ? error.name : String(record.name ?? "");
  if (name === "AbortError") return { category: "aborted", transient: false, status };
  if (name === "TimeoutError") return { category: "timeout", transient: true, status };
  if (status === 401 || status === 403) {
    return { category: "authentication", transient: false, status };
  }
  if (status === 408 || status === 425 || status === 504) {
    return { category: "timeout", transient: true, status };
  }
  if (status === 429) return { category: "rate_limited", transient: true, status };
  if (status !== undefined && status >= 500) {
    return { category: "upstream_unavailable", transient: true, status };
  }
  if (status !== undefined && status >= 400) {
    return { category: "invalid_request", transient: false, status };
  }
  if (error instanceof TypeError) return { category: "network", transient: true };
  return { category: "unknown", transient: false, status };
}

function safeHttpStatus(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : undefined;
}

function safeRetryAfterMs(error: unknown): number | undefined {
  const value = error instanceof ProviderAttemptError ? error.options.retryAfterMs : undefined;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? value : undefined;
}

export async function abortableBackoff(
  retry: number,
  policyInput: ResiliencePolicy,
  signal: AbortSignal,
  random: () => number = Math.random,
  minimumDelayMs = 0,
  remainingMs = Number.POSITIVE_INFINITY,
): Promise<void> {
  const policy = validateResiliencePolicy(policyInput);
  integer(retry, "retry", 1);
  integer(minimumDelayMs, "minimumDelayMs", 0);
  if (
    !(remainingMs === Number.POSITIVE_INFINITY) &&
    (!Number.isFinite(remainingMs) || remainingMs < 0)
  ) {
    throw new TypeError("remainingMs must be non-negative");
  }
  signal.throwIfAborted();
  const delay = Math.max(minimumDelayMs, backoffDelayMs(retry, policy, random));
  if (delay >= remainingMs) {
    throw new ProviderAttemptError("Provider retry delay exceeds the total request deadline", {
      category: "timeout",
      transient: false,
    });
  }
  if (delay === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delay);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export function backoffDelayMs(
  retry: number,
  policyInput: ResiliencePolicy,
  random: () => number = Math.random,
): number {
  const policy = validateResiliencePolicy(policyInput);
  integer(retry, "retry", 1);
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * policy.backoffMultiplier ** (retry - 1),
  );
  const jitter = exponential * (policy.jitterRatio ?? 0) * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

interface OrchestrationOptions {
  initialCandidateId: string;
  resolveCandidate: (
    id: string,
  ) => ProviderCandidate | undefined | Promise<ProviderCandidate | undefined>;
  policy: ResiliencePolicy;
  signal: AbortSignal;
  circuitStore?: CircuitStore;
  beforeAttempt?: (
    candidate: ProviderCandidate,
    signal: AbortSignal,
    context: AttemptContext,
  ) => void | Promise<void>;
  onAttempt?: (event: AttemptEvent) => void | Promise<void>;
  now?: () => number;
  random?: () => number;
}

async function emit(callback: OrchestrationOptions["onAttempt"], event: AttemptEvent) {
  await callback?.(event);
}

async function candidateSequence(
  options: OrchestrationOptions,
  run: (
    candidate: ProviderCandidate,
    context: AttemptContext,
  ) => Promise<
    | { ok: true; durationMs: number; visible: boolean }
    | { ok: false; error: unknown; visible: boolean; durationMs: number }
  >,
): Promise<void> {
  const policy = validateResiliencePolicy(options.policy);
  const now = options.now ?? Date.now;
  const deadline = now() + policy.totalTimeoutMs;
  const visited = new Set<string>();
  let candidateId: string | null = options.initialCandidateId;
  let attempt = 0;
  let hop = 0;
  let lastError: unknown;
  while (candidateId) {
    options.signal.throwIfAborted();
    if (visited.has(candidateId)) {
      throw new ResilienceExhaustedError("Fallback cycle detected", attempt, lastError);
    }
    if (hop > policy.maxHops) {
      throw new ResilienceExhaustedError("Fallback hop limit exceeded", attempt, lastError);
    }
    visited.add(candidateId);
    const candidate = await options.resolveCandidate(candidateId);
    if (!candidate || candidate.id !== candidateId) {
      throw new ResilienceExhaustedError(
        `Provider candidate '${candidateId}' is unavailable`,
        attempt,
        lastError,
      );
    }
    let retryAfterMs = 0;
    for (let retry = 0; retry <= policy.maxRetries; retry++) {
      if (attempt >= policy.maxAttempts) {
        throw new ResilienceExhaustedError("Provider attempt limit exceeded", attempt, lastError);
      }
      if (retry > 0) {
        await abortableBackoff(
          retry,
          policy,
          options.signal,
          options.random,
          retryAfterMs,
          Math.max(0, deadline - now()),
        );
      }
      const permit = options.circuitStore
        ? await options.circuitStore.acquire(candidate.id, policy)
        : { allowed: true, state: "closed" as const };
      if (!permit.allowed) {
        await emit(options.onAttempt, {
          type: "skipped",
          candidateId: candidate.id,
          attempt,
          hop,
          retry,
          circuitState: permit.state,
          reason: "circuit_open",
        });
        break;
      }
      attempt += 1;
      const context = {
        attempt,
        hop,
        retry,
        circuitState: permit.state,
      };
      await options.beforeAttempt?.(candidate, options.signal, context);
      const result = await run(candidate, context);
      if (result.ok) {
        const breakerAfter = await options.circuitStore?.success(candidate.id, permit);
        await emit(options.onAttempt, {
          type: "succeeded",
          candidateId: candidate.id,
          ...context,
          durationMs: result.durationMs,
          visibleOutput: result.visible,
          ...(breakerAfter ? { breakerAfter } : {}),
        });
        return;
      }
      lastError = result.error;
      retryAfterMs = result.error instanceof ProviderAttemptError
        ? result.error.options.retryAfterMs ?? 0
        : 0;
      if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
        throw new ProviderAttemptError("Provider Retry-After value is invalid", {
          category: "invalid_response",
          transient: false,
        });
      }
      const classified = classifyProviderError(result.error);
      const breakerAfter = classified.transient || permit.state === "half_open"
        ? await options.circuitStore?.failure(candidate.id, permit, policy)
        : undefined;
      await emit(options.onAttempt, {
        type: "failed",
        candidateId: candidate.id,
        ...context,
        durationMs: result.durationMs,
        visibleOutput: result.visible,
        errorCategory: classified.category,
        httpStatus: classified.status,
        retryable: classified.transient,
        retryAfterMs: safeRetryAfterMs(result.error),
        ...(breakerAfter ? { breakerAfter } : {}),
      });
      if (result.visible || !classified.transient) {
        throw result.error;
      }
      if (permit.state === "half_open") break;
    }
    candidateId = candidate.fallbackId ?? null;
    hop += 1;
  }
  throw new ResilienceExhaustedError("All provider candidates were exhausted", attempt, lastError);
}

export async function executeProviderRequest<T>(
  options: OrchestrationOptions & {
    attempt: (
      candidate: ProviderCandidate,
      signal: AbortSignal,
      context: AttemptContext,
    ) => Promise<T>;
  },
): Promise<T> {
  let value: T | undefined;
  const policy = validateResiliencePolicy(options.policy);
  const orchestrationOptions = {
    ...options,
    policy,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(policy.totalTimeoutMs)]),
  };
  const now = options.now ?? Date.now;
  await candidateSequence(orchestrationOptions, async (candidate, context) => {
    await emit(options.onAttempt, { type: "started", candidateId: candidate.id, ...context });
    const started = now();
    try {
      value = await options.attempt(candidate, orchestrationOptions.signal, context);
    } catch (error) {
      const failure = orchestrationOptions.signal.aborted
        ? orchestrationOptions.signal.reason
        : error;
      return {
        ok: false,
        error: failure,
        visible: false,
        durationMs: Math.max(0, now() - started),
      };
    }
    return { ok: true, visible: false, durationMs: Math.max(0, now() - started) };
  });
  return value as T;
}

export function openAIVisibleUnits(chunk: unknown): number {
  if (typeof chunk === "string") {
    if (!chunk || chunk === "[DONE]" || chunk.startsWith(":")) return 0;
    try {
      return openAIVisibleUnits(JSON.parse(chunk.replace(/^data:\s*/, "")));
    } catch {
      return 0;
    }
  }
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return 0;
  const value = chunk as Record<string, unknown>;
  if (typeof value.delta === "string" && value.delta.length > 0) return value.delta.length;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  let units = 0;
  for (const item of choices) {
    if (!item || typeof item !== "object") continue;
    const delta = (item as Record<string, unknown>).delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    const fields = delta as Record<string, unknown>;
    for (const name of ["content", "reasoning_content", "reasoning", "refusal"]) {
      if (typeof fields[name] === "string") units += fields[name].length;
    }
    if (Array.isArray(fields.tool_calls) && fields.tool_calls.length > 0) units += 1;
  }
  return units;
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal: AbortSignal,
  message: string,
): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const timer = setTimeout(() =>
      finish(() =>
        reject(
          new ProviderAttemptError(message, { category: "timeout", transient: true }),
        )
      ), timeoutMs);
    const aborted = () =>
      finish(() =>
        reject(
          signal.reason ?? new DOMException("The operation was aborted", "AbortError"),
        )
      );
    const finish = (action: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      action();
    };
    signal.addEventListener("abort", aborted, { once: true });
    iterator.next().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

const STREAM_CLEANUP_TIMEOUT_MS = 250;

async function boundedCleanup(task: Promise<unknown> | undefined): Promise<void> {
  if (!task) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STREAM_CLEANUP_TIMEOUT_MS);
  });
  await Promise.race([task.then(() => undefined, () => undefined), timeout]);
  if (timer !== undefined) clearTimeout(timer);
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown;

  push(value: T) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown) {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#values.length > 0) {
          return Promise.resolve({ done: false, value: this.#values.shift()! });
        }
        if (this.#closed) {
          return this.#error === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : Promise.reject(this.#error);
        }
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

function encodedChunkBytes(chunk: unknown): number {
  let value: string;
  if (typeof chunk === "string") value = chunk;
  else {
    try {
      value = JSON.stringify(chunk) ?? "";
    } catch {
      throw new ProviderAttemptError("Provider stream chunk is not serializable", {
        category: "invalid_response",
        transient: true,
      });
    }
  }
  return new TextEncoder().encode(value).byteLength;
}

export async function* streamProviderRequest<T>(
  options: OrchestrationOptions & {
    attempt: (
      candidate: ProviderCandidate,
      signal: AbortSignal,
      context: AttemptContext,
    ) => AsyncIterable<T> | Promise<AsyncIterable<T>>;
    visibleUnits?: (chunk: T) => number;
    /** Accept a validated stream whose buffered events contain no user-visible units. */
    allowNoVisibleOutput?: boolean;
  },
): AsyncGenerator<T> {
  const policy = validateResiliencePolicy(options.policy);
  const queue = new AsyncQueue<T>();
  const localAbort = new AbortController();
  const orchestrationOptions = {
    ...options,
    policy,
    signal: AbortSignal.any([
      options.signal,
      localAbort.signal,
      AbortSignal.timeout(policy.totalTimeoutMs),
    ]),
  };
  const now = options.now ?? Date.now;
  const visibleUnits = options.visibleUnits ?? ((chunk: T) => openAIVisibleUnits(chunk));
  const running = candidateSequence(orchestrationOptions, async (candidate, context) => {
    let visible = false;
    let observedUnits = 0;
    let visibleStarted = 0;
    let lastVisibleAt = 0;
    let bufferedBytes = 0;
    const buffered: T[] = [];
    let iterator: AsyncIterator<T> | undefined;
    const attemptAbort = new AbortController();
    const attemptSignal = AbortSignal.any([orchestrationOptions.signal, attemptAbort.signal]);
    await emit(options.onAttempt, { type: "started", candidateId: candidate.id, ...context });
    const started = now();
    try {
      iterator = (await options.attempt(candidate, attemptSignal, context))[Symbol.asyncIterator]();
      while (true) {
        const deadline = visible
          ? lastVisibleAt + options.policy.idleTimeoutMs
          : started + options.policy.firstVisibleTimeoutMs;
        const timeout = Math.max(1, deadline - now());
        const item = await nextWithTimeout(
          iterator,
          timeout,
          attemptSignal,
          visible
            ? "Provider stream became idle"
            : "Provider did not produce visible output in time",
        );
        if (item.done) {
          if (!visible) {
            if (!options.allowNoVisibleOutput) {
              throw new ProviderAttemptError("Provider stream ended before visible output", {
                category: "invalid_response",
                transient: true,
              });
            }
            for (const chunk of buffered) queue.push(chunk);
            buffered.length = 0;
          }
          break;
        }
        const rawUnits = visibleUnits(item.value);
        if (!Number.isSafeInteger(rawUnits) || rawUnits < 0) {
          throw new ProviderAttemptError("Provider stream visibility count is invalid", {
            category: "invalid_response",
            transient: true,
          });
        }
        const units = rawUnits;
        if (!visible) {
          bufferedBytes += encodedChunkBytes(item.value);
          if (
            buffered.length >= policy.maxPreVisibleChunks ||
            bufferedBytes > policy.maxPreVisibleBytes
          ) {
            throw new ProviderAttemptError(
              "Provider pre-visible stream buffer exceeded its limit",
              {
                category: "invalid_response",
                transient: true,
              },
            );
          }
          buffered.push(item.value);
          if (units <= 0) continue;
          visible = true;
          visibleStarted = now();
          lastVisibleAt = visibleStarted;
          observedUnits += units;
          for (const chunk of buffered) queue.push(chunk);
          buffered.length = 0;
        } else {
          observedUnits += units;
          if (units > 0) lastVisibleAt = now();
          queue.push(item.value);
        }
        if (
          options.policy.slowWindowMs && options.policy.minimumVisibleUnitsPerSecond &&
          now() - visibleStarted >= options.policy.slowWindowMs
        ) {
          const rate = observedUnits / Math.max(0.001, (now() - visibleStarted) / 1_000);
          if (rate < options.policy.minimumVisibleUnitsPerSecond) {
            throw new ProviderAttemptError("Provider stream is below the minimum throughput", {
              category: "timeout",
              transient: true,
            });
          }
        }
      }
    } catch (error) {
      const failure = orchestrationOptions.signal.aborted
        ? orchestrationOptions.signal.reason
        : error;
      attemptAbort.abort(failure);
      await boundedCleanup(
        iterator?.return ? Promise.resolve().then(() => iterator!.return!()) : undefined,
      );
      return {
        ok: false,
        error: failure,
        visible,
        durationMs: Math.max(0, now() - started),
      };
    }
    return { ok: true, visible, durationMs: Math.max(0, now() - started) };
  });
  running.then(() => queue.close(), (error) => queue.fail(error));
  try {
    yield* queue;
    await running;
  } finally {
    localAbort.abort(new DOMException("Provider stream consumer disconnected", "AbortError"));
    await boundedCleanup(running);
  }
}

interface MemoryCircuitEntry {
  failures: number;
  openUntil: number;
  halfOpenInFlight: boolean;
  touchedAt: number;
}

export class MemoryCircuitStore implements CircuitStore {
  readonly #entries = new Map<string, MemoryCircuitEntry>();
  constructor(
    private readonly maxEntries = 1_000,
    private readonly now: () => number = Date.now,
  ) {
    integer(maxEntries, "maxEntries", 1);
  }

  acquire(candidateId: string, _policy: ResiliencePolicy): CircuitPermit {
    const current = this.#entries.get(candidateId);
    if (!current) return { allowed: true, state: "closed" };
    current.touchedAt = this.now();
    if (current.openUntil > this.now()) {
      return { allowed: false, state: "open", retryAt: current.openUntil };
    }
    if (current.openUntil > 0) {
      if (current.halfOpenInFlight) return { allowed: false, state: "half_open" };
      current.halfOpenInFlight = true;
      return { allowed: true, state: "half_open" };
    }
    return { allowed: true, state: "closed" };
  }

  success(candidateId: string, _permit: CircuitPermit): CircuitState {
    this.#entries.delete(candidateId);
    return "closed";
  }

  failure(candidateId: string, _permit: CircuitPermit, policy: ResiliencePolicy): CircuitState {
    const time = this.now();
    const current = this.#entries.get(candidateId) ?? {
      failures: 0,
      openUntil: 0,
      halfOpenInFlight: false,
      touchedAt: time,
    };
    current.failures += 1;
    current.touchedAt = time;
    if (current.halfOpenInFlight || current.failures >= policy.circuitFailureThreshold) {
      current.openUntil = time + policy.circuitOpenMs;
      current.halfOpenInFlight = false;
    }
    this.#entries.set(candidateId, current);
    this.#evict();
    return this.state(candidateId);
  }

  state(candidateId: string): CircuitState {
    const entry = this.#entries.get(candidateId);
    if (!entry || entry.openUntil === 0) return "closed";
    if (entry.openUntil > this.now()) return "open";
    return "half_open";
  }

  get size(): number {
    return this.#entries.size;
  }

  #evict() {
    while (this.#entries.size > this.maxEntries) {
      let oldest: [string, MemoryCircuitEntry] | undefined;
      for (const item of this.#entries) {
        if (!oldest || item[1].touchedAt < oldest[1].touchedAt) oldest = item;
      }
      if (!oldest) return;
      this.#entries.delete(oldest[0]);
    }
  }
}
