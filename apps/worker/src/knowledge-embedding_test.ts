import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  parseDocumentEmbeddingPayload,
  parseKnowledgeEmbeddingConfig,
  sha256,
} from "./knowledge-embedding.ts";

Deno.test("knowledge embedding configuration is disabled cleanly and validates complete HTTPS config", () => {
  assertEquals(parseKnowledgeEmbeddingConfig({}), undefined);
  assertThrows(() => parseKnowledgeEmbeddingConfig({ KNOWLEDGE_EMBEDDING_MODEL: "embed" }));
  assertThrows(() =>
    parseKnowledgeEmbeddingConfig({
      KNOWLEDGE_EMBEDDING_BASE_URL: "http://provider.example/v1",
      KNOWLEDGE_EMBEDDING_API_KEY: "secret",
      KNOWLEDGE_EMBEDDING_MODEL: "embed",
    })
  );
  assertEquals(
    parseKnowledgeEmbeddingConfig({
      KNOWLEDGE_EMBEDDING_BASE_URL: "https://provider.example/v1",
      KNOWLEDGE_EMBEDDING_API_KEY: "secret",
      KNOWLEDGE_EMBEDDING_MODEL: "public-embed",
      KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL: "upstream-embed",
      KNOWLEDGE_EMBEDDING_VERSION: "embed-v2",
      KNOWLEDGE_EMBEDDING_BATCH_SIZE: "32",
    }),
    {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "public-embed",
      upstreamModel: "upstream-embed",
      version: "embed-v2",
      batchSize: 32,
      billing: { inputMicrosPerMillion: 0, fixedCallMicros: 0 },
    },
  );
});

Deno.test("document embedding payload and content digest are deterministic", async () => {
  const payload = {
    attachmentId: "11111111-1111-4111-8111-111111111111",
    ownerId: "22222222-2222-4222-8222-222222222222",
    version: "embed-v1",
  };
  assertEquals(parseDocumentEmbeddingPayload(payload), payload);
  assertThrows(() => parseDocumentEmbeddingPayload({ ...payload, extra: true }));
  assertEquals(
    await sha256("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});
