import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { complete, parseOpenAIEventStream, streamChatCompletion } from "./models.ts";

const encoder = new TextEncoder();
const request: ChatCompletionRequest = {
  model: "openai/default",
  messages: [{ role: "user", content: "hello" }],
  stream: false,
};

function byteStream(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<string>) {
  const values: string[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

Deno.test("upstream streaming preserves split SSE chunks and terminal DONE", async () => {
  let postedBody: Record<string, unknown> | undefined;
  let acceptHeader: string | null = null;
  const fetchMock = ((_input: string | URL | Request, init?: RequestInit) => {
    postedBody = JSON.parse(String(init?.body));
    acceptHeader = new Headers(init?.headers).get("accept");
    return Promise.resolve(
      new Response(
        byteStream([
          ": keepalive\r",
          '\ndata: {"id":"one","choices":[{"delta":{"content":"Hel"}}]}\r\n\r',
          '\ndata: {"id":"two",\n',
          'data: "choices":[]}\n\n',
          "data: [DO",
          "NE]\n\n",
        ]),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      ),
    );
  }) as typeof fetch;

  const chunks = await collect(streamChatCompletion(request, new AbortController().signal, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    upstreamModel: "provider-model",
    fetch: fetchMock,
  }));

  assertEquals(chunks, [
    '{"id":"one","choices":[{"delta":{"content":"Hel"}}]}',
    '{"id":"two",\n"choices":[]}',
    "[DONE]",
  ]);
  assertEquals(acceptHeader, "text/event-stream");
  assertEquals(postedBody?.model, "provider-model");
  assertEquals(postedBody?.stream, true);
});

Deno.test("upstream streaming propagates caller abort to fetch", async () => {
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | undefined;
  const fetchMock = ((_input: string | URL | Request, init?: RequestInit) => {
    upstreamSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      upstreamSignal?.addEventListener("abort", () => reject(upstreamSignal?.reason), {
        once: true,
      });
    });
  }) as typeof fetch;

  const collecting = collect(streamChatCompletion(request, controller.signal, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    fetch: fetchMock,
  }));
  await Promise.resolve();
  controller.abort(new DOMException("client disconnected", "AbortError"));

  await assertRejects(() => collecting, DOMException, "client disconnected");
  assert(upstreamSignal?.aborted);
});

Deno.test("SSE parser cancels an open response body when the caller disconnects", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const collecting = collect(parseOpenAIEventStream(body, controller.signal));
  await Promise.resolve();
  controller.abort(new DOMException("stream disconnected", "AbortError"));

  await assertRejects(() => collecting, DOMException, "stream disconnected");
  assert(cancelled);
});

Deno.test("upstream streaming rejects successful non-SSE responses", async () => {
  const fetchMock = (() => Promise.resolve(Response.json({ choices: [] }))) as typeof fetch;
  await assertRejects(
    () =>
      collect(streamChatCompletion(request, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: fetchMock,
      })),
    Error,
    "non-SSE",
  );
});

Deno.test("SSE parser rejects malformed JSON and streams without DONE", async () => {
  await assertRejects(
    () =>
      collect(parseOpenAIEventStream(
        byteStream(["data: not-json\n\n"]),
        new AbortController().signal,
      )),
    Error,
    "malformed JSON",
  );
  await assertRejects(
    () =>
      collect(parseOpenAIEventStream(
        byteStream(['data: {"choices":[]}\n\n']),
        new AbortController().signal,
      )),
    Error,
    "without [DONE]",
  );
  await assertRejects(
    () =>
      collect(parseOpenAIEventStream(
        byteStream(['data: {"choices":[]}']),
        new AbortController().signal,
      )),
    Error,
    "mid-frame",
  );
});

Deno.test("SSE parser bounds cumulative wire bytes including ignored metadata", async () => {
  const padded = (value: string) => `data: ${JSON.stringify({ choices: [], metadata: value })}\n\n`;
  await assertRejects(
    () =>
      collect(parseOpenAIEventStream(
        byteStream([padded("a".repeat(600)), padded("b".repeat(600)), "data: [DONE]\n\n"]),
        new AbortController().signal,
        undefined,
        1_024,
      )),
    Error,
    "size limit",
  );
});

Deno.test("upstream streaming surfaces structured provider errors", async () => {
  const fetchMock = (() =>
    Promise.resolve(Response.json(
      { error: { message: "provider overloaded" } },
      { status: 503 },
    ))) as typeof fetch;
  await assertRejects(
    () =>
      collect(streamChatCompletion(request, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: fetchMock,
      })),
    Error,
    "provider overloaded",
  );
});

Deno.test("upstream timeout remains active after response headers", async () => {
  let cancelled = false;
  const fetchMock = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )) as typeof fetch;
  await assertRejects(
    () =>
      collect(streamChatCompletion(request, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        timeoutMs: 100,
        fetch: fetchMock,
      })),
    DOMException,
  );
  assert(cancelled);
});

