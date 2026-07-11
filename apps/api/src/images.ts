import type { UsagePricingSnapshot } from "@dg-chat/database";
import { pinnedProviderFetch } from "./provider_transport.ts";

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 64 * 1024 * 1024;
export const IMAGE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const IMAGE_MAX_WIRE_BYTES = 48 * 1024 * 1024;
const IMAGE_MAX_EVENT_BYTES = 40 * 1024 * 1024;

/** Conservative replay storage bound for normalized partial and terminal SSE events. */
export function maximumImageStreamReplayBytes(
  request: Pick<ImageGenerationRequest, "partialImages">,
): number {
  const encodedImage = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;
  // Normalized event metadata is ASCII and tightly bounded; reserve ample fixed framing space so
  // admission never depends on a provider-controlled timestamp or JSON representation.
  return (request.partialImages + 1) * (encodedImage + 2_048);
}

export type ImageOutputFormat = "png" | "jpeg" | "webp";
export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n: number;
  background: "auto" | "opaque" | "transparent";
  moderation: "auto" | "low";
  outputCompression: number;
  outputFormat: ImageOutputFormat;
  partialImages: number;
  quality: "auto" | "low" | "medium" | "high" | "standard" | "hd";
  responseFormat: "b64_json" | "url";
  size:
    | "auto"
    | "256x256"
    | "512x512"
    | "1024x1024"
    | "1536x1024"
    | "1024x1536"
    | "1792x1024"
    | "1024x1792";
  stream: boolean;
  style: "vivid" | "natural";
  user?: string;
}

export interface ImageProviderUsage {
  inputTokens: number;
  outputTokens: number;
  source: "estimated" | "provider_tokens";
}
export interface ImageOutput {
  b64Json: string;
  bytes: Uint8Array;
  format: ImageOutputFormat;
  width: number;
  height: number;
  revisedPrompt?: string;
}
export interface ImageProviderResponse {
  created: number;
  data?: ImageOutput[];
  stream?: AsyncIterable<Uint8Array>;
  terminalFrame?: Promise<Uint8Array>;
  usage: ImageProviderUsage | Promise<ImageProviderUsage>;
  /** Winning provider target. Added by the execution engine, never trusted from upstream. */
  executionTarget?: ImageExecutionTarget | Promise<ImageExecutionTarget>;
}
export interface ImageEditInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sha256: string;
  image: ImageOutput;
}
export interface ImageEditRequest extends ImageGenerationRequest {
  images: ImageEditInput[];
  mask?: ImageEditInput;
  inputFidelity?: "high" | "low";
}
export interface ImageEditFileReference {
  fileId: string;
}
export interface ParsedImageEditJson {
  request: ImageGenerationRequest & { inputFidelity?: "high" | "low" };
  images: ImageEditFileReference[];
  mask?: ImageEditFileReference;
}
export interface ImageExecutionTarget {
  providerModelId: string;
  publicModelId: string;
  upstreamModelId: string;
  providerSlug: string;
}

export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "provider_error",
    readonly providerStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ImageProviderError";
  }
}

const scalarLength = (value: string) => [...value].length;
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || scalarLength(value) < 1 || scalarLength(value) > max) {
    throw new ImageProviderError(
      `${name} must contain between 1 and ${max} characters`,
      422,
      "validation_error",
    );
  }
  if (
    [...value].some((part) => {
      const code = part.codePointAt(0)!;
      return code === 0 || (code < 0x20 && ![9, 10, 13].includes(code)) || code === 0x7f;
    })
  ) throw new ImageProviderError(`${name} contains invalid characters`, 422, "validation_error");
  return value;
}
function choice<T extends string>(
  value: unknown,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const candidate = value ?? fallback;
  if (typeof candidate !== "string" || !values.includes(candidate as T)) {
    throw new ImageProviderError(`${name} is invalid`, 422, "validation_error");
  }
  return candidate as T;
}
function integer(value: unknown, name: string, min: number, max: number, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || Number(candidate) < min || Number(candidate) > max) {
    throw new ImageProviderError(
      `${name} must be an integer from ${min} to ${max}`,
      422,
      "validation_error",
    );
  }
  return Number(candidate);
}

