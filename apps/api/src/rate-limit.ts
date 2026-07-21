import { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Public, non-secret adapter identity used by readiness diagnostics. */
  readonly implementation?: "memory" | "redis" | "custom";
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  health(signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}

export function authorizationCredentialIdentity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bearer = /^\s*Bearer[\t ]+([^\t ]+)[\t ]*$/i.exec(value);
  return bearer ? `bearer:${bearer[1]}` : undefined;
}

export class MemoryRateLimiter implements RateLimiter {
  readonly implementation = "memory" as const;
  readonly #entries = new Map<string, { count: number; resetsAt: number }>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.#maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive safe integer");
    }
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  #makeRoom(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.resetsAt <= now) this.#entries.delete(key);
    }
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = this.#now();
    let entry = this.#entries.get(key);
    if (entry?.resetsAt !== undefined && entry.resetsAt <= now) {
      this.#entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (this.#entries.size >= this.#maxEntries) this.#makeRoom(now);
      entry = { count: 0, resetsAt: now + windowSeconds * 1000 };
      this.#entries.set(key, entry);
    }
    entry.count++;
    return Promise.resolve({
      allowed: entry.count <= limit,
      limit,
      remaining: Math.max(0, limit - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - now) / 1000)),
    });
  }

  close() {
    return Promise.resolve();
  }

  health() {
    return Promise.resolve(true);
  }
}

export class RedisRateLimiter implements RateLimiter {
  readonly implementation = "redis" as const;
  readonly #redis: Redis;
  #connecting?: Promise<void>;

  constructor(url: string) {
    this.#redis = new Redis(url, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    // Connection failures are surfaced through consume()/health(); registering a listener keeps
    // ioredis from emitting duplicate "Unhandled error event" diagnostics during recovery.
    this.#redis.on("error", () => undefined);
  }

  async #ensureConnected() {
    if (this.#redis.status === "ready") return;
    this.#connecting ??= this.#redis.connect().finally(() => {
      this.#connecting = undefined;
    });
    await this.#connecting;
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    await this.#ensureConnected();
    const redisKey = `dg-chat:rate:${key}`;
    const [count, ttl] = await this.#redis.eval(
      `local count = redis.call('INCR', KEYS[1])
       local ttl = redis.call('TTL', KEYS[1])
       if count == 1 or ttl < 0 then
         redis.call('EXPIRE', KEYS[1], ARGV[1])
         ttl = tonumber(ARGV[1])
       end
       return {count, ttl}`,
      1,
      redisKey,
      windowSeconds,
    ) as [number, number];
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: Math.max(1, ttl),
    };
  }

  async close() {
    if (this.#redis.status === "ready") await this.#redis.quit();
    else this.#redis.disconnect();
  }

  async health(signal?: AbortSignal) {
    try {
      if (signal?.aborted) return false;
      const health = (async () => {
        await this.#ensureConnected();
        return await this.#redis.ping() === "PONG";
      })();
      if (!signal) return await health;
      return await new Promise<boolean>((resolve) => {
        // ioredis does not expose per-command cancellation. Resolve this health probe on abort,
        // but do not disconnect the shared client: doing so would disrupt concurrent requests.
        // The route-level readiness deadline remains the hard caller-visible bound, while the
        // in-flight ping settles independently under ioredis' finite retry policy.
        const aborted = () => resolve(false);
        signal.addEventListener("abort", aborted, { once: true });
        void health.then(resolve, () => resolve(false)).finally(() => {
          signal.removeEventListener("abort", aborted);
        });
      });
    } catch {
      return false;
    }
  }
}

function validAddress(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 45) return undefined;
  const octets = candidate.split(".");
  if (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  ) return candidate;
  if (!candidate.includes(":") || !/^[0-9a-f:.]+$/i.test(candidate)) return undefined;
  try {
    new URL(`http://[${candidate}]/`);
    return candidate;
  } catch {
    return undefined;
  }
}

/** Forwarded headers are attacker-controlled unless the deployment explicitly trusts its proxy. */
export function requestClientKey(
  headers: Headers,
  trustProxy = Deno.env.get("TRUST_PROXY_HEADERS") === "true",
): string {
  if (!trustProxy) return "untrusted-client";
  const realIp = validAddress(headers.get("x-real-ip"));
  if (realIp) return realIp;
  return validAddress(headers.get("x-forwarded-for")?.split(",", 1)[0]) ?? "unknown-proxy-client";
}

export function requestTrustedClientKey(
  headers: Headers,
  trustProxy = Deno.env.get("TRUST_PROXY_HEADERS") === "true",
): string | undefined {
  if (!trustProxy) return undefined;
  return validAddress(headers.get("x-real-ip")) ??
    validAddress(headers.get("x-forwarded-for")?.split(",", 1)[0]);
}
