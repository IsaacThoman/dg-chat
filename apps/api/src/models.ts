import type { ChatCompletionRequest, ModelInfo } from "@dg-chat/contracts";
import { isSpecialUseIp, pinnedProviderFetch } from "./provider_transport.ts";

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
    boundedString((chunk.error as Record<string, unknown>).message, "stream error message");
    return 0;
  }
  if (!Array.isArray(chunk.choices) || chunk.choices.length > 128) {
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
  if (!baseUrl || !apiKey) throw new Error("The OpenAI-compatible provider is not configured");
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
      const parsed = JSON.parse(payload) as { error?: { message?: string } };
      message = parsed.error?.message ?? message;
    } catch {
      // Non-JSON error bodies still retain the provider status without reflecting arbitrary HTML.
    }
    throw new Error(message);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    await response.body?.cancel();
    throw new Error("Provider returned a non-SSE response for a streaming request");
  }
  if (!response.body) throw new Error("Provider returned an empty event stream");
  yield* parseOpenAIEventStream(response.body, combinedSignal, {
    promptTokens: new TextEncoder().encode(JSON.stringify(request)).length,
    completionTokens: request.max_tokens ?? request.max_completion_tokens ?? 4096,
  }, maxResponseBytes(options.maxResponseBytes));
}

export async function complete(
  request: ChatCompletionRequest,
  signal: AbortSignal,
  options: UpstreamStreamOptions = {},
): Promise<{ text: string; inputTokens: number; outputTokens: number; upstream?: unknown }> {
  const inputTokens = Math.max(1, Math.ceil(JSON.stringify(request.messages).length / 4));
  if (request.model.startsWith("simulated/")) {
    const text = simulate(request);
    return { text, inputTokens, outputTokens: Math.ceil(text.length / 4) };
  }
  const baseUrl = options.baseUrl ?? Deno.env.get("OPENAI_BASE_URL");
  const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY");
  if (!baseUrl || !apiKey) throw new Error("The OpenAI-compatible provider is not configured");
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
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Provider returned malformed JSON");
  }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).error
      : undefined;
    const message = error && typeof error === "object" && !Array.isArray(error)
      ? boundedString((error as Record<string, unknown>).message, "provider error message")
      : undefined;
    throw new Error(
      message ?? `Provider returned ${response.status}`,
    );
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
  if (!Array.isArray(data.choices) || data.choices.length < 1 || data.choices.length > 128) {
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
    const content = boundedString(fields.content, "message content", true);
    if (content) outputBytes += new TextEncoder().encode(content).length;
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
  return {
    text,
    inputTokens: tokenCount(usage.prompt_tokens, "prompt token usage") ?? inputTokens,
    outputTokens: Math.max(
      tokenCount(usage.completion_tokens, "completion token usage") ?? 0,
      estimatedOutputTokens,
    ),
    upstream: payload,
  };
}
