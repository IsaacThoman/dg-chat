import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  AUDIO_MAX_FILE_BYTES,
  AudioProviderError,
  type AudioRequest,
  createAudioTranscription,
  serializeAudioMultipart,
} from "./audio.ts";
import { parseAudioMultipart } from "./audio-multipart.ts";
import { UploadSecurityError } from "./upload-security.ts";

const wav = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46,
  0x24,
  0,
  0,
  0,
  0x57,
  0x41,
  0x56,
  0x45,
  0x66,
  0x6d,
  0x74,
  0x20,
  16,
  0,
  0,
  0,
  1,
  0,
  1,
  0,
  0x40,
  0x1f,
  0,
  0,
  0x80,
  0x3e,
  0,
  0,
  2,
  0,
  16,
  0,
  0x64,
  0x61,
  0x74,
  0x61,
  0,
  0,
  0,
  0,
]);

function form(file = new File([wav], "sample.wav", { type: "audio/wav" })): FormData {
  const value = new FormData();
  value.set("file", file);
  value.set("model", "public/transcribe");
  return value;
}

Deno.test("audio multipart validates WAV and browser WebM signatures", async () => {
  const parsed = await parseAudioMultipart(
    new Request("http://local/v1/audio/transcriptions", {
      method: "POST",
      body: form(),
    }),
    "transcriptions",
  );
  assertEquals(parsed.model, "public/transcribe");
  assertEquals(parsed.mime, "audio/wav");
  assertEquals(parsed.responseFormat, "json");
  assertEquals(parsed.fileSha256.length, 64);

  const webm = new Uint8Array([
    0x1a,
    0x45,
    0xdf,
    0xa3,
    0x87,
    0x42,
    0x82,
    0x84,
    0x77,
    0x65,
    0x62,
    0x6d,
    0x18,
    0x53,
    0x80,
    0x67,
    0xff,
    0x16,
    0x54,
    0xae,
    0x6b,
    0x8d,
    0xae,
    0x8b,
    0x83,
    0x81,
    0x02,
    0x86,
    0x86,
    0x41,
    0x5f,
    0x4f,
    0x50,
    0x55,
    0x53,
  ]);
  const browser = form(new File([webm], "recording.webm", { type: "audio/webm;codecs=opus" }));
  const browserParsed = await parseAudioMultipart(
    new Request("http://local", {
      method: "POST",
      body: browser,
    }),
    "transcriptions",
  );
  assertEquals(browserParsed.mime, "audio/webm");

  const m4a = new Uint8Array(60);
  const m4aView = new DataView(m4a.buffer);
  for (
    const [offset, size, type] of [
      [0, 16, "ftyp"],
      [16, 44, "moov"],
      [24, 36, "trak"],
      [32, 28, "mdia"],
      [40, 20, "hdlr"],
    ] as const
  ) {
    m4aView.setUint32(offset, size);
    m4a.set(new TextEncoder().encode(type), offset + 4);
  }
  m4a.set(new TextEncoder().encode("M4A "), 8);
  m4a.set(new TextEncoder().encode("soun"), 56);
  const m4aParsed = await parseAudioMultipart(
    new Request("http://local", {
      method: "POST",
      body: form(new File([m4a], "recording.m4a", { type: "audio/mp4" })),
    }),
    "transcriptions",
  );
  assertEquals(m4aParsed.mime, "audio/mp4");

  const tailMoov = new Uint8Array(70_060);
  const tailView = new DataView(tailMoov.buffer);
  tailView.setUint32(0, 16);
  tailMoov.set(new TextEncoder().encode("ftypM4A "), 4);
  tailView.setUint32(16, 70_000);
  tailMoov.set(new TextEncoder().encode("mdat"), 20);
  for (
    const [offset, size, type] of [
      [70_016, 44, "moov"],
      [70_024, 36, "trak"],
      [70_032, 28, "mdia"],
      [70_040, 20, "hdlr"],
    ] as const
  ) {
    tailView.setUint32(offset, size);
    tailMoov.set(new TextEncoder().encode(type), offset + 4);
  }
  tailMoov.set(new TextEncoder().encode("soun"), 70_056);
  const tailParsed = await parseAudioMultipart(
    new Request("http://local", {
      method: "POST",
      body: form(new File([tailMoov], "tail-moov.m4a", { type: "audio/mp4" })),
    }),
    "transcriptions",
  );
  assertEquals(tailParsed.mime, "audio/mp4");
});

