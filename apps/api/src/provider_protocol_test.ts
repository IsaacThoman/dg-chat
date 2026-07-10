import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.14";
import {
  chatCompletionsRequestToResponses,
  normalizeChatCompletionResult,
  normalizeChatStreamChunk,
  normalizeResponsesResult,
  normalizeResponsesStreamEvent,
  ProviderProtocolError,
  publicChatCompletion,
  publicChatStreamChunk,
  responsesRequestToChatCompletions,
} from "./provider-protocol.ts";

Deno.test("chat request converts multimodal messages, tools, calls, results, and reasoning effort", () => {
  const output = chatCompletionsRequestToResponses({
    model: "provider/model",
    messages: [
      { role: "developer", content: "Follow policy" },
      {
        role: "user",
        content: [{ type: "text", text: "Look" }, {
          type: "image_url",
          image_url: { url: "https://example.test/a.png", detail: "high" },
        }],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"q":1}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look up",
        parameters: { type: "object" },
        strict: true,
      },
    }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    reasoning_effort: "high",
    max_completion_tokens: 500,
    stream: true,
  });
  assertEquals(output, {
    model: "provider/model",
    input: [
      { role: "developer", content: [{ type: "input_text", text: "Follow policy" }] },
      {
        role: "user",
        content: [{ type: "input_text", text: "Look" }, {
          type: "input_image",
          image_url: "https://example.test/a.png",
          detail: "high",
        }],
      },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":1}' },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ],
    stream: true,
    max_output_tokens: 500,
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up",
      parameters: { type: "object" },
      strict: true,
    }],
    tool_choice: { type: "function", name: "lookup" },
    reasoning: { effort: "high" },
  });
});

Deno.test("responses request converts instructions, multimodal input, calls, results, and tools", () => {
  const output = responsesRequestToChatCompletions({
    model: "provider/model",
    instructions: "Be safe",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Look" }, {
          type: "input_image",
          image_url: "data:image/png;base64,AA==",
          detail: "low",
        }],
      },
      { type: "function_call", call_id: "call_2", name: "search", arguments: "{}" },
      { type: "function_call_output", call_id: "call_2", output: "done" },
    ],
    tools: [{ type: "function", name: "search", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "search" },
    reasoning: { effort: "medium", summary: "none" },
    text: { format: { type: "json_object" } },
  });
  assertEquals(output, {
    model: "provider/model",
    messages: [
      { role: "system", content: "Be safe" },
      {
        role: "user",
        content: [{ type: "text", text: "Look" }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AA==", detail: "low" },
        }],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_2",
          type: "function",
          function: { name: "search", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call_2", content: "done" },
    ],
    tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "search" } },
    response_format: { type: "json_object" },
    reasoning_effort: "medium",
  });
});

Deno.test("lossy and unsupported request features fail before transport", () => {
  const cases = [
    () =>
      chatCompletionsRequestToResponses({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        stop: "END",
      }),
    () =>
      chatCompletionsRequestToResponses({
        model: "m",
        messages: [{ role: "assistant", content: "x", reasoning_content: "secret" }],
      }),
    () =>
      chatCompletionsRequestToResponses({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        max_tokens: 1,
        max_completion_tokens: 2,
      }),
    () =>
      responsesRequestToChatCompletions({ model: "m", input: "x", previous_response_id: "resp" }),
    () =>
      responsesRequestToChatCompletions({ model: "m", input: "x", reasoning: { summary: "auto" } }),
  ];
  for (const transform of cases) assertThrows(transform, ProviderProtocolError);
});

