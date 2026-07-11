import { pinnedProviderFetch } from "./provider_transport.ts";

export const AUDIO_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const AUDIO_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const AUDIO_MAX_AUXILIARY_BYTES = 8 * 1024 * 1024;

export type AudioEndpoint = "transcriptions" | "translations";
export type AudioResponseFormat =
  | "diarized_json"
  | "json"
  | "text"
  | "srt"
  | "verbose_json"
  | "vtt";

export interface AudioServerVadChunkingStrategy {
  type: "server_vad";
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
}

export type AudioChunkingStrategy = "auto" | AudioServerVadChunkingStrategy;

export interface AudioRequest {
  model: string;
  file: Uint8Array;
  filename: string;
  mime: string;
  fileSha256: string;
  language?: string;
  prompt?: string;
  responseFormat: AudioResponseFormat;
  stream?: boolean;
  include?: Array<"logprobs">;
  chunkingStrategy?: AudioChunkingStrategy;
  knownSpeakerNames?: string[];
  knownSpeakerReferences?: string[];
  temperature?: number;
  timestampGranularities?: Array<"word" | "segment">;
}

export interface AudioProviderResponse {
  body?: Uint8Array;
  stream?: AsyncIterable<Uint8Array>;
  /** Streaming terminal event, withheld until request accounting is durable. */
  terminalFrame?: Promise<Uint8Array>;
  contentType: string;
  usage?: Promise<AudioProviderUsage>;
}

export interface AudioProviderUsage {
  inputTokens: number;
  outputTokens: number;
  source: "estimated" | "provider_duration" | "provider_tokens";
  durationSeconds?: number;
}

export class AudioProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "provider_error",
    readonly providerStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AudioProviderError";
  }
}

const encoder = new TextEncoder();

export function estimateAudioInputTokens(request: Pick<AudioRequest, "file" | "prompt">): number {
  const promptBytes = request.prompt === undefined ? 0 : encoder.encode(request.prompt).byteLength;
  return Math.min(Number.MAX_SAFE_INTEGER, request.file.byteLength + promptBytes);
}

function audioEndpoint(baseUrl: string, endpoint: AudioEndpoint): URL {
  const url = new URL(baseUrl);
  const testHost = Deno.env.get("DENO_ENV") === "test" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" || url.username || url.password || url.hash || url.search
  ) {
    throw new AudioProviderError("Provider base URL is invalid", 500, "provider_config_error");
  }
  // Persisted provider URLs remain production-safe HTTPS. Contract tests may downgrade exactly
  // one explicitly allowlisted in-network hostname, matching chat and embeddings transports.
  if (testHost) url.protocol = "http:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/audio/${endpoint}`;
  return url;
}

function quoted(value: string): string {
  return value.replace(
    /[\r\n"\\]/g,
    (character) => character === "\\" ? "\\\\" : character === '"' ? '\\"' : "_",
  );
}

/** Creates a fresh, bounded multipart body for every retry/fallback attempt. */
export function serializeAudioMultipart(request: AudioRequest, upstreamModel: string): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = `dg-chat-${crypto.randomUUID()}`;
  const chunks: Uint8Array[] = [];
  const text = (name: string, value: string) =>
    chunks.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  text("model", upstreamModel);
  if (request.language !== undefined) text("language", request.language);
  if (request.prompt !== undefined) text("prompt", request.prompt);
  text("response_format", request.responseFormat);
  if (request.temperature !== undefined) text("temperature", String(request.temperature));
  for (const value of request.timestampGranularities ?? []) {
    text("timestamp_granularities[]", value);
  }
  if (request.stream !== undefined) text("stream", String(request.stream));
  for (const value of request.include ?? []) text("include[]", value);
  if (request.chunkingStrategy !== undefined) {
    text(
      "chunking_strategy",
      typeof request.chunkingStrategy === "string"
        ? request.chunkingStrategy
        : JSON.stringify(request.chunkingStrategy),
    );
  }
  for (const value of request.knownSpeakerNames ?? []) text("known_speaker_names[]", value);
  for (const value of request.knownSpeakerReferences ?? []) {
    text("known_speaker_references[]", value);
  }
  chunks.push(encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${
      quoted(request.filename)
    }"\r\nContent-Type: ${request.mime}\r\n\r\n`,
  ));
  chunks.push(request.file);
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (size > AUDIO_MAX_FILE_BYTES + AUDIO_MAX_AUXILIARY_BYTES + 128 * 1024) {
    throw new AudioProviderError(
      "Audio multipart request exceeds the size limit",
      413,
      "audio_too_large",
    );
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > AUDIO_MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AudioProviderError("Audio provider response exceeds the size limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AUDIO_MAX_RESPONSE_BYTES) {
        throw new AudioProviderError("Audio provider response exceeds the size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function audioUsage(value: unknown): AudioProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (usage === undefined) return undefined;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new AudioProviderError("Audio provider returned malformed usage");
  }
  const record = usage as Record<string, unknown>;
  if (record.type === "duration" || record.seconds !== undefined) {
    if (
      record.type !== "duration" || typeof record.seconds !== "number" ||
      !Number.isSafeInteger(record.seconds) || record.seconds < 0
    ) throw new AudioProviderError("Audio provider returned malformed usage");
    return {
      inputTokens: 0,
      outputTokens: 0,
      source: "provider_duration",
      durationSeconds: record.seconds,
    };
  }
  if (record.type !== undefined && record.type !== "tokens") {
    throw new AudioProviderError("Audio provider returned malformed usage");
  }
  const validCount = (input: unknown) =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
  if (!validCount(record.input_tokens) || !validCount(record.output_tokens)) {
    throw new AudioProviderError("Audio provider returned malformed usage");
  }
  const inputTokens = Number(record.input_tokens);
  const outputTokens = Number(record.output_tokens);
  if (
    record.total_tokens !== undefined &&
    (!validCount(record.total_tokens) || Number(record.total_tokens) !== inputTokens + outputTokens)
  ) {
    throw new AudioProviderError("Audio provider returned malformed usage");
  }
  return { inputTokens, outputTokens, source: "provider_tokens" };
}

const estimatedAudioUsage = (text: string, inputTokens: number): AudioProviderUsage => ({
  inputTokens,
  outputTokens: Math.ceil(text.length / 4),
  source: "estimated",
});

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  let milliseconds: number;
  if (/^\d+(?:\.\d+)?$/.test(raw)) milliseconds = Math.ceil(Number(raw) * 1_000);
  else milliseconds = Math.max(0, Date.parse(raw) - Date.now());
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 86_400_000
    ? milliseconds
    : undefined;
}

function transcriptionSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  estimatedInputTokens: number,
): { stream: AsyncIterable<Uint8Array>; usage: Promise<AudioProviderUsage> } {
  let resolveUsage!: (usage: AudioProviderUsage) => void;
  let rejectUsage!: (error: unknown) => void;
  const usage = new Promise<AudioProviderUsage>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });
  // A downstream disconnect may abandon iteration before its caller awaits usage. Keep the
  // cancellation rejection observable to callers without creating a process-level rejection.
  void usage.catch(() => undefined);
  const stream = (async function* () {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    let total = 0;
    let usageSettled = false;
    let terminalSeen = false;
    let terminalUsage: AudioProviderUsage | undefined;
    const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > AUDIO_MAX_RESPONSE_BYTES) {
          throw new AudioProviderError("Audio provider response exceeds the size limit");
        }
        buffered += decoder.decode(value, { stream: true });
        if (buffered.length > 512 * 1024 && !/\r?\n\r?\n/.test(buffered)) {
          throw new AudioProviderError("Audio provider SSE event exceeds the size limit");
        }
        while (true) {
          const match = /\r?\n\r?\n/.exec(buffered);
          if (!match) break;
          const raw = buffered.slice(0, match.index);
          buffered = buffered.slice(match.index + match[0].length);
          if (!raw.trim()) continue;
          const fields = new Map<string, string[]>();
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith(":")) continue;
            const separator = line.indexOf(":");
            const name = separator < 0 ? line : line.slice(0, separator);
            const value = (separator < 0 ? "" : line.slice(separator + 1)).replace(/^ /, "");
            if (!new Set(["data", "event", "id", "retry"]).has(name)) {
              throw new AudioProviderError("Audio provider returned invalid SSE");
            }
            const values = fields.get(name) ?? [];
            values.push(value);
            fields.set(name, values);
          }
          if (!fields.size) continue;
          const dataFields = fields.get("data");
          if (!dataFields?.length) {
            throw new AudioProviderError("Audio provider returned invalid SSE");
          }
          for (const singleton of ["event", "id", "retry"]) {
            if ((fields.get(singleton)?.length ?? 0) > 1) {
              throw new AudioProviderError("Audio provider returned invalid SSE");
            }
          }
          const id = fields.get("id")?.[0];
          if (id !== undefined && (id.length > 256 || id.includes("\0"))) {
            throw new AudioProviderError("Audio provider returned invalid SSE id");
          }
          const retry = fields.get("retry")?.[0];
          if (retry !== undefined && (!/^\d+$/.test(retry) || Number(retry) > 60_000)) {
            throw new AudioProviderError("Audio provider returned invalid SSE retry");
          }
          const data = dataFields.join("\n");
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            throw new AudioProviderError("Audio provider returned invalid SSE JSON");
          }
          if (!event || typeof event !== "object") {
            throw new AudioProviderError("Audio provider returned invalid SSE event");
          }
          const type = (event as { type?: unknown }).type;
          if (
            type !== "transcript.text.delta" && type !== "transcript.text.done" &&
            type !== "transcript.text.segment"
          ) {
            throw new AudioProviderError("Audio provider returned an unsupported SSE event");
          }
          const textField = type === "transcript.text.delta" ? "delta" : "text";
          if (typeof (event as Record<string, unknown>)[textField] !== "string") {
            throw new AudioProviderError(
              `Audio provider ${type} event is missing a string ${textField}`,
            );
          }
          const eventName = fields.get("event")?.[0];
          if (eventName !== undefined && eventName !== type) {
            throw new AudioProviderError("Audio provider SSE event field does not match its type");
          }
          if (terminalSeen) {
            throw new AudioProviderError("Audio provider returned an event after terminal done");
          }
          if (type === "transcript.text.done") {
            terminalSeen = true;
            terminalUsage = audioUsage(event) ?? estimatedAudioUsage(
              typeof (event as { text?: unknown }).text === "string"
                ? (event as { text: string }).text
                : "",
              estimatedInputTokens,
            );
          }
          yield encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) {
        throw new AudioProviderError("Audio provider returned incomplete SSE");
      }
      if (!terminalSeen) {
        throw new AudioProviderError("Audio provider stream ended without terminal done");
      }
      usageSettled = true;
      resolveUsage(terminalUsage ?? estimatedAudioUsage("", estimatedInputTokens));
    } catch (error) {
      usageSettled = true;
      rejectUsage(error);
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      if (!usageSettled) {
        rejectUsage(new DOMException("Audio stream consumer disconnected", "AbortError"));
        await reader.cancel("Audio stream consumer disconnected").catch(() => undefined);
      }
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  })();
  return { stream, usage };
}