Deno.test("audio multipart rejects spoofed signatures, duplicate fields, and invalid combinations", async () => {
  await assertRejects(
    () =>
      parseAudioMultipart(
        new Request("http://local", {
          method: "POST",
          body: form(new File([new Uint8Array([1, 2, 3])], "fake.wav", { type: "audio/wav" })),
        }),
        "transcriptions",
      ),
    UploadSecurityError,
  );
  const embeddedMoov = new Uint8Array(76);
  const embeddedView = new DataView(embeddedMoov.buffer);
  embeddedView.setUint32(0, 16);
  embeddedMoov.set(new TextEncoder().encode("ftypM4A "), 4);
  embeddedView.setUint32(16, 60);
  embeddedMoov.set(new TextEncoder().encode("mdat"), 20);
  for (
    const [offset, size, type] of [
      [24, 52, "moov"],
      [32, 44, "trak"],
      [40, 36, "mdia"],
      [48, 28, "hdlr"],
    ] as const
  ) {
    embeddedView.setUint32(offset, size);
    embeddedMoov.set(new TextEncoder().encode(type), offset + 4);
  }
  embeddedMoov.set(new TextEncoder().encode("soun"), 64);
  await assertRejects(
    () =>
      parseAudioMultipart(
        new Request("http://local", {
          method: "POST",
          body: form(new File([embeddedMoov], "embedded-moov.m4a", { type: "audio/mp4" })),
        }),
        "transcriptions",
      ),
    UploadSecurityError,
  );
  const fakeMp4 = new Uint8Array(40);
  new DataView(fakeMp4.buffer).setUint32(0, 16);
  fakeMp4.set(new TextEncoder().encode("ftypM4A "), 4);
  new DataView(fakeMp4.buffer).setUint32(16, 24);
  fakeMp4.set(new TextEncoder().encode("hdlr"), 20);
  fakeMp4.set(new TextEncoder().encode("soun"), 32);
  await assertRejects(
    () =>
      parseAudioMultipart(
        new Request("http://local", {
          method: "POST",
          body: form(new File([fakeMp4], "fake.m4a", { type: "audio/mp4" })),
        }),
        "transcriptions",
      ),
    UploadSecurityError,
  );
  await assertRejects(
    () =>
      parseAudioMultipart(
        new Request("http://local", {
          method: "POST",
          body: form(
            new File(
              [
                new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
              ],
              "fake.webm",
              { type: "audio/webm" },
            ),
          ),
        }),
        "transcriptions",
      ),
    UploadSecurityError,
  );
  const invalid = form();
  invalid.append("model", "second/model");
  await assertRejects(
    () =>
      parseAudioMultipart(
        new Request("http://local", { method: "POST", body: invalid }),
        "transcriptions",
      ),
    UploadSecurityError,
    "Duplicate",
  );
  const timestamps = form();
  timestamps.set("timestamp_granularities[]", "word");
  await assertRejects(
    () =>
      parseAudioMultipart(
        new Request("http://local", { method: "POST", body: timestamps }),
        "transcriptions",
      ),
    UploadSecurityError,
    "verbose_json",
  );
});

Deno.test("audio multipart rejects a chunked file that crosses the streamed byte limit", async () => {
  const oversized = new Uint8Array(AUDIO_MAX_FILE_BYTES + 1);
  oversized.set(wav.subarray(0, Math.min(wav.length, oversized.length)));
  const request = new Request("http://local", {
    method: "POST",
    body: form(new File([oversized], "oversized.wav", { type: "audio/wav" })),
  });
  // Request/FormData is chunked by the runtime and intentionally has no Content-Length, so this
  // proves the streamed Busboy limit rather than the cheap declared-length preflight.
  assertEquals(request.headers.has("content-length"), false);
  await assertRejects(
    () => parseAudioMultipart(request, "transcriptions"),
    UploadSecurityError,
    "byte limit",
  );
});

Deno.test("audio multipart normalizes missing boundaries and prematurely terminated bodies", async () => {
  await assertRejects(
    () =>
      parseAudioMultipart(
        new Request("http://local", {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=" },
          body: "broken",
        }),
        "transcriptions",
      ),
    UploadSecurityError,
    "malformed or incomplete",
  );
  await assertRejects(
    () =>
      parseAudioMultipart(
        new Request("http://local", {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=partial" },
          body: '--partial\r\nContent-Disposition: form-data; name="model"\r\n\r\npublic/model',
        }),
        "transcriptions",
      ),
    UploadSecurityError,
    "malformed or incomplete",
  );
});

