export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Document formats the durable ingestion pipeline is prepared to extract.
 * Keep this allowlist exact: other ZIP-based Office formats and macro-enabled
 * documents must remain non-ingestible until their extractors are sandboxed.
 */
export const INGESTIBLE_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "application/json",
  "application/pdf",
  DOCX_MIME_TYPE,
]);

export function isIngestibleDocumentMime(mime: string): boolean {
  return INGESTIBLE_DOCUMENT_MIME_TYPES.has(mime);
}
