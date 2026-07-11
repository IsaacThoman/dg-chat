const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_DOCUMENT_PROCESSING_CONFIG = Object.freeze({
  chunkSizeChars: 4_000,
  chunkOverlapChars: 400,
  extractorVersion: "builtin-document-v1",
  chunkerVersion: "character-window-v1",
});

export interface DocumentProcessingConfig {
  chunkSizeChars: number;
  chunkOverlapChars: number;
  extractorVersion: string;
  chunkerVersion: string;
}

export interface DocumentProcessingEnvironment {
  DOCUMENT_CHUNK_SIZE_CHARS?: string;
  DOCUMENT_CHUNK_OVERLAP_CHARS?: string;
  DOCUMENT_EXTRACTOR_VERSION?: string;
  DOCUMENT_CHUNKER_VERSION?: string;
}

function integerSetting(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} is outside the safe range`);
  return parsed;
}

function versionSetting(name: string, value: string | undefined, fallback: string): string {
  const version = value ?? fallback;
  if (!VERSION_PATTERN.test(version)) {
    throw new TypeError(`${name} must be a 1-64 character version identifier`);
  }
  return version;
}

/** Parses one immutable ingestion configuration snapshot. Read this once at process startup. */
export function parseDocumentProcessingConfig(
  environment: DocumentProcessingEnvironment = {},
): Readonly<DocumentProcessingConfig> {
  const chunkSizeChars = integerSetting(
    "DOCUMENT_CHUNK_SIZE_CHARS",
    environment.DOCUMENT_CHUNK_SIZE_CHARS,
    DEFAULT_DOCUMENT_PROCESSING_CONFIG.chunkSizeChars,
  );
  const chunkOverlapChars = integerSetting(
    "DOCUMENT_CHUNK_OVERLAP_CHARS",
    environment.DOCUMENT_CHUNK_OVERLAP_CHARS,
    DEFAULT_DOCUMENT_PROCESSING_CONFIG.chunkOverlapChars,
  );
  if (chunkSizeChars < 256 || chunkSizeChars > 20_000) {
    throw new TypeError("DOCUMENT_CHUNK_SIZE_CHARS must be between 256 and 20000");
  }
  if (chunkOverlapChars < 0 || chunkOverlapChars >= chunkSizeChars) {
    throw new TypeError(
      "DOCUMENT_CHUNK_OVERLAP_CHARS must be non-negative and smaller than the chunk size",
    );
  }
  return Object.freeze({
    chunkSizeChars,
    chunkOverlapChars,
    extractorVersion: versionSetting(
      "DOCUMENT_EXTRACTOR_VERSION",
      environment.DOCUMENT_EXTRACTOR_VERSION,
      DEFAULT_DOCUMENT_PROCESSING_CONFIG.extractorVersion,
    ),
    chunkerVersion: versionSetting(
      "DOCUMENT_CHUNKER_VERSION",
      environment.DOCUMENT_CHUNKER_VERSION,
      DEFAULT_DOCUMENT_PROCESSING_CONFIG.chunkerVersion,
    ),
  });
}
