import type { ChatCompletionRequest, ModelInfo } from "@dg-chat/contracts";
import { isSpecialUseIp, pinnedProviderFetch } from "./provider_transport.ts";
import { ProviderAttemptError } from "./provider-resilience.ts";

export const models: ModelInfo[] = [
  {
    id: "simulated/dg-chat",
    displayName: "DG Chat Simulated",
    provider: "simulated",
    capabilities: ["chat", "streaming", "tools", "vision"],
    contextWindow: 128000,
    inputMicrosPerMillion: 100_000,
    outputMicrosPerMillion: 300_000,
  },
  {
    id: "openai/default",
    displayName: "Configured OpenAI model",
    provider: "openai-compatible",
    capabilities: ["chat", "streaming", "tools", "vision"],
    contextWindow: 128000,
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 3_000_000,
  },
];

export function contentText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content.map((part) =>
    typeof part.text === "string" ? part.text : part.type === "image_url" ? "[image]" : ""
  ).filter(Boolean).join("\n");
}

export function simulate(request: ChatCompletionRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  const prompt = last ? contentText(last.content) : "Hello";
  const response = `This is a simulated response to: ${prompt}`;
  const maxTokens = request.max_tokens ?? request.max_completion_tokens;
  return maxTokens === undefined ? response : response.slice(0, maxTokens * 4);
}

const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_PROVIDER_TEXT_LENGTH = 8_388_608;
const DEFAULT_MAX_RESPONSE_BYTES = 16_777_216;

function providerEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || isSpecialUseIp(host);
  const testHost = Deno.env.get("DENO_ENV") === "test" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === host;
  if (
    url.protocol !== "https:" &&
    !(Deno.env.get("DENO_ENV") !== "production" && (privateHost || testHost))
  ) {
    throw new Error("Provider URL must use HTTPS");
  }
  if (Deno.env.get("DENO_ENV") === "production" && privateHost) {
    throw new Error("Provider URL may not target a private network");
  }
  return `${url.toString().replace(/\/$/, "")}/chat/completions`;
}

function providerFetch(endpoint: string, options: UpstreamStreamOptions): typeof fetch {
  if (options.fetch) return options.fetch;
  const url = new URL(endpoint);
  const testHttp = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  return testHttp ? fetch : pinnedProviderFetch;
}

export interface UpstreamStreamOptions {
  baseUrl?: string;
  apiKey?: string;
  upstreamModel?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? Math.ceil(seconds * 1_000)
    : Date.parse(value) - Date.now();
  if (!Number.isSafeInteger(delay) || delay < 0) return undefined;
  return Math.min(delay, 300_000);
}

const MAX_SSE_BUFFER_LENGTH = 1_048_576;
function maxResponseBytes(override?: number): number {
  const value = override ?? Number(
    Deno.env.get("OPENAI_MAX_RESPONSE_BYTES") ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 67_108_864) {
    throw new Error("OPENAI_MAX_RESPONSE_BYTES must be between 1024 and 67108864");
  }
  return value;
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error("Provider response exceeded the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Provider response exceeded the size limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function boundedString(value: unknown, field: string, nullable = false): string | null | undefined {
  if (value === undefined) return undefined;
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > MAX_PROVIDER_TEXT_LENGTH) {
    throw new Error(`Upstream sent an invalid ${field}`);
  }
  return value;
}

function tokenCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_TOKEN_COUNT) {
    throw new Error(`Upstream sent an invalid ${field}`);
  }
  return Number(value);
}

function validateToolCalls(value: unknown) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("Upstream sent invalid tool call deltas");
  }
  for (const call of value) {
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw new Error("Upstream sent invalid tool call deltas");
    }
    const item = call as Record<string, unknown>;
    if (
      item.index !== undefined &&
      (!Number.isSafeInteger(item.index) || Number(item.index) < 0 || Number(item.index) > 127)
    ) throw new Error("Upstream sent an invalid tool call index");
    boundedString(item.id, "tool call id");
    boundedString(item.type, "tool call type");
    if (item.function !== undefined) {
      if (!item.function || typeof item.function !== "object" || Array.isArray(item.function)) {
        throw new Error("Upstream sent invalid tool call function");
      }
      const fn = item.function as Record<string, unknown>;
      boundedString(fn.name, "tool call function name");
      boundedString(fn.arguments, "tool call function arguments");
    }
  }
}

interface UsageBounds {
  promptTokens: number;
  completionTokens: number;
}

