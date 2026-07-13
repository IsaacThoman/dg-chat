import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  assertImageAggregateBytes,
  assertImageUsagePricing,
  createImageGeneration,
  decodeImage,
  ImageProviderError,
  maximumImageJsonReplayBytes,
  parseImageGenerationRequest,
} from "./images.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const request = () =>
  parseImageGenerationRequest({
    model: "images/test",
    prompt: "a polished robot",
    response_format: "b64_json",
  });

Deno.test("buffered image replay bounds distinguish binary and asset-only responses", () => {
  const parsed = parseImageGenerationRequest({
    model: "images/test",
    prompt: "bounded",
    n: 10,
    response_format: "b64_json",
  });
  const binary = maximumImageJsonReplayBytes(parsed, false);
  const rich = maximumImageJsonReplayBytes(parsed, true);
  assertEquals(binary > 32 * 1024 * 1024, true);
  assertEquals(rich < 8 * 1024 * 1024, true);
  assertEquals(binary - rich, Math.ceil((32 * 1024 * 1024) / 3) * 4);
});

Deno.test("image generation request parsing is strict and normalizes cross-field constraints", () => {
  assertEquals(request(), {
    model: "images/test",
    prompt: "a polished robot",
    n: 1,
    background: "auto",
    moderation: "auto",
    outputCompression: 100,
    outputFormat: "png",
    partialImages: 0,
    quality: "auto",
    responseFormat: "b64_json",
    size: "auto",
    stream: false,
    style: "vivid",
  });
  for (
    const invalid of [
      { model: "x", prompt: "x", unknown: true },
      { model: "x", prompt: "x", n: 0 },
      { model: "x", prompt: "x", stream: true, n: 2 },
      { model: "x", prompt: "x", partial_images: 1 },
      { model: "x", prompt: "x", background: "transparent", output_format: "jpeg" },
      { model: "bad model", prompt: "x" },
    ]
  ) {
    try {
      parseImageGenerationRequest(invalid);
      throw new Error("expected validation failure");
    } catch (error) {
      assertEquals(error instanceof ImageProviderError, true);
      assertEquals((error as ImageProviderError).status, 422);
    }
  }
});

Deno.test("image decoder rejects noncanonical, unsupported, and oversized dimensions", () => {
  const decoded = decodeImage(png);
  assertEquals([decoded.format, decoded.width, decoded.height], ["png", 1, 1]);
  for (const invalid of ["abcd=", btoa("<svg></svg>"), `${png}=`]) {
    assertThrows(() => decodeImage(invalid), ImageProviderError);
  }
  const jpegWithoutEoi = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    0x01,
    0x00,
    0x01,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
  assertThrows(
    () => decodeImage(btoa(String.fromCharCode(...jpegWithoutEoi))),
    ImageProviderError,
    "truncated JPEG",
  );
  const malformedWebp = new TextEncoder().encode("RIFF\u0004\u0000\u0000\u0000WEBP");
  assertThrows(
    () => decodeImage(btoa(String.fromCharCode(...malformedWebp))),
    ImageProviderError,
  );
  const huge = Uint8Array.from(atob(png), (part) => part.charCodeAt(0));
  new DataView(huge.buffer).setUint32(16, 20_000);
  assertThrows(() => decodeImage(btoa(String.fromCharCode(...huge))), ImageProviderError);
});

Deno.test("image outputs have a bounded aggregate decoded size", () => {
  assertImageAggregateBytes([
    { bytes: new Uint8Array(16 * 1024 * 1024) },
    { bytes: new Uint8Array(16 * 1024 * 1024) },
  ]);
  assertThrows(
    () =>
      assertImageAggregateBytes([
        { bytes: new Uint8Array(16 * 1024 * 1024) },
        { bytes: new Uint8Array(16 * 1024 * 1024 + 1) },
      ]),
    ImageProviderError,
    "aggregate size",
  );
});

Deno.test("image provider normalizes nonstream b64 output and usage and refuses URLs", async () => {
  const result = await createImageGeneration(request(), {
    baseUrl: "https://images.example/v1",
    apiKey: "secret",
    upstreamModel: "upstream-image",
    signal: new AbortController().signal,
    fetch: (_input, init) => {
      const sent = JSON.parse(String(init?.body));
      assertEquals(sent.model, "upstream-image");
      assertEquals(sent.response_format, "b64_json");
      return Promise.resolve(Response.json({
        created: 1_700_000_000,
        data: [{ b64_json: png, revised_prompt: "robot" }],
        usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      }));
    },
  });
  assertEquals(result.data?.[0].width, 1);
  assertEquals(await result.usage, { inputTokens: 4, outputTokens: 8, source: "provider_tokens" });
  await assertRejects(
    () =>
      createImageGeneration(request(), {
        baseUrl: "https://images.example/v1",
        apiKey: "secret",
        upstreamModel: "upstream-image",
        signal: new AbortController().signal,
        fetch: () =>
          Promise.resolve(Response.json({ created: 1, data: [{ url: "https://evil.invalid/x" }] })),
      }),
    ImageProviderError,
    "unsafe URL",
  );
  await assertRejects(
    () =>
      createImageGeneration({ ...request(), outputFormat: "jpeg" }, {
        baseUrl: "https://images.example/v1",
        apiKey: "secret",
        upstreamModel: "upstream-image",
        signal: new AbortController().signal,
        fetch: () => Promise.resolve(Response.json({ created: 1, data: [{ b64_json: png }] })),
      }),
    ImageProviderError,
    "does not match",
  );
});