export async function createAudioTranscription(
  endpoint: AudioEndpoint,
  request: AudioRequest,
  options: {
    baseUrl: string;
    apiKey: string;
    upstreamModel: string;
    signal: AbortSignal;
    fetch?: typeof fetch;
  },
): Promise<AudioProviderResponse> {
  options.signal.throwIfAborted();
  const url = audioEndpoint(options.baseUrl, endpoint);
  const testHttp = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  const multipart = serializeAudioMultipart(request, options.upstreamModel);
  const response = await (options.fetch ?? (testHttp ? fetch : pinnedProviderFetch))(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": multipart.contentType,
      accept: request.stream
        ? "text/event-stream"
        : request.responseFormat === "json" || request.responseFormat === "verbose_json" ||
            request.responseFormat === "diarized_json"
        ? "application/json"
        : "text/plain",
    },
    body: multipart.body as unknown as BodyInit,
    redirect: "error",
    signal: options.signal,
  });
  if (!response.ok) {
    await boundedBytes(response).catch(() => undefined);
    throw new AudioProviderError(
      "Audio provider request failed",
      response.status >= 500 || response.status === 429 ? 502 : 400,
      "provider_error",
      response.status,
      retryAfterMs(response),
    );
  }
  if (request.stream) {
    if (!response.body) throw new AudioProviderError("Audio provider returned an empty response");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "text/event-stream") {
      await response.body.cancel();
      throw new AudioProviderError("Audio provider did not return an SSE stream");
    }
    const parsed = transcriptionSse(
      response.body,
      options.signal,
      estimateAudioInputTokens(request),
    );
    return { contentType: "text/event-stream", ...parsed };
  }
  const body = await boundedBytes(response);
  if (!body.byteLength) throw new AudioProviderError("Audio provider returned an empty response");
  // The response format is validated by this gateway. Never reflect an arbitrary upstream MIME
  // (notably text/html) into a browser response or durable replay.
  const contentType = request.stream
    ? "text/event-stream"
    : request.responseFormat === "json" || request.responseFormat === "verbose_json" ||
        request.responseFormat === "diarized_json"
    ? "application/json"
    : request.responseFormat === "vtt"
    ? "text/vtt"
    : "text/plain";
  let responseText = "";
  if (request.stream) {
    // Streaming bodies are validated below by the bounded SSE parser before they are returned.
  } else if (
    request.responseFormat === "json" || request.responseFormat === "verbose_json" ||
    request.responseFormat === "diarized_json"
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new AudioProviderError("Audio provider returned invalid JSON");
    }
    if (
      !parsed || typeof parsed !== "object" ||
      typeof (parsed as { text?: unknown }).text !== "string"
    ) {
      throw new AudioProviderError("Audio provider response is missing text");
    }
    responseText = (parsed as { text: string }).text;
  } else {
    try {
      responseText = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new AudioProviderError("Audio provider returned invalid UTF-8 text");
    }
  }
  let usage: AudioProviderUsage | undefined;
  if (contentType === "application/json") {
    usage = audioUsage(JSON.parse(new TextDecoder().decode(body)));
  }
  return {
    body,
    contentType,
    usage: Promise.resolve(
      usage ?? estimatedAudioUsage(responseText, estimateAudioInputTokens(request)),
    ),
  };
}
