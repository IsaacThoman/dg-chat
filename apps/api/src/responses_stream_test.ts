import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.14";
import { ProviderProtocolError } from "./provider-protocol.ts";
import { ResponsesStreamProjector } from "./responses-stream.ts";

function chunk(input: Record<string, unknown>) {
  return JSON.stringify({
    id: "chatcmpl-upstream",
    object: "chat.completion.chunk",
    created: 1,
    model: "upstream",
    ...input,
  });
}

Deno.test("Responses stream projection caps accumulated citation bytes before emission", () => {
  const projector = new ResponsesStreamProjector({
    responseId: "resp_citation_limit",
    messageId: "msg_citation_limit",
    model: "public/model",
    createdAt: 10,
  });
  const annotations = Array.from({ length: 22 }, (_, index) => ({
    type: "url_citation",
    url_citation: {
      start_index: 0,
      end_index: 1,
      title: "\u0000".repeat(8_192),
      url: `https://example.test/${index}/` + "a".repeat(16_000),
    },
  }));
  const error = assertThrows(
    () =>
      projector.push(chunk({
        choices: [{
          index: 0,
          delta: { content: "x", annotations },
          finish_reason: null,
        }],
      })),
    ProviderProtocolError,
  );
  assertEquals(error.code, "payload_too_large");
});

Deno.test("Responses stream projection rejects citation ranges beyond accumulated text", () => {
  const projector = new ResponsesStreamProjector({
    responseId: "resp_citation_range",
    messageId: "msg_citation_range",
    model: "public/model",
    createdAt: 10,
  });
  const error = assertThrows(
    () =>
      projector.push(chunk({
        choices: [{
          index: 0,
          delta: {
            content: "x",
            annotations: [{
              type: "url_citation",
              url_citation: {
                start_index: 0,
                end_index: 2,
                title: "outside",
                url: "https://example.test/outside",
              },
            }],
          },
          finish_reason: null,
        }],
      })),
    ProviderProtocolError,
  );
  assertEquals(error.code, "malformed_payload");
});

Deno.test("Responses stream projection preserves live reasoning, text, citations, tools, and usage", () => {
  const projector = new ResponsesStreamProjector({
    responseId: "resp_public",
    messageId: "msg_public",
    model: "public/model",
    createdAt: 10,
  });
  assertEquals(projector.createdEvent().type, "response.created");
  assertEquals(projector.inProgressEvent().type, "response.in_progress");

  const events = [
    ...projector.push(chunk({
      choices: [{
        index: 0,
        delta: { reasoning_summary: "brief " },
        finish_reason: null,
      }],
    })),
    ...projector.push(chunk({
      choices: [{
        index: 0,
        delta: {
          content: "answer",
          annotations: [{
            type: "url_citation",
            url_citation: {
              start_index: 0,
              end_index: 6,
              title: "Source",
              url: "https://example.com/source",
            },
          }],
        },
        finish_reason: null,
      }],
    })),
    ...projector.push(chunk({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_weather",
            type: "function",
            function: { name: "weather", arguments: '{"city":' },
          }],
        },
        finish_reason: null,
      }],
    })),
    ...projector.push(chunk({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 5,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    })),
    ...projector.push("[DONE]"),
  ];

  assertEquals(
    events.some((event) => event.type === "response.reasoning_summary_text.delta"),
    true,
  );
  assertEquals(events.some((event) => event.type === "response.output_text.delta"), true);
  assertEquals(
    events.some((event) => event.type === "response.output_text.annotation.added"),
    true,
  );
  assertEquals(
    events.some((event) => event.type === "response.function_call_arguments.delta"),
    true,
  );
  assertEquals(projector.usage?.outputTokens, 5);

  const finished = projector.finish();
  assertEquals(finished.terminalEvents.at(-1)?.type, "response.completed");
  assertEquals(finished.response.status, "completed");
  const serialized = JSON.stringify(finished.response);
  assertStringIncludes(serialized, "brief ");
  assertStringIncludes(serialized, "https://example.com/source");
  assertStringIncludes(serialized, "call_weather");
  assertStringIncludes(serialized, '{\\"city\\":\\"NYC\\"}');
  assertEquals(finished.response.usage, {
    input_tokens: 9,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 14,
  });
});

