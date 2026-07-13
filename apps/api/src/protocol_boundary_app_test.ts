import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { createApp } from "./app.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("OpenAI gateway preserves public identity, visible stream billing, and Responses fields", async () => {
  const completedRequests: ChatCompletionRequest[] = [];
  const streamedRequests: ChatCompletionRequest[] = [];
  const providerComplete = (request: ChatCompletionRequest) => {
    completedRequests.push(structuredClone(request));
    const prompt = JSON.stringify(request.messages);
    if (prompt.includes("tool response")) {
      return Promise.resolve({
        text: "",
        inputTokens: 8,
        outputTokens: 14,
        cachedInputTokens: 2,
        reasoningTokens: 4,
        upstream: {
          id: "private-tool-id",
          model: "private-tool-model",
          created: 2,
          secret_extension: "must-not-leak",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              refusal: "policy refusal",
              reasoning_content: "checked policy",
              reasoning_summary: "policy summary",
              tool_calls: [{
                id: "call_lookup",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              }],
              private_delta: "must-not-leak",
            },
            finish_reason: "tool_calls",
            private_choice: "must-not-leak",
          }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 14,
            total_tokens: 22,
            prompt_tokens_details: { cached_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 4 },
          },
        },
      });
    }
    return Promise.resolve({
      text: "gateway result",
      inputTokens: 12,
      outputTokens: 4,
      upstream: {
        id: "upstream-secret-id",
        object: "chat.completion",
        created: 1,
        model: "fallback/secret-model",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "gateway result",
            annotations: [{
              type: "url_citation",
              url_citation: {
                start_index: 0,
                end_index: 7,
                title: "Gateway source",
                url: "https://example.com/gateway",
              },
            }],
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        secret_extension: "must-not-leak",
      },
    });
  };
  const providerStream = async function* (request: ChatCompletionRequest) {
    streamedRequests.push(structuredClone(request));
    const prompt = JSON.stringify(request.messages);
    if (prompt.includes("tool response")) {
      yield JSON.stringify({
        id: "private-tool-stream-id",
        model: "private-tool-model",
        object: "chat.completion.chunk",
        secret_extension: "must-not-leak",
        choices: [{
          index: 0,
          delta: {
            reasoning_content: "checked policy",
            reasoning_summary: "policy summary",
            refusal: "policy refusal",
            tool_calls: [{
              index: 0,
              id: "call_lookup",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"' },
            }],
          },
          finish_reason: null,
        }],
      });
      yield JSON.stringify({
        id: "private-tool-stream-id",
        model: "private-tool-model",
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: 'x"}' } }] },
          finish_reason: "tool_calls",
        }],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 14,
          total_tokens: 22,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      });
      yield "[DONE]";
      return;
    }
    if (prompt.includes("reasoning then fail")) {
      yield JSON.stringify({
        id: "upstream-reasoning-id",
        model: "fallback/reasoning-model",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { reasoning_content: "visible thought" } }],
      });
      throw new Error("provider failed after reasoning");
    }
    if (prompt.includes("refusal then fail")) {
      yield JSON.stringify({
        id: "upstream-refusal-id",
        model: "fallback/refusal-model",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { refusal: "visible refusal" } }],
      });
      throw new Error("provider failed after refusal");
    }
    if (prompt.includes("usage then fail")) {
      yield JSON.stringify({
        id: "upstream-usage-id",
        model: "fallback/usage-model",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      });
      throw new Error("provider failed after reporting usage");
    }
    yield JSON.stringify({
      id: "upstream-stream-id",
      model: "fallback/stream-model",
      object: "chat.completion.chunk",
      secret_extension: "must-not-leak",
      choices: [{ index: 0, delta: { content: "public " }, finish_reason: null }],
    });
    yield JSON.stringify({
      id: "different-upstream-stream-id",
      model: "different-fallback/stream-model",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "result" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    });
    yield "[DONE]";
  };
  const { app, repository } = createApp({
    setupToken: "protocol-boundary-setup",
    providerComplete,
    providerStream,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "protocol-boundary-setup",
    },
    body: JSON.stringify({
      email: "protocol-boundary@example.com",
      password: "correct horse battery",
      name: "Protocol Admin",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "protocol-boundary@example.com",
      password: "correct horse battery",
    }),
  });
  const me = await json(login);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: {
      cookie: cookie(login),
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "protocol", scopes: ["chat:write"] }),
  });
  const token = (await json(tokenResponse)).token as string;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const completion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/default",
      messages: [{ role: "user", content: "public identity" }],
    }),
  });
  const completionBody = await json(completion);
  assertEquals(completion.status, 200);
  assertEquals(completionBody.model, "openai/default");
  assertEquals(completionBody.id.startsWith("chatcmpl-"), true);
  assertEquals(completionBody.id === "upstream-secret-id", false);
  assertEquals(completionBody.secret_extension, undefined);

  const streamed = await app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/default",
      messages: [{ role: "user", content: "stream public identity" }],
      stream: true,
    }),
  });
  const streamPayloads = (await streamed.text()).split("\n").filter((line) =>
    line.startsWith("data: {")
  ).map((line) => JSON.parse(line.slice(6)));
  assertEquals(streamPayloads.length, 2);
  assertEquals(streamPayloads[0].model, "openai/default");
  assertEquals(String(streamPayloads[0].id).startsWith("chatcmpl-"), true);
  assertEquals(new Set(streamPayloads.map((payload) => payload.id)).size, 1);
  assertEquals(JSON.stringify(streamPayloads).includes("fallback/stream-model"), false);
  assertEquals(JSON.stringify(streamPayloads).includes("upstream-stream-id"), false);
  assertEquals(JSON.stringify(streamPayloads).includes("must-not-leak"), false);
  assertEquals(streamedRequests.at(-1)?.stream_options?.include_usage, true);

  for (const prompt of ["reasoning then fail", "refusal then fail"]) {
    const before = await repository.usage(me.user.id);
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "openai/default",
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
    });
    const text = await response.text();
    assertEquals(
      text.includes(prompt.startsWith("reasoning") ? "visible thought" : "visible refusal"),
      true,
    );
    assertEquals(text.includes("fallback/"), false);
    const after = await repository.usage(me.user.id);
    assertEquals(after.calls, before.calls + 1);
    assertEquals(after.balanceMicros < before.balanceMicros, true);
  }

  const beforeUsageFailure = await repository.usage(me.user.id);
  const usageFailure = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/default",
      input: "usage then fail",
      stream: true,
    }),
  });
  const usageFailureEvents = (await usageFailure.text()).split("\n").filter((line) =>
    line.startsWith("data: {")
  ).map((line) => JSON.parse(line.slice(6)));
  const usageFailureError = usageFailureEvents.at(-1);
  assertEquals(usageFailureError.type, "error");
  assertEquals(usageFailureError.param, null);
  const afterUsageFailure = await repository.usage(me.user.id);
  assertEquals(afterUsageFailure.calls, beforeUsageFailure.calls + 1);
  assertEquals(afterUsageFailure.inputTokens, beforeUsageFailure.inputTokens + 8);
  assertEquals(afterUsageFailure.outputTokens, beforeUsageFailure.outputTokens + 3);
  assertEquals(afterUsageFailure.spentMicros > beforeUsageFailure.spentMicros, true);

  const supported = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/default",
      instructions: "Be exact",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "inspect this" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
        ],
      }],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "lookup" },
      reasoning: { effort: "medium", summary: "none" },
      metadata: { trace: "chat-provider" },
    }),
  });
  assertEquals(supported.status, 200);
  const converted = completedRequests.at(-1)! as ChatCompletionRequest & {
    reasoning_effort?: string;
  };
  assertEquals(converted.messages[0], { role: "system", content: "Be exact" });
  assertEquals(converted.messages[1].content, [{ type: "text", text: "inspect this" }, {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AA==", detail: "low" },
  }]);
  assertEquals(converted.tools, [{
    type: "function",
    function: { name: "lookup", parameters: { type: "object" } },
  }]);
  assertEquals(converted.reasoning_effort, "medium");
  const supportedBody = await json(supported);
  assertEquals(supportedBody.store, false);
  assertEquals(supportedBody.metadata, { trace: "chat-provider" });
  const citedText = supportedBody.output.flatMap(
    (item: { content?: Array<Record<string, unknown>> }) => item.content ?? [],
  ).find((part: { type?: string }) => part.type === "output_text");
  assertEquals(citedText.annotations, [{
    type: "url_citation",
    start_index: 0,
    end_index: 7,
    title: "Gateway source",
    url: "https://example.com/gateway",
  }]);

  const toolHistory = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/default",
      input: [
        { type: "message", role: "developer", content: "Use tools carefully" },
        {
          type: "function_call",
          id: "fc_lookup",
          call_id: "call_lookup",
          name: "lookup",
          arguments: '{"q":"x"}',
        },
        { type: "function_call_output", call_id: "call_lookup", output: "tool response" },
      ],
    }),
  });
  assertEquals(toolHistory.status, 200);
  const convertedHistory = completedRequests.at(-1)!;
  assertEquals(convertedHistory.messages, [
    { role: "developer", content: "Use tools carefully" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_lookup",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"x"}' },
      }],
    },
    { role: "tool", tool_call_id: "call_lookup", content: "tool response" },
  ]);

  const richResponse = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "openai/default", input: "tool response" }),
  });
  assertEquals(richResponse.status, 200);
  const richBody = await json(richResponse);
  assertEquals(JSON.stringify(richBody).includes("must-not-leak"), false);
  assertEquals(richBody.store, false);
  assertEquals(
    richBody.output.some((item: { type: string }) => item.type === "function_call"),
    true,
  );
  assertEquals(richBody.output.some((item: { type: string }) => item.type === "reasoning"), true);
  assertEquals(
    richBody.output.some((item: { content?: Array<{ refusal?: string }> }) =>
      item.content?.some((part) => part.refusal === "policy refusal")
    ),
    true,
  );

  const richStream = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "openai/default", input: "tool response", stream: true }),
  });
  assertEquals(richStream.status, 200);
  const richEvents = (await richStream.text()).split("\n").filter((line) =>
    line.startsWith("data: {")
  ).map((line) => JSON.parse(line.slice(6)));
  assertEquals(
    richEvents.map((event, index) => event.sequence_number === index).every(Boolean),
    true,
  );
  assertEquals(richEvents.slice(0, 2).map((event) => event.type), [
    "response.created",
    "response.in_progress",
  ]);
  const added = richEvents.filter((event) => event.type === "response.output_item.added");
  for (const event of added) {
    assertEquals(event.item.status, "in_progress");
    if (event.item.type === "message") assertEquals(event.item.content, []);
    if (event.item.type === "reasoning") {
      assertEquals(event.item.summary, []);
      assertEquals(event.item.content, []);
    }
    if (event.item.type === "function_call") assertEquals(event.item.arguments, "");
  }
  const summaryAdded = richEvents.find((event) =>
    event.type === "response.reasoning_summary_part.added"
  );
  const summaryDelta = richEvents.find((event) =>
    event.type === "response.reasoning_summary_text.delta"
  );
  const summaryDone = richEvents.find((event) =>
    event.type === "response.reasoning_summary_part.done"
  );
  assertEquals(summaryAdded?.summary_index, 0);
  assertEquals(summaryAdded?.part, { type: "summary_text", text: "" });
  assertEquals(summaryDelta?.summary_index, 0);
  assertEquals(summaryDelta?.content_index, undefined);
  assertEquals(summaryDone?.part, { type: "summary_text", text: "policy summary" });
  const functionDone = richEvents.find((event) =>
    event.type === "response.function_call_arguments.done"
  );
  assertEquals(functionDone?.name, "lookup");
  assertEquals(functionDone?.arguments, '{"q":"x"}');

  const callsBeforeUnsupported = completedRequests.length;
  const usageBeforeUnsupported = await repository.usage(me.user.id);
  const stored = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/default",
      input: "do not claim unsupported storage",
      store: true,
    }),
  });
  assertEquals(stored.status, 400);
  assertEquals((await json(stored)).error.code, "unsupported_parameter");
  assertEquals(completedRequests.length, callsBeforeUnsupported);
  assertEquals(await repository.usage(me.user.id), usageBeforeUnsupported);
  const unsupported = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/default",
      input: "do not spend",
      previous_response_id: "resp_not_supported",
    }),
  });
  assertEquals(unsupported.status, 400);
  assertEquals((await json(unsupported)).error.code, "unsupported_feature");
  assertEquals(completedRequests.length, callsBeforeUnsupported);
  assertEquals(await repository.usage(me.user.id), usageBeforeUnsupported);
});
