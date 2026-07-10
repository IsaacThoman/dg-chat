import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  completeSimulatedProvider,
  simulatedErrorClassification,
  SimulatedProviderError,
  type SimulatedProviderEvent,
  SimulatedScenarioValidationError,
  simulatedVisibleUnits,
  type SimulatorClock,
  streamSimulatedProvider,
  validateSimulatedProviderScenario,
} from "./provider-simulator.ts";
import {
  executeProviderRequest,
  ProviderAttemptError,
  type ResiliencePolicy,
  streamProviderRequest,
} from "./provider-resilience.ts";

class FakeClock implements SimulatorClock {
  readonly sleeps: number[] = [];
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return Promise.resolve();
  }
}

async function collect(
  input: unknown,
  signal = new AbortController().signal,
  clock: SimulatorClock = new FakeClock(),
) {
  const events: SimulatedProviderEvent[] = [];
  for await (const event of streamSimulatedProvider(input, signal, { clock })) events.push(event);
  return events;
}

const fullScenario = {
  id: "full",
  name: "Full deterministic response",
  seed: 42,
  steps: [
    { type: "role", role: "assistant", delayMs: 2, jitterMs: 3 },
    { type: "reasoning", text: "Think. ", delayMs: 1 },
    { type: "text", text: "Hello ", delayMs: 3, jitterMs: 5 },
    {
      type: "tool",
      name: "lookup",
      arguments: { query: "safe" },
      delayMs: 4,
      jitterMs: 1,
    },
    { type: "text", text: "world", delayMs: 0 },
    {
      type: "usage",
      inputTokens: 20,
      cachedInputTokens: 5,
      reasoningTokens: 2,
      outputTokens: 10,
    },
  ],
};

const resiliencePolicy: ResiliencePolicy = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 2,
  maxAttempts: 2,
  maxHops: 1,
  totalTimeoutMs: 1_000,
  firstVisibleTimeoutMs: 100,
  idleTimeoutMs: 100,
  maxPreVisibleChunks: 16,
  maxPreVisibleBytes: 16_384,
  circuitFailureThreshold: 2,
  circuitOpenMs: 100,
};

Deno.test("simulator emits normalized delayed events and collects a completion", async () => {
  const firstClock = new FakeClock();
  const secondClock = new FakeClock();
  const first = await collect(fullScenario, new AbortController().signal, firstClock);
  const second = await collect(fullScenario, new AbortController().signal, secondClock);
  assertEquals(first, second);
  assertEquals(firstClock.sleeps, secondClock.sleeps);
  assert(firstClock.sleeps[0] >= 2 && firstClock.sleeps[0] <= 5);
  assertEquals(first.at(-1), { type: "done" });

  const result = await completeSimulatedProvider(fullScenario, new AbortController().signal, {
    clock: new FakeClock(),
  });
  assertEquals(result.text, "Hello world");
  assertEquals(result.reasoning, "Think. ");
  assertEquals(result.toolCalls[0].name, "lookup");
  assertEquals(result.usage, {
    inputTokens: 20,
    cachedInputTokens: 5,
    reasoningTokens: 2,
    outputTokens: 10,
    source: "scenario",
  });
});

Deno.test("seed controls jitter and generated tool IDs repeatably", async () => {
  const changed = structuredClone(fullScenario);
  changed.seed = 43;
  const oneClock = new FakeClock();
  const twoClock = new FakeClock();
  const one = await collect(fullScenario, new AbortController().signal, oneClock);
  const two = await collect(changed, new AbortController().signal, twoClock);
  const oneTool = one.find((event) => event.type === "tool");
  const twoTool = two.find((event) => event.type === "tool");
  assert(oneTool?.type === "tool" && twoTool?.type === "tool");
  assert(oneTool.id !== twoTool.id || oneClock.sleeps.join() !== twoClock.sleeps.join());
});

Deno.test("simulator exposes classified transient and permanent HTTP failures", async () => {
  const transient = {
    id: "transient",
    name: "Transient",
    seed: 1,
    steps: [{
      type: "failure",
      outcome: "http_transient",
      status: 429,
      retryAfterMs: 250,
      message: "rate limited",
    }],
  };
  const error = await assertRejects(
    () => collect(transient),
    SimulatedProviderError,
    "rate limited",
  );
  assertEquals(error.kind, "http_transient");
  assertEquals(error.details, {
    transient: true,
    phase: "connect",
    responseVisible: false,
    status: 429,
    retryAfterMs: 250,
  });
  assertEquals(simulatedErrorClassification(error), {
    category: "rate_limited",
    transient: true,
    status: 429,
    retryAfterMs: 250,
    phase: "connect",
    responseVisible: false,
  });

  const permanent = {
    id: "permanent",
    name: "Permanent",
    seed: 1,
    steps: [{
      type: "failure",
      outcome: "http_permanent",
      status: 401,
      message: "unauthorized",
    }],
  };
  const permanentError = await assertRejects(
    () => collect(permanent),
    SimulatedProviderError,
  );
  assertEquals(permanentError.details.transient, false);
});

