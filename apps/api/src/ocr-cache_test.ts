import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ocrCacheFailureModeFromEnv, RedisOcrCache } from "./ocr-cache.ts";

const key = `ocr:v1:${"a".repeat(64)}`;

class FakeRedis {
  status = "wait";
  values = new Map<string, string>();
  writes: Array<[string, string, string, number]> = [];
  fail = false;
  on() {}
  connect() {
    if (this.fail) return Promise.reject(new Error("redis unavailable"));
    this.status = "ready";
    return Promise.resolve();
  }
  get(cacheKey: string) {
    if (this.fail) return Promise.reject(new Error("redis unavailable"));
    return Promise.resolve(this.values.get(cacheKey) ?? null);
  }
  set(cacheKey: string, value: string, mode: "EX", ttl: number) {
    if (this.fail) return Promise.reject(new Error("redis unavailable"));
    this.writes.push([cacheKey, value, mode, ttl]);
    this.values.set(cacheKey, value);
    return Promise.resolve("OK");
  }
  quit() {
    this.status = "end";
    return Promise.resolve("OK");
  }
  disconnect() {
    this.status = "end";
  }
}

Deno.test("Redis OCR cache stores only hashed keys with an atomic Redis TTL", async () => {
  const client = new FakeRedis();
  const cache = new RedisOcrCache("redis://unused", { client });
  await cache.set(key, "invoice 42", 90);
  assertEquals(client.writes, [[key, "invoice 42", "EX", 90]]);
  assertEquals(await cache.get(key), "invoice 42");
  await cache.close();
  assertEquals(client.status, "end");
});

Deno.test("Redis OCR cache fail-open converts read and write outages to miss/no-op", async () => {
  const client = new FakeRedis();
  client.fail = true;
  const cache = new RedisOcrCache("redis://unused", { client, failureMode: "fail-open" });
  assertEquals(await cache.get(key), null);
  await cache.set(key, "retry provider safely", 60);
});

Deno.test("Redis OCR cache fail-closed prevents uncached provider dispatch during outages", async () => {
  const client = new FakeRedis();
  client.fail = true;
  const cache = new RedisOcrCache("redis://unused", { client, failureMode: "fail-closed" });
  await assertRejects(() => cache.get(key), Error, "redis unavailable");
  await assertRejects(() => cache.set(key, "must persist", 60), Error, "redis unavailable");
});

Deno.test("Redis OCR cache rejects unhashed keys, unsafe TTLs, and oversized shared values", async () => {
  const client = new FakeRedis();
  const cache = new RedisOcrCache("redis://unused", { client });
  await assertRejects(() => cache.get("ocr:raw:https://secret.example/image"), TypeError);
  await assertRejects(() => cache.set(key, "x", 0), TypeError);
  client.values.set(key, "x".repeat(2_000_001));
  assertEquals(await cache.get(key), null);
});

Deno.test("OCR cache environment failure policy is explicit", () => {
  assertEquals(ocrCacheFailureModeFromEnv(undefined), "fail-open");
  assertEquals(ocrCacheFailureModeFromEnv("fail-closed"), "fail-closed");
  assertThrows(() => ocrCacheFailureModeFromEnv("sometimes"), Error);
});
