import { type RawData, WebSocket as NodeWebSocket } from "ws";
import {
  createPinnedLookup,
  isSpecialUseIp,
  pinnedProviderFetch,
  resolvePinnedAddress,
} from "./provider_transport.ts";

export const REALTIME_MAX_EVENT_BYTES = 1_048_576;
export const REALTIME_MAX_HTTP_BODY_BYTES = 2_097_152;
export const REALTIME_MAX_HTTP_RESPONSE_BYTES = 4_194_304;
export const REALTIME_HTTP_TIMEOUT_MS = 30_000;
export const REALTIME_WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
export const REALTIME_MAX_BUFFERED_BYTES = 4_194_304;

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

export interface PreparedRealtimeCall {
  model: string;
  body: Uint8Array;
  contentType: string;
}

async function formText(value: FormDataEntryValue | null, name: string): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof File) return await value.text();
  throw new RealtimeProtocolError("invalid_request", `Realtime call ${name} is required`, 422);
}

/** Parses and re-encodes both official WebRTC call creation request variants. */
export async function prepareRealtimeCall(
  contentType: string,
  body: Uint8Array,
  queryModel?: string,
): Promise<PreparedRealtimeCall> {
  if (body.byteLength > REALTIME_MAX_HTTP_BODY_BYTES) {
    throw new RealtimeProtocolError(
      "request_too_large",
      "Realtime request exceeds the size limit",
      413,
    );
  }
  if (contentType.toLowerCase().startsWith("application/sdp")) {
    if (!queryModel?.trim()) {
      throw new RealtimeProtocolError(
        "model_required",
        "A model query is required when a DG Chat API token submits raw SDP",
        422,
      );
    }
    return { model: queryModel.trim(), body, contentType: "application/sdp" };
  }
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new RealtimeProtocolError(
      "invalid_content_type",
      "Realtime calls require multipart/form-data or application/sdp",
      415,
    );
  }
  const copy = bodyBuffer(body)!;
  let form: FormData;
  try {
    form = await new Request("http://localhost/realtime-call", {
      method: "POST",
      headers: { "content-type": contentType },
      body: copy,
    }).formData();
  } catch {
    throw new RealtimeProtocolError("invalid_request", "Realtime call multipart body is invalid");
  }
  const sessionText = await formText(form.get("session"), "session");
  let session: unknown;
  try {
    session = JSON.parse(sessionText);
  } catch {
    throw new RealtimeProtocolError("invalid_request", "Realtime call session must be valid JSON");
  }
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new RealtimeProtocolError(
      "invalid_request",
      "Realtime call session must be a JSON object",
    );
  }
  const model = (session as Record<string, unknown>).model;
  if (typeof model !== "string" || !model.trim()) {
    throw new RealtimeProtocolError(
      "model_required",
      "Realtime call session.model is required",
      422,
    );
  }
  // Re-encoding normalizes the caller-controlled multipart boundary before provider dispatch.
  const output = new FormData();
  for (const [name, value] of form.entries()) {
    if (name === "session") continue;
    output.append(name, value);
  }
  output.set(
    "session",
    new Blob([JSON.stringify(session)], { type: "application/json" }),
    "session.json",
  );
  const encoded = new Request("http://localhost/realtime-call", { method: "POST", body: output });
  const encodedBody = new Uint8Array(await encoded.arrayBuffer());
  if (encodedBody.byteLength > REALTIME_MAX_HTTP_BODY_BYTES) {
    throw new RealtimeProtocolError(
      "request_too_large",
      "Realtime request exceeds the size limit",
      413,
    );
  }
  return {
    model: model.trim(),
    body: encodedBody,
    contentType: encoded.headers.get("content-type")!,
  };
}

export async function rewriteRealtimeCall(
  prepared: PreparedRealtimeCall,
  upstreamModel: string,
): Promise<PreparedRealtimeCall> {
  if (prepared.contentType === "application/sdp") return prepared;
  const form = await new Request("http://localhost/realtime-call", {
    method: "POST",
    headers: { "content-type": prepared.contentType },
    body: bodyBuffer(prepared.body),
  }).formData();
  const session = JSON.parse(await formText(form.get("session"), "session"));
  form.set(
    "session",
    new Blob([
      JSON.stringify(rewriteRealtimeModels(session, prepared.model, upstreamModel)),
    ], { type: "application/json" }),
    "session.json",
  );
  const encoded = new Request("http://localhost/realtime-call", { method: "POST", body: form });
  return {
    model: prepared.model,
    body: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encoded.headers.get("content-type")!,
  };
}

