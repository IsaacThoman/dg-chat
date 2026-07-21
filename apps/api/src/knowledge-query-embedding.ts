import {
  type EmbeddingBillingConfig,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  knowledgeEmbeddingIdentityVersion,
  parseEmbeddingBillingConfig,
} from "@dg-chat/database";
import { createEmbeddings, type ProviderFetch } from "./embeddings.ts";

export interface KnowledgeQueryEmbedding {
  embedding: number[];
  version: string;
  inputTokens: number;
  provider: string;
  model: string;
  upstreamModel: string;
  billing: EmbeddingBillingConfig;
}

export type KnowledgeQueryEmbedder =
  & ((
    query: string,
    signal?: AbortSignal,
  ) => Promise<KnowledgeQueryEmbedding>)
  & {
    readonly provider: string;
    readonly model: string;
    readonly upstreamModel: string;
    readonly billing: EmbeddingBillingConfig;
  };

/** Creates the query side of the same versioned embedding pipeline used by the worker. */
export function knowledgeQueryEmbedderFromEnv(
  env: Record<string, string | undefined>,
  providerFetch?: ProviderFetch,
): KnowledgeQueryEmbedder | undefined {
  const baseUrl = env.KNOWLEDGE_EMBEDDING_BASE_URL?.trim();
  const apiKey = env.KNOWLEDGE_EMBEDDING_API_KEY?.trim();
  const model = env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  const upstreamModel = env.KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL?.trim() || model;
  const baseVersion = env.KNOWLEDGE_EMBEDDING_VERSION?.trim() || model;
  const batchSize = Number(env.KNOWLEDGE_EMBEDDING_BATCH_SIZE ?? 64);
  if (!baseUrl && !apiKey && !model) return undefined;
  if (
    !baseUrl || !apiKey || !model || !upstreamModel || !baseVersion ||
    !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256
  ) {
    throw new Error("Knowledge embedding configuration is incomplete");
  }
  const timeoutMs = Number(env.KNOWLEDGE_EMBEDDING_QUERY_TIMEOUT_MS ?? 10_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("KNOWLEDGE_EMBEDDING_QUERY_TIMEOUT_MS must be between 100 and 60000");
  }
  const billing = parseEmbeddingBillingConfig(env);
  const provider = new URL(baseUrl).host;
  // The worker persists vectors under an identity that includes its effective batch size.
  // Query vectors must use the exact same identity or PostgreSQL correctly excludes every
  // otherwise-compatible stored vector from semantic retrieval.
  const version = knowledgeEmbeddingIdentityVersion({
    baseVersion,
    baseUrl,
    model,
    upstreamModel,
    batchSize,
  });
  const embed = async (query: string, signal?: AbortSignal) => {
    const normalized = query.trim().slice(0, 8_000);
    if (!normalized) throw new Error("Knowledge embedding query is empty");
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await createEmbeddings(
      {
        model,
        input: normalized,
        dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      },
      {
        baseUrl,
        apiKey,
        upstreamModel,
        publicModel: model,
        signal: combined,
        fetch: providerFetch,
      },
    );
    const embedding = response.data[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("Embedding provider returned base64 data");
    return {
      embedding,
      version,
      inputTokens: response.usage.prompt_tokens,
      provider,
      model,
      upstreamModel,
      billing,
    };
  };
  return Object.assign(embed, { provider, model, upstreamModel, billing });
}
