import { Redis } from "ioredis";

export interface AudioConcurrencyLimits {
  global: number;
  perUser: number;
}

export interface AudioConcurrencyLease {
  readonly id: string;
  /** Aborts when this process can no longer prove that it owns the distributed slot. */
  readonly signal: AbortSignal;
  release(): Promise<void>;
}

export interface AudioConcurrencyLimiter {
  acquire(ownerId: string, limits: AudioConcurrencyLimits): Promise<AudioConcurrencyLease | null>;
  close(): Promise<void>;
}

function validate(ownerId: string, limits: AudioConcurrencyLimits): void {
  if (!ownerId || ownerId.length > 200) throw new TypeError("ownerId is invalid");
  if (
    !Number.isSafeInteger(limits.global) || limits.global < 1 ||
    !Number.isSafeInteger(limits.perUser) || limits.perUser < 1 ||
    limits.perUser > limits.global
  ) throw new TypeError("audio concurrency limits are invalid");
}

export class MemoryAudioConcurrencyLimiter implements AudioConcurrencyLimiter {
  readonly #leases = new Map<
    string,
    {
      ownerId: string;
      expiresAt: number;
      controller: AbortController;
      renewalTimer?: ReturnType<typeof setInterval>;
      fenceTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #leaseMs: number;
  readonly #now: () => number;
  readonly #autoRenew: boolean;

  constructor(options: { leaseMs?: number; now?: () => number; autoRenew?: boolean } = {}) {
    this.#leaseMs = options.leaseMs ?? 120_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000) {
      throw new TypeError("leaseMs must be an integer of at least 1000");
    }
    this.#now = options.now ?? Date.now;
    this.#autoRenew = options.autoRenew ?? true;
  }

