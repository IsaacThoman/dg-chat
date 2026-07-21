import { Redis } from "ioredis";
import type {
  CircuitPermit as ResilienceCircuitPermit,
  CircuitStore,
  ResiliencePolicy,
} from "./provider-resilience.ts";

export type BreakerState = "closed" | "open" | "half_open" | "unavailable";

export interface BreakerPolicy {
  failureThreshold: number;
  failureWindowSeconds: number;
  openSeconds: number;
  halfOpenLeaseSeconds: number;
}

export interface BreakerPermit {
  allowed: boolean;
  state: BreakerState;
  version: number;
  probeToken?: string;
  retryAfterMs?: number;
}

export interface BreakerSnapshot {
  state: BreakerState;
  version: number;
  failureCount: number;
  openUntil: number | null;
  probeUntil: number | null;
  /** Server-clock-derived remaining delay, safe to translate onto the application clock. */
  retryAfterMs?: number;
}

export interface CircuitBreaker {
  beforeAttempt(targetId: string, policy: BreakerPolicy): Promise<BreakerPermit>;
  recordSuccess(targetId: string, permit: BreakerPermit): Promise<BreakerSnapshot>;
  recordFailure(
    targetId: string,
    permit: BreakerPermit,
    policy: BreakerPolicy,
  ): Promise<BreakerSnapshot>;
  inspect(targetId: string, policy: BreakerPolicy): Promise<BreakerSnapshot>;
  reset(targetId: string, expectedVersion: number): Promise<boolean>;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateBreakerPolicy(policy: BreakerPolicy): BreakerPolicy {
  const integer = (value: number, name: string, min: number, max: number) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  return {
    failureThreshold: integer(policy.failureThreshold, "failureThreshold", 1, 100),
    failureWindowSeconds: integer(policy.failureWindowSeconds, "failureWindowSeconds", 1, 86_400),
    openSeconds: integer(policy.openSeconds, "openSeconds", 1, 86_400),
    halfOpenLeaseSeconds: integer(policy.halfOpenLeaseSeconds, "halfOpenLeaseSeconds", 1, 300),
  };
}

function targetKey(targetId: string): string {
  if (!uuid.test(targetId)) throw new TypeError("Circuit breaker targetId must be a UUID");
  return targetId.toLowerCase();
}

interface MemoryEntry {
  version: number;
  failures: number[];
  openUntil: number | null;
  probeToken: string | null;
  probeUntil: number | null;
  touchedAt: number;
}

export class MemoryCircuitBreaker implements CircuitBreaker {
  readonly #entries = new Map<string, MemoryEntry>();
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #maxEntries: number;
  #nextVersion = 0;

  constructor(
    options: { now?: () => number; randomId?: () => string; maxEntries?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => crypto.randomUUID());
    this.#maxEntries = options.maxEntries ?? 1_000;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer");
    }
  }

