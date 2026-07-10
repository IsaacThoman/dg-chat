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
  assertEquals(pending.output, []);
  assertEquals(pending.usage, null);

  const completed = responseObject({
    id: "resp_test",
    messageId: "msg_test",
    model: "test/model",
    createdAt: 1,
    status: "completed",
    text: "hello",
    usage: { inputTokens: 2, outputTokens: 3 },
  });
  assertEquals(completed.output, [responseMessage("msg_test", "hello")]);
  assertEquals(completed.usage?.total_tokens, 5);
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
