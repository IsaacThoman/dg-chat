import { isSpecialUseIp, pinnedProviderFetch } from "./provider_transport.ts";

export const REALTIME_MAX_EVENT_BYTES = 1_048_576;
export const REALTIME_MAX_HTTP_BODY_BYTES = 2_097_152;
export const REALTIME_MAX_HTTP_RESPONSE_BYTES = 4_194_304;
export const REALTIME_HTTP_TIMEOUT_MS = 30_000;

export type RealtimeCapability =
  | "realtime"
  | "realtime_transcription"
  | "realtime_translation";

export interface RealtimeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
}

export class RealtimeProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RealtimeProtocolError";
  }
}

function safeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function tokenDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Extracts authoritative terminal usage without trusting partial delta events. */
export function realtimeUsage(event: unknown): RealtimeUsage | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const record = event as Record<string, unknown>;
  if (record.type !== "response.done") return undefined;
  const response = tokenDetails(record.response);
  const usage = tokenDetails(response.usage);
  if (Object.keys(usage).length === 0) return undefined;
  const input = tokenDetails(usage.input_token_details);
  const output = tokenDetails(usage.output_token_details);
  return {
    inputTokens: safeInteger(usage.input_tokens),
    cachedInputTokens: safeInteger(input.cached_tokens),
    inputTextTokens: safeInteger(input.text_tokens),
    inputAudioTokens: safeInteger(input.audio_tokens),
    outputTokens: safeInteger(usage.output_tokens),
    outputTextTokens: safeInteger(output.text_tokens),
    outputAudioTokens: safeInteger(output.audio_tokens),
  };
}

export function parseRealtimeEvent(data: string | Uint8Array): Record<string, unknown> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes.byteLength > REALTIME_MAX_EVENT_BYTES) {
    throw new RealtimeProtocolError(
      "event_too_large",
      "Realtime event exceeds the size limit",
      413,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      typeof data === "string" ? data : new TextDecoder("utf-8", {
        fatal: true,
      }).decode(data),
    );
  } catch {
    throw new RealtimeProtocolError("invalid_event", "Realtime event must be valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RealtimeProtocolError("invalid_event", "Realtime event must be a JSON object");
  }
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || event.type.length < 1 || event.type.length > 160) {
    throw new RealtimeProtocolError("invalid_event", "Realtime event type is required");
  }
  if (
    event.event_id !== undefined &&
    (typeof event.event_id !== "string" || event.event_id.length < 1 ||
      event.event_id.length > 256)
  ) {
    throw new RealtimeProtocolError("invalid_event", "Realtime event_id is invalid");
  }
  return event;
}

export function realtimeProviderEndpoint(baseUrl: string, path = "/realtime"): URL {
  const base = new URL(baseUrl);
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || isSpecialUseIp(host);
  const testHost = Deno.env.get("DENO_ENV") === "test" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === host;
  if (
    base.protocol !== "https:" &&
    !(Deno.env.get("DENO_ENV") !== "production" && (privateHost || testHost))
  ) {
    throw new RealtimeProtocolError("invalid_provider", "Provider URL must use HTTPS", 500);
  }
  if (Deno.env.get("DENO_ENV") === "production" && privateHost) {
    throw new RealtimeProtocolError(
      "invalid_provider",
      "Provider URL may not target a private network",
      500,
    );
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new RealtimeProtocolError(
      "invalid_provider",
      "Provider URL must not contain credentials, a query, or a fragment",
      500,
    );
  }
  if (!/^\/realtime(?:\/|$)/.test(path)) {
    throw new RealtimeProtocolError("invalid_path", "Realtime provider path is invalid", 500);
  }
  const endpoint = new URL(base.toString().replace(/\/$/, "") + path);
  return endpoint;
}

function replaceModel(value: unknown, publicModel: string, upstreamModel: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceModel(item, publicModel, upstreamModel));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === "model" && item === publicModel
        ? upstreamModel
        : replaceModel(item, publicModel, upstreamModel),
    ]),
  );
}

/** Rewrites only exact model identifiers; arbitrary instructions and event content stay opaque. */
export function rewriteRealtimeModels(
  value: unknown,
  publicModel: string,
  upstreamModel: string,
): unknown {
  return replaceModel(value, publicModel, upstreamModel);
}

async function boundedResponse(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new RealtimeProtocolError(
      "provider_response_too_large",
      "Provider response exceeded the size limit",
      502,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        throw new RealtimeProtocolError(
          "provider_response_too_large",
          "Provider response exceeded the size limit",
          502,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export interface RealtimeHttpProxyInput {
  baseUrl: string;
  apiKey: string;
  path: string;
  method?: string;
  headers?: HeadersInit;
  body?: Uint8Array;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function bodyBuffer(body: Uint8Array | undefined): ArrayBuffer | undefined {
  if (!body) return undefined;
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}

/** Bounded, redirect-free Realtime REST proxy used after model entitlement resolution. */
export async function proxyRealtimeHttp(input: RealtimeHttpProxyInput): Promise<Response> {
  if ((input.body?.byteLength ?? 0) > REALTIME_MAX_HTTP_BODY_BYTES) {
    throw new RealtimeProtocolError(
      "request_too_large",
      "Realtime request exceeds the size limit",
      413,
    );
  }
  const endpoint = realtimeProviderEndpoint(input.baseUrl, input.path);
  const headers = new Headers(input.headers);
  headers.set("authorization", `Bearer ${input.apiKey}`);
  headers.set("accept-encoding", "identity");
  headers.delete("host");
  headers.delete("content-length");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Realtime provider timed out", "TimeoutError")),
    input.timeoutMs ?? REALTIME_HTTP_TIMEOUT_MS,
  );
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const providerFetch = input.fetch ??
      (endpoint.protocol === "https:" ? pinnedProviderFetch : fetch);
    const response = await providerFetch(endpoint, {
      method: input.method ?? "POST",
      headers,
      body: bodyBuffer(input.body),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new RealtimeProtocolError(
        "provider_redirect",
        "Provider redirects are not allowed",
        502,
      );
    }
    const body = await boundedResponse(response, REALTIME_MAX_HTTP_RESPONSE_BYTES);
    const outputHeaders = new Headers();
    for (const name of ["content-type", "location", "openai-request-id", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    return new Response(bodyBuffer(body), {
      status: response.status,
      statusText: response.statusText,
      headers: outputHeaders,
    });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}
