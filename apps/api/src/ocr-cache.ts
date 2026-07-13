import { Redis } from "ioredis";
import type { OcrCache } from "./ocr-interception.ts";

export type OcrCacheFailureMode = "fail-open" | "fail-closed";

interface RedisOcrClient {
  readonly status: string;
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export interface RedisOcrCacheOptions {
  failureMode?: OcrCacheFailureMode;
  client?: RedisOcrClient;
}

const OCR_CACHE_KEY = /^ocr:v2:[0-9a-f]{64}$/;
const MAX_CACHED_TEXT_BYTES = 2_000_000;

/**
 * Shared OCR cache. Keys must already be one-way hashes, so image bytes, URLs, prompts, and
 * credentials can never become Redis key material. In fail-open mode Redis errors behave as a
 * cache miss/no-op; fail-closed mode rejects OCR instead of dispatching an uncached provider call.
 */
export class RedisOcrCache implements OcrCache {
  readonly #redis: RedisOcrClient;
  readonly #failureMode: OcrCacheFailureMode;
  #connecting?: Promise<void>;

  constructor(url: string, options: RedisOcrCacheOptions = {}) {
    if (!url && !options.client) throw new TypeError("Redis OCR cache requires a URL");
    this.#failureMode = options.failureMode ?? "fail-open";
    if (!(["fail-open", "fail-closed"] as const).includes(this.#failureMode)) {
      throw new TypeError("OCR cache failure mode must be fail-open or fail-closed");
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
    this.#connecting ??= this.#redis.connect().then(() => undefined).finally(() => {
      this.#connecting = undefined;
    });
    await this.#connecting;
  }

  async #withFailurePolicy<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      await this.#ensureConnected();
      return await operation();
    } catch (error) {
      if (this.#failureMode === "fail-closed") throw error;
      return fallback;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!OCR_CACHE_KEY.test(key)) throw new TypeError("OCR cache key must be a versioned hash");
    const value = await this.#withFailurePolicy(() => this.#redis.get(key), null);
    if (value !== null && new TextEncoder().encode(value).length > MAX_CACHED_TEXT_BYTES) {
      // Treat corrupt/oversized shared state as unavailable. Never inject it into a prompt.
      if (this.#failureMode === "fail-closed") {
        throw new Error("OCR cache value exceeds the safe size limit");
      }
      return null;
    }
    return value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!OCR_CACHE_KEY.test(key)) throw new TypeError("OCR cache key must be a versioned hash");
    const size = new TextEncoder().encode(value).length;
    if (!value || size > MAX_CACHED_TEXT_BYTES) {
      throw new TypeError("OCR cache value is outside safe bounds");
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 2_592_000) {
      throw new TypeError("OCR cache TTL is outside safe bounds");
    }
    await this.#withFailurePolicy(
      () => this.#redis.set(key, value, "EX", ttlSeconds).then(() => undefined),
      undefined,
    );
  }

  async close(): Promise<void> {
    if (this.#redis.status === "ready") await this.#redis.quit();
    else this.#redis.disconnect();
  }
}

export function ocrCacheFailureModeFromEnv(value: string | undefined): OcrCacheFailureMode {
  if (value === undefined || value === "fail-open") return "fail-open";
  if (value === "fail-closed") return value;
  throw new Error("OCR_CACHE_FAILURE_MODE must be fail-open or fail-closed");
}
