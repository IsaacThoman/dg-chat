import { Busboy } from "@fastify/busboy";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  AUDIO_MAX_AUXILIARY_BYTES,
  AUDIO_MAX_FILE_BYTES,
  type AudioChunkingStrategy,
  type AudioRequest,
  type AudioResponseFormat,
} from "./audio.ts";
import { secureUploadStream, UploadSecurityError } from "./upload-security.ts";

const AUDIO_TYPES = new Set([
  "audio/flac",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);
const formats = new Set<AudioResponseFormat>([
  "diarized_json",
  "json",
  "text",
  "srt",
  "verbose_json",
  "vtt",
]);
const repeatedFields = new Set([
  "include[]",
  "known_speaker_names[]",
  "known_speaker_references[]",
  "timestamp_granularities[]",
]);

function validSpeakerReference(value: string): boolean {
  const matched = /^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!matched || !AUDIO_TYPES.has(matched[1].toLowerCase())) return false;
  try {
    return atob(matched[2]).length > 0;
  } catch {
    return false;
  }
}

function webReadable(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export async function parseAudioMultipart(
  request: Request,
  endpoint: "transcriptions" | "translations",
): Promise<AudioRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new UploadSecurityError(
      "invalid_multipart",
      "Content-Type must be multipart/form-data",
      400,
    );
  }
  const declared = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declared) &&
    declared > AUDIO_MAX_FILE_BYTES + AUDIO_MAX_AUXILIARY_BYTES + 128 * 1024
  ) {
    throw new UploadSecurityError("audio_too_large", "Audio upload exceeds the byte limit", 413);
  }
  if (!request.body) throw new UploadSecurityError("empty_upload", "Audio upload is empty", 400);
  const fields = new Map<string, string[]>();
  let file:
    | Promise<{ bytes: Uint8Array; filename: string; mime: string; sha256: string }>
    | undefined;
  let failure: unknown;
  const busboy = (() => {
    try {
      return Busboy({
        headers: { "content-type": contentType },
        limits: {
          fileSize: AUDIO_MAX_FILE_BYTES,
          files: 1,
          fields: 24,
          parts: 25,
          fieldSize: 2 * 1024 * 1024,
          fieldNameSize: 100,
          headerPairs: 20,
          headerSize: 8192,
        },
      });
    } catch {
      throw new UploadSecurityError(
        "invalid_multipart",
        "Audio multipart boundary is invalid",
        400,
      );
    }
  })();
  busboy.on("field", (name, value, nameTruncated, valueTruncated) => {
    if (nameTruncated || valueTruncated) {
      failure ??= new UploadSecurityError(
        "invalid_multipart",
        "Audio form field is too large",
        400,
      );
      return;
    }
    const allowed = [
      "model",
      "language",
      "prompt",
      "response_format",
      "temperature",
      "timestamp_granularities[]",
      "stream",
      "include[]",
      "chunking_strategy",
      "known_speaker_names[]",
      "known_speaker_references[]",
    ];
    if (
      !allowed.includes(name) ||
      (endpoint === "translations" &&
        !["model", "prompt", "response_format", "temperature"].includes(name))
    ) {
      failure ??= new UploadSecurityError(
        "invalid_multipart",
        `Unexpected audio form field '${name}'`,
        400,
      );
      return;
    }
    const prior = fields.get(name) ?? [];
    if (!repeatedFields.has(name) && prior.length) {
      failure ??= new UploadSecurityError(
        "invalid_multipart",
        `Duplicate audio form field '${name}'`,
        400,
      );
      return;
    }
    prior.push(value);
    fields.set(name, prior);
  });
  busboy.on("file", (name, stream, filename, _encoding, mime) => {
    if (name !== "file" || file) {
      failure ??= new UploadSecurityError(
        "invalid_multipart",
        "Exactly one audio file is required",
        400,
      );
      stream.resume();
      return;
    }
    let limited = false;
    stream.once("limit", () => limited = true);
    file = (async () => {
      const secured = secureUploadStream(webReadable(stream as Readable), filename, mime, {
        maxBytes: AUDIO_MAX_FILE_BYTES,
        allowedTypes: AUDIO_TYPES,
      });
      const [rawBytes, inspection] = await Promise.all([
        new Response(secured.stream).arrayBuffer(),
        secured.inspection,
      ]);
      if (limited || stream.truncated) {
        throw new UploadSecurityError(
          "audio_too_large",
          "Audio upload exceeds the byte limit",
          413,
        );
      }
      const bytes = new Uint8Array(rawBytes);
      return {
        bytes,
        filename: inspection.filename,
        mime: inspection.mime,
        sha256: inspection.sha256,
      };
    })();
    void file.catch((error) => failure ??= error);
  });
  for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const) {
    busboy.on(
      event,
      () =>
        failure ??= new UploadSecurityError(
          "invalid_multipart",
          "Audio multipart limits exceeded",
          400,
        ),
    );
  }
  let parserErrored = false;
  const finished = new Promise<void>((resolve, reject) => {
    busboy.once("finish", resolve);
    // Keep this listener installed after the first parser error. Destroying or draining a broken
    // multipart stream can otherwise emit a second process-level unhandled error.
    busboy.on("error", (error) => {
      parserErrored = true;
      reject(error);
    });
  });
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!busboy.write(value)) await new Promise<void>((resolve) => busboy.once("drain", resolve));
    }
    busboy.end();
    await finished;
  } catch (error) {
    failure ??= new UploadSecurityError(
      "invalid_multipart",
      "Audio multipart body is malformed or incomplete",
      400,
    );
    if (!parserErrored) {
      try {
        busboy.destroy(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // The controlled multipart error above is authoritative.
      }
    }
    await finished.catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
  let uploaded;
  try {
    uploaded = await file;
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  if (!uploaded?.bytes.byteLength) {
    throw new UploadSecurityError("missing_file", "An audio file is required", 400);
  }
  const model = fields.get("model")?.[0]?.trim();
  if (!model || model.length > 200) {
    throw new UploadSecurityError("validation_error", "A valid model is required", 422);
  }
  const responseFormat = (fields.get("response_format")?.[0] ?? "json") as AudioResponseFormat;
  if (!formats.has(responseFormat)) {
    throw new UploadSecurityError("validation_error", "Invalid audio response_format", 422);
  }
  if (endpoint === "translations" && responseFormat === "diarized_json") {
    throw new UploadSecurityError(
      "validation_error",
      "diarized_json is only supported for transcriptions",
      422,
    );
  }
  const language = fields.get("language")?.[0];
  if (language !== undefined && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) {
    throw new UploadSecurityError("validation_error", "Invalid audio language", 422);
  }
  const prompt = fields.get("prompt")?.[0];
  if (prompt !== undefined && new TextEncoder().encode(prompt).byteLength > 8_192) {
    throw new UploadSecurityError("validation_error", "Audio prompt is too long", 422);
  }
  const rawTemperature = fields.get("temperature")?.[0];
  const temperature = rawTemperature === undefined ? undefined : Number(rawTemperature);
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0 || temperature > 1)
  ) {
    throw new UploadSecurityError(
      "validation_error",
      "Audio temperature must be between 0 and 1",
      422,
    );
  }
  const timestampGranularities = fields.get("timestamp_granularities[]") as
    | Array<"word" | "segment">
    | undefined;
  if (
    timestampGranularities &&
    (timestampGranularities.some((value) => value !== "word" && value !== "segment") ||
      new Set(timestampGranularities).size !== timestampGranularities.length)
  ) {
    throw new UploadSecurityError("validation_error", "Invalid timestamp granularities", 422);
  }
  if (timestampGranularities?.length && responseFormat !== "verbose_json") {
    throw new UploadSecurityError(
      "validation_error",
      "Timestamp granularities require verbose_json",
      422,
    );
  }
  const rawStream = fields.get("stream")?.[0];
  if (rawStream !== undefined && rawStream !== "true" && rawStream !== "false") {
    throw new UploadSecurityError("validation_error", "Audio stream must be true or false", 422);
  }
  const stream = rawStream === "true";
  if (stream && endpoint !== "transcriptions") {
    throw new UploadSecurityError(
      "validation_error",
      "Streaming is only supported for transcriptions",
      422,
    );
  }
  if (stream && !["json", "diarized_json"].includes(responseFormat)) {
    throw new UploadSecurityError(
      "validation_error",
      "Streaming requires json or diarized_json",
      422,
    );
  }
  const include = fields.get("include[]") as Array<"logprobs"> | undefined;
  if (
    include &&
    (include.some((value) => value !== "logprobs") || new Set(include).size !== include.length)
  ) {
    throw new UploadSecurityError("validation_error", "Invalid audio include value", 422);
  }
  if (include?.length && responseFormat !== "json") {
    throw new UploadSecurityError(
      "validation_error",
      "Audio include values require response_format=json",
      422,
    );
  }
  const chunkingStrategy = parseChunkingStrategy(fields.get("chunking_strategy")?.[0]);
  const knownSpeakerNames = fields.get("known_speaker_names[]");
  const knownSpeakerReferences = fields.get("known_speaker_references[]");
  if ((knownSpeakerNames?.length ?? 0) > 4 || (knownSpeakerReferences?.length ?? 0) > 4) {
    throw new UploadSecurityError(
      "validation_error",
      "At most four known speakers are allowed",
      422,
    );
  }
  if ((knownSpeakerNames?.length ?? 0) !== (knownSpeakerReferences?.length ?? 0)) {
    throw new UploadSecurityError(
      "validation_error",
      "Known speaker names and references must have equal lengths",
      422,
    );
  }
  if (knownSpeakerNames?.some((value) => !/^[A-Za-z0-9_-]{1,64}$/.test(value))) {
    throw new UploadSecurityError("validation_error", "Invalid known speaker name", 422);
  }
  if (knownSpeakerReferences?.some((value) => !validSpeakerReference(value))) {
    throw new UploadSecurityError("validation_error", "Invalid known speaker reference", 422);
  }
  const auxiliaryBytes = [...(knownSpeakerReferences ?? [])].reduce(
    (total, value) => total + new TextEncoder().encode(value).byteLength,
    0,
  );
  if (auxiliaryBytes > AUDIO_MAX_AUXILIARY_BYTES) {
    throw new UploadSecurityError(
      "validation_error",
      "Known speaker references are too large",
      422,
    );
  }
  // Recompute defensively so request identity never relies on a multipart boundary or filename.
  const fileSha256 = createHash("sha256").update(uploaded.bytes).digest("hex");
  return {
    model,
    file: uploaded.bytes,
    filename: uploaded.filename,
    mime: uploaded.mime,
    fileSha256,
    responseFormat,
    ...(stream ? { stream: true } : {}),
    ...(include?.length ? { include } : {}),
    ...(chunkingStrategy ? { chunkingStrategy } : {}),
    ...(knownSpeakerNames?.length ? { knownSpeakerNames } : {}),
    ...(knownSpeakerReferences?.length ? { knownSpeakerReferences } : {}),
    ...(language ? { language } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(timestampGranularities?.length ? { timestampGranularities } : {}),
  };
}

function parseChunkingStrategy(value: string | undefined): AudioChunkingStrategy | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UploadSecurityError("validation_error", "Invalid chunking_strategy", 422);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UploadSecurityError("validation_error", "Invalid chunking_strategy", 422);
  }
  const input = parsed as Record<string, unknown>;
  if (
    input.type !== "server_vad" ||
    Object.keys(input).some((key) =>
      !["type", "threshold", "prefix_padding_ms", "silence_duration_ms"].includes(key)
    ) ||
    (input.threshold !== undefined &&
      (typeof input.threshold !== "number" || !Number.isFinite(input.threshold) ||
        input.threshold < 0 || input.threshold > 1)) ||
    (input.prefix_padding_ms !== undefined &&
      (!Number.isInteger(input.prefix_padding_ms) || Number(input.prefix_padding_ms) < 0 ||
        Number(input.prefix_padding_ms) > 10_000)) ||
    (input.silence_duration_ms !== undefined &&
      (!Number.isInteger(input.silence_duration_ms) || Number(input.silence_duration_ms) < 0 ||
        Number(input.silence_duration_ms) > 10_000))
  ) {
    throw new UploadSecurityError("validation_error", "Invalid chunking_strategy", 422);
  }
  return input as unknown as AudioChunkingStrategy;
}
