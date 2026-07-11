import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "@dg-chat/database";
import { createEmbeddings, type ProviderFetch } from "./embeddings.ts";

export interface KnowledgeQueryEmbedding {
  embedding: number[];
  version: string;
}

export type KnowledgeQueryEmbedder = (
  query: string,
  signal?: AbortSignal,
) => Promise<KnowledgeQueryEmbedding>;

/** Creates the query side of the same versioned embedding pipeline used by the worker. */
export function knowledgeQueryEmbedderFromEnv(
  env: Record<string, string | undefined>,
  providerFetch?: ProviderFetch,
): KnowledgeQueryEmbedder | undefined {
  const baseUrl = env.KNOWLEDGE_EMBEDDING_BASE_URL?.trim();
  const apiKey = env.KNOWLEDGE_EMBEDDING_API_KEY?.trim();
  const model = env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  const upstreamModel = env.KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL?.trim() || model;
  const version = env.KNOWLEDGE_EMBEDDING_VERSION?.trim() || model;
  if (!baseUrl && !apiKey && !model) return undefined;
  if (!baseUrl || !apiKey || !model || !upstreamModel || !version) {
    throw new Error("Knowledge embedding configuration is incomplete");
  }
  const timeoutMs = Number(env.KNOWLEDGE_EMBEDDING_QUERY_TIMEOUT_MS ?? 10_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("KNOWLEDGE_EMBEDDING_QUERY_TIMEOUT_MS must be between 100 and 60000");
  }
  return async (query, signal) => {
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
    return { embedding, version };
  };
}