Deno.test("connection, stall, malformed, empty, and visible mid-stream outcomes are modeled", async () => {
  const outcomes = [
    "connection_error",
    "first_token_stall",
    "malformed_response",
    "empty_response",
  ] as const;
  for (const outcome of outcomes) {
    const error = await assertRejects(
      () =>
        collect({
          id: outcome,
          name: outcome,
          seed: 0,
          steps: [{ type: "failure", outcome, delayMs: 12 }],
        }),
      SimulatedProviderError,
    );
    assertEquals(error.kind, outcome);
    assertEquals(error.details.responseVisible, false);
  }

  const events: SimulatedProviderEvent[] = [];
  const scenario = {
    id: "midstream",
    name: "Midstream",
    seed: 0,
    steps: [
      { type: "text", text: "visible" },
      { type: "failure", outcome: "mid_stream_failure" },
    ],
  };
  const error = await assertRejects(async () => {
    for await (
      const event of streamSimulatedProvider(
        scenario,
        new AbortController().signal,
        { clock: new FakeClock() },
      )
    ) events.push(event);
  }, SimulatedProviderError);
  assertEquals(events, [{ type: "text", text: "visible", delayMs: 0 }]);
  assertEquals(error.details.responseVisible, true);
  assertEquals(error.details.phase, "stream");
});

Deno.test("abort interrupts an injected clock that does not implement cancellation", async () => {
  let release: (() => void) | undefined;
  const clock: SimulatorClock = {
    sleep() {
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  const controller = new AbortController();
  const pending = collect(
    {
      id: "abort",
      name: "Abort",
      seed: 0,
      steps: [{ type: "text", text: "never", delayMs: 1000 }],
    },
    controller.signal,
    clock,
  );
  await Promise.resolve();
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assertRejects(() => pending, DOMException, "client disconnected");
  release?.();
});

Deno.test("scenario validation rejects unsafe, inconsistent, and unbounded inputs", () => {
  assertThrows(
    () => validateSimulatedProviderScenario({ ...fullScenario, unexpected: true }),
    SimulatedScenarioValidationError,
    "unsupported field",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "bad-http",
        name: "bad",
        seed: 0,
        steps: [{ type: "failure", outcome: "http_transient", status: 401 }],
      }),
    SimulatedScenarioValidationError,
    "permanent status",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "bad-usage",
        name: "bad",
        seed: 0,
        steps: [{
          type: "usage",
          inputTokens: 1,
          cachedInputTokens: 2,
          reasoningTokens: 0,
          outputTokens: 0,
        }],
      }),
    SimulatedScenarioValidationError,
    "exceed",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "bad-midstream",
        name: "bad",
        seed: 0,
        steps: [{ type: "failure", outcome: "mid_stream_failure" }],
      }),
    SimulatedScenarioValidationError,
    "requires visible output",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "bad-tool",
        name: "bad",
        seed: 0,
        steps: [{ type: "tool", name: "unsafe name", arguments: {} }],
      }),
    SimulatedScenarioValidationError,
    "tool name",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "delay",
        name: "bad",
        seed: 0,
        steps: [
          { type: "text", text: "a", delayMs: 60_000, jitterMs: 60_000 },
          { type: "text", text: "b", delayMs: 1 },
        ],
      }),
    SimulatedScenarioValidationError,
    "total limit",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "implicit-empty",
        name: "bad",
        seed: 0,
        steps: [{ type: "role", role: "assistant" }],
      }),
    SimulatedScenarioValidationError,
    "use empty_response",
  );
});

Deno.test("scenario validation rejects coercive JSON values without invoking accessors", () => {
  const invalidValues = [NaN, Infinity, undefined, () => undefined, new Date()];
  for (const value of invalidValues) {
    assertThrows(
      () =>
        validateSimulatedProviderScenario({
          id: "invalid-json",
          name: "invalid",
          seed: 0,
          steps: [{ type: "tool", name: "lookup", arguments: { value } }],
        }),
      SimulatedScenarioValidationError,
    );
  }

  let getterCalled = false;
  const argumentsWithGetter: Record<string, unknown> = {};
  Object.defineProperty(argumentsWithGetter, "secret", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "leaked";
    },
  });
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "getter",
        name: "getter",
        seed: 0,
        steps: [{ type: "tool", name: "lookup", arguments: argumentsWithGetter }],
      }),
    SimulatedScenarioValidationError,
    "accessor",
  );
  assertEquals(getterCalled, false);

  let toJsonCalled = false;
  const withToJSON = {
    toJSON() {
      toJsonCalled = true;
      return {};
    },
  };
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "to-json",
        name: "to-json",
        seed: 0,
        steps: [{ type: "tool", name: "lookup", arguments: withToJSON }],
      }),
    SimulatedScenarioValidationError,
    "non-JSON",
  );
  assertEquals(toJsonCalled, false);
});