/** Strict normalized OpenAI Images generation request. Model-specific policy belongs in model config. */
export function parseImageGenerationRequest(value: unknown): ImageGenerationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImageProviderError("Image request must be a JSON object", 422, "validation_error");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "model",
    "prompt",
    "n",
    "background",
    "moderation",
    "output_compression",
    "output_format",
    "partial_images",
    "quality",
    "response_format",
    "size",
    "stream",
    "style",
    "user",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new ImageProviderError(
      "Image request contains unsupported fields",
      422,
      "validation_error",
    );
  }
  const model = text(body.model, "model", 200);
  if ([...model].some((character) => /\s/u.test(character))) {
    throw new ImageProviderError("model contains invalid characters", 422, "validation_error");
  }
  const prompt = text(body.prompt, "prompt", 32_000);
  const n = integer(body.n, "n", 1, 10, 1);
  const background = choice(
    body.background,
    "background",
    ["auto", "opaque", "transparent"],
    "auto",
  );
  const outputFormat = choice(body.output_format, "output_format", ["png", "jpeg", "webp"], "png");
  const stream = body.stream ?? false;
  if (typeof stream !== "boolean") {
    throw new ImageProviderError("stream must be a boolean", 422, "validation_error");
  }
  const partialImages = integer(body.partial_images, "partial_images", 0, 3, 0);
  if (background === "transparent" && outputFormat === "jpeg") {
    throw new ImageProviderError(
      "transparent backgrounds require png or webp",
      422,
      "validation_error",
    );
  }
  if (partialImages > 0 && !stream) {
    throw new ImageProviderError("partial_images requires streaming", 422, "validation_error");
  }
  if (stream && n !== 1) {
    throw new ImageProviderError("streaming currently requires n=1", 422, "validation_error");
  }
  return {
    model,
    prompt,
    n,
    background,
    moderation: choice(body.moderation, "moderation", ["auto", "low"], "auto"),
    outputCompression: integer(body.output_compression, "output_compression", 0, 100, 100),
    outputFormat,
    partialImages,
    quality: choice(
      body.quality,
      "quality",
      ["auto", "low", "medium", "high", "standard", "hd"],
      "auto",
    ),
    responseFormat: choice(
      body.response_format,
      "response_format",
      ["b64_json", "url"],
      "b64_json",
    ),
    size: choice(body.size, "size", [
      "auto",
      "256x256",
      "512x512",
      "1024x1024",
      "1536x1024",
      "1024x1536",
      "1792x1024",
      "1024x1792",
    ], "auto"),
    stream,
    style: choice(body.style, "style", ["vivid", "natural"], "vivid"),
    ...(body.user === undefined ? {} : { user: text(body.user, "user", 256) }),
  };
}

/** Parse the current OpenAI JSON edit shape; owned file IDs are resolved by the authenticated route. */
export function parseImageEditJson(value: unknown): ParsedImageEditJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImageProviderError(
      "Image edit request must be a JSON object",
      422,
      "validation_error",
    );
  }
  const body = { ...(value as Record<string, unknown>) };
  const rawImages = body.images;
  const rawMask = body.mask;
  const inputFidelity = body.input_fidelity;
  delete body.images;
  delete body.mask;
  delete body.input_fidelity;
  if (body.model === undefined) {
    throw new ImageProviderError(
      "model is required because this installation has no global image-edit default",
      422,
      "model_required",
    );
  }
  if (!Array.isArray(rawImages) || rawImages.length < 1 || rawImages.length > 16) {
    throw new ImageProviderError(
      "images must contain between 1 and 16 references",
      422,
      "validation_error",
    );
  }
  const reference = (raw: unknown, name: string): ImageEditFileReference => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ImageProviderError(`${name} is invalid`, 422, "validation_error");
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.image_url === "string") {
      throw new ImageProviderError(
        "Remote image_url edit inputs are not supported; upload the image and use file_id",
        422,
        "remote_image_url_unsupported",
      );
    }
    if (
      Object.keys(item).length !== 1 || typeof item.file_id !== "string" ||
      item.file_id.length < 1 || item.file_id.length > 200 ||
      [...item.file_id].some((character) => character.charCodeAt(0) < 33)
    ) throw new ImageProviderError(`${name}.file_id is invalid`, 422, "validation_error");
    return { fileId: item.file_id };
  };
  const images = rawImages.map((item, index) => reference(item, `images[${index}]`));
  if (new Set(images.map((item) => item.fileId)).size !== images.length) {
    throw new ImageProviderError("Each source image must be distinct", 422, "duplicate_image");
  }
  const mask = rawMask === undefined ? undefined : reference(rawMask, "mask");
  if (mask && images.some((item) => item.fileId === mask.fileId)) {
    throw new ImageProviderError(
      "The mask must be distinct from every source image",
      422,
      "duplicate_image",
    );
  }
  return {
    request: {
      ...parseImageGenerationRequest(body),
      ...(inputFidelity === undefined ? {} : {
        inputFidelity: choice(
          inputFidelity,
          "input_fidelity",
          ["high", "low"] as const,
          "low",
        ),
      }),
    },
    images,
    ...(mask ? { mask } : {}),
  };
}