  #entry(id: string): MemoryEntry {
    let entry = this.#entries.get(id);
    if (!entry) {
      entry = {
        version: ++this.#nextVersion,
        failures: [],
        openUntil: null,
        probeToken: null,
        probeUntil: null,
        touchedAt: this.#now(),
      };
      this.#entries.set(id, entry);
      this.#evict();
    }
    entry.touchedAt = this.#now();
    return entry;
  }

  #evict() {
    while (this.#entries.size > this.#maxEntries) {
      let oldest: [string, MemoryEntry] | undefined;
      for (const item of this.#entries) {
        if (!oldest || item[1].touchedAt < oldest[1].touchedAt) oldest = item;
      }
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
    }
  }

  #prune(entry: MemoryEntry, policy: BreakerPolicy, now: number) {
    const cutoff = now - policy.failureWindowSeconds * 1_000;
    entry.failures = entry.failures.filter((at) => at > cutoff);
  }

  beforeAttempt(targetId: string, input: BreakerPolicy): Promise<BreakerPermit> {
    const id = targetKey(targetId);
    const policy = validateBreakerPolicy(input);
    const now = this.#now();
    const entry = this.#entry(id);
    this.#prune(entry, policy, now);
    if (entry.openUntil !== null && entry.openUntil > now) {
      return Promise.resolve({
        allowed: false,
        state: "open",
        version: entry.version,
        retryAfterMs: entry.openUntil - now,
      });
    }
    if (entry.openUntil !== null) {
      if (entry.probeToken && entry.probeUntil !== null && entry.probeUntil > now) {
        return Promise.resolve({
          allowed: false,
          state: "half_open",
          version: entry.version,
          retryAfterMs: entry.probeUntil - now,
        });
      }
      entry.version++;
      entry.probeToken = this.#randomId();
      entry.probeUntil = now + policy.halfOpenLeaseSeconds * 1_000;
      return Promise.resolve({
        allowed: true,
        state: "half_open",
        version: entry.version,
        probeToken: entry.probeToken,
      });
    }
    return Promise.resolve({ allowed: true, state: "closed", version: entry.version });
  }

  recordSuccess(targetId: string, permit: BreakerPermit): Promise<BreakerSnapshot> {
    const id = targetKey(targetId);
    const entry = this.#entries.get(id);
    if (!entry) return Promise.resolve(closedSnapshot());
    entry.touchedAt = this.#now();
    if (
      permit.state === "half_open" && permit.probeToken &&
      permit.version === entry.version && permit.probeToken === entry.probeToken
    ) {
      entry.version++;
      entry.failures = [];
      entry.openUntil = null;
      entry.probeToken = null;
      entry.probeUntil = null;
    }
    return Promise.resolve(this.#snapshot(entry, this.#now()));
  }

  recordFailure(
    targetId: string,
    permit: BreakerPermit,
    input: BreakerPolicy,
  ): Promise<BreakerSnapshot> {
    const id = targetKey(targetId);
    const policy = validateBreakerPolicy(input);
    const now = this.#now();
    const entry = this.#entries.get(id);
    if (!entry) return Promise.resolve(closedSnapshot());
    entry.touchedAt = now;
    this.#prune(entry, policy, now);
    const validClosed = permit.state === "closed" && permit.version === entry.version &&
      entry.openUntil === null;
    const validProbe = permit.state === "half_open" && permit.version === entry.version &&
      Boolean(permit.probeToken) && permit.probeToken === entry.probeToken;
    if (!validClosed && !validProbe) return Promise.resolve(this.#snapshot(entry, now));
    entry.failures.push(now);
    if (validProbe || entry.failures.length >= policy.failureThreshold) {
      entry.version++;
      entry.openUntil = now + policy.openSeconds * 1_000;
      entry.probeToken = null;
      entry.probeUntil = null;
    }
    return Promise.resolve(this.#snapshot(entry, now));
  }

  inspect(targetId: string, input: BreakerPolicy): Promise<BreakerSnapshot> {
    const id = targetKey(targetId);
    const policy = validateBreakerPolicy(input);
    const now = this.#now();
    const entry = this.#entries.get(id);
    if (!entry) {
      return Promise.resolve(closedSnapshot());
    }
    entry.touchedAt = now;
    this.#prune(entry, policy, now);
    return Promise.resolve(this.#snapshot(entry, now));
  }

  reset(targetId: string, expectedVersion: number): Promise<boolean> {
    const id = targetKey(targetId);
    const entry = this.#entries.get(id);
    if (!entry || entry.version !== expectedVersion) return Promise.resolve(false);
    entry.version = ++this.#nextVersion;
    entry.failures = [];
    entry.openUntil = null;
    entry.probeToken = null;
    entry.probeUntil = null;
    entry.touchedAt = this.#now();
    return Promise.resolve(true);
  }

  get size() {
    return this.#entries.size;
  }

  #snapshot(entry: MemoryEntry, now: number): BreakerSnapshot {
    const state = entry.openUntil === null
      ? "closed"
      : entry.openUntil > now
      ? "open"
      : entry.probeToken && entry.probeUntil !== null && entry.probeUntil > now
      ? "half_open"
      : "half_open";
    return {
      state,
      version: entry.version,
      failureCount: entry.failures.length,
      openUntil: entry.openUntil,
      probeUntil: entry.probeUntil,
      ...(state === "open" && entry.openUntil !== null
        ? { retryAfterMs: Math.max(0, entry.openUntil - now) }
        : state === "half_open" && entry.probeUntil !== null && entry.probeUntil > now
        ? { retryAfterMs: entry.probeUntil - now }
        : {}),
    };
  }

  health() {
    return Promise.resolve(true);
  }

  close() {
    this.#entries.clear();
    return Promise.resolve();
  }
}

const BEFORE_ATTEMPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local cutoff = now - tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
local version = redis.call('HGET', KEYS[1], 'version')
if not version then
  version = 1
  redis.call('HSET', KEYS[1], 'version', version)
else
  version = tonumber(version)
end
local openUntil = tonumber(redis.call('HGET', KEYS[1], 'open_until') or '0')
local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probe_until') or '0')
if openUntil > now then
  return {0, 'open', version, '', openUntil - now, now}
end
if openUntil > 0 then
  if probeUntil > now then
    return {0, 'half_open', version, '', probeUntil - now, now}
  end
  version = version + 1
  redis.call('HSET', KEYS[1], 'version', version, 'probe_token', ARGV[3],
    'probe_until', now + tonumber(ARGV[2]))
  return {1, 'half_open', version, ARGV[3], 0, now}
end
return {1, 'closed', version, '', 0, now}
`;

const RECORD_FAILURE = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local cutoff = now - tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
local version = redis.call('HGET', KEYS[1], 'version')
local count = tonumber(redis.call('ZCARD', KEYS[2]))
if not version then return {0, count, 0, 0, now} end
version = tonumber(version)
local currentProbe = redis.call('HGET', KEYS[1], 'probe_token') or ''
local openUntil = tonumber(redis.call('HGET', KEYS[1], 'open_until') or '0')
local validVersion = tonumber(ARGV[6]) == version
local validClosed = ARGV[4] == 'closed' and validVersion and openUntil == 0
local validProbe = ARGV[4] == 'half_open' and validVersion and ARGV[5] ~= '' and ARGV[5] == currentProbe
if not validClosed and not validProbe then
  local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probe_until') or '0')
  return {version, count, openUntil, probeUntil, now}
end
redis.call('ZADD', KEYS[2], now, ARGV[7])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[8]))
count = tonumber(redis.call('ZCARD', KEYS[2]))
if validProbe or count >= tonumber(ARGV[2]) then
  version = version + 1
  redis.call('HSET', KEYS[1], 'version', version, 'open_until', now + tonumber(ARGV[3]))
  redis.call('HDEL', KEYS[1], 'probe_token', 'probe_until')
end
openUntil = tonumber(redis.call('HGET', KEYS[1], 'open_until') or '0')
local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probe_until') or '0')
return {version, count, openUntil, probeUntil, now}
`;

const RECORD_SUCCESS = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local version = redis.call('HGET', KEYS[1], 'version')
if not version then return {0, 0, 0, 0, now} end
version = tonumber(version)
local currentProbe = redis.call('HGET', KEYS[1], 'probe_token') or ''
if ARGV[1] == 'half_open' and tonumber(ARGV[3]) == version and ARGV[2] ~= '' and ARGV[2] == currentProbe then
  version = version + 1
  redis.call('DEL', KEYS[2])
  redis.call('HSET', KEYS[1], 'version', version)
  redis.call('HDEL', KEYS[1], 'open_until', 'probe_token', 'probe_until')
end
local count = tonumber(redis.call('ZCARD', KEYS[2]))
local openUntil = tonumber(redis.call('HGET', KEYS[1], 'open_until') or '0')
local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probe_until') or '0')
return {version, count, openUntil, probeUntil, now}
`;

const INSPECT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[1]))
local version = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
local count = tonumber(redis.call('ZCARD', KEYS[2]))
local openUntil = tonumber(redis.call('HGET', KEYS[1], 'open_until') or '0')
local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probe_until') or '0')
return {version, count, openUntil, probeUntil, now}
`;

export class RedisCircuitBreaker implements CircuitBreaker {
  readonly #redis: Redis;
  readonly #namespace: "live" | "playground";
  #connecting?: Promise<void>;
  #closed = false;

  constructor(
    url: string,
    options: {
      namespace?: "live" | "playground";
      connectTimeoutMs?: number;
      commandTimeoutMs?: number;
    } = {},
  ) {
    this.#namespace = options.namespace ?? "live";
    const connectTimeout = options.connectTimeoutMs ?? 750;
    const commandTimeout = options.commandTimeoutMs ?? 750;
    for (
      const [name, value] of [["connectTimeoutMs", connectTimeout], [
        "commandTimeoutMs",
        commandTimeout,
      ]] as const
    ) {
      if (!Number.isSafeInteger(value) || value < 100 || value > 5_000) {
        throw new TypeError(`${name} must be an integer from 100 to 5000`);
      }
    }
    this.#redis = new Redis(url, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout,
      commandTimeout,
      retryStrategy: () => null,
    });
    this.#redis.on("error", () => undefined);
  }

  async #connect() {
    if (this.#closed) throw new Error("Circuit breaker is closed");
    if (this.#redis.status === "ready") return;
    this.#connecting ??= this.#redis.connect().finally(() => this.#connecting = undefined);
    await this.#connecting;
  }

  #keys(targetId: string): [string, string] {
    const id = targetKey(targetId);
    const base = `dg-chat:breaker:${this.#namespace}:${id}`;
    return [base, `${base}:failures`];
  }

  async beforeAttempt(targetId: string, input: BreakerPolicy): Promise<BreakerPermit> {
    const policy = validateBreakerPolicy(input);
    const keys = this.#keys(targetId);
    try {
      await this.#connect();
      const result = await this.#redis.eval(
        BEFORE_ATTEMPT,
        2,
        ...keys,
        policy.failureWindowSeconds * 1_000,
        policy.halfOpenLeaseSeconds * 1_000,
        crypto.randomUUID(),
      ) as [number, BreakerState, number, string, number, number];
      return {
        allowed: Number(result[0]) === 1,
        state: result[1],
        version: Number(result[2]),
        probeToken: result[3] || undefined,
        retryAfterMs: Number(result[4]) || undefined,
      };
    } catch {
      return { allowed: true, state: "unavailable", version: 0 };
    }
  }

  async recordFailure(
    targetId: string,
    permit: BreakerPermit,
    input: BreakerPolicy,
  ): Promise<BreakerSnapshot> {
    const policy = validateBreakerPolicy(input);
    const keys = this.#keys(targetId);
    try {
      await this.#connect();
      const ttl = (policy.failureWindowSeconds + policy.openSeconds +
        policy.halfOpenLeaseSeconds) * 1_000;
      const result = await this.#redis.eval(
        RECORD_FAILURE,
        2,
        ...keys,
        policy.failureWindowSeconds * 1_000,
        policy.failureThreshold,
        policy.openSeconds * 1_000,
        permit.state,
        permit.probeToken ?? "",
        permit.version,
        crypto.randomUUID(),
        ttl,
      ) as [number, number, number, number, number];
      return snapshot(result);
    } catch {
      return unavailableSnapshot();
    }
  }

  async recordSuccess(targetId: string, permit: BreakerPermit): Promise<BreakerSnapshot> {
    const keys = this.#keys(targetId);
    try {
      await this.#connect();
      const result = await this.#redis.eval(
        RECORD_SUCCESS,
        2,
        ...keys,
        permit.state,
        permit.probeToken ?? "",
        permit.version,
      ) as [number, number, number, number, number];
      return snapshot(result);
    } catch {
      return unavailableSnapshot();
    }
  }

  async inspect(targetId: string, input: BreakerPolicy): Promise<BreakerSnapshot> {
    const policy = validateBreakerPolicy(input);
    const keys = this.#keys(targetId);
    try {
      await this.#connect();
      const result = await this.#redis.eval(
        INSPECT,
        2,
        ...keys,
        policy.failureWindowSeconds * 1_000,
      ) as [number, number, number, number, number];
      return snapshot(result);
    } catch {
      return unavailableSnapshot();
    }
  }

  async reset(targetId: string, expectedVersion: number): Promise<boolean> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return false;
    const [state, failures] = this.#keys(targetId);
    try {
      await this.#connect();
      return Number(
        await this.#redis.eval(
          `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
         local version = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
         if version ~= tonumber(ARGV[1]) then return 0 end
         redis.call('DEL', KEYS[2])
         redis.call('HSET', KEYS[1], 'version', version + 1)
         redis.call('HDEL', KEYS[1], 'open_until', 'probe_token', 'probe_until')
         return 1`,
          2,
          state,
          failures,
          expectedVersion,
        ),
      ) === 1;
    } catch {
      return false;
    }
  }

  async health() {
    try {
      await this.#connect();
      return await this.#redis.ping() === "PONG";
    } catch {
      return false;
    }
  }

  async close() {
    this.#closed = true;
    if (this.#redis.status === "ready") await this.#redis.quit();
    else this.#redis.disconnect();
  }
}

