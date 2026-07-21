import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import { knowledgeEmbeddingIdentityVersion } from "@dg-chat/database";
import { parseKnowledgeEmbeddingConfig } from "../../worker/src/knowledge-embedding.ts";
import { knowledgeQueryEmbedderFromEnv } from "./knowledge-query-embedding.ts";

const env = {
  KNOWLEDGE_EMBEDDING_BASE_URL: "https://provider.example/v1",
  KNOWLEDGE_EMBEDDING_API_KEY: "secret",
  KNOWLEDGE_EMBEDDING_MODEL: "embed-public",
  KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL: "embed-upstream",
  KNOWLEDGE_EMBEDDING_VERSION: "embed-v3",
  KNOWLEDGE_EMBEDDING_BATCH_SIZE: "64",
};

Deno.test("query embedder sends bounded version-compatible requests", async () => {
  let observed: Record<string, unknown> | undefined;
  const embed = knowledgeQueryEmbedderFromEnv(env, (_url, init) => {
    observed = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({
      object: "list",
      data: [{ object: "embedding", embedding: Array(1536).fill(0.25), index: 0 }],
      model: "ignored",
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }));
  })!;
  const result = await embed("  turbine reset  ");
  assertEquals(observed, {
    model: "embed-upstream",
    input: "turbine reset",
    dimensions: 1536,
    encoding_format: "float",
  });
  assertEquals(
    result.version,
    knowledgeEmbeddingIdentityVersion({
      baseVersion: "embed-v3",
      baseUrl: "https://provider.example/v1",
      model: "embed-public",
      upstreamModel: "embed-upstream",
      batchSize: 64,
    }),
  );
  assertEquals(
    result.version,
    parseKnowledgeEmbeddingConfig(env)?.version,
    "API query and worker document embeddings must share an identity",
  );
  assertEquals(result.inputTokens, 2);
  assertEquals(result.billing, { inputMicrosPerMillion: 0, fixedCallMicros: 0 });
  assertEquals(result.embedding.length, 1536);
});

Deno.test("query embedder rejects partial config and propagates cancellation", async () => {
  assertEquals(knowledgeQueryEmbedderFromEnv({}), undefined);
  assertThrows(() => knowledgeQueryEmbedderFromEnv({ KNOWLEDGE_EMBEDDING_MODEL: "incomplete" }));
  assertThrows(() =>
    knowledgeQueryEmbedderFromEnv({ ...env, KNOWLEDGE_EMBEDDING_BATCH_SIZE: "0" })
  );
  const embed = knowledgeQueryEmbedderFromEnv(env, async (_url, init) => {
    await new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    );
    throw new Error("unreachable");
  })!;
  const controller = new AbortController();
  const pending = embed("query", controller.signal);
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assertRejects(() => pending, DOMException);
});

Deno.test("query embedding identity tracks the worker batch identity", async () => {
  const provider = () =>
    Promise.resolve(Response.json({
      object: "list",
      data: [{ object: "embedding", embedding: Array(1536).fill(0.25), index: 0 }],
      model: "ignored",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
  const first = knowledgeQueryEmbedderFromEnv(env, provider)!;
  const changed = knowledgeQueryEmbedderFromEnv(
    { ...env, KNOWLEDGE_EMBEDDING_BATCH_SIZE: "32" },
    provider,
  )!;
  const [firstResult, changedResult] = await Promise.all([first("query"), changed("query")]);
  assertNotEquals(firstResult.version, changedResult.version);
  assertNotEquals(
    changedResult.version,
    knowledgeEmbeddingIdentityVersion({
      baseVersion: "embed-v3",
      baseUrl: "https://provider.example/v1",
      model: "embed-public",
      upstreamModel: "embed-upstream",
      batchSize: 64,
    }),
  );
  assertEquals(
    changedResult.version,
    knowledgeEmbeddingIdentityVersion({
      baseVersion: "embed-v3",
      baseUrl: "https://provider.example/v1",
      model: "embed-public",
      upstreamModel: "embed-upstream",
      batchSize: 32,
    }),
  );
});
