import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  adminAccountStateSchema,
  adminApiTokenQuerySchema,
  adminApiTokenRevocationSchema,
  adminApprovalSchema,
  adminBalanceAdjustmentSchema,
  adminDeleteUserSchema,
  adminLedgerQuerySchema,
  adminRoleSchema,
  adminSessionQuerySchema,
  adminSessionRevocationSchema,
  adminUserQuerySchema,
  chatCompletionSchema,
  communityLeaderboardQuerySchema,
  createAccessGroupSchema,
  createConversationFolderSchema,
  createConversationTagSchema,
  createTokenSchema,
  generateMessageSchema,
  keepTemporaryConversationSchema,
  passwordResetSchema,
  registerSchema,
  reorderConversationFoldersSchema,
  replaceConversationTagsSchema,
  replaceFolderMembershipsSchema,
  responsesSchema,
  setActiveLeafSchema,
  streamGenerationSchema,
  updateAccessGroupSchema,
  updateCommunityProfileSchema,
  updateConversationFolderSchema,
  updateConversationSchema,
  updateConversationTagSchema,
  updatePreferencesSchema,
  updateTokenSchema,
  workspaceDeleteSchema,
} from "./schemas.ts";
import { isModelCapability, MODEL_CAPABILITIES } from "./types.ts";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordPolicyError,
} from "./password-policy.ts";