function validateUsage(value: unknown, bounds?: UsageBounds) {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Upstream sent invalid usage");
  }
  const usage = value as Record<string, unknown>;
  const promptTokens = tokenCount(usage.prompt_tokens, "prompt token usage");
  const completionTokens = tokenCount(usage.completion_tokens, "completion token usage");
  const totalTokens = tokenCount(usage.total_tokens, "total token usage");
  if (bounds) {
    if (promptTokens !== undefined && promptTokens > bounds.promptTokens) {
      throw new Error("Upstream prompt token usage exceeds the reserved request bound");
    }
    if (completionTokens !== undefined && completionTokens > bounds.completionTokens) {
      throw new Error("Upstream completion token usage exceeds the requested output bound");
    }
    if (totalTokens !== undefined && totalTokens > bounds.promptTokens + bounds.completionTokens) {
      throw new Error("Upstream total token usage exceeds the reserved request bound");
    }
  }
  for (const detailsName of ["prompt_tokens_details", "completion_tokens_details"]) {
    const details = usage[detailsName];
    if (details === undefined || details === null) continue;
    if (typeof details !== "object" || Array.isArray(details)) {
      throw new Error(`Upstream sent invalid ${detailsName}`);
    }
    for (const [name, count] of Object.entries(details)) {
      if (name.endsWith("_tokens")) tokenCount(count, `${detailsName}.${name}`);
    }
  }
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const cachedTokens = promptDetails
    ? tokenCount(promptDetails.cached_tokens, "prompt_tokens_details.cached_tokens")
    : undefined;
  const reasoningTokens = completionDetails
    ? tokenCount(completionDetails.reasoning_tokens, "completion_tokens_details.reasoning_tokens")
    : undefined;
  if (cachedTokens !== undefined) {
    if (promptTokens === undefined) {
      throw new Error("Upstream sent invalid usage: cached tokens require prompt tokens");
    }
    if (cachedTokens > promptTokens) {
      throw new Error("Upstream cached token usage exceeds prompt token usage");
    }
  }
  if (reasoningTokens !== undefined) {
    if (completionTokens === undefined) {
      throw new Error("Upstream sent invalid usage: reasoning tokens require completion tokens");
    }
    if (reasoningTokens > completionTokens) {
      throw new Error("Upstream reasoning token usage exceeds completion token usage");
    }
  }
}
function providerTimeoutMs(override?: number): number {
  const value = override ?? Number(Deno.env.get("OPENAI_TIMEOUT_MS") ?? 120_000);
  if (!Number.isSafeInteger(value) || value < 100 || value > 600_000) {
    throw new Error("OPENAI_TIMEOUT_MS must be an integer between 100 and 600000");
  }
  return value;
}

function nextSSELine(buffer: string, streamEnded: boolean) {
  for (let index = 0; index < buffer.length; index++) {
    const character = buffer[index];
    if (character !== "\r" && character !== "\n") continue;
    if (character === "\r" && index === buffer.length - 1 && !streamEnded) return undefined;
    const separatorLength = character === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
    return { line: buffer.slice(0, index), rest: buffer.slice(index + separatorLength) };
  }
  if (streamEnded && buffer.length) return { line: buffer, rest: "" };
  return undefined;
}

