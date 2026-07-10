import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  authorizationCredentialIdentity,
  MemoryRateLimiter,
  requestClientKey,
} from "./rate-limit.ts";

Deno.test("memory rate limiter enforces a fixed window deterministically", async () => {
  const limiter = new MemoryRateLimiter();
  assertEquals((await limiter.consume("login:client", 2, 60)).allowed, true);
  assertEquals((await limiter.consume("login:client", 2, 60)).remaining, 0);
  const blocked = await limiter.consume("login:client", 2, 60);
  assertEquals(blocked.allowed, false);
  assertEquals(blocked.retryAfterSeconds > 0, true);
});

Deno.test("Bearer credential identity normalizes scheme case and whitespace", () => {
  assertEquals(
    authorizationCredentialIdentity("Bearer dg_same-token"),
    authorizationCredentialIdentity("bearer    dg_same-token\t"),
  );
  assertEquals(authorizationCredentialIdentity("Basic dg_same-token"), undefined);
  assertEquals(authorizationCredentialIdentity("Bearer token with spaces"), undefined);
});

Deno.test("client identity ignores spoofable forwarded headers by default", () => {
  const headers = new Headers({
    "x-forwarded-for": "203.0.113.2, 10.0.0.1",
    "x-real-ip": "198.51.100.7",
  });
  assertEquals(requestClientKey(headers, false), "untrusted-client");
});

Deno.test("trusted proxy identity prefers sanitized real IP and validates fallback", () => {
  assertEquals(
    requestClientKey(
      new Headers({
        "x-real-ip": "198.51.100.7",
        "x-forwarded-for": "203.0.113.2, 10.0.0.1",
      }),
      true,
    ),
    "198.51.100.7",
  );
  assertEquals(
    requestClientKey(new Headers({ "x-forwarded-for": "203.0.113.2, 10.0.0.1" }), true),
    "203.0.113.2",
  );
  assertEquals(
    requestClientKey(new Headers({ "x-real-ip": "attacker-controlled-value" }), true),
    "unknown-proxy-client",
  );
});

Deno.test("memory limiter remains bounded and evicts the oldest active identity", async () => {
  const limiter = new MemoryRateLimiter({ maxEntries: 2 });
  await limiter.consume("first", 1, 60);
  await limiter.consume("second", 1, 60);
  await limiter.consume("third", 1, 60);
  assertEquals(limiter.size, 2);
  assertEquals((await limiter.consume("first", 1, 60)).allowed, true);
  assertEquals(limiter.size, 2);
});

Deno.test("memory limiter prunes expired entries before capacity eviction", async () => {
  let now = 1_000;
  const limiter = new MemoryRateLimiter({ maxEntries: 2, now: () => now });
  await limiter.consume("expired-one", 1, 1);
  await limiter.consume("expired-two", 1, 1);
  now += 1_001;
  await limiter.consume("current", 1, 60);
  assertEquals(limiter.size, 1);
});
