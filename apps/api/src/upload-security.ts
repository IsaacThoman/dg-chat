import { createHash } from "node:crypto";
import { DOCX_MIME_TYPE, INGESTIBLE_DOCUMENT_MIME_TYPES } from "@dg-chat/database";

export type UploadDecision =
  | { state: "ready"; reason: "validated" }
  | {
    state: "quarantine";
    reason: "image_guard_pending" | "manual_review_required" | "security_scan_inconclusive";
  };

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
  ...INGESTIBLE_DOCUMENT_MIME_TYPES,
  "audio/mpeg",
  "audio/flac",
  "audio/mp4",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
]);

const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/x-wav": "audio/wav",
  "audio/x-flac": "audio/flac",
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
  [DOCX_MIME_TYPE]: "docx",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
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

function containsAscii(bytes: Uint8Array, marker: string): boolean {
  if (!marker.length || bytes.length < marker.length) return false;
  const first = marker.charCodeAt(0);
  outer: for (let offset = 0; offset <= bytes.length - marker.length; offset++) {
    if (bytes[offset] !== first) continue;
    for (let index = 1; index < marker.length; index++) {
      if (bytes[offset + index] !== marker.charCodeAt(index)) continue outer;
    }
    return true;
  }
  return false;
}

function mpegAudioFrameLength(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
    return undefined;
  }
  const versionBits = (bytes[offset + 1] >> 3) & 0x03;
  const layerBits = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
  if (
    versionBits === 0x01 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 0x0f ||
    sampleRateIndex === 0x03
  ) return undefined;

  const version = versionBits === 0x03 ? 1 : versionBits === 0x02 ? 2 : 2.5;
  const layer = 4 - layerBits;
  const mpeg1Bitrates = layer === 1
    ? [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
    : layer === 2
    ? [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
    : [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Bitrates = layer === 1
    ? [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
    : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrateKbps = (version === 1 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex - 1];
  const baseSampleRates = [44_100, 48_000, 32_000];
  const sampleRate = baseSampleRates[sampleRateIndex] / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const padding = (bytes[offset + 2] >> 1) & 1;
  const length = layer === 1
    ? Math.floor((12 * bitrateKbps * 1_000 / sampleRate) + padding) * 4
    : Math.floor(
      ((layer === 3 && version !== 1 ? 72 : 144) * bitrateKbps * 1_000 / sampleRate) + padding,
    );
  return Number.isSafeInteger(length) && length >= 4 ? length : undefined;
}

function mp3Audio(bytes: Uint8Array, totalBytes: number): boolean {
  let frameOffset = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    if (bytes.length < 10) return false;
    const version = bytes[3];
    if (version < 2 || version > 4 || bytes[4] === 0xff) return false;
    const sizeBytes = bytes.subarray(6, 10);
    if (sizeBytes.some((value) => (value & 0x80) !== 0)) return false;
    const tagSize = sizeBytes.reduce((size, value) => size * 128 + value, 0);
    const footerSize = version === 4 && (bytes[5] & 0x10) !== 0 ? 10 : 0;
    frameOffset = 10 + tagSize + footerSize;
    if (
      !Number.isSafeInteger(frameOffset) || frameOffset > totalBytes || frameOffset > bytes.length
    ) {
      return false;
    }
  }
  const frameLength = mpegAudioFrameLength(bytes, frameOffset);
  return frameLength !== undefined && frameOffset + frameLength <= bytes.length &&
    frameOffset + frameLength <= totalBytes;
}

function ebmlVint(bytes: Uint8Array, offset: number, maximumLength: number): {
  length: number;
  value: number;
  unknown: boolean;
} | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  let marker = 0x80;
  let length = 1;
  while (!(first & marker) && length <= maximumLength) {
    marker >>= 1;
    length++;
  }
  if (length > maximumLength || offset + length > bytes.length) return undefined;
  let value = first & (marker - 1);
  let unknown = value === marker - 1;
  for (let index = 1; index < length; index++) {
    value = value * 256 + bytes[offset + index];
    unknown &&= bytes[offset + index] === 0xff;
    if (!Number.isSafeInteger(value)) return undefined;
  }
  return { length, value, unknown };
}

function ebmlElement(bytes: Uint8Array, offset: number, end: number): {
  id: string;
  dataStart: number;
  dataEnd: number;
} | undefined {
  const idVint = ebmlVint(bytes, offset, 4);
  if (!idVint) return undefined;
  const idBytes = bytes.subarray(offset, offset + idVint.length);
  const id = [...idBytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  const size = ebmlVint(bytes, offset + idVint.length, 8);
  if (!size || size.unknown) return undefined;
  const dataStart = offset + idVint.length + size.length;
  const dataEnd = dataStart + size.value;
  return dataEnd <= end ? { id, dataStart, dataEnd } : undefined;
}

function webmAudioContainer(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  const headerSize = ebmlVint(bytes, 4, 8);
  if (!headerSize || headerSize.unknown) return false;
  const headerStart = 4 + headerSize.length;
  const headerEnd = headerStart + headerSize.value;
  if (headerEnd > bytes.length) return false;
  let docType = false;
  for (let offset = headerStart; offset < headerEnd;) {
    const element = ebmlElement(bytes, offset, headerEnd);
    if (!element) return false;
    if (element.id === "4282") {
      docType = ascii(bytes, element.dataStart, element.dataEnd - element.dataStart) === "webm";
    }
    offset = element.dataEnd;
  }
  if (!docType || !startsWith(bytes, [0x18, 0x53, 0x80, 0x67], headerEnd)) return false;
  const segmentSize = ebmlVint(bytes, headerEnd + 4, 8);
  if (!segmentSize) return false;
  let offset = headerEnd + 4 + segmentSize.length;
  const segmentEnd = segmentSize.unknown
    ? bytes.length
    : Math.min(bytes.length, offset + segmentSize.value);
  while (offset < segmentEnd) {
    const element = ebmlElement(bytes, offset, segmentEnd);
    if (!element) return false;
    if (element.id === "1654ae6b") {
      for (let trackOffset = element.dataStart; trackOffset < element.dataEnd;) {
        const track = ebmlElement(bytes, trackOffset, element.dataEnd);
        if (!track) return false;
        if (track.id === "ae") {
          let audio = false;
          let codec = false;
          for (let fieldOffset = track.dataStart; fieldOffset < track.dataEnd;) {
            const field = ebmlElement(bytes, fieldOffset, track.dataEnd);
            if (!field) return false;
            if (field.id === "83" && field.dataEnd - field.dataStart === 1) {
              audio = bytes[field.dataStart] === 2;
            }
            if (field.id === "86") {
              const value = ascii(bytes, field.dataStart, field.dataEnd - field.dataStart);
              codec = ["A_OPUS", "A_VORBIS", "A_FLAC", "A_AAC", "A_MPEG/L3"]
                .includes(value) || value.startsWith("A_PCM/");
            }
            fieldOffset = field.dataEnd;
          }
          if (audio && codec) return true;
        }
        trackOffset = track.dataEnd;
      }
    }
    offset = element.dataEnd;
  }
  return false;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

interface Mp4Box {
  type: string;
  dataStart: number;
  end: number;
}

function mp4Children(bytes: Uint8Array, start: number, end: number): Mp4Box[] | undefined {
  const result: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) return undefined;
    const size = u32be(bytes, offset);
    // Extended-size boxes are unnecessary for bounded metadata and complicate safe arithmetic.
    if (size === 1 || size < 8 || offset + size > end) return undefined;
    result.push({ type: ascii(bytes, offset + 4, 4), dataStart: offset + 8, end: offset + size });
    offset += size;
  }
  return result;
}

function mp4SoundTrack(bytes: Uint8Array): boolean {
  const moov = mp4Children(bytes, 8, bytes.length);
  if (!moov) return false;
  for (const trak of moov.filter((box) => box.type === "trak")) {
    const trakChildren = mp4Children(bytes, trak.dataStart, trak.end);
    if (!trakChildren) continue;
    for (const mdia of trakChildren.filter((box) => box.type === "mdia")) {
      const mediaChildren = mp4Children(bytes, mdia.dataStart, mdia.end);
      if (!mediaChildren) continue;
      for (const handler of mediaChildren.filter((box) => box.type === "hdlr")) {
        // hdlr is a FullBox: version/flags, pre-defined, then the four-byte handler type.
        if (
          handler.dataStart + 12 <= handler.end &&
          ascii(bytes, handler.dataStart + 8, 4) === "soun"
        ) return true;
      }
    }
  }
  return false;
}

function mp4Window(
  prefix: Uint8Array,
  suffix: Uint8Array,
  totalBytes: number,
  absoluteOffset: number,
  length: number,
): Uint8Array | undefined {
  if (!Number.isSafeInteger(absoluteOffset) || !Number.isSafeInteger(length) || length < 0) {
    return undefined;
  }
  if (absoluteOffset >= 0 && absoluteOffset + length <= prefix.length) {
    return prefix.subarray(absoluteOffset, absoluteOffset + length);
  }
  const suffixStart = totalBytes - suffix.length;
  if (absoluteOffset >= suffixStart && absoluteOffset + length <= totalBytes) {
    const local = absoluteOffset - suffixStart;
    return suffix.subarray(local, local + length);
  }
  return undefined;
}

function mp4AudioContainer(
  prefix: Uint8Array,
  suffix: Uint8Array,
  totalBytes: number,
): boolean {
  const first = mp4Window(prefix, suffix, totalBytes, 0, 16);
  if (!first || ascii(first, 4, 4) !== "ftyp") return false;
  const ftypSize = u32be(first, 0);
  if (ftypSize < 16 || ftypSize > totalBytes) return false;
  const brand = ascii(prefix, 8, 4);
  const knownBrand = ["M4A ", "M4B ", "M4P ", "isom", "iso2", "mp41", "mp42"]
    .includes(brand);
  if (!knownBrand) return false;
  // Walk declared top-level boxes by absolute offset. This lets us jump over a large `mdat` while
  // still inspecting a tail `moov`, without accepting forged box names embedded in media bytes.
  let offset = 0;
  let boxes = 0;
  while (offset < totalBytes && boxes++ < 4096) {
    const header = mp4Window(prefix, suffix, totalBytes, offset, 8);
    if (!header) return false;
    const size = u32be(header, 0);
    const type = ascii(header, 4, 4);
    // Extended-size boxes are rejected rather than performing arithmetic on attacker-controlled
    // 64-bit values. A zero size consumes the rest of the file and therefore cannot precede moov.
    if (size === 1 || (size !== 0 && size < 8)) return false;
    const boxSize = size === 0 ? totalBytes - offset : size;
    if (!Number.isSafeInteger(boxSize) || offset + boxSize > totalBytes) return false;
    if (type === "moov") {
      const box = mp4Window(prefix, suffix, totalBytes, offset, boxSize);
      return !!box && mp4SoundTrack(box);
    }
    offset += boxSize;
  }
  return false;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | bytes[offset + 1] << 8;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 |
    bytes[offset + 3] << 24) >>> 0;
}

