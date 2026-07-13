import { createHash } from "node:crypto";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { isSpecialUseIp, pinnedProviderFetch } from "./provider_transport.ts";

export interface OcrInterceptionConfig {
  enabled: boolean;
  providerId: string;
  model: string;
  prompt: string;
  cacheTtlSeconds: number;
  timeoutMs: number;
  maxBytes: number;
  maxPixels: number;
  maxDimension: number;
  maxRedirects: number;
}

export interface OcrCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface OcrCacheScope {
  /** OCR results may contain sensitive text and are never shared across users. */
  userId: string;
  providerVersion: number;
  credentialUpdatedAt: string | null;
  modelVersion: number;
  upstreamModelId: string;
}

export class MemoryOcrCache implements OcrCache {
  #values = new Map<string, { value: string; expiresAt: number; bytes: number }>();
  #bytes = 0;
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(
    private readonly now: () => number = Date.now,
    options: { maxEntries?: number; maxBytes?: number } = {},
  ) {
    this.#maxEntries = options.maxEntries ?? 512;
    this.#maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1 || this.#maxEntries > 10_000
    ) {
      throw new TypeError("Memory OCR cache entry limit is outside safe bounds");
    }
    if (
      !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 ||
      this.#maxBytes > 64 * 1024 * 1024
    ) {
      throw new TypeError("Memory OCR cache byte limit is outside safe bounds");
    }
  }

  #remove(key: string) {
    const current = this.#values.get(key);
    if (!current) return;
    this.#bytes -= current.bytes;
    this.#values.delete(key);
  }

  #sweepExpired(now: number) {
    for (const [key, entry] of this.#values) {
      if (entry.expiresAt <= now) this.#remove(key);
    }
  }

  #evictToBounds() {
    while (this.#values.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldest = this.#values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#remove(oldest);
    }
  }

  get(key: string): Promise<string | null> {
    const now = this.now();
    this.#sweepExpired(now);
    const hit = this.#values.get(key);
    if (!hit) return Promise.resolve(null);
    // Refresh insertion order so bounded eviction is deterministic LRU.
    this.#values.delete(key);
    this.#values.set(key, hit);
    return Promise.resolve(hit.value);
  }
  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 2_592_000) {
      throw new TypeError("Memory OCR cache TTL is outside safe bounds");
    }
    const bytes = new TextEncoder().encode(value).byteLength;
    if (!value || bytes > OCR_MAX_TEXT_BYTES || bytes > this.#maxBytes) {
      throw new TypeError("Memory OCR cache value is outside safe bounds");
    }
    const now = this.now();
    this.#sweepExpired(now);
    this.#remove(key);
    this.#values.set(key, { value, expiresAt: now + ttlSeconds * 1_000, bytes });
    this.#bytes += bytes;
    this.#evictToBounds();
    return Promise.resolve();
  }
}

export type OcrImage = { bytes: Uint8Array; mime: string; width: number; height: number };
export type OcrRecognize = (input: {
  providerId: string;
  model: string;
  prompt: string;
  image: OcrImage;
  signal: AbortSignal;
}) => Promise<string>;

export class OcrInterceptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: { messageIndex: number; partIndex: number; sourceKind: "inline" | "remote" },
  ) {
    super(message);
    this.name = "OcrInterceptionError";
  }
}

const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Matches the maximum text volume possible from the bounded OCR provider request. */
export const OCR_MAX_TEXT_BYTES = 65_536;
const decoder = new TextDecoder();

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : fallback;
}

