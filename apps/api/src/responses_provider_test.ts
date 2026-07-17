import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { ProviderAttemptError } from "./provider-resilience.ts";
import { ResponsesStreamProjector } from "./responses-stream.ts";
import { responseRequestFields } from "./responses.ts";
import {
  completeResponsesChat,
  responsesBufferedReplayUpperBound,
  responsesStreamReplayUpperBound,
  responsesTerminalReplayUpperBound,
  streamResponsesChat,
} from "./responses-provider.ts";

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

const messageLifecycle = (outputIndex: number, itemId: string, contentIndex = 0) => [{
  type: "response.output_item.added",
  output_index: outputIndex,
  item: { id: itemId, type: "message", status: "in_progress", role: "assistant" },
}, {
  type: "response.content_part.added",
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  part: { type: "output_text", text: "", annotations: [] },
}];

Deno.test("Responses terminal replay bound covers duplicate text and JSON escaping", () => {
  assertEquals(responsesTerminalReplayUpperBound(4_096, 0), 13_697_024);
  assertEquals(responsesTerminalReplayUpperBound(0, 123), 1_114_235);
  assertEquals(responsesBufferedReplayUpperBound(0), 12_648_448);
  assertEquals(responsesStreamReplayUpperBound(4_096, 0, 20_000), 61_685_760);
});

