import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  chatCompletionSchema,
  responsesSchema,
  setActiveLeafSchema,
  updateConversationSchema,
} from "./schemas.ts";

Deno.test("Chat Completions rejects unsupported multi-choice accounting", () => {
  assertEquals(
    chatCompletionSchema.safeParse({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      n: 2,
    }).success,
    false,
  );
});

Deno.test("Chat Completions preserves common SDK fields and tool-call history", () => {
  const parsed = chatCompletionSchema.parse({
    model: "openai/default",
    messages: [{
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup" } }],
    }],
    max_completion_tokens: 1,
    stream_options: { include_usage: true },
    tool_choice: "auto",
    response_format: { type: "json_object" },
  });
  assertEquals(parsed.messages[0].content, null);
  assertEquals(parsed.max_completion_tokens, 1);
  assertEquals(parsed.stream_options?.include_usage, true);
  assertEquals(parsed.tool_choice, "auto");
  assertEquals(parsed.response_format, { type: "json_object" });
});

Deno.test("Responses accepts multimodal content items without stripping options", () => {
  const parsed = responsesSchema.parse({
    model: "openai/default",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "describe" },
        { type: "input_image", image_url: "https://example.invalid/image.png" },
      ],
    }],
    instructions: "Be concise",
    temperature: 0.2,
  });
  assertEquals(Array.isArray(parsed.input), true);
  assertEquals(parsed.instructions, "Be concise");
  assertEquals(parsed.temperature, 0.2);
});

Deno.test("conversation patches are strict, bounded, and normalized", () => {
  assertEquals(updateConversationSchema.parse({ title: "  Renamed  " }), { title: "Renamed" });
  assertEquals(updateConversationSchema.safeParse({}).success, false);
  assertEquals(updateConversationSchema.safeParse({ title: "x".repeat(201) }).success, false);
  assertEquals(
    updateConversationSchema.safeParse({ title: "ok", ownerId: "other" }).success,
    false,
  );
  assertEquals(updateConversationSchema.safeParse({ pinned: "yes" }).success, false);
});

Deno.test("active leaf changes require a strict UUID and optimistic version", () => {
  assertEquals(
    setActiveLeafSchema.safeParse({ leafId: crypto.randomUUID(), expectedVersion: 0 }).success,
    true,
  );
  assertEquals(
    setActiveLeafSchema.safeParse({ leafId: "not-a-uuid", expectedVersion: 0 }).success,
    false,
  );
  assertEquals(
    setActiveLeafSchema.safeParse({ leafId: crypto.randomUUID(), expectedVersion: -1 }).success,
    false,
  );
  assertEquals(
    setActiveLeafSchema.safeParse({ leafId: crypto.randomUUID(), expectedVersion: 0, ownerId: "x" })
      .success,
    false,
  );
});
