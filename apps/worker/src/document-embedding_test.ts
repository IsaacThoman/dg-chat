import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import type { DocumentChunk } from "@dg-chat/database";
import {
  assertCurrentDocumentChunkSet,
  batchDocumentEmbeddingChunks,
  documentChunkSetSha256,
  DocumentEmbeddingInputTooLargeError,
  embeddingHeartbeatIntervalMs,
  parseDocumentEmbeddingConfig,
  parseDocumentEmbeddingPayload,
  StaleDocumentEmbeddingJobError,
  validateWorkerJobLeaseSeconds,
} from "./document-embedding.ts";

const attachmentId = "00000000-0000-8000-8000-000000000001";
const ownerId = "00000000-0000-8000-8000-000000000002";
const digest = "a".repeat(64);

Deno.test("embedding job leases preserve a heartbeat safety margin", () => {
  assertThrows(() => validateWorkerJobLeaseSeconds(4));
  assertEquals(validateWorkerJobLeaseSeconds(5), 5);
  assertEquals(embeddingHeartbeatIntervalMs(5), 1_666);
  assertEquals(embeddingHeartbeatIntervalMs(120), 40_000);
});

function chunk(ordinal: number, content = `chunk ${ordinal}`): DocumentChunk {
  return {
    id: `00000000-0000-8000-8000-${String(ordinal + 10).padStart(12, "0")}`,
    attachmentId,
    ordinal,
    content,
    metadata: {
      sha256: digest,
      extractorVersion: "document-v2",
      chunkerVersion: "window-v3",
    },
    embeddingStatus: "pending",
    embeddingModelId: null,
    embeddingConfigVersion: null,
    embeddedAt: null,
    embeddingError: null,
  };
}

Deno.test("embedding config is explicit and rejects partial or unsafe values", () => {
  const values = new Map<string, string>();
  const env = { get: (name: string) => values.get(name) };
  assertEquals(parseDocumentEmbeddingConfig(env), undefined);
  values.set("DOCUMENT_EMBEDDING_MODEL_ID", "provider/embed");
  assertThrows(() => parseDocumentEmbeddingConfig(env));
  values.set("DOCUMENT_EMBEDDING_CONFIG_VERSION", "knowledge-v1");
  assertEquals(parseDocumentEmbeddingConfig(env), {
    modelId: "provider/embed",
    configVersion: "knowledge-v1",
  });
});

Deno.test("embedding payload is closed and identity fields are bounded", async () => {
  const chunks = [chunk(0), chunk(1)];
  const payload = {
    attachmentId,
    ownerId,
    chunkSetDigest: await documentChunkSetSha256(chunks),
    modelId: "provider/embed",
    configVersion: "knowledge-v1",
  };
  assertEquals(parseDocumentEmbeddingPayload(payload), payload);
  assertThrows(() => parseDocumentEmbeddingPayload({ ...payload, extra: true }));
});

Deno.test("chunk identity covers order, IDs, exact content, and extraction identity", async () => {
  const chunks = [chunk(1), chunk(0)];
  const payload = parseDocumentEmbeddingPayload({
    attachmentId,
    ownerId,
    chunkSetDigest: await documentChunkSetSha256(chunks),
    modelId: "provider/embed",
    configVersion: "knowledge-v1",
  });
  await assertCurrentDocumentChunkSet(payload, chunks);
  await assertRejects(
    () => assertCurrentDocumentChunkSet(payload, [chunk(0, "changed"), chunk(1)]),
    StaleDocumentEmbeddingJobError,
  );
});

Deno.test("embedding request preserves ordinal order and enforces one-request bounds", () => {
  const chunks = Array.from({ length: 129 }, (_, index) => chunk(index));
  const batches = batchDocumentEmbeddingChunks(chunks.reverse());
  assertEquals(batches.map((batch) => batch.length), [129]);
  assertEquals(
    batches.flat().map((item) => item.ordinal),
    chunks.reverse().map((item) => item.ordinal),
  );
  assertThrows(() => batchDocumentEmbeddingChunks([chunk(0, "")]));
  assertThrows(
    () => batchDocumentEmbeddingChunks(Array.from({ length: 2_049 }, (_, index) => chunk(index))),
    DocumentEmbeddingInputTooLargeError,
  );
  assertThrows(
    () => batchDocumentEmbeddingChunks([chunk(0, "x".repeat(2_000_001))]),
    DocumentEmbeddingInputTooLargeError,
  );
});
