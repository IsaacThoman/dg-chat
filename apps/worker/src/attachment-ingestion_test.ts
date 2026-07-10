import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import type { StoredObject } from "@dg-chat/database";
import {
  deterministicChunks,
  readIngestionText,
  requireIngestionObject,
} from "./attachment-ingestion.ts";

const stored = (bytes: Uint8Array, splits = [bytes.length]): StoredObject => {
  let offset = 0;
  return {
    key: "object",
    contentLength: bytes.length,
    contentType: "text/plain",
    etag: null,
    metadata: {},
    body: new ReadableStream({
      pull(controller) {
        const size = splits.shift() ?? bytes.length;
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset += size));
      },
    }),
  };
};

Deno.test("ingestion validates split UTF-8 and complete JSON", async () => {
  const json = new TextEncoder().encode('{"emoji":"😀"}\r\n');
  assertEquals(
    await readIngestionText(stored(json, [12, 1, 2]), "application/json"),
    '{"emoji":"😀"}\n',
  );
  await assertRejects(
    () => readIngestionText(stored(new TextEncoder().encode('{"open":')), "application/json"),
    Error,
    "valid JSON",
  );
  await assertRejects(
    () => readIngestionText(stored(new Uint8Array([0xc3, 0x28])), "text/plain"),
    Error,
    "valid UTF-8",
  );
});

Deno.test("ingestion verifies the exact streamed object digest", async () => {
  const bytes = new TextEncoder().encode("hello");
  assertEquals(
    await readIngestionText(
      stored(bytes),
      "text/plain",
      100,
      1000,
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    ),
    "hello",
  );
  await assertRejects(
    () => readIngestionText(stored(bytes), "text/plain", 100, 1000, "0".repeat(64)),
    Error,
    "digest",
  );
});

Deno.test("ingestion enforces stream byte and time bounds", async () => {
  await assertRejects(
    () => readIngestionText(stored(new Uint8Array(20)), "text/plain", 10),
    Error,
    "byte limit",
  );
  const stalled: StoredObject = {
    key: "stalled",
    contentLength: null,
    contentType: "text/plain",
    etag: null,
    metadata: {},
    body: new ReadableStream({ pull: () => new Promise(() => {}) }),
  };
  await assertRejects(() => readIngestionText(stalled, "text/plain", 10, 5), Error, "timed out");
});

Deno.test("ingestion fails explicitly when its object is missing", async () => {
  await assertRejects(
    () => requireIngestionObject({ get: () => Promise.resolve(undefined) } as never, "missing"),
    Error,
    "object is missing",
  );
});

Deno.test("deterministic overlapping chunks have stable citation ranges", async () => {
  const input = {
    attachmentId: "00000000-0000-4000-8000-000000000001",
    filename: "notes.txt",
    mimeType: "text/plain",
    sha256: "a".repeat(64),
    text: "one\ntwo\nthree\nfour\nfive\n",
    chunkChars: 12,
    overlapChars: 3,
  };
  const first = await deterministicChunks(input);
  const replay = await deterministicChunks(input);
  assertEquals(first, replay);
  assertEquals(first.length > 1, true);
  assertEquals(first[0].metadata.startLine, 1);
  assertEquals(typeof first.at(-1)?.metadata.endLine, "number");
});

Deno.test("chunk boundaries never split UTF-16 surrogate pairs", async () => {
  const chunks = await deterministicChunks({
    attachmentId: "00000000-0000-4000-8000-000000000003",
    filename: "emoji.txt",
    mimeType: "text/plain",
    sha256: "c".repeat(64),
    text: "abc😀def😀ghi",
    chunkChars: 4,
    overlapChars: 1,
  });
  for (const chunk of chunks) {
    assertEquals(
      /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(
        chunk.content,
      ),
      false,
    );
  }
});

Deno.test("small overlapping Unicode chunks always make progress", async () => {
  const chunks = await deterministicChunks({
    attachmentId: "00000000-0000-4000-8000-000000000004",
    filename: "small-emoji.txt",
    mimeType: "text/plain",
    sha256: "d".repeat(64),
    text: "a😀b",
    chunkChars: 2,
    overlapChars: 1,
  });
  assertEquals(chunks.map((chunk) => chunk.content), ["a", "😀", "b"]);
});
