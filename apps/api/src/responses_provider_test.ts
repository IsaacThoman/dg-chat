import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { ProviderAttemptError } from "./provider-resilience.ts";
import { completeResponsesChat, streamResponsesChat } from "./responses-provider.ts";

const request = {
  model: "public/model",
  messages: [{
    role: "user" as const,
    content: [
      { type: "text" as const, text: "describe" },
      {
        type: "image_url" as const,
        image_url: { url: "https://example.test/image.png", detail: "high" as const },
      },
    ],
  }],
  tools: [{
    type: "function" as const,
    function: { name: "lookup", description: "Look up a value", parameters: { type: "object" } },
  }],
  max_completion_tokens: 64,
  user: "caller-123",
};

Deno.test("native Responses buffered adapter transforms the request and preserves canonical output", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const result = await completeResponsesChat(request, new AbortController().signal, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    upstreamModel: "upstream-model",
    customParams: {
      temperature: 0.2,
      top_p: 0.8,
      parallel_tool_calls: false,
      response_format: { type: "json_object" },
      model: "forbidden",
      stream: true,
    },
    requestFields: { store: false, metadata: { trace: "buffered" } },
    fetch: (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "resp_1",
            model: "upstream-model",
            created_at: 20,
            status: "completed",
            output: [
              {
                id: "rs_1",
                type: "reasoning",
                status: "completed",
                summary: [{ type: "summary_text", text: "summary" }],
                content: [{ type: "reasoning_text", text: "reasoning" }],
              },
              {
                id: "msg_1",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{
                  type: "output_text",
                  text: "hello",
                  annotations: [{
                    type: "url_citation",
                    start_index: 0,
                    end_index: 5,
                    title: "Source",
                    url: "https://example.test/source",
                  }],
                }],
              },
              {
                type: "function_call",
                id: "item_1",
                call_id: "call_1",
                name: "lookup",
                arguments: "{}",
                status: "completed",
              },
            ],
            usage: {
              input_tokens: 9,
              output_tokens: 6,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 3 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
  });

  assertEquals(capturedUrl, "https://provider.example/v1/responses");
  assertEquals(capturedBody.model, "upstream-model");
  assertEquals(capturedBody.stream, false);
  assertEquals(capturedBody.temperature, 0.2);
  assertEquals(capturedBody.top_p, 0.8);
  assertEquals(capturedBody.parallel_tool_calls, false);
  assertEquals(capturedBody.store, false);
  assertEquals(capturedBody.metadata, { trace: "buffered" });
  assertEquals(capturedBody.user, "caller-123");
  assertEquals(capturedBody.text, { format: { type: "json_object" } });
  assertEquals(Array.isArray(capturedBody.input), true);
  assertEquals(Array.isArray(capturedBody.tools), true);
  assertEquals(result.text, "hello");
  assertEquals(result.inputTokens, 9);
  assertEquals(result.outputTokens, 6);
  assertEquals(result.cachedInputTokens, 2);
  assertEquals(result.reasoningTokens, 3);
  const upstream = result.upstream as Record<string, unknown>;
  const choice = (upstream.choices as Record<string, unknown>[])[0];
  assertEquals(choice.finish_reason, "tool_calls");
  const message = choice.message as Record<string, unknown>;
  assertEquals(message.reasoning_content, "reasoning");
  assertEquals(message.reasoning_summary, "summary");
  assertEquals(message.tool_calls, [{
    id: "call_1",
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  }]);
  assertEquals(message.annotations, [{
    type: "url_citation",
    url_citation: {
      start_index: 0,
      end_index: 5,
      title: "Source",
      url: "https://example.test/source",
    },
  }]);
});