Deno.test("audio adapter rewrites model, serializes fresh multipart, and validates JSON", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
    language: "en",
  };
  const first = serializeAudioMultipart(request, "whisper-upstream");
  const second = serializeAudioMultipart(request, "whisper-upstream");
  assertEquals(first.contentType === second.contentType, false);
  assertStringIncludes(new TextDecoder().decode(first.body), "whisper-upstream");
  let seenAuthorization = "";
  const result = await createAudioTranscription("transcriptions", request, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    upstreamModel: "whisper-upstream",
    signal: new AbortController().signal,
    fetch: (_input, init) => {
      seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(
        new Response(JSON.stringify({ text: "hello" }), {
          headers: { "content-type": "text/html" },
        }),
      );
    },
  });
  assertEquals(seenAuthorization, "Bearer secret");
  assertEquals(result.contentType, "application/json");
  assertEquals(JSON.parse(new TextDecoder().decode(result.body)), { text: "hello" });
  assertEquals(await result.usage, {
    inputTokens: wav.byteLength,
    outputTokens: 2,
    source: "estimated",
  });
});

Deno.test("audio adapter assigns canonical text and VTT response content types", async () => {
  const base: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "text",
  };
  const call = (request: AudioRequest) =>
    createAudioTranscription("transcriptions", request, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      upstreamModel: "whisper",
      signal: new AbortController().signal,
      fetch: () =>
        Promise.resolve(
          new Response("hello", {
            headers: { "content-type": "text/html" },
          }),
        ),
    });
  assertEquals((await call(base)).contentType, "text/plain");
  assertEquals((await call({ ...base, responseFormat: "vtt" })).contentType, "text/vtt");
});

Deno.test("audio multipart accepts and forwards modern diarization and streaming fields", async () => {
  const body = form();
  body.set("response_format", "diarized_json");
  body.set("stream", "true");
  body.set(
    "chunking_strategy",
    JSON.stringify({
      type: "server_vad",
      threshold: 0.45,
      prefix_padding_ms: 250,
      silence_duration_ms: 700,
    }),
  );
  body.append("known_speaker_names[]", "agent");
  body.append("known_speaker_references[]", "data:audio/wav;base64,UklGRg==");
  const parsed = await parseAudioMultipart(
    new Request("http://local/v1/audio/transcriptions", { method: "POST", body }),
    "transcriptions",
  );
  assertEquals(parsed.stream, true);
  assertEquals(parsed.chunkingStrategy, {
    type: "server_vad",
    threshold: 0.45,
    prefix_padding_ms: 250,
    silence_duration_ms: 700,
  });
  assertEquals(parsed.knownSpeakerNames, ["agent"]);
  assertEquals(parsed.knownSpeakerReferences, ["data:audio/wav;base64,UklGRg=="]);

  const serialized = new TextDecoder().decode(serializeAudioMultipart(parsed, "diarize-1").body);
  for (
    const expected of [
      'name="stream"\r\n\r\ntrue',
      'name="chunking_strategy"',
      'name="known_speaker_names[]"\r\n\r\nagent',
      'name="known_speaker_references[]"\r\n\r\ndata:audio/wav;base64,UklGRg==',
    ]
  ) assertStringIncludes(serialized, expected);

  const logprobs = form();
  logprobs.set("response_format", "json");
  logprobs.append("include[]", "logprobs");
  const parsedLogprobs = await parseAudioMultipart(
    new Request("http://local/v1/audio/transcriptions", { method: "POST", body: logprobs }),
    "transcriptions",
  );
  assertEquals(parsedLogprobs.include, ["logprobs"]);
});

