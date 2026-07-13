import type { ChatCompletionRequest } from "@dg-chat/contracts";
import {
  type CanonicalResult,
  type CanonicalStreamEvent,
  chatCompletionsRequestToResponses,
  normalizeResponsesResult,
  normalizeResponsesStreamEvent,
  ProviderProtocolError,
} from "./provider-protocol.ts";
import { type UpstreamStreamOptions } from "./models.ts";
import { isSpecialUseIp, pinnedProviderFetch } from "./provider_transport.ts";
import { ProviderAttemptError } from "./provider-resilience.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 16_777_216;
const MAX_RESPONSE_BYTES = 67_108_864;
const MAX_SSE_LINE_BYTES = 1_048_576;
const MAX_ERROR_BODY_BYTES = 65_536;
// Large whitespace/code tokens can decode to far more than four bytes. Keep a bounded
// per-token ceiling while the transport-wide response limit remains the hard outer bound.
const MAX_VISIBLE_BYTES_PER_OUTPUT_TOKEN = 256;
const encoder = new TextEncoder();

class ResponsesStreamConsistency {
  readonly #text = new Map<string, string>();
  readonly #tools = new Map<number, { id: string; name: string; arguments: string }>();
  #refusal = "";
  #reasoning = "";
  #summary = "";

  observe(events: CanonicalStreamEvent[]) {
    for (const event of events) {
      if (event.type === "text_delta") {
        const key = `${event.outputIndex ?? 0}:${event.contentIndex ?? 0}`;
        this.#text.set(key, (this.#text.get(key) ?? "") + event.text);
      } else if (event.type === "refusal_delta") this.#refusal += event.text;
      else if (event.type === "reasoning_delta") {
        if (event.summary) this.#summary += event.text;
        else this.#reasoning += event.text;
      } else if (event.type === "tool_call_delta") {
        const current = this.#tools.get(event.index) ?? { id: "", name: "", arguments: "" };
        this.#tools.set(event.index, {
          id: event.id ?? current.id,
          name: event.name ?? current.name,
          arguments: current.arguments + (event.arguments ?? ""),
        });
      }
    }
  }

  validate(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const event = input as Record<string, unknown>;
    const type = event.type;
    const text = (field: string) => {
      if (typeof event[field] !== "string") {
        throw new Error(`Responses ${String(type)} omitted ${field}`);
      }
      return event[field] as string;
    };
    const index = (field: string) => {
      const value = event[field] ?? 0;
      if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`Responses ${String(type)} has an invalid ${field}`);
      }
      return Number(value);
    };
    if (type === "response.output_text.done") {
      this.#equal(
        text("text"),
        this.#text.get(`${index("output_index")}:${index("content_index")}`) ?? "",
        type,
      );
    } else if (type === "response.refusal.done") {
      this.#equal(text("refusal"), this.#refusal, type);
    } else if (type === "response.reasoning_summary_text.done") {
      this.#equal(text("text"), this.#summary, type);
    } else if (type === "response.reasoning_text.done") {
      this.#equal(text("text"), this.#reasoning, type);
    } else if (type === "response.function_call_arguments.done") {
      const tool = this.#tools.get(index("output_index"));
      if (!tool) throw new Error("Responses function-call done event has no matching item");
      this.#equal(text("name"), tool.name, type);
      this.#equal(text("arguments"), tool.arguments, type);
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = event.response;
      {
        const result = normalizeResponsesResult(response);
        const streamedText = [...this.#text.entries()].sort(([left], [right]) =>
          left.localeCompare(right, undefined, { numeric: true })
        ).map(([, value]) => value).join("");
        this.#equal(result.text, streamedText, "terminal response text");
        this.#equal(result.refusal ?? "", this.#refusal, "terminal response refusal");
        this.#equal(result.reasoning?.summary ?? "", this.#summary, "terminal reasoning summary");
        this.#equal(result.reasoning?.content ?? "", this.#reasoning, "terminal reasoning content");
        const terminalTools = result.toolCalls.map(({ id, name, arguments: value }) => ({
          id,
          name,
          arguments: value,
        }));
        const streamedTools = [...this.#tools.entries()].sort(([left], [right]) => left - right)
          .map(
            ([, value]) => value,
          );
        if (JSON.stringify(terminalTools) !== JSON.stringify(streamedTools)) {
          throw new Error("Responses terminal function calls conflict with streamed deltas");
        }
      }
    }
  }

  #equal(actual: string, expected: string, context: unknown) {
    if (actual !== expected) throw new Error(`${String(context)} conflicts with streamed deltas`);
  }
}