Deno.test("streaming rejects unsafe usage, content, and tool delta fields", async () => {
  const invalidChunks = [
    '{"choices":[],"usage":{"prompt_tokens":-1}}',
    '{"choices":[],"usage":{"completion_tokens":1000000001}}',
    '{"choices":[],"usage":{"total_tokens":1e309}}',
    '{"choices":[],"usage":{"completion_tokens_details":{"reasoning_tokens":-1}}}',
    '{"choices":[{"delta":{"content":42}}]}',
    '{"choices":[{"delta":{"tool_calls":{}}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":999}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":42}}]}}]}',
  ];
  for (const chunk of invalidChunks) {
    await assertRejects(
      () =>
        collect(parseOpenAIEventStream(
          byteStream([`data: ${chunk}\n\ndata: [DONE]\n\n`]),
          new AbortController().signal,
        )),
      Error,
      "invalid",
    );
  }
});

Deno.test("non-stream completions validate shapes and bounded usage", async () => {
  const invalidPayloads = [
    { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: -1 } },
    { choices: [{ message: { content: "ok" } }], usage: { completion_tokens: 1_000_000_001 } },
    { choices: [{ message: { content: 7 } }] },
    { choices: [{ message: { content: null, tool_calls: [{}] } }], usage: "NaN" },
  ];
  for (const payload of invalidPayloads) {
    const fetchMock = (() => Promise.resolve(Response.json(payload))) as typeof fetch;
    await assertRejects(
      () =>
        complete(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          fetch: fetchMock,
        }),
      Error,
      "invalid",
    );
  }

  const infinityFetch = (() =>
    Promise.resolve(
      new Response(
        '{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1e309}}',
        { headers: { "content-type": "application/json" } },
      ),
    )) as typeof fetch;
  await assertRejects(
    () =>
      complete(request, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: infinityFetch,
      }),
    Error,
    "invalid",
  );

  for (const usage of [{ prompt_tokens: 10_000 }, { completion_tokens: 4_097 }]) {
    const fetchMock = (() =>
      Promise.resolve(
        Response.json({ choices: [{ message: { content: "ok" } }], usage }),
      )) as typeof fetch;
    await assertRejects(
      () =>
        complete(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          fetch: fetchMock,
        }),
      Error,
      "exceeds",
    );
  }
});

Deno.test("non-stream success and error bodies enforce byte caps", async () => {
  for (
    const response of [
      new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        padding: "x".repeat(2_000),
      })),
      new Response(JSON.stringify({ error: { message: "x".repeat(2_000) } }), { status: 503 }),
    ]
  ) {
    const fetchMock = (() => Promise.resolve(response)) as typeof fetch;
    await assertRejects(
      () =>
        complete(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          maxResponseBytes: 1_024,
          fetch: fetchMock,
        }),
      Error,
      "size limit",
    );
  }
});

Deno.test("provider bounds include tool schemas and cumulative generated output", async () => {
  const requestWithTools: ChatCompletionRequest = {
    ...request,
    max_tokens: 8,
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "d".repeat(300),
        parameters: { type: "object", properties: {} },
      },
    }],
  };
  const fullPromptBytes = encoder.encode(JSON.stringify(requestWithTools)).length;
  const messageBytes = encoder.encode(JSON.stringify(requestWithTools.messages)).length;
  const promptTokens = Math.min(fullPromptBytes, messageBytes + 20);
  assert(promptTokens > messageBytes);
  const validFetch = (() =>
    Promise.resolve(Response.json({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
    }))) as typeof fetch;
  assertEquals(
    (await complete(requestWithTools, new AbortController().signal, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      fetch: validFetch,
    })).inputTokens,
    promptTokens,
  );

  const oversized = { ...request, max_tokens: 1 };
  const nonStreamFetch = (() =>
    Promise.resolve(
      Response.json({ choices: [{ message: { content: "12345" } }] }),
    )) as typeof fetch;
  await assertRejects(
    () =>
      complete(oversized, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: nonStreamFetch,
      }),
    Error,
    "output bound",
  );
  const streamFetch = (() =>
    Promise.resolve(
      new Response(
        byteStream([
          'data: {"choices":[{"delta":{"content":"12345"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )) as typeof fetch;
  await assertRejects(
    () =>
      collect(streamChatCompletion({ ...oversized, stream: true }, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: streamFetch,
      })),
    Error,
    "output bound",
  );
});

Deno.test({
  name: "production provider URLs reject IPv4 and IPv6 special-use literals",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const previous = Deno.env.get("DENO_ENV");
    Deno.env.set("DENO_ENV", "production");
    try {
      for (
        const host of [
          "127.0.0.1",
          "10.0.0.1",
          "100.64.0.1",
          "169.254.169.254",
          "192.0.2.1",
          "[::1]",
          "[fc00::1]",
          "[fe80::1]",
          "[2001:db8::1]",
          "[::ffff:127.0.0.1]",
        ]
      ) {
        await assertRejects(
          () =>
            collect(streamChatCompletion(request, new AbortController().signal, {
              baseUrl: `https://${host}/v1`,
              apiKey: "secret",
              fetch: (() => {
                throw new Error("fetch must not be reached");
              }) as typeof fetch,
            })),
          Error,
          "private network",
        );
      }
    } finally {
      if (previous === undefined) Deno.env.delete("DENO_ENV");
      else Deno.env.set("DENO_ENV", previous);
    }
  },
});
