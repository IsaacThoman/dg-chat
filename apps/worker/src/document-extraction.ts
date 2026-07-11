import { Inflate, unzip } from "fflate";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api.d.ts";

export type DocumentExtractionErrorCode =
  | "unsupported_type"
  | "raw_bytes_exceeded"
  | "time_exceeded"
  | "output_exceeded"
  | "invalid_pdf"
  | "pdf_pages_exceeded"
  | "invalid_docx"
  | "zip_entries_exceeded"
  | "zip_entry_exceeded"
  | "zip_expansion_exceeded"
  | "zip_ratio_exceeded"
  | "zip_path_traversal"
  | "zip_encrypted"
  | "docx_macro"
  | "docx_active_content"
  | "docx_external_reference";

export class DocumentExtractionError extends Error {
  override name = "DocumentExtractionError";

  constructor(
    public readonly code: DocumentExtractionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ExtractedDocumentUnit {
  kind: "page" | "section";
  index: number;
  text: string;
  metadata: Record<string, string | number>;
}

export interface ExtractedDocument {
  mimeType:
    | "application/pdf"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  text: string;
  units: ExtractedDocumentUnit[];
  metadata: Record<string, string | number>;
}

export interface DocumentExtractionLimits {
  maxRawBytes?: number;
  timeoutMs?: number;
  maxOutputCharacters?: number;
  maxPdfPages?: number;
  maxZipEntries?: number;
  maxZipEntryBytes?: number;
  maxZipExpandedBytes?: number;
  maxZipCompressionRatio?: number;
}

type PdfTextItem = { str: string; hasEOL: boolean; transform: number[] };

/** Reconstructs PDF.js text items. `hasEOL` describes the break *after* its item. */
export function reconstructPdfText(items: readonly PdfTextItem[]): string {
  let text = "";
  let previousY: number | undefined;
  let previousEndedLine = false;
  for (const item of items) {
    const y = item.transform[5];
    const movedLine = previousY !== undefined && Math.abs(y - previousY) > 2;
    if (text && !text.endsWith("\n") && movedLine) text += "\n";
    else if (text && !text.endsWith("\n") && item.str && !previousEndedLine) text += " ";
    text += item.str;
    if (item.hasEOL && text && !text.endsWith("\n")) text += "\n";
    previousEndedLine = item.hasEOL;
    previousY = y;
  }
  return text.trim();
}

interface RequiredLimits {
  maxRawBytes: number;
  timeoutMs: number;
  maxOutputCharacters: number;
  maxPdfPages: number;
  maxZipEntries: number;
  maxZipEntryBytes: number;
  maxZipExpandedBytes: number;
  maxZipCompressionRatio: number;
}

const DEFAULTS: RequiredLimits = {
  maxRawBytes: 20 * 1024 * 1024,
  timeoutMs: 30_000,
  maxOutputCharacters: 2_000_000,
  maxPdfPages: 1_000,
  maxZipEntries: 2_000,
  maxZipEntryBytes: 25 * 1024 * 1024,
  maxZipExpandedBytes: 100 * 1024 * 1024,
  maxZipCompressionRatio: 200,
};

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const decoder = new TextDecoder();

function limits(input: DocumentExtractionLimits): RequiredLimits {
  const result = { ...DEFAULTS, ...input };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be non-negative`);
  }
  return result;
}

function deadline(limits: RequiredLimits): () => void {
  const end = performance.now() + limits.timeoutMs;
  return () => {
    if (performance.now() >= end) {
      throw new DocumentExtractionError("time_exceeded", "Document extraction timed out");
    }
  };
}

function assertRawSize(bytes: Uint8Array, value: RequiredLimits): void {
  if (bytes.byteLength > value.maxRawBytes) {
    throw new DocumentExtractionError("raw_bytes_exceeded", "Document exceeds the raw byte limit");
  }
}

function boundedText(parts: string[], value: RequiredLimits): string {
  const text = parts.filter(Boolean).join("\n\n");
  if (text.length > value.maxOutputCharacters) {
    throw new DocumentExtractionError("output_exceeded", "Extracted text exceeds the output limit");
  }
  return text;
}

function raceDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(
      new DocumentExtractionError("time_exceeded", "Document extraction timed out"),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DocumentExtractionError("time_exceeded", "Document extraction timed out")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function extractPdf(
  bytes: Uint8Array,
  options: DocumentExtractionLimits = {},
): Promise<ExtractedDocument> {
  const value = limits(options);
  assertRawSize(bytes, value);
  const started = performance.now();
  let document: PDFDocumentProxy | undefined;
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    loadingTask = getDocument({ data: bytes.slice(), useSystemFonts: false });
    document = await raceDeadline(loadingTask.promise, value.timeoutMs);
    if (document.numPages > value.maxPdfPages) {
      throw new DocumentExtractionError(
        "pdf_pages_exceeded",
        `PDF has ${document.numPages} pages; the limit is ${value.maxPdfPages}`,
      );
    }
    const pageLabels = await raceDeadline(
      document.getPageLabels(),
      value.timeoutMs - (performance.now() - started),
    );
    const units: ExtractedDocumentUnit[] = [];
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const remaining = value.timeoutMs - (performance.now() - started);
      const page = await raceDeadline(document.getPage(pageNumber), remaining);
      const content = await raceDeadline(page.getTextContent(), remaining);
      const text = reconstructPdfText(content.items.filter((item) => "str" in item));
      texts.push(text);
      boundedText(texts, value);
      const viewport = page.getViewport({ scale: 1 });
      const metadata: Record<string, string | number> = {
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
      };
      const pageLabel = pageLabels?.[pageNumber - 1];
      if (pageLabel) metadata.pageLabel = pageLabel;
      units.push({
        kind: "page",
        index: pageNumber,
        text,
        metadata,
      });
      page.cleanup();
    }
    return {
      mimeType: "application/pdf",
      text: boundedText(texts, value),
      units,
      metadata: { pageCount: document.numPages },
    };
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError("invalid_pdf", "PDF could not be safely parsed", {
      cause: error,
    });
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
  }
}

interface ZipEntry {
  name: string;
  compressed: number;
  expanded: number;
  flags: number;
  method: number;
  crc32: number;
  localOffset: number;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function zipEntries(bytes: Uint8Array, value: RequiredLimits): ZipEntry[] {
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (u32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new DocumentExtractionError("invalid_docx", "DOCX ZIP directory is missing");
  const count = u16(bytes, eocd + 10);
  const disk = u16(bytes, eocd + 4);
  const directoryDisk = u16(bytes, eocd + 6);
  const diskCount = u16(bytes, eocd + 8);
  const directorySize = u32(bytes, eocd + 12);
  const directoryOffset = u32(bytes, eocd + 16);
  const commentLength = u16(bytes, eocd + 20);
  if (disk !== 0 || directoryDisk !== 0 || diskCount !== count) {
    throw new DocumentExtractionError("invalid_docx", "Multi-disk DOCX archives are not supported");
  }
  if (eocd + 22 + commentLength !== bytes.length) {
    throw new DocumentExtractionError("invalid_docx", "DOCX ZIP footer is malformed");
  }
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new DocumentExtractionError("invalid_docx", "ZIP64 DOCX archives are not supported");
  }
  if (count > value.maxZipEntries) {
    throw new DocumentExtractionError("zip_entries_exceeded", "DOCX has too many ZIP entries");
  }
  if (directoryOffset + directorySize > eocd || directoryOffset > bytes.length) {
    throw new DocumentExtractionError("invalid_docx", "DOCX ZIP directory is malformed");
  }
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) {
      throw new DocumentExtractionError("invalid_docx", "DOCX ZIP entry is malformed");
    }
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const crc32 = u32(bytes, offset + 16);
    const compressed = u32(bytes, offset + 20);
    const expanded = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) {
      throw new DocumentExtractionError("invalid_docx", "DOCX ZIP entry is truncated");
    }
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (
      !name || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name) ||
      name.split("/").some((part) => part === ".." || part === ".")
    ) {
      throw new DocumentExtractionError("zip_path_traversal", "DOCX contains an unsafe ZIP path");
    }
    if (name.includes("\0") || names.has(name)) {
      throw new DocumentExtractionError(
        "invalid_docx",
        "DOCX contains a duplicate or invalid ZIP entry name",
      );
    }
    names.add(name);
    if (flags & 1) {
      throw new DocumentExtractionError("zip_encrypted", "Encrypted DOCX entries are not allowed");
    }
    if (flags & 8) {
      throw new DocumentExtractionError(
        "invalid_docx",
        "DOCX ZIP data descriptors are not supported",
      );
    }
    if (expanded > value.maxZipEntryBytes) {
      throw new DocumentExtractionError("zip_entry_exceeded", "A DOCX ZIP entry is too large");
    }
    total += expanded;
    if (total > value.maxZipExpandedBytes) {
      throw new DocumentExtractionError(
        "zip_expansion_exceeded",
        "DOCX expanded data exceeds the limit",
      );
    }
    if (expanded > 0 && expanded / Math.max(1, compressed) > value.maxZipCompressionRatio) {
      throw new DocumentExtractionError("zip_ratio_exceeded", "DOCX compression ratio is unsafe");
    }
    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) {
      throw new DocumentExtractionError("invalid_docx", "DOCX ZIP local entry is malformed");
    }
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const localEnd = localOffset + 30 + localNameLength + localExtraLength + compressed;
    const localName = decoder.decode(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (
      localEnd > directoryOffset || localName !== name || u16(bytes, localOffset + 6) !== flags ||
      u16(bytes, localOffset + 8) !== method || u32(bytes, localOffset + 14) !== crc32 ||
      u32(bytes, localOffset + 18) !== compressed || u32(bytes, localOffset + 22) !== expanded
    ) {
      throw new DocumentExtractionError(
        "invalid_docx",
        "DOCX ZIP local and central entries disagree",
      );
    }
    entries.push({ name, compressed, expanded, flags, method, crc32, localOffset });
    offset = end;
  }
  if (offset !== directoryOffset + directorySize) {
    throw new DocumentExtractionError("invalid_docx", "DOCX ZIP directory size is inconsistent");
  }
  return entries;
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function updateCrc32(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return crc >>> 0;
}

function assertActualInflation(
  archive: Uint8Array,
  entries: ZipEntry[],
  value: RequiredLimits,
): void {
  let total = 0;
  for (const entry of entries) {
    const nameLength = u16(archive, entry.localOffset + 26);
    const extraLength = u16(archive, entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressed;
    let expanded = 0;
    let crc = 0xffffffff;
    const count = (chunk: Uint8Array) => {
      expanded += chunk.byteLength;
      crc = updateCrc32(crc, chunk);
      if (expanded > value.maxZipEntryBytes) {
        throw new DocumentExtractionError("zip_entry_exceeded", "A DOCX ZIP entry is too large");
      }
      if (expanded / Math.max(1, entry.compressed) > value.maxZipCompressionRatio) {
        throw new DocumentExtractionError("zip_ratio_exceeded", "DOCX compression ratio is unsafe");
      }
    };
    if (entry.method === 0) {
      count(archive.subarray(start, end));
    } else if (entry.method === 8) {
      const inflater = new Inflate((chunk) => count(chunk));
      // Small input increments bound the amount a hostile stream can inflate before
      // the output callback enforces limits. Hard timeout isolation is layered above.
      const inputIncrement = 128;
      for (let cursor = start; cursor < end; cursor += inputIncrement) {
        inflater.push(
          archive.subarray(cursor, Math.min(end, cursor + inputIncrement)),
          cursor + inputIncrement >= end,
        );
      }
    } else {
      throw new DocumentExtractionError(
        "invalid_docx",
        "DOCX uses an unsupported compression method",
      );
    }
    if (expanded !== entry.expanded) {
      throw new DocumentExtractionError(
        "invalid_docx",
        "DOCX ZIP entry size does not match its directory metadata",
      );
    }
    if ((crc ^ 0xffffffff) >>> 0 !== entry.crc32) {
      throw new DocumentExtractionError("invalid_docx", "DOCX ZIP entry checksum is invalid");
    }
    total += expanded;
    if (total > value.maxZipExpandedBytes) {
      throw new DocumentExtractionError(
        "zip_expansion_exceeded",
        "DOCX expanded data exceeds the limit",
      );
    }
  }
}

function xmlText(value: string): string {
  return value
    .replace(/<w:tab\b[^>]*\/?\s*>/gi, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/w:p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number: string) => String.fromCodePoint(parseInt(number, 16)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number: string) => String.fromCodePoint(parseInt(number, 16)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

const WORDPROCESSING_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const OFFICE_NAMESPACES = new Set([
  ...WORDPROCESSING_NAMESPACES,
  "urn:schemas-microsoft-com:office:office",
]);
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/package/2006/relationships",
  "http://purl.oclc.org/ooxml/package/relationships",
]);

function xmlNamespaces(xml: string): Map<string, Set<string>> {
  const namespaces = new Map<string, Set<string>>();
  for (const match of xml.matchAll(/\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*["']([^"']+)["']/gi)) {
    const prefix = match[1] ?? "";
    const values = namespaces.get(prefix) ?? new Set<string>();
    values.add(decodeXmlEntities(match[2]));
    namespaces.set(prefix, values);
  }
  return namespaces;
}

function prefixUses(
  namespaces: Map<string, Set<string>>,
  prefix: string | undefined,
  allowed: Set<string>,
): boolean {
  const values = namespaces.get(prefix ?? "");
  return Boolean(values && [...values].some((value) => allowed.has(value)));
}

function relationshipPath(part: string): string {
  const slash = part.lastIndexOf("/");
  const directory = slash < 0 ? "" : part.slice(0, slash + 1);
  const basename = part.slice(slash + 1);
  return `${directory}_rels/${basename}.rels`;
}

function relationshipAttributes(xml: string): string[] {
  const namespaces = xmlNamespaces(xml);
  return [...xml.matchAll(
    /<([A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/?\s*>/gi,
  )].filter((match) =>
    prefixUses(namespaces, match[1]?.slice(0, -1), PACKAGE_RELATIONSHIP_NAMESPACES)
  ).map((match) => match[2]);
}

function resolveRelationshipTarget(part: string, target: string): string | undefined {
  if (!target || target.startsWith("/") || target.includes("\\")) return undefined;
  const slash = part.lastIndexOf("/");
  const base = slash < 0 ? [] : part.slice(0, slash).split("/");
  const path = decodeURIComponent(target).split(/[?#]/, 1)[0];
  for (const component of path.split("/")) {
    if (!component || component === ".") continue;
    if (component === "..") {
      if (!base.length) return undefined;
      base.pop();
    } else base.push(component);
  }
  return base.join("/");
}

function reachableXmlParts(files: Record<string, Uint8Array>): Set<string> {
  const reached = new Set<string>();
  const queue = ["word/document.xml"];
  while (queue.length) {
    const part = queue.shift()!;
    if (reached.has(part)) continue;
    reached.add(part);
    const relationships = files[relationshipPath(part)];
    if (!relationships) continue;
    const xml = decodeXmlEntities(decoder.decode(relationships));
    for (const attributes of relationshipAttributes(xml)) {
      if (/\bTargetMode\s*=\s*["']External["']/i.test(attributes)) continue;
      const target = attributes.match(/\bTarget\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!target) continue;
      let resolved: string | undefined;
      try {
        resolved = resolveRelationshipTarget(part, target);
      } catch {
        throw new DocumentExtractionError("invalid_docx", "DOCX relationship target is invalid");
      }
      if (!resolved) {
        throw new DocumentExtractionError(
          "invalid_docx",
          "DOCX relationship target traverses root",
        );
      }
      if (resolved && files[resolved] && resolved.toLowerCase().endsWith(".xml")) {
        queue.push(resolved);
      }
    }
  }
  return reached;
}

function assertNoActiveOfficeXml(xml: string): void {
  const namespaces = xmlNamespaces(xml);
  const complex: string[] = [];
  for (
    const match of xml.matchAll(
      /<([A-Za-z_][\w.-]*:)?instrText\b[^>]*>([\s\S]*?)<\/([A-Za-z_][\w.-]*:)?instrText\s*>/gi,
    )
  ) {
    const prefix = match[1]?.slice(0, -1);
    if (prefixUses(namespaces, prefix, WORDPROCESSING_NAMESPACES)) {
      complex.push(decodeXmlEntities(match[2]).replace(/<[^>]*>/g, ""));
    }
  }
  const simple: string[] = [];
  for (
    const match of xml.matchAll(
      /<([A-Za-z_][\w.-]*:)?fldSimple\b([^>]*)>/gi,
    )
  ) {
    const elementPrefix = match[1]?.slice(0, -1);
    if (!prefixUses(namespaces, elementPrefix, WORDPROCESSING_NAMESPACES)) continue;
    const instruction = match[2].match(
      /\b([A-Za-z_][\w.-]*:)?instr\s*=\s*["']([^"']*)["']/i,
    );
    if (!instruction) continue;
    const attributePrefix = instruction[1]?.slice(0, -1);
    if (prefixUses(namespaces, attributePrefix, WORDPROCESSING_NAMESPACES)) {
      simple.push(decodeXmlEntities(instruction[2]));
    }
  }
  const activeObject = [...xml.matchAll(
    /<([A-Za-z_][\w.-]*:)?(?:OLEObject|object)\b/gi,
  )].some((match) => prefixUses(namespaces, match[1]?.slice(0, -1), OFFICE_NAMESPACES));
  if (
    [complex.join(""), ...simple].some((value) => /\bDDE(?:AUTO)?\b/i.test(value)) || activeObject
  ) {
    throw new DocumentExtractionError(
      "docx_active_content",
      "DDE-enabled DOCX fields are not allowed",
    );
  }
}

function assertSafeDocx(entries: ZipEntry[], files: Record<string, Uint8Array>): void {
  const names = new Set(entries.map((entry) => entry.name));
  const lowerNames = entries.map((entry) => entry.name.toLowerCase());
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) {
    throw new DocumentExtractionError(
      "invalid_docx",
      "DOCX required package parts must use canonical names",
    );
  }
  const rootRelationships = files["_rels/.rels"];
  if (!rootRelationships) {
    throw new DocumentExtractionError("invalid_docx", "DOCX root relationships are missing");
  }
  const rootXml = decodeXmlEntities(decoder.decode(rootRelationships));
  const mainTargets = relationshipAttributes(rootXml).filter((attributes) =>
    /\bType\s*=\s*["'][^"']*\/officeDocument["']/i.test(attributes) &&
    !/\bTargetMode\s*=\s*["']External["']/i.test(attributes)
  ).map((attributes) => attributes.match(/\bTarget\s*=\s*["']([^"']+)["']/i)?.[1])
    .filter((target): target is string => Boolean(target))
    .map((target) => resolveRelationshipTarget("", target));
  if (mainTargets.length !== 1 || mainTargets[0] !== "word/document.xml") {
    throw new DocumentExtractionError(
      "invalid_docx",
      "DOCX must have one canonical main document relationship",
    );
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (
      (name.toLowerCase().endsWith(".xml") || name.toLowerCase().endsWith(".rels")) &&
      /<!DOCTYPE\b|<!ENTITY\b/i.test(decoder.decode(bytes))
    ) {
      throw new DocumentExtractionError(
        "docx_active_content",
        "DOCX document type and entity declarations are not allowed",
      );
    }
  }
  if (lowerNames.some((name) => name.endsWith("vbaproject.bin") || name.includes("/macros/"))) {
    throw new DocumentExtractionError("docx_macro", "Macro-enabled DOCX files are not allowed");
  }
  const contentTypes = files["[Content_Types].xml"];
  const decodedContentTypes = decodeXmlEntities(decoder.decode(contentTypes));
  if (/macroEnabled|vbaProject/i.test(decodedContentTypes)) {
    throw new DocumentExtractionError("docx_macro", "Macro-enabled DOCX files are not allowed");
  }
  const activePart = lowerNames.some((name) =>
    name.startsWith("word/embeddings/") ||
    name.startsWith("word/activex/") ||
    name.startsWith("customui/") ||
    /(?:^|\/)(?:oleobject|package)(?:\.|\/|$)/i.test(name) ||
    /\.(?:exe|dll|com|bat|cmd|ps1|js|jse|vbs|vbe|wsf|wsh|scr|msi)$/i.test(name)
  );
  const activeContentType = /(?:activeX|oleObject|customUI|vnd\.microsoft\.portable-executable)/i
    .test(
      decodedContentTypes,
    );
  if (activePart || activeContentType) {
    throw new DocumentExtractionError(
      "docx_active_content",
      "Embedded or active DOCX content is not allowed",
    );
  }
  for (const name of reachableXmlParts(files)) {
    if (files[name]) assertNoActiveOfficeXml(decoder.decode(files[name]));
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.toLowerCase().endsWith(".rels")) continue;
    const relationships = decodeXmlEntities(decoder.decode(bytes));
    const attributes = relationshipAttributes(relationships);
    if (attributes.some((value) => /\bTargetMode\s*=\s*["']External["']/i.test(value))) {
      throw new DocumentExtractionError(
        "docx_external_reference",
        "External DOCX relationships are not allowed",
      );
    }
    const relationshipTypes = attributes.map((value) =>
      value.match(/\bType\s*=\s*["']([^"']+)["']/i)?.[1].toLowerCase()
    ).filter((value): value is string => Boolean(value));
    if (
      relationshipTypes.some((type) =>
        /\/(?:oleobject|package|embeddedpackage|attachedtemplate|attachedtoolbars|control|activex|customui|vbaproject)$/i
          .test(type)
      )
    ) {
      throw new DocumentExtractionError(
        "docx_active_content",
        "Active DOCX relationships are not allowed",
      );
    }
  }
}

function assertActualZipLimits(
  entries: ZipEntry[],
  files: Record<string, Uint8Array>,
  value: RequiredLimits,
): void {
  const expected = new Map(entries.map((entry) => [entry.name, entry]));
  let total = 0;
  for (const [name, bytes] of Object.entries(files)) {
    const entry = expected.get(name);
    if (!entry) {
      throw new DocumentExtractionError("invalid_docx", "DOCX inflated an undeclared ZIP entry");
    }
    if (bytes.byteLength !== entry.expanded) {
      throw new DocumentExtractionError(
        "invalid_docx",
        "DOCX ZIP entry size does not match its directory metadata",
      );
    }
    if (bytes.byteLength > value.maxZipEntryBytes) {
      throw new DocumentExtractionError("zip_entry_exceeded", "A DOCX ZIP entry is too large");
    }
    total += bytes.byteLength;
    if (total > value.maxZipExpandedBytes) {
      throw new DocumentExtractionError(
        "zip_expansion_exceeded",
        "DOCX expanded data exceeds the limit",
      );
    }
    if (
      bytes.byteLength > 0 &&
      bytes.byteLength / Math.max(1, entry.compressed) > value.maxZipCompressionRatio
    ) {
      throw new DocumentExtractionError("zip_ratio_exceeded", "DOCX compression ratio is unsafe");
    }
    expected.delete(name);
  }
  if (expected.size !== 0) {
    throw new DocumentExtractionError("invalid_docx", "DOCX ZIP entries are incomplete");
  }
}

function unzipWithDeadline(
  bytes: Uint8Array,
  timeoutMs: number,
): Promise<Record<string, Uint8Array>> {
  if (timeoutMs <= 0) {
    return Promise.reject(
      new DocumentExtractionError("time_exceeded", "Document extraction timed out"),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const state: { terminate?: () => void } = {};
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.terminate?.();
      reject(new DocumentExtractionError("time_exceeded", "Document extraction timed out"));
    }, timeoutMs);
    state.terminate = unzip(bytes, (error, files) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(files);
    });
  });
}

export async function extractDocx(
  bytes: Uint8Array,
  options: DocumentExtractionLimits = {},
): Promise<ExtractedDocument> {
  const value = limits(options);
  assertRawSize(bytes, value);
  const started = performance.now();
  const checkDeadline = deadline(value);
  try {
    const entries = zipEntries(bytes, value);
    checkDeadline();
    assertActualInflation(bytes, entries, value);
    checkDeadline();
    const files = await unzipWithDeadline(bytes, value.timeoutMs - (performance.now() - started));
    checkDeadline();
    assertActualZipLimits(entries, files, value);
    assertSafeDocx(entries, files);
    const documentBytes = files["word/document.xml"];
    if (!documentBytes) {
      throw new DocumentExtractionError("invalid_docx", "DOCX is missing word/document.xml");
    }
    const xml = decoder.decode(documentBytes);
    if (!/<w:document\b/i.test(xml)) {
      throw new DocumentExtractionError("invalid_docx", "DOCX document XML is malformed");
    }
    const rawSections = xml.split(/<w:sectPr\b[\s\S]*?<\/w:sectPr\s*>/gi);
    const sectionTexts = rawSections.map(xmlText).filter(Boolean);
    const text = boundedText(sectionTexts, value);
    const units = sectionTexts.map((sectionText, index): ExtractedDocumentUnit => ({
      kind: "section",
      index: index + 1,
      text: sectionText,
      metadata: { sectionNumber: index + 1 },
    }));
    return {
      mimeType: DOCX_MIME,
      text,
      units,
      metadata: { sectionCount: units.length, zipEntryCount: entries.length },
    };
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError("invalid_docx", "DOCX could not be safely parsed", {
      cause: error,
    });
  }
}

export function extractDocument(
  bytes: Uint8Array,
  mimeType: string,
  options: DocumentExtractionLimits = {},
): Promise<ExtractedDocument> {
  if (mimeType === "application/pdf") return extractPdf(bytes, options);
  if (mimeType === DOCX_MIME) return extractDocx(bytes, options);
  return Promise.reject(
    new DocumentExtractionError("unsupported_type", `Unsupported document type: ${mimeType}`),
  );
}
