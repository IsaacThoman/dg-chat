import { assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  createPeScanState,
  normalizeUploadFilename,
  safeUploadObjectKey,
  scanEmbeddedPe,
  secureUploadStream,
  UploadSecurityError,
} from "./upload-security.ts";
import { DOCX_MIME_TYPE } from "@dg-chat/database";
import { strToU8, zipSync } from "fflate";

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

Deno.test("accepts DOCX packages but rejects other and macro-enabled Office ZIPs", async () => {
  const zipPackage = (entries: string[]) =>
    zipSync(Object.fromEntries(entries.map((entry) => [entry, strToU8("content")])));
  const docx = secureUploadStream(
    stream(zipPackage(["[Content_Types].xml", "_rels/.rels", "word/document.xml"])),
    "notes.docx",
    DOCX_MIME_TYPE,
    { maxBytes: 4096 },
  );
  await drain(docx.stream);
  assertEquals((await docx.inspection).mime, DOCX_MIME_TYPE);
  assertMatch(safeUploadObjectKey("user_123", DOCX_MIME_TYPE), /\.docx$/);

  for (
    const [entries, declared] of [
      [
        ["[Content_Types].xml", "ppt/presentation.xml"],
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
      [
        ["[Content_Types].xml", "xl/workbook.xml"],
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    ] as const
  ) {
    assertThrows(
      () =>
        secureUploadStream(stream(zipPackage([...entries])), "office.zip", declared, {
          maxBytes: 4096,
        }),
      UploadSecurityError,
    );
  }
  const macro = secureUploadStream(
    stream(zipPackage(["[Content_Types].xml", "word/document.xml", "word/vbaProject.bin"])),
    "macro.docx",
    DOCX_MIME_TYPE,
    { maxBytes: 4096 },
  );
  await assertRejects(() => drain(macro.stream), UploadSecurityError);
  await assertRejects(() => macro.inspection, UploadSecurityError);
});

Deno.test("recognizes DOCX from its central directory when local entries exceed the prefix", async () => {
  const packageBytes = zipSync({
    "large-padding.bin": new Uint8Array(90_000).fill(65),
    "word/document.xml": strToU8("<w:document/>"),
    "[Content_Types].xml": strToU8("<Types/>"),
  }, { level: 0 });
  const upload = secureUploadStream(
    stream(packageBytes.slice(0, 31_000), packageBytes.slice(31_000)),
    "ordered.docx",
    DOCX_MIME_TYPE,
    { maxBytes: 100_000, inspectionBytes: 64 * 1024 },
  );
  await drain(upload.stream);
  assertEquals((await upload.inspection).mime, DOCX_MIME_TYPE);
});

Deno.test("DOCX sniffing requires canonical package part casing", async () => {
  const packageBytes = zipSync({
    "[CONTENT_TYPES].XML": strToU8("<Types/>"),
    "word/document.xml": strToU8("<w:document/>"),
  });
  const upload = secureUploadStream(stream(packageBytes), "case.docx", DOCX_MIME_TYPE, {
    maxBytes: 4096,
  });
  await assertRejects(() => drain(upload.stream), UploadSecurityError);
  await assertRejects(() => upload.inspection, UploadSecurityError);
});

Deno.test("detects polyglot markers in the middle of a streamed upload across chunks", async () => {
  const prefix = new Uint8Array(24);
  prefix.set(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  new DataView(prefix.buffer).setUint32(16, 1);
  new DataView(prefix.buffer).setUint32(20, 1);
  const upload = secureUploadStream(
    stream(
      prefix,
      new Uint8Array(80_000),
      strToU8("<scr"),
      strToU8("ipt>alert(1)</script>"),
      new Uint8Array(80_000),
    ),
    "polyglot.png",
    "image/png",
    { maxBytes: 200_000, inspectionBytes: 512 },
  );
  await assertRejects(() => drain(upload.stream), UploadSecurityError, "Conflicting");
  await assertRejects(() => upload.inspection, UploadSecurityError, "Conflicting");
});

Deno.test("PE polyglot detection validates a DOS and PE header without mz false positives", async () => {
  const png = new Uint8Array(256);
  png.set(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  new DataView(png.buffer).setUint32(16, 1);
  new DataView(png.buffer).setUint32(20, 1);
  png.set(strToU8("ordinary amazing image metadata"), 32);
  const valid = secureUploadStream(stream(png), "valid.png", "image/png", { maxBytes: 1024 });
  await drain(valid.stream);
  assertEquals((await valid.inspection).mime, "image/png");

  const pe = png.slice();
  pe[64] = 0x4d;
  pe[65] = 0x5a;
  new DataView(pe.buffer).setUint32(64 + 0x3c, 0x50, true);
  pe.set(bytes(0x50, 0x45, 0, 0), 64 + 0x50);
  const hostile = secureUploadStream(stream(pe.slice(0, 90), pe.slice(90)), "pe.png", "image/png", {
    maxBytes: 1024,
  });
  await assertRejects(() => drain(hostile.stream), UploadSecurityError, "Conflicting");
  await assertRejects(() => hostile.inspection, UploadSecurityError, "Conflicting");
});

Deno.test("PE polyglot detection follows large DOS offsets across stream boundaries", async () => {
  const body = new Uint8Array(7_000);
  body.set(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  new DataView(body.buffer).setUint32(16, 1);
  new DataView(body.buffer).setUint32(20, 1);
  const dosOffset = 100;
  const peRelative = 5_000;
  body.set(bytes(0x4d, 0x5a), dosOffset);
  new DataView(body.buffer).setUint32(dosOffset + 0x3c, peRelative, true);
  body.set(bytes(0x50, 0x45, 0, 0), dosOffset + peRelative);
  const hostile = secureUploadStream(
    stream(
      body.slice(0, dosOffset + 1),
      body.slice(dosOffset + 1, dosOffset + peRelative + 2),
      body.slice(dosOffset + peRelative + 2),
    ),
    "large-stub.png",
    "image/png",
    { maxBytes: body.length },
  );
  await assertRejects(() => drain(hostile.stream), UploadSecurityError, "Conflicting");
  await assertRejects(() => hostile.inspection, UploadSecurityError, "Conflicting");
});

Deno.test("PE live-candidate saturation quarantines without claiming a polyglot", async () => {
  const body = new Uint8Array(200_000);
  body.set(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  new DataView(body.buffer).setUint32(16, 1);
  new DataView(body.buffer).setUint32(20, 1);
  for (let index = 0; index < 1_025; index++) {
    const offset = 64 + index * 64;
    body.set(bytes(0x4d, 0x5a), offset);
    new DataView(body.buffer).setUint32(offset + 0x3c, body.length - offset - 4, true);
  }
  const state = createPeScanState();
  const first = body.slice(0, 70_000);
  const second = body.slice(70_000);
  let previous = scanEmbeddedPe(first, 0, state, undefined, body.length).previousByte;
  previous = scanEmbeddedPe(second, first.length, state, previous, body.length).previousByte;
  assertEquals(state.terminal, true);
  assertEquals(state.inconclusive, true);
  assertEquals(state.headers.size, 0);
  assertEquals(state.signatures.size, 0);
  if (state.work > 100_000) {
    throw new Error(`PE scan exceeded its deterministic work budget: ${state.work}`);
  }
  assertEquals(previous, second.at(-1));
  const inconclusive = secureUploadStream(
    stream(body.slice(0, 70_000), body.slice(70_000)),
    "candidate-flood.png",
    "image/png",
    { maxBytes: body.length },
  );
  await drain(inconclusive.stream);
  assertEquals((await inconclusive.inspection).decision, {
    state: "quarantine",
    reason: "security_scan_inconclusive",
  });
});

Deno.test("more than 1024 expired MZ candidates do not cause a false positive", async () => {
  const body = new Uint8Array(200_000);
  body.set(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  new DataView(body.buffer).setUint32(16, 1);
  new DataView(body.buffer).setUint32(20, 1);
  for (let index = 0; index < 1_100; index++) {
    const offset = 64 + index * 128;
    body.set(bytes(0x4d, 0x5a), offset);
    new DataView(body.buffer).setUint32(offset + 0x3c, 0, true);
  }
  const state = createPeScanState();
  const scan = scanEmbeddedPe(body, 0, state, undefined, body.length);
  assertEquals(scan.detected, false);
  assertEquals(state.inconclusive, false);
  assertEquals(state.candidates, 0);
  if (state.work > 100_000) {
    throw new Error(`Expired candidates used excess work: ${state.work}`);
  }

  const valid = secureUploadStream(stream(body), "many-mz.png", "image/png", {
    maxBytes: body.length,
  });
  await drain(valid.stream);
  assertEquals((await valid.inspection).mime, "image/png");
});

Deno.test("validates the complete JSON document instead of only its prefix", async () => {
  const valid = secureUploadStream(
    stream(strToU8('{"safe":'), strToU8("true}")),
    "valid.json",
    "application/json",
    { maxBytes: 1024 },
  );
  await drain(valid.stream);
  assertEquals((await valid.inspection).mime, "application/json");

  const hostile = secureUploadStream(
    stream(strToU8('{"safe":true}'), strToU8("<script>alert(1)</script>")),
    "hostile.json",
    "application/json",
    { maxBytes: 1024 },
  );
  await assertRejects(() => drain(hostile.stream), UploadSecurityError, "malformed");
  await assertRejects(() => hostile.inspection, UploadSecurityError, "malformed");
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
