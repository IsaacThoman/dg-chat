import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  DEFAULT_DOCUMENT_PROCESSING_CONFIG,
  parseDocumentProcessingConfig,
} from "./document-processing-config.ts";

Deno.test("document processing config has stable validated defaults", () => {
  const config = parseDocumentProcessingConfig();
  assertEquals(config, DEFAULT_DOCUMENT_PROCESSING_CONFIG);
  assertEquals(Object.isFrozen(config), true);
});

Deno.test("document processing config accepts an explicit versioned chunking snapshot", () => {
  assertEquals(
    parseDocumentProcessingConfig({
      DOCUMENT_CHUNK_SIZE_CHARS: "8192",
      DOCUMENT_CHUNK_OVERLAP_CHARS: "512",
      DOCUMENT_EXTRACTOR_VERSION: "pdf.js-4.2",
      DOCUMENT_CHUNKER_VERSION: "semantic-window_v2",
    }),
    {
      chunkSizeChars: 8192,
      chunkOverlapChars: 512,
      extractorVersion: "pdf.js-4.2",
      chunkerVersion: "semantic-window_v2",
    },
  );
});

Deno.test("document processing config rejects ambiguous or unsafe values", () => {
  for (
    const environment of [
      { DOCUMENT_CHUNK_SIZE_CHARS: "255" },
      { DOCUMENT_CHUNK_SIZE_CHARS: "02000" },
      { DOCUMENT_CHUNK_OVERLAP_CHARS: "4000" },
      { DOCUMENT_CHUNK_OVERLAP_CHARS: "-1" },
      { DOCUMENT_EXTRACTOR_VERSION: "spaces are ambiguous" },
      { DOCUMENT_CHUNKER_VERSION: "" },
    ]
  ) assertThrows(() => parseDocumentProcessingConfig(environment), TypeError);
});