function validateOpenAIChunk(data: string, usageBounds?: UsageBounds): number {
  if (data === "[DONE]") return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Upstream sent malformed JSON in its event stream");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Upstream sent a non-object chat completion chunk");
  }
  const chunk = parsed as Record<string, unknown>;
  boundedString(chunk.id, "chunk id");
  boundedString(chunk.object, "chunk object");
  boundedString(chunk.model, "chunk model");
  if (
    chunk.created !== undefined &&
    (!Number.isSafeInteger(chunk.created) || Number(chunk.created) < 0)
  ) throw new Error("Upstream sent an invalid chunk creation time");
  validateUsage(chunk.usage, usageBounds);
  if (chunk.error !== undefined) {
    if (!chunk.error || typeof chunk.error !== "object" || Array.isArray(chunk.error)) {
      throw new Error("Upstream sent an invalid stream error");
    }
    const error = chunk.error as Record<string, unknown>;
    const message = boundedString(error.message, "stream error message") ??
      "Provider stream failed";
    const code = boundedString(error.code, "stream error code");
    const type = boundedString(error.type, "stream error type");
    if (message.length > 500 || (code?.length ?? 0) > 120 || (type?.length ?? 0) > 120) {
      throw new Error("Upstream sent an invalid stream error");
    }
    throw new ProviderAttemptError(
      code ? `${message} (${code})` : type ? `${message} (${type})` : message,
      {
        category: "invalid_response",
        transient: true,
      },
    );
  }
  // The public contract only supports n=1. Empty choice arrays remain valid for
  // usage-only stream chunks, but multiple choices would otherwise leak an
  // unsupported response shape after the request has already been accepted.
  if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) {
    throw new Error("Upstream sent invalid chat completion choices");
  }
  let outputBytes = 0;
  for (const choice of chunk.choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      throw new Error("Upstream sent an invalid chat completion choice");
    }
    const choiceFields = choice as Record<string, unknown>;
    if (
      choiceFields.index !== undefined &&
      (!Number.isSafeInteger(choiceFields.index) || Number(choiceFields.index) < 0)
    ) throw new Error("Upstream sent an invalid chat completion choice index");
    const delta = choiceFields.delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
      throw new Error("Upstream sent an invalid chat completion delta");
    }
    const fields = delta as Record<string, unknown>;
    const content = boundedString(fields.content, "delta content", true);
    if (content) outputBytes += new TextEncoder().encode(content).length;
    if (
      fields.role !== undefined &&
      (typeof fields.role !== "string" ||
        !["assistant", "system", "user", "tool"].includes(fields.role))
    ) throw new Error("Upstream sent an invalid delta role");
    validateToolCalls(fields.tool_calls);
    if (fields.tool_calls !== undefined) {
      outputBytes += new TextEncoder().encode(JSON.stringify(fields.tool_calls)).length;
    }
  }
  return outputBytes;
}

/**
 * Parses OpenAI-compatible SSE and yields each decoded `data` payload verbatim. The terminal
 * `[DONE]` payload is yielded as well, allowing an HTTP route to proxy frames without rebuilding
 * provider chunks. A successful stream must be valid SSE, contain JSON object chunks, and end in
 * `[DONE]`.
 */
export async function* parseOpenAIEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  usageBounds?: UsageBounds,
  maxStreamBytes = DEFAULT_MAX_RESPONSE_BYTES,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let dataLength = 0;
  let outputBytes = 0;
  let receivedBytes = 0;
  let sawDone = false;
  const abortReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abortReader, { once: true });

  const dispatch = () => {
    if (!dataLines.length) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    dataLength = 0;
    outputBytes += validateOpenAIChunk(data, usageBounds);
    if (usageBounds && outputBytes > usageBounds.completionTokens * 4) {
      throw new Error("Upstream output exceeds the requested output bound");
    }
    return data;
  };

  try {
    while (!sawDone) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      receivedBytes += value?.byteLength ?? 0;
      if (receivedBytes > maxStreamBytes) {
        throw new Error("Provider response exceeded the size limit");
      }
      buffer += decoder.decode(value, { stream: !done });

      while (true) {
        const next = nextSSELine(buffer, done);
        if (!next) break;
        buffer = next.rest;
        const line = next.line;
        if (line === "") {
          const data = dispatch();
          if (data === undefined) continue;
          yield data;
          if (data === "[DONE]") {
            sawDone = true;
            break;
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let valueText = colon === -1 ? "" : line.slice(colon + 1);
        if (valueText.startsWith(" ")) valueText = valueText.slice(1);
        if (field === "data") {
          dataLength += valueText.length + (dataLines.length ? 1 : 0);
          if (dataLength > MAX_SSE_BUFFER_LENGTH) {
            throw new Error("Upstream event stream frame exceeded the size limit");
          }
          dataLines.push(valueText);
        }
      }

      if (buffer.length > MAX_SSE_BUFFER_LENGTH) {
        throw new Error("Upstream event stream line exceeded the size limit");
      }

      if (done) break;
    }
    if (!sawDone) {
      if (dataLines.length) throw new Error("Upstream event stream ended mid-frame");
      throw new Error("Upstream event stream ended without [DONE]");
    }
  } finally {
    signal.removeEventListener("abort", abortReader);
    await reader.cancel(signal.aborted ? signal.reason : undefined).catch(() => undefined);
    reader.releaseLock();
  }
}

