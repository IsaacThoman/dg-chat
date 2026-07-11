import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  CircuitBreakerStoreAdapter,
  MemoryCircuitBreaker,
  RedisCircuitBreaker,
  validateBreakerPolicy,
} from "./provider-circuit.ts";
import { executeProviderRequest, ProviderAttemptError } from "./provider-resilience.ts";

const target = "11111111-1111-4111-8111-111111111111";
const policy = {
  failureThreshold: 2,
  failureWindowSeconds: 10,
  openSeconds: 5,
  halfOpenLeaseSeconds: 2,
};

Deno.test("memory breaker opens, admits one half-open probe, and closes on success", async () => {
  let now = 1_000;
  let sequence = 0;
  const breaker = new MemoryCircuitBreaker({
    now: () => now,
    randomId: () => `probe-${++sequence}`,
  });
  const first = await breaker.beforeAttempt(target, policy);
  assertEquals(first.state, "closed");
  await breaker.recordFailure(target, first, policy);
  const second = await breaker.beforeAttempt(target, policy);
  await breaker.recordFailure(target, second, policy);
  const open = await breaker.beforeAttempt(target, policy);
  assertEquals({ allowed: open.allowed, state: open.state, retryAfterMs: open.retryAfterMs }, {
    allowed: false,
    state: "open",
    retryAfterMs: 5_000,
  });

  now += 5_001;
  const probe = await breaker.beforeAttempt(target, policy);
  assertEquals({ allowed: probe.allowed, state: probe.state, probeToken: probe.probeToken }, {
    allowed: true,
    state: "half_open",
    probeToken: "probe-1",
  });
  const concurrent = await breaker.beforeAttempt(target, policy);
  assertEquals({ allowed: concurrent.allowed, state: concurrent.state }, {
    allowed: false,
    state: "half_open",
  });
  const closed = await breaker.recordSuccess(target, probe);
  assertEquals(closed.state, "closed");
  assertEquals(closed.failureCount, 0);
});

Deno.test("failed half-open probe reopens and stale resets are fenced", async () => {
  let now = 10_000;
  const breaker = new MemoryCircuitBreaker({ now: () => now, randomId: () => "probe" });
  const one = await breaker.beforeAttempt(target, { ...policy, failureThreshold: 1 });
  const opened = await breaker.recordFailure(target, one, { ...policy, failureThreshold: 1 });
  assertEquals(await breaker.reset(target, opened.version - 1), false);
  now += 5_001;
  const probe = await breaker.beforeAttempt(target, policy);
  const reopened = await breaker.recordFailure(target, probe, policy);
  assertEquals(reopened.state, "open");
  assertEquals(await breaker.reset(target, reopened.version), true);
  assertEquals((await breaker.inspect(target, policy)).state, "closed");
});

Deno.test("memory breaker ignores pre-reset and expired half-open outcomes and stays bounded", async () => {
  let now = 10_000;
  let sequence = 0;
  const breaker = new MemoryCircuitBreaker({
    now: () => now,
    randomId: () => `probe-${++sequence}`,
    maxEntries: 2,
  });
  const oneFailure = { ...policy, failureThreshold: 1, halfOpenLeaseSeconds: 1 };
  const staleClosed = await breaker.beforeAttempt(target, oneFailure);
  assertEquals(await breaker.reset(target, staleClosed.version), true);
  const resetSnapshot = await breaker.inspect(target, oneFailure);
  await breaker.recordFailure(target, staleClosed, oneFailure);
  assertEquals(await breaker.inspect(target, oneFailure), resetSnapshot);

  const current = await breaker.beforeAttempt(target, oneFailure);
  await breaker.recordFailure(target, current, oneFailure);
  now += policy.openSeconds * 1_000 + 1;
  const staleProbe = await breaker.beforeAttempt(target, oneFailure);
  now += 1_001;
  const currentProbe = await breaker.beforeAttempt(target, oneFailure);
  await breaker.recordFailure(target, staleProbe, oneFailure);
  assertEquals((await breaker.inspect(target, oneFailure)).state, "half_open");
  assertEquals((await breaker.recordSuccess(target, currentProbe)).state, "closed");

  await breaker.inspect("22222222-2222-4222-8222-222222222222", policy);
  assertEquals(breaker.size, 1);
  await breaker.beforeAttempt("22222222-2222-4222-8222-222222222222", policy);
  await breaker.beforeAttempt("33333333-3333-4333-8333-333333333333", policy);
  assertEquals(breaker.size, 2);
});