  #purge(now: number): void {
    for (const [id, lease] of this.#leases) {
      if (lease.expiresAt > now) continue;
      lease.controller.abort(new Error("Audio concurrency lease expired"));
      if (lease.renewalTimer !== undefined) clearInterval(lease.renewalTimer);
      if (lease.fenceTimer !== undefined) clearTimeout(lease.fenceTimer);
      this.#leases.delete(id);
    }
  }

  acquire(ownerId: string, limits: AudioConcurrencyLimits): Promise<AudioConcurrencyLease | null> {
    validate(ownerId, limits);
    const now = this.#now();
    this.#purge(now);
    let ownerCount = 0;
    for (const lease of this.#leases.values()) if (lease.ownerId === ownerId) ownerCount++;
    if (this.#leases.size >= limits.global || ownerCount >= limits.perUser) {
      return Promise.resolve(null);
    }
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const record: {
      ownerId: string;
      expiresAt: number;
      controller: AbortController;
      renewalTimer?: ReturnType<typeof setInterval>;
      fenceTimer?: ReturnType<typeof setTimeout>;
    } = {
      ownerId,
      expiresAt: now + this.#leaseMs,
      controller,
    };
    const fence = () => {
      const current = this.#leases.get(id);
      if (!current || this.#now() < current.expiresAt) return;
      current.controller.abort(new Error("Audio concurrency lease expired"));
      if (current.renewalTimer !== undefined) clearInterval(current.renewalTimer);
      this.#leases.delete(id);
    };
    record.fenceTimer = setTimeout(fence, this.#leaseMs);
    if (this.#autoRenew) {
      record.renewalTimer = setInterval(() => {
        const current = this.#leases.get(id);
        if (!current) return;
        const renewedAt = this.#now();
        if (renewedAt >= current.expiresAt) {
          fence();
          return;
        }
        current.expiresAt = renewedAt + this.#leaseMs;
        if (current.fenceTimer !== undefined) clearTimeout(current.fenceTimer);
        current.fenceTimer = setTimeout(fence, this.#leaseMs);
      }, Math.max(250, Math.floor(this.#leaseMs / 3)));
    }
    this.#leases.set(id, record);
    let released = false;
    return Promise.resolve({
      id,
      signal: controller.signal,
      release: () => {
        if (released) return Promise.resolve();
        released = true;
        const current = this.#leases.get(id);
        if (current?.renewalTimer !== undefined) clearInterval(current.renewalTimer);
        if (current?.fenceTimer !== undefined) clearTimeout(current.fenceTimer);
        this.#leases.delete(id);
        return Promise.resolve();
      },
    });
  }

  close(): Promise<void> {
    for (const lease of this.#leases.values()) {
      lease.controller.abort(new Error("Audio concurrency limiter closed"));
      if (lease.renewalTimer !== undefined) clearInterval(lease.renewalTimer);
      if (lease.fenceTimer !== undefined) clearTimeout(lease.fenceTimer);
    }
    this.#leases.clear();
    return Promise.resolve();
  }
}

type RedisClient = Pick<Redis, "status" | "connect" | "eval" | "quit" | "disconnect" | "on">;

const ACQUIRE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if tonumber(redis.call('ZCARD', KEYS[1])) >= tonumber(ARGV[2]) or
   tonumber(redis.call('ZCARD', KEYS[2])) >= tonumber(ARGV[3]) then
  return 0
end
local expires = now + tonumber(ARGV[4])
redis.call('ZADD', KEYS[1], expires, ARGV[1])
redis.call('ZADD', KEYS[2], expires, ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[4]) * 2)
return 1`;

const RENEW_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false or
   redis.call('ZSCORE', KEYS[2], ARGV[1]) == false then return 0 end
local clock = redis.call('TIME')
local expires = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000) + tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], expires, ARGV[1])
redis.call('ZADD', KEYS[2], expires, ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]) * 2)
return 1`;

const RELEASE_SCRIPT = `
local globalRemoved = redis.call('ZREM', KEYS[1], ARGV[1])
local userRemoved = redis.call('ZREM', KEYS[2], ARGV[1])
return globalRemoved + userRemoved`;

export class RedisAudioConcurrencyLimiter implements AudioConcurrencyLimiter {
  readonly #redis: RedisClient;
  readonly #leaseMs: number;
  #connecting?: Promise<void>;
  readonly #renewals = new Set<ReturnType<typeof setInterval>>();
  readonly #fences = new Set<ReturnType<typeof setTimeout>>();
  readonly #controllers = new Set<AbortController>();

  constructor(
    url: string,
    options: { leaseMs?: number; client?: RedisClient } = {},
  ) {
    this.#leaseMs = options.leaseMs ?? 120_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000) {
      throw new TypeError("leaseMs must be an integer of at least 1000");
    }
    this.#redis = options.client ?? new Redis(url, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.#redis.on("error", () => undefined);
  }

  async #ensureConnected(): Promise<void> {
    if (this.#redis.status === "ready") return;
    this.#connecting ??= this.#redis.connect().finally(() => this.#connecting = undefined);
    await this.#connecting;
  }

  async acquire(
    ownerId: string,
    limits: AudioConcurrencyLimits,
  ): Promise<AudioConcurrencyLease | null> {
    validate(ownerId, limits);
    await this.#ensureConnected();
    const id = crypto.randomUUID();
    const globalKey = "dg-chat:audio:{concurrency}:global";
    const userKey = `dg-chat:audio:{concurrency}:user:${ownerId}`;
    // Start the local fencing deadline before the round trip. Redis computes its expiry while
    // executing the script, so using response time could let this holder outlive Redis by one RTT.
    const acquisitionStartedAt = Date.now();
    const acquired = Number(
      await this.#redis.eval(
        ACQUIRE_SCRIPT,
        2,
        globalKey,
        userKey,
        id,
        limits.global,
        limits.perUser,
        this.#leaseMs,
      ),
    );
    if (acquired !== 1) return null;
    let released = false;
    const controller = new AbortController();
    this.#controllers.add(controller);
    let confirmedUntil = acquisitionStartedAt + this.#leaseMs;
    let renewalInFlight = false;
    let fenceTimer: ReturnType<typeof setTimeout>;
    const lose = () => {
      if (released || controller.signal.aborted) return;
      controller.abort(new Error("Audio concurrency lease could not be renewed"));
      this.#controllers.delete(controller);
      clearInterval(timer);
      this.#renewals.delete(timer);
      this.#fences.delete(fenceTimer);
    };
    const scheduleFence = () => {
      if (fenceTimer !== undefined) {
        clearTimeout(fenceTimer);
        this.#fences.delete(fenceTimer);
      }
      fenceTimer = setTimeout(lose, Math.max(0, confirmedUntil - Date.now()));
      this.#fences.add(fenceTimer);
    };
    const timer = setInterval(() => {
      if (released || controller.signal.aborted || renewalInFlight) return;
      if (Date.now() >= confirmedUntil) {
        lose();
        return;
      }
      renewalInFlight = true;
      const renewalStartedAt = Date.now();
      void this.#redis.eval(RENEW_SCRIPT, 2, globalKey, userKey, id, this.#leaseMs).then(
        (renewed) => {
          if (released || controller.signal.aborted) return;
          if (Number(renewed) !== 1) {
            lose();
            return;
          }
          confirmedUntil = renewalStartedAt + this.#leaseMs;
          if (Date.now() >= confirmedUntil) {
            lose();
            return;
          }
          scheduleFence();
        },
        () => {
          // The existing deadline remains authoritative. A later tick may recover before it.
        },
      ).finally(() => renewalInFlight = false);
    }, Math.max(250, Math.floor(this.#leaseMs / 3)));
    this.#renewals.add(timer);
    scheduleFence();
    return {
      id,
      signal: controller.signal,
      release: async () => {
        if (released) return;
        released = true;
        this.#controllers.delete(controller);
        clearInterval(timer);
        this.#renewals.delete(timer);
        clearTimeout(fenceTimer);
        this.#fences.delete(fenceTimer);
        await this.#ensureConnected();
        await this.#redis.eval(RELEASE_SCRIPT, 2, globalKey, userKey, id);
      },
    };
  }

  async close(): Promise<void> {
    for (const timer of this.#renewals) clearInterval(timer);
    this.#renewals.clear();
    for (const timer of this.#fences) clearTimeout(timer);
    this.#fences.clear();
    for (const controller of this.#controllers) {
      controller.abort(new Error("Audio concurrency limiter closed"));
    }
    this.#controllers.clear();
    if (this.#redis.status === "ready") await this.#redis.quit();
    else this.#redis.disconnect();
  }
}