export function estimateImageInputTokens(request: Pick<ImageGenerationRequest, "prompt">): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(request.prompt).byteLength / 4));
}

export function assertImageUsagePricing(
  usage: ImageProviderUsage,
  pricing: UsagePricingSnapshot,
): void {
  if (usage.source === "provider_tokens") {
    if (pricing.cachedInputMicrosPerMillion === 0 && pricing.reasoningMicrosPerMillion === 0) {
      return;
    }
    throw new ImageProviderError(
      "Image token pricing cannot include unobserved cached or reasoning token rates",
      500,
      "unsupported_image_pricing",
    );
  }
  if (
    pricing.fixedCallMicros <= 0 || pricing.inputMicrosPerMillion !== 0 ||
    pricing.cachedInputMicrosPerMillion !== 0 || pricing.reasoningMicrosPerMillion !== 0 ||
    pricing.outputMicrosPerMillion !== 0
  ) {
    throw new ImageProviderError(
      "Usage-less image models require fixed-call-only pricing",
      500,
      "unsupported_image_pricing",
    );
  }
}

function u32(bytes: Uint8Array, offset: number, little = false): number {
  if (offset + 4 > bytes.length) {
    throw new ImageProviderError("Image provider returned truncated image data");
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, little);
}
function dimensions(
  bytes: Uint8Array,
): { format: ImageOutputFormat; width: number; height: number } {
  let format: ImageOutputFormat;
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
    u32(bytes, 8) === 13 && new TextDecoder().decode(bytes.subarray(12, 16)) === "IHDR"
  ) {
    format = "png";
    width = u32(bytes, 16);
    height = u32(bytes, 20);
    let offset = 8;
    let chunks = 0;
    let sawIdat = false;
    let sawIend = false;
    while (offset + 12 <= bytes.length) {
      const length = u32(bytes, offset);
      const end = offset + 12 + length;
      if (length > IMAGE_MAX_BYTES || end > bytes.length) {
        throw new ImageProviderError("Image provider returned truncated PNG data");
      }
      const type = new TextDecoder("ascii", { fatal: true }).decode(
        bytes.subarray(offset + 4, offset + 8),
      );
      if (!/^[A-Za-z]{4}$/.test(type) || (chunks === 0 && type !== "IHDR")) {
        throw new ImageProviderError("Image provider returned malformed PNG data");
      }
      if (type === "IDAT") sawIdat = true;
      if (type === "IEND") {
        if (length !== 0 || end !== bytes.length) {
          throw new ImageProviderError("Image provider returned malformed PNG data");
        }
        sawIend = true;
        break;
      }
      chunks++;
      if (chunks > 100_000) {
        throw new ImageProviderError("Image provider returned too many PNG chunks");
      }
      offset = end;
    }
    if (!sawIdat || !sawIend) {
      throw new ImageProviderError("Image provider returned truncated PNG data");
    }
  } else if (
    bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  ) {
    format = "webp";
    if (u32(bytes, 4, true) + 8 !== bytes.length) {
      throw new ImageProviderError("Image provider returned malformed WebP data");
    }
    const kind = new TextDecoder().decode(bytes.subarray(12, 16));
    if (kind === "VP8X" && bytes.length >= 30) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10));
    } else if (
      kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = "jpeg";
    if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      throw new ImageProviderError("Image provider returned truncated JPEG data");
    }
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) {
        throw new ImageProviderError("Image provider returned malformed JPEG data");
      }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) {
        throw new ImageProviderError("Image provider returned truncated JPEG data");
      }
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 7) throw new ImageProviderError("Image provider returned malformed JPEG data");
        height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        break;
      }
      offset += length;
    }
  } else throw new ImageProviderError("Image provider returned unsupported image data");
  if (!width || !height || width > 16384 || height > 16384 || width * height > IMAGE_MAX_PIXELS) {
    throw new ImageProviderError("Image provider returned invalid image dimensions");
  }
  return { format, width, height };
}