Deno.test("usage-less images require fixed pricing while authoritative usage permits token rates", async () => {
  const result = await createImageGeneration(request(), {
    baseUrl: "https://images.example/v1",
    apiKey: "secret",
    upstreamModel: "upstream-image",
    signal: new AbortController().signal,
    fetch: () => Promise.resolve(Response.json({ created: 1, data: [{ b64_json: png }] })),
  });
  const estimated = await result.usage;
  assertImageUsagePricing(estimated, {
    pricingVersionId: "fixed",
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 10,
    source: "test",
  });
  assertThrows(() =>
    assertImageUsagePricing(estimated, {
      pricingVersionId: "tokens",
      inputMicrosPerMillion: 1,
      cachedInputMicrosPerMillion: 0,
      reasoningMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      fixedCallMicros: 10,
      source: "test",
    }), ImageProviderError);
  const authoritative = { inputTokens: 4, outputTokens: 8, source: "provider_tokens" } as const;
  assertImageUsagePricing(authoritative, {
    pricingVersionId: "provider-tokens",
    inputMicrosPerMillion: 1,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 1,
    fixedCallMicros: 10,
    source: "test",
  });
  assertThrows(
    () =>
      assertImageUsagePricing(authoritative, {
        pricingVersionId: "unobserved-details",
        inputMicrosPerMillion: 1,
        cachedInputMicrosPerMillion: 1,
        reasoningMicrosPerMillion: 0,
        outputMicrosPerMillion: 1,
        fixedCallMicros: 10,
        source: "test",
      }),
    ImageProviderError,
    "unobserved",
  );
});

Deno.test("image provider canonicalizes SSE and withholds the completed frame", async () => {
  const streaming = parseImageGenerationRequest({
    model: "images/test",
    prompt: "robot",
    stream: true,
    partial_images: 1,
  });
  const body = [
    `event: image_generation.partial_image\ndata: ${
      JSON.stringify({
        type: "image_generation.partial_image",
        b64_json: png,
        created_at: 1,
        partial_image_index: 0,
      })
    }\n\n`,
    `event: image_generation.completed\ndata: ${
      JSON.stringify({
        type: "image_generation.completed",
        b64_json: png,
        created_at: 2,
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      })
    }\n\n`,
  ].join("");
  const result = await createImageGeneration(streaming, {
    baseUrl: "https://images.example/v1",
    apiKey: "secret",
    upstreamModel: "upstream-image",
    signal: new AbortController().signal,
    fetch: () =>
      Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
  });
  const frames: string[] = [];
  for await (const frame of result.stream!) frames.push(new TextDecoder().decode(frame));
  assertEquals(frames.length, 1);
  assertEquals(frames[0].includes("partial_image"), true);
  assertEquals(new TextDecoder().decode(await result.terminalFrame!).includes("completed"), true);
  assertEquals(await result.usage, { inputTokens: 2, outputTokens: 3, source: "provider_tokens" });
});

Deno.test("image provider rejects truncated and duplicate-terminal SSE", async () => {
  const streaming = parseImageGenerationRequest({
    model: "images/test",
    prompt: "robot",
    stream: true,
  });
  for (
    const body of [
      `data: ${
        JSON.stringify({
          type: "image_generation.partial_image",
          b64_json: png,
          created_at: 1,
          partial_image_index: 0,
        })
      }\n\n`,
      `${`data: ${
        JSON.stringify({ type: "image_generation.completed", b64_json: png, created_at: 1 })
      }\n\n`}${`data: ${
        JSON.stringify({ type: "image_generation.completed", b64_json: png, created_at: 2 })
      }\n\n`}`,
    ]
  ) {
    const result = await createImageGeneration(streaming, {
      baseUrl: "https://images.example/v1",
      apiKey: "secret",
      upstreamModel: "upstream-image",
      signal: new AbortController().signal,
      fetch: () =>
        Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
    });
    await assertRejects(async () => {
      for await (const _ of result.stream!) { /* drain */ }
    }, ImageProviderError);
  }
});

Deno.test("image stream rejects aggregate decoded bytes before exposing the over-limit frame", async () => {
  const original = Uint8Array.from(atob(png), (part) => part.charCodeAt(0));
  const targetBytes = 17 * 1024 * 1024;
  const payloadLength = targetBytes - original.byteLength - 12;
  const oversized = new Uint8Array(targetBytes);
  const iendOffset = original.byteLength - 12;
  oversized.set(original.subarray(0, iendOffset));
  new DataView(oversized.buffer).setUint32(iendOffset, payloadLength);
  oversized.set(new TextEncoder().encode("tEXt"), iendOffset + 4);
  // Payload and CRC remain zero; structural validation deliberately does not decompress images.
  oversized.set(original.subarray(iendOffset), targetBytes - 12);
  const encoded = oversized.toBase64();
  const event = (index: number) =>
    `event: image_generation.partial_image\ndata: ${
      JSON.stringify({
        type: "image_generation.partial_image",
        b64_json: encoded,
        created_at: 100 + index,
        partial_image_index: index,
      })
    }\n\n`;
  const streaming = parseImageGenerationRequest({
    model: "images/test",
    prompt: "large progressive image",
    stream: true,
    partial_images: 2,
  });
  const result = await createImageGeneration(streaming, {
    baseUrl: "https://images.example/v1",
    apiKey: "secret",
    upstreamModel: "upstream-image",
    signal: new AbortController().signal,
    fetch: () =>
      Promise.resolve(
        new Response(event(0) + event(1), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
  });
  const iterator = result.stream![Symbol.asyncIterator]();
  assertEquals((await iterator.next()).done, false);
  await assertRejects(() => iterator.next(), ImageProviderError, "aggregate size limit");
});