function docxFromCentralDirectory(
  prefix: Uint8Array,
  suffix: Uint8Array,
  totalBytes: number,
): boolean {
  if (!startsWith(prefix, [0x50, 0x4b, 0x03, 0x04])) return false;
  let eocd = -1;
  for (let offset = suffix.length - 22; offset >= Math.max(0, suffix.length - 65_557); offset--) {
    if (u32(suffix, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 + u16(suffix, eocd + 20) !== suffix.length) return false;
  const count = u16(suffix, eocd + 10);
  if (
    u16(suffix, eocd + 4) !== 0 || u16(suffix, eocd + 6) !== 0 ||
    u16(suffix, eocd + 8) !== count || count === 0xffff
  ) return false;
  const size = u32(suffix, eocd + 12);
  const absoluteOffset = u32(suffix, eocd + 16);
  if (size === 0xffffffff || absoluteOffset === 0xffffffff) return false;
  const suffixStart = totalBytes - suffix.length;
  const directoryOffset = absoluteOffset - suffixStart;
  if (directoryOffset < 0 || directoryOffset + size !== eocd) return false;
  const names = new Set<string>();
  const lowerNames = new Set<string>();
  let offset = directoryOffset;
  try {
    for (let index = 0; index < count; index++) {
      if (offset + 46 > eocd || u32(suffix, offset) !== 0x02014b50) return false;
      const nameLength = u16(suffix, offset + 28);
      const extraLength = u16(suffix, offset + 30);
      const commentLength = u16(suffix, offset + 32);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > eocd) return false;
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        suffix.subarray(offset + 46, offset + 46 + nameLength),
      );
      const lowerName = name.toLowerCase();
      if (!name || names.has(name) || lowerNames.has(lowerName)) return false;
      names.add(name);
      lowerNames.add(lowerName);
      offset = end;
    }
  } catch {
    return false;
  }
  if (offset !== eocd) return false;
  const forbidden = [...lowerNames].some((name) =>
    name.startsWith("ppt/") || name.startsWith("xl/") ||
    name.endsWith("vbaproject.bin") || name.startsWith("word/activex/") ||
    name.startsWith("word/embeddings/") || name.startsWith("customui/") ||
    /\.(?:exe|dll|com|bat|cmd|ps1|js|jse|vbs|vbe|wsf|wsh|scr|msi)$/.test(name)
  );
  return !forbidden && names.has("[Content_Types].xml") && names.has("word/document.xml");
}