export interface ResponsesUpstreamOptions extends UpstreamStreamOptions {
  protocol?: "responses";
  /** Responses-only fields preserved by the public Responses compatibility route. */
  requestFields?: NativeResponsesRequestFields;
}

export interface NativeResponsesRequestFields {
  store?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ResponsesChatCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  upstream: Record<string, unknown>;
}

function providerTimeoutMs(override?: number): number {
  const value = override ?? Number(Deno.env.get("OPENAI_TIMEOUT_MS") ?? 120_000);
  if (!Number.isSafeInteger(value) || value < 100 || value > 600_000) {
    throw new Error("OPENAI_TIMEOUT_MS must be an integer between 100 and 600000");
  }
  return value;
}

function responseByteLimit(override?: number): number {
  const value = override ?? Number(
    Deno.env.get("OPENAI_MAX_RESPONSE_BYTES") ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  if (!Number.isSafeInteger(value) || value < 1_024 || value > MAX_RESPONSE_BYTES) {
    throw new Error("OPENAI_MAX_RESPONSE_BYTES must be between 1024 and 67108864");
  }
  return value;
}

function responsesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || isSpecialUseIp(host);
  const testHost = Deno.env.get("DENO_ENV") === "test" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === host;
  if (
    url.protocol !== "https:" &&
    !(Deno.env.get("DENO_ENV") !== "production" && (privateHost || testHost))
  ) throw new Error("Provider URL must use HTTPS");
  if (Deno.env.get("DENO_ENV") === "production" && privateHost) {
    throw new Error("Provider URL may not target a private network");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Provider URL must not contain credentials, a query, or a fragment");
  }
  return `${url.toString().replace(/\/$/, "")}/responses`;
}

