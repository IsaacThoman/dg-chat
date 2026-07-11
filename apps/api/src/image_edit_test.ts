import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { createImageEdit, ImageProviderError, parseImageEditJson } from "./images.ts";
import { parseImageEditMultipart } from "./image-edit-multipart.ts";
import { UploadSecurityError } from "./upload-security.ts";
import OpenAI, { toFile } from "npm:openai@6.16.0";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const bytes = Uint8Array.from(atob(png), (part) => part.charCodeAt(0));
const alternatePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const alternateBytes = Uint8Array.from(atob(alternatePng), (part) => part.charCodeAt(0));

function pngCrc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  view.setUint32(8 + data.byteLength, pngCrc32(result.subarray(4, 8 + data.byteLength)));
  return result;
}

async function onePixelPng(red: number, green: number, blue: number): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 1);
  headerView.setUint32(4, 1);
  header.set([8, 6, 0, 0, 0], 8);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([new Uint8Array([0, red, green, blue, 255])]).stream().pipeThrough(
        new CompressionStream("deflate"),
      ),
    ).arrayBuffer(),
  );
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function editRequest(extra?: (form: FormData) => void) {
  const form = new FormData();
  form.append("model", "images/editor");
  form.append("prompt", "Polish this icon");
  form.append("image", new Blob([bytes], { type: "image/png" }), "source.png");
  extra?.(form);
  return await parseImageEditMultipart(
    new Request("http://localhost/v1/images/edits", {
      method: "POST",
      body: form,
    }),
  );
}

Deno.test("image edit multipart is streamed, sniffed, normalized, and mask constrained", async () => {
  const parsed = await editRequest((form) => {
    form.append("mask", new Blob([alternateBytes], { type: "image/png" }), "mask.png");
    form.append("n", "1");
    form.append("stream", "false");
  });
  assertEquals(parsed.model, "images/editor");
  assertEquals(parsed.images.length, 1);
  assertEquals(parsed.images[0].image.width, 1);
  assertEquals(parsed.mask?.image.format, "png");
  await assertRejects(
    () => editRequest((form) => form.append("prompt", "duplicate")),
    UploadSecurityError,
    "Invalid image edit field",
  );
});

