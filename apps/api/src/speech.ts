import type { UsagePricingSnapshot } from "@dg-chat/database";
import { pinnedProviderFetch } from "./provider_transport.ts";

export const SPEECH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export type SpeechResponseFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
export type SpeechStreamFormat = "audio" | "sse";
export type SpeechVoice = string | { id: string };

export interface SpeechRequest {
  model: string;
  input: string;
  voice: SpeechVoice;
  instructions?: string;
  responseFormat: SpeechResponseFormat;
  speed: number;
  streamFormat: SpeechStreamFormat;
}

export interface SpeechProviderUsage {
  inputTokens: number;
  outputTokens: number;
  source: "estimated" | "provider_tokens";
}

export interface SpeechProviderResponse {
  body?: Uint8Array;
  stream?: AsyncIterable<Uint8Array>;
  /** Streaming terminal event, withheld until customer accounting is durable. */
  terminalFrame?: Promise<Uint8Array>;
  contentType: string;
  usage: SpeechProviderUsage | Promise<SpeechProviderUsage>;
}

export class SpeechProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "provider_error",
    readonly providerStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SpeechProviderError";
  }
}

const formats = new Set<SpeechResponseFormat>(["mp3", "opus", "aac", "flac", "wav", "pcm"]);
const streams = new Set<SpeechStreamFormat>(["audio", "sse"]);
function validIdentifier(value: string): boolean {
  if (scalarLength(value) < 1 || scalarLength(value) > 200) return false;
  return [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code > 0x1f && code !== 0x7f;
  });
}

function scalarLength(value: string): number {
  return [...value].length;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || scalarLength(value) < 1 || scalarLength(value) > maximum) {
    throw new SpeechProviderError(
      `${field} must contain between 1 and ${maximum} characters`,
      422,
      "validation_error",
    );
  }
  return value;
}

/** Strictly validates and normalizes the OpenAI speech JSON domain object. */
export function parseSpeechRequest(value: unknown): SpeechRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpeechProviderError("Speech request must be a JSON object", 422, "validation_error");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "model",
    "input",
    "voice",
    "instructions",
    "response_format",
    "speed",
    "stream_format",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new SpeechProviderError(
      "Speech request contains unsupported fields",
      422,
      "validation_error",
    );
  }
  const model = boundedText(body.model, "model", 200);
  if (!validIdentifier(model)) {
    throw new SpeechProviderError("model contains invalid characters", 422, "validation_error");
  }
  const input = boundedText(body.input, "input", 4_096);
  let voice: SpeechVoice;
  if (typeof body.voice === "string") {
    voice = boundedText(body.voice, "voice", 200);
    if (!validIdentifier(voice)) {
      throw new SpeechProviderError("voice contains invalid characters", 422, "validation_error");
    }
  } else if (body.voice && typeof body.voice === "object" && !Array.isArray(body.voice)) {
    const candidate = body.voice as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => key !== "id")) {
      throw new SpeechProviderError(
        "Custom voice contains unsupported fields",
        422,
        "validation_error",
      );
    }
    const id = boundedText(candidate.id, "voice.id", 200);
    if (!validIdentifier(id)) {
      throw new SpeechProviderError(
        "voice.id contains invalid characters",
        422,
        "validation_error",
      );
    }
    voice = { id };
  } else {
    throw new SpeechProviderError("voice is required", 422, "validation_error");
  }
  const instructions = body.instructions === undefined
    ? undefined
    : boundedText(body.instructions, "instructions", 4_096);
  const responseFormat = body.response_format ?? "mp3";
  if (typeof responseFormat !== "string" || !formats.has(responseFormat as SpeechResponseFormat)) {
    throw new SpeechProviderError("response_format is invalid", 422, "validation_error");
  }
  const streamFormat = body.stream_format ?? "audio";
  if (typeof streamFormat !== "string" || !streams.has(streamFormat as SpeechStreamFormat)) {
    throw new SpeechProviderError("stream_format is invalid", 422, "validation_error");
  }
  const speed = body.speed ?? 1;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw new SpeechProviderError("speed must be between 0.25 and 4", 422, "validation_error");
  }
  return {
    model,
    input,
    voice,
    ...(instructions === undefined ? {} : { instructions }),
    responseFormat: responseFormat as SpeechResponseFormat,
    speed,
    streamFormat: streamFormat as SpeechStreamFormat,
  };
}

