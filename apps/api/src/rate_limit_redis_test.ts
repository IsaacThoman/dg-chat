import { assertEquals } from "jsr:@std/assert@1.0.14";
import { Redis } from "ioredis";
import { RedisRateLimiter } from "./rate-limit.ts";
import { consumeTokenRateLimits } from "./token-rate-limit.ts";

const redisUrl = Deno.env.get("TEST_REDIS_URL");

Deno.test({
  name: "Redis rate limits are atomic, shared, isolated, expiring, and repair missing TTLs",
  ignore: !redisUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const suffix = crypto.randomUUID();
    const first = new RedisRateLimiter(redisUrl!);
    const second = new RedisRateLimiter(redisUrl!);
    const raw = new Redis(redisUrl!, { lazyConnect: true });
    try {
      const results = await Promise.all(
        Array.from(
          { length: 100 },
          (_, index) => (index % 2 ? first : second).consume(`atomic:${suffix}`, 25, 2),
        ),
      );
      assertEquals(results.filter((result) => result.allowed).length, 25);
      assertEquals((await first.consume(`isolated:${suffix}`, 1, 2)).allowed, true);

      await raw.set(`dg-chat:rate:orphan:${suffix}`, "4");
      assertEquals(await raw.ttl(`dg-chat:rate:orphan:${suffix}`), -1);
      const repaired = await first.consume(`orphan:${suffix}`, 10, 1);
      assertEquals(repaired.allowed, true);
      assertEquals((await raw.ttl(`dg-chat:rate:orphan:${suffix}`)) > 0, true);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assertEquals((await first.consume(`orphan:${suffix}`, 1, 1)).allowed, true);
      assertEquals(await first.health(), true);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await raw.quit();
    }
  },
});

Deno.test({
  name: "Redis default token quota is shared across rotation and replicas",
  ignore: !redisUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const family = crypto.randomUUID();
    const first = new RedisRateLimiter(redisUrl!);
    const second = new RedisRateLimiter(redisUrl!);
    const raw = new Redis(redisUrl!, { lazyConnect: true });
    const policy = { rotationFamilyId: family, requestsPerMinute: null, burst: null };
    try {
      assertEquals((await consumeTokenRateLimits(first, policy, 20, 1)).allowed, true);
      assertEquals((await consumeTokenRateLimits(second, policy, 20, 1)).allowed, false);
      assertEquals(await raw.ttl(`dg-chat:rate:token:${family}:rpm`) > 0, true);
    } finally {
      await raw.del(`dg-chat:rate:token:${family}:rpm`);
      await raw.del(`dg-chat:rate:token:${family}:burst`);
      await Promise.all([first.close(), second.close()]);
      await raw.quit();
    }
  },
});