Deno.test("Responses stream projection reports max-output truncation as incomplete", () => {
  const projector = new ResponsesStreamProjector({
    responseId: "resp_incomplete",
    messageId: "msg_incomplete",
    model: "public/model",
    createdAt: 10,
  });
  projector.push(chunk({
    choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }],
  }));
  projector.push("[DONE]");
  const finished = projector.finish();
  assertEquals(finished.terminalEvents.at(-1)?.type, "response.incomplete");
  assertEquals(finished.response.status, "incomplete");
  assertEquals(finished.response.incomplete_details, { reason: "max_output_tokens" });
  assertEquals(finished.response.completed_at, null);
  assertEquals(
    (finished.response.output as Array<{ status: string }>).map((item) => item.status),
    ["incomplete"],
  );
  assertEquals(
    finished.terminalEvents.find((event) => event.type === "response.output_item.done")?.item,
    {
      id: "msg_incomplete",
      type: "message",
      status: "incomplete",
      role: "assistant",
      content: [{ type: "output_text", text: "partial", annotations: [] }],
    },
  );
});

Deno.test("Responses stream preserves partial function calls on incomplete responses", () => {
  const projector = new ResponsesStreamProjector({
    responseId: "resp_tool_incomplete",
    messageId: "msg_tool_incomplete",
    model: "public/model",
    createdAt: 10,
  });
  projector.push(chunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"partial":' },
        }],
      },
      finish_reason: "length",
    }],
  }));
  projector.push("[DONE]");
  const finished = projector.finish();
  assertEquals(finished.response.output, [{
    id: (finished.response.output as Array<{ id: string }>)[0].id,
    type: "function_call",
    status: "incomplete",
    call_id: "call_1",
    name: "lookup",
    arguments: '{"partial":',
  }]);
  assertEquals(
    finished.terminalEvents.some((event) => event.type === "response.function_call_arguments.done"),
    false,
  );
});

Deno.test("Responses stream preserves first-seen content indexes when refusal precedes text", () => {
  const projector = new ResponsesStreamProjector({
    responseId: "resp_order",
    messageId: "msg_order",
    model: "public/model",
    createdAt: 10,
  });
  const refusal = projector.push(chunk({
    choices: [{ index: 0, delta: { refusal: "no" }, finish_reason: null }],
  }));
  const text = projector.push(chunk({
    choices: [{ index: 0, delta: { content: "context" }, finish_reason: "stop" }],
  }));
  projector.push("[DONE]");
  assertEquals(
    refusal.find((event) => event.type === "response.refusal.delta")?.content_index,
    0,
  );
  assertEquals(
    text.find((event) => event.type === "response.output_text.delta")?.content_index,
    1,
  );
  const finished = projector.finish({
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
    totalTokens: 3,
  });
  const message = (finished.response.output as Array<Record<string, unknown>>).find((item) =>
    item.type === "message"
  )!;
  assertEquals(message.content, [
    { type: "refusal", refusal: "no" },
    { type: "output_text", text: "context", annotations: [] },
  ]);
  assertEquals(finished.response.output_text, "context");
  assertEquals((finished.response.usage as Record<string, unknown>).total_tokens, 3);
});

Deno.test("Responses stream rejects missing finish states and malformed terminal tools", () => {
  const unfinished = new ResponsesStreamProjector({
    responseId: "resp_unfinished",
    messageId: "msg_unfinished",
    model: "public/model",
    createdAt: 10,
  });
  unfinished.push(chunk({
    choices: [{ index: 0, delta: { content: "text" }, finish_reason: null }],
  }));
  unfinished.push("[DONE]");
  assertThrows(() => unfinished.finish(), Error, "valid finish state");

  for (
    const tool of [
      { id: "call_1", function: { arguments: "{}" } },
      { id: "call_1", function: { name: "lookup", arguments: "not json" } },
      { function: { name: "lookup", arguments: "{}" } },
    ]
  ) {
    const malformed = new ResponsesStreamProjector({
      responseId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      model: "public/model",
      createdAt: 10,
    });
    malformed.push(chunk({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, type: "function", ...tool }] },
        finish_reason: "tool_calls",
      }],
    }));
    malformed.push("[DONE]");
    assertThrows(() => malformed.finish(), Error, "function call");
  }
});
