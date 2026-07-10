const MAX_STEPS = 128;
const MAX_STEP_DELAY_MS = 60_000;
const MAX_TOTAL_DELAY_MS = 120_000;
const MAX_EVENT_TEXT = 8_192;
const MAX_TOTAL_TEXT = 65_536;
const MAX_TOOL_ARGUMENT_BYTES = 16_384;
const MAX_TOTAL_TOOL_ARGUMENT_BYTES = 65_536;
const MAX_TOOL_CALLS = 16;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;
const MAX_TOKENS = 10_000_000;

const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const roles = new Set(["assistant", "system", "tool"]);

export type SimulatedProviderFailureKind =
  | "http_transient"
  | "http_permanent"
  | "connection_error"
  | "first_token_stall"
  | "mid_stream_failure"
  | "empty_response"
  | "malformed_response";

export type SimulatedProviderStep =
  | { type: "role"; role: "assistant" | "system" | "tool"; delayMs: number; jitterMs: number }
  | { type: "text"; text: string; delayMs: number; jitterMs: number }
  | { type: "reasoning"; text: string; delayMs: number; jitterMs: number }
  | {
    type: "tool";
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
    delayMs: number;
    jitterMs: number;
  }
  | {
    type: "usage";
    inputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    outputTokens: number;
    delayMs: number;
    jitterMs: number;
  }
  | {
    type: "failure";
    outcome: SimulatedProviderFailureKind;
    status?: number;
    retryAfterMs?: number;
    message?: string;
    delayMs: number;
    jitterMs: number;
  };

export interface SimulatedProviderScenario {
  id: string;
  name: string;
  seed: number;
  steps: SimulatedProviderStep[];
}

export type SimulatedProviderEvent =
  | { type: "role"; role: "assistant" | "system" | "tool"; delayMs: number }
  | { type: "text"; text: string; delayMs: number }
  | { type: "reasoning"; text: string; delayMs: number }
  | {
    type: "tool";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    delayMs: number;
  }
  | {
    type: "usage";
    inputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    outputTokens: number;
    delayMs: number;
  }
  | { type: "done" };

export interface SimulatedProviderCompletion {
  scenarioId: string;
  seed: number;
  role: "assistant" | "system" | "tool";
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    outputTokens: number;
    source: "scenario" | "estimated";
  };
}

export interface SimulatorClock {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface SimulatorOptions {
  clock?: SimulatorClock;
}

export interface SimulatedErrorClassification {
  category:
    | "timeout"
    | "rate_limited"
    | "upstream_unavailable"
    | "network"
    | "authentication"
    | "invalid_request"
    | "invalid_response";
  transient: boolean;
  status?: number;
  retryAfterMs?: number;
  phase: "connect" | "first_token" | "stream" | "response";
  responseVisible: boolean;
}

export class SimulatedProviderError extends Error {
  constructor(
    public readonly kind: SimulatedProviderFailureKind,
    message: string,
    public readonly details: {
      transient: boolean;
      phase: "connect" | "first_token" | "stream" | "response";
      responseVisible: boolean;
      status?: number;
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = "SimulatedProviderError";
  }
}

export class SimulatedScenarioValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "SimulatedScenarioValidationError";
  }
}

const realClock: SimulatorClock = {
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SimulatedScenarioValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) {
    throw new SimulatedScenarioValidationError(
      `${label} contains unsupported field '${extras[0]}'`,
    );
  }
}

