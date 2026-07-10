import type { DocumentChunkInput, DocumentProcessingConfig, StoredObject } from "@dg-chat/database";
import { DOCX_MIME_TYPE } from "@dg-chat/database";
import {
  deterministicChunks,
  readIngestionBytes,
  readIngestionText,
} from "./attachment-ingestion.ts";
import { type DocumentExtractionLimits, extractDocument } from "./document-extraction.ts";

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
): Promise<DocumentChunkInput[]> {
  const started = performance.now();
  const timeoutMs = extractionLimits.timeoutMs ?? 30_000;
  const remainingTimeout = () => Math.max(0, timeoutMs - (performance.now() - started));
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
    const text = await readIngestionText(
      source.object,
      source.mimeType,
      extractionLimits.maxRawBytes ?? 4 * 1024 * 1024,
      remainingTimeout(),
      source.sha256,
    );
    return await deterministicChunks({ ...common, text });
  }
  if (source.mimeType !== "application/pdf" && source.mimeType !== DOCX_MIME_TYPE) {
    throw new Error(`Unsupported ingestion MIME type: ${source.mimeType}`);
  }
  const bytes = await readIngestionBytes(
    source.object,
    extractionLimits.maxRawBytes ?? 20 * 1024 * 1024,
    remainingTimeout(),
    source.sha256,
  );
  const extracted = await extractDocument(bytes, source.mimeType, {
    ...extractionLimits,
    timeoutMs: remainingTimeout(),
  });
  return await deterministicChunks({
    ...common,
    text: extracted.text,
    sourceUnits: extracted.units.map((unit) => ({
      text: unit.text,
      metadata: unit.kind === "page"
        ? {
          pageNumber: unit.index,
          pageLabel: typeof unit.metadata.pageLabel === "string"
            ? unit.metadata.pageLabel
            : undefined,
        }
        : { section: String(unit.index), sectionPath: [String(unit.index)] },
    })),
  });
}
