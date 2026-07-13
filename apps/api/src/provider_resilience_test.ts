import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  abortableBackoff,
  backoffDelayMs,
  classifyProviderError,
  executeProviderRequest,
  MemoryCircuitStore,
  openAIVisibleUnits,
  ProviderAttemptError,
  ResilienceExhaustedError,
  type ResiliencePolicy,
  streamProviderRequest,
  validateResiliencePolicy,
} from "./provider-resilience.ts";

const policy: ResiliencePolicy = {
  maxRetries: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 2,
  maxAttempts: 6,
  maxHops: 3,
  totalTimeoutMs: 1_000,
  firstVisibleTimeoutMs: 20,
  idleTimeoutMs: 20,
  maxPreVisibleChunks: 100,
  maxPreVisibleBytes: 100_000,
  circuitFailureThreshold: 2,
  circuitOpenMs: 100,
};

Deno.test("resilience policy and transient error classification are strict", () => {
  assertEquals(validateResiliencePolicy(policy).jitterRatio, 0);
  assertEquals(classifyProviderError({ status: 429 }), {
    category: "rate_limited",
    transient: true,
    status: 429,
  });
  assertEquals(classifyProviderError({ status: 401 }).transient, false);
  assertEquals(classifyProviderError(new TypeError("connection reset")).category, "network");
  assertEquals(
    backoffDelayMs(2, {
      ...policy,
      baseDelayMs: 5,
      maxDelayMs: 100,
      backoffMultiplier: 3,
    }),
    15,
  );
  assertThrows(
    () => validateResiliencePolicy({ ...policy, maxAttempts: 0 }),
    TypeError,
    "maxAttempts",
  );
  for (
    const invalid of [
      { maxRetries: 4 },
      { maxAttempts: 9 },
      { maxHops: 8 },
      { totalTimeoutMs: 900_001 },
      { firstVisibleTimeoutMs: 300_001 },
      { idleTimeoutMs: 300_001 },
      { maxDelayMs: 300_001 },
      { backoffMultiplier: 4.01 },
      { maxPreVisibleChunks: 1_025 },
      { maxPreVisibleBytes: 16_777_217 },
      { maxRetries: policy.maxAttempts },
    ]
  ) assertThrows(() => validateResiliencePolicy({ ...policy, ...invalid }));
});

Deno.test("abort-aware backoff terminates immediately", async () => {
  const controller = new AbortController();
  const waiting = abortableBackoff(
    1,
    { ...policy, baseDelayMs: 10_000, maxDelayMs: 10_000, totalTimeoutMs: 20_000 },
    controller.signal,
  );
  controller.abort(new DOMException("stop", "AbortError"));
  await assertRejects(() => waiting, DOMException, "stop");
});

Deno.test("total deadline aborts backoff before another fallback attempt", async () => {
  let calls = 0;
  let time = 0;
  await assertRejects(
    () =>
      executeProviderRequest({
        initialCandidateId: "a",
        resolveCandidate: (id) => ({ id, fallbackId: "b" }),
        policy: {
          ...policy,
          maxRetries: 2,
          baseDelayMs: 10,
          maxDelayMs: 10,
          totalTimeoutMs: 25,
        },
        now: () => time,
        signal: new AbortController().signal,
        attempt: () => {
          calls += 1;
          time = 20;
          throw new ProviderAttemptError("retry", { status: 503 });
        },
      }),
    ProviderAttemptError,
    "total request deadline",
  );
  assertEquals(calls, 1);
});

Deno.test("Retry-After cannot schedule work beyond the total deadline", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      executeProviderRequest({
        initialCandidateId: "a",
        resolveCandidate: (id) => ({ id, fallbackId: "b" }),
        policy: { ...policy, totalTimeoutMs: 20 },
        signal: new AbortController().signal,
        attempt: () => {
          calls += 1;
          throw new ProviderAttemptError("rate limited", {
            status: 429,
            retryAfterMs: 1_000,
          });
        },
      }),
    ProviderAttemptError,
    "total request deadline",
  );
  assertEquals(calls, 1);
});