function responseFetch(endpoint: string, options: ResponsesUpstreamOptions): typeof fetch {
  if (options.fetch) return options.fetch;
  const url = new URL(endpoint);
  const testHttp = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  return testHttp ? fetch : pinnedProviderFetch;
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? Math.ceil(seconds * 1_000)
    : Date.parse(value) - Date.now();
  return Number.isSafeInteger(delay) && delay >= 0 ? Math.min(delay, 300_000) : undefined;
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error("Provider response exceeded the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Provider response exceeded the size limit");
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function providerErrorPayload(payload: string): { message: string; code?: string } | undefined {
  try {
    const body = JSON.parse(payload) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const error = (body as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
    const fields = error as Record<string, unknown>;
    if (typeof fields.message !== "string" || fields.message.length > 500) return undefined;
    const code = typeof fields.code === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(fields.code)
      ? fields.code
      : undefined;
    return { message: code ? `${fields.message} (${code})` : fields.message, code };
  } catch {
    return undefined;
  }
}

async function requireSuccessfulResponse(
  response: Response,
  expectedContentType: "application/json" | "text/event-stream",
  bodyLimit: number,
): Promise<string | undefined> {
  if (!response.ok) {
    const payload = await readBoundedBody(response, Math.min(bodyLimit, MAX_ERROR_BODY_BYTES));
    const providerError = providerErrorPayload(payload);
    const category = response.status === 429
      ? "rate_limited"
      : response.status >= 400 && response.status < 500
      ? response.status === 401 || response.status === 403 ? "authentication" : "invalid_request"
      : "upstream_unavailable";
    throw new ProviderAttemptError(
      providerError?.message ?? `Provider returned ${response.status}`,
      {
        status: response.status,
        category,
        transient: response.status === 429 || response.status >= 500,
        retryAfterMs: retryAfterMs(response.headers),
        code: providerError?.code,
      },
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith(expectedContentType)) {
    await response.body?.cancel();
    throw new ProviderAttemptError(
      `Provider returned an unexpected content type for a ${
        expectedContentType === "text/event-stream" ? "streaming" : "buffered"
      } request`,
      { category: "invalid_response", transient: true },
    );
  }
  if (expectedContentType === "application/json") return await readBoundedBody(response, bodyLimit);
  if (!response.body) {
    throw new ProviderAttemptError("Provider returned an empty event stream", {
      category: "invalid_response",
      transient: true,
    });
  }
  return undefined;
}

function outputLimit(request: ChatCompletionRequest): number {
  return request.max_completion_tokens ?? request.max_tokens ?? 4_096;
}

function requestInputBound(request: ChatCompletionRequest): number {
  return Math.max(1, encoder.encode(JSON.stringify(request)).byteLength);
}

function visibleResultBytes(result: CanonicalResult): number {
  return encoder.encode([
    result.text,
    result.refusal ?? "",
    result.reasoning?.content ?? "",
    result.reasoning?.summary ?? "",
    ...result.toolCalls.map((call) => `${call.name}${call.arguments}`),
  ].join("")).byteLength;
}

function visibleOutputByteLimit(request: ChatCompletionRequest, responseLimit: number): number {
  return Math.min(responseLimit, outputLimit(request) * MAX_VISIBLE_BYTES_PER_OUTPUT_TOKEN);
}

function validateUsageBounds(
  result: CanonicalResult,
  request: ChatCompletionRequest,
  responseLimit: number,
): void {
  if (visibleResultBytes(result) > visibleOutputByteLimit(request, responseLimit)) {
    throw new Error("Provider output exceeds the requested output bound");
  }
  if (!result.usage) return;
  if (result.usage.inputTokens > requestInputBound(request)) {
    throw new Error("Upstream input token usage exceeds the reserved request bound");
  }
  if (result.usage.outputTokens > outputLimit(request)) {
    throw new Error("Upstream output token usage exceeds the requested output bound");
  }
}

function finishReason(state: CanonicalResult["finishState"]): string {
  switch (state) {
    case "stop":
      return "stop";
    case "length":
    case "incomplete":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      throw new Error(`Provider returned a non-terminal Responses status (${state})`);
  }
}

function chatUsage(result: CanonicalResult): Record<string, unknown> | undefined {
  if (!result.usage) return undefined;
  return {
    prompt_tokens: result.usage.inputTokens,
    completion_tokens: result.usage.outputTokens,
    total_tokens: result.usage.totalTokens,
    prompt_tokens_details: { cached_tokens: result.usage.cachedInputTokens },
    completion_tokens_details: { reasoning_tokens: result.usage.reasoningTokens },
  };
}

function responsesFailure(code: string, message: string): ProviderAttemptError {
  const authentication = new Set([
    "authentication_error",
    "invalid_api_key",
    "invalid_authentication",
  ]).has(code);
  const transient = new Set([
    "rate_limit_exceeded",
    "server_error",
    "overloaded",
    "timeout",
    "temporarily_unavailable",
    "vector_store_timeout",
  ]).has(code);
  const category = authentication
    ? "authentication"
    : code === "rate_limit_exceeded"
    ? "rate_limited"
    : code === "timeout" || code === "vector_store_timeout"
    ? "timeout"
    : transient
    ? "upstream_unavailable"
    : "invalid_response";
  const status = authentication
    ? 401
    : code === "rate_limit_exceeded"
    ? 429
    : new Set(["invalid_prompt", "invalid_request_error"]).has(code)
    ? 400
    : undefined;
  return new ProviderAttemptError(`${message} (${code})`, { category, transient, code, status });
}

/** Rebuild a Responses result as a strict Chat Completion for the gateway's canonical boundary. */
export function responsesResultToChatCompletion(result: CanonicalResult): Record<string, unknown> {
  if (result.error) {
    throw responsesFailure(result.error.code, result.error.message);
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text || result.toolCalls.length || result.refusal ? result.text || null : "",
  };
  if (result.refusal) message.refusal = result.refusal;
  if (result.reasoning?.content) message.reasoning_content = result.reasoning.content;
  if (result.reasoning?.summary) message.reasoning_summary = result.reasoning.summary;
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (result.annotations?.length) {
    message.annotations = result.annotations.map((citation) => ({
      type: "url_citation",
      url_citation: {
        start_index: citation.startIndex,
        end_index: citation.endIndex,
        title: citation.title,
        url: citation.url,
      },
    }));
  }
  return {
    id: result.id,
    object: "chat.completion",
    created: result.createdAt ?? Math.floor(Date.now() / 1_000),
    model: result.model,
    choices: [{ index: 0, message, finish_reason: finishReason(result.finishState) }],
    ...(chatUsage(result) ? { usage: chatUsage(result) } : {}),
  };
}

function responseRequest(
  request: ChatCompletionRequest,
  upstreamModel: string,
  stream: boolean,
  customParams: Readonly<Record<string, unknown>> = {},
  requestFields: NativeResponsesRequestFields = {},
): Record<string, unknown> {
  try {
    const withDefaults = { ...customParams, ...request };
    const translated = {
      ...chatCompletionsRequestToResponses(withDefaults),
      model: upstreamModel,
      stream,
    };
    return {
      ...translated,
      ...(requestFields.store === undefined ? {} : { store: requestFields.store }),
      ...(requestFields.metadata === undefined
        ? {}
        : { metadata: structuredClone(requestFields.metadata) }),
    };
  } catch (error) {
    if (error instanceof ProviderProtocolError) {
      throw new ProviderAttemptError(error.message, {
        category: "invalid_request",
        transient: false,
        candidateLocal: true,
      });
    }
    throw error;
  }
}

export async function completeResponsesChat(
  request: ChatCompletionRequest,
  signal: AbortSignal,
  options: ResponsesUpstreamOptions = {},
): Promise<ResponsesChatCompletion> {
  try {
    signal.throwIfAborted();
    const baseUrl = options.baseUrl ?? Deno.env.get("OPENAI_BASE_URL");
    const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY");
    if (!baseUrl || !apiKey) {
      throw new ProviderAttemptError("The OpenAI-compatible provider is not configured", {
        category: "invalid_request",
        transient: false,
      });
    }
    const upstreamModel = options.upstreamModel ?? request.model;
    const endpoint = responsesEndpoint(baseUrl);
    const combinedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(providerTimeoutMs(options.timeoutMs)),
    ]);
    const response = await responseFetch(endpoint, options)(endpoint, {
      method: "POST",
      signal: combinedSignal,
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        responseRequest(
          request,
          upstreamModel,
          false,
          options.customParams,
          options.requestFields,
        ),
      ),
    });
    const body = await requireSuccessfulResponse(
      response,
      "application/json",
      responseByteLimit(options.maxResponseBytes),
    );
    let payload: unknown;
    try {
      payload = JSON.parse(body!);
    } catch {
      throw new Error("Provider returned malformed JSON");
    }
    const result = normalizeResponsesResult(payload);
    const maxResponseBytes = responseByteLimit(options.maxResponseBytes);
    validateUsageBounds(result, request, maxResponseBytes);
    const upstream = responsesResultToChatCompletion(result);
    const fallbackInput = Math.max(1, Math.ceil(JSON.stringify(request.messages).length / 4));
    const estimatedOutput = Math.min(
      outputLimit(request),
      Math.ceil(visibleResultBytes(result) / 4),
    );
    return {
      text: result.text,
      inputTokens: result.usage?.inputTokens ?? fallbackInput,
      outputTokens: result.usage?.outputTokens ?? estimatedOutput,
      ...(result.usage ? { cachedInputTokens: result.usage.cachedInputTokens } : {}),
      ...(result.usage ? { reasoningTokens: result.usage.reasoningTokens } : {}),
      upstream,
    };
  } catch (error) {
    if (
      signal.aborted || error instanceof ProviderAttemptError ||
      (error instanceof TypeError && !(error instanceof ProviderProtocolError)) ||
      (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
    ) throw error;
    throw new ProviderAttemptError(
      error instanceof Error ? error.message : "Provider returned an invalid Responses result",
      { category: "invalid_response", transient: true },
    );
  }
}

async function* parseResponsesEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes: number,
): AsyncGenerator<CanonicalStreamEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineBytes: number[] = [];
  let pendingCarriageReturn = false;
  let dataLines: string[] = [];
  let dataBytes = 0;
  let received = 0;
  let terminal = false;
  const consistency = new ResponsesStreamConsistency();
  const abortReader = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abortReader, { once: true });
  const dispatch = () => {
    if (!dataLines.length) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    dataBytes = 0;
    let value: unknown = data;
    if (data !== "[DONE]") {
      try {
        value = JSON.parse(data);
      } catch {
        throw new Error("Upstream sent malformed JSON in its Responses event stream");
      }
    }
    const events = normalizeResponsesStreamEvent(value);
    consistency.validate(value);
    consistency.observe(events);
    return { events, doneMarker: data === "[DONE]" };
  };
  let terminalKind: "official" | "marker" | undefined;
  let trailingDone = false;
  const processLine = (line: string): CanonicalStreamEvent[] | undefined => {
    if (line === "") {
      const frame = dispatch();
      if (!frame) return;
      if (terminal) {
        if (terminalKind === "official" && frame.doneMarker && !trailingDone) {
          trailingDone = true;
          return;
        }
        throw new Error("Responses stream sent data after its terminal event");
      }
      terminal = frame.events.some((event) => event.type === "done");
      if (terminal) terminalKind = frame.doneMarker ? "marker" : "official";
      return frame.events;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (field === "data") {
      dataLines.push(fieldValue);
      dataBytes += encoder.encode(fieldValue).byteLength + (dataLines.length > 1 ? 1 : 0);
      if (dataBytes > MAX_SSE_LINE_BYTES) {
        throw new Error("Upstream Responses event exceeded the size limit");
      }
    }
  };
  const completeLine = () => {
    const line = decoder.decode(Uint8Array.from(lineBytes));
    lineBytes = [];
    return processLine(line);
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      received += value?.byteLength ?? 0;
      if (received > maxBytes) throw new Error("Provider response exceeded the size limit");
      for (const byte of value ?? []) {
        if (pendingCarriageReturn) {
          const events = completeLine();
          if (events) yield events;
          pendingCarriageReturn = false;
          if (byte === 10) continue;
        }
        if (byte === 13) {
          pendingCarriageReturn = true;
        } else if (byte === 10) {
          const events = completeLine();
          if (events) yield events;
        } else {
          lineBytes.push(byte);
          if (lineBytes.length > MAX_SSE_LINE_BYTES) {
            throw new Error("Upstream Responses event stream line exceeded the size limit");
          }
        }
      }
      if (!done) continue;
      if (pendingCarriageReturn) {
        const events = completeLine();
        if (events) yield events;
        pendingCarriageReturn = false;
      } else if (lineBytes.length) {
        const events = completeLine();
        if (events) yield events;
      }
      // Dispatch a complete pending event at EOF even if the producer omitted the customary
      // trailing blank line. The normal JSON parser still rejects a genuinely truncated payload.
      if (dataLines.length) {
        const events = processLine("");
        if (events) yield events;
      }
      break;
    }
    if (dataLines.length) throw new Error("Upstream Responses event stream ended mid-frame");
    if (!terminal) {
      throw new Error("Upstream Responses event stream ended without a terminal event");
    }
  } finally {
    signal.removeEventListener("abort", abortReader);
    await reader.cancel(signal.aborted ? signal.reason : undefined).catch(() => undefined);
    reader.releaseLock();
  }
}