export function decodeImage(value: unknown): ImageOutput {
  const canonicalCharacters = (candidate: string) => {
    if (!candidate.length || candidate.length % 4) return false;
    const padding = candidate.endsWith("==") ? 2 : candidate.endsWith("=") ? 1 : 0;
    for (let index = 0; index < candidate.length - padding; index++) {
      const code = candidate.charCodeAt(index);
      if (
        !(
          (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
          (code >= 48 && code <= 57) || code === 43 || code === 47
        )
      ) return false;
    }
    return !candidate.slice(0, -padding || undefined).includes("=");
  };
  if (
    typeof value !== "string" || !value.length ||
    value.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 4 || value.length % 4 ||
    !canonicalCharacters(value)
  ) {
    throw new ImageProviderError("Image provider returned invalid Base64 image");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ImageProviderError("Image provider returned invalid Base64 image");
  }
  if (binary.length > IMAGE_MAX_BYTES || btoa(binary) !== value) {
    throw new ImageProviderError("Image provider returned invalid Base64 image");
  }
  const bytes = Uint8Array.from(binary, (part) => part.charCodeAt(0));
  return { b64Json: value, bytes, ...dimensions(bytes) };
}

export function imageHasAlpha(image: Pick<ImageOutput, "bytes" | "format">): boolean {
  if (image.format === "png") return image.bytes[25] === 4 || image.bytes[25] === 6;
  if (image.format === "webp") {
    return new TextDecoder().decode(image.bytes.subarray(12, 16)) === "VP8X" &&
      (image.bytes[20] & 0x10) !== 0;
  }
  return false;
}

export function assertImageAggregateBytes(
  outputs: readonly Pick<ImageOutput, "bytes">[],
): void {
  let total = 0;
  for (const output of outputs) {
    total += output.bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > IMAGE_MAX_TOTAL_BYTES) {
      throw new ImageProviderError("Image provider output exceeds the aggregate size limit");
    }
  }
}

function assertRequestedFormat(
  image: ImageOutput,
  request: Pick<ImageGenerationRequest, "outputFormat">,
): ImageOutput {
  if (image.format !== request.outputFormat) {
    throw new ImageProviderError("Image provider output format does not match the request");
  }
  return image;
}

function usage(value: unknown, request: ImageGenerationRequest): ImageProviderUsage {
  if (value === undefined) {
    return { inputTokens: estimateImageInputTokens(request), outputTokens: 0, source: "estimated" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImageProviderError("Image provider returned malformed usage");
  }
  const item = value as Record<string, unknown>;
  const valid = (part: unknown): part is number =>
    typeof part === "number" && Number.isSafeInteger(part) && part >= 0;
  if (
    !valid(item.input_tokens) || !valid(item.output_tokens) || !valid(item.total_tokens) ||
    item.total_tokens !== item.input_tokens + item.output_tokens
  ) throw new ImageProviderError("Image provider returned malformed usage");
  return {
    inputTokens: item.input_tokens,
    outputTokens: item.output_tokens,
    source: "provider_tokens",
  };
}

function endpoint(baseUrl: string, operation: "generations" | "edits" = "generations"): URL {
  const url = new URL(baseUrl);
  const test = Deno.env.get("DENO_ENV") === "test" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ImageProviderError("Provider base URL is invalid", 500, "provider_config_error");
  }
  if (test) url.protocol = "http:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/images/${operation}`;
  return url;
}
function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return;
  const value = /^\d+(?:\.\d+)?$/.test(raw)
    ? Math.ceil(Number(raw) * 1000)
    : Math.max(0, Date.parse(raw) - Date.now());
  return Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000 ? value : undefined;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ImageProviderError("Image provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > IMAGE_MAX_WIRE_BYTES) {
        throw new ImageProviderError("Image provider response exceeds the size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } catch {
    throw new ImageProviderError("Image provider returned invalid JSON");
  }
}

