import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  assertSpeechFixedPricing,
  createSpeech,
  estimateSpeechInputTokens,
  parseSpeechRequest,
  SpeechProviderError,
  type SpeechRequest,
  type SpeechResponseFormat,
} from "./speech.ts";

const request: SpeechRequest = {
  model: "voice/public",
  input: "Hello world",
  voice: "alloy",
  responseFormat: "mp3",
  speed: 1,
  streamFormat: "audio",
};

Deno.test("speech request parser normalizes defaults and custom voices", () => {
  assertEquals(parseSpeechRequest({ model: "voice/public", input: "Hello", voice: "alloy" }), {
    model: "voice/public",
    input: "Hello",
    voice: "alloy",
    responseFormat: "mp3",
    speed: 1,
    streamFormat: "audio",
  });
  assertEquals(
    parseSpeechRequest({
      model: "voice/public",
      input: "😀".repeat(4_096),
      voice: { id: "voice_custom" },
      instructions: "Warm and concise",
      response_format: "opus",
      speed: 0.25,
      stream_format: "sse",
    }).voice,
    { id: "voice_custom" },
  );
  assertEquals(estimateSpeechInputTokens({ input: "1234", instructions: "5678" }), 2);
});

Deno.test("speech request parser rejects malformed and unbounded values", () => {
  for (
    const body of [
      null,
      { model: "voice/public", input: "", voice: "alloy" },
      { model: "voice/public", input: "x".repeat(4_097), voice: "alloy" },
      { model: "voice\npublic", input: "x", voice: "alloy" },
      { model: "voice/public", input: "x", voice: { id: "ok", extra: true } },
      { model: "voice/public", input: "x", voice: "alloy", speed: Number.NaN },
      { model: "voice/public", input: "x", voice: "alloy", speed: 4.01 },
      { model: "voice/public", input: "x", voice: "alloy", response_format: "html" },
      { model: "voice/public", input: "x", voice: "alloy", stream_format: "chunks" },
      { model: "voice/public", input: "x", voice: "alloy", unknown: true },
    ]
  ) assertThrows(() => parseSpeechRequest(body), SpeechProviderError);
});

Deno.test("speech pricing fails closed unless every variable rate is zero", () => {
  const fixed = {
    pricingVersionId: "price",
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 100,
    source: "test",
  };
  assertSpeechFixedPricing(fixed);
  assertThrows(
    () => assertSpeechFixedPricing({ ...fixed, inputMicrosPerMillion: 1 }),
    SpeechProviderError,
    "fixed-call-only",
  );
  assertThrows(
    () => assertSpeechFixedPricing({ ...fixed, fixedCallMicros: 0 }),
    SpeechProviderError,
    "fixed-call-only",
  );
});

function audio(format: SpeechResponseFormat): { bytes: Uint8Array; mime: string } {
  switch (format) {
    case "mp3":
      return {
        bytes: new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]),
        mime: "audio/mpeg",
      };
    case "opus": {
      const bytes = new Uint8Array(48);
      bytes.set(new TextEncoder().encode("OggS"));
      bytes.set(new TextEncoder().encode("OpusHead"), 28);
      return { bytes, mime: "audio/ogg; codecs=opus" };
    }
    case "aac":
      return { bytes: new Uint8Array([0xff, 0xf1, 0x50, 0x80]), mime: "audio/aac" };
    case "flac":
      return { bytes: new TextEncoder().encode("fLaCdata"), mime: "audio/flac" };
    case "wav": {
      const bytes = new Uint8Array(12);
      bytes.set(new TextEncoder().encode("RIFF"));
      bytes.set(new TextEncoder().encode("WAVE"), 8);
      return { bytes, mime: "audio/wav" };
    }
    case "pcm":
      return { bytes: new Uint8Array([0, 0, 1, 0]), mime: "application/octet-stream" };
  }
}

Deno.test("speech adapter rewrites only the model and validates every binary format", async () => {
  for (const format of ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const) {
    const expected = audio(format);
    let upstream: Record<string, unknown> | undefined;
    const result = await createSpeech({
      ...request,
      voice: { id: "voice_123" },
      instructions: "Friendly",
      responseFormat: format,
      speed: 1.5,
    }, {
      baseUrl: "https://speech.example/v1",
      apiKey: "secret",
      upstreamModel: "upstream-tts",
      signal: new AbortController().signal,
      fetch: ((_url: string | URL | Request, init?: RequestInit) => {
        assertEquals(new Headers(init?.headers).get("authorization"), "Bearer secret");
        assertEquals(init?.redirect, "error");
        upstream = JSON.parse(String(init?.body));
        return Promise.resolve(
          new Response(expected.bytes.slice().buffer as ArrayBuffer, {
            headers: { "content-type": expected.mime },
          }),
        );
      }) as typeof fetch,
    });
    assertEquals(result.body, expected.bytes);
    assertEquals(upstream, {
      model: "upstream-tts",
      input: "Hello world",
      voice: { id: "voice_123" },
      instructions: "Friendly",
      response_format: format,
      speed: 1.5,
      stream_format: "audio",
    });
    assertEquals((await result.usage).source, "estimated");
  }
});