Deno.test("non-stream execution retries transient failures then follows fallback exactly once", async () => {
  const calls: string[] = [];
  const events: string[] = [];
  const result = await executeProviderRequest({
    initialCandidateId: "a",
    resolveCandidate: (id) => id === "a" ? { id, fallbackId: "b" } : { id },
    policy,
    signal: new AbortController().signal,
    onAttempt: (event) => {
      events.push(`${event.type}:${event.candidateId}:${event.retry}`);
      if (event.type === "failed") {
        assertEquals(event.httpStatus, 503);
        assertEquals(event.retryable, true);
        assertEquals("error" in event, false);
      }
    },
    attempt: async (candidate) => {
      await Promise.resolve();
      calls.push(candidate.id);
      if (candidate.id === "a") throw new ProviderAttemptError("busy", { status: 503 });
      return "fallback won";
    },
  });
  assertEquals(result, "fallback won");
  assertEquals(calls, ["a", "a", "b"]);
  assertEquals(events, [
    "started:a:0",
    "failed:a:0",
    "started:a:1",
    "failed:a:1",
    "started:b:0",
    "succeeded:b:0",
  ]);
});

Deno.test("circuit permit is reacquired before every physical retry", async () => {
  const circuit = new MemoryCircuitStore();
  const calls: string[] = [];
  const events: string[] = [];
  const result = await executeProviderRequest({
    initialCandidateId: "a",
    resolveCandidate: (id) => ({ id, fallbackId: id === "a" ? "b" : null }),
    policy: { ...policy, circuitFailureThreshold: 1 },
    circuitStore: circuit,
    signal: new AbortController().signal,
    onAttempt: (event) => {
      events.push(`${event.type}:${event.candidateId}:${event.retry}`);
    },
    attempt: (candidate) => {
      calls.push(candidate.id);
      if (candidate.id === "a") throw new ProviderAttemptError("down", { status: 503 });
      return Promise.resolve("fallback");
    },
  });
  assertEquals(result, "fallback");
  assertEquals(calls, ["a", "b"]);
  assertEquals(events.includes("skipped:a:1"), true);
});

Deno.test("non-transient failures do not retry or fall back and fallback cycles are guarded", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      executeProviderRequest({
        initialCandidateId: "a",
        resolveCandidate: (id) => ({ id, fallbackId: "b" }),
        policy,
        signal: new AbortController().signal,
        attempt: () => {
          calls += 1;
          throw new ProviderAttemptError("bad key", { status: 401 });
        },
      }),
    ProviderAttemptError,
    "bad key",
  );
  assertEquals(calls, 1);
  await assertRejects(
    () =>
      executeProviderRequest({
        initialCandidateId: "a",
        resolveCandidate: (id) => ({ id, fallbackId: id === "a" ? "b" : "a" }),
        policy: { ...policy, maxRetries: 0 },
        signal: new AbortController().signal,
        attempt: () => {
          throw new ProviderAttemptError("down", { status: 503 });
        },
      }),
    ResilienceExhaustedError,
    "cycle",
  );
});

Deno.test("candidate-local protocol incompatibilities skip only that fallback target", async () => {
  const calls: string[] = [];
  const result = await executeProviderRequest({
    initialCandidateId: "chat-primary",
    resolveCandidate: (id) => ({
      id,
      fallbackId: id === "chat-primary"
        ? "responses-incompatible"
        : id === "responses-incompatible"
        ? "chat-compatible"
        : null,
    }),
    policy: { ...policy, maxRetries: 0 },
    signal: new AbortController().signal,
    attempt: (candidate) => {
      calls.push(candidate.id);
      if (candidate.id === "chat-primary") {
        throw new ProviderAttemptError("unavailable", { status: 503 });
      }
      if (candidate.id === "responses-incompatible") {
        throw new ProviderAttemptError("stop cannot be represented by Responses", {
          category: "invalid_request",
          transient: false,
          candidateLocal: true,
        });
      }
      return Promise.resolve("later Chat fallback won");
    },
  });
  assertEquals(result, "later Chat fallback won");
  assertEquals(calls, ["chat-primary", "responses-incompatible", "chat-compatible"]);

  await assertRejects(
    () =>
      executeProviderRequest({
        initialCandidateId: "responses-only",
        resolveCandidate: (id) => ({ id }),
        policy: { ...policy, maxRetries: 0 },
        signal: new AbortController().signal,
        attempt: () => {
          throw new ProviderAttemptError("unsupported stop", {
            category: "invalid_request",
            transient: false,
            candidateLocal: true,
          });
        },
      }),
    ProviderAttemptError,
    "unsupported stop",
  );
});