function streamChunk(
  event: CanonicalStreamEvent,
  state: {
    id: string;
    model: string;
    started: boolean;
    sawToolCall: boolean;
    toolIndexes: Map<number, number>;
    textPartOffsets: Map<string, number>;
    textLength: number;
    created: number;
  },
): string | undefined {
  if (event.type === "started") {
    state.id = event.id;
    if (event.model) state.model = event.model;
    state.started = true;
    state.created = Math.floor(Date.now() / 1_000);
    return JSON.stringify({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [],
    });
  }
  if (event.type === "error") {
    throw responsesFailure(event.code, event.message);
  }
  if (event.type === "done") return "[DONE]";
  if (!state.started) throw new Error("Responses stream emitted output before response.created");
  const base = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
  };
  if (event.type === "usage") {
    return JSON.stringify({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: event.usage.inputTokens,
        completion_tokens: event.usage.outputTokens,
        total_tokens: event.usage.totalTokens,
        prompt_tokens_details: { cached_tokens: event.usage.cachedInputTokens },
        completion_tokens_details: { reasoning_tokens: event.usage.reasoningTokens },
      },
    });
  }
  const delta: Record<string, unknown> = {};
  let finish_reason: string | null = null;
  if (event.type === "role") delta.role = event.role;
  if (event.type === "text_delta") {
    const key = `${event.outputIndex ?? 0}:${event.contentIndex ?? 0}`;
    if (!state.textPartOffsets.has(key)) state.textPartOffsets.set(key, state.textLength);
    state.textLength += event.text.length;
    delta.content = event.text;
  }
  if (event.type === "refusal_delta") delta.refusal = event.text;
  if (event.type === "reasoning_delta") {
    delta[event.summary ? "reasoning_summary" : "reasoning_content"] = event.text;
  }
  if (event.type === "annotation") {
    const key = `${event.outputIndex ?? 0}:${event.contentIndex ?? 0}`;
    const offset = state.textPartOffsets.get(key) ?? state.textLength;
    state.textPartOffsets.set(key, offset);
    delta.annotations = [{
      type: "url_citation",
      url_citation: {
        start_index: event.annotation.startIndex + offset,
        end_index: event.annotation.endIndex + offset,
        title: event.annotation.title,
        url: event.annotation.url,
      },
    }];
  }
  if (event.type === "tool_call_delta") {
    state.sawToolCall = true;
    let index = state.toolIndexes.get(event.index);
    if (index === undefined) {
      index = state.toolIndexes.size;
      state.toolIndexes.set(event.index, index);
    }
    delta.tool_calls = [{
      index,
      ...(event.id === undefined ? {} : { id: event.id }),
      type: "function",
      function: {
        ...(event.name === undefined ? {} : { name: event.name }),
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
      },
    }];
  }
  if (event.type === "finish") {
    finish_reason = finishReason(
      event.state === "stop" && state.sawToolCall ? "tool_calls" : event.state,
    );
  }
  return JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] });
}

