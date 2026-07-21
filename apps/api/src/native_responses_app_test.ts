import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("public Chat and Responses routes execute a native Responses registry model", async () => {
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(4)]]),
  });
  const upstreamBodies: Record<string, unknown>[] = [];
  const upstreamUrls: string[] = [];
  let releasePublicResponsesStream: (() => void) | undefined;
  let publicResponsesTerminalReleased = false;
  let cancellationObserved = false;
  const responsesFetch: typeof fetch = (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assertEquals(headers.get("authorization"), "Bearer native-responses-secret");
    assertEquals(url, "https://native.example/v1/responses");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    upstreamUrls.push(url);
    upstreamBodies.push(body);
    assertEquals(body.model, "native-upstream");
    assertEquals(Object.hasOwn(body, "input"), true);
    assertEquals(Object.hasOwn(body, "messages"), false);
    if (JSON.stringify(body.input).includes("force public rate limit")) {
      return Promise.resolve(Response.json({
        error: {
          message: "Native provider rate limit",
          type: "rate_limit_error",
          param: null,
          code: "rate_limit_exceeded",
        },
      }, { status: 429, headers: { "retry-after": "2" } }));
    }
    if (JSON.stringify(body.input).includes("force provider authentication failure")) {
      return Promise.resolve(Response.json({
        error: {
          message: "Rejected provider credential sk-provider-fingerprint",
          type: "authentication_error",
          param: null,
          code: "invalid_api_key",
        },
      }, { status: 401 }));
    }
    if (JSON.stringify(body.input).includes("force provider timeout")) {
      return Promise.reject(new DOMException("native deadline exceeded", "TimeoutError"));
    }
    const id = `resp_${upstreamBodies.length}`;
    if (body.stream === true) {
      if (JSON.stringify(body.input).includes("force streaming secret")) {
        const events = [{
          type: "response.created",
          response: { id, status: "in_progress", model: "native-upstream" },
        }, {
          type: "response.failed",
          response: {
            id,
            status: "failed",
            model: "native-upstream",
            error: {
              code: "server_error",
              message: "Bearer streaming-provider-secret at https://internal.example.test",
            },
          },
        }];
        return Promise.resolve(
          new Response(
            events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(
              "",
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      if (JSON.stringify(body.input).includes("long token without usage")) {
        const text = " ".repeat(256);
        const messageId = `msg_long_${upstreamBodies.length}`;
        const events = [{
          type: "response.created",
          response: { id, status: "in_progress", model: "native-upstream" },
        }, {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: messageId, type: "message", status: "in_progress", role: "assistant" },
        }, {
          type: "response.content_part.added",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }, {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: text,
        }, {
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text,
        }, {
          type: "response.content_part.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        }, {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        }, {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            model: "native-upstream",
            output: [{
              id: messageId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            }],
          },
        }];
        return Promise.resolve(
          new Response(
            events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(
              "",
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      if (JSON.stringify(body.input).includes("cancel public response")) {
        const messageId = `msg_cancel_${upstreamBodies.length}`;
        const encode = (event: Record<string, unknown>) =>
          new TextEncoder().encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        const controlled = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode({
              type: "response.created",
              response: { id, status: "in_progress", model: "native-upstream" },
            }));
            controller.enqueue(encode({
              type: "response.output_item.added",
              output_index: 0,
              item: { id: messageId, type: "message", status: "in_progress", role: "assistant" },
            }));
            controller.enqueue(encode({
              type: "response.content_part.added",
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }));
            controller.enqueue(encode({
              type: "response.output_text.delta",
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: "bill this visible cancellation",
            }));
          },
          cancel() {
            cancellationObserved = true;
          },
        });
        init?.signal?.addEventListener("abort", () => {
          cancellationObserved = true;
        }, { once: true });
        return Promise.resolve(
          new Response(controlled, { headers: { "content-type": "text/event-stream" } }),
        );
      }
      if (upstreamBodies.length === 5) {
        const events = [{
          type: "response.created",
          response: { id, status: "in_progress", model: "native-upstream" },
        }, {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "rs_summary", type: "reasoning", status: "in_progress" },
        }, {
          type: "response.reasoning_summary_part.added",
          item_id: "rs_summary",
          output_index: 0,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }, {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_summary",
          output_index: 0,
          summary_index: 0,
          delta: "visible summary",
        }, {
          type: "response.failed",
          response: {
            id,
            status: "failed",
            model: "native-upstream",
            error: { code: "summary_failure", message: "failure after summary" },
          },
        }];
        return Promise.resolve(
          new Response(
            events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(
              "",
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      const messageId = `msg_stream_${upstreamBodies.length}`;
      const events = [
        {
          type: "response.created",
          response: { id, status: "in_progress", model: "native-upstream" },
        },
        { type: "response.queued", response: { id, status: "queued", model: "native-upstream" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: messageId, type: "message", status: "in_progress", role: "assistant" },
        },
        {
          type: "response.content_part.added",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: "native streamed result",
        },
        {
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: "native streamed result",
        },
        {
          type: "response.content_part.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "native streamed result", annotations: [] },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{
              type: "output_text",
              text: "native streamed result",
              annotations: [],
            }],
          },
        },
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            model: "native-upstream",
            output: [{
              id: messageId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{
                type: "output_text",
                text: "native streamed result",
                annotations: [],
              }],
            }],
            usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
          },
        },
      ];
      if (upstreamBodies.length === 4) {
        const encode = (event: Record<string, unknown>) =>
          new TextEncoder().encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        const controlled = new ReadableStream<Uint8Array>({
          start(controller) {
            const terminalStart = events.findIndex((event) =>
              event.type === "response.output_text.done"
            );
            for (const event of events.slice(0, terminalStart)) controller.enqueue(encode(event));
            releasePublicResponsesStream = () => {
              publicResponsesTerminalReleased = true;
              for (const event of events.slice(terminalStart)) controller.enqueue(encode(event));
              controller.close();
            };
          },
        });
        return Promise.resolve(
          new Response(controlled, {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(
            "",
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }
    const serializedInput = JSON.stringify(body.input);
    const incomplete = serializedInput.includes("truncate response");
    const highNativeToolUsage = serializedInput.includes("native shadow tool accounting");
    return Promise.resolve(Response.json({
      id,
      object: "response",
      status: incomplete ? "incomplete" : "completed",
      ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      model: "native-upstream",
      output: [{
        id: `msg_${upstreamBodies.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: highNativeToolUsage ? "ok" : "native buffered result",
          annotations: [],
        }],
      }],
      usage: highNativeToolUsage
        ? { input_tokens: 8_000, output_tokens: 1, total_tokens: 8_001 }
        : { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    }));
  };
  const { app, repository } = createApp({
    setupToken: "native-responses-app",
    providerKeyring: keyring,
    responsesFetch,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "native-responses-app" },
    body: JSON.stringify({
      email: "native-responses@example.com",
      name: "Native Responses Admin",
      password: "correct horse battery staple",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "native-responses@example.com",
      password: "correct horse battery staple",
    }),
  });
  const sessionHeaders = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  let provider = await json(
    await app.request("/api/admin/providers", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        slug: "native-responses",
        displayName: "Native Responses",
        baseUrl: "https://native.example/v1",
        protocol: "responses",
        enabled: false,
      }),
    }),
  );
  provider = await json(
    await app.request(`/api/admin/providers/${provider.id}/credential`, {
      method: "PUT",
      headers: sessionHeaders,
      body: JSON.stringify({
        expectedVersion: provider.version,
        credential: "native-responses-secret",
      }),
    }),
  );
  provider = await json(
    await app.request(`/api/admin/providers/${provider.id}`, {
      method: "PATCH",
      headers: sessionHeaders,
      body: JSON.stringify({ expectedVersion: provider.version, enabled: true }),
    }),
  );
  const modelResponse = await app.request("/api/admin/models", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      providerId: provider.id,
      publicModelId: "native-responses/model",
      upstreamModelId: "native-upstream",
      displayName: "Native Responses",
      capabilities: ["chat", "streaming", "tools"],
      // A tiny request must reserve its bounded input, not nearly the entire large context window.
      contextWindow: 4_000_000,
      enabled: true,
    }),
  });
  const model = await json(modelResponse);
  assertEquals(modelResponse.status, 201, JSON.stringify(model));
  assertEquals(
    (await app.request(`/api/admin/models/${model.id}/prices`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        providerModelId: model.id,
        expectedModelVersion: model.version,
        effectiveAt: new Date(Date.now() - 1_000).toISOString(),
        inputMicrosPerMillion: 2_000_000,
        cachedInputMicrosPerMillion: 50_000,
        reasoningMicrosPerMillion: 200_000,
        outputMicrosPerMillion: 300_000,
        fixedCallMicros: 10,
        source: "integration",
      }),
    })).status,
    201,
  );
  const openAIHeaders = sessionHeaders;
  const available = await json(await app.request("/api/models", { headers: sessionHeaders }));
  assertEquals(
    available.data.some((candidate: { id: string }) => candidate.id === "native-responses/model"),
    true,
    JSON.stringify(available),
  );

  const chat = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-chat-buffered" },
    body: JSON.stringify({
      model: "native-responses/model",
      messages: [{ role: "user", content: "buffered chat" }],
    }),
  });
  const chatBody = await json(chat);
  assertEquals(chat.status, 200, JSON.stringify(chatBody));
  assertStringIncludes(JSON.stringify(chatBody), "native buffered result");

  const chatStream = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-chat-stream" },
    body: JSON.stringify({
      model: "native-responses/model",
      messages: [{ role: "user", content: "streamed chat" }],
      stream: true,
    }),
  });
  assertEquals(chatStream.status, 200);
  const chatStreamText = await chatStream.text();
  assertStringIncludes(chatStreamText, "native streamed result");
  assertEquals(chatStreamText.trimEnd().endsWith("data: [DONE]"), true);
  assertEquals(chatStreamText.includes('"usage"'), false);

  const statelessInput = [
    {
      type: "reasoning",
      id: "rs_previous",
      summary: [{ type: "summary_text", text: "Use the prior output" }],
      encrypted_content: "opaque-provider-state",
      status: "completed",
    },
    {
      type: "message",
      id: "msg_previous",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Prior native answer", annotations: [] }],
    },
    {
      type: "function_call",
      id: "fc_previous",
      call_id: "call_previous",
      name: "lookup",
      arguments: '{"query":"prior"}',
      status: "completed",
    },
    {
      type: "function_call_output",
      call_id: "call_previous",
      output: "prior tool result",
    },
    { type: "message", role: "user", content: "buffered response" },
  ];
  const response = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-buffered" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: statelessInput,
      store: false,
      metadata: { request: "buffered" },
      user: "public-buffered-user",
    }),
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertStringIncludes((await json(response)).output[0].content[0].text, "native buffered result");
  assertEquals(upstreamBodies[2].store, false);
  assertEquals(upstreamBodies[2].metadata, { request: "buffered" });
  assertEquals(upstreamBodies[2].user, "public-buffered-user");
  assertEquals(upstreamBodies[2].input, statelessInput);

  const responseStream = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-stream" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "streamed response",
      stream: true,
      store: false,
      metadata: { request: "streaming" },
      user: "public-streaming-user",
    }),
  });
  assertEquals(responseStream.status, 200);
  const responseReader = responseStream.body!.getReader();
  const decoder = new TextDecoder();
  let responseStreamText = "";
  while (!responseStreamText.includes("response.output_text.delta")) {
    const next = await responseReader.read();
    assertEquals(next.done, false);
    responseStreamText += decoder.decode(next.value, { stream: true });
  }
  assertEquals(publicResponsesTerminalReleased, false);
  assertExists(releasePublicResponsesStream);
  releasePublicResponsesStream();
  while (true) {
    const next = await responseReader.read();
    if (next.done) break;
    responseStreamText += decoder.decode(next.value, { stream: true });
  }
  responseStreamText += decoder.decode();
  assertStringIncludes(responseStreamText, "response.output_text.delta");
  assertStringIncludes(responseStreamText, "native streamed result");
  assertEquals(upstreamBodies[3].store, false);
  assertEquals(upstreamBodies[3].metadata, { request: "streaming" });
  assertEquals(upstreamBodies[3].user, "public-streaming-user");

  const summaryFailure = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-summary-failure" },
    body: JSON.stringify({
      model: "native-responses/model",
      messages: [{ role: "user", content: "summary then fail" }],
      stream: true,
    }),
  });
  assertEquals(summaryFailure.status, 200, await summaryFailure.clone().text());
  const summaryFailureText = await summaryFailure.text();
  assertStringIncludes(summaryFailureText, "visible summary");
  assertStringIncludes(summaryFailureText, "provider_error");
  const reasoningRequest = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-reasoning-summary" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "reason with summary",
      reasoning: { effort: "high", summary: "auto" },
    }),
  });
  assertEquals(reasoningRequest.status, 200, await reasoningRequest.text());
  assertEquals(upstreamUrls.length, 6);
  assertEquals(
    upstreamBodies.map((body) => body.stream),
    [false, true, false, true, true, false],
  );
  assertEquals(upstreamBodies.at(-1)?.reasoning, { effort: "high", summary: "auto" });

  const incompleteResponse = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-incomplete-response" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "truncate response",
      max_output_tokens: 4,
    }),
  });
  const incompleteBody = await json(incompleteResponse);
  assertEquals(incompleteResponse.status, 200, JSON.stringify(incompleteBody));
  assertEquals(incompleteBody.status, "incomplete");
  assertEquals(incompleteBody.incomplete_details, { reason: "max_output_tokens" });
  assertEquals(incompleteBody.store, false);
  assertEquals(upstreamBodies.at(-1)?.store, false);
  assertEquals(upstreamUrls.length, 7);

  const usageStream = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-chat-usage-stream" },
    body: JSON.stringify({
      model: "native-responses/model",
      messages: [{ role: "user", content: "stream with usage" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  assertStringIncludes(await usageStream.text(), '"usage"');
  const noUsageStream = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-chat-no-usage-stream" },
    body: JSON.stringify({
      model: "native-responses/model",
      messages: [{ role: "user", content: "stream without usage" }],
      stream: true,
      stream_options: { include_usage: false },
    }),
  });
  assertEquals((await noUsageStream.text()).includes('"usage"'), false);
  assertEquals(upstreamUrls.length, 9);
  assertEquals(upstreamBodies.slice(-2).map((body) => body.stream), [true, true]);
  const memory = repository as MemoryRepository;
  for (
    const key of [
      "native-chat-stream",
      "native-response-stream",
      "native-chat-usage-stream",
      "native-chat-no-usage-stream",
    ]
  ) {
    const replay = [...memory.apiIdempotencyRequests.values()].find((item) =>
      item.idempotencyKey === key
    );
    assertExists(replay);
    const usageRun = memory.usageRuns.get(replay.usageRunId);
    assertEquals(usageRun?.outputTokens, 3, `${key} must prefer provider-reported usage`);
  }
  const failedReplay = [...memory.apiIdempotencyRequests.values()].find((item) =>
    item.idempotencyKey === "native-summary-failure"
  );
  assertExists(failedReplay);
  const failedUsage = memory.usageRuns.get(failedReplay.usageRunId);
  assertEquals((failedUsage?.outputTokens ?? 0) > 0, true);
  assertEquals((failedUsage?.costMicros ?? 0) > 0, true);

  const cancelled = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-cancelled" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "cancel public response",
      stream: true,
    }),
  });
  const cancelledReader = cancelled.body!.getReader();
  let cancelledText = "";
  while (!cancelledText.includes("bill this visible cancellation")) {
    const next = await cancelledReader.read();
    assertEquals(next.done, false);
    cancelledText += new TextDecoder().decode(next.value);
  }
  await cancelledReader.cancel("client stopped reading");
  for (let attempt = 0; attempt < 20 && !cancellationObserved; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(cancellationObserved, true);
  const cancelledReplay = [...memory.apiIdempotencyRequests.values()].find((item) =>
    item.idempotencyKey === "native-response-cancelled"
  );
  assertExists(cancelledReplay);
  for (
    let attempt = 0;
    attempt < 100 && memory.usageRuns.get(cancelledReplay.usageRunId)?.status === "reserved";
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const cancelledUsage = memory.usageRuns.get(cancelledReplay.usageRunId);
  assertEquals(cancelledUsage?.status, "completed");
  assertEquals((cancelledUsage?.outputTokens ?? 0) > 0, true);

  const nativeUser = [...(repository as MemoryRepository).users.values()].find((candidate) =>
    candidate.email === "native-responses@example.com"
  );
  assertExists(nativeUser);
  const balanceBeforeRateLimit = (await repository.usage(nativeUser.id)).balanceMicros;
  const rateLimited = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-rate-limit" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "force public rate limit",
    }),
  });
  const rateLimitedBody = await json(rateLimited);
  assertEquals(rateLimited.status, 429, JSON.stringify(rateLimitedBody));
  assertEquals(rateLimited.headers.get("retry-after"), "2");
  assertEquals(rateLimitedBody.error.code, "rate_limit_exceeded");
  assertEquals(rateLimitedBody.error.type, "rate_limit_error");
  assertEquals(rateLimitedBody.error.message, "The provider rate limit was exceeded");
  assertEquals(JSON.stringify(rateLimitedBody).includes("Native provider rate limit"), false);
  assertEquals((await repository.usage(nativeUser.id)).balanceMicros, balanceBeforeRateLimit);

  const authenticationFailure = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-provider-auth" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "force provider authentication failure",
    }),
  });
  const authenticationFailureBody = await json(authenticationFailure);
  assertEquals(authenticationFailure.status, 502, JSON.stringify(authenticationFailureBody));
  assertEquals(authenticationFailureBody.error.code, "provider_authentication_error");
  assertEquals(authenticationFailureBody.error.type, "server_error");
  assertEquals(
    authenticationFailureBody.error.message,
    "The configured provider rejected its credentials",
  );
  assertEquals(
    JSON.stringify(authenticationFailureBody).includes("sk-provider-fingerprint"),
    false,
  );

  const boundedEstimate = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-bounded-estimate" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "long token without usage",
      max_output_tokens: 1,
      stream: true,
    }),
  });
  const boundedEstimateBody = await boundedEstimate.text();
  assertStringIncludes(boundedEstimateBody, "response.completed");
  const boundedReplay = [...memory.apiIdempotencyRequests.values()].find((item) =>
    item.idempotencyKey === "native-response-bounded-estimate"
  );
  assertExists(boundedReplay);
  assertEquals(memory.usageRuns.get(boundedReplay.usageRunId)?.outputTokens, 1);

  const timeout = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-timeout" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "force provider timeout",
    }),
  });
  const timeoutBody = await json(timeout);
  assertEquals(timeout.status, 504, JSON.stringify(timeoutBody));
  assertEquals(timeoutBody.error.code, "timeout");
  assertEquals(timeoutBody.error.type, "server_error");

  for (
    const [name, tool] of [
      ["web-search", { type: "web_search", search_context_size: "medium" }],
      ["mcp", { type: "mcp", server_label: "docs", server_url: "https://mcp.example.test" }],
    ] as const
  ) {
    const dispatchesBefore = upstreamBodies.length;
    const usageBefore = memory.usageRuns.size;
    const deniedTool = await app.request("/v1/responses", {
      method: "POST",
      headers: { ...openAIHeaders, "idempotency-key": `native-response-${name}` },
      body: JSON.stringify({
        model: "native-responses/model",
        input: "do not dispatch network tools",
        tools: [tool],
        tool_choice: "auto",
      }),
    });
    const deniedBody = await json(deniedTool);
    assertEquals(deniedTool.status, 400, JSON.stringify(deniedBody));
    assertEquals(deniedBody.error.code, "unsupported_feature");
    assertEquals(upstreamBodies.length, dispatchesBefore);
    assertEquals(memory.usageRuns.size, usageBefore);
  }

  const safeFunctionTools = [{
    type: "function",
    name: "lookup",
    description: "Look up an internal value",
    parameters: { type: "object", properties: { key: { type: "string" } } },
  }];
  const functionToolResponse = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-function-tools" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "use a bounded function",
      tools: safeFunctionTools,
      tool_choice: "auto",
    }),
  });
  assertEquals(functionToolResponse.status, 200, await functionToolResponse.clone().text());
  assertEquals(upstreamBodies.at(-1)?.tools, safeFunctionTools);

  const nativeOnlyInput = [{
    type: "reasoning",
    summary: [{ type: "summary_text", text: "prior provider state" }],
    status: "completed",
  }, {
    type: "message",
    role: "user",
    content: "native shadow tool accounting",
  }];
  const largeNativeFunctionTools = [{
    type: "function",
    name: "large_native_schema",
    description: "x".repeat(8_192),
    parameters: { type: "object", properties: {} },
  }];
  const nativeToolAccounting = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-native-tool-accounting" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: nativeOnlyInput,
      max_output_tokens: 8,
      tools: largeNativeFunctionTools,
      tool_choice: "auto",
    }),
  });
  assertEquals(
    nativeToolAccounting.status,
    200,
    await nativeToolAccounting.clone().text(),
  );
  assertEquals(upstreamBodies.at(-1)?.input, nativeOnlyInput);
  assertEquals(upstreamBodies.at(-1)?.tools, largeNativeFunctionTools);

  const streamingFailure = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-stream-secret" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "force streaming secret",
      stream: true,
    }),
  });
  const streamingFailureText = await streamingFailure.text();
  assertStringIncludes(streamingFailureText, '"code":"provider_error"');
  assertStringIncludes(streamingFailureText, '"message":"Provider request failed"');
  assertEquals(streamingFailureText.includes("streaming-provider-secret"), false);
  assertEquals(streamingFailureText.includes("internal.example.test"), false);

  const dispatchesBeforeUnsupportedStore = upstreamBodies.length;
  const usageBeforeUnsupportedStore = memory.usageRuns.size;
  const unsupportedStore = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-store-true" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "do not dispatch stored response",
      store: true,
    }),
  });
  const unsupportedStoreBody = await json(unsupportedStore);
  assertEquals(unsupportedStore.status, 400, JSON.stringify(unsupportedStoreBody));
  assertEquals(unsupportedStoreBody.error.code, "unsupported_parameter");
  assertEquals(upstreamBodies.length, dispatchesBeforeUnsupportedStore);
  assertEquals(memory.usageRuns.size, usageBeforeUnsupportedStore);

  const account = memory.users.get(nativeUser.id);
  assertExists(account);
  account.balanceMicros = 5_000;
  const dispatchesBeforeNativeToolCredit = upstreamBodies.length;
  const insufficientNativeToolCredit = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      ...openAIHeaders,
      "idempotency-key": "native-response-native-tool-insufficient-credit",
    },
    body: JSON.stringify({
      model: "native-responses/model",
      input: nativeOnlyInput,
      max_output_tokens: 8,
      tools: largeNativeFunctionTools,
      tool_choice: "auto",
    }),
  });
  assertEquals(
    insufficientNativeToolCredit.status,
    402,
    await insufficientNativeToolCredit.clone().text(),
  );
  assertEquals((await json(insufficientNativeToolCredit)).error.code, "insufficient_credit");
  assertEquals(upstreamBodies.length, dispatchesBeforeNativeToolCredit);

  const dispatchesBeforeLargeTool = upstreamBodies.length;
  const insufficientToolCredit = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...openAIHeaders, "idempotency-key": "native-response-large-tool-credit" },
    body: JSON.stringify({
      model: "native-responses/model",
      input: "small prompt",
      max_output_tokens: 1,
      tools: [{
        type: "function",
        name: "large_schema",
        description: "x".repeat(8_192),
        parameters: { type: "object", properties: {} },
      }],
    }),
  });
  assertEquals(insufficientToolCredit.status, 402, await insufficientToolCredit.clone().text());
  assertEquals((await json(insufficientToolCredit)).error.code, "insufficient_credit");
  assertEquals(upstreamBodies.length, dispatchesBeforeLargeTool);
});
