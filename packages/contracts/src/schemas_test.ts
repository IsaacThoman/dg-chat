import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  chatCompletionSchema,
  createConversationFolderSchema,
  createConversationTagSchema,
  createTokenSchema,
  generateMessageSchema,
  reorderConversationFoldersSchema,
  replaceConversationTagsSchema,
  replaceFolderMembershipsSchema,
  responsesSchema,
  setActiveLeafSchema,
  streamGenerationSchema,
  updateConversationFolderSchema,
  updateConversationSchema,
  updateConversationTagSchema,
  updatePreferencesSchema,
  updateTokenSchema,
  workspaceDeleteSchema,
} from "./schemas.ts";
import { isModelCapability, MODEL_CAPABILITIES } from "./types.ts";

Deno.test("model capabilities are canonical and reject near-miss values", () => {
  assertEquals(new Set(MODEL_CAPABILITIES).size, MODEL_CAPABILITIES.length);
  assertEquals(isModelCapability("transcription"), true);
  assertEquals(isModelCapability("image_editing"), true);
  assertEquals(isModelCapability("image_edit"), false);
  assertEquals(isModelCapability("transcripton"), false);
});

Deno.test("web generation accepts attachment-only sends but rejects empty text-only sends", () => {
  const attachmentId = crypto.randomUUID();
  const base = {
    parentId: null,
    content: "   ",
    model: "simulated/dg-chat",
    expectedVersion: 0,
    idempotencyKey: "attachment-only-send",
  };
  assertEquals(generateMessageSchema.safeParse(base).success, false);
  assertEquals(generateMessageSchema.parse({ ...base, attachmentIds: [attachmentId] }).content, "");
  assertEquals(
    streamGenerationSchema.safeParse({ ...base, mode: "send", attachmentIds: [] }).success,
    false,
  );
  assertEquals(
    streamGenerationSchema.safeParse({ ...base, mode: "send", attachmentIds: [attachmentId] })
      .success,
    true,
  );
});

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

Deno.test("Responses accepts bounded developer and function-call history items", () => {
  const parsed = responsesSchema.parse({
    model: "openai/default",
    input: [
      { type: "message", role: "developer", content: "Use the tool" },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"q":"x"}',
        status: "completed",
      },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ],
  });
  assertEquals(Array.isArray(parsed.input), true);
  assertEquals(
    responsesSchema.safeParse({
      model: "openai/default",
      input: [{
        type: "function_call",
        call_id: "call_1",
        name: "x".repeat(129),
        arguments: "{}",
      }],
    }).success,
    false,
  );
});

