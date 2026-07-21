import { createEmbeddings } from "../../api/src/embeddings.ts";
import {
  type EmbeddingBillingConfig,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  knowledgeEmbeddingIdentityVersion,
  parseEmbeddingBillingConfig,
} from "@dg-chat/database";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface KnowledgeEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  upstreamModel: string;
  version: string;
  batchSize: number;
  billing: EmbeddingBillingConfig;
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
  const baseVersion = env.KNOWLEDGE_EMBEDDING_VERSION?.trim() || model;
  if (!baseUrl && !apiKey && !model) return undefined;
  const batchSize = Number(env.KNOWLEDGE_EMBEDDING_BATCH_SIZE ?? 64);
  if (
    !baseUrl || !apiKey || !model || !upstreamModel || !baseVersion || !VERSION.test(baseVersion) ||
    model.length > 200 || upstreamModel.length > 200 ||
    !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256
  ) throw new Error("Knowledge embedding configuration is incomplete or invalid");
  const url = new URL(baseUrl);
  const testHttpAllowed = env.DENO_ENV === "test" && url.protocol === "http:" &&
    env.OPENAI_TEST_ALLOW_HTTP_HOST?.trim().toLowerCase() === url.hostname.toLowerCase();
  if (
    (url.protocol !== "https:" && !testHttpAllowed) || url.username || url.password ||
    url.search || url.hash
  ) {
    throw new Error("KNOWLEDGE_EMBEDDING_BASE_URL must be a credential-free HTTPS URL");
  }
  const version = knowledgeEmbeddingIdentityVersion({
    baseVersion,
    baseUrl,
    model,
    upstreamModel,
    batchSize,
  });
  return {
    baseUrl,
    apiKey,
    model,
    upstreamModel,
    version,
    batchSize,
    billing: parseEmbeddingBillingConfig(env),
  };
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

export function validateKnowledgeEmbeddings(
  embeddings: number[][],
  expectedItems: number,
): number[][] {
  if (
    embeddings.length !== expectedItems ||
    embeddings.some((vector) =>
      vector.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
      vector.some((part) => typeof part !== "number" || !Number.isFinite(part))
    )
  ) throw new Error("Embedding provider returned invalid vectors");
  return embeddings;
}

export async function embedKnowledgeChunks(
  content: string[],
  config: KnowledgeEmbeddingConfig,
  signal: AbortSignal,
): Promise<{ embeddings: number[][]; inputTokens: number }> {
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
  const embeddings = response.data.map((item) => {
    if (!Array.isArray(item.embedding)) throw new Error("Embedding provider returned base64 data");
    return item.embedding;
  });
  return {
    embeddings: validateKnowledgeEmbeddings(embeddings, content.length),
    inputTokens: response.usage.prompt_tokens,
  };
}
