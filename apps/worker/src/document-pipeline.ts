import type { DocumentChunkInput, DocumentProcessingConfig, StoredObject } from "@dg-chat/database";
import { DOCX_MIME_TYPE } from "@dg-chat/database";
import {
  deterministicChunks,
  readIngestionBytes,
  readIngestionText,
} from "./attachment-ingestion.ts";
import { type DocumentExtractionLimits, extractDocument } from "./document-extraction.ts";
import { DocumentExtractionError } from "./document-extraction.ts";

export class DocumentPipelineTimeoutError extends Error {
  override name = "DocumentPipelineTimeoutError";
  constructor() {
    super("Document processing timed out");
  }
}

export function remainingDeadline(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new DocumentPipelineTimeoutError();
  return remaining;
}

export function raceJobDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = remainingDeadline(deadlineAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DocumentPipelineTimeoutError()), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

type ExtractionResult = Awaited<ReturnType<typeof extractDocument>>;

export function extractDocumentIsolated(
  bytes: Uint8Array,
  mimeType: string,
  limits: DocumentExtractionLimits,
  deadlineAt: number,
  createWorker: () => Worker = () =>
    new Worker(new URL("./extraction-worker.ts", import.meta.url).href, {
      type: "module",
      deno: { permissions: "none" },
    }),
): Promise<ExtractionResult> {
  const remaining = remainingDeadline(deadlineAt);
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      operation();
    };
    const timer = setTimeout(
      () => finish(() => reject(new DocumentPipelineTimeoutError())),
      remaining,
    );
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        ok: boolean;
        result?: ExtractionResult;
        error?: { name?: string; message?: string; code?: string };
      };
      if (message.ok && message.result) return finish(() => resolve(message.result!));
      finish(() => {
        const detail = message.error;
        if (detail?.code) {
          reject(
            new DocumentExtractionError(
              detail.code as DocumentExtractionError["code"],
              detail.message ?? "Document extraction failed",
            ),
          );
        } else reject(new Error(detail?.message ?? "Document extraction worker failed"));
      });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(new Error(event.message || "Document extraction worker crashed")));
    };
    const transferable = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice();
    worker.postMessage(
      { bytes: transferable, mimeType, limits },
      [transferable.buffer as ArrayBuffer],
    );
  });
}

export interface DocumentPipelineSource {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  object: StoredObject;
}

export async function buildDocumentChunks(
  source: DocumentPipelineSource,
  config: DocumentProcessingConfig,
  extractionLimits: DocumentExtractionLimits = {},
  deadlineAt = Date.now() + (extractionLimits.timeoutMs ?? 30_000),
): Promise<DocumentChunkInput[]> {
  const remainingTimeout = () => remainingDeadline(deadlineAt);
  const common = {
    attachmentId: source.attachmentId,
    filename: source.filename,
    mimeType: source.mimeType,
    sha256: source.sha256,
    chunkChars: config.chunkSizeChars,
    overlapChars: config.chunkOverlapChars,
    extractorVersion: config.extractorVersion,
    chunkerVersion: config.chunkerVersion,
  };
  if (source.mimeType === "text/plain" || source.mimeType === "application/json") {
    const text = await raceJobDeadline(
      readIngestionText(
        source.object,
        source.mimeType,
        extractionLimits.maxRawBytes ?? 4 * 1024 * 1024,
        remainingTimeout(),
        source.sha256,
      ),
      deadlineAt,
    );
    return await deterministicChunks({ ...common, text, deadlineAt });
  }
  if (source.mimeType !== "application/pdf" && source.mimeType !== DOCX_MIME_TYPE) {
    throw new Error(`Unsupported ingestion MIME type: ${source.mimeType}`);
  }
  const bytes = await raceJobDeadline(
    readIngestionBytes(
      source.object,
      extractionLimits.maxRawBytes ?? 20 * 1024 * 1024,
      remainingTimeout(),
      source.sha256,
    ),
    deadlineAt,
  );
  const extracted = await extractDocumentIsolated(bytes, source.mimeType, {
    ...extractionLimits,
    timeoutMs: remainingTimeout(),
  }, deadlineAt);
  remainingDeadline(deadlineAt);
  return await deterministicChunks({
    ...common,
    text: extracted.text,
    sourceUnits: extracted.units.map((unit) => ({
      text: unit.text,
      metadata: unit.kind === "page"
        ? {
          pageNumber: unit.index,
          ...(typeof unit.metadata.pageLabel === "string"
            ? { pageLabel: unit.metadata.pageLabel }
            : {}),
        }
        : { section: String(unit.index), sectionPath: [String(unit.index)] },
    })),
    deadlineAt,
  });
}
