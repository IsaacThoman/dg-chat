import { assertEquals, assertMatch } from "jsr:@std/assert@1.0.14";
import type { DomainRepository, ObjectStore } from "@dg-chat/database";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { readinessTimeoutsFromEnv } from "./readiness.ts";

function hungProbe(signal: AbortSignal, aborted: { value: boolean }): Promise<never> {
  signal.addEventListener("abort", () => aborted.value = true, { once: true });
  return new Promise(() => {});
}

Deno.test("ready returns a sanitized 503 promptly and cancels hung dependency probes", async () => {
  const postgresAborted = { value: false };
  const redisAborted = { value: false };
  const objectsAborted = { value: false };
  let postgresProbes = 0;
  let redisProbes = 0;
  let objectProbes = 0;
  const base = new MemoryRepository();
  const repository = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "readiness") {
        return (signal: AbortSignal) => {
          postgresProbes++;
          return hungProbe(signal, postgresAborted);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as DomainRepository;
  const rateLimiter: RateLimiter = {
    consume: () => Promise.reject(new Error("unused")),
    health: (signal) => {
      redisProbes++;
      return hungProbe(signal!, redisAborted);
    },
    close: () => Promise.resolve(),
  };
  const objectStore: ObjectStore = {
    put: () => Promise.reject(new Error("unused")),
    get: () => Promise.reject(new Error("unused")),
    delete: () => Promise.reject(new Error("unused")),
    readiness: (signal) => {
      objectProbes++;
      return hungProbe(signal!, objectsAborted);
    },
    close: () => undefined,
  };
  const { app } = createApp({
    repository,
    rateLimiter,
    objectStore,
    readinessTimeouts: { postgresMs: 10, redisMs: 10, objectStoreMs: 10 },
    requestLogSink: () => undefined,
  });

  const started = performance.now();
  const responses = await Promise.all(Array.from({ length: 10 }, () => app.request("/ready")));
  const elapsed = performance.now() - started;

  assertEquals(responses.every((response) => response.status === 503), true);
  assertEquals(
    responses.every((response) => response.headers.get("cache-control") === "no-store"),
    true,
  );
  assertEquals(elapsed < 250, true);
  assertEquals(await responses[0].json(), {
    status: "not_ready",
    storage: { ready: false, storage: "memory" },
    redis: false,
    objects: { configured: true, ready: false },
  });
  assertEquals(postgresAborted.value, true);
  assertEquals(redisAborted.value, true);
  assertEquals(objectsAborted.value, true);
  assertEquals([postgresProbes, redisProbes, objectProbes], [1, 1, 1]);
  assertEquals((await app.request("/ready")).status, 503);
  assertEquals([postgresProbes, redisProbes, objectProbes], [1, 1, 1]);
});

Deno.test("readiness timeout configuration supports common and per-dependency bounds", () => {
  assertEquals(readinessTimeoutsFromEnv({ READINESS_TIMEOUT_MS: "125" }), {
    postgresMs: 125,
    redisMs: 125,
    objectStoreMs: 125,
  });
  assertEquals(
    readinessTimeoutsFromEnv({
      READINESS_TIMEOUT_MS: "125",
      POSTGRES_READINESS_TIMEOUT_MS: "50",
      REDIS_READINESS_TIMEOUT_MS: "75",
      S3_READINESS_TIMEOUT_MS: "100",
    }),
    { postgresMs: 50, redisMs: 75, objectStoreMs: 100 },
  );
  for (const invalid of ["0", "1.5", "30001", "secret-value"]) {
    let message = "";
    try {
      readinessTimeoutsFromEnv({ READINESS_TIMEOUT_MS: invalid });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertMatch(message, /^READINESS_TIMEOUT_MS must be an integer between 1 and 30000$/);
  }
});

Deno.test("ready coalesces concurrent probes and caches the sanitized snapshot briefly", async () => {
  let postgresProbes = 0;
  let redisProbes = 0;
  let objectProbes = 0;
  const delayed = async <T>(value: T): Promise<T> => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return value;
  };
  const base = new MemoryRepository();
  const repository = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "readiness") {
        return () => {
          postgresProbes++;
          return delayed({ ready: true, storage: "memory" });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as DomainRepository;
  const rateLimiter: RateLimiter = {
    consume: () => Promise.reject(new Error("unused")),
    health: () => {
      redisProbes++;
      return delayed(true);
    },
    close: () => Promise.resolve(),
  };
  const objectStore: ObjectStore = {
    put: () => Promise.reject(new Error("unused")),
    get: () => Promise.reject(new Error("unused")),
    delete: () => Promise.reject(new Error("unused")),
    readiness: () => {
      objectProbes++;
      return delayed(true);
    },
    close: () => undefined,
  };
  const { app } = createApp({
    repository,
    rateLimiter,
    objectStore,
    readinessTimeouts: { postgresMs: 500, redisMs: 500, objectStoreMs: 500 },
    readinessCacheMs: 30,
    requestLogSink: () => undefined,
  });

  const concurrent = await Promise.all(Array.from({ length: 20 }, () => app.request("/ready")));
  assertEquals(concurrent.every((response) => response.status === 200), true);
  assertEquals(
    concurrent.every((response) => response.headers.get("cache-control") === "no-store"),
    true,
  );
  assertEquals([postgresProbes, redisProbes, objectProbes], [1, 1, 1]);
  assertEquals(await concurrent[0].json(), {
    status: "ready",
    storage: { ready: true, storage: "memory" },
    redis: true,
    objects: { configured: true, ready: true },
  });

  assertEquals((await app.request("/ready")).status, 200);
  assertEquals([postgresProbes, redisProbes, objectProbes], [1, 1, 1]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assertEquals((await app.request("/ready")).status, 200);
  assertEquals([postgresProbes, redisProbes, objectProbes], [2, 2, 2]);
});

Deno.test("readiness cache configuration rejects unbounded values", () => {
  for (const readinessCacheMs of [Number.POSITIVE_INFINITY, 30_001, 1.5]) {
    let message = "";
    try {
      createApp({ readinessCacheMs });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertEquals(
      message,
      "Readiness cache must be an integer between 0 and 30000 milliseconds",
    );
  }
});