function boundedString(value: unknown, label: string, max: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > max ||
    (pattern && !pattern.test(value))
  ) {
    throw new SimulatedScenarioValidationError(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new SimulatedScenarioValidationError(`${label} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function optionalDelay(value: Record<string, unknown>, key: "delayMs" | "jitterMs"): number {
  return value[key] === undefined ? 0 : integer(value[key], key, 0, MAX_STEP_DELAY_MS);
}

function clonePlainJson(
  value: unknown,
  label: string,
  state = { nodes: 0, active: new WeakSet<object>() },
  depth = 0,
): unknown {
  state.nodes++;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new SimulatedScenarioValidationError(`${label} exceeds the JSON complexity limit`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SimulatedScenarioValidationError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new SimulatedScenarioValidationError(`${label} contains a non-JSON value`);
  }
  const source = value as object;
  if (state.active.has(source)) {
    throw new SimulatedScenarioValidationError(`${label} contains a cycle`);
  }
  state.active.add(source);
  try {
    if (Array.isArray(source)) {
      if (Object.getPrototypeOf(source) !== Array.prototype) {
        throw new SimulatedScenarioValidationError(`${label} must use plain JSON arrays`);
      }
      const keys = Reflect.ownKeys(source);
      if (
        keys.some((key) =>
          typeof key !== "string" ||
          (key !== "length" && (!/^\d+$/.test(key) || String(Number(key)) !== key))
        )
      ) {
        throw new SimulatedScenarioValidationError(
          `${label} array contains unsupported properties`,
        );
      }
      const output: unknown[] = [];
      for (let index = 0; index < source.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new SimulatedScenarioValidationError(
            `${label} contains a sparse or accessor array`,
          );
        }
        output.push(clonePlainJson(descriptor.value, label, state, depth + 1));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SimulatedScenarioValidationError(`${label} must contain only plain JSON objects`);
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") {
        throw new SimulatedScenarioValidationError(`${label} contains a symbol property`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new SimulatedScenarioValidationError(`${label} contains an accessor property`);
      }
      output[key] = clonePlainJson(descriptor.value, label, state, depth + 1);
    }
    return output;
  } finally {
    state.active.delete(source);
  }
}

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function jsonObject(value: unknown): Record<string, unknown> {
  const candidate = record(clonePlainJson(value, "tool arguments"), "tool arguments");
  if (jsonBytes(candidate) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new SimulatedScenarioValidationError("tool arguments exceed the size limit");
  }
  return candidate;
}

function validateStep(value: unknown, index: number): SimulatedProviderStep {
  const step = record(value, `step ${index}`);
  const type = boundedString(step.type, `step ${index} type`, 32);
  const delayMs = optionalDelay(step, "delayMs");
  const jitterMs = optionalDelay(step, "jitterMs");
  if (type === "role") {
    exactKeys(step, ["type", "role", "delayMs", "jitterMs"], `step ${index}`);
    if (typeof step.role !== "string" || !roles.has(step.role)) {
      throw new SimulatedScenarioValidationError(`step ${index} role is invalid`);
    }
    return { type, role: step.role as "assistant" | "system" | "tool", delayMs, jitterMs };
  }
  if (type === "text" || type === "reasoning") {
    exactKeys(step, ["type", "text", "delayMs", "jitterMs"], `step ${index}`);
    return {
      type,
      text: boundedString(step.text, `step ${index} text`, MAX_EVENT_TEXT),
      delayMs,
      jitterMs,
    };
  }
  if (type === "tool") {
    exactKeys(
      step,
      ["type", "id", "name", "arguments", "delayMs", "jitterMs"],
      `step ${index}`,
    );
    const id = step.id === undefined
      ? undefined
      : boundedString(step.id, `step ${index} tool id`, 128, /^[A-Za-z0-9_-]+$/);
    return {
      type,
      ...(id === undefined ? {} : { id }),
      name: boundedString(step.name, `step ${index} tool name`, 128, /^[A-Za-z0-9_-]+$/),
      arguments: jsonObject(step.arguments),
      delayMs,
      jitterMs,
    };
  }
  if (type === "usage") {
    exactKeys(
      step,
      [
        "type",
        "inputTokens",
        "cachedInputTokens",
        "reasoningTokens",
        "outputTokens",
        "delayMs",
        "jitterMs",
      ],
      `step ${index}`,
    );
    const inputTokens = integer(step.inputTokens, "inputTokens", 0, MAX_TOKENS);
    const cachedInputTokens = integer(step.cachedInputTokens, "cachedInputTokens", 0, MAX_TOKENS);
    const reasoningTokens = integer(step.reasoningTokens, "reasoningTokens", 0, MAX_TOKENS);
    const outputTokens = integer(step.outputTokens, "outputTokens", 0, MAX_TOKENS);
    if (cachedInputTokens > inputTokens || reasoningTokens > outputTokens) {
      throw new SimulatedScenarioValidationError("usage token details exceed their totals");
    }
    return {
      type,
      inputTokens,
      cachedInputTokens,
      reasoningTokens,
      outputTokens,
      delayMs,
      jitterMs,
    };
  }
  if (type === "failure") {
    exactKeys(
      step,
      ["type", "outcome", "status", "retryAfterMs", "message", "delayMs", "jitterMs"],
      `step ${index}`,
    );
    const outcomes = new Set<SimulatedProviderFailureKind>([
      "http_transient",
      "http_permanent",
      "connection_error",
      "first_token_stall",
      "mid_stream_failure",
      "empty_response",
      "malformed_response",
    ]);
    if (
      typeof step.outcome !== "string" ||
      !outcomes.has(step.outcome as SimulatedProviderFailureKind)
    ) {
      throw new SimulatedScenarioValidationError(`step ${index} failure outcome is invalid`);
    }
    const outcome = step.outcome as SimulatedProviderFailureKind;
    const status = step.status === undefined ? undefined : integer(step.status, "status", 400, 599);
    if (outcome === "http_transient" && status !== undefined && !transientStatuses.has(status)) {
      throw new SimulatedScenarioValidationError("transient HTTP failure has a permanent status");
    }
    if (outcome === "http_permanent" && status !== undefined && transientStatuses.has(status)) {
      throw new SimulatedScenarioValidationError("permanent HTTP failure has a transient status");
    }
    if (!outcome.startsWith("http_") && status !== undefined) {
      throw new SimulatedScenarioValidationError("only HTTP failures may include a status");
    }
    const retryAfterMs = step.retryAfterMs === undefined
      ? undefined
      : integer(step.retryAfterMs, "retryAfterMs", 0, MAX_STEP_DELAY_MS);
    if (retryAfterMs !== undefined && outcome !== "http_transient") {
      throw new SimulatedScenarioValidationError("only transient HTTP failures may retry later");
    }
    const message = step.message === undefined
      ? undefined
      : boundedString(step.message, `step ${index} message`, 240);
    return {
      type,
      outcome,
      ...(status === undefined ? {} : { status }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(message === undefined ? {} : { message }),
      delayMs,
      jitterMs,
    };
  }
  throw new SimulatedScenarioValidationError(`step ${index} type is unsupported`);
}

/** Parses an untrusted declarative scenario into a bounded, detached value. */
export function validateSimulatedProviderScenario(value: unknown): SimulatedProviderScenario {
  const scenario = record(clonePlainJson(value, "scenario"), "scenario");
  exactKeys(scenario, ["id", "name", "seed", "steps"], "scenario");
  const id = boundedString(scenario.id, "scenario id", 64, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const name = boundedString(scenario.name, "scenario name", 120);
  const seed = integer(scenario.seed, "scenario seed", 0, 0xffff_ffff);
  if (
    !Array.isArray(scenario.steps) || scenario.steps.length < 1 ||
    scenario.steps.length > MAX_STEPS
  ) {
    throw new SimulatedScenarioValidationError(`scenario must contain 1 to ${MAX_STEPS} steps`);
  }
  const steps = scenario.steps.map(validateStep);
  let totalDelay = 0;
  let totalText = 0;
  let visible = false;
  let rolesSeen = 0;
  let usageSeen = 0;
  let toolCalls = 0;
  let totalToolArgumentBytes = 0;
  const explicitToolIds = new Set<string>();
  for (const [index, step] of steps.entries()) {
    totalDelay += step.delayMs + step.jitterMs;
    if (totalDelay > MAX_TOTAL_DELAY_MS) {
      throw new SimulatedScenarioValidationError("scenario delays exceed the total limit");
    }
    if (step.type === "text" || step.type === "reasoning") totalText += step.text.length;
    if (totalText > MAX_TOTAL_TEXT) {
      throw new SimulatedScenarioValidationError("scenario text exceeds the total size limit");
    }
    if (step.type === "role") {
      rolesSeen++;
      if (rolesSeen > 1 || visible) {
        throw new SimulatedScenarioValidationError("role must occur once before visible output");
      }
    }
    if (step.type === "text" || step.type === "reasoning" || step.type === "tool") visible = true;
    if (step.type === "tool") {
      toolCalls++;
      totalToolArgumentBytes += jsonBytes(step.arguments);
      if (toolCalls > MAX_TOOL_CALLS || totalToolArgumentBytes > MAX_TOTAL_TOOL_ARGUMENT_BYTES) {
        throw new SimulatedScenarioValidationError(
          "scenario tool calls exceed the aggregate limit",
        );
      }
      if (step.id && explicitToolIds.has(step.id)) {
        throw new SimulatedScenarioValidationError("scenario tool call IDs must be unique");
      }
      if (step.id) explicitToolIds.add(step.id);
    }
    if (step.type === "usage") {
      usageSeen++;
      if (usageSeen > 1 || index !== steps.length - 1) {
        throw new SimulatedScenarioValidationError("usage must be the final step and occur once");
      }
    }
    if (step.type === "failure") {
      if (index !== steps.length - 1) {
        throw new SimulatedScenarioValidationError("failure must be the final step");
      }
      if (step.outcome === "mid_stream_failure" && !visible) {
        throw new SimulatedScenarioValidationError("mid-stream failure requires visible output");
      }
      if (step.outcome === "first_token_stall" && visible) {
        throw new SimulatedScenarioValidationError("first-token stall must precede visible output");
      }
      if (
        ["http_transient", "http_permanent", "connection_error"].includes(step.outcome) && visible
      ) {
        throw new SimulatedScenarioValidationError(
          `${step.outcome} must occur before visible output`,
        );
      }
      if (step.outcome === "empty_response" && visible) {
        throw new SimulatedScenarioValidationError("empty response cannot follow visible output");
      }
    }
  }
  if (!visible && steps.at(-1)?.type !== "failure") {
    throw new SimulatedScenarioValidationError(
      "successful scenario must produce output; use empty_response to model an empty result",
    );
  }
  return { id, name, seed, steps };
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function sleep(clock: SimulatorClock, ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (ms === 0) return;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([clock.sleep(ms, signal), aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function failure(step: Extract<SimulatedProviderStep, { type: "failure" }>, visible: boolean) {
  const defaults: Record<SimulatedProviderFailureKind, string> = {
    http_transient: "Simulated transient provider failure",
    http_permanent: "Simulated permanent provider failure",
    connection_error: "Simulated provider connection error",
    first_token_stall: "Simulated first-token stall",
    mid_stream_failure: "Simulated provider stream failure",
    empty_response: "Simulated empty provider response",
    malformed_response: "Simulated malformed provider response",
  };
  const transient = [
    "http_transient",
    "connection_error",
    "first_token_stall",
    "mid_stream_failure",
  ].includes(step.outcome);
  const phase = step.outcome === "connection_error" || step.outcome.startsWith("http_")
    ? "connect"
    : step.outcome === "first_token_stall"
    ? "first_token"
    : step.outcome === "mid_stream_failure"
    ? "stream"
    : "response";
  return new SimulatedProviderError(step.outcome, step.message ?? defaults[step.outcome], {
    transient,
    phase,
    responseVisible: visible,
    status: step.status ??
      (step.outcome === "http_transient"
        ? 503
        : step.outcome === "http_permanent"
        ? 400
        : undefined),
    retryAfterMs: step.retryAfterMs,
  });
}

/** Maps a simulator failure to the executor's transport-neutral classification contract. */
export function simulatedErrorClassification(
  error: unknown,
): SimulatedErrorClassification | undefined {
  if (!(error instanceof SimulatedProviderError)) return undefined;
  const suppliedStatus =
    Number.isSafeInteger(error.details.status) && error.details.status! >= 400 &&
      error.details.status! <= 599
      ? error.details.status
      : undefined;
  const status = error.kind === "http_transient"
    ? suppliedStatus !== undefined && transientStatuses.has(suppliedStatus) ? suppliedStatus : 503
    : error.kind === "http_permanent"
    ? suppliedStatus !== undefined && !transientStatuses.has(suppliedStatus) ? suppliedStatus : 400
    : undefined;
  const retryAfterMs = error.kind === "http_transient" &&
      Number.isSafeInteger(error.details.retryAfterMs) && error.details.retryAfterMs! >= 0 &&
      error.details.retryAfterMs! <= MAX_STEP_DELAY_MS
    ? error.details.retryAfterMs
    : undefined;
  const category: SimulatedErrorClassification["category"] = error.kind === "connection_error" ||
      error.kind === "mid_stream_failure"
    ? "network"
    : error.kind === "first_token_stall"
    ? "timeout"
    : error.kind === "empty_response" || error.kind === "malformed_response"
    ? "invalid_response"
    : status === 401 || status === 403
    ? "authentication"
    : status === 408 || status === 425 || status === 504
    ? "timeout"
    : status === 429
    ? "rate_limited"
    : status !== undefined && status >= 500
    ? "upstream_unavailable"
    : "invalid_request";
  const transient = [
    "http_transient",
    "connection_error",
    "first_token_stall",
    "mid_stream_failure",
  ].includes(error.kind);
  const phase = error.kind === "connection_error" || error.kind.startsWith("http_")
    ? "connect"
    : error.kind === "first_token_stall"
    ? "first_token"
    : error.kind === "mid_stream_failure"
    ? "stream"
    : "response";
  return {
    category,
    transient,
    status,
    retryAfterMs,
    phase,
    responseVisible: error.kind === "mid_stream_failure" || Boolean(error.details.responseVisible),
  };
}

/** Counts user-visible units in normalized simulator events for resilience first-token handling. */
export function simulatedVisibleUnits(event: unknown): number {
  if (!event || typeof event !== "object" || Array.isArray(event)) return 0;
  const candidate = event as Record<string, unknown>;
  if (candidate.type === "text" || candidate.type === "reasoning") {
    return typeof candidate.text === "string" ? candidate.text.length : 0;
  }
  return candidate.type === "tool" ? 1 : 0;
}

/** Emits transport-neutral provider events. It never constructs URLs, headers, or executable code. */
export async function* streamSimulatedProvider(
  input: unknown,
  signal: AbortSignal,
  options: SimulatorOptions = {},
): AsyncGenerator<SimulatedProviderEvent> {
  const scenario = validateSimulatedProviderScenario(input);
  const rng = random(scenario.seed);
  const clock = options.clock ?? realClock;
  let visible = false;
  let toolOrdinal = 0;
  const usedToolIds = new Set(
    scenario.steps.flatMap((step) => step.type === "tool" && step.id ? [step.id] : []),
  );
  for (const step of scenario.steps) {
    const jitter = step.jitterMs ? Math.floor(rng() * (step.jitterMs + 1)) : 0;
    const delayMs = step.delayMs + jitter;
    await sleep(clock, delayMs, signal);
    signal.throwIfAborted();
    if (step.type === "failure") throw failure(step, visible);
    if (step.type === "role") yield { type: step.type, role: step.role, delayMs };
    if (step.type === "text") {
      visible = true;
      yield { type: step.type, text: step.text, delayMs };
    }
    if (step.type === "reasoning") {
      visible = true;
      yield { type: step.type, text: step.text, delayMs };
    }
    if (step.type === "tool") {
      visible = true;
      toolOrdinal++;
      let id = step.id;
      while (!id || usedToolIds.has(id) && id !== step.id) {
        id = `call_${toolOrdinal}_${Math.floor(rng() * 0xffff_ffff).toString(16).padStart(8, "0")}`;
      }
      usedToolIds.add(id);
      yield {
        type: step.type,
        id,
        name: step.name,
        arguments: structuredClone(step.arguments),
        delayMs,
      };
    }
    if (step.type === "usage") {
      yield {
        type: step.type,
        inputTokens: step.inputTokens,
        cachedInputTokens: step.cachedInputTokens,
        reasoningTokens: step.reasoningTokens,
        outputTokens: step.outputTokens,
        delayMs,
      };
    }
  }
  signal.throwIfAborted();
  yield { type: "done" };
}

/** Collects the normalized stream into a deterministic non-streaming completion. */
export async function completeSimulatedProvider(
  input: unknown,
  signal: AbortSignal,
  options: SimulatorOptions = {},
): Promise<SimulatedProviderCompletion> {
  const scenario = validateSimulatedProviderScenario(input);
  let role: SimulatedProviderCompletion["role"] = "assistant";
  let text = "";
  let reasoning = "";
  const toolCalls: SimulatedProviderCompletion["toolCalls"] = [];
  let usage: SimulatedProviderCompletion["usage"] | undefined;
  for await (const event of streamSimulatedProvider(scenario, signal, options)) {
    if (event.type === "role") role = event.role;
    if (event.type === "text") text += event.text;
    if (event.type === "reasoning") reasoning += event.text;
    if (event.type === "tool") {
      toolCalls.push({
        id: event.id,
        name: event.name,
        arguments: structuredClone(event.arguments),
      });
    }
    if (event.type === "usage") {
      usage = {
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        reasoningTokens: event.reasoningTokens,
        outputTokens: event.outputTokens,
        source: "scenario",
      };
    }
  }
  return {
    scenarioId: scenario.id,
    seed: scenario.seed,
    role,
    text,
    reasoning,
    toolCalls,
    usage: usage ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: Math.ceil(reasoning.length / 4),
      outputTokens: Math.ceil(
        (text.length + reasoning.length + JSON.stringify(toolCalls).length) / 4,
      ),
      source: "estimated",
    },
  };
}
