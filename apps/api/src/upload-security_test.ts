import { assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  normalizeUploadFilename,
  safeUploadObjectKey,
  secureUploadStream,
  UploadSecurityError,
} from "./upload-security.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const stream = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
async function drain(input: ReadableStream<Uint8Array>) {
  for await (const _chunk of input) { /* object-store consumer */ }
}

Deno.test("normalizes hostile filenames and object keys never contain user filenames", () => {
  assertEquals(normalizeUploadFilename("../../etc/passwd"), "passwd");
  assertEquals(normalizeUploadFilename("..\\..\\evil\u0000.png"), "evil.png");
  assertEquals(normalizeUploadFilename("..."), "upload");
  const key = safeUploadObjectKey("user_123", "IMAGE/PNG; charset=binary");
  assertMatch(key, /^uploads\/user_123\/[0-9a-f]{2}\/[0-9a-f-]{36}\.png$/);
  assertThrows(() => safeUploadObjectKey("../admin", "image/png"), UploadSecurityError);
});

Deno.test("streams, hashes, and validates a PNG without buffering the body", async () => {
  const header = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const ihdr = new Uint8Array(24);
  ihdr.set(header);
  new DataView(ihdr.buffer).setUint32(16, 2);
  new DataView(ihdr.buffer).setUint32(20, 3);
  const upload = secureUploadStream(stream(ihdr, bytes(1, 2, 3)), "photo.png", "image/png", {
    maxBytes: 100,
    imageGuard: () => ({ decompressedBytes: 24 }),
    maxImagePixels: 100,
    maxDecompressedBytes: 100,
  });
  await drain(upload.stream);
  const result = await upload.inspection;
  assertEquals(result.size, 27);
  assertEquals(result.image, { width: 2, height: 3, decompressedBytes: 24 });
  assertEquals(result.decision.state, "ready");
  assertEquals(result.sha256.length, 64);
});

Deno.test("rejects oversize and empty streams", async () => {
  const oversized = secureUploadStream(stream(new Uint8Array(9)), "x.txt", "text/plain", {
    maxBytes: 8,
  });
  await assertRejects(() => drain(oversized.stream), UploadSecurityError, "byte limit");
  await assertRejects(() => oversized.inspection, UploadSecurityError, "byte limit");

  const empty = secureUploadStream(stream(), "x.txt", "text/plain", { maxBytes: 8 });
  await assertRejects(() => drain(empty.stream), UploadSecurityError, "empty");
  await assertRejects(() => empty.inspection, UploadSecurityError, "empty");
});

Deno.test("rejects MIME spoofing, executable headers, and HTML disguised as text", async () => {
  for (
    const [body, declared] of [
      [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/jpeg"],
      [bytes(0x4d, 0x5a, 0x90, 0x00), "application/octet-stream"],
      [new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>"), "text/plain"],
    ] as const
  ) {
    const upload = secureUploadStream(stream(body), "payload", declared, { maxBytes: 1024 });
    await assertRejects(() => drain(upload.stream), UploadSecurityError);
    await assertRejects(() => upload.inspection, UploadSecurityError);
  }
});

Deno.test("rejects binary polyglots and malformed image dimensions", async () => {
  const polyglot = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new TextEncoder().encode("<script>alert(1)</script>"),
  ]);
  const bad = secureUploadStream(stream(polyglot), "polyglot.png", "image/png", {
    maxBytes: 1024,
  });
  await assertRejects(() => drain(bad.stream), UploadSecurityError, "Conflicting");
  await assertRejects(() => bad.inspection, UploadSecurityError, "Conflicting");

  const huge = new Uint8Array(24);
  huge.set(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  new DataView(huge.buffer).setUint32(16, 100_000);
  new DataView(huge.buffer).setUint32(20, 100_000);
  const image = secureUploadStream(stream(huge), "huge.png", "image/png", {
    maxBytes: 1024,
    maxImagePixels: 1_000_000,
  });
  await assertRejects(() => drain(image.stream), UploadSecurityError, "pixel count");
  await assertRejects(() => image.inspection, UploadSecurityError, "pixel count");
});

Deno.test("image guard can quarantine and enforce decompression limits", async () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const quarantined = secureUploadStream(stream(png), "unknown.png", "image/png", {
    maxBytes: 100,
  });
  await drain(quarantined.stream);
  assertEquals((await quarantined.inspection).decision, {
    state: "quarantine",
    reason: "image_guard_pending",
  });

  const bomb = secureUploadStream(stream(png), "bomb.png", "image/png", {
    maxBytes: 100,
    maxDecompressedBytes: 1000,
    imageGuard: () => ({ width: 1, height: 1, decompressedBytes: 1001 }),
  });
  await assertRejects(() => drain(bomb.stream), UploadSecurityError, "Decompressed");
  await assertRejects(() => bomb.inspection, UploadSecurityError, "Decompressed");
});