Deno.test("conversation patches are strict, bounded, and normalized", () => {
  assertEquals(updateConversationSchema.parse({ title: "  Renamed  ", expectedVersion: 2 }), {
    title: "Renamed",
    expectedVersion: 2,
  });
  assertEquals(updateConversationSchema.safeParse({ expectedVersion: 2 }).success, false);
  assertEquals(
    updateConversationSchema.safeParse({ title: "x".repeat(201), expectedVersion: 2 }).success,
    false,
  );
  assertEquals(
    updateConversationSchema.safeParse({ title: "ok", expectedVersion: 2, ownerId: "other" })
      .success,
    false,
  );
  assertEquals(
    updateConversationSchema.safeParse({ pinned: "yes", expectedVersion: 2 }).success,
    false,
  );
  assertEquals(
    updateConversationSchema.safeParse({ pinned: true, expectedVersion: -1 }).success,
    false,
  );
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

Deno.test("workspace preferences are strict, bounded, and require an optimistic mutation", () => {
  assertEquals(
    updatePreferencesSchema.parse({
      expectedVersion: 1,
      theme: "dark",
      preferredModelId: "  provider/model  ",
    }),
    { expectedVersion: 1, theme: "dark", preferredModelId: "provider/model" },
  );
  assertEquals(updatePreferencesSchema.safeParse({ expectedVersion: 1 }).success, false);
  assertEquals(
    updatePreferencesSchema.safeParse({ expectedVersion: 0, theme: "system" }).success,
    false,
  );
  assertEquals(
    updatePreferencesSchema.safeParse({
      expectedVersion: 1,
      customInstructions: "x".repeat(20_001),
    })
      .success,
    false,
  );
  assertEquals(
    updatePreferencesSchema.safeParse({ expectedVersion: 1, theme: "dark", userId: "other" })
      .success,
    false,
  );
  assertEquals(
    updatePreferencesSchema.safeParse({ expectedVersion: 1, preferredModelId: null }).success,
    true,
  );
});

Deno.test("folder contracts reject ambiguous reorder and membership mutations", () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  assertEquals(createConversationFolderSchema.parse({ name: "  Research  " }), {
    name: "Research",
  });
  assertEquals(createConversationFolderSchema.safeParse({ name: " " }).success, false);
  assertEquals(
    updateConversationFolderSchema.safeParse({ expectedVersion: 1 }).success,
    false,
  );
  assertEquals(
    updateConversationFolderSchema.safeParse({ expectedVersion: 0, name: "Renamed" }).success,
    false,
  );
  assertEquals(
    reorderConversationFoldersSchema.safeParse({
      folderIds: [first, second],
      expectedVersions: { [first]: 1, [second]: 3 },
    }).success,
    true,
  );
  assertEquals(
    reorderConversationFoldersSchema.safeParse({
      folderIds: [first, first],
      expectedVersions: { [first]: 1 },
    }).success,
    false,
  );
  assertEquals(
    reorderConversationFoldersSchema.safeParse({
      folderIds: [first, second],
      expectedVersions: { [first]: 1 },
    }).success,
    false,
  );
  assertEquals(
    replaceFolderMembershipsSchema.safeParse({
      conversationIds: [first, first],
      expectedMembershipVersions: { [second]: 0 },
    }).success,
    false,
  );
  assertEquals(workspaceDeleteSchema.safeParse({ expectedVersion: 0 }).success, false);
  assertEquals(
    workspaceDeleteSchema.safeParse({ expectedVersion: 1, deleteConversations: true }).success,
    false,
  );
});

Deno.test("tag contracts normalize names and bound colors and assignment sets", () => {
  const tagId = crypto.randomUUID();
  assertEquals(createConversationTagSchema.parse({ name: "  Review  ", color: "#aBc123" }), {
    name: "Review",
    color: "#aBc123",
  });
  assertEquals(
    createConversationTagSchema.safeParse({ name: "Review", color: "red" }).success,
    false,
  );
  assertEquals(
    updateConversationTagSchema.safeParse({ expectedVersion: 1 }).success,
    false,
  );
  assertEquals(
    updateConversationTagSchema.safeParse({ expectedVersion: 0, color: "#000000" }).success,
    false,
  );
  assertEquals(
    replaceConversationTagsSchema.safeParse({ tagIds: [tagId, tagId], expectedVersion: 0 }).success,
    false,
  );
  assertEquals(
    replaceConversationTagsSchema.safeParse({
      tagIds: Array.from({ length: 21 }, () => crypto.randomUUID()),
      expectedVersion: 0,
    }).success,
    false,
  );
});

Deno.test("personal token policies are strict and bounded", () => {
  const valid = {
    name: "Automation",
    scopes: ["chat:write"],
    expiresAt: null,
    rpmLimit: 60,
    burstLimit: 4,
  };
  assertEquals(createTokenSchema.safeParse(valid).success, true);
  assertEquals(createTokenSchema.safeParse({ ...valid, burstLimit: 61 }).success, false);
  assertEquals(createTokenSchema.safeParse({ ...valid, rpmLimit: 60_001 }).success, false);
  assertEquals(createTokenSchema.safeParse({ ...valid, tokenHash: "secret" }).success, false);
  assertEquals(
    updateTokenSchema.safeParse({ expectedVersion: 1, rpmLimit: null, burstLimit: null }).success,
    true,
  );
  assertEquals(updateTokenSchema.safeParse({ expectedVersion: 0, name: "Nope" }).success, false);
});
