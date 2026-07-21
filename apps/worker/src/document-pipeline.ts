import type { DocumentChunkInput, DocumentProcessingConfig, StoredObject } from "@dg-chat/database";
import { DOCX_MIME_TYPE } from "@dg-chat/database";
import {
  deterministicChunks,
  readIngestionBytes,
  readIngestionText,
} from "./attachment-ingestion.ts";
import { type DocumentExtractionLimits, extractDocument } from "./document-extraction.ts";
import { DocumentExtractionError } from "./document-extraction.ts";
import { operationSignal, raceAbort } from "./operation-signal.ts";

const neverAbort = new AbortController().signal;

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

export function raceJobDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  parent: AbortSignal = neverAbort,
): Promise<T> {
  remainingDeadline(deadlineAt);
  const operation = operationSignal(
    parent,
    deadlineAt,
    () => new DocumentPipelineTimeoutError(),
  );
  return raceAbort(promise, operation.signal).finally(operation.dispose);
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
  signal: AbortSignal = neverAbort,
): Promise<ExtractionResult> {
  remainingDeadline(deadlineAt);
  signal.throwIfAborted();
  const cancellation = operationSignal(
    signal,
    deadlineAt,
    () => new DocumentPipelineTimeoutError(),
  );
  let worker: Worker;
  try {
    worker = createWorker();
  } catch (error) {
    // operationSignal owns a deadline timer. Worker construction is deliberately injectable and
    // can fail synchronously (permissions, resource exhaustion, malformed worker URL), before the
    // promise executor below has installed its normal finish path.
    cancellation.dispose();
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cancellation.signal.removeEventListener("abort", onAbort);
      cancellation.dispose();
      worker.terminate();
      complete();
    };
    const onAbort = () =>
      finish(() => reject(cancellation.signal.reason ?? new DOMException("Aborted", "AbortError")));
    cancellation.signal.addEventListener("abort", onAbort, { once: true });
    // Close the check/listener race without ever posting work after shutdown.
    if (cancellation.signal.aborted) {
      onAbort();
      return;
    }
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
  signal: AbortSignal = neverAbort,
): Promise<DocumentChunkInput[]> {
  signal.throwIfAborted();
  const cancellation = operationSignal(
    signal,
    deadlineAt,
    () => new DocumentPipelineTimeoutError(),
  );
  try {
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
          cancellation.signal,
        ),
        deadlineAt,
        cancellation.signal,
      );
      return await deterministicChunks({
        ...common,
        text,
        deadlineAt,
        signal: cancellation.signal,
      });
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
        cancellation.signal,
      ),
      deadlineAt,
      cancellation.signal,
    );
    const extracted = await extractDocumentIsolated(
      bytes,
      source.mimeType,
      {
        ...extractionLimits,
        timeoutMs: remainingTimeout(),
      },
      deadlineAt,
      undefined,
      cancellation.signal,
    );
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
      signal: cancellation.signal,
    });
  } finally {
    cancellation.dispose();
  }
}