function imageSse(
  body: ReadableStream<Uint8Array>,
  request: ImageGenerationRequest,
  signal: AbortSignal,
  eventPrefix = "image_generation",
) {
  let resolveUsage!: (value: ImageProviderUsage) => void;
  let rejectUsage!: (reason: unknown) => void;
  let resolveTerminal!: (value: Uint8Array) => void;
  let rejectTerminal!: (reason: unknown) => void;
  const usagePromise = new Promise<ImageProviderUsage>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });
  const terminalFrame = new Promise<Uint8Array>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  void usagePromise.catch(() => {});
  void terminalFrame.catch(() => {});
  const stream = (async function* () {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    let wire = 0;
    let terminal = false;
    let settled = false;
    let expectedPartial = 0;
    let decodedTotal = 0;
    const accountDecoded = (bytes: number) => {
      decodedTotal += bytes;
      if (!Number.isSafeInteger(decodedTotal) || decodedTotal > IMAGE_MAX_TOTAL_BYTES) {
        throw new ImageProviderError("Image provider output exceeds the aggregate size limit");
      }
    };
    const abort = () => void reader.cancel(signal.reason).catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    const event = (raw: string): { frame?: Uint8Array; done?: true } => {
      if (!raw.trim() || raw.split(/\r?\n/).every((line) => !line || line.startsWith(":"))) {
        return {};
      }
      const lines = raw.split(/\r?\n/).filter((line) => line && !line.startsWith(":"));
      if (lines.some((line) => !line.startsWith("data:") && !line.startsWith("event:"))) {
        throw new ImageProviderError("Image provider returned invalid SSE");
      }
      const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) =>
        line.slice(5).replace(/^ /, "")
      );
      if (!dataLines.length || raw.length > IMAGE_MAX_EVENT_BYTES) {
        throw new ImageProviderError("Image provider returned invalid SSE");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataLines.join("\n"));
      } catch {
        throw new ImageProviderError("Image provider returned invalid SSE JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ImageProviderError("Image provider returned invalid SSE event");
      }
      const item = parsed as Record<string, unknown>;
      const eventNames = lines.filter((line) => line.startsWith("event:")).map((line) =>
        line.slice(6).trim()
      );
      if (eventNames.length > 1 || (eventNames[0] && eventNames[0] !== item.type)) {
        throw new ImageProviderError("Image provider SSE event name does not match its type");
      }
      if (item.type === `${eventPrefix}.partial_image`) {
        if (
          terminal || !Number.isSafeInteger(item.partial_image_index) ||
          item.partial_image_index !== expectedPartial++ || expectedPartial > request.partialImages
        ) throw new ImageProviderError("Image provider returned invalid partial image event");
        const decoded = assertRequestedFormat(decodeImage(item.b64_json), request);
        accountDecoded(decoded.bytes.byteLength);
        const normalized = {
          type: item.type,
          b64_json: decoded.b64Json,
          created_at: safeTimestamp(item.created_at),
          size: request.size,
          quality: request.quality,
          background: request.background,
          output_format: decoded.format,
          partial_image_index: item.partial_image_index,
        };
        return {
          frame: new TextEncoder().encode(
            `event: ${item.type}\ndata: ${JSON.stringify(normalized)}\n\n`,
          ),
        };
      }
      if (item.type === `${eventPrefix}.completed`) {
        if (terminal) {
          throw new ImageProviderError("Image provider returned duplicate terminal image event");
        }
        terminal = true;
        const decoded = assertRequestedFormat(decodeImage(item.b64_json), request);
        accountDecoded(decoded.bytes.byteLength);
        const observed = usage(item.usage, request);
        const normalized = {
          type: item.type,
          b64_json: decoded.b64Json,
          created_at: safeTimestamp(item.created_at),
          size: request.size,
          quality: request.quality,
          background: request.background,
          output_format: decoded.format,
          ...(item.usage === undefined ? {} : {
            usage: {
              input_tokens: observed.inputTokens,
              output_tokens: observed.outputTokens,
              total_tokens: observed.inputTokens + observed.outputTokens,
            },
          }),
        };
        const frame = new TextEncoder().encode(
          `event: ${item.type}\ndata: ${JSON.stringify(normalized)}\n\n`,
        );
        resolveUsage(observed);
        resolveTerminal(frame);
        settled = true;
        return { done: true };
      }
      throw new ImageProviderError("Image provider returned an unknown SSE event");
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        wire += next.value.length;
        if (wire > IMAGE_MAX_WIRE_BYTES) {
          throw new ImageProviderError("Image provider response exceeds the size limit");
        }
        buffered += decoder.decode(next.value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffered))) {
          const raw = buffered.slice(0, match.index);
          buffered = buffered.slice(match.index + match[0].length);
          const result = event(raw);
          if (result.frame) yield result.frame;
        }
        if (buffered.length > IMAGE_MAX_EVENT_BYTES) {
          throw new ImageProviderError("Image provider SSE event exceeds the size limit");
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) throw new ImageProviderError("Image provider returned truncated SSE");
      if (!terminal) throw new ImageProviderError("Image provider terminal event is missing");
    } catch (error) {
      if (!settled) {
        rejectUsage(error);
        rejectTerminal(error);
        settled = true;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      if (!settled) {
        const error = new DOMException("Image stream consumer disconnected", "AbortError");
        rejectUsage(error);
        rejectTerminal(error);
      }
    }
  })();
  return { stream, usage: usagePromise, terminalFrame };
}
function safeTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ImageProviderError("Image provider returned invalid timestamp");
  }
  return Number(value);
}

