import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  parseDocumentEmbeddingPayload,
  parseKnowledgeEmbeddingConfig,
  sha256,
  validateKnowledgeEmbeddings,
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
  assertThrows(() =>
    parseKnowledgeEmbeddingConfig({
      DENO_ENV: "test",
      OPENAI_TEST_ALLOW_HTTP_HOST: "different.example",
      KNOWLEDGE_EMBEDDING_BASE_URL: "http://provider.example/v1",
      KNOWLEDGE_EMBEDDING_API_KEY: "secret",
      KNOWLEDGE_EMBEDDING_MODEL: "embed",
    })
  );
  assertEquals(
    parseKnowledgeEmbeddingConfig({
      DENO_ENV: "test",
      OPENAI_TEST_ALLOW_HTTP_HOST: "provider.example",
      KNOWLEDGE_EMBEDDING_BASE_URL: "http://provider.example/v1",
      KNOWLEDGE_EMBEDDING_API_KEY: "secret",
      KNOWLEDGE_EMBEDDING_MODEL: "embed",
    })?.baseUrl,
    "http://provider.example/v1",
  );
  const config = parseKnowledgeEmbeddingConfig({
    KNOWLEDGE_EMBEDDING_BASE_URL: "https://provider.example/v1",
    KNOWLEDGE_EMBEDDING_API_KEY: "secret",
    KNOWLEDGE_EMBEDDING_MODEL: "public-embed",
    KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL: "upstream-embed",
    KNOWLEDGE_EMBEDDING_VERSION: "embed-v2",
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: "32",
  });
  assertEquals(config?.baseUrl, "https://provider.example/v1");
  assertEquals(config?.version.startsWith("embed-v2-"), true);
  const changed = parseKnowledgeEmbeddingConfig({
    KNOWLEDGE_EMBEDDING_BASE_URL: "https://provider.example/v1",
    KNOWLEDGE_EMBEDDING_API_KEY: "secret",
    KNOWLEDGE_EMBEDDING_MODEL: "public-embed",
    KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL: "different-upstream",
    KNOWLEDGE_EMBEDDING_VERSION: "embed-v2",
  });
  assertNotEquals(config?.version, changed?.version);
  const changedBatch = parseKnowledgeEmbeddingConfig({
    KNOWLEDGE_EMBEDDING_BASE_URL: "https://provider.example/v1",
    KNOWLEDGE_EMBEDDING_API_KEY: "secret",
    KNOWLEDGE_EMBEDDING_MODEL: "public-embed",
    KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL: "upstream-embed",
    KNOWLEDGE_EMBEDDING_VERSION: "embed-v2",
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: "16",
  });
  assertNotEquals(config?.version, changedBatch?.version);
});

Deno.test("knowledge embedding vectors are finite and exactly match the configured dimensions", () => {
  const valid = [Array(1536).fill(0)];
  assertEquals(validateKnowledgeEmbeddings(valid, 1), valid);
  assertThrows(() => validateKnowledgeEmbeddings([], 1));
  assertThrows(() => validateKnowledgeEmbeddings([[0]], 1));
  assertThrows(() => validateKnowledgeEmbeddings([Array(1536).fill(Number.NaN)], 1));
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
