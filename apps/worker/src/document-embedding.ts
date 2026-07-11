import type { DocumentChunk } from "@dg-chat/database";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DOCUMENT_EMBEDDING_DIMENSIONS = 1536;
export const DOCUMENT_EMBEDDING_MAX_BATCH_INPUTS = 2_048;
export const DOCUMENT_EMBEDDING_MAX_BATCH_CHARACTERS = 2_000_000;

export function validateWorkerJobLeaseSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5) {
    throw new Error("WORKER_JOB_LEASE_SECONDS must be an integer of at least 5 seconds");
  }
  return value;
}

export function embeddingHeartbeatIntervalMs(leaseSeconds: number): number {
  validateWorkerJobLeaseSeconds(leaseSeconds);
  return Math.min(leaseSeconds * 1_000 - 2_000, Math.floor(leaseSeconds * 1_000 / 3));
}

export interface DocumentEmbeddingConfig {
  modelId: string;
  configVersion: string;
}

export interface DocumentEmbeddingPayload extends DocumentEmbeddingConfig {
  attachmentId: string;
  ownerId: string;
  chunkSetDigest: string;
}

export function parseDocumentEmbeddingConfig(
  env: Pick<typeof Deno.env, "get"> = Deno.env,
): DocumentEmbeddingConfig | undefined {
  const modelId = env.get("DOCUMENT_EMBEDDING_MODEL_ID")?.trim();
  const configVersion = env.get("DOCUMENT_EMBEDDING_CONFIG_VERSION")?.trim();
  if (!modelId && !configVersion) return undefined;
  if (!modelId || modelId.length > 255) {
    throw new Error("DOCUMENT_EMBEDDING_MODEL_ID must contain 1 to 255 characters");
  }
  if (!configVersion || !VERSION.test(configVersion)) {
    throw new Error("DOCUMENT_EMBEDDING_CONFIG_VERSION is invalid");
  }
  return { modelId, configVersion };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Document embedding payload is invalid");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > max ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`Document embedding ${name} is invalid`);
  }
  return value;
}

export function parseDocumentEmbeddingPayload(value: unknown): DocumentEmbeddingPayload {
  const input = record(value);
  const expected = new Set([
    "attachmentId",
    "ownerId",
    "chunkSetDigest",
    "modelId",
    "configVersion",
  ]);
  if (Object.keys(input).some((key) => !expected.delete(key)) || expected.size) {
    throw new TypeError("Document embedding payload is invalid");
  }
  return {
    attachmentId: text(input.attachmentId, "attachment ID", 36, UUID),
    ownerId: text(input.ownerId, "owner ID", 36, UUID),
    chunkSetDigest: text(input.chunkSetDigest, "chunk-set digest", 64, SHA256),
    modelId: text(input.modelId, "model ID", 255),
    configVersion: text(input.configVersion, "config version", 64, VERSION),
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

/** Hashes IDs, order, and exact UTF-8 content with unambiguous length framing. */
export async function documentChunkSetSha256(
  chunks: readonly Pick<DocumentChunk, "id" | "ordinal" | "content">[],
): Promise<string> {
  const ordered = [...chunks].sort((left, right) =>
    left.ordinal - right.ordinal ||
    left.id.localeCompare(right.id)
  );
  const parts: string[] = [];
  for (const chunk of ordered) {
    if (!UUID.test(chunk.id) || !Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0) {
      throw new TypeError("Document chunk identity is invalid");
    }
    const content = bytes(chunk.content);
    parts.push(
      `${chunk.id.length}:${chunk.id}:${chunk.ordinal}:${content.byteLength}:`,
      chunk.content,
    );
  }
  return hex(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes(parts.join(""))).buffer));
}

export async function assertCurrentDocumentChunkSet(
  payload: DocumentEmbeddingPayload,
  chunks: readonly Pick<DocumentChunk, "id" | "ordinal" | "content">[],
): Promise<void> {
  if (!chunks.length || await documentChunkSetSha256(chunks) !== payload.chunkSetDigest) {
    throw new StaleDocumentEmbeddingJobError();
  }
}

export class StaleDocumentEmbeddingJobError extends Error {
  constructor() {
    super("Document embedding job no longer matches the current chunk set");
    this.name = "StaleDocumentEmbeddingJobError";
  }
}

export class DocumentEmbeddingInputTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentEmbeddingInputTooLargeError";
  }
}

export function batchDocumentEmbeddingChunks(
  chunks: readonly Pick<DocumentChunk, "id" | "ordinal" | "content">[],
): Array<Array<Pick<DocumentChunk, "id" | "ordinal" | "content">>> {
  if (!chunks.length || chunks.length > DOCUMENT_EMBEDDING_MAX_BATCH_INPUTS) {
    throw new DocumentEmbeddingInputTooLargeError(
      "Document chunk set exceeds the single-request embedding input bound",
    );
  }
  const batch: Array<Pick<DocumentChunk, "id" | "ordinal" | "content">> = [];
  let characters = 0;
  for (const chunk of [...chunks].sort((left, right) => left.ordinal - right.ordinal)) {
    if (!chunk.content) {
      throw new TypeError("Document chunk content is outside embedding bounds");
    }
    characters += chunk.content.length;
    if (characters > DOCUMENT_EMBEDDING_MAX_BATCH_CHARACTERS) {
      throw new DocumentEmbeddingInputTooLargeError(
        "Document chunk set exceeds the single-request embedding size bound",
      );
    }
    batch.push(chunk);
  }
  return [batch];
}