export function imageFrameDecodedBytes(frame: Uint8Array): number {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    const line = raw.split(/\r?\n/).find((part) => part.startsWith("data:"));
    const item = JSON.parse(line!.slice(5)) as Record<string, unknown>;
    return decodeImage(item.b64_json).bytes.length;
  } catch {
    return 0;
  }
}

/** Decode the already-validated canonical terminal event for durable asset persistence. */
export function imageTerminalOutput(frame: Uint8Array): {
  created: number;
  output: ImageOutput;
} {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    const line = raw.split(/\r?\n/).find((part) => part.startsWith("data:"));
    const item = JSON.parse(line!.slice(5)) as Record<string, unknown>;
    if (!["image_generation.completed", "image_edit.completed"].includes(String(item.type))) {
      throw new Error("not terminal");
    }
    return {
      created: safeTimestamp(item.created_at),
      output: decodeImage(item.b64_json),
    };
  } catch (error) {
    if (error instanceof ImageProviderError) throw error;
    throw new ImageProviderError("Canonical image terminal event is invalid");
  }
}

export async function createImageGeneration(
  request: ImageGenerationRequest,
  options: {
    baseUrl: string;
    apiKey: string;
    upstreamModel: string;
    signal: AbortSignal;
    fetch?: typeof fetch;
  },
): Promise<ImageProviderResponse> {
  options.signal.throwIfAborted();
  const url = endpoint(options.baseUrl);
  const test = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:";
  const response = await (options.fetch ?? (test ? fetch : pinnedProviderFetch))(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
    },
    redirect: "error",
    signal: options.signal,
    body: JSON.stringify({
      model: options.upstreamModel,
      prompt: request.prompt,
      n: request.n,
      background: request.background,
      moderation: request.moderation,
      output_compression: request.outputCompression,
      output_format: request.outputFormat,
      partial_images: request.partialImages,
      quality: request.quality,
      response_format: "b64_json",
      size: request.size,
      stream: request.stream,
      style: request.style,
      ...(request.user ? { user: request.user } : {}),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ImageProviderError(
      "Image provider request failed",
      response.status >= 500 || response.status === 429 ? 502 : 400,
      "provider_error",
      response.status,
      retryAfter(response),
    );
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (request.stream) {
    if (contentType !== "text/event-stream" || !response.body) {
      await response.body?.cancel();
      throw new ImageProviderError("Image provider did not return an SSE stream");
    }
    return { created: 0, ...imageSse(response.body, request, options.signal) };
  }
  if (contentType !== "application/json") {
    await response.body?.cancel();
    throw new ImageProviderError("Image provider returned an unexpected content type");
  }
  const raw = await boundedJson(response);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ImageProviderError("Image provider returned malformed response");
  }
  const value = raw as Record<string, unknown>;
  const created = safeTimestamp(value.created);
  if (!Array.isArray(value.data) || value.data.length !== request.n) {
    throw new ImageProviderError("Image provider returned an unexpected image count");
  }
  const data = value.data.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ImageProviderError("Image provider returned malformed image data");
    }
    const item = entry as Record<string, unknown>;
    if (item.url !== undefined) {
      throw new ImageProviderError("Image provider returned an unsafe URL instead of image data");
    }
    const decoded = assertRequestedFormat(decodeImage(item.b64_json), request);
    if (item.revised_prompt !== undefined) {
      decoded.revisedPrompt = text(item.revised_prompt, "revised_prompt", 32_000);
    }
    return decoded;
  });
  assertImageAggregateBytes(data);
  return { created, data, usage: usage(value.usage, request) };
}

