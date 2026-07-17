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
    const searchPrefix = "dg-chat:search:{concurrency}:";
    const raw = new Redis(redisUrl!, { lazyConnect: true });
    const one = new RedisAudioConcurrencyLimiter(redisUrl!, { leaseMs: 1_000 });
    const two = new RedisAudioConcurrencyLimiter(redisUrl!, { leaseMs: 1_000 });
    const crashedSearch = new RedisAudioConcurrencyLimiter(redisUrl!, { leaseMs: 1_000 });
    await raw.connect();
    await raw.del(
      `${prefix}global`,
      `${prefix}user:user-a`,
      `${prefix}user:user-b`,
      `${searchPrefix}global`,
      `${searchPrefix}user:user-a`,
      `${searchPrefix}user:user-b`,
    );
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

      const searchLease = await one.acquire(
        "user-a",
        { global: 1, perUser: 1 },
        "search",
      );
      assert(searchLease);
      assertEquals(
        await two.acquire("user-b", { global: 1, perUser: 1 }, "search"),
        null,
      );
      await searchLease.release();
      const replacementSearch = await two.acquire(
        "user-b",
        { global: 1, perUser: 1 },
        "search",
      );
      assert(replacementSearch);
      await replacementSearch.release();

      const abandonedSearch = await crashedSearch.acquire(
        "user-a",
        { global: 1, perUser: 1 },
        "search",
      );
      assert(abandonedSearch);
      await crashedSearch.close();
      assertEquals(
        await one.acquire("user-b", { global: 1, perUser: 1 }, "search"),
        null,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_150));
      const searchAfterCrash = await one.acquire(
        "user-b",
        { global: 1, perUser: 1 },
        "search",
      );
      assert(searchAfterCrash);
      await searchAfterCrash.release();

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
      await crashedSearch.close();
      await raw.del(
        `${prefix}global`,
        `${prefix}user:user-a`,
        `${prefix}user:user-b`,
        `${searchPrefix}global`,
        `${searchPrefix}user:user-a`,
        `${searchPrefix}user:user-b`,
      );
      await raw.quit();
    }
  },
});