/** Opens an OpenAI-compatible upstream Chat Completions stream. */
export async function* streamChatCompletion(
  request: ChatCompletionRequest,
  signal: AbortSignal,
  options: UpstreamStreamOptions = {},
): AsyncGenerator<string> {
  signal.throwIfAborted();
  const baseUrl = options.baseUrl ?? Deno.env.get("OPENAI_BASE_URL");
  const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY");
  if (!baseUrl || !apiKey) {
    throw new ProviderAttemptError("The OpenAI-compatible provider is not configured", {
      category: "invalid_request",
      transient: false,
    });
  }
  const upstreamModel = options.upstreamModel ??
    (request.model === "openai/default"
      ? (Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini")
      : request.model.replace(/^openai\//, ""));
  const timeout = AbortSignal.timeout(providerTimeoutMs(options.timeoutMs));
  const combinedSignal = AbortSignal.any([signal, timeout]);
  const endpoint = providerEndpoint(baseUrl);
  const response = await providerFetch(endpoint, options)(endpoint, {
    method: "POST",
    signal: combinedSignal,
    redirect: "error",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...request, model: upstreamModel, stream: true }),
  });
  if (!response.ok) {
    const payload = await readBoundedBody(response, maxResponseBytes(options.maxResponseBytes));
    let message = `Provider returned ${response.status}`;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const error = (parsed as Record<string, unknown>).error;
        if (error !== undefined) {
          if (!error || typeof error !== "object" || Array.isArray(error)) {
            throw new Error("Upstream sent an invalid provider error");
          }
          const fields = error as Record<string, unknown>;
          const upstreamMessage = boundedString(fields.message, "provider error message");
          const type = boundedString(fields.type, "provider error type");
          const code = boundedString(fields.code, "provider error code");
          for (
            const [name, value, limit] of [
              ["message", upstreamMessage, 500],
              ["type", type, 120],
              ["code", code, 120],
            ] as const
          ) {
            if (value != null && value.length > limit) {
              throw new Error(`Upstream sent an invalid provider error ${name}`);
            }
          }
          if (upstreamMessage) {
            message = `${upstreamMessage}${code ? ` (${code})` : type ? ` (${type})` : ""}`;
          }
        }
      }
    } catch {
      // Malformed error bodies retain only the authoritative provider status.
    }
    throw new ProviderAttemptError(message, {
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers),
    });
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    await response.body?.cancel();
    throw new ProviderAttemptError("Provider returned a non-SSE response for a streaming request", {
      category: "invalid_response",
      transient: true,
    });
  }
  if (!response.body) {
    throw new ProviderAttemptError("Provider returned an empty event stream", {
      category: "invalid_response",
      transient: true,
    });
  }
  try {
    yield* parseOpenAIEventStream(response.body, combinedSignal, {
      promptTokens: new TextEncoder().encode(JSON.stringify(request)).length,
      completionTokens: request.max_tokens ?? request.max_completion_tokens ?? 4096,
    }, maxResponseBytes(options.maxResponseBytes));
  } catch (error) {
    if (combinedSignal.aborted || error instanceof ProviderAttemptError) throw error;
    throw new ProviderAttemptError(
      error instanceof Error ? error.message : "Provider returned an invalid event stream",
      { category: "invalid_response", transient: true },
    );
  }
}