Deno.test("Responses stream replay bound covers every escaped projector lifecycle projection", () => {
  const maxOutputTokens = 4_096;
  const text = "\u0000".repeat(maxOutputTokens * 256);
  const projector = new ResponsesStreamProjector({
    responseId: "resp_replay_bound",
    messageId: "msg_replay_bound",
    model: "public/model",
    createdAt: 1,
  });
  const events: Record<string, unknown>[] = [
    projector.createdEvent(),
    projector.inProgressEvent(),
  ];
  // Keep each provider event within the protocol's per-payload ceiling while the accumulated
  // output reaches the long-token byte bound that terminal lifecycle events repeat in full.
  for (const delta of [text.slice(0, 500_000), text.slice(500_000)]) {
    events.push(...projector.push(JSON.stringify({
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    })));
  }
  events.push(...projector.push(JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: maxOutputTokens,
      total_tokens: maxOutputTokens + 1,
    },
  })));
  projector.push("[DONE]");
  events.push(...projector.finish().terminalEvents);
  const frames = events.map((event, sequence) => {
    const payload = { ...event, sequence_number: sequence };
    return `event: ${String(event.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
  });
  const actualBytes = frames.reduce(
    (total, frame) => total + new TextEncoder().encode(frame).byteLength,
    0,
  );
  const bound = responsesStreamReplayUpperBound(maxOutputTokens, 0, frames.length);
  assertEquals(actualBytes <= bound, true);

  // This is the former delta-plus-terminal estimate. The assertion keeps the regression capable
  // of detecting the repeated value/part/item done projections that originally exceeded it.
  const visibleBytes = maxOutputTokens * 256;
  const formerBound = responsesTerminalReplayUpperBound(maxOutputTokens, 0) + Math.max(
    visibleBytes * 6 + frames.length * 512,
    16_777_216,
  );
  assertEquals(actualBytes > formerBound, true);
});

Deno.test("Responses stream replay bound covers created and in-progress request echoes", () => {
  const requestEcho = {
    tools: [{
      type: "function",
      name: "large_echo",
      description: "\u0000".repeat(500_000),
      parameters: { type: "object" },
    }],
  };
  const echoedRequestBytes = new TextEncoder().encode(
    JSON.stringify(responseRequestFields(requestEcho)),
  ).byteLength;
  const projector = new ResponsesStreamProjector({
    responseId: "resp_request_echo",
    messageId: "msg_request_echo",
    model: "public/model",
    createdAt: 1,
    request: requestEcho,
  });
  const events: Record<string, unknown>[] = [projector.createdEvent(), projector.inProgressEvent()];
  events.push(...projector.push(JSON.stringify({
    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })));
  projector.push("[DONE]");
  events.push(...projector.finish().terminalEvents);
  const actualBytes = events.reduce((total, event, sequence) =>
    total + new TextEncoder().encode(
      `event: ${String(event.type)}\ndata: ${
        JSON.stringify({
          ...event,
          sequence_number: sequence,
        })
      }\n\n`,
    ).byteLength, 0);
  const bound = responsesStreamReplayUpperBound(
    1,
    echoedRequestBytes,
    events.length,
    1_024,
  );
  assertEquals(actualBytes <= bound, true);
  assertEquals(actualBytes > bound - echoedRequestBytes * 2, true);
});

const messageDone = (
  outputIndex: number,
  itemId: string,
  text: string,
  status: "completed" | "incomplete" = "completed",
  contentIndex = 0,
) => [{
  type: "response.output_text.done",
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  text,
}, {
  type: "response.content_part.done",
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  part: { type: "output_text", text, annotations: [] },
}, {
  type: "response.output_item.done",
  output_index: outputIndex,
  item: {
    id: itemId,
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  },
}];

Deno.test("native Responses buffered adapter transforms the request and preserves canonical output", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const nativeInput = [{
    id: "rs_previous",
    type: "reasoning",
    summary: [],
    encrypted_content: "opaque-reasoning-state",
  }, { role: "user", content: "continue" }];
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
    requestFields: {
      store: false,
      metadata: { trace: "buffered" },
      input: nativeInput,
      requiresNativeInput: true,
    },
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
  assertEquals(capturedBody.input, nativeInput);
  assertEquals("requiresNativeInput" in capturedBody, false);
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

Deno.test("native Responses adapter never dispatches provider-managed network tools", async () => {
  for (
    const tool of [
      { type: "web_search", search_context_size: "medium" },
      { type: "mcp", server_label: "docs", server_url: "https://mcp.example.test" },
    ]
  ) {
    let dispatched = false;
    await assertRejects(
      () =>
        completeResponsesChat(
          { model: "public/model", messages: [{ role: "user", content: "search" }] },
          new AbortController().signal,
          {
            baseUrl: "https://provider.example/v1",
            apiKey: "secret",
            upstreamModel: "upstream-model",
            requestFields: {
              request: { model: "public/model", input: "search", tools: [tool] },
              store: false,
              requiresNativeInput: true,
            },
            fetch: () => {
              dispatched = true;
              return Promise.resolve(Response.json({}));
            },
          },
        ),
      ProviderAttemptError,
      tool.type === "mcp" ? "Remote MCP tools are disabled" : "web search is disabled",
    );
    assertEquals(dispatched, false);
  }
});

Deno.test("native Responses SSE adapter exposes Chat chunks, usage, and one DONE", async () => {
  let capturedBody: Record<string, unknown> = {};
  const events = [
    { type: "response.created", response: { id: "resp_stream", model: "upstream-model" } },
    { type: "response.in_progress", response: { id: "resp_stream", model: "upstream-model" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_stream", type: "reasoning", status: "in_progress" },
    },
    {
      type: "response.reasoning_summary_part.added",
      item_id: "rs_stream",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_stream",
      output_index: 0,
      summary_index: 0,
      delta: "summary",
    },
    ...messageLifecycle(1, "msg_stream"),
    {
      type: "response.output_text.delta",
      item_id: "msg_stream",
      output_index: 1,
      content_index: 0,
      delta: "hello ",
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_stream",
      output_index: 1,
      content_index: 0,
      delta: "world",
    },
    {
      type: "response.output_text.annotation.added",
      item_id: "msg_stream",
      output_index: 1,
      content_index: 0,
      annotation: {
        type: "url_citation",
        start_index: 6,
        end_index: 11,
        title: "Source",
        url: "https://example.test/source",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: {
        type: "function_call",
        id: "item",
        status: "in_progress",
        call_id: "call",
        name: "lookup",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 2,
      item_id: "item",
      delta: "{}",
    },
    {
      type: "response.reasoning_summary_text.done",
      item_id: "rs_stream",
      output_index: 0,
      summary_index: 0,
      text: "summary",
    },
    {
      type: "response.reasoning_summary_part.done",
      item_id: "rs_stream",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "summary" },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_stream",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "summary" }],
        content: [],
      },
    },
    ...messageDone(1, "msg_stream", "hello world"),
    {
      type: "response.function_call_arguments.done",
      output_index: 2,
      item_id: "item",
      name: "lookup",
      arguments: "{}",
    },
    {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        type: "function_call",
        id: "item",
        status: "completed",
        call_id: "call",
        name: "lookup",
        arguments: "{}",
      },
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
              ...messageLifecycle(0, "msg_bound"),
              {
                type: "response.output_text.delta",
                item_id: "msg_bound",
                output_index: 0,
                content_index: 0,
                delta: " ".repeat(1_024),
              },
              ...messageDone(0, "msg_bound", " ".repeat(1_024)),
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
                  ...messageLifecycle(0, "msg_bound_rejected"),
                  {
                    type: "response.output_text.delta",
                    item_id: "msg_bound_rejected",
                    output_index: 0,
                    content_index: 0,
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

Deno.test("Responses streams terminate on official lifecycle events and reject bare DONE", async () => {
  const terminal = [
    { type: "response.created", response: { id: "resp_terminal", model: "upstream-model" } },
    ...messageLifecycle(0, "msg_terminal"),
    {
      type: "response.output_text.delta",
      item_id: "msg_terminal",
      output_index: 0,
      content_index: 0,
      delta: "ok",
    },
    ...messageDone(0, "msg_terminal", "ok"),
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
  let cancelled = false;
  const frames: string[] = [];
  await Promise.race([
    (async () => {
      for await (
        const frame of streamResponsesChat(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          upstreamModel: "upstream-model",
          fetch: () =>
            Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode(terminal));
                    // Deliberately remain open. The official terminal event must finish parsing
                    // without waiting for transport EOF or a non-standard [DONE] marker.
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
            ),
        })
      ) frames.push(frame);
    })(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("official terminal waited for EOF")), 250)
    ),
  ]);
  assertEquals(frames.at(-1), "[DONE]");
  assertEquals(cancelled, true);

  await assertRejects(
    async () => {
      for await (
        const _ of streamResponsesChat(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          upstreamModel: "upstream-model",
          fetch: () =>
            Promise.resolve(
              new Response("data: [DONE]\n\n", {
                headers: { "content-type": "text/event-stream" },
              }),
            ),
        })
      ) { /* consume */ }
    },
    ProviderAttemptError,
    "before an official terminal",
  );
});

Deno.test("native Responses streams reject invalid lifecycle prefixes before text is exposed", async () => {
  const created = {
    type: "response.created",
    response: { id: "resp_lifecycle", model: "upstream-model", status: "in_progress" },
  };
  const message = messageLifecycle(0, "msg_lifecycle");
  const invalidCases: Array<{ name: string; events: unknown[]; message: string }> = [{
    name: "duplicate created",
    events: [created, created],
    message: "duplicate response.created",
  }, {
    name: "changed response id",
    events: [created, {
      type: "response.in_progress",
      response: { id: "resp_changed", model: "upstream-model", status: "in_progress" },
    }],
    message: "changed response id",
  }, {
    name: "changed terminal model",
    events: [created, {
      type: "response.completed",
      response: {
        id: "resp_lifecycle",
        model: "different-model",
        status: "completed",
        output: [],
      },
    }],
    message: "changed response model",
  }, {
    name: "delta before item",
    events: [created, {
      type: "response.output_text.delta",
      item_id: "msg_lifecycle",
      output_index: 0,
      content_index: 0,
      delta: "must remain buffered",
    }],
    message: "preceded output_item.added",
  }, {
    name: "delta before content part",
    events: [created, message[0], {
      type: "response.output_text.delta",
      item_id: "msg_lifecycle",
      output_index: 0,
      content_index: 0,
      delta: "must remain buffered",
    }],
    message: "preceded content_part.added",
  }, {
    name: "changed item id",
    events: [created, ...message, {
      type: "response.output_text.delta",
      item_id: "msg_changed",
      output_index: 0,
      content_index: 0,
      delta: "must remain buffered",
    }],
    message: "item identity changed",
  }, {
    name: "content part not closed",
    events: [created, ...message, {
      type: "response.output_text.done",
      item_id: "msg_lifecycle",
      output_index: 0,
      content_index: 0,
      text: "",
    }, {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_lifecycle",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
    }],
    message: "preceded content_part.done",
  }, {
    name: "output item not closed",
    events: [created, ...message, {
      type: "response.completed",
      response: {
        id: "resp_lifecycle",
        model: "upstream-model",
        status: "completed",
        output: [{
          id: "msg_lifecycle",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        }],
      },
    }],
    message: "preceded output_item.done",
  }, {
    name: "function arguments not closed",
    events: [created, {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_lifecycle",
        type: "function_call",
        status: "in_progress",
        call_id: "call_lifecycle",
        name: "lookup",
        arguments: "",
      },
    }, {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "fc_lifecycle",
        type: "function_call",
        status: "completed",
        call_id: "call_lifecycle",
        name: "lookup",
        arguments: "{}",
      },
    }],
    message: "preceded function_call_arguments.done",
  }, {
    name: "terminal item identity changed",
    events: [created, ...message, ...messageDone(0, "msg_lifecycle", ""), {
      type: "response.completed",
      response: {
        id: "resp_lifecycle",
        model: "upstream-model",
        status: "completed",
        output: [{
          id: "msg_changed_at_terminal",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        }],
      },
    }],
    message: "conflicts with its streamed identity",
  }];

  for (const invalid of invalidCases) {
    const exposed: string[] = [];
    const error = await assertRejects(
      async () => {
        for await (
          const frame of streamResponsesChat(request, new AbortController().signal, {
            baseUrl: "https://provider.example/v1",
            apiKey: "secret",
            fetch: () =>
              Promise.resolve(
                new Response(
                  invalid.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
          })
        ) exposed.push(frame);
      },
      ProviderAttemptError,
      invalid.message,
      invalid.name,
    );
    assertEquals(error.options.category, "invalid_response", invalid.name);
    assertEquals(error.options.transient, true, invalid.name);
    assertEquals(
      exposed.some((frame) => frame.includes("must remain buffered")),
      false,
      invalid.name,
    );
  }
});

Deno.test("native Responses SSE adapter maps incomplete terminals to Chat length", async () => {
  const events = [
    { type: "response.created", response: { id: "resp_incomplete", model: "upstream-model" } },
    ...messageLifecycle(0, "msg_incomplete"),
    {
      type: "response.output_text.delta",
      item_id: "msg_incomplete",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    },
    ...messageDone(0, "msg_incomplete", "partial", "incomplete"),
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
                      response: {
                        id: `resp_${code}`,
                        model: "upstream-model",
                        status: "failed",
                        output: [],
                        error: { code, message: "failed" },
                      },
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

Deno.test("native Responses provider timeouts retain retry and public error classification", async () => {
  const timedOut = () => Promise.reject(new DOMException("deadline exceeded", "TimeoutError"));
  const buffered = await assertRejects(
    () =>
      completeResponsesChat(request, new AbortController().signal, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        fetch: timedOut,
      }),
    ProviderAttemptError,
    "timed out",
  );
  assertEquals(buffered.options, {
    category: "timeout",
    status: 504,
    transient: true,
    code: "timeout",
  });

  const streamed = await assertRejects(
    async () => {
      for await (
        const _ of streamResponsesChat(request, new AbortController().signal, {
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          fetch: timedOut,
        })
      ) { /* consume */ }
    },
    ProviderAttemptError,
    "timed out",
  );
  assertEquals(streamed.options, {
    category: "timeout",
    status: 504,
    transient: true,
    code: "timeout",
  });
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
  assertEquals(error.options.param, "request.stop");
});

Deno.test("Responses streaming rejects authoritative done values that conflict with deltas", async () => {
  const events = [
    {
      type: "response.created",
      response: { id: "resp_mismatch", status: "in_progress", model: "upstream" },
    },
    ...messageLifecycle(0, "msg_mismatch"),
    {
      type: "response.output_text.delta",
      item_id: "msg_mismatch",
      output_index: 0,
      content_index: 0,
      delta: "exposed text",
    },
    {
      type: "response.output_text.done",
      item_id: "msg_mismatch",
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

Deno.test("Responses streaming rejects terminal citations that conflict with live annotations", async () => {
  const citation = (url: string) => ({
    type: "url_citation",
    start_index: 0,
    end_index: 1,
    title: "source",
    url,
  });
  const live = citation("https://example.test/live");
  const terminal = citation("https://example.test/terminal");
  const item = (annotations: unknown[]) => ({
    id: "msg_citation_mismatch",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "x", annotations }],
  });
  const events = [
    {
      type: "response.created",
      response: { id: "resp_citation_mismatch", status: "in_progress", model: "upstream" },
    },
    ...messageLifecycle(0, "msg_citation_mismatch"),
    {
      type: "response.output_text.delta",
      item_id: "msg_citation_mismatch",
      output_index: 0,
      content_index: 0,
      delta: "x",
    },
    {
      type: "response.output_text.annotation.added",
      item_id: "msg_citation_mismatch",
      output_index: 0,
      content_index: 0,
      annotation_index: 0,
      annotation: live,
    },
    {
      type: "response.output_text.done",
      item_id: "msg_citation_mismatch",
      output_index: 0,
      content_index: 0,
      text: "x",
    },
    {
      type: "response.content_part.done",
      item_id: "msg_citation_mismatch",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "x", annotations: [live] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: item([live]),
    },
    {
      type: "response.completed",
      response: {
        id: "resp_citation_mismatch",
        object: "response",
        status: "completed",
        model: "upstream",
        output: [item([terminal])],
      },
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
    "terminal citations conflict",
  );
});

Deno.test("Responses streaming globalizes citations from later output text parts", async () => {
  const citation = {
    type: "url_citation",
    start_index: 0,
    end_index: 1,
    title: "second part",
    url: "https://example.test/second",
  };
  const content = [
    { type: "output_text", text: "a", annotations: [] },
    { type: "output_text", text: "b", annotations: [citation] },
  ];
  const partLifecycle = (contentIndex: number, text: string, annotations: unknown[]) => [
    {
      type: "response.content_part.added",
      item_id: "msg_multi_part",
      output_index: 0,
      content_index: contentIndex,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_multi_part",
      output_index: 0,
      content_index: contentIndex,
      delta: text,
    },
    ...(annotations.length
      ? [{
        type: "response.output_text.annotation.added",
        item_id: "msg_multi_part",
        output_index: 0,
        content_index: contentIndex,
        annotation_index: 0,
        annotation: annotations[0],
      }]
      : []),
    {
      type: "response.output_text.done",
      item_id: "msg_multi_part",
      output_index: 0,
      content_index: contentIndex,
      text,
    },
    {
      type: "response.content_part.done",
      item_id: "msg_multi_part",
      output_index: 0,
      content_index: contentIndex,
      part: { type: "output_text", text, annotations },
    },
  ];
  const messageItem = {
    id: "msg_multi_part",
    type: "message",
    status: "completed",
    role: "assistant",
    content,
  };
  const events = [
    {
      type: "response.created",
      response: { id: "resp_multi_part", status: "in_progress", model: "upstream" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg_multi_part",
        type: "message",
        status: "in_progress",
        role: "assistant",
      },
    },
    ...partLifecycle(0, "a", []),
    ...partLifecycle(1, "b", [citation]),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: messageItem,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_multi_part",
        object: "response",
        status: "completed",
        model: "upstream",
        output: [messageItem],
      },
    },
  ];
  const frames: string[] = [];
  for await (
    const frame of streamResponsesChat(request, new AbortController().signal, {
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
  ) frames.push(frame);
  assertEquals(frames.some((frame) => frame.includes('"start_index":1')), true);
  assertEquals(frames.some((frame) => frame.includes('"end_index":2')), true);
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
    ...messageLifecycle(0, "msg_chunked").map((event) => `data: ${JSON.stringify(event)}\n\n`),
    `data: ${
      JSON.stringify({
        type: "response.output_text.delta",
        item_id: "msg_chunked",
        output_index: 0,
        content_index: 0,
        delta: text,
      })
    }\n\n`,
    ...messageDone(0, "msg_chunked", text).map((event) => `data: ${JSON.stringify(event)}\n\n`),
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