export interface RealtimeWebSocketConnectInput {
  baseUrl: string;
  apiKey: string;
  upstreamModel?: string;
  callId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RealtimeUpstreamSocket = NodeWebSocket;

/** Opens an authenticated, DNS-pinned, redirect-free provider Realtime WebSocket. */
export async function connectRealtimeWebSocket(
  input: RealtimeWebSocketConnectInput,
): Promise<RealtimeUpstreamSocket> {
  const endpoint = realtimeProviderEndpoint(input.baseUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  if (Boolean(input.upstreamModel) === Boolean(input.callId)) {
    throw new RealtimeProtocolError(
      "invalid_connection",
      "Exactly one Realtime model or call ID is required",
      500,
    );
  }
  if (input.upstreamModel) endpoint.searchParams.set("model", input.upstreamModel);
  else endpoint.searchParams.set("call_id", input.callId!);
  const production = Deno.env.get("DENO_ENV") === "production";
  const pinned = endpoint.protocol === "wss:"
    ? await resolvePinnedAddress(endpoint.hostname, undefined, input.signal)
    : undefined;
  return await new Promise<RealtimeUpstreamSocket>((resolve, reject) => {
    let settled = false;
    const socket = new NodeWebSocket(endpoint, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      followRedirects: false,
      handshakeTimeout: input.timeoutMs ?? REALTIME_WEBSOCKET_CONNECT_TIMEOUT_MS,
      maxPayload: REALTIME_MAX_EVENT_BYTES,
      perMessageDeflate: false,
      ...(pinned
        ? {
          family: pinned.family,
          lookup: createPinnedLookup(pinned),
          servername: endpoint.hostname,
          rejectUnauthorized: true,
        }
        : { rejectUnauthorized: !production }),
    });
    const abort = () => {
      socket.terminate();
      if (!settled) reject(input.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    socket.once("open", () => {
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      resolve(socket);
    });
    socket.once("error", (error) => {
      input.signal?.removeEventListener("abort", abort);
      if (!settled) reject(error);
    });
  });
}

export interface RealtimeRelayOptions {
  publicModel: string;
  upstreamModel: string;
  onServerEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  onClose?: (details: {
    code: number;
    reason: string;
    clientEvents: number;
    serverEvents: number;
  }) => void | Promise<void>;
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const length = data.reduce((total, part) => total + part.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of data) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function closeReason(value: unknown): string {
  return [...String(value ?? "")].filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }).join("").slice(0, 120);
}

/**
 * Relays protocol JSON without Socket.IO framing. Both directions are validated and bounded, model
 * aliases remain private to their side, and slow consumers fail explicitly instead of growing an
 * unbounded process queue.
 */
export function relayRealtimeWebSocket(
  downstream: WebSocket,
  upstream: RealtimeUpstreamSocket,
  options: RealtimeRelayOptions,
): () => void {
  let closed = false;
  let clientEvents = 0;
  let serverEvents = 0;
  let queuedBytes = 0;
  const queuedServerEvents: string[] = [];
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    downstream.removeEventListener("message", fromClient);
    downstream.removeEventListener("open", downstreamOpen);
    downstream.removeEventListener("close", clientClose);
    downstream.removeEventListener("error", clientError);
    upstream.off("message", fromServer);
    upstream.off("close", serverClose);
    upstream.off("error", serverError);
    void options.onClose?.({ code, reason, clientEvents, serverEvents });
  };
  const overloaded = () =>
    downstream.bufferedAmount > REALTIME_MAX_BUFFERED_BYTES ||
    upstream.bufferedAmount > REALTIME_MAX_BUFFERED_BYTES;
  const fail = (code: number, reason: string) => {
    const safeReason = closeReason(reason);
    if (downstream.readyState === WebSocket.OPEN) downstream.close(code, safeReason);
    if (upstream.readyState === NodeWebSocket.OPEN) upstream.close(code, safeReason);
    else if (upstream.readyState !== NodeWebSocket.CLOSED) upstream.terminate();
    finish(code, safeReason);
  };
  const fromClient = (message: MessageEvent) => {
    try {
      if (overloaded()) return fail(1013, "Realtime peer is applying backpressure");
      if (typeof message.data !== "string") {
        return fail(1003, "Realtime events must be JSON text frames");
      }
      const event = parseRealtimeEvent(message.data);
      const rewritten = rewriteRealtimeModels(
        event,
        options.publicModel,
        options.upstreamModel,
      );
      clientEvents += 1;
      upstream.send(JSON.stringify(rewritten));
    } catch (error) {
      fail(error instanceof RealtimeProtocolError ? 1007 : 1011, "Invalid Realtime client event");
    }
  };
  const fromServer = (data: RawData, isBinary: boolean) => {
    try {
      if (overloaded()) return fail(1013, "Realtime peer is applying backpressure");
      if (isBinary) return fail(1003, "Realtime provider sent a binary event");
      const event = parseRealtimeEvent(rawDataBytes(data));
      const rewritten = rewriteRealtimeModels(
        event,
        options.upstreamModel,
        options.publicModel,
      ) as Record<string, unknown>;
      serverEvents += 1;
      const payload = JSON.stringify(rewritten);
      if (downstream.readyState === WebSocket.OPEN) downstream.send(payload);
      else {
        queuedBytes += new TextEncoder().encode(payload).byteLength;
        if (queuedBytes > REALTIME_MAX_BUFFERED_BYTES) {
          return fail(1013, "Realtime client did not become ready");
        }
        queuedServerEvents.push(payload);
      }
      void options.onServerEvent?.(event);
    } catch (error) {
      fail(error instanceof RealtimeProtocolError ? 1007 : 1011, "Invalid Realtime provider event");
    }
  };
  const clientClose = (event: CloseEvent) => {
    const reason = closeReason(event.reason);
    if (upstream.readyState === NodeWebSocket.OPEN) upstream.close(event.code || 1000, reason);
    finish(event.code || 1000, reason);
  };
  const downstreamOpen = () => {
    for (const payload of queuedServerEvents.splice(0)) downstream.send(payload);
    queuedBytes = 0;
  };
  const clientError = () => fail(1011, "Realtime client transport failed");
  const serverClose = (code: number, reason: Buffer) => {
    const safeReason = closeReason(reason.toString("utf8"));
    if (downstream.readyState === WebSocket.OPEN) downstream.close(code || 1011, safeReason);
    finish(code || 1011, safeReason);
  };
  const serverError = () => fail(1011, "Realtime provider transport failed");
  downstream.addEventListener("message", fromClient);
  downstream.addEventListener("open", downstreamOpen);
  downstream.addEventListener("close", clientClose);
  downstream.addEventListener("error", clientError);
  upstream.on("message", fromServer);
  upstream.on("close", serverClose);
  upstream.on("error", serverError);
  return () => fail(1001, "Realtime server is shutting down");
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
