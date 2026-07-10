import { assertEquals } from "jsr:@std/assert@1.0.14";
import { responseMessage, responseObject } from "./responses.ts";

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