/** Carries the exact distributed permit through a resilience attempt outcome. */
export class CircuitBreakerStoreAdapter implements CircuitStore {
  readonly #policy: BreakerPolicy;

  constructor(
    private readonly breaker: CircuitBreaker,
    policy: BreakerPolicy,
    private readonly now: () => number = Date.now,
  ) {
    this.#policy = validateBreakerPolicy(policy);
  }

  async acquire(
    candidateId: string,
    _policy: ResiliencePolicy,
  ): Promise<ResilienceCircuitPermit> {
    const permit = await this.breaker.beforeAttempt(candidateId, this.#policy);
    return {
      allowed: permit.allowed,
      state: permit.state,
      retryAt: permit.retryAfterMs === undefined ? undefined : this.now() + permit.retryAfterMs,
      lease: permit,
    };
  }

  async success(candidateId: string, permit: ResilienceCircuitPermit): Promise<BreakerState> {
    const lease = this.#lease(permit);
    return (await this.breaker.recordSuccess(candidateId, lease)).state;
  }

  async failure(
    candidateId: string,
    permit: ResilienceCircuitPermit,
    _policy: ResiliencePolicy,
  ): Promise<{ state: BreakerState; retryAt?: number }> {
    const lease = this.#lease(permit);
    const snapshot = await this.breaker.recordFailure(candidateId, lease, this.#policy);
    const retryAt = snapshot.retryAfterMs === undefined
      ? undefined
      : this.now() + snapshot.retryAfterMs;
    return { state: snapshot.state, ...(retryAt === undefined ? {} : { retryAt }) };
  }

  #lease(permit: ResilienceCircuitPermit): BreakerPermit {
    const lease = permit.lease;
    if (
      !lease || typeof lease !== "object" ||
      typeof (lease as BreakerPermit).allowed !== "boolean" ||
      !Number.isSafeInteger((lease as BreakerPermit).version)
    ) throw new TypeError("Circuit permit lease is missing or invalid");
    return lease as BreakerPermit;
  }
}

function snapshot(
  value: [number, number, number, number, number],
): BreakerSnapshot {
  const [version, failureCount, rawOpenUntil, rawProbeUntil, now] = value.map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const openUntil = rawOpenUntil || null;
  const probeUntil = rawProbeUntil || null;
  const state = openUntil === null ? "closed" : openUntil > now ? "open" : "half_open";
  return {
    state,
    version,
    failureCount,
    openUntil,
    probeUntil,
    ...(state === "open" && openUntil !== null
      ? { retryAfterMs: Math.max(0, openUntil - now) }
      : state === "half_open" && probeUntil !== null && probeUntil > now
      ? { retryAfterMs: probeUntil - now }
      : {}),
  };
}

function unavailableSnapshot(): BreakerSnapshot {
  return {
    state: "unavailable",
    version: 0,
    failureCount: 0,
    openUntil: null,
    probeUntil: null,
  };
}

function closedSnapshot(): BreakerSnapshot {
  return {
    state: "closed",
    version: 0,
    failureCount: 0,
    openUntil: null,
    probeUntil: null,
  };
}
