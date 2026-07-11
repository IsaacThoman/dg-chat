import { Inflate, unzip } from "fflate";
import { type Document, DOMParser } from "@xmldom/xmldom";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api.d.ts";
// @ts-types="./canvas-geometry.d.ts"
import geometry from "@napi-rs/canvas/geometry";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfJs: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
  // PDF.js needs DOMMatrix at module load even for text-only extraction. Use the canvas package's
  // complete pure-JavaScript geometry implementation without loading its optional native renderer.
  if (!("DOMMatrix" in globalThis)) {
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: geometry.DOMMatrix,
      writable: true,
    });
  }
  return pdfJs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
}

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
  let loadingTask: ReturnType<PdfJs["getDocument"]> | undefined;
  try {
    const { getDocument } = await loadPdfJs();
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

const MAX_XML_PART_BYTES = 4 * 1024 * 1024;
const MAX_XML_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_XML_MARKERS = 100_000;
const MAX_XML_NODES = 150_000;
const MAX_XML_DEPTH = 256;

function bytePrefix(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function decodePackageXml(bytes: Uint8Array, name: string): string {
  if (bytes.byteLength > MAX_XML_PART_BYTES) {
    throw new DocumentExtractionError("invalid_docx", `DOCX XML part is too large: ${name}`);
  }
  let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  if (
    bytePrefix(bytes, [0xff, 0xfe]) ||
    bytePrefix(bytes, [0x3c, 0x00, 0x3f, 0x00])
  ) encoding = "utf-16le";
  else if (
    bytePrefix(bytes, [0xfe, 0xff]) ||
    bytePrefix(bytes, [0x00, 0x3c, 0x00, 0x3f])
  ) encoding = "utf-16be";
  let xml: string;
  try {
    xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentExtractionError("invalid_docx", `DOCX XML encoding is invalid: ${name}`);
  }
  const declaration = xml.slice(0, 512).match(
    /^\uFEFF?\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i,
  )?.[1].toLowerCase().replaceAll("_", "-");
  const allowed = encoding === "utf-8"
    ? new Set(["utf-8", "utf8"])
    : encoding === "utf-16le"
    ? new Set(["utf-16", "utf-16le"])
    : new Set(["utf-16", "utf-16be"]);
  if (declaration && !allowed.has(declaration)) {
    throw new DocumentExtractionError(
      "invalid_docx",
      `DOCX XML declaration conflicts with its byte encoding: ${name}`,
    );
  }
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    throw new DocumentExtractionError(
      "docx_active_content",
      "DOCX document type and entity declarations are not allowed",
    );
  }
  let markers = 0;
  for (let index = xml.indexOf("<"); index >= 0; index = xml.indexOf("<", index + 1)) {
    if (++markers > MAX_XML_MARKERS) {
      throw new DocumentExtractionError(
        "invalid_docx",
        `DOCX XML part has too many nodes: ${name}`,
      );
    }
  }
  return xml;
}

function assertXmlArchiveBudget(files: Record<string, Uint8Array>): void {
  let total = 0;
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.toLowerCase().endsWith(".xml") && !name.toLowerCase().endsWith(".rels")) continue;
    total += bytes.byteLength;
    if (total > MAX_XML_ARCHIVE_BYTES) {
      throw new DocumentExtractionError(
        "invalid_docx",
        "DOCX XML data exceeds the aggregate limit",
      );
    }
    // Decode and preflight before DOM allocation; the resulting string is released each iteration.
    decodePackageXml(bytes, name);
  }
}

interface TraversalNode {
  firstChild: TraversalNode | null;
  nextSibling: TraversalNode | null;
  attributes?: { length: number };
}

function assertDomBudget(document: Document, name: string): void {
  const stack: Array<{ node: TraversalNode; depth: number }> = [
    { node: document as unknown as TraversalNode, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    nodes += 1 + (node.attributes?.length ?? 0);
    if (nodes > MAX_XML_NODES || depth > MAX_XML_DEPTH) {
      throw new DocumentExtractionError(
        "invalid_docx",
        `DOCX XML structure is too complex: ${name}`,
      );
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
}

function parsePackageXml(bytes: Uint8Array, name: string): Document {
  const xml = decodePackageXml(bytes, name);
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      errors.push(`${level}: ${message}`);
    },
  }).parseFromString(xml, "application/xml");
  if (!document || !document.documentElement || errors.length) {
    throw new DocumentExtractionError("invalid_docx", `DOCX XML part is malformed: ${name}`);
  }
  assertDomBudget(document, name);
  return document;
}

function relationshipPath(part: string): string {
  const slash = part.lastIndexOf("/");
  const directory = slash < 0 ? "" : part.slice(0, slash + 1);
  const basename = part.slice(slash + 1);
  return `${directory}_rels/${basename}.rels`;
}

interface PackageRelationship {
  type: string;
  target: string;
  external: boolean;
}

