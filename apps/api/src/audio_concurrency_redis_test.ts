import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.14";
import { Redis } from "ioredis";
import { RedisAudioConcurrencyLimiter } from "./audio-concurrency.ts";

const redisUrl = Deno.env.get("TEST_REDIS_URL");

Deno.test({
  name: "Redis audio admission is shared, atomic, token-safe, and expires crashed leases",
  ignore: !redisUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const prefix = "dg-chat:audio:{concurrency}:";
    const raw = new Redis(redisUrl!, { lazyConnect: true });
    const one = new RedisAudioConcurrencyLimiter(redisUrl!, { leaseMs: 1_000 });
    const two = new RedisAudioConcurrencyLimiter(redisUrl!, { leaseMs: 1_000 });
    await raw.connect();
    await raw.del(`${prefix}global`, `${prefix}user:user-a`, `${prefix}user:user-b`);
    try {
      const [a, b] = await Promise.all([
        one.acquire("user-a", { global: 2, perUser: 1 }),
        two.acquire("user-a", { global: 2, perUser: 1 }),
      ]);
      assert((a === null) !== (b === null));
      const ownerLease = a ?? b!;
      const otherLease = await two.acquire("user-b", { global: 2, perUser: 1 });
      assert(otherLease);
      assertNotEquals(ownerLease.id, otherLease.id);
      assertEquals(await one.acquire("user-b", { global: 2, perUser: 1 }), null);

      await ownerLease.release();
      const replacement = await one.acquire("user-a", { global: 2, perUser: 1 });
      assert(replacement);
      await ownerLease.release();
      assertEquals(await one.acquire("user-a", { global: 2, perUser: 1 }), null);
      await replacement.release();

      // Simulate the holder crashing: close stops renewal but deliberately leaves the lease for
      // Redis TTL/score cleanup rather than pretending a graceful release occurred.
      await two.close();
      await new Promise((resolve) => setTimeout(resolve, 1_150));
      const afterCrash = await one.acquire("user-b", { global: 2, perUser: 1 });
      assert(afterCrash);
      await afterCrash.release();
    } finally {
      await one.close();
      await two.close();
      await raw.del(`${prefix}global`, `${prefix}user:user-a`, `${prefix}user:user-b`);
      await raw.quit();
    }
  },
});
