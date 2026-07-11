export const SPEECH_RESPONSE_FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const;
export type SpeechResponseFormat = (typeof SPEECH_RESPONSE_FORMATS)[number];

export interface SpeechInput {
  model: string;
  input: string;
  voice: string;
  responseFormat?: SpeechResponseFormat;
  speed?: number;
  signal?: AbortSignal;
}

export class SpeechApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "SpeechApiError";
  }
}

const MIME_BY_FORMAT: Record<SpeechResponseFormat, readonly string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"],
  opus: ["audio/ogg", "audio/opus", "application/ogg"],
  aac: ["audio/aac", "audio/mp4", "audio/x-m4a"],
  flac: ["audio/flac", "audio/x-flac"],
  wav: ["audio/wav", "audio/wave", "audio/x-wav"],
  pcm: ["audio/pcm", "audio/L16", "application/octet-stream"],
};

const normalizedContentType = (value: string | null) =>
  value?.split(";", 1)[0].trim().toLowerCase() ?? "";

async function boundedErrorBody(response: Response): Promise<unknown> {
  const limit = 32 * 1024;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

async function speechError(response: Response): Promise<SpeechApiError> {
  const fallback = `Speech generation failed (${response.status}).`;
  if (normalizedContentType(response.headers.get("content-type")) !== "application/json") {
    return new SpeechApiError(response.status, "speech_failed", fallback);
  }
  try {
    const body = await boundedErrorBody(response) as
      | { error?: { code?: unknown; message?: unknown } }
      | undefined;
    const code = typeof body?.error?.code === "string" && body.error.code.length <= 120
      ? body.error.code
      : "speech_failed";
    const message = typeof body?.error?.message === "string" && body.error.message.length <= 500
      ? body.error.message
      : fallback;
    return new SpeechApiError(response.status, code, message);
  } catch {
    return new SpeechApiError(response.status, "speech_failed", fallback);
  }
}

export async function createSpeech(input: SpeechInput): Promise<Blob> {
  const format = input.responseFormat ?? "mp3";
  if (!input.model.trim() || !input.input.trim() || !input.voice.trim()) {
    throw new SpeechApiError(400, "invalid_request", "Model, input, and voice are required.");
  }
  if (!(SPEECH_RESPONSE_FORMATS as readonly string[]).includes(format)) {
    throw new SpeechApiError(400, "invalid_request", "The speech response format is invalid.");
  }
  if (
    input.speed !== undefined &&
    (!Number.isFinite(input.speed) || input.speed < 0.25 || input.speed > 4)
  ) {
    throw new SpeechApiError(400, "invalid_request", "Speech speed must be between 0.25 and 4.");
  }
  const response = await fetch("/api/audio/speech", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      input: input.input,
      voice: input.voice,
      response_format: format,
      ...(input.speed === undefined ? {} : { speed: input.speed }),
    }),
    signal: input.signal,
  });
  if (!response.ok) throw await speechError(response);
  const contentType = normalizedContentType(response.headers.get("content-type"));
  if (!MIME_BY_FORMAT[format].some((candidate) => candidate.toLowerCase() === contentType)) {
    throw new SpeechApiError(
      502,
      "invalid_speech_response",
      "The speech provider returned an unexpected media type.",
    );
  }
  const audio = await response.blob();
  if (!audio.size) {
    throw new SpeechApiError(502, "invalid_speech_response", "The speech response was empty.");
  }
  return audio;
}
