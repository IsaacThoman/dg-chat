import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { parseOpenAIEventStream, streamChatCompletion } from "./models.ts";

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