/** Parse the versioned `custom_params.ocr` model setting without accepting secret material. */
export function parseOcrInterceptionConfig(value: unknown): OcrInterceptionConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const raw = root.ocr;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ocr = raw as Record<string, unknown>;
  if (ocr.enabled !== true) return null;
  const allowed = new Set([
    "enabled",
    "providerId",
    "model",
    "prompt",
    "cacheTtlSeconds",
    "timeoutMs",
    "maxBytes",
    "maxPixels",
    "maxDimension",
    "maxRedirects",
  ]);
  if (Object.keys(ocr).some((key) => !allowed.has(key))) {
    throw new TypeError("OCR configuration contains an unsupported field");
  }
  if (typeof ocr.providerId !== "string" || !ocr.providerId.trim() || ocr.providerId.length > 200) {
    throw new TypeError("OCR providerId must be a bounded non-empty string");
  }
  if (typeof ocr.model !== "string" || !ocr.model.trim() || ocr.model.length > 200) {
    throw new TypeError("OCR model must be a bounded non-empty string");
  }
  if (typeof ocr.prompt !== "string" || !ocr.prompt.trim() || ocr.prompt.length > 8_192) {
    throw new TypeError("OCR prompt must be a bounded non-empty string");
  }
  return {
    enabled: true,
    providerId: ocr.providerId.trim(),
    model: ocr.model.trim(),
    prompt: ocr.prompt,
    cacheTtlSeconds: boundedInteger(ocr.cacheTtlSeconds, 86_400, 1, 2_592_000),
    timeoutMs: boundedInteger(ocr.timeoutMs, 15_000, 100, 120_000),
    maxBytes: boundedInteger(ocr.maxBytes, 10 * 1024 * 1024, 1_024, 50 * 1024 * 1024),
    maxPixels: boundedInteger(ocr.maxPixels, 40_000_000, 1, 100_000_000),
    maxDimension: boundedInteger(ocr.maxDimension, 16_384, 1, 65_535),
    maxRedirects: boundedInteger(ocr.maxRedirects, 2, 0, 5),
  };
}

function u16be(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 256 + bytes[offset + 1];
}
function u24le(bytes: Uint8Array, offset: number) {
  return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65_536;
}
function u32be(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 + bytes[offset + 3];
}
function u32le(bytes: Uint8Array, offset: number) {
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000;
}

function skipGifSubBlocks(bytes: Uint8Array, offset: number): number {
  while (true) {
    if (offset >= bytes.length) throw new Error("Malformed GIF sub-block stream");
    const length = bytes[offset++];
    if (length === 0) return offset;
    if (offset + length > bytes.length) throw new Error("Malformed GIF sub-block stream");
    offset += length;
  }
}

function gifMetadata(bytes: Uint8Array): { mime: string; width: number; height: number } {
  if (bytes.length < 14) throw new Error("Malformed GIF image");
  const width = bytes[6] + bytes[7] * 256;
  const height = bytes[8] + bytes[9] * 256;
  if (!width || !height) throw new Error("Malformed GIF dimensions");
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * 2 ** ((bytes[10] & 0x07) + 1);
  if (offset > bytes.length) throw new Error("Malformed GIF color table");
  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (frames !== 1) throw new Error("GIF images must contain exactly one frame");
      if (offset !== bytes.length) throw new Error("Malformed GIF trailing data");
      return { mime: "image/gif", width, height };
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) throw new Error("Malformed GIF extension");
      offset++; // Extension label.
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) {
      throw new Error("Malformed GIF image descriptor");
    }
    const left = bytes[offset] + bytes[offset + 1] * 256;
    const top = bytes[offset + 2] + bytes[offset + 3] * 256;
    const frameWidth = bytes[offset + 4] + bytes[offset + 5] * 256;
    const frameHeight = bytes[offset + 6] + bytes[offset + 7] * 256;
    const packed = bytes[offset + 8];
    offset += 9;
    if (
      !frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height
    ) throw new Error("GIF frame dimensions exceed the logical canvas");
    frames++;
    if (frames > 1) throw new Error("Animated GIF images are not supported for OCR");
    if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
    if (offset >= bytes.length) throw new Error("Malformed GIF image data");
    offset++; // LZW minimum code size.
    offset = skipGifSubBlocks(bytes, offset);
  }
  throw new Error("Malformed GIF image without a trailer");
}

