import { createHash } from "node:crypto";

export type UploadDecision =
  | { state: "ready"; reason: "validated" }
  | { state: "quarantine"; reason: "image_guard_pending" | "manual_review_required" };

export interface ImageGuardResult {
  width?: number;
  height?: number;
  decompressedBytes?: number;
  requiresManualReview?: boolean;
}

export interface UploadInspection {
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  decision: UploadDecision;
  image?: ImageGuardResult;
}

export interface UploadSecurityOptions {
  maxBytes: number;
  allowedTypes?: ReadonlySet<string>;
  inspectionBytes?: number;
  maxImageWidth?: number;
  maxImageHeight?: number;
  maxImagePixels?: number;
  maxDecompressedBytes?: number;
  imageGuard?: (input: {
    mime: string;
    prefix: Uint8Array;
    totalBytes: number;
  }) => ImageGuardResult | Promise<ImageGuardResult>;
}

export class UploadSecurityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "UploadSecurityError";
  }
}

const DEFAULT_ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/json",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
]);

const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/x-wav": "audio/wav",
  "application/x-pdf": "application/pdf",
  "text/json": "application/json",
};

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/json": "json",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
};

function canonicalMime(value: string): string {
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return MIME_ALIASES[mime] ?? mime;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function sniffMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(bytes, 0, 3) === "ID3" || startsWith(bytes, [0xff, 0xfb])) return "audio/mpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x4d, 0x5a])) {
    return undefined;
  }
  if (bytes.includes(0)) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
      .trimStart();
    if (!text) return "text/plain";
    if (/^(?:<!doctype\s+html|<html\b|<svg\b|<\?xml\b|<script\b)/i.test(text)) return undefined;
    // The bounded inspection prefix commonly truncates otherwise valid JSON.
    // This is MIME classification; consumers parse the complete object later.
    if (text.startsWith("{") || text.startsWith("[")) return "application/json";
    const controls = [...text].filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code);
    }).length;
    return controls / Math.max(text.length, 1) <= 0.01 ? "text/plain" : undefined;
  } catch {
    return undefined;
  }
}

function hasPolyglotMarkers(bytes: Uint8Array, mime: string): boolean {
  if (mime === "text/plain" || mime === "application/json") return false;
  const text = new TextDecoder("latin1").decode(bytes).toLowerCase();
  const dangerousMarkup = ["<script", "<!doctype html", "<html", "<?php", "<svg"];
  if (dangerousMarkup.some((marker) => text.includes(marker))) return true;
  const secondarySignatures = ["pk\x03\x04", "mz"];
  return secondarySignatures.some((signature) => text.indexOf(signature, 8) >= 0);
}

function builtInImageDimensions(mime: string, bytes: Uint8Array): ImageGuardResult {
  if (mime === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === "image/gif" && bytes.length >= 10) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mime === "image/webp" && bytes.length >= 30 && ascii(bytes, 12, 4) === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height };
  }
  if (mime === "image/jpeg") {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        };
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return {};
}

function enforceImageLimits(result: ImageGuardResult, options: UploadSecurityOptions): void {
  const { width, height, decompressedBytes } = result;
  if (width !== undefined && (!Number.isSafeInteger(width) || width < 1)) {
    throw new UploadSecurityError("invalid_image_dimensions", "Image width is invalid");
  }
  if (height !== undefined && (!Number.isSafeInteger(height) || height < 1)) {
    throw new UploadSecurityError("invalid_image_dimensions", "Image height is invalid");
  }
  if (width && options.maxImageWidth && width > options.maxImageWidth) {
    throw new UploadSecurityError(
      "image_dimensions_exceeded",
      "Image width exceeds the limit",
      413,
    );
  }
  if (height && options.maxImageHeight && height > options.maxImageHeight) {
    throw new UploadSecurityError(
      "image_dimensions_exceeded",
      "Image height exceeds the limit",
      413,
    );
  }
  if (width && height && options.maxImagePixels && width * height > options.maxImagePixels) {
    throw new UploadSecurityError(
      "image_pixels_exceeded",
      "Image pixel count exceeds the limit",
      413,
    );
  }
  if (
    decompressedBytes !== undefined && options.maxDecompressedBytes &&
    decompressedBytes > options.maxDecompressedBytes
  ) {
    throw new UploadSecurityError(
      "image_decompression_exceeded",
      "Decompressed image exceeds the limit",
      413,
    );
  }
}

export function normalizeUploadFilename(input: string, maxLength = 120): string {
  const basename = input.normalize("NFKC").replaceAll("\\", "/").split("/").at(-1) ?? "";
  let safe = [...basename]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .replace(/[^\p{L}\p{N}._ ()\[\]-]+/gu, "_")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!safe || safe === "." || safe === "..") safe = "upload";
  if (safe.length > maxLength) {
    const dot = safe.lastIndexOf(".");
    const extension = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : "";
    safe = `${safe.slice(0, maxLength - extension.length)}${extension}`;
  }
  return safe;
}