Deno.test("tool call IDs and aggregate UTF-8 payloads are bounded", async () => {
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "duplicate-tools",
        name: "duplicate-tools",
        seed: 0,
        steps: [
          { type: "tool", id: "same", name: "one", arguments: {} },
          { type: "tool", id: "same", name: "two", arguments: {} },
        ],
      }),
    SimulatedScenarioValidationError,
    "unique",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "too-many-tools",
        name: "too-many-tools",
        seed: 0,
        steps: Array.from({ length: 17 }, (_, index) => ({
          type: "tool",
          name: `tool_${index}`,
          arguments: {},
        })),
      }),
    SimulatedScenarioValidationError,
    "aggregate limit",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "utf8-tools",
        name: "utf8-tools",
        seed: 0,
        steps: [{ type: "tool", name: "tool", arguments: { text: "😀".repeat(5_000) } }],
      }),
    SimulatedScenarioValidationError,
    "size limit",
  );
  assertThrows(
    () =>
      validateSimulatedProviderScenario({
        id: "aggregate-tool-bytes",
        name: "aggregate-tool-bytes",
        seed: 0,
        steps: Array.from({ length: 5 }, (_, index) => ({
          type: "tool",
          name: `tool_${index}`,
          arguments: { text: "a".repeat(14_000) },
        })),
      }),
    SimulatedScenarioValidationError,
    "aggregate limit",
  );

  const generated = await collect({
    id: "generated-tools",
    name: "generated-tools",
    seed: 7,
    steps: Array.from({ length: 16 }, (_, index) => ({
      type: "tool",
      name: `tool_${index}`,
      arguments: {},
    })),
  });
  const ids = generated.flatMap((event) => event.type === "tool" ? [event.id] : []);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("classification adapter sanitizes manually constructed failure metadata", () => {
  const error = new SimulatedProviderError("http_transient", "unsafe metadata", {
    transient: false,
    phase: "response",
    responseVisible: true,
    status: 401,
    retryAfterMs: 999_999,
  });
  assertEquals(simulatedErrorClassification(error), {
    category: "upstream_unavailable",
    transient: true,
    status: 503,
    retryAfterMs: undefined,
    phase: "connect",
    responseVisible: true,
  });
});

Deno.test("simulator adapters integrate with resilience fallback and visibility callbacks", async () => {
  const failing = {
    id: "transient-adapter",
    name: "transient-adapter",
    seed: 0,
    steps: [{ type: "failure", outcome: "connection_error" }],
  };
  const successful = {
    id: "success-adapter",
    name: "success-adapter",
    seed: 0,
    steps: [{ type: "text", text: "fallback" }],
  };
  const result = await executeProviderRequest({
    initialCandidateId: "a",
    resolveCandidate: (id) => id === "a" ? { id, fallbackId: "b" } : { id },
    policy: resiliencePolicy,
    signal: new AbortController().signal,
    attempt: async (candidate, signal) => {
      try {
        return await completeSimulatedProvider(
          candidate.id === "a" ? failing : successful,
          signal,
          { clock: new FakeClock() },
        );
      } catch (error) {
        const classification = simulatedErrorClassification(error);
        if (!classification) throw error;
        throw new ProviderAttemptError(error instanceof Error ? error.message : "simulated", {
          category: classification.category,
          transient: classification.transient,
          status: classification.status,
        });
      }
    },
  });
  assertEquals(result.text, "fallback");

  const events: SimulatedProviderEvent[] = [];
  for await (
    const event of streamProviderRequest<SimulatedProviderEvent>({
      initialCandidateId: "simulated",
      resolveCandidate: (id) => ({ id }),
      policy: resiliencePolicy,
      signal: new AbortController().signal,
      visibleUnits: simulatedVisibleUnits,
      attempt: (_candidate, signal) =>
        streamSimulatedProvider(successful, signal, { clock: new FakeClock() }),
    })
  ) events.push(event);
  assertEquals(events, [
    { type: "text", text: "fallback", delayMs: 0 },
    { type: "done" },
  ]);
});

Deno.test("validated scenarios are detached from mutable tool arguments", async () => {
  const source = {
    id: "clone",
    name: "Clone",
    seed: 0,
    steps: [{ type: "tool", name: "lookup", arguments: { value: "original" } }],
  };
  const validated = validateSimulatedProviderScenario(source);
  source.steps[0].arguments.value = "mutated";
  const result = await completeSimulatedProvider(validated, new AbortController().signal, {
    clock: new FakeClock(),
  });
  assertEquals(result.toolCalls[0].arguments, { value: "original" });
});
