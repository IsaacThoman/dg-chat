import { assertEquals } from "jsr:@std/assert@1.0.14";
import { MemoryRateLimiter } from "./rate-limit.ts";
import { consumeTokenRateLimits } from "./token-rate-limit.ts";

Deno.test("token quotas share rotation family buckets and enforce burst first", async () => {
  let now = 0;
  const limiter = new MemoryRateLimiter({ now: () => now });
  const original = {
    rotationFamilyId: "family-one",
    requestsPerMinute: 3,
    burst: 1,
  };
  assertEquals((await consumeTokenRateLimits(limiter, original, 120, 20))?.allowed, true);
  const rotated = await consumeTokenRateLimits(limiter, original, 120, 20);
  assertEquals({ allowed: rotated?.allowed, bucket: rotated?.bucket }, {
    allowed: false,
    bucket: "burst",
  });

  now = 1_001;
  assertEquals((await consumeTokenRateLimits(limiter, original, 120, 20))?.allowed, true);
  now = 2_002;
  const minuteLimited = await consumeTokenRateLimits(limiter, original, 120, 20);
  assertEquals({ allowed: minuteLimited?.allowed, bucket: minuteLimited?.bucket }, {
    allowed: false,
    bucket: "rpm",
  });
});

Deno.test("tokens without overrides consume a rotation-family default RPM bucket", async () => {
  const limiter = new MemoryRateLimiter();
  const result = await consumeTokenRateLimits(
    limiter,
    {
      rotationFamilyId: "family-default",
      requestsPerMinute: null,
      burst: null,
    },
    1,
    20,
  );
  assertEquals({ allowed: result.allowed, limit: result.limit, bucket: result.bucket }, {
    allowed: true,
    limit: 1,
    bucket: "rpm",
  });
  const rotated = await consumeTokenRateLimits(
    limiter,
    {
      rotationFamilyId: "family-default",
      requestsPerMinute: null,
      burst: null,
    },
    1,
    20,
  );
  assertEquals({ allowed: rotated.allowed, bucket: rotated.bucket }, {
    allowed: false,
    bucket: "rpm",
  });
  assertEquals(limiter.size, 2);
});