Deno.test("image edit provider forces b64 output and normalizes buffered and SSE responses", async () => {
  const parsed = await editRequest();
  let observed: FormData | undefined;
  const buffered = await createImageEdit(parsed, {
    baseUrl: "https://editor.example/v1",
    apiKey: "secret",
    upstreamModel: "editor-upstream",
    signal: new AbortController().signal,
    fetch: async (input, init) => {
      observed = await new Request(input, init).formData();
      return Promise.resolve(Response.json({ created: 123, data: [{ b64_json: png }] }));
    },
  });
  assertEquals(observed?.get("model"), "editor-upstream");
  assertEquals(observed?.get("response_format"), "b64_json");
  assertEquals(observed?.has("moderation"), false);
  assertEquals(observed?.has("style"), false);
  assertEquals((observed?.getAll("image")[0] as File).type, "image/png");
  assertEquals(buffered.data?.[0].width, 1);

  const streaming = { ...parsed, stream: true, partialImages: 0 };
  const result = await createImageEdit(streaming, {
    baseUrl: "https://editor.example/v1",
    apiKey: "secret",
    upstreamModel: "editor-upstream",
    signal: new AbortController().signal,
    fetch: () =>
      Promise.resolve(
        new Response(
          `event: image_edit.completed\ndata: ${
            JSON.stringify({
              type: "image_edit.completed",
              b64_json: png,
              created_at: 124,
            })
          }\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  for await (const _frame of result.stream!) {
    throw new Error("completed edit event must be withheld");
  }
  assertEquals(
    new TextDecoder().decode(await result.terminalFrame!).includes("image_edit.completed"),
    true,
  );
});

Deno.test("official JavaScript SDK image array serialization is accepted in order", async () => {
  let parsed: Awaited<ReturnType<typeof parseImageEditMultipart>> | undefined;
  const client = new OpenAI({
    apiKey: "test",
    baseURL: "http://localhost/v1",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      parsed = await parseImageEditMultipart(request);
      return Response.json({ created: 1, data: [{ b64_json: png }] });
    },
  });
  await client.images.edit({
    model: "images/editor",
    prompt: "SDK array",
    image: [
      await toFile(bytes, "first.png", { type: "image/png" }),
      await toFile(alternateBytes, "second.png", { type: "image/png" }),
    ],
    input_fidelity: "high",
    response_format: "b64_json",
  });
  assertEquals(parsed?.images.map((input) => input.filename), ["first.png", "second.png"]);
  assertEquals(parsed?.inputFidelity, "high");
});

Deno.test("image edits reject duplicate source content before provider work", async () => {
  const form = new FormData();
  form.append("model", "images/editor");
  form.append("prompt", "Duplicate sources");
  form.append("image[]", new Blob([bytes], { type: "image/png" }), "first.png");
  form.append("image[]", new Blob([bytes], { type: "image/png" }), "second.png");
  await assertRejects(
    () =>
      parseImageEditMultipart(
        new Request("http://localhost/v1/images/edits", { method: "POST", body: form }),
      ),
    UploadSecurityError,
    "distinct",
  );
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseImageEditJson({
          model: "images/editor",
          prompt: "Duplicate references",
          images: [{ file_id: "same" }, { file_id: "same" }],
        })
      ),
    ImageProviderError,
    "distinct",
  );
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseImageEditJson({
          model: "images/editor",
          prompt: "Duplicate mask reference",
          images: [{ file_id: "same" }],
          mask: { file_id: "same" },
        })
      ),
    ImageProviderError,
    "mask must be distinct",
  );
});

Deno.test("sixteen ordered sources may be followed by a mask", async () => {
  const form = new FormData();
  form.append("model", "images/editor");
  form.append("prompt", "Maximum sources with mask");
  for (let index = 0; index < 16; index++) {
    const encodedSource = await onePixelPng(index * 11, 255 - index * 7, index * 13);
    form.append(
      "image[]",
      new Blob([encodedSource.slice().buffer], { type: "image/png" }),
      `source-${index}.png`,
    );
  }
  form.append("mask", new Blob([alternateBytes], { type: "image/png" }), "mask.png");
  const parsed = await parseImageEditMultipart(
    new Request("http://localhost/v1/images/edits", { method: "POST", body: form }),
  );
  assertEquals(parsed.images.length, 16);
  assertEquals(parsed.mask?.filename, "mask.png");
});

Deno.test("image edit provider rejects URL exfiltration", async () => {
  const parsed = await editRequest();
  await assertRejects(
    () =>
      createImageEdit(parsed, {
        baseUrl: "https://editor.example/v1",
        apiKey: "secret",
        upstreamModel: "editor-upstream",
        signal: new AbortController().signal,
        fetch: () =>
          Promise.resolve(Response.json({ created: 1, data: [{ url: "https://evil.test" }] })),
      }),
    ImageProviderError,
    "unsafe URL",
  );
});

Deno.test("image edit JSON accepts file IDs and explicitly rejects remote URLs", () => {
  const parsed = parseImageEditJson({
    model: "images/editor",
    prompt: "Edit owned files",
    images: [{ file_id: "file-one" }, { file_id: "file-two" }],
    mask: { file_id: "mask-one" },
  });
  assertEquals(parsed.images.map((item) => item.fileId), ["file-one", "file-two"]);
  assertEquals(parsed.mask?.fileId, "mask-one");
  try {
    parseImageEditJson({
      model: "images/editor",
      prompt: "No SSRF",
      images: [{ image_url: "http://127.0.0.1/metadata" }],
    });
    throw new Error("remote URL was accepted");
  } catch (error) {
    assertEquals((error as ImageProviderError).code, "remote_image_url_unsupported");
  }
});

Deno.test("omitted edit model returns the documented stable deviation", async () => {
  try {
    parseImageEditJson({ prompt: "missing model", images: [{ file_id: "owned" }] });
    throw new Error("missing model accepted");
  } catch (error) {
    assertEquals((error as ImageProviderError).code, "model_required");
  }
  const form = new FormData();
  form.append("prompt", "missing model");
  form.append("image", new Blob([bytes], { type: "image/png" }), "source.png");
  await assertRejects(
    () =>
      parseImageEditMultipart(
        new Request("http://localhost/v1/images/edits", {
          method: "POST",
          body: form,
        }),
      ),
    UploadSecurityError,
    "no global image-edit default",
  );
});

Deno.test("chunked image edit aggregate is rejected during consumption", async () => {
  const targetBytes = 17 * 1024 * 1024;
  const oversized = new Uint8Array(targetBytes);
  const iend = bytes.byteLength - 12;
  oversized.set(bytes.subarray(0, iend));
  const payloadLength = targetBytes - bytes.byteLength - 12;
  new DataView(oversized.buffer).setUint32(iend, payloadLength);
  oversized.set(new TextEncoder().encode("tEXt"), iend + 4);
  oversized.set(bytes.subarray(iend), targetBytes - 12);
  const form = new FormData();
  form.append("model", "images/editor");
  form.append("prompt", "bounded");
  form.append("image[]", new Blob([oversized], { type: "image/png" }), "one.png");
  form.append("image[]", new Blob([oversized], { type: "image/png" }), "two.png");
  await assertRejects(
    () =>
      parseImageEditMultipart(
        new Request("http://localhost/v1/images/edits", {
          method: "POST",
          body: form,
        }),
      ),
    UploadSecurityError,
    "byte limit",
  );
});

Deno.test("chunked image edit wire bytes include multipart epilogue", async () => {
  const form = new FormData();
  form.append("model", "images/editor");
  form.append("prompt", "Bound all wire bytes");
  form.append("image", new Blob([bytes], { type: "image/png" }), "source.png");
  const encoded = new Response(form);
  const prefix = new Uint8Array(await encoded.arrayBuffer());
  const trailer = new Uint8Array(33 * 1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      for (let offset = 0; offset < trailer.byteLength; offset += 64 * 1024) {
        controller.enqueue(trailer.subarray(offset, offset + 64 * 1024));
      }
      controller.close();
    },
  });
  await assertRejects(
    () =>
      parseImageEditMultipart(
        new Request("http://localhost/v1/images/edits", {
          method: "POST",
          headers: { "content-type": encoded.headers.get("content-type")! },
          body,
        }),
      ),
    UploadSecurityError,
    "byte limit",
  );
});