Deno.test("identity password policy is shared by registration and recovery", () => {
  const base = { email: "person@example.com", name: "Person" };
  const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
  const valid = "a".repeat(PASSWORD_MIN_LENGTH);
  const long = "a".repeat(PASSWORD_MAX_LENGTH + 1);
  assertEquals(registerSchema.safeParse({ ...base, password: short }).success, false);
  assertEquals(registerSchema.safeParse({ ...base, password: valid }).success, true);
  assertEquals(registerSchema.safeParse({ ...base, password: long }).success, false);
  assertEquals(
    passwordResetSchema.safeParse({ token: "x".repeat(32), password: valid }).success,
    true,
  );
  assertEquals(passwordPolicyError(short), `Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  assertEquals(passwordPolicyError(valid), null);
  assertEquals(passwordPolicyError(long), `Use no more than ${PASSWORD_MAX_LENGTH} characters.`);
});

Deno.test("community profile updates are strict, versioned, and consent-safe", () => {
  assertEquals(
    updateCommunityProfileSchema.parse({
      expectedVersion: 1,
      optedIn: true,
      identityMode: "nickname",
      nickname: "  Friendly-user.2  ",
      color: "violet",
      shareBalance: true,
    }),
    {
      expectedVersion: 1,
      optedIn: true,
      identityMode: "nickname",
      nickname: "Friendly-user.2",
      color: "violet",
      shareBalance: true,
    },
  );
  for (
    const invalid of [
      { expectedVersion: 1 },
      { expectedVersion: 0, optedIn: true },
      { expectedVersion: 1, optedIn: false, shareBalance: true },
      { expectedVersion: 1, identityMode: "nickname", nickname: null },
      { expectedVersion: 1, identityMode: "anonymous", nickname: "Named" },
      { expectedVersion: 1, nickname: "<script>" },
      { expectedVersion: 1, nickname: "unsafe@example.test" },
      { expectedVersion: 1, nickname: "right\u202Eleft" },
      { expectedVersion: 1, color: "#ff00ff" },
      { expectedVersion: 1, optedIn: true, extra: "not accepted" },
    ]
  ) {
    assertEquals(updateCommunityProfileSchema.safeParse(invalid).success, false);
  }
});

Deno.test("community leaderboard queries are strict, bounded, and separate current balance", () => {
  assertEquals(communityLeaderboardQuerySchema.parse({}), {
    metric: "calls",
    limit: 25,
  });
  assertEquals(
    communityLeaderboardQuerySchema.parse({ metric: "tokens", window: "90d", limit: 100 }),
    { metric: "tokens", window: "90d", limit: 100 },
  );
  for (
    const invalid of [
      { metric: "provider_cost" },
      { metric: "calls", window: "all" },
      { metric: "balance", window: "30d" },
      { limit: 0 },
      { limit: 101 },
      { cursor: "visible-user-id" },
      { extra: true },
    ]
  ) {
    assertEquals(communityLeaderboardQuerySchema.safeParse(invalid).success, false);
  }
});

Deno.test("admin security and billing command schemas are strict and bounded", () => {
  assertEquals(adminSessionQuerySchema.parse({}).limit, 50);
  assertEquals(
    adminSessionQuerySchema.safeParse({ source: "better_auth", status: "active", limit: 100 })
      .success,
    true,
  );
  assertEquals(adminSessionQuerySchema.safeParse({ source: "unknown" }).success, false);
  assertEquals(adminSessionQuerySchema.safeParse({ limit: 101 }).success, false);
  assertEquals(adminSessionQuerySchema.safeParse({ unexpected: true }).success, false);
  assertEquals(
    adminSessionRevocationSchema.parse({ reason: "  Lost device  " }).reason,
    "Lost device",
  );
  assertEquals(adminSessionRevocationSchema.safeParse({ reason: "" }).success, false);

  assertEquals(adminApiTokenQuerySchema.parse({ status: "overlap" }).limit, 50);
  assertEquals(adminApiTokenQuerySchema.safeParse({ status: "expired" }).success, true);
  assertEquals(adminApiTokenQuerySchema.safeParse({ status: "disabled" }).success, false);
  assertEquals(
    adminApiTokenRevocationSchema.safeParse({ expectedVersion: 1, reason: "Exposed" }).success,
    true,
  );
  assertEquals(
    adminApiTokenRevocationSchema.safeParse({ expectedVersion: 0, reason: "Exposed" }).success,
    false,
  );

  assertEquals(adminLedgerQuerySchema.parse({ kind: "adjustment" }).limit, 50);
  assertEquals(adminLedgerQuerySchema.safeParse({ kind: "charge" }).success, false);
  assertEquals(
    adminBalanceAdjustmentSchema.parse({
      amountMicros: -250_000,
      expectedBalanceMicros: 5_000_000,
      reason: "  Correct duplicate grant  ",
    }),
    {
      amountMicros: -250_000,
      expectedBalanceMicros: 5_000_000,
      reason: "Correct duplicate grant",
    },
  );
  for (const amountMicros of [0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertEquals(
      adminBalanceAdjustmentSchema.safeParse({
        amountMicros,
        expectedBalanceMicros: 0,
        reason: "Correction",
      }).success,
      false,
    );
  }
  assertEquals(
    adminBalanceAdjustmentSchema.safeParse({
      amountMicros: 1,
      expectedBalanceMicros: -1,
      reason: "Correction",
    }).success,
    false,
  );
  assertEquals(
    adminBalanceAdjustmentSchema.safeParse({
      amountMicros: 1,
      expectedBalanceMicros: 0,
      reason: "Correction",
      idempotencyKey: "must-not-be-in-json",
    }).success,
    false,
  );
});

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

Deno.test("OpenAI schemas preserve explicit nullable SDK options", () => {
  const chat = chatCompletionSchema.parse({
    model: "openai/default",
    messages: [{ role: "user", content: "hello" }],
    temperature: null,
    max_completion_tokens: null,
    stop: null,
  });
  assertEquals(chat.temperature, undefined);
  assertEquals(chat.max_completion_tokens, undefined);
  assertEquals(chat.stop, undefined);
  assertEquals(Object.hasOwn(chat, "temperature"), false);
  assertEquals(Object.hasOwn(chat, "max_completion_tokens"), false);
  assertEquals(Object.hasOwn(chat, "stop"), false);

  const responses = responsesSchema.parse({
    model: "openai/default",
    input: "hello",
    instructions: null,
    stream: null,
    stream_options: null,
    temperature: null,
    top_p: null,
    parallel_tool_calls: null,
    max_output_tokens: null,
    reasoning: null,
    store: null,
  });
  assertEquals(responses.instructions, undefined);
  assertEquals(responses.stream, undefined);
  assertEquals(responses.stream_options, undefined);
  assertEquals(responses.temperature, undefined);
  assertEquals(responses.top_p, undefined);
  assertEquals(responses.parallel_tool_calls, undefined);
  assertEquals(responses.max_output_tokens, undefined);
  assertEquals(responses.reasoning, undefined);
  assertEquals(responses.store, undefined);
  for (
    const field of [
      "instructions",
      "stream",
      "stream_options",
      "temperature",
      "top_p",
      "parallel_tool_calls",
      "max_output_tokens",
      "reasoning",
      "store",
    ]
  ) assertEquals(Object.hasOwn(responses, field), false);
  assertEquals(
    responsesSchema.safeParse({ model: "openai/default", input: "hello", store: "false" })
      .success,
    false,
  );
});

Deno.test("Responses schema bounds stream obfuscation options", () => {
  const base = { model: "openai/default", input: "hello" };
  assertEquals(
    responsesSchema.parse({ ...base, stream_options: { include_obfuscation: false } })
      .stream_options,
    { include_obfuscation: false },
  );
  assertEquals(
    responsesSchema.safeParse({ ...base, stream_options: { unknown: true } }).success,
    false,
  );
});

Deno.test("Responses metadata follows the bounded OpenAI string map contract", () => {
  const base = { model: "openai/default", input: "hello" };
  assertEquals(
    responsesSchema.parse({ ...base, metadata: { trace: "request-1" } }).metadata,
    { trace: "request-1" },
  );
  for (
    const metadata of [
      Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key-${index}`, "value"])),
      { ["k".repeat(65)]: "value" },
      { key: "v".repeat(513) },
      { key: { nested: "not supported" } },
    ]
  ) {
    assertEquals(responsesSchema.safeParse({ ...base, metadata }).success, false);
  }
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