function packageRelationships(document: Document): PackageRelationship[] {
  const relationships: PackageRelationship[] = [];
  for (const namespace of PACKAGE_RELATIONSHIP_NAMESPACES) {
    const nodes = document.getElementsByTagNameNS(namespace, "Relationship");
    for (let index = 0; index < nodes.length; index++) {
      const element = nodes.item(index)!;
      relationships.push({
        type: element.getAttribute("Type") ?? "",
        target: element.getAttribute("Target") ?? "",
        external: (element.getAttribute("TargetMode") ?? "").toLowerCase() === "external",
      });
    }
  }
  return relationships;
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

function reachableXmlParts(
  files: Record<string, Uint8Array>,
): Set<string> {
  const reached = new Set<string>();
  const queue = ["word/document.xml"];
  while (queue.length) {
    const part = queue.shift()!;
    if (reached.has(part)) continue;
    reached.add(part);
    const relationshipName = relationshipPath(part);
    const relationshipBytes = files[relationshipName];
    if (!relationshipBytes) continue;
    const relationships = parsePackageXml(relationshipBytes, relationshipName);
    for (const relationship of packageRelationships(relationships)) {
      if (relationship.external || !relationship.target) continue;
      let resolved: string | undefined;
      try {
        resolved = resolveRelationshipTarget(part, relationship.target);
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

function assertNoActiveOfficeXml(document: Document): void {
  const complex: string[] = [];
  const simple: string[] = [];
  let activeObject = false;
  for (const namespace of WORDPROCESSING_NAMESPACES) {
    const instructions = document.getElementsByTagNameNS(namespace, "instrText");
    for (let index = 0; index < instructions.length; index++) {
      complex.push(instructions.item(index)?.textContent ?? "");
    }
    const fields = document.getElementsByTagNameNS(namespace, "fldSimple");
    for (let index = 0; index < fields.length; index++) {
      const value = fields.item(index)?.getAttributeNS(namespace, "instr");
      if (value) simple.push(value);
    }
    activeObject ||= document.getElementsByTagNameNS(namespace, "object").length > 0;
  }
  for (const namespace of OFFICE_NAMESPACES) {
    activeObject ||= document.getElementsByTagNameNS(namespace, "OLEObject").length > 0;
  }
  if (
    [complex.join(""), ...simple].some((value) => /\bDDE(?:AUTO)?\b/i.test(value)) || activeObject
  ) {
    throw new DocumentExtractionError(
      "docx_active_content",
      "DDE-enabled DOCX fields are not allowed",
    );
  }
}

interface OfficeXmlNode extends TraversalNode {
  localName?: string | null;
  namespaceURI?: string | null;
  textContent?: string | null;
}

function wordDocumentSections(document: Document): string[] {
  const sections: string[] = [];
  let text = "";
  const append = (value: string) => {
    text += value;
  };
  const flush = () => {
    const normalized = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (normalized) sections.push(normalized);
    text = "";
  };
  const walk = (node: OfficeXmlNode, deferSectionBreak = false): boolean => {
    const word = node.namespaceURI !== null && node.namespaceURI !== undefined &&
      WORDPROCESSING_NAMESPACES.has(node.namespaceURI);
    if (word && node.localName === "t") {
      append(node.textContent ?? "");
      return false;
    }
    if (word && node.localName === "tab") append("\t");
    else if (word && (node.localName === "br" || node.localName === "cr")) append("\n");
    if (word && node.localName === "sectPr") {
      if (deferSectionBreak) return true;
      flush();
      return false;
    }
    const paragraph = word && node.localName === "p";
    let sectionBreak = false;
    for (
      let child = node.firstChild as OfficeXmlNode | null;
      child;
      child = child.nextSibling as OfficeXmlNode | null
    ) {
      sectionBreak = walk(child, deferSectionBreak || paragraph) || sectionBreak;
    }
    if (paragraph) {
      append("\n");
      if (sectionBreak) flush();
      return false;
    }
    return sectionBreak;
  };
  walk(document as unknown as OfficeXmlNode);
  flush();
  return sections;
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
  assertXmlArchiveBudget(files);
  const rootRelationships = files["_rels/.rels"];
  if (!rootRelationships) {
    throw new DocumentExtractionError("invalid_docx", "DOCX root relationships are missing");
  }
  const rootDocument = parsePackageXml(rootRelationships, "_rels/.rels");
  const mainTargets = packageRelationships(rootDocument).filter((relationship) =>
    /\/officeDocument$/i.test(relationship.type) && !relationship.external && relationship.target
  ).map((relationship) => relationship.target)
    .map((target) => resolveRelationshipTarget("", target));
  if (mainTargets.length !== 1 || mainTargets[0] !== "word/document.xml") {
    throw new DocumentExtractionError(
      "invalid_docx",
      "DOCX must have one canonical main document relationship",
    );
  }
  if (lowerNames.some((name) => name.endsWith("vbaproject.bin") || name.includes("/macros/"))) {
    throw new DocumentExtractionError("docx_macro", "Macro-enabled DOCX files are not allowed");
  }
  const contentTypes = files["[Content_Types].xml"];
  const decodedContentTypes = decodeXmlEntities(
    decodePackageXml(contentTypes, "[Content_Types].xml"),
  );
  parsePackageXml(contentTypes, "[Content_Types].xml");
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
    const bytes = files[name];
    if (bytes) assertNoActiveOfficeXml(parsePackageXml(bytes, name));
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.toLowerCase().endsWith(".rels")) continue;
    const relationships = packageRelationships(
      name === "_rels/.rels" ? rootDocument : parsePackageXml(bytes, name),
    );
    if (relationships.some((relationship) => relationship.external)) {
      throw new DocumentExtractionError(
        "docx_external_reference",
        "External DOCX relationships are not allowed",
      );
    }
    const relationshipTypes = relationships.map((relationship) => relationship.type.toLowerCase());
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
    const document = parsePackageXml(documentBytes, "word/document.xml");
    const documentElement = document.documentElement!;
    if (
      !WORDPROCESSING_NAMESPACES.has(documentElement.namespaceURI ?? "") ||
      documentElement.localName !== "document"
    ) {
      throw new DocumentExtractionError("invalid_docx", "DOCX document XML is malformed");
    }
    const sectionTexts = wordDocumentSections(document);
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