/** Open a native Responses stream and expose strict Chat chunks to the gateway core. */
export async function* streamResponsesChat(
  request: ChatCompletionRequest,
  signal: AbortSignal,
  options: ResponsesUpstreamOptions = {},
): AsyncGenerator<string> {
  try {
    signal.throwIfAborted();
    const baseUrl = options.baseUrl ?? Deno.env.get("OPENAI_BASE_URL");
    const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY");
    if (!baseUrl || !apiKey) {
      throw new ProviderAttemptError("The OpenAI-compatible provider is not configured", {
        category: "invalid_request",
        transient: false,
      });
    }
    const upstreamModel = options.upstreamModel ?? request.model;
    const endpoint = responsesEndpoint(baseUrl);
    const combinedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(providerTimeoutMs(options.timeoutMs)),
    ]);
    const response = await responseFetch(endpoint, options)(endpoint, {
      method: "POST",
      signal: combinedSignal,
      redirect: "error",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        responseRequest(
          request,
          upstreamModel,
          true,
          options.customParams,
          options.requestFields,
        ),
      ),
    });
    await requireSuccessfulResponse(
      response,
      "text/event-stream",
      responseByteLimit(options.maxResponseBytes),
    );
    const state = {
      id: "",
      model: upstreamModel,
      started: false,
      sawToolCall: false,
      toolIndexes: new Map<number, number>(),
      textPartOffsets: new Map<string, number>(),
      textLength: 0,
      created: 0,
    };
    let visibleBytes = 0;
    for await (
      const events of parseResponsesEvents(
        response.body!,
        combinedSignal,
        responseByteLimit(options.maxResponseBytes),
      )
    ) {
      for (const event of events) {
        if (
          event.type === "text_delta" || event.type === "refusal_delta" ||
          event.type === "reasoning_delta"
        ) visibleBytes += encoder.encode(event.text).byteLength;
        if (event.type === "tool_call_delta") {
          visibleBytes += encoder.encode(`${event.name ?? ""}${event.arguments ?? ""}`).byteLength;
        }
        if (event.type === "usage") {
          if (event.usage.inputTokens > requestInputBound(request)) {
            throw new Error("Upstream input token usage exceeds the reserved request bound");
          }
          if (event.usage.outputTokens > outputLimit(request)) {
            throw new Error("Upstream output token usage exceeds the requested output bound");
          }
        }
        if (
          visibleBytes > visibleOutputByteLimit(
            request,
            responseByteLimit(options.maxResponseBytes),
          )
        ) {
          throw new Error("Provider output exceeds the requested output bound");
        }
        const chunk = streamChunk(event, state);
        if (chunk !== undefined) yield chunk;
      }
    }
  } catch (error) {
    if (
      signal.aborted || error instanceof ProviderAttemptError ||
      (error instanceof TypeError && !(error instanceof ProviderProtocolError)) ||
      (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
    ) throw error;
    throw new ProviderAttemptError(
      error instanceof Error ? error.message : "Provider returned an invalid Responses stream",
      { category: "invalid_response", transient: true },
    );
  }
}
