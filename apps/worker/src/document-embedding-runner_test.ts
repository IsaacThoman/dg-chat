import { assertEquals } from "jsr:@std/assert@1.0.14";
import type { DomainRepository } from "@dg-chat/database";
import type { ProviderExecutionEngine } from "@dg-chat/provider-runtime";
import { documentChunkSetSha256 } from "./document-embedding.ts";
import { runDocumentEmbeddingJob } from "./document-embedding-runner.ts";

Deno.test("result-ready embedding recovery finalizes without provider redispatch", async () => {
  const chunks = [{
    id: "00000000-0000-8000-8000-000000000010",
    ordinal: 0,
    content: "durable vector",
  }];
  const chunkSetDigest = await documentChunkSetSha256(chunks);
  const calls: string[] = [];
  const repository = {
    claimDocumentEmbeddingExecution() {
      calls.push("claim");
      return Promise.resolve({
        id: "00000000-0000-8000-8000-000000000099",
        jobId: "00000000-0000-8000-8000-000000000020",
        ownerId: "00000000-0000-8000-8000-000000000002",
        attachmentId: "00000000-0000-8000-8000-000000000001",
        chunkSetDigest,
        modelId: "provider/embed",
        configVersion: "knowledge-v1",
        usageRunId: "embedding-run",
        status: "result_ready" as const,
        createdAt: new Date().toISOString(),
        completedAt: null,
        runLeaseToken: "lease",
        chunks,
      });
    },
    finalizeDocumentEmbedding() {
      calls.push("finalize");
      return Promise.resolve({});
    },
  } as unknown as DomainRepository;
  const engine = {
    resolvePlan() {
      calls.push("provider");
      throw new Error("must not dispatch");
    },
  } as unknown as ProviderExecutionEngine;
  await runDocumentEmbeddingJob({
    job: {
      id: "00000000-0000-8000-8000-000000000020",
      type: "document.embed",
      attempts: 1,
      claimToken: "worker:claim",
      payload: {
        attachmentId: "00000000-0000-8000-8000-000000000001",
        ownerId: "00000000-0000-8000-8000-000000000002",
        chunkSetDigest,
        modelId: "provider/embed",
        configVersion: "knowledge-v1",
      },
    },
    repository,
    engine,
  });
  assertEquals(calls, ["claim", "finalize"]);
});

Deno.test("embedding dispatch uses the durably claimed provider plan snapshot", async () => {
  const chunks = [{
    id: "00000000-0000-8000-8000-000000000011",
    ordinal: 0,
    content: "frozen route",
  }];
  const chunkSetDigest = await documentChunkSetSha256(chunks);
  const frozenPlan = { sourceModelId: "model-id", routeVersion: 7, targets: [{ ordinal: 0 }] };
  let observedPlan: unknown;
  const repository = {
    claimDocumentEmbeddingExecution: () =>
      Promise.resolve({
        id: crypto.randomUUID(),
        jobId: "00000000-0000-8000-8000-000000000021",
        ownerId: "00000000-0000-8000-8000-000000000002",
        attachmentId: "00000000-0000-8000-8000-000000000001",
        chunkSetDigest,
        modelId: "model-id",
        configVersion: "knowledge-v1",
        usageRunId: "embedding-run",
        planSnapshot: frozenPlan,
        status: "running",
        createdAt: new Date().toISOString(),
        completedAt: null,
        runLeaseToken: "lease",
        chunks,
      }),
    listProviderAttempts: () =>
      Promise.resolve([{
        status: "succeeded",
        costMicros: 2,
        inputTokens: 1,
        latencyMs: 3,
      }]),
    persistDocumentEmbeddingResult: () => Promise.resolve({}),
    finalizeDocumentEmbedding: () => Promise.resolve({}),
  } as unknown as DomainRepository;
  const engine = {
    async embeddings(...args: unknown[]) {
      observedPlan = args[5];
      const persist = args[6] as (input: unknown) => Promise<void>;
      await persist({
        response: {
          object: "list",
          model: "model-id",
          data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
      });
      return {};
    },
  } as unknown as ProviderExecutionEngine;
  await runDocumentEmbeddingJob({
    job: {
      id: "00000000-0000-8000-8000-000000000021",
      type: "document.embed",
      attempts: 0,
      claimToken: "worker:claim",
      payload: {
        attachmentId: "00000000-0000-8000-8000-000000000001",
        ownerId: "00000000-0000-8000-8000-000000000002",
        chunkSetDigest,
        modelId: "model-id",
        configVersion: "knowledge-v1",
      },
    },
    repository,
    engine,
  });
  assertEquals(observedPlan, frozenPlan);
});