function webpMetadata(bytes: Uint8Array): { mime: string; width: number; height: number } {
  if (
    bytes.length < 30 || decoder.decode(bytes.subarray(0, 4)) !== "RIFF" ||
    decoder.decode(bytes.subarray(8, 12)) !== "WEBP"
  ) {
    throw new Error("Malformed WebP image");
  }
  if (u32le(bytes, 4) + 8 !== bytes.length) throw new Error("Malformed WebP container size");
  let offset = 12;
  let firstKind = "";
  let firstPayload = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Malformed WebP chunk header");
    const kind = decoder.decode(bytes.subarray(offset, offset + 4));
    const length = u32le(bytes, offset + 4);
    const payload = offset + 8;
    const next = payload + length + (length & 1);
    if (next > bytes.length) throw new Error("Malformed WebP chunk length");
    if (!firstKind) {
      firstKind = kind;
      firstPayload = payload;
    }
    if (kind === "ANIM" || kind === "ANMF") {
      throw new Error("Animated WebP images are not supported for OCR");
    }
    offset = next;
  }
  if (firstKind === "VP8X") {
    if (firstPayload + 10 > bytes.length) throw new Error("Malformed WebP VP8X header");
    if (bytes[firstPayload] & 0x02) {
      throw new Error("Animated WebP images are not supported for OCR");
    }
    return {
      mime: "image/webp",
      width: u24le(bytes, firstPayload + 4) + 1,
      height: u24le(bytes, firstPayload + 7) + 1,
    };
  }
  if (firstKind === "VP8L" && firstPayload + 5 <= bytes.length && bytes[firstPayload] === 0x2f) {
    const bits = bytes[firstPayload + 1] | bytes[firstPayload + 2] << 8 |
      bytes[firstPayload + 3] << 16 | bytes[firstPayload + 4] << 24;
    return {
      mime: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: (bits >>> 14 & 0x3fff) + 1,
    };
  }
  throw new Error("Unsupported WebP encoding");
}

function imageMetadata(bytes: Uint8Array): { mime: string; width: number; height: number } {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])
  ) return { mime: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  const header = decoder.decode(bytes.subarray(0, 12));
  if (bytes.length >= 10 && (header.startsWith("GIF87a") || header.startsWith("GIF89a"))) {
    return gifMetadata(bytes);
  }
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP") return webpMetadata(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error("Malformed JPEG marker stream");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = u16be(bytes, offset);
      if (length < 2 || offset + length > bytes.length) throw new Error("Malformed JPEG segment");
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 7) throw new Error("Malformed JPEG dimensions");
        return {
          mime: "image/jpeg",
          height: u16be(bytes, offset + 3),
          width: u16be(bytes, offset + 5),
        };
      }
      offset += length;
    }
  }
  throw new Error("Image MIME or dimensions could not be validated");
}

function validateUrl(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("OCR images must use credential-free HTTPS URLs");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || isSpecialUseIp(host)) {
    throw new Error("OCR image URL targets a private or special-use network");
  }
}

async function boundedBody(response: Response, limit: number, signal: AbortSignal) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("OCR image exceeds the byte limit");
  }
  if (!response.body) throw new Error("OCR image response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("OCR image exceeds the byte limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function inlineImage(value: string, maxBytes: number): { bytes: Uint8Array; declaredMime: string } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || !ALLOWED_MIMES.has(match[1].toLowerCase())) {
    throw new Error("Invalid inline OCR image");
  }
  if (match[2].length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error("OCR image exceeds the byte limit");
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  } catch {
    throw new Error("Invalid inline OCR image encoding");
  }
  if (bytes.length > maxBytes) throw new Error("OCR image exceeds the byte limit");
  return { bytes, declaredMime: match[1].toLowerCase() };
}