function sniffMime(
  prefix: Uint8Array,
  suffix: Uint8Array,
  totalBytes: number,
): string | undefined {
  const bytes = prefix;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (mp3Audio(bytes, totalBytes)) return "audio/mpeg";
  if (ascii(bytes, 0, 4) === "fLaC" && bytes.length >= 8) return "audio/flac";
  if (mp4AudioContainer(bytes, suffix, totalBytes)) return "audio/mp4";
  if (webmAudioContainer(bytes)) return "audio/webm";
  if (
    ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE" &&
    containsAscii(bytes, "fmt ") && containsAscii(bytes, "data")
  ) return "audio/wav";
  if (
    ascii(bytes, 0, 4) === "OggS" &&
    ["OpusHead", "vorbis", "Speex   ", "fLaC"].some((marker) => containsAscii(bytes, marker))
  ) return "audio/ogg";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return docxFromCentralDirectory(prefix, suffix, totalBytes) ? DOCX_MIME_TYPE : undefined;
  }
  if (startsWith(bytes, [0x4d, 0x5a])) {
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

interface StreamMarkers {
  dangerousMarkup: boolean;
  secondaryZip: boolean;
  executable: boolean;
}

interface PeCandidate {
  offset: number;
  header: number[];
}

export interface PeScanState {
  headers: Map<number, PeCandidate[]>;
  signatures: Map<number, number[]>;
  candidates: number;
  terminal: boolean;
  inconclusive: boolean;
  work: number;
}

export function createPeScanState(): PeScanState {
  return {
    headers: new Map(),
    signatures: new Map(),
    candidates: 0,
    terminal: false,
    inconclusive: false,
    work: 0,
  };
}

export function scanEmbeddedPe(
  bytes: Uint8Array,
  absoluteStart: number,
  state: PeScanState,
  previousByte: number | undefined,
  maxBytes: number,
): { detected: boolean; previousByte: number } {
  if (state.terminal) return { detected: false, previousByte: bytes.at(-1) ?? previousByte! };
  const maxWork = 100_000;
  let detected = false;
  for (let index = 0; index < bytes.length; index++) {
    const absolute = absoluteStart + index;
    const byte = bytes[index];
    const signatures = state.signatures.get(absolute);
    if (signatures) {
      state.signatures.delete(absolute);
      for (const progress of signatures) {
        state.work++;
        if (state.work > maxWork) {
          state.inconclusive = true;
          state.terminal = true;
          break;
        }
        const expected = [0x50, 0x45, 0, 0];
        if (byte !== expected[progress]) state.candidates--;
        else if (progress + 1 === expected.length) {
          detected = true;
          state.candidates--;
        } else {
          const next = state.signatures.get(absolute + 1) ?? [];
          next.push(progress + 1);
          state.signatures.set(absolute + 1, next);
        }
      }
    }
    if (state.terminal) break;
    const headers = state.headers.get(absolute);
    if (headers) {
      state.headers.delete(absolute);
      for (const candidate of headers) {
        state.work++;
        if (state.work > maxWork) {
          state.inconclusive = true;
          state.terminal = true;
          break;
        }
        candidate.header.push(byte);
        if (candidate.header.length === 64) {
          const header = new Uint8Array(candidate.header);
          const relative = u32(header, 0x3c);
          if (relative < 64 || candidate.offset + relative + 4 > maxBytes) {
            state.candidates--;
            continue;
          }
          const signatureOffset = candidate.offset + relative;
          const pending = state.signatures.get(signatureOffset) ?? [];
          pending.push(0);
          state.signatures.set(signatureOffset, pending);
        } else {
          const next = state.headers.get(absolute + 1) ?? [];
          next.push(candidate);
          state.headers.set(absolute + 1, next);
        }
      }
    }
    if (state.terminal) break;
    if (previousByte === 0x4d && byte === 0x5a && absolute - 1 >= 8) {
      if (state.candidates >= 1024) {
        state.inconclusive = true;
        state.terminal = true;
      } else {
        const next = state.headers.get(absolute + 1) ?? [];
        next.push({ offset: absolute - 1, header: [0x4d, 0x5a] });
        state.headers.set(absolute + 1, next);
        state.candidates++;
      }
    }
    previousByte = byte;
    if (detected || state.inconclusive) {
      state.terminal = true;
      state.headers.clear();
      state.signatures.clear();
      state.candidates = 0;
      break;
    }
  }
  if (state.inconclusive) {
    state.headers.clear();
    state.signatures.clear();
    state.candidates = 0;
  }
  return { detected, previousByte: previousByte! };
}

function hasPolyglotMarkers(markers: StreamMarkers, mime: string): boolean {
  if (mime === "text/plain" || mime === "application/json") return false;
  if (mime === DOCX_MIME_TYPE) return false;
  return markers.dangerousMarkup || markers.secondaryZip || markers.executable;
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
  const suffixChunks: Uint8Array[] = [];
  const completeValidationChunks: Uint8Array[] = [];
  let prefixSize = 0;
  let suffixSize = 0;
  let total = 0;
  const markers: StreamMarkers = {
    dangerousMarkup: false,
    secondaryZip: false,
    executable: false,
  };
  let markerCarry = new Uint8Array();
  const peState = createPeScanState();
  let previousByte: number | undefined;
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
        const scan = new Uint8Array(markerCarry.length + chunk.length);
        scan.set(markerCarry);
        scan.set(chunk, markerCarry.length);
        const scanStart = total - chunk.length - markerCarry.length;
        const scanText = new TextDecoder("latin1").decode(scan).toLowerCase();
        markers.dangerousMarkup ||= ["<script", "<!doctype html", "<html", "<?php", "<svg"]
          .some((marker) => scanText.includes(marker));
        let found = scanText.indexOf("pk\x03\x04");
        while (found >= 0) {
          if (scanStart + found >= 8) markers.secondaryZip = true;
          found = scanText.indexOf("pk\x03\x04", found + 1);
        }
        if (!markers.executable) {
          const peScan = scanEmbeddedPe(
            chunk,
            total - chunk.length,
            peState,
            previousByte,
            options.maxBytes,
          );
          markers.executable ||= peScan.detected;
          previousByte = peScan.previousByte;
        }
        markerCarry = scan.slice(Math.max(0, scan.length - 32));
        if (declared === "application/json" || declared === "application/octet-stream") {
          completeValidationChunks.push(chunk.slice());
        }
        const remaining = inspectionBytes - prefixSize;
        if (remaining > 0) {
          const part = chunk.slice(0, remaining);
          prefixChunks.push(part);
          prefixSize += part.byteLength;
        }
        suffixChunks.push(chunk.slice());
        suffixSize += chunk.byteLength;
        while (suffixSize > inspectionBytes && suffixChunks.length) {
          const excess = suffixSize - inspectionBytes;
          const first = suffixChunks[0];
          if (first.byteLength <= excess) {
            suffixSize -= first.byteLength;
            suffixChunks.shift();
          } else {
            suffixChunks[0] = first.slice(excess);
            suffixSize -= excess;
          }
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
        const suffix = new Uint8Array(suffixSize);
        offset = 0;
        for (const chunk of suffixChunks) {
          suffix.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const sniffed = sniffMime(prefix, suffix, total);
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
        if (validatedMime === "application/json") {
          const body = new Uint8Array(total);
          let bodyOffset = 0;
          for (const chunk of completeValidationChunks) {
            body.set(chunk, bodyOffset);
            bodyOffset += chunk.byteLength;
          }
          try {
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
          } catch {
            fail(new UploadSecurityError("invalid_json", "JSON upload is malformed", 422));
          }
        }
        if (hasPolyglotMarkers(markers, validatedMime)) {
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
        if (peState.inconclusive) {
          decision = { state: "quarantine", reason: "security_scan_inconclusive" };
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