Deno.test("audio multipart rejects invalid modern option combinations", async () => {
  const invalid = async (mutate: (body: FormData) => void) => {
    const body = form();
    mutate(body);
    await assertRejects(
      () =>
        parseAudioMultipart(
          new Request("http://local/v1/audio/transcriptions", { method: "POST", body }),
          "transcriptions",
        ),
      UploadSecurityError,
    );
  };
  await invalid((body) => body.set("stream", "yes"));
  await invalid((body) => body.append("include[]", "timestamps"));
  await invalid((body) => {
    body.set("response_format", "verbose_json");
    body.append("include[]", "logprobs");
  });
  await invalid((body) => body.set("chunking_strategy", '{"type":"client_vad"}'));
  await invalid((body) => {
    body.set("response_format", "diarized_json");
    body.append("known_speaker_names[]", "agent");
  });
  await invalid((body) => {
    body.set("response_format", "diarized_json");
    body.append("known_speaker_names[]", "agent name");
    body.append("known_speaker_references[]", "https://example.com/reference.wav");
  });

  const chunking = form();
  chunking.set("chunking_strategy", "auto");
  assertEquals(
    (await parseAudioMultipart(
      new Request("http://local/v1/audio/transcriptions", { method: "POST", body: chunking }),
      "transcriptions",
    )).chunkingStrategy,
    "auto",
  );

  // Known-speaker hints are valid independently of whether annotations are requested.
  const speakerHint = form();
  speakerHint.append("known_speaker_names[]", "agent");
  speakerHint.append("known_speaker_references[]", "data:audio/wav;base64,UklGRg==");
  assertEquals(
    (await parseAudioMultipart(
      new Request("http://local/v1/audio/transcriptions", { method: "POST", body: speakerHint }),
      "transcriptions",
    )).knownSpeakerNames,
    ["agent"],
  );
});

Deno.test("audio adapter validates and canonicalizes bounded transcription SSE with usage", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
    stream: true,
    include: ["logprobs"],
  };
  const result = await createAudioTranscription("transcriptions", request, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    upstreamModel: "transcribe-1",
    signal: new AbortController().signal,
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"type":"transcript.text.delta","delta":"hel"}\r\n\r\n' +
                  'data: {"type":"transcript.text.done","text":"hello","usage":{"input_tokens":7,"output_tokens":2}}\n\n',
              ));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream; charset=utf-8" } },
        ),
      ),
  });
  const frames: string[] = [];
  for await (const frame of result.stream!) frames.push(new TextDecoder().decode(frame));
  assertEquals(frames, [
    'data: {"type":"transcript.text.delta","delta":"hel"}\n\n',
    'data: {"type":"transcript.text.done","text":"hello","usage":{"input_tokens":7,"output_tokens":2}}\n\n',
  ]);
  assertEquals(await result.usage, {
    inputTokens: 7,
    outputTokens: 2,
    source: "provider_tokens",
  });
});

Deno.test("audio adapter cancels and rejects malformed transcription SSE", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
    stream: true,
  };
  let cancelled = false;
  const result = await createAudioTranscription("transcriptions", request, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    upstreamModel: "transcribe-1",
    signal: new AbortController().signal,
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"untrusted.event"}\n\n'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  await assertRejects(
    async () => {
      for await (const _frame of result.stream!) { /* no-op */ }
    },
    AudioProviderError,
    "unsupported SSE event",
  );
  await result.usage?.catch(() => undefined);
  assertEquals(cancelled, true);
});

Deno.test("audio adapter cancels upstream and settles usage when a stream consumer stops early", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
    stream: true,
  };
  let cancelled = false;
  const result = await createAudioTranscription("transcriptions", request, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    upstreamModel: "transcribe-1",
    signal: new AbortController().signal,
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"type":"transcript.text.delta","delta":"hello"}\n\n',
              ));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  const iterator = result.stream![Symbol.asyncIterator]();
  assertEquals((await iterator.next()).done, false);
  await iterator.return?.();
  await assertRejects(() => result.usage!, DOMException, "consumer disconnected");
  assertEquals(cancelled, true);
});

Deno.test("audio SSE ignores comment lines and requires exactly one final done event", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
    stream: true,
  };
  const call = (body: string) =>
    createAudioTranscription("transcriptions", request, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      upstreamModel: "transcribe-1",
      signal: new AbortController().signal,
      fetch: () =>
        Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
    });
  const valid = await call(
    ": keepalive\nevent: transcript.text.delta\nid: provider-event-1\nretry: 1000\n" +
      'data: {"type":"transcript.text.delta","delta":"hello"}\n\n' +
      ": another keepalive\n\n" +
      'data: {"type":"transcript.text.done","text":"hello"}\n\n',
  );
  const frames: string[] = [];
  for await (const frame of valid.stream!) frames.push(new TextDecoder().decode(frame));
  assertEquals(frames, [
    'data: {"type":"transcript.text.delta","delta":"hello"}\n\n',
    'data: {"type":"transcript.text.done","text":"hello"}\n\n',
  ]);

  for (
    const invalid of [
      'data: {"type":"transcript.text.delta","delta":"truncated"}\n\n',
      'data: {"type":"transcript.text.delta"}\n\n',
      'data: {"type":"transcript.text.delta","delta":7}\n\n',
      'data: {"type":"transcript.text.done"}\n\n',
      'data: {"type":"transcript.text.done","text":null}\n\n',
      'data: {"type":"transcript.text.segment"}\n\n',
      'data: {"type":"transcript.text.done","text":"one"}\n\n' +
      'data: {"type":"transcript.text.done","text":"two"}\n\n',
      'data: {"type":"transcript.text.done","text":"done"}\n\n' +
      'data: {"type":"transcript.text.delta","delta":"late"}\n\n',
    ]
  ) {
    const result = await call(invalid);
    await assertRejects(async () => {
      for await (const _frame of result.stream!) { /* consume */ }
    }, AudioProviderError);
    await result.usage?.catch(() => undefined);
  }
});

