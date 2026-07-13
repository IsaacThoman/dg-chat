import { assertEquals } from "jsr:@std/assert@1.0.14";
import { responseMessage, responseObject, responseOutput } from "./responses.ts";

Deno.test("Responses payloads use the official response and output item shapes", () => {
  const pending = responseObject({
    id: "resp_test",
    messageId: "msg_test",
    model: "test/model",
    createdAt: 1,
    status: "in_progress",
  });
  assertEquals(pending.object, "response");
  assertEquals(pending.output_text, "");
  assertEquals(pending.output, []);
  assertEquals(pending.usage, null);
  assertEquals(pending.instructions, null);
  assertEquals(pending.background, false);
  assertEquals(pending.max_output_tokens, null);
  assertEquals(pending.max_tool_calls, null);
  assertEquals(pending.metadata, {});
  assertEquals(pending.parallel_tool_calls, true);
  assertEquals(pending.previous_response_id, null);
  assertEquals(pending.reasoning, { effort: null, summary: null });
  assertEquals(pending.store, false);
  assertEquals(pending.temperature, 1);
  assertEquals(pending.text, { format: { type: "text" } });
  assertEquals(pending.tool_choice, "auto");
  assertEquals(pending.tools, []);
  assertEquals(pending.top_p, 1);
  assertEquals(pending.truncation, "disabled");
  assertEquals(pending.user, null);

  const completed = responseObject({
    id: "resp_test",
    messageId: "msg_test",
    model: "test/model",
    createdAt: 1,
    status: "completed",
    text: "hello",
    usage: { inputTokens: 2, outputTokens: 3 },
    request: {
      instructions: "Be exact",
      maxOutputTokens: 42,
      reasoning: { effort: "high", summary: "auto" },
      temperature: 0.2,
      text: { format: { type: "json_object" } },
      topP: 0.8,
      parallelToolCalls: false,
      toolChoice: "none",
      tools: [{ type: "function", name: "lookup", parameters: {} }],
    },
  });
  assertEquals(completed.output, [responseMessage("msg_test", "hello")]);
  assertEquals(completed.output_text, "hello");
  assertEquals(completed.instructions, "Be exact");
  assertEquals(completed.max_output_tokens, 42);
  assertEquals(completed.reasoning, { effort: "high", summary: "auto" });
  assertEquals(completed.temperature, 0.2);
  assertEquals(completed.text, { format: { type: "json_object" } });
  assertEquals(completed.top_p, 0.8);
  assertEquals(completed.parallel_tool_calls, false);
  assertEquals(completed.tool_choice, "none");
  assertEquals(completed.tools, [{ type: "function", name: "lookup", parameters: {} }]);
  assertEquals(completed.usage?.total_tokens, 5);
});

Deno.test("incomplete Responses mark every buffered output item incomplete", () => {
  const incomplete = responseObject({
    id: "resp_incomplete",
    messageId: "msg_incomplete",
    model: "test/model",
    createdAt: 1,
    status: "incomplete",
    result: {
      id: "upstream",
      model: "upstream",
      content: [{ type: "text", text: "partial" }],
      text: "partial",
      reasoning: { summary: "partial reasoning" },
      toolCalls: [{ id: "call_1", name: "lookup", arguments: '{"partial":', status: "incomplete" }],
      finishState: "length",
    },
  });
  assertEquals(
    (incomplete.output as Array<{ status: string }>).map((item) => item.status),
    ["incomplete", "incomplete", "incomplete"],
  );
  assertEquals(incomplete.completed_at, null);
});

Deno.test("Responses output preserves normalized Chat URL citations", () => {
  assertEquals(
    responseOutput({
      id: "chatcmpl_upstream",
      model: "upstream/model",
      content: [{ type: "text", text: "answer" }],
      text: "answer",
      annotations: [{
        type: "url_citation",
        startIndex: 0,
        endIndex: 6,
        title: "Source",
        url: "https://example.com/source",
      }],
      toolCalls: [],
      finishState: "stop",
    }, "msg_test"),
    [{
      id: "msg_test",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "answer",
        annotations: [{
          type: "url_citation",
          start_index: 0,
          end_index: 6,
          title: "Source",
          url: "https://example.com/source",
        }],
      }],
    }],
  );
});
