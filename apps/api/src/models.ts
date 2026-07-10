import type { ChatCompletionRequest, ModelInfo } from "@dg-chat/contracts";

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

function providerEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  const privateHost = host === "localhost" || host === "::1" || host === "0.0.0.0" ||
    host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "169.254.169.254";
  if (url.protocol !== "https:" && !(Deno.env.get("DENO_ENV") !== "production" && privateHost)) {
    throw new Error("Provider URL must use HTTPS");
  }
  if (Deno.env.get("DENO_ENV") === "production" && privateHost) {
    throw new Error("Provider URL may not target a private network");
  }
  return `${url.toString().replace(/\/$/, "")}/chat/completions`;
}

export interface UpstreamStreamOptions {
  baseUrl?: string;
  apiKey?: string;
  upstreamModel?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const MAX_SSE_BUFFER_LENGTH = 1_048_576;

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

function validateOpenAIChunk(data: string) {
  if (data === "[DONE]") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Upstream sent malformed JSON in its event stream");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Upstream sent a non-object chat completion chunk");
  }
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
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let dataLength = 0;
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
    validateOpenAIChunk(data);
    return data;
  };

  try {
    while (!sawDone) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
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
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const response = await (options.fetch ?? fetch)(providerEndpoint(baseUrl), {
    method: "POST",
    signal: AbortSignal.any([signal, timeout]),
    redirect: "error",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...request, model: upstreamModel, stream: true }),
  });
  if (!response.ok) {
    const payload = await response.text();
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
  yield* parseOpenAIEventStream(response.body, signal);
}

export async function complete(
  request: ChatCompletionRequest,
  signal: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number; upstream?: unknown }> {
  const inputTokens = Math.max(1, Math.ceil(JSON.stringify(request.messages).length / 4));
  if (request.model.startsWith("simulated/")) {
    const text = simulate(request);
    return { text, inputTokens, outputTokens: Math.ceil(text.length / 4) };
  }
  const baseUrl = Deno.env.get("OPENAI_BASE_URL");
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!baseUrl || !apiKey) throw new Error("The OpenAI-compatible provider is not configured");
  const upstreamModel = request.model === "openai/default"
    ? (Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini")
    : request.model.replace(/^openai\//, "");
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetch(providerEndpoint(baseUrl), {
    method: "POST",
    signal: AbortSignal.any([signal, timeout]),
    redirect: "error",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ...request, model: upstreamModel, stream: false }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      (payload as { error?: { message?: string } }).error?.message ??
        `Provider returned ${response.status}`,
    );
  }
  const data = payload as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? inputTokens,
    outputTokens: data.usage?.completion_tokens ?? Math.ceil(text.length / 4),
    upstream: payload,
  };
}