Deno.test("native Responses SSE adapter exposes Chat chunks, usage, and one DONE", async () => {
  let capturedBody: Record<string, unknown> = {};
  const events = [
    { type: "response.created", response: { id: "resp_stream", model: "upstream-model" } },
    { type: "response.in_progress", response: { id: "resp_stream", model: "upstream-model" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", role: "assistant" },
    },
    { type: "response.reasoning_summary_text.delta", delta: "summary" },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "hello ",
    },
    {
      type: "response.output_text.delta",
      output_index: 2,
      content_index: 0,
      delta: "world",
    },
    {
      type: "response.output_text.annotation.added",
      output_index: 2,
      content_index: 0,
      annotation: {
        type: "url_citation",
        start_index: 0,
        end_index: 5,
        title: "Source",
        url: "https://example.test/source",
      },
    },
    { type: "response.refusal.done", refusal: "" },
    {
      type: "response.output_item.added",
      output_index: 3,
      item: { type: "function_call", id: "item", call_id: "call", name: "lookup" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 3,
      item_id: "item",
      delta: "{}",
    },
    {
      type: "response.completed",
      response: {
        id: "resp_stream",
        model: "upstream-model",
        status: "completed",
        output: [
          {
            id: "rs_stream",
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: "summary" }],
            content: [],
          },
          {
            id: "msg_stream",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "hello world",
              annotations: [{
                type: "url_citation",
                start_index: 6,
                end_index: 11,
                title: "Source",
                url: "https://example.test/source",
              }],
            }],
          },
          {
            id: "item",
            type: "function_call",
            status: "completed",
            call_id: "call",
            name: "lookup",
            arguments: "{}",
          },
        ],
        usage: { input_tokens: 9, output_tokens: 6, total_tokens: 15 },
      },
    },
  ];
  const stream = streamResponsesChat(request, new AbortController().signal, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    upstreamModel: "upstream-model",
    customParams: { temperature: 0.1, top_p: 0.9, model: "forbidden", stream: false },
    requestFields: { store: false, metadata: { trace: "streaming" } },
    fetch: (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return (
        Promise.resolve(
          new Response(
            `${
              events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
            }data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
        )
      );
    },
  });
  const frames: string[] = [];
  for await (const frame of stream) frames.push(frame);
  assertEquals(frames.filter((frame) => frame === "[DONE]").length, 1);
  assertEquals(frames.some((frame) => frame.includes('"content":"hello "')), true);
  assertEquals(frames.some((frame) => frame.includes('"content":"world"')), true);
  assertEquals(frames.some((frame) => frame.includes('"reasoning_summary":"summary"')), true);
  assertEquals(frames.some((frame) => frame.includes('"annotations":[')), true);
  assertEquals(frames.some((frame) => frame.includes('"prompt_tokens":9')), true);
  assertEquals(frames.some((frame) => frame.includes('"finish_reason":"tool_calls"')), true);
  const chunks = frames.filter((frame) => frame !== "[DONE]").map((frame) => JSON.parse(frame));
  assertEquals(
    chunks.filter((chunk) => chunk.choices?.length === 0 && chunk.usage === undefined).length,
    1,
  );
  const annotation =
    chunks.find((chunk) => chunk.choices?.[0]?.delta?.annotations).choices[0].delta.annotations[0]
      .url_citation;
  assertEquals(annotation.start_index, 6);
  assertEquals(annotation.end_index, 11);
  const tool = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls)
    .choices[0].delta.tool_calls[0];
  assertEquals(tool.index, 0);
  assertEquals(tool.id, "call");
  assertEquals(capturedBody.model, "upstream-model");
  assertEquals(capturedBody.stream, true);
  assertEquals(capturedBody.temperature, 0.1);
  assertEquals(capturedBody.top_p, 0.9);
  assertEquals(capturedBody.store, false);
  assertEquals(capturedBody.metadata, { trace: "streaming" });
  assertEquals(capturedBody.user, "caller-123");
});

Deno.test("native Responses SSE dispatches a complete terminal event at EOF", async () => {
  const terminal = {
    type: "response.completed",
    response: {
      id: "resp_eof",
      model: "upstream-model",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    },
  };
  const payload = [
    {
      type: "response.created",
      response: { id: "resp_eof", model: "upstream-model", status: "in_progress" },
    },
    terminal,
  ].map((event, index) => `data: ${JSON.stringify(event)}${index === 0 ? "\n\n" : ""}`).join("");
  const frames: string[] = [];
  for await (
    const frame of streamResponsesChat(request, new AbortController().signal, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      fetch: () =>
        Promise.resolve(
          new Response(payload, { headers: { "content-type": "text/event-stream" } }),
        ),
    })
  ) frames.push(frame);
  assertEquals(frames.at(-1), "[DONE]");

  await assertRejects(
    async () => {
      for await (
        const _frame of streamResponsesChat(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          fetch: () =>
            Promise.resolve(
              new Response('data: {"type":"response.completed"', {
                headers: { "content-type": "text/event-stream" },
              }),
            ),
        })
      ) { /* consume */ }
    },
    ProviderAttemptError,
    "malformed JSON",
  );
});

Deno.test("Responses output byte bounds allow long tokens and retain hard ceilings", async () => {
  const completeWithText = (text: string) =>
    completeResponsesChat(request, new AbortController().signal, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      upstreamModel: "upstream-model",
      maxResponseBytes: 1_048_576,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "resp_bound",
              model: "upstream-model",
              status: "completed",
              output: [{
                id: "msg_bound",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text }],
              }],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
    });
  const accepted = await completeWithText(" ".repeat(1_024));
  assertEquals(accepted.text.length, 1_024);
  assertEquals(accepted.outputTokens, 64);
  await assertRejects(
    () => completeWithText(" ".repeat(64 * 256 + 1)),
    ProviderAttemptError,
    "output bound",
  );

  const streamed: string[] = [];
  for await (
    const frame of streamResponsesChat(request, new AbortController().signal, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      upstreamModel: "upstream-model",
      fetch: () =>
        Promise.resolve(
          new Response(
            [
              { type: "response.created", response: { id: "resp_bound", model: "upstream-model" } },
              { type: "response.output_text.delta", delta: " ".repeat(1_024) },
              {
                type: "response.completed",
                response: {
                  id: "resp_bound",
                  model: "upstream-model",
                  status: "completed",
                  output: [{
                    id: "msg_bound",
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [{ type: "output_text", text: " ".repeat(1_024) }],
                  }],
                  usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
                },
              },
            ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    })
  ) streamed.push(frame);
  assertEquals(streamed.some((frame) => frame.includes(" ".repeat(1_024))), true);

  await assertRejects(
    async () => {
      for await (
        const _ of streamResponsesChat(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          upstreamModel: "upstream-model",
          fetch: () =>
            Promise.resolve(
              new Response(
                [
                  {
                    type: "response.created",
                    response: { id: "resp_bound_rejected", model: "upstream-model" },
                  },
                  {
                    type: "response.output_text.delta",
                    delta: " ".repeat(64 * 256 + 1),
                  },
                ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
                { headers: { "content-type": "text/event-stream" } },
              ),
            ),
        })
      ) { /* consume */ }
    },
    ProviderAttemptError,
    "output bound",
  );
});

Deno.test("Responses streams reject duplicate DONE and non-marker post-terminal data", async () => {
  const terminal = [
    { type: "response.created", response: { id: "resp_terminal", model: "upstream-model" } },
    { type: "response.output_text.delta", delta: "ok" },
    {
      type: "response.completed",
      response: {
        id: "resp_terminal",
        model: "upstream-model",
        status: "completed",
        output: [{
          id: "msg_terminal",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  for (
    const suffix of [
      "data: [DONE]\n\ndata: [DONE]\n\n",
      'data: {"type":"response.in_progress","response":{}}\n\n',
    ]
  ) {
    await assertRejects(
      async () => {
        for await (
          const _ of streamResponsesChat(request, new AbortController().signal, {
            baseUrl: "https://provider.example/v1",
            apiKey: "secret",
            upstreamModel: "upstream-model",
            fetch: () =>
              Promise.resolve(
                new Response(terminal + suffix, {
                  headers: { "content-type": "text/event-stream" },
                }),
              ),
          })
        ) { /* consume */ }
      },
      ProviderAttemptError,
      "after its terminal",
    );
  }
});

Deno.test("native Responses SSE adapter maps incomplete terminals to Chat length", async () => {
  const events = [
    { type: "response.created", response: { id: "resp_incomplete", model: "upstream-model" } },
    { type: "response.output_text.delta", delta: "partial" },
    {
      type: "response.incomplete",
      response: {
        id: "resp_incomplete",
        model: "upstream-model",
        status: "incomplete",
        output: [{
          id: "msg_incomplete",
          type: "message",
          status: "incomplete",
          role: "assistant",
          content: [{ type: "output_text", text: "partial" }],
        }],
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
      },
    },
  ];
  const frames: string[] = [];
  for await (
    const frame of streamResponsesChat(request, new AbortController().signal, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      upstreamModel: "upstream-model",
      fetch: () =>
        Promise.resolve(
          new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    })
  ) frames.push(frame);
  assertEquals(frames.some((frame) => frame.includes('"finish_reason":"length"')), true);
  assertEquals(frames.at(-1), "[DONE]");
});

Deno.test("native Responses adapter classifies status and malformed stream failures", async () => {
  const status = await assertRejects(
    () =>
      completeResponsesChat(request, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: () =>
          Promise.resolve(
            new Response('{"error":{"message":"busy","code":"overloaded"}}', {
              status: 503,
              headers: { "content-type": "application/json", "retry-after": "2" },
            }),
          ),
      }),
    ProviderAttemptError,
    "busy",
  );
  assertEquals(status.options.status, 503);
  assertEquals(status.options.retryAfterMs, 2_000);

  await assertRejects(
    async () => {
      for await (
        const _ of streamResponsesChat(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          fetch: () =>
            Promise.resolve(
              new Response("data: {\n\n", {
                headers: { "content-type": "text/event-stream" },
              }),
            ),
        })
      ) { /* consume */ }
    },
    ProviderAttemptError,
    "malformed",
  );
});

Deno.test("Responses body and stream errors distinguish permanent from transient failures", async () => {
  for (
    const [code, transient, category] of [
      ["invalid_prompt", false, "invalid_response"],
      ["server_error", true, "upstream_unavailable"],
      ["invalid_api_key", false, "authentication"],
    ] as const
  ) {
    const buffered = await assertRejects(
      () =>
        completeResponsesChat(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          fetch: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  id: `resp_${code}`,
                  model: "upstream-model",
                  status: "failed",
                  output: [],
                  error: { code, message: "failed" },
                }),
                { headers: { "content-type": "application/json" } },
              ),
            ),
        }),
      ProviderAttemptError,
      code,
    );
    assertEquals(buffered.options.transient, transient);
    assertEquals(buffered.options.category, category);

    const streamed = await assertRejects(
      async () => {
        for await (
          const _ of streamResponsesChat(request, new AbortController().signal, {
            baseUrl: "https://provider.example/v1",
            apiKey: "secret",
            fetch: () =>
              Promise.resolve(
                new Response(
                  `data: ${
                    JSON.stringify({
                      type: "response.created",
                      response: { id: `resp_${code}`, model: "upstream-model" },
                    })
                  }\n\ndata: ${
                    JSON.stringify({
                      type: "response.failed",
                      response: { error: { code, message: "failed" } },
                    })
                  }\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
          })
        ) { /* consume */ }
      },
      ProviderAttemptError,
      code,
    );
    assertEquals(streamed.options.transient, transient);
    assertEquals(streamed.options.category, category);
  }
});