export function estimateSpeechInputTokens(
  request: Pick<SpeechRequest, "input" | "instructions">,
): number {
  const bytes =
    new TextEncoder().encode(`${request.input}${request.instructions ?? ""}`).byteLength;
  return Math.max(1, Math.ceil(bytes / 4));
}

/** Raw speech has no portable usage metadata, so its initial pricing contract is fixed-call-only. */
export function assertSpeechFixedPricing(pricing: UsagePricingSnapshot): void {
  if (
    pricing.fixedCallMicros <= 0 || pricing.inputMicrosPerMillion !== 0 ||
    pricing.cachedInputMicrosPerMillion !== 0 || pricing.reasoningMicrosPerMillion !== 0 ||
    pricing.outputMicrosPerMillion !== 0
  ) {
    throw new SpeechProviderError(
      "Speech models require fixed-call-only pricing",
      500,
      "unsupported_speech_pricing",
    );
  }
}

function endpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const testHost = Deno.env.get("DENO_ENV") === "test" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new SpeechProviderError("Provider base URL is invalid", 500, "provider_config_error");
  }
  if (testHost) url.protocol = "http:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/audio/speech`;
  return url;
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(raw)
    ? Math.ceil(Number(raw) * 1_000)
    : Math.max(0, Date.parse(raw) - Date.now());
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 86_400_000
    ? milliseconds
    : undefined;
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > SPEECH_MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new SpeechProviderError("Speech provider response exceeds the size limit");
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
      if (size > SPEECH_MAX_RESPONSE_BYTES) {
        throw new SpeechProviderError("Speech provider response exceeds the size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const contentTypes: Record<SpeechResponseFormat, readonly string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"],
  opus: ["audio/ogg", "audio/opus"],
  aac: ["audio/aac", "audio/aacp"],
  flac: ["audio/flac", "audio/x-flac"],
  wav: ["audio/wav", "audio/x-wav"],
  pcm: ["audio/pcm", "audio/L16", "application/octet-stream"],
};

const publicContentTypes: Record<SpeechResponseFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "application/octet-stream",
};

function hasAscii(body: Uint8Array, offset: number, expected: string): boolean {
  if (offset + expected.length > body.length) return false;
  return [...expected].every((character, index) =>
    body[offset + index] === character.charCodeAt(0)
  );
}

function validSignature(format: SpeechResponseFormat, body: Uint8Array): boolean {
  if (!body.byteLength) return false;
  if (format === "pcm") return body.byteLength % 2 === 0;
  if (format === "wav") return hasAscii(body, 0, "RIFF") && hasAscii(body, 8, "WAVE");
  if (format === "flac") return hasAscii(body, 0, "fLaC");
  if (format === "opus") {
    if (!hasAscii(body, 0, "OggS")) return false;
    const prefix = new TextDecoder("latin1").decode(body.subarray(0, Math.min(body.length, 128)));
    return prefix.includes("OpusHead");
  }
  if (format === "aac") {
    return body.length >= 2 && body[0] === 0xff && (body[1] & 0xf6) === 0xf0;
  }
  let offset = 0;
  if (hasAscii(body, 0, "ID3")) {
    if (
      body.length < 14 || body[3] < 2 || body[3] > 4 ||
      [body[6], body[7], body[8], body[9]].some((part) => (part & 0x80) !== 0)
    ) return false;
    const tagSize = (body[6] << 21) | (body[7] << 14) | (body[8] << 7) | body[9];
    offset = 10 + tagSize + ((body[5] & 0x10) !== 0 ? 10 : 0);
    if (offset + 4 > body.length) return false;
  }
  if (body[offset] !== 0xff || (body[offset + 1] & 0xe0) !== 0xe0) return false;
  const version = (body[offset + 1] >> 3) & 0x03;
  const layer = (body[offset + 1] >> 1) & 0x03;
  const bitrate = (body[offset + 2] >> 4) & 0x0f;
  const sampleRate = (body[offset + 2] >> 2) & 0x03;
  return version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3;
}