async function completeAttempt(
  request: ChatCompletionRequest,
  signal: AbortSignal,
  options: UpstreamStreamOptions = {},
): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  upstream?: unknown;
}> {
  const inputTokens = Math.max(1, Math.ceil(JSON.stringify(request.messages).length / 4));
  if (request.model.startsWith("simulated/")) {
    const text = simulate(request);
    return { text, inputTokens, outputTokens: Math.ceil(text.length / 4) };
  }
  const baseUrl = options.baseUrl ?? Deno.env.get("OPENAI_BASE_URL");
  const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY");
  if (!baseUrl || !apiKey) {
    throw new ProviderAttemptError("The OpenAI-compatible provider is not configured", {
      category: "invalid_request",
      transient: false,
    });
  }
  const upstreamModel = options.upstreamModel ??
    (request.model === "openai/default"
      ? (Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini")
      : request.model.replace(/^openai\//, ""));
  const timeout = AbortSignal.timeout(providerTimeoutMs(options.timeoutMs));
  const endpoint = providerEndpoint(baseUrl);
  const response = await providerFetch(endpoint, options)(endpoint, {
    method: "POST",
    signal: AbortSignal.any([signal, timeout]),
    redirect: "error",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ...request, model: upstreamModel, stream: false }),
  });
  const body = await readBoundedBody(response, maxResponseBytes(options.maxResponseBytes));
  if (!response.ok) {
    let message: string | undefined;
    try {
      const parsed = JSON.parse(body) as unknown;
      const error = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).error
        : undefined;
      message = error && typeof error === "object" && !Array.isArray(error)
        ? boundedString((error as Record<string, unknown>).message, "provider error message") ??
          undefined
        : undefined;
    } catch {
      // Error bodies are advisory. HTTP status and Retry-After remain authoritative.
    }
    throw new ProviderAttemptError(message ?? `Provider returned ${response.status}`, {
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers),
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ProviderAttemptError("Provider returned malformed JSON", {
      category: "invalid_response",
      transient: true,
    });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Provider returned a non-object chat completion");
  }
  const data = payload as Record<string, unknown>;
  boundedString(data.id, "completion id");
  boundedString(data.object, "completion object");
  boundedString(data.model, "completion model");
  if (
    data.created !== undefined &&
    (!Number.isSafeInteger(data.created) || Number(data.created) < 0)
  ) throw new Error("Provider returned an invalid completion creation time");
  validateUsage(data.usage, {
    promptTokens: new TextEncoder().encode(JSON.stringify(request)).length,
    completionTokens: request.max_tokens ?? request.max_completion_tokens ?? 4096,
  });
  if (!Array.isArray(data.choices) || data.choices.length !== 1) {
    throw new Error("Provider returned invalid chat completion choices");
  }
  let outputBytes = 0;
  for (const choice of data.choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      throw new Error("Provider returned an invalid chat completion choice");
    }
    const choiceFields = choice as Record<string, unknown>;
    if (
      choiceFields.index !== undefined &&
      (!Number.isSafeInteger(choiceFields.index) || Number(choiceFields.index) < 0)
    ) throw new Error("Provider returned an invalid chat completion choice index");
    const message = choiceFields.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("Provider returned an invalid chat completion message");
    }
    const fields = message as Record<string, unknown>;
    if (fields.role !== undefined && fields.role !== "assistant") {
      throw new Error("Provider returned an invalid completion message role");
    }
    const content = boundedString(fields.content, "message content", true);
    if (content) outputBytes += new TextEncoder().encode(content).length;
    for (
      const name of ["refusal", "reasoning_content", "reasoning", "reasoning_summary"] as const
    ) {
      const value = boundedString(fields[name], `message ${name}`, true);
      if (value) outputBytes += new TextEncoder().encode(value).length;
    }
    validateToolCalls(fields.tool_calls);
    if (fields.tool_calls !== undefined) {
      outputBytes += new TextEncoder().encode(JSON.stringify(fields.tool_calls)).length;
    }
  }
  const completionBound = request.max_tokens ?? request.max_completion_tokens ?? 4096;
  const estimatedOutputTokens = Math.ceil(outputBytes / 4);
  if (estimatedOutputTokens > completionBound) {
    throw new Error("Provider output exceeds the requested output bound");
  }
  const firstMessage = (data.choices[0] as Record<string, unknown>).message as Record<
    string,
    unknown
  >;
  const text = boundedString(firstMessage.content, "message content", true) ?? "";
  const usage = data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
    ? data.usage as Record<string, unknown>
    : {};
  const promptDetails = usage.prompt_tokens_details &&
      typeof usage.prompt_tokens_details === "object" && !Array.isArray(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  const completionDetails = usage.completion_tokens_details &&
      typeof usage.completion_tokens_details === "object" &&
      !Array.isArray(usage.completion_tokens_details)
    ? usage.completion_tokens_details as Record<string, unknown>
    : {};
  const cachedInputTokens = tokenCount(
    promptDetails.cached_tokens,
    "prompt_tokens_details.cached_tokens",
  );
  const reasoningTokens = tokenCount(
    completionDetails.reasoning_tokens,
    "completion_tokens_details.reasoning_tokens",
  );
  return {
    text,
    inputTokens: tokenCount(usage.prompt_tokens, "prompt token usage") ?? inputTokens,
    outputTokens: Math.max(
      tokenCount(usage.completion_tokens, "completion token usage") ?? 0,
      estimatedOutputTokens,
    ),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    upstream: payload,
  };
}

export async function complete(
  request: ChatCompletionRequest,
  signal: AbortSignal,
  options: UpstreamStreamOptions = {},
): ReturnType<typeof completeAttempt> {
  try {
    return await completeAttempt(request, signal, options);
  } catch (error) {
    if (
      signal.aborted || error instanceof ProviderAttemptError || error instanceof TypeError ||
      (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
    ) throw error;
    throw new ProviderAttemptError(
      error instanceof Error ? error.message : "Provider returned an invalid completion",
      { category: "invalid_response", transient: true },
    );
  }
}
