import { createEmbeddings } from "../../api/src/embeddings.ts";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "@dg-chat/database";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface KnowledgeEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  upstreamModel: string;
  version: string;
  batchSize: number;
}

export interface DocumentEmbeddingPayload {
  attachmentId: string;
  ownerId: string;
  version: string;
}

export function parseKnowledgeEmbeddingConfig(
  env: Record<string, string | undefined>,
): KnowledgeEmbeddingConfig | undefined {
  const baseUrl = env.KNOWLEDGE_EMBEDDING_BASE_URL?.trim();
  const apiKey = env.KNOWLEDGE_EMBEDDING_API_KEY?.trim();
  const model = env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  const upstreamModel = env.KNOWLEDGE_EMBEDDING_UPSTREAM_MODEL?.trim() || model;
  const version = env.KNOWLEDGE_EMBEDDING_VERSION?.trim() || model;
  if (!baseUrl && !apiKey && !model) return undefined;
  const batchSize = Number(env.KNOWLEDGE_EMBEDDING_BATCH_SIZE ?? 64);
  if (
    !baseUrl || !apiKey || !model || !upstreamModel || !version || !VERSION.test(version) ||
    model.length > 200 || upstreamModel.length > 200 ||
    !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256
  ) throw new Error("Knowledge embedding configuration is incomplete or invalid");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("KNOWLEDGE_EMBEDDING_BASE_URL must be a credential-free HTTPS URL");
  }
  return { baseUrl, apiKey, model, upstreamModel, version, batchSize };
}

export function parseDocumentEmbeddingPayload(value: unknown): DocumentEmbeddingPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Document embedding payload is invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["attachmentId", "ownerId", "version"].includes(key)) ||
    typeof input.attachmentId !== "string" || !UUID.test(input.attachmentId) ||
    typeof input.ownerId !== "string" || !UUID.test(input.ownerId) ||
    typeof input.version !== "string" || !VERSION.test(input.version)
  ) throw new Error("Document embedding payload is invalid");
  return {
    attachmentId: input.attachmentId,
    ownerId: input.ownerId,
    version: input.version,
  };
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function embedKnowledgeChunks(
  content: string[],
  config: KnowledgeEmbeddingConfig,
  signal: AbortSignal,
): Promise<number[][]> {
  if (!content.length || content.length > config.batchSize) {
    throw new Error("Knowledge embedding batch is invalid");
  }
  const response = await createEmbeddings(
    {
      model: config.model,
      input: content,
      dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
      encoding_format: "float",
    },
    {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      upstreamModel: config.upstreamModel,
      publicModel: config.model,
      signal,
    },
  );
  return response.data.map((item) => {
    if (!Array.isArray(item.embedding)) throw new Error("Embedding provider returned base64 data");
    return item.embedding;
  });
}