export function safeUploadObjectKey(ownerId: string, mime: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId)) {
    throw new UploadSecurityError("invalid_owner_id", "Upload owner identifier is invalid");
  }
  const extension = EXTENSIONS[canonicalMime(mime)];
  if (!extension) {
    throw new UploadSecurityError("unsupported_media_type", "Media type is not allowed", 415);
  }
  const id = crypto.randomUUID();
  return `uploads/${ownerId}/${id.slice(0, 2)}/${id}.${extension}`;
}

export function secureUploadStream(
  source: ReadableStream<Uint8Array>,
  filename: string,
  declaredType: string,
  options: UploadSecurityOptions,
): { stream: ReadableStream<Uint8Array>; inspection: Promise<UploadInspection> } {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  const inspectionBytes = options.inspectionBytes ?? 64 * 1024;
  if (
    !Number.isSafeInteger(inspectionBytes) || inspectionBytes < 512 || inspectionBytes > 1024 * 1024
  ) {
    throw new TypeError("inspectionBytes must be an integer from 512 to 1048576");
  }
  const normalizedFilename = normalizeUploadFilename(filename);
  const declared = canonicalMime(declaredType);
  const allowed = options.allowedTypes ?? DEFAULT_ALLOWED_TYPES;
  if (!allowed.has(declared) && declared !== "application/octet-stream") {
    throw new UploadSecurityError(
      "unsupported_media_type",
      "Declared media type is not allowed",
      415,
    );
  }
  const hash = createHash("sha256");
  const prefixChunks: Uint8Array[] = [];
  let prefixSize = 0;
  let total = 0;
  let resolveInspection!: (value: UploadInspection) => void;
  let rejectInspection!: (reason: unknown) => void;
  let settled = false;
  const inspection = new Promise<UploadInspection>((resolve, reject) => {
    resolveInspection = resolve;
    rejectInspection = reject;
  });
  const fail = (error: unknown): never => {
    if (!settled) {
      settled = true;
      rejectInspection(error);
    }
    throw error;
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        if (!(chunk instanceof Uint8Array)) {
          fail(
            new UploadSecurityError("invalid_chunk", "Upload stream contained an invalid chunk"),
          );
        }
        total += chunk.byteLength;
        if (total > options.maxBytes) {
          fail(new UploadSecurityError("upload_too_large", "Upload exceeds the byte limit", 413));
        }
        hash.update(chunk);
        const remaining = inspectionBytes - prefixSize;
        if (remaining > 0) {
          const part = chunk.slice(0, remaining);
          prefixChunks.push(part);
          prefixSize += part.byteLength;
        }
        controller.enqueue(chunk);
      } catch (error) {
        fail(error);
      }
    },
    async flush() {
      try {
        if (total === 0) fail(new UploadSecurityError("empty_upload", "Upload is empty"));
        const prefix = new Uint8Array(prefixSize);
        let offset = 0;
        for (const chunk of prefixChunks) {
          prefix.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const sniffed = sniffMime(prefix);
        if (!sniffed) {
          fail(
            new UploadSecurityError("unsupported_media_type", "File signature is not allowed", 415),
          );
        }
        const validatedMime = sniffed as string;
        if (!allowed.has(validatedMime)) {
          fail(
            new UploadSecurityError("unsupported_media_type", "File signature is not allowed", 415),
          );
        }
        if (declared !== "application/octet-stream" && validatedMime !== declared) {
          fail(
            new UploadSecurityError(
              "mime_mismatch",
              "Declared media type does not match file signature",
              415,
            ),
          );
        }
        if (hasPolyglotMarkers(prefix, validatedMime)) {
          fail(
            new UploadSecurityError(
              "polyglot_detected",
              "Conflicting file signatures were detected",
              415,
            ),
          );
        }
        let image: ImageGuardResult | undefined;
        let decision: UploadDecision = { state: "ready", reason: "validated" };
        if (validatedMime.startsWith("image/")) {
          const builtIn = builtInImageDimensions(validatedMime, prefix);
          const external = options.imageGuard
            ? await options.imageGuard({ mime: validatedMime, prefix, totalBytes: total })
            : undefined;
          image = { ...builtIn, ...external };
          enforceImageLimits(image, options);
          if (image.requiresManualReview) {
            decision = { state: "quarantine", reason: "manual_review_required" };
          } else if (!image.width || !image.height || image.decompressedBytes === undefined) {
            decision = { state: "quarantine", reason: "image_guard_pending" };
          }
        }
        settled = true;
        resolveInspection({
          filename: normalizedFilename,
          mime: validatedMime,
          size: total,
          sha256: hash.digest("hex"),
          decision,
          image,
        });
      } catch (error) {
        fail(error);
      }
    },
    cancel(reason) {
      if (!settled) {
        settled = true;
        rejectInspection(
          reason ?? new UploadSecurityError("upload_cancelled", "Upload was cancelled"),
        );
      }
    },
  });
  return { stream: source.pipeThrough(transform), inspection };
}