/** OpenAI-compatible image edit dispatch. Inputs are already sniffed and structurally validated. */
export async function createImageEdit(
  request: ImageEditRequest,
  options: {
    baseUrl: string;
    apiKey: string;
    upstreamModel: string;
    signal: AbortSignal;
    fetch?: typeof fetch;
  },
): Promise<ImageProviderResponse> {
  options.signal.throwIfAborted();
  const form = new FormData();
  const upstreamImageField = request.images.length === 1 ? "image" : "image[]";
  for (const input of request.images) {
    form.append(
      upstreamImageField,
      new Blob([input.bytes.slice().buffer], { type: input.mimeType }),
      input.filename,
    );
  }
  if (request.mask) {
    form.append(
      "mask",
      new Blob([request.mask.bytes.slice().buffer], { type: request.mask.mimeType }),
      request.mask.filename,
    );
  }
  const fields: Record<string, string | number | boolean> = {
    model: options.upstreamModel,
    prompt: request.prompt,
    n: request.n,
    background: request.background,
    output_compression: request.outputCompression,
    output_format: request.outputFormat,
    partial_images: request.partialImages,
    quality: request.quality,
    response_format: "b64_json",
    size: request.size,
    stream: request.stream,
    ...(request.inputFidelity ? { input_fidelity: request.inputFidelity } : {}),
    ...(request.user ? { user: request.user } : {}),
  };
  for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
  // The pinned production transport intentionally accepts only materialized bytes so it can
  // send the exact validated body through its DNS-pinned TLS connection. Let the platform's
  // standards-compliant FormData encoder choose the boundary, then preserve that content type
  // while materializing the already-bounded edit inputs.
  const encodedForm = new Response(form);
  const multipartContentType = encodedForm.headers.get("content-type");
  if (!multipartContentType?.toLowerCase().startsWith("multipart/form-data; boundary=")) {
    throw new ImageProviderError("Could not encode image edit multipart request");
  }
  const multipartBody = new Uint8Array(await encodedForm.arrayBuffer());
  const url = endpoint(options.baseUrl, "edits");
  const test = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:";
  const response = await (options.fetch ?? (test ? fetch : pinnedProviderFetch))(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: request.stream ? "text/event-stream" : "application/json",
        "content-type": multipartContentType,
      },
      redirect: "error",
      signal: options.signal,
      body: multipartBody,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new ImageProviderError(
      "Image edit provider request failed",
      response.status >= 500 || response.status === 429 ? 502 : 400,
      "provider_error",
      response.status,
      retryAfter(response),
    );
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (request.stream) {
    if (contentType !== "text/event-stream" || !response.body) {
      await response.body?.cancel();
      throw new ImageProviderError("Image edit provider did not return an SSE stream");
    }
    return { created: 0, ...imageSse(response.body, request, options.signal, "image_edit") };
  }
  if (contentType !== "application/json") {
    await response.body?.cancel();
    throw new ImageProviderError("Image edit provider returned an unexpected content type");
  }
  const raw = await boundedJson(response);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ImageProviderError("Image edit provider returned malformed response");
  }
  const value = raw as Record<string, unknown>;
  const created = safeTimestamp(value.created);
  if (!Array.isArray(value.data) || value.data.length !== request.n) {
    throw new ImageProviderError("Image edit provider returned an unexpected image count");
  }
  const data = value.data.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ImageProviderError("Image edit provider returned malformed image data");
    }
    const item = entry as Record<string, unknown>;
    if (item.url !== undefined) {
      throw new ImageProviderError(
        "Image edit provider returned an unsafe URL instead of image data",
      );
    }
    const decoded = assertRequestedFormat(decodeImage(item.b64_json), request);
    if (item.revised_prompt !== undefined) {
      decoded.revisedPrompt = text(item.revised_prompt, "revised_prompt", 32_000);
    }
    return decoded;
  });
  assertImageAggregateBytes(data);
  return { created, data, usage: usage(value.usage, request) };
}