Deno.test("audio SSE rejects mismatched or unsafe transport metadata", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
    stream: true,
  };
  for (
    const prefix of [
      "event: transcript.text.done\n",
      "id: one\nid: two\n",
      "retry: -1\n",
      "retry: 60001\n",
      "unknown: value\n",
    ]
  ) {
    const result = await createAudioTranscription("transcriptions", request, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      upstreamModel: "transcribe-1",
      signal: new AbortController().signal,
      fetch: () =>
        Promise.resolve(
          new Response(
            `${prefix}data: {"type":"transcript.text.delta","delta":"hello"}\n\n` +
              'data: {"type":"transcript.text.done","text":"hello"}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    });
    await assertRejects(async () => {
      for await (const _frame of result.stream!) { /* consume */ }
    }, AudioProviderError);
    await result.usage?.catch(() => undefined);
  }
});

Deno.test("audio usage rejects malformed and overflowing payloads", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
  };
  for (
    const usage of [
      { type: "tokens", input_tokens: 3 },
      { type: "tokens", input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1 },
      { type: "tokens", input_tokens: 3, output_tokens: 2, total_tokens: 4 },
    ]
  ) {
    await assertRejects(
      () =>
        createAudioTranscription("transcriptions", request, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          upstreamModel: "transcribe-1",
          signal: new AbortController().signal,
          fetch: () => Promise.resolve(Response.json({ text: "hello", usage })),
        }),
      AudioProviderError,
    );
  }
  const duration = await createAudioTranscription("transcriptions", request, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    upstreamModel: "transcribe-1",
    signal: new AbortController().signal,
    fetch: () =>
      Promise.resolve(Response.json({
        text: "hello",
        usage: { type: "duration", seconds: 5 },
      })),
  });
  assertEquals(await duration.usage, {
    inputTokens: 0,
    outputTokens: 0,
    source: "provider_duration",
    durationSeconds: 5,
  });
});

Deno.test("audio provider errors preserve upstream status and validated Retry-After", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
  };
  try {
    await createAudioTranscription("transcriptions", request, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      upstreamModel: "transcribe-1",
      signal: new AbortController().signal,
      fetch: () =>
        Promise.resolve(
          new Response("busy", {
            status: 429,
            headers: { "retry-after": "1.25" },
          }),
        ),
    });
    throw new Error("expected provider error");
  } catch (error) {
    if (!(error instanceof AudioProviderError)) throw error;
    assertEquals(error.status, 502);
    assertEquals(error.providerStatus, 429);
    assertEquals(error.retryAfterMs, 1_250);
  }
});

Deno.test("audio adapter rejects malformed and oversized provider responses", async () => {
  const request: AudioRequest = {
    model: "public/transcribe",
    file: wav,
    filename: "sample.wav",
    mime: "audio/wav",
    fileSha256: "a".repeat(64),
    responseFormat: "json",
  };
  await assertRejects(
    () =>
      createAudioTranscription("transcriptions", request, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        upstreamModel: "whisper",
        signal: new AbortController().signal,
        fetch: () => Promise.resolve(new Response("not-json")),
      }),
    AudioProviderError,
    "invalid JSON",
  );
  await assertRejects(
    () =>
      createAudioTranscription("transcriptions", request, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        upstreamModel: "whisper",
        signal: new AbortController().signal,
        fetch: () =>
          Promise.resolve(new Response(null, { headers: { "content-length": "5000000" } })),
      }),
    AudioProviderError,
    "size limit",
  );
});