Deno.test("chat nonstream normalization preserves reasoning, tools, finish, and detailed usage", () => {
  assertEquals(
    normalizeChatCompletionResult({
      id: "chatcmpl_1",
      model: "m",
      created: 12,
      choices: [{
        message: {
          role: "assistant",
          content: "answer",
          reasoning_content: "thinking",
          reasoning_summary: "summary",
          tool_calls: [{
            id: "call",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 7,
        total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }),
    {
      id: "chatcmpl_1",
      model: "m",
      createdAt: 12,
      content: [{ type: "text", text: "answer" }],
      text: "answer",
      reasoning: { content: "thinking", summary: "summary" },
      toolCalls: [{ id: "call", name: "lookup", arguments: "{}" }],
      finishState: "tool_calls",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 7,
        reasoningTokens: 3,
        totalTokens: 17,
      },
    },
  );
});

Deno.test("public Chat reconstruction allowlists citations, audio, and nested logprobs", () => {
  const logprobs = {
    content: [{
      token: "hello",
      logprob: -0.1,
      bytes: [104],
      top_logprobs: [{ token: "hi", logprob: -0.2, bytes: [104] }],
      private_token_field: "drop me",
    }],
    private_logprobs_field: "drop me",
  };
  assertThrows(
    () =>
      publicChatCompletion(
        {
          choices: [{ message: { role: "assistant", content: "hello" }, logprobs }],
        },
        "chatcmpl_public",
        "public/model",
      ),
    ProviderProtocolError,
  );
  const completion = publicChatCompletion(
    {
      choices: [{
        message: {
          role: "assistant",
          content: "hello",
          annotations: [{
            type: "url_citation",
            url_citation: {
              start_index: 0,
              end_index: 5,
              title: "Source",
              url: "https://example.com/source",
            },
          }],
          audio: {
            id: "audio_1",
            data: "YQ==",
            expires_at: 42,
            transcript: "hello",
          },
        },
        finish_reason: "stop",
        logprobs: {
          content: [{
            token: "hello",
            logprob: -0.1,
            bytes: [104],
            top_logprobs: [{ token: "hi", logprob: -0.2, bytes: [104] }],
          }],
        },
      }],
    },
    "chatcmpl_public",
    "public/model",
  );
  assertEquals((completion.choices as Array<Record<string, unknown>>)[0].logprobs, {
    content: [{
      token: "hello",
      logprob: -0.1,
      bytes: [104],
      top_logprobs: [{ token: "hi", logprob: -0.2, bytes: [104] }],
    }],
  });
  const message = ((completion.choices as Array<Record<string, unknown>>)[0].message) as Record<
    string,
    unknown
  >;
  assertEquals(message.annotations, [{
    type: "url_citation",
    url_citation: {
      start_index: 0,
      end_index: 5,
      title: "Source",
      url: "https://example.com/source",
    },
  }]);
  assertEquals(message.audio, {
    id: "audio_1",
    data: "YQ==",
    expires_at: 42,
    transcript: "hello",
  });
  assertThrows(
    () =>
      publicChatStreamChunk(
        {
          choices: [{ delta: {}, logprobs: { content: [], private: true } }],
        },
        "chatcmpl_public",
        "public/model",
      ),
    ProviderProtocolError,
  );
});

Deno.test("responses nonstream normalization preserves output, reasoning, refusal, tools, and usage", () => {
  const result = normalizeResponsesResult({
    id: "resp_1",
    model: "m",
    created_at: 20,
    status: "completed",
    output: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "sum" }],
        content: [{ type: "reasoning_text", text: "why" }],
      },
      {
        type: "message",
        content: [
          { type: "output_text", text: "hello" },
          {
            type: "output_image",
            image_url: "https://example.test/result.png",
            detail: "high",
          },
          { type: "refusal", refusal: "cannot" },
        ],
      },
      {
        type: "function_call",
        id: "item_1",
        call_id: "call",
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
  });
  assertEquals(result.reasoning, { content: "why", summary: "sum" });
  assertEquals(result.text, "hello");
  assertEquals(result.content, [
    { type: "text", text: "hello" },
    { type: "image", url: "https://example.test/result.png", detail: "high" },
  ]);
  assertEquals(result.refusal, "cannot");
  assertEquals(result.toolCalls, [{
    id: "call",
    name: "lookup",
    arguments: "{}",
    status: "completed",
  }]);
  assertEquals(result.usage?.cachedInputTokens, 2);
  assertEquals(result.usage?.reasoningTokens, 3);
});

Deno.test("chat streaming normalization emits visible, tool, usage, finish, and done events", () => {
  assertEquals(
    normalizeChatStreamChunk({
      id: "chunk",
      model: "m",
      choices: [{
        delta: {
          role: "assistant",
          content: "hi",
          reasoning_content: "why",
          tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "{" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    }),
    [
      { type: "started", id: "chunk", model: "m" },
      { type: "role", role: "assistant" },
      { type: "text_delta", text: "hi" },
      { type: "reasoning_delta", text: "why", summary: false },
      { type: "tool_call_delta", index: 0, id: "call", name: "lookup", arguments: "{" },
      { type: "finish", state: "tool_calls" },
      {
        type: "usage",
        usage: {
          inputTokens: 2,
          cachedInputTokens: 1,
          outputTokens: 3,
          reasoningTokens: 1,
          totalTokens: 5,
        },
      },
    ],
  );
  assertEquals(normalizeChatStreamChunk("[DONE]"), [{ type: "done" }]);
});

Deno.test("responses streaming normalization covers text, reasoning, tools, completion, and errors", () => {
  assertEquals(normalizeResponsesStreamEvent({ type: "response.output_text.delta", delta: "hi" }), [
    { type: "text_delta", text: "hi" },
  ]);
  assertEquals(
    normalizeResponsesStreamEvent({
      type: "response.output_item.added",
      item: { type: "message", role: "assistant" },
    }),
    [{ type: "role", role: "assistant" }],
  );
  assertEquals(
    normalizeResponsesStreamEvent({ type: "response.reasoning_summary_text.delta", delta: "sum" }),
    [{ type: "reasoning_delta", text: "sum", summary: true }],
  );
  assertEquals(
    normalizeResponsesStreamEvent({
      type: "response.reasoning_summary_part.added",
      item_id: "reasoning",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
    [],
  );
  assertEquals(
    normalizeResponsesStreamEvent({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "call",
      delta: "{}",
    }),
    [{ type: "tool_call_delta", index: 1, id: "call", arguments: "{}" }],
  );
  assertEquals(
    normalizeResponsesStreamEvent({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    }),
    [
      {
        type: "usage",
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 3,
        },
      },
      { type: "finish", state: "stop" },
      { type: "done" },
    ],
  );
  assertEquals(
    normalizeResponsesStreamEvent({ type: "error", error: { code: "bad", message: "safe" } }),
    [{ type: "error", code: "bad", message: "safe" }],
  );
});

Deno.test("malformed, oversized, invalid usage, and unknown events return typed safe errors", async () => {
  for (
    const transform of [
      () => normalizeChatCompletionResult({ id: "x", model: "m", choices: [] }),
      () => normalizeResponsesResult({ id: "x", model: "m", output: [{ type: "unknown" }] }),
      () =>
        normalizeChatCompletionResult({
          id: "x",
          model: "m",
          choices: [{ message: { content: "x" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 9 },
        }),
      () =>
        normalizeResponsesStreamEvent({ type: "response.future.delta", secret: "do not reflect" }),
      () =>
        chatCompletionsRequestToResponses({
          model: "m",
          messages: [{ role: "user", content: "x".repeat(4_200_000) }],
        }),
    ]
  ) {
    const error = assertThrows(transform, ProviderProtocolError);
    assertInstanceOf(error, ProviderProtocolError);
    if (error.code === "unsupported_feature") assertEquals(error.message.includes("secret"), false);
  }
  await assertRejects(
    () => Promise.reject(new ProviderProtocolError("malformed_payload", "safe")),
    ProviderProtocolError,
    "safe",
  );
});

Deno.test("validation rejects non-JSON and accessor payloads without executing them", () => {
  for (const value of [NaN, Infinity, undefined, () => undefined, new Date()]) {
    assertThrows(
      () =>
        chatCompletionsRequestToResponses({
          model: "m",
          messages: [{ role: "user", content: "x" }],
          extra: value,
        }),
      ProviderProtocolError,
    );
  }
  let read = false;
  const request: Record<string, unknown> = {
    model: "m",
    messages: [{ role: "user", content: "x" }],
  };
  Object.defineProperty(request, "secret", {
    enumerable: true,
    get() {
      read = true;
      return "not safe";
    },
  });
  assertThrows(
    () => chatCompletionsRequestToResponses(request),
    ProviderProtocolError,
    "accessor",
  );
  assertEquals(read, false);

  const error = assertThrows(
    () => normalizeResponsesStreamEvent({ type: "private-secret-event-name" }),
    ProviderProtocolError,
  );
  assertEquals(error.message.includes("private-secret"), false);
});