Deno.test("stream buffers role and keepalive chunks, retries before visibility, then publishes", async () => {
  let calls = 0;
  const chunks: unknown[] = [];
  for await (
    const chunk of streamProviderRequest<unknown>({
      initialCandidateId: "a",
      resolveCandidate: (id) => ({ id }),
      policy,
      signal: new AbortController().signal,
      attempt: async function* () {
        calls += 1;
        yield { choices: [{ delta: { role: "assistant" } }] };
        yield ": keepalive";
        if (calls === 1) throw new TypeError("socket closed");
        yield { choices: [{ delta: { content: "hello" } }] };
        yield "[DONE]";
      },
    })
  ) chunks.push(chunk);
  assertEquals(calls, 2);
  assertEquals(chunks, [
    { choices: [{ delta: { role: "assistant" } }] },
    ": keepalive",
    { choices: [{ delta: { content: "hello" } }] },
    "[DONE]",
  ]);
  assertEquals(openAIVisibleUnits({ choices: [{ delta: { tool_calls: [{}] } }] }), 1);
});

Deno.test("no-visible streams require an explicit validator before buffered publication", async () => {
  const frames = [
    { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ];
  const published: unknown[] = [];
  let validated = 0;
  for await (
    const chunk of streamProviderRequest<unknown>({
      initialCandidateId: "empty",
      resolveCandidate: (id) => ({ id }),
      policy,
      signal: new AbortController().signal,
      visibleUnits: () => 0,
      validateNoVisibleOutput(buffered) {
        validated++;
        assertEquals(buffered, frames);
      },
      attempt: async function* () {
        yield* frames;
      },
    })
  ) published.push(chunk);
  assertEquals(validated, 1);
  assertEquals(published, frames);

  await assertRejects(
    async () => {
      for await (
        const _chunk of streamProviderRequest<unknown>({
          initialCandidateId: "invalid-empty",
          resolveCandidate: (id) => ({ id }),
          policy: { ...policy, maxRetries: 0 },
          signal: new AbortController().signal,
          visibleUnits: () => 0,
          validateNoVisibleOutput() {
            throw new ProviderAttemptError("terminal validation failed", {
              category: "invalid_response",
              transient: false,
            });
          },
          attempt: async function* () {
            yield "[DONE]";
          },
        })
      ) { /* consume */ }
    },
    ProviderAttemptError,
    "terminal validation failed",
  );
});

Deno.test("pre-visible buffering is bounded before fallback", async () => {
  const chunks: unknown[] = [];
  let calls = 0;
  for await (
    const chunk of streamProviderRequest<unknown>({
      initialCandidateId: "a",
      resolveCandidate: (id) => ({ id, fallbackId: id === "a" ? "b" : null }),
      policy: { ...policy, maxRetries: 0, maxPreVisibleChunks: 2 },
      signal: new AbortController().signal,
      attempt: async function* (candidate) {
        calls += 1;
        if (candidate.id === "a") {
          yield ": one";
          yield ": two";
          yield ": three";
        } else yield { choices: [{ delta: { content: "fallback" } }] };
      },
    })
  ) chunks.push(chunk);
  assertEquals(calls, 2);
  assertEquals(chunks, [{ choices: [{ delta: { content: "fallback" } }] }]);
});

Deno.test("stream first-visible timeout falls back but idle failure after visibility never retries", async () => {
  const fallbackOutput: unknown[] = [];
  let timedOutAttemptAborted = false;
  for await (
    const chunk of streamProviderRequest<unknown>({
      initialCandidateId: "slow",
      resolveCandidate: (id) => id === "slow" ? { id, fallbackId: "fast" } : { id },
      policy: { ...policy, maxRetries: 0, firstVisibleTimeoutMs: 5 },
      signal: new AbortController().signal,
      attempt: async function* (candidate, signal) {
        if (candidate.id === "slow") {
          signal.addEventListener("abort", () => timedOutAttemptAborted = true, { once: true });
          for (let index = 0; index < 10; index++) {
            await new Promise((resolve) => setTimeout(resolve, 3));
            yield ": keepalive";
          }
        }
        yield { choices: [{ delta: { content: candidate.id } }] };
      },
    })
  ) fallbackOutput.push(chunk);
  assertEquals(fallbackOutput, [{ choices: [{ delta: { content: "fast" } }] }]);
  assertEquals(timedOutAttemptAborted, true);

  let calls = 0;
  const iterator = streamProviderRequest<unknown>({
    initialCandidateId: "a",
    resolveCandidate: (id) => ({ id, fallbackId: "b" }),
    policy: { ...policy, idleTimeoutMs: 5 },
    signal: new AbortController().signal,
    attempt: async function* () {
      calls += 1;
      yield { choices: [{ delta: { content: "visible" } }] };
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  await assertRejects(
    async () => {
      for await (const _chunk of iterator) { /* consume */ }
    },
    ProviderAttemptError,
    "idle",
  );
  assertEquals(calls, 1);
});

Deno.test("timed-out stream cleanup completes before fallback starts", async () => {
  let cleaned = false;
  let fallbackSawCleanup = false;
  const output: unknown[] = [];
  for await (
    const chunk of streamProviderRequest<unknown>({
      initialCandidateId: "slow",
      resolveCandidate: (id) => ({ id, fallbackId: id === "slow" ? "fast" : null }),
      policy: { ...policy, maxRetries: 0, firstVisibleTimeoutMs: 5 },
      signal: new AbortController().signal,
      attempt: async function* (candidate, signal) {
        if (candidate.id === "fast") {
          fallbackSawCleanup = cleaned;
          yield { choices: [{ delta: { content: "ready" } }] };
          return;
        }
        try {
          yield { choices: [{ delta: { role: "assistant" } }] };
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
        } finally {
          await new Promise((resolve) => setTimeout(resolve, 2));
          cleaned = true;
        }
      },
    })
  ) output.push(chunk);
  assertEquals(cleaned, true);
  assertEquals(fallbackSawCleanup, true);
  assertEquals(output, [{ choices: [{ delta: { content: "ready" } }] }]);
});

Deno.test("consumer return awaits cooperative provider cleanup", async () => {
  let cleaned = false;
  const iterator = streamProviderRequest<unknown>({
    initialCandidateId: "a",
    resolveCandidate: (id) => ({ id }),
    policy,
    signal: new AbortController().signal,
    attempt: async function* (_candidate, signal) {
      try {
        yield { choices: [{ delta: { content: "visible" } }] };
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 2));
        cleaned = true;
      }
    },
  });
  assertEquals((await iterator.next()).done, false);
  await iterator.return(undefined);
  assertEquals(cleaned, true);
});

Deno.test("slow-stream detection reports after visibility and cannot retry", async () => {
  let time = 0;
  let calls = 0;
  const iterator = streamProviderRequest<unknown>({
    initialCandidateId: "a",
    resolveCandidate: (id) => ({ id, fallbackId: "b" }),
    policy: {
      ...policy,
      slowWindowMs: 1_000,
      minimumVisibleUnitsPerSecond: 10,
    },
    now: () => time,
    signal: new AbortController().signal,
    attempt: async function* () {
      calls += 1;
      yield { choices: [{ delta: { content: "a" } }] };
      time = 1_000;
      yield { choices: [{ delta: { content: "b" } }] };
    },
  });
  await assertRejects(
    async () => {
      for await (const _chunk of iterator) { /* consume visible output */ }
    },
    ProviderAttemptError,
    "minimum throughput",
  );
  assertEquals(calls, 1);
});

Deno.test("terminal telemetry failure never retries a completed provider call", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      executeProviderRequest({
        initialCandidateId: "a",
        resolveCandidate: (id) => ({ id, fallbackId: id === "a" ? "b" : null }),
        policy,
        signal: new AbortController().signal,
        attempt: (candidate) => {
          calls.push(candidate.id);
          return Promise.resolve("paid response");
        },
        onAttempt: (event) => {
          if (event.type === "succeeded") throw new Error("telemetry unavailable");
        },
      }),
    Error,
    "telemetry unavailable",
  );
  assertEquals(calls, ["a"]);
});