Deno.test("speech adapter rejects MIME confusion, invalid signatures, oversized output, and SSE", async () => {
  const invoke = (response: Response, overrides: Partial<SpeechRequest> = {}) =>
    createSpeech({ ...request, ...overrides }, {
      baseUrl: "https://speech.example/v1",
      apiKey: "secret",
      upstreamModel: "tts",
      signal: new AbortController().signal,
      fetch: (() => Promise.resolve(response)) as typeof fetch,
    });
  await assertRejects(
    () => invoke(new Response("<html>", { headers: { "content-type": "text/html" } })),
    SpeechProviderError,
    "content type",
  );
  await assertRejects(
    () =>
      invoke(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
      ),
    SpeechProviderError,
    "invalid audio",
  );
  await assertRejects(
    () =>
      invoke(
        new Response(null, {
          headers: { "content-type": "audio/mpeg", "content-length": "999999999" },
        }),
      ),
    SpeechProviderError,
    "size limit",
  );
});

Deno.test("speech SSE canonicalizes split CRLF events and withholds exactly one terminal", async () => {
  const encoded = btoa("audio");
  const wire =
    `: keepalive\r\nevent: speech.audio.delta\r\nid: delta-1\r\nretry: 1000\r\ndata: {"type":"speech.audio.delta","audio":"${encoded}"}\r\n\r\n` +
    `event: speech.audio.done\r\nid: done-1\r\ndata: {"type":"speech.audio.done","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}\r\n\r\n`;
  const bytes = new TextEncoder().encode(wire);
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 17));
        controller.enqueue(bytes.subarray(17));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const result = await createSpeech({ ...request, streamFormat: "sse" }, {
    baseUrl: "https://speech.example/v1",
    apiKey: "secret",
    upstreamModel: "tts",
    signal: new AbortController().signal,
    fetch: (() => Promise.resolve(response)) as typeof fetch,
  });
  const frames: string[] = [];
  for await (const frame of result.stream!) frames.push(new TextDecoder().decode(frame));
  assertEquals(frames, [`data: {"type":"speech.audio.delta","audio":"${encoded}"}\n\n`]);
  assertEquals(await result.usage, {
    inputTokens: 2,
    outputTokens: 3,
    source: "provider_tokens",
  });
  assertEquals(
    new TextDecoder().decode(await result.terminalFrame),
    'data: {"type":"speech.audio.done","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}\n\n',
  );
});

Deno.test("speech SSE rejects noncanonical Base64, malformed usage, truncation, and post-terminal data", async () => {
  const cases = [
    'data: {"type":"speech.audio.delta","audio":"YR=="}\n\n',
    'data: {"type":"speech.audio.delta","audio":"YQ=="}\n\ndata: {"type":"speech.audio.done","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":9}}\n\n',
    'data: {"type":"speech.audio.delta","audio":"YQ=="}\n\n',
    'data: {"type":"speech.audio.delta","audio":"YQ=="}\n\ndata: {"type":"speech.audio.done","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}\n\ndata: {"type":"speech.audio.delta","audio":"Yg=="}\n\n',
    'event: speech.audio.done\ndata: {"type":"speech.audio.delta","audio":"YQ=="}\n\n',
    'id: one\nid: two\ndata: {"type":"speech.audio.delta","audio":"YQ=="}\n\n',
    'retry: 60001\ndata: {"type":"speech.audio.delta","audio":"YQ=="}\n\n',
  ];
  for (const wire of cases) {
    const result = await createSpeech({ ...request, streamFormat: "sse" }, {
      baseUrl: "https://speech.example/v1",
      apiKey: "secret",
      upstreamModel: "tts",
      signal: new AbortController().signal,
      fetch: (() =>
        Promise.resolve(
          new Response(wire, {
            headers: { "content-type": "text/event-stream" },
          }),
        )) as typeof fetch,
    });
    await assertRejects(async () => {
      for await (const _frame of result.stream!) { /* consume */ }
    }, SpeechProviderError);
  }
});

Deno.test("speech adapter preserves retryable statuses, Retry-After, public 4xx, and cancellation", async () => {
  const invoke = (response: Response, signal = new AbortController().signal) =>
    createSpeech(request, {
      baseUrl: "https://speech.example/v1",
      apiKey: "secret",
      upstreamModel: "tts",
      signal,
      fetch: (() => Promise.resolve(response)) as typeof fetch,
    });
  const limited = await assertRejects(
    () => invoke(new Response("busy", { status: 429, headers: { "retry-after": "2" } })),
    SpeechProviderError,
  );
  assertEquals(limited.providerStatus, 429);
  assertEquals(limited.retryAfterMs, 2_000);
  assertEquals(limited.status, 502);
  const bad = await assertRejects(
    () => invoke(new Response("bad", { status: 400 })),
    SpeechProviderError,
  );
  assertEquals(bad.providerStatus, 400);
  assertEquals(bad.status, 400);
  const controller = new AbortController();
  controller.abort();
  await assertRejects(() => invoke(new Response(), controller.signal), DOMException, "aborted");
});