function decodedAudio(value: unknown): Uint8Array {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 1_048_576 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) throw new SpeechProviderError("Speech provider returned invalid Base64 audio");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new SpeechProviderError("Speech provider returned invalid Base64 audio");
  }
  if (btoa(binary) !== value) {
    throw new SpeechProviderError("Speech provider returned non-canonical Base64 audio");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function tokenUsage(value: unknown): SpeechProviderUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpeechProviderError("Speech provider returned malformed usage");
  }
  const usage = value as Record<string, unknown>;
  if (
    Object.keys(usage).some((key) =>
      !["input_tokens", "output_tokens", "total_tokens"].includes(key)
    )
  ) {
    throw new SpeechProviderError("Speech provider returned malformed usage");
  }
  const valid = (part: unknown): part is number =>
    typeof part === "number" && Number.isSafeInteger(part) && part >= 0;
  if (!valid(usage.input_tokens) || !valid(usage.output_tokens) || !valid(usage.total_tokens)) {
    throw new SpeechProviderError("Speech provider returned malformed usage");
  }
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    throw new SpeechProviderError("Speech provider returned malformed usage");
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    source: "provider_tokens",
  };
}

export function speechFrameDecodedBytes(frame: Uint8Array): number {
  let event: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    const data = text.trim().replace(/^data:\s*/, "");
    event = JSON.parse(data);
  } catch {
    return 0;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return 0;
  const record = event as Record<string, unknown>;
  if (record.type !== "speech.audio.delta") return 0;
  try {
    return decodedAudio(record.audio).byteLength;
  } catch {
    return 0;
  }
}

function speechSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): {
  stream: AsyncIterable<Uint8Array>;
  usage: Promise<SpeechProviderUsage>;
  terminalFrame: Promise<Uint8Array>;
} {
  let resolveUsage!: (usage: SpeechProviderUsage) => void;
  let rejectUsage!: (error: unknown) => void;
  let resolveTerminal!: (frame: Uint8Array) => void;
  let rejectTerminal!: (error: unknown) => void;
  const usage = new Promise<SpeechProviderUsage>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });
  const terminalFrame = new Promise<Uint8Array>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  void usage.catch(() => undefined);
  void terminalFrame.catch(() => undefined);
  const stream = (async function* () {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    let wireBytes = 0;
    let audioBytes = 0;
    let terminalSeen = false;
    let settled = false;
    const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
    signal.addEventListener("abort", abort, { once: true });
    const processEvent = (raw: string): { frame?: Uint8Array; done?: true } => {
      if (!raw.trim() || raw.split(/\r?\n/).every((line) => !line || line.startsWith(":"))) {
        return {};
      }
      const fields = new Map<string, string[]>();
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const name = separator < 0 ? line : line.slice(0, separator);
        const value = (separator < 0 ? "" : line.slice(separator + 1)).replace(/^ /, "");
        if (!["data", "event", "id", "retry"].includes(name)) {
          throw new SpeechProviderError("Speech provider returned invalid SSE");
        }
        const values = fields.get(name) ?? [];
        values.push(value);
        fields.set(name, values);
      }
      const data = fields.get("data");
      if (!data?.length) throw new SpeechProviderError("Speech provider returned invalid SSE");
      for (const singleton of ["event", "id", "retry"]) {
        if ((fields.get(singleton)?.length ?? 0) > 1) {
          throw new SpeechProviderError("Speech provider returned duplicate SSE metadata");
        }
      }
      const id = fields.get("id")?.[0];
      if (id !== undefined && (id.length > 256 || id.includes("\0"))) {
        throw new SpeechProviderError("Speech provider returned invalid SSE id");
      }
      const retry = fields.get("retry")?.[0];
      if (retry !== undefined && (!/^\d+$/.test(retry) || Number(retry) > 60_000)) {
        throw new SpeechProviderError("Speech provider returned invalid SSE retry");
      }
      let value: unknown;
      try {
        value = JSON.parse(data.join("\n"));
      } catch {
        throw new SpeechProviderError("Speech provider returned invalid SSE JSON");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SpeechProviderError("Speech provider returned invalid SSE event");
      }
      const event = value as Record<string, unknown>;
      const eventName = fields.get("event")?.[0];
      if (eventName !== undefined && eventName !== event.type) {
        throw new SpeechProviderError("Speech provider SSE event name does not match its type");
      }
      if (event.type === "speech.audio.delta") {
        if (terminalSeen || Object.keys(event).some((key) => !["type", "audio"].includes(key))) {
          throw new SpeechProviderError("Speech provider returned invalid audio delta");
        }
        const decoded = decodedAudio(event.audio);
        audioBytes += decoded.byteLength;
        if (audioBytes > SPEECH_MAX_RESPONSE_BYTES) {
          throw new SpeechProviderError("Speech provider response exceeds the size limit");
        }
        return {
          frame: new TextEncoder().encode(
            `data: ${JSON.stringify({ type: event.type, audio: event.audio })}\n\n`,
          ),
        };
      }
      if (event.type === "speech.audio.done") {
        if (terminalSeen || Object.keys(event).some((key) => !["type", "usage"].includes(key))) {
          throw new SpeechProviderError("Speech provider returned invalid terminal event");
        }
        if (audioBytes === 0) throw new SpeechProviderError("Speech provider returned no audio");
        terminalSeen = true;
        const observed = tokenUsage(event.usage);
        const terminal = new TextEncoder().encode(`data: ${
          JSON.stringify({
            type: event.type,
            usage: {
              input_tokens: observed.inputTokens,
              output_tokens: observed.outputTokens,
              total_tokens: observed.inputTokens + observed.outputTokens,
            },
          })
        }\n\n`);
        resolveUsage(observed);
        resolveTerminal(terminal);
        settled = true;
        return { done: true };
      }
      throw new SpeechProviderError("Speech provider returned an unknown SSE event");
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        wireBytes += value.byteLength;
        if (wireBytes > SPEECH_MAX_RESPONSE_BYTES) {
          throw new SpeechProviderError("Speech provider response exceeds the size limit");
        }
        buffered += decoder.decode(value, { stream: true });
        if (buffered.length > 1_048_576 && !/\r?\n\r?\n/.test(buffered)) {
          throw new SpeechProviderError("Speech provider SSE event exceeds the size limit");
        }
        while (true) {
          const boundary = /\r?\n\r?\n/.exec(buffered);
          if (!boundary) break;
          const raw = buffered.slice(0, boundary.index);
          buffered = buffered.slice(boundary.index + boundary[0].length);
          const result = processEvent(raw);
          if (result.frame) yield result.frame;
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) {
        throw new SpeechProviderError("Speech provider returned truncated SSE");
      }
      if (!terminalSeen) throw new SpeechProviderError("Speech provider terminal event is missing");
    } catch (error) {
      if (!settled) {
        rejectUsage(error);
        rejectTerminal(error);
        settled = true;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      if (!settled) {
        const error = new DOMException("Speech stream consumer disconnected", "AbortError");
        rejectUsage(error);
        rejectTerminal(error);
      }
    }
  })();
  return { stream, usage, terminalFrame };
}