Deno.test("refusal and reasoning deltas count as visible output", () => {
  assertEquals(openAIVisibleUnits({ choices: [{ delta: { refusal: "cannot comply" } }] }), 13);
  assertEquals(
    openAIVisibleUnits({ choices: [{ delta: { reasoning_content: "private thought" } }] }),
    15,
  );
  assertEquals(
    openAIVisibleUnits({ choices: [{ delta: { reasoning_summary: "short summary" } }] }),
    13,
  );
});

Deno.test("memory circuit store opens, permits one half-open probe, closes, and stays bounded", () => {
  let now = 1_000;
  const store = new MemoryCircuitStore(2, () => now);
  const closed = { allowed: true, state: "closed" as const };
  store.failure("a", closed, policy);
  store.failure("a", closed, policy);
  assertEquals(store.acquire("a", policy).state, "open");
  now += policy.circuitOpenMs + 1;
  assertEquals(store.acquire("a", policy), { allowed: true, state: "half_open" });
  assertEquals(store.acquire("a", policy).allowed, false);
  store.success("a", { allowed: true, state: "half_open" });
  assertEquals(store.acquire("a", policy).state, "closed");
  store.failure("a", closed, policy);
  now += 1;
  store.failure("b", closed, policy);
  now += 1;
  store.failure("c", closed, policy);
  assertEquals(store.size, 2);
});