Deno.test("Responses accepts bounded stateless reasoning and output history", () => {
  const parsed = responsesSchema.parse({
    model: "openai/default",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Use the prior result" }],
        encrypted_content: "opaque-state",
        status: "completed",
      },
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Prior answer" }],
      },
      { type: "message", role: "user", content: "Continue" },
    ],
  });
  assertEquals(Array.isArray(parsed.input), true);
  assertEquals(
    responsesSchema.safeParse({
      model: "openai/default",
      input: [{
        type: "reasoning",
        summary: [{ type: "summary_text", text: "x".repeat(2_000_001) }],
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

Deno.test("temporary keep input accepts only a non-negative CAS version", () => {
  assertEquals(keepTemporaryConversationSchema.parse({ expectedVersion: 0 }), {
    expectedVersion: 0,
  });
  assertEquals(keepTemporaryConversationSchema.safeParse({ expectedVersion: -1 }).success, false);
  assertEquals(
    keepTemporaryConversationSchema.safeParse({ expectedVersion: 0, ownerId: "spoofed" }).success,
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

Deno.test("access-group metadata updates require an actual change", () => {
  assertEquals(updateAccessGroupSchema.safeParse({ expectedVersion: 1 }).success, false);
  assertEquals(
    updateAccessGroupSchema.safeParse({ expectedVersion: 1, name: "Operators" }).success,
    true,
  );
  assertEquals(
    updateAccessGroupSchema.safeParse({ expectedVersion: 1, description: "" }).success,
    true,
  );
});

Deno.test("access-group creation accepts a bounded initial policy and defaults to empty", () => {
  assertEquals(createAccessGroupSchema.parse({ name: "Legacy" }), {
    name: "Legacy",
    userIds: [],
    modelIds: [],
    tokenIds: [],
  });
  const id = crypto.randomUUID();
  assertEquals(
    createAccessGroupSchema.parse({
      name: "Restricted",
      userIds: [id],
      modelIds: [id],
      tokenIds: [id],
    }),
    {
      name: "Restricted",
      userIds: [id],
      modelIds: [id],
      tokenIds: [id],
    },
  );
  assertEquals(
    createAccessGroupSchema.safeParse({ name: "Invalid", userIds: ["not-a-uuid"] }).success,
    false,
  );
});

Deno.test("admin account lifecycle contracts are strict, versioned, and bounded", () => {
  assertEquals(adminUserQuerySchema.parse({}), { limit: 50 });
  assertEquals(adminUserQuerySchema.parse({ search: "  person@example.com  ", limit: 100 }), {
    search: "person@example.com",
    limit: 100,
  });
  assertEquals(adminUserQuerySchema.safeParse({ limit: 101 }).success, false);
  assertEquals(adminUserQuerySchema.safeParse({ search: "x".repeat(201) }).success, false);
  assertEquals(adminUserQuerySchema.safeParse({ state: "deleted" }).success, false);
  assertEquals(adminUserQuerySchema.safeParse({ unknown: true }).success, false);

  assertEquals(
    adminApprovalSchema.safeParse({ status: "approved", expectedVersion: 1 }).success,
    true,
  );
  assertEquals(
    adminApprovalSchema.safeParse({ status: "rejected", expectedVersion: 1 }).success,
    false,
  );
  assertEquals(
    adminApprovalSchema.safeParse({
      status: "rejected",
      expectedVersion: 1,
      reason: "Policy violation",
    }).success,
    true,
  );
  assertEquals(
    adminApprovalSchema.safeParse({ status: "approved", expectedVersion: 0 }).success,
    false,
  );
  assertEquals(
    adminRoleSchema.safeParse({ role: "admin", expectedVersion: 1, reason: "Support coverage" })
      .success,
    true,
  );
  assertEquals(
    adminAccountStateSchema.safeParse({ state: "suspended", expectedVersion: 1 }).success,
    false,
  );
  assertEquals(
    adminAccountStateSchema.safeParse({
      state: "suspended",
      expectedVersion: 1,
      reason: "Security review",
    }).success,
    true,
  );
  assertEquals(
    adminDeleteUserSchema.safeParse({ expectedVersion: 1, reason: " " }).success,
    false,
  );
});