async function loadImage(
  source: string,
  config: OcrInterceptionConfig,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<OcrImage> {
  let bytes: Uint8Array;
  let declaredMime: string;
  if (source.startsWith("data:")) {
    ({ bytes, declaredMime } = inlineImage(source, config.maxBytes));
  } else {
    let url = new URL(source);
    validateUrl(url);
    let response: Response | undefined;
    for (let redirects = 0;; redirects++) {
      response = await fetcher(url, { method: "GET", redirect: "manual", signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      response.body?.cancel().catch(() => {});
      if (redirects >= config.maxRedirects) throw new Error("OCR image exceeded redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new Error("OCR image redirect is missing Location");
      url = new URL(location, url);
      validateUrl(url);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OCR image fetch failed with HTTP ${response.status}`);
    }
    declaredMime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ??
      "";
    if (!ALLOWED_MIMES.has(declaredMime)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("OCR image response MIME is not allowed");
    }
    bytes = await boundedBody(response, config.maxBytes, signal);
  }
  const metadata = imageMetadata(bytes);
  if (metadata.mime !== declaredMime) {
    throw new Error("OCR image declared MIME does not match content");
  }
  if (
    !metadata.width || !metadata.height || metadata.width > config.maxDimension ||
    metadata.height > config.maxDimension ||
    BigInt(metadata.width) * BigInt(metadata.height) > BigInt(config.maxPixels)
  ) {
    throw new Error("OCR image dimensions exceed configured limits");
  }
  return { bytes, ...metadata };
}

function cacheKey(config: OcrInterceptionConfig, image: OcrImage, scope?: OcrCacheScope) {
  const hash = createHash("sha256");
  hash.update("dg-chat-ocr-v2\0");
  hash.update(scope?.userId ?? "internal");
  hash.update("\0");
  hash.update(String(scope?.providerVersion ?? 0));
  hash.update("\0");
  hash.update(scope?.credentialUpdatedAt ?? "no-credential");
  hash.update("\0");
  hash.update(String(scope?.modelVersion ?? 0));
  hash.update("\0");
  hash.update(scope?.upstreamModelId ?? config.model);
  hash.update("\0");
  hash.update(config.providerId);
  hash.update("\0");
  hash.update(config.model);
  hash.update("\0");
  hash.update(config.prompt);
  hash.update("\0");
  hash.update(image.bytes);
  return `ocr:v2:${hash.digest("hex")}`;
}

export async function interceptOcrImages(
  request: ChatCompletionRequest,
  config: OcrInterceptionConfig,
  dependencies: {
    cache: OcrCache;
    recognize: OcrRecognize;
    fetch?: typeof fetch;
    cacheScope?: OcrCacheScope;
  },
  signal: AbortSignal,
): Promise<ChatCompletionRequest> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const messages = structuredClone(request.messages);
  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
      const part = message.content[partIndex];
      if (part.type !== "image_url") continue;
      const raw = part.image_url;
      const source = typeof raw === "string"
        ? raw
        : raw && typeof raw === "object"
        ? String((raw as Record<string, unknown>).url ?? "")
        : "";
      const sourceKind = source.startsWith("data:") ? "inline" : "remote";
      try {
        const image = await loadImage(
          source,
          config,
          combined,
          dependencies.fetch ?? pinnedProviderFetch,
        );
        const key = cacheKey(config, image, dependencies.cacheScope);
        let text = await dependencies.cache.get(key);
        if (text === null) {
          text = (await dependencies.recognize({
            providerId: config.providerId,
            model: config.model,
            prompt: config.prompt,
            image,
            signal: combined,
          })).trim();
          if (!text || new TextEncoder().encode(text).length > OCR_MAX_TEXT_BYTES) {
            throw new Error("OCR provider returned invalid text");
          }
          await dependencies.cache.set(key, text, config.cacheTtlSeconds);
        }
        if (!text || new TextEncoder().encode(text).length > OCR_MAX_TEXT_BYTES) {
          throw new Error("OCR provider returned invalid text");
        }
        message.content.splice(partIndex, 1, {
          type: "text",
          text: `[OCR image ${messageIndex + 1}.${partIndex + 1}]\n${text}`,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown failure";
        throw new OcrInterceptionError(
          "ocr_interception_failed",
          `OCR failed for message ${messageIndex + 1}, image ${partIndex + 1}: ${detail}`,
          { messageIndex, partIndex, sourceKind },
        );
      }
    }
  }
  return { ...request, messages };
}