Deno.test("native Responses streaming propagates caller cancellation to transport", async () => {
  const controller = new AbortController();
  let transportAborted = false;
  const stream = streamResponsesChat(request, controller.signal, {
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("transport signal missing");
        signal.addEventListener("abort", () => {
          transportAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
  });
  const pending = stream.next();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assertRejects(() => pending, DOMException, "cancelled");
  assertEquals(transportAborted, true);
});

Deno.test("lossy Chat to Responses options fail before transport without fallback eligibility", async () => {
  let dispatched = false;
  const error = await assertRejects(
    () =>
      completeResponsesChat({ ...request, stop: "END" }, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: () => {
          dispatched = true;
          return Promise.reject(new Error("must not dispatch"));
        },
      }),
    ProviderAttemptError,
  );
  assertEquals(dispatched, false);
  assertEquals(error.options.category, "invalid_request");
  assertEquals(error.options.transient, false);
});

Deno.test("Responses streaming rejects authoritative done values that conflict with deltas", async () => {
  const events = [
    {
      type: "response.created",
      response: { id: "resp_mismatch", status: "in_progress", model: "upstream" },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "exposed text",
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      text: "different terminal text",
    },
  ];
  await assertRejects(
    async () => {
      for await (
        const _event of streamResponsesChat(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          fetch: () =>
            Promise.resolve(
              new Response(
                events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
                { headers: { "content-type": "text/event-stream" } },
              ),
            ),
        })
      ) { /* consume */ }
    },
    ProviderAttemptError,
    "conflicts with streamed deltas",
  );
});

Deno.test("Responses SSE parsing remains linear across many small transport chunks", async () => {
  const text = "x".repeat(32_768);
  const payload = new TextEncoder().encode([
    `data: ${
      JSON.stringify({
        type: "response.created",
        response: { id: "resp_chunked", status: "in_progress", model: "upstream" },
      })
    }\n\n`,
    `data: ${
      JSON.stringify({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: text,
      })
    }\n\n`,
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_chunked",
          status: "completed",
          model: "upstream",
          output: [{
            id: "msg_chunked",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text }],
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      })
    }\n\n`,
  ].join(""));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.length) return controller.close();
      controller.enqueue(payload.subarray(offset, Math.min(offset + 7, payload.length)));
      offset += 7;
    },
  });
  const output: string[] = [];
  for await (
    const event of streamResponsesChat(
      { ...request, max_completion_tokens: 131_072 },
      new AbortController().signal,
      {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: () =>
          Promise.resolve(
            new Response(body, {
              headers: { "content-type": "text/event-stream" },
            }),
          ),
      },
    )
  ) output.push(event);
  assertEquals(output.some((event) => event.includes(text)), true);
  assertEquals(output.at(-1), "[DONE]");
});