export async function createSpeech(
  request: SpeechRequest,
  options: {
    baseUrl: string;
    apiKey: string;
    upstreamModel: string;
    signal: AbortSignal;
    fetch?: typeof fetch;
  },
): Promise<SpeechProviderResponse> {
  options.signal.throwIfAborted();
  const url = endpoint(options.baseUrl);
  const testHttp = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  const response = await (options.fetch ?? (testHttp ? fetch : pinnedProviderFetch))(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      accept: request.streamFormat === "sse"
        ? "text/event-stream"
        : contentTypes[request.responseFormat][0],
    },
    body: JSON.stringify({
      model: options.upstreamModel,
      input: request.input,
      voice: request.voice,
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      response_format: request.responseFormat,
      speed: request.speed,
      stream_format: request.streamFormat,
    }),
    redirect: "error",
    signal: options.signal,
  });
  if (!response.ok) {
    await boundedBytes(response).catch(() => undefined);
    throw new SpeechProviderError(
      "Speech provider request failed",
      response.status >= 500 || response.status === 429 ? 502 : 400,
      "provider_error",
      response.status,
      retryAfter(response),
    );
  }
  if (request.streamFormat === "sse") {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "text/event-stream" || !response.body) {
      await response.body?.cancel();
      throw new SpeechProviderError("Speech provider did not return an SSE stream");
    }
    return { contentType: "text/event-stream", ...speechSse(response.body, options.signal) };
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
  if (
    !contentType ||
    !contentTypes[request.responseFormat].some((type) =>
      type.toLowerCase() === contentType.toLowerCase()
    )
  ) {
    await response.body?.cancel();
    throw new SpeechProviderError("Speech provider returned an unexpected content type");
  }
  const body = await boundedBytes(response);
  if (!validSignature(request.responseFormat, body)) {
    throw new SpeechProviderError("Speech provider returned invalid audio data");
  }
  return {
    body,
    contentType: publicContentTypes[request.responseFormat],
    usage: {
      inputTokens: estimateSpeechInputTokens(request),
      outputTokens: 0,
      source: "estimated",
    },
  };
}
