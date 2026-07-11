import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import { type StoredObject, validateDocumentChunkInputs } from "@dg-chat/database";
import { strToU8, zipSync } from "fflate";
import {
  buildDocumentChunks,
  DocumentPipelineTimeoutError,
  extractDocumentIsolated,
  raceJobDeadline,
} from "./document-pipeline.ts";

const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer),
  );
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function object(bytes: Uint8Array): StoredObject {
  return {
    key: "objects/test",
    body: new Blob([bytes.slice().buffer as ArrayBuffer]).stream(),
    contentLength: bytes.length,
    contentType: "text/plain",
    metadata: {},
    etag: null,
  };
}

Deno.test("document pipeline stamps configured versions and chunk bounds on text", async () => {
  const bytes = encoder.encode("alpha beta gamma delta");
  const digest = await sha256(bytes);
  const chunks = await buildDocumentChunks({
    attachmentId: "00000000-0000-8000-8000-000000000001",
    filename: "notes.txt",
    mimeType: "text/plain",
    sha256: digest,
    object: object(bytes),
  }, {
    chunkSizeChars: 256,
    chunkOverlapChars: 32,
    extractorVersion: "document-v2",
    chunkerVersion: "window-v3",
  });
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].metadata.extractorVersion, "document-v2");
  assertEquals(chunks[0].metadata.chunkerVersion, "window-v3");
  assertEquals(chunks[0].content, "alpha beta gamma delta");
});

Deno.test("document pipeline verifies the streamed object digest", async () => {
  const bytes = encoder.encode("tampered");
  await assertRejects(
    () =>
      buildDocumentChunks({
        attachmentId: "00000000-0000-8000-8000-000000000001",
        filename: "notes.txt",
        mimeType: "text/plain",
        sha256: "0".repeat(64),
        object: object(bytes),
      }, {
        chunkSizeChars: 256,
        chunkOverlapChars: 32,
        extractorVersion: "document-v2",
        chunkerVersion: "window-v3",
      }),
    Error,
    "digest",
  );
});

Deno.test("shared validation rejects a replacement set before persistence", () => {
  assertThrows(
    () => {
      validateDocumentChunkInputs([{
        id: "00000000-0000-8000-8000-000000000002",
        ordinal: 1,
        content: "out of order",
        metadata: { sourceAttachmentId: "00000000-0000-8000-8000-000000000001" },
      }], "00000000-0000-8000-8000-000000000001");
    },
    TypeError,
    "invalid",
  );
});

Deno.test({
  name: "document pipeline applies one timeout budget across object read and extraction",
  async fn() {
    const bytes = encoder.encode("slow input");
    const digest = await sha256(bytes);
    const slowObject: StoredObject = {
      ...object(bytes),
      body: new ReadableStream({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
    await assertRejects(
      () =>
        buildDocumentChunks({
          attachmentId: "00000000-0000-8000-8000-000000000001",
          filename: "notes.txt",
          mimeType: "text/plain",
          sha256: digest,
          object: slowObject,
        }, {
          chunkSizeChars: 256,
          chunkOverlapChars: 32,
          extractorVersion: "document-v2",
          chunkerVersion: "window-v3",
        }, { timeoutMs: 5 }),
      Error,
      "timed out",
    );
    // Let the synthetic source finish so its timer cannot spill into the following worker test.
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
});

Deno.test("isolated extraction preemptively terminates CPU-bound worker code", async () => {
  const script = URL.createObjectURL(
    new Blob([
      `self.onmessage = () => { while (true) {} };`,
    ], { type: "text/javascript" }),
  );
  const started = performance.now();
  await assertRejects(
    () =>
      extractDocumentIsolated(
        new Uint8Array([1]),
        "application/pdf",
        {},
        Date.now() + 20,
        () => new Worker(script, { type: "module", deno: { permissions: "none" } }),
      ),
    DocumentPipelineTimeoutError,
  );
  URL.revokeObjectURL(script);
  if (performance.now() - started > 1_000) throw new Error("CPU-bound worker was not preempted");
});

Deno.test("real extraction worker returns a structured document", async () => {
  const bytes = zipSync({
    "[Content_Types].xml": strToU8(
      `<Types><Override PartName="/word/document.xml" ` +
        `ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>isolated text</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
  const result = await extractDocumentIsolated(
    bytes,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    {},
    Date.now() + 5_000,
  );
  assertEquals(result.text, "isolated text");
});

Deno.test("absolute job deadline rejects stalled acquisition", async () => {
  await assertRejects(
    () => raceJobDeadline(new Promise(() => {}), Date.now() + 5),
    DocumentPipelineTimeoutError,
  );
});

Deno.test("chunking refuses work after the absolute deadline", async () => {
  const bytes = encoder.encode("expired");
  await assertRejects(
    () =>
      buildDocumentChunks(
        {
          attachmentId: "00000000-0000-8000-8000-000000000001",
          filename: "notes.txt",
          mimeType: "text/plain",
          sha256: "0".repeat(64),
          object: object(bytes),
        },
        {
          chunkSizeChars: 256,
          chunkOverlapChars: 32,
          extractorVersion: "document-v2",
          chunkerVersion: "window-v3",
        },
        {},
        Date.now() - 1,
      ),
    DocumentPipelineTimeoutError,
  );
});