Deno.test("breaker adapter carries permits through resilience outcomes", async () => {
  const breaker = new MemoryCircuitBreaker();
  const adapter = new CircuitBreakerStoreAdapter(breaker, { ...policy, failureThreshold: 1 });
  const fallback = "22222222-2222-4222-8222-222222222222";
  const result = await executeProviderRequest({
    initialCandidateId: target,
    resolveCandidate: (id) => ({ id, fallbackId: id === target ? fallback : null }),
    policy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 2,
      maxAttempts: 2,
      maxHops: 1,
      totalTimeoutMs: 1_000,
      firstVisibleTimeoutMs: 100,
      idleTimeoutMs: 100,
      maxPreVisibleChunks: 10,
      maxPreVisibleBytes: 10_000,
      circuitFailureThreshold: 1,
      circuitOpenMs: 1_000,
    },
    circuitStore: adapter,
    signal: new AbortController().signal,
    attempt: (candidate) => {
      if (candidate.id === target) throw new ProviderAttemptError("down", { status: 503 });
      return Promise.resolve("fallback");
    },
  });
  assertEquals(result, "fallback");
  assertEquals((await breaker.inspect(target, policy)).state, "open");
});

Deno.test("breaker policy and target identifiers are strictly bounded", () => {
  assertThrows(() => validateBreakerPolicy({ ...policy, failureThreshold: 0 }));
  assertThrows(() => validateBreakerPolicy({ ...policy, openSeconds: 86_401 }));
  assertThrows(() => validateBreakerPolicy({ ...policy, halfOpenLeaseSeconds: 1.5 }));
  const breaker = new MemoryCircuitBreaker();
  assertThrows(() => breaker.beforeAttempt("unsafe:key", policy), TypeError);
});

Deno.test({
  name: "Redis breaker fails open within a bounded interval when unavailable",
  // ioredis intentionally retains a two-second socket-destroy fallback after disconnect.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const breaker = new RedisCircuitBreaker("redis://127.0.0.1:1", {
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
    });
    const started = performance.now();
    try {
      const permit = await breaker.beforeAttempt(target, policy);
      assertEquals({ allowed: permit.allowed, state: permit.state }, {
        allowed: true,
        state: "unavailable",
      });
      assertEquals(performance.now() - started < 1_000, true);
    } finally {
      await breaker.close();
    }
  },
});

const redisUrl = Deno.env.get("TEST_REDIS_URL");
Deno.test({
  name: "Redis breaker is shared and grants only one half-open probe",
  ignore: !redisUrl,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const one = new RedisCircuitBreaker(redisUrl!);
    const two = new RedisCircuitBreaker(redisUrl!);
    const uniqueTarget = crypto.randomUUID();
    const short = {
      ...policy,
      failureThreshold: 1,
      openSeconds: 1,
      halfOpenLeaseSeconds: 1,
    };
    try {
      const permit = await one.beforeAttempt(uniqueTarget, short);
      await one.recordFailure(uniqueTarget, permit, short);
      assertEquals((await two.beforeAttempt(uniqueTarget, short)).state, "open");
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      const probes = await Promise.all([
        one.beforeAttempt(uniqueTarget, short),
        two.beforeAttempt(uniqueTarget, short),
      ]);
      assertEquals(probes.filter((candidate) => candidate.allowed).length, 1);
      const winner = probes.find((candidate) => candidate.allowed)!;
      await one.recordSuccess(uniqueTarget, winner);
      assertEquals((await two.inspect(uniqueTarget, short)).state, "closed");

      const staleClosed = await one.beforeAttempt(uniqueTarget, short);
      assertEquals(await two.reset(uniqueTarget, staleClosed.version), true);
      const resetSnapshot = await two.inspect(uniqueTarget, short);
      await one.recordFailure(uniqueTarget, staleClosed, short);
      assertEquals(await two.inspect(uniqueTarget, short), resetSnapshot);

      const closed = await one.beforeAttempt(uniqueTarget, short);
      await one.recordFailure(uniqueTarget, closed, short);
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      const staleProbe = await one.beforeAttempt(uniqueTarget, short);
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      const currentProbe = await two.beforeAttempt(uniqueTarget, short);
      await one.recordFailure(uniqueTarget, staleProbe, short);
      assertEquals((await two.inspect(uniqueTarget, short)).state, "half_open");
      await two.recordSuccess(uniqueTarget, currentProbe);
      assertEquals((await one.inspect(uniqueTarget, short)).state, "closed");

      await assertRejects(() => one.beforeAttempt("unsafe:key", short), TypeError);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  },
});
