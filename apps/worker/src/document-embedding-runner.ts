import type { ClaimedDocumentEmbeddingExecution, DomainRepository } from "@dg-chat/database";
import { DomainError } from "@dg-chat/database";
import type { EmbeddingsResponse, ProviderExecutionEngine } from "@dg-chat/provider-runtime";
import {
  assertCurrentDocumentChunkSet,
  batchDocumentEmbeddingChunks,
  DOCUMENT_EMBEDDING_DIMENSIONS,
  parseDocumentEmbeddingPayload,
} from "./document-embedding.ts";
import type { ClaimedJob } from "./job-queue.ts";

function vectors(response: EmbeddingsResponse, chunkIds: readonly string[]) {
  if (response.data.length !== chunkIds.length) throw new Error("Embedding cardinality changed");
  return response.data.map((item, index) => {
    if (
      !Array.isArray(item.embedding) || item.index !== index ||
      item.embedding.length !== DOCUMENT_EMBEDDING_DIMENSIONS
    ) {
      throw new Error("Embedding provider returned an incompatible vector");
    }
    return { chunkId: chunkIds[index], embedding: item.embedding };
  });
}

async function observed(repository: DomainRepository, usageRunId: string) {
  const attempts = await repository.listProviderAttempts(usageRunId);
  return attempts.filter((attempt) => attempt.status !== "skipped").reduce(
    (total, attempt) => ({
      costMicros: total.costMicros + attempt.costMicros,
      inputTokens: total.inputTokens + attempt.inputTokens,
      latencyMs: total.latencyMs + (attempt.latencyMs ?? 0),
    }),
    { costMicros: 0, inputTokens: 0, latencyMs: 0 },
  );
}

export async function runDocumentEmbeddingJob(input: {
  job: ClaimedJob;
  repository: DomainRepository;
  engine: ProviderExecutionEngine;
  signal?: AbortSignal;
}): Promise<void> {
  let claimed: ClaimedDocumentEmbeddingExecution | undefined;
  try {
    const payload = parseDocumentEmbeddingPayload(input.job.payload);
    claimed = await input.repository.claimDocumentEmbeddingExecution(
      input.job.id,
      input.job.claimToken,
    );
    const execution = claimed;
    if (
      claimed.attachmentId !== payload.attachmentId || claimed.ownerId !== payload.ownerId ||
      claimed.chunkSetDigest !== payload.chunkSetDigest || claimed.modelId !== payload.modelId ||
      claimed.configVersion !== payload.configVersion
    ) throw new DomainError("validation_error", "Embedding job payload differs", 422);
    await assertCurrentDocumentChunkSet(payload, claimed.chunks);
    if (claimed.status === "result_ready") {
      await input.repository.finalizeDocumentEmbedding(input.job.id, input.job.claimToken);
      return;
    }
    const [batch] = batchDocumentEmbeddingChunks(claimed.chunks);
    const chunkIds = batch.map((chunk) => chunk.id);
    await input.engine.embeddings(
      claimed.modelId,
      claimed.usageRunId,
      claimed.runLeaseToken,
      {
        model: claimed.modelId,
        input: batch.map((chunk) => chunk.content),
        encoding_format: "float",
        dimensions: DOCUMENT_EMBEDDING_DIMENSIONS,
      },
      input.signal ?? new AbortController().signal,
      claimed.planSnapshot,
      async ({ response }) => {
        const usage = await observed(input.repository, execution.usageRunId);
        await input.repository.persistDocumentEmbeddingResult({
          jobId: input.job.id,
          jobClaimToken: input.job.claimToken,
          runLeaseToken: execution.runLeaseToken,
          vectors: vectors(response, chunkIds),
          ...usage,
        });
      },
    );
    await input.repository.finalizeDocumentEmbedding(input.job.id, input.job.claimToken);
  } catch (error) {
    if (!claimed) {
      await input.repository.failDocumentEmbedding({
        jobId: input.job.id,
        jobClaimToken: input.job.claimToken,
        error: error instanceof Error ? error.message : String(error),
        billing: { mode: "refund" },
      });
      return;
    }
    const usage = await observed(input.repository, claimed.usageRunId);
    await input.repository.failDocumentEmbedding({
      jobId: input.job.id,
      jobClaimToken: input.job.claimToken,
      error: error instanceof Error ? error.message : String(error),
      billing: usage.costMicros > 0 ? { mode: "settle", ...usage } : { mode: "refund" },
    });
  }
}
