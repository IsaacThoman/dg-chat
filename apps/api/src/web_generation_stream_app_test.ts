import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

async function session(app: ReturnType<typeof createApp>["app"], setupToken: string) {
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": setupToken },
    body: JSON.stringify({
      email: `${setupToken}@example.com`,
      password: "correct horse battery",
      name: "Stream Admin",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${setupToken}@example.com`,
      password: "correct horse battery",
    }),
  });
  return cookie(login);
}

const headers = (sessionCookie: string) => ({
  cookie: sessionCookie,
  origin: "http://localhost:5173",
  "content-type": "application/json",
});

function eventPayloads(text: string) {
  return text.split("\n").filter((line) => line.startsWith("data: {")).map((line) =>
    JSON.parse(line.slice(6)) as Record<string, unknown>
  );
}

Deno.test("typed web streaming completes, replays, regenerates, and continues immutable branches", async () => {
  let answer = "first answer";
  const providerStream = async function* (_request: ChatCompletionRequest) {
    yield JSON.stringify({
      id: "upstream-private",
      model: "private-model",
      choices: [{ index: 0, delta: { content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    yield "[DONE]";
  };
  const { app } = createApp({ setupToken: "stream-flow", providerStream });
  const auth = await session(app, "stream-flow");
  const created = await app.request("/api/conversations", {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ title: "Streaming" }),
  });
  const conversation = await created.json() as { id: string; version: number };
  const sendBody = {
    mode: "send",
    parentId: null,
    content: "hello",
    model: "simulated/dg-chat",
    expectedVersion: 0,
    idempotencyKey: "typed-stream-send",
    attachmentIds: [],
  };
  const sent = await app.request(`/api/conversations/${conversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify(sendBody),
  });
  assertEquals(sent.status, 200);
  const firstEvents = eventPayloads(await sent.text());
  assertEquals(firstEvents.map((event) => event.type), [
    "generation.started",
    "response.text.delta",
    "response.usage",
    "generation.completed",
  ]);
  const generationId = firstEvents[0].generationId;
  assertEquals(typeof generationId, "string");
  assertEquals(JSON.stringify(firstEvents).includes("upstream-private"), false);
  assertEquals(JSON.stringify(firstEvents).includes("private-model"), false);

  const replay = await app.request(`/api/conversations/${conversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify(sendBody),
  });
  const replayEvents = eventPayloads(await replay.text());
  assertEquals(replayEvents[0].generationId, generationId);
  assertEquals(replayEvents[0].replay, true);
  assertEquals(replayEvents.at(-1)?.type, "generation.completed");

  let detail = await (await app.request(`/api/conversations/${conversation.id}`, {
    headers: { cookie: auth },
  })).json() as {
    version: number;
    activeLeafId: string | null;
    messages: Array<Record<string, unknown>>;
  };
  assertEquals(detail.messages.length, 2);
  const originalAssistant = detail.messages.find((message) => message.role === "assistant")!;

  answer = "replacement";
  const regenerateBody = {
    mode: "regenerate",
    sourceMessageId: originalAssistant.id,
    model: "simulated/dg-chat",
    expectedVersion: detail.version,
    idempotencyKey: "typed-stream-regenerate",
  };
  const regenerated = await app.request(`/api/conversations/${conversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify(regenerateBody),
  });
  assertEquals(regenerated.status, 200);
  const regenerateEvents = eventPayloads(await regenerated.text());
  assertEquals(regenerateEvents.at(-1)?.type, "generation.completed");
  detail = await (await app.request(`/api/conversations/${conversation.id}`, {
    headers: { cookie: auth },
  })).json() as typeof detail;
  assertEquals(detail.messages.length, 3);
  const replacement = detail.messages.find((message) => message.content === "replacement")!;
  assertEquals(replacement.parentId, originalAssistant.parentId);
  assertEquals(replacement.supersedesId, originalAssistant.id);
  const regenerateReplay = await app.request(
    `/api/conversations/${conversation.id}/generate/stream`,
    { method: "POST", headers: headers(auth), body: JSON.stringify(regenerateBody) },
  );
  const regenerateReplayEvents = eventPayloads(await regenerateReplay.text());
  assertEquals(regenerateReplayEvents[0].replay, true);
  assertEquals(regenerateReplayEvents[0].generationId, regenerateEvents[0].generationId);

  answer = "continued";
  const continueBody = {
    mode: "continue",
    sourceMessageId: replacement.id,
    model: "simulated/dg-chat",
    expectedVersion: detail.version,
    idempotencyKey: "typed-stream-continue",
  };
  const continued = await app.request(`/api/conversations/${conversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify(continueBody),
  });
  assertEquals(continued.status, 200);
  const continueEvents = eventPayloads(await continued.text());
  detail = await (await app.request(`/api/conversations/${conversation.id}`, {
    headers: { cookie: auth },
  })).json() as typeof detail;
  assertEquals(detail.messages.length, 4);
  const continuation = detail.messages.find((message) =>
    message.content === "replacement\n\ncontinued"
  )!;
  assertEquals(continuation.supersedesId, replacement.id);
  assertEquals((continuation.metadata as Record<string, unknown>).continuesId, replacement.id);
  const continueReplay = await app.request(
    `/api/conversations/${conversation.id}/generate/stream`,
    {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify(continueBody),
    },
  );
  const continueReplayEvents = eventPayloads(await continueReplay.text());
  assertEquals(continueReplayEvents[0].replay, true);
  assertEquals(continueReplayEvents[0].generationId, continueEvents[0].generationId);

  // Build a genuine descendant path, then regenerate its earlier assistant ancestor.
  const earlierConversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ title: "Earlier branch" }),
  })).json() as { id: string };
  answer = "ancestor";
  await (await app.request(`/api/conversations/${earlierConversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({
      ...sendBody,
      idempotencyKey: "typed-stream-ancestor",
    }),
  })).text();
  let earlierDetail = await (await app.request(`/api/conversations/${earlierConversation.id}`, {
    headers: { cookie: auth },
  })).json() as typeof detail;
  const ancestor = earlierDetail.messages.find((message) => message.content === "ancestor")!;
  answer = "descendant";
  await (await app.request(`/api/conversations/${earlierConversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({
      ...sendBody,
      parentId: ancestor.id,
      content: "follow up",
      expectedVersion: earlierDetail.version,
      idempotencyKey: "typed-stream-descendant",
    }),
  })).text();
  earlierDetail = await (await app.request(`/api/conversations/${earlierConversation.id}`, {
    headers: { cookie: auth },
  })).json() as typeof detail;
  answer = "earlier replacement";
  const earlier = await app.request(
    `/api/conversations/${earlierConversation.id}/generate/stream`,
    {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify({
        mode: "regenerate",
        sourceMessageId: ancestor.id,
        model: "simulated/dg-chat",
        expectedVersion: earlierDetail.version,
        idempotencyKey: "typed-stream-earlier-regenerate",
      }),
    },
  );
  assertEquals(earlier.status, 200);
  const earlierEvents = eventPayloads(await earlier.text());
  const earlierStartedConversation = earlierEvents[0].conversation as Record<string, unknown>;
  assertEquals(earlierStartedConversation.activeLeafId, ancestor.id);
  earlierDetail = await (await app.request(`/api/conversations/${earlierConversation.id}`, {
    headers: { cookie: auth },
  })).json() as typeof detail;
  const earlierReplacement = earlierDetail.messages.find((message) =>
    message.content === "earlier replacement"
  )!;
  assertEquals(earlierDetail.activeLeafId, earlierReplacement.id);
  assertEquals(earlierReplacement.supersedesId, ancestor.id);

  const stale = await app.request(`/api/conversations/${conversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({
      ...sendBody,
      parentId: continuation.id,
      idempotencyKey: "typed-stream-stale",
      expectedVersion: 0,
    }),
  });
  assertEquals(stale.status, 409);
});

Deno.test("web generation persists refusals and durably replays terminal errors", async () => {
  const providerStream = async function* (request: ChatCompletionRequest) {
    const content = String(request.messages.at(-1)?.content ?? "");
    if (content.includes("refuse")) {
      yield JSON.stringify({
        choices: [{
          index: 0,
          delta: { content: "A partial answer. " },
          finish_reason: null,
        }],
      });
      yield JSON.stringify({
        choices: [{
          index: 0,
          delta: { refusal: "I cannot help with that." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 2, completion_tokens: 6 },
      });
      yield "[DONE]";
      return;
    }
    if (content.includes("tool")) {
      yield JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"answer"' },
            }],
          },
          finish_reason: null,
        }],
      });
      yield JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: ":42}" } }] },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 2, completion_tokens: 4 },
      });
      yield "[DONE]";
      return;
    }
    if (content.includes("fail")) {
      yield JSON.stringify({
        choices: [{ index: 0, delta: { content: "Partial text. " }, finish_reason: null }],
      });
      yield JSON.stringify({
        choices: [{ index: 0, delta: { refusal: "Then refused." }, finish_reason: null }],
      });
    }
    throw new Error("deterministic provider failure");
  };
  const { app } = createApp({ setupToken: "stream-terminal", providerStream });
  const auth = await session(app, "stream-terminal");

  const refusalConversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ title: "Refusal" }),
  })).json() as { id: string };
  const refusal = await app.request(
    `/api/conversations/${refusalConversation.id}/generate/stream`,
    {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify({
        mode: "send",
        parentId: null,
        content: "please refuse",
        model: "simulated/dg-chat",
        expectedVersion: 0,
        idempotencyKey: "typed-stream-refusal",
        attachmentIds: [],
      }),
    },
  );
  const refusalEvents = eventPayloads(await refusal.text());
  assertEquals(refusalEvents.map((event) => event.type), [
    "generation.started",
    "response.text.delta",
    "response.refusal.delta",
    "response.usage",
    "generation.completed",
  ]);
  assertEquals(
    (refusalEvents.at(-1)?.assistant as Record<string, unknown>).content,
    "A partial answer. I cannot help with that.",
  );

  const toolConversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ title: "Tool" }),
  })).json() as { id: string };
  const toolResponse = await app.request(
    `/api/conversations/${toolConversation.id}/generate/stream`,
    {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify({
        mode: "send",
        parentId: null,
        content: "use a tool",
        model: "simulated/dg-chat",
        expectedVersion: 0,
        idempotencyKey: "typed-stream-tool",
        attachmentIds: [],
      }),
    },
  );
  const toolEvents = eventPayloads(await toolResponse.text());
  assertEquals(toolEvents.filter((event) => event.type === "response.tool_call.delta").length, 2);
  const toolAssistant = toolEvents.at(-1)?.assistant as {
    metadata: { toolCalls: Array<{ name: string; arguments: string }> };
  };
  assertEquals(toolAssistant.metadata.toolCalls[0].name, "lookup");
  assertEquals(toolAssistant.metadata.toolCalls[0].arguments, '{"answer":42}');

  const errorConversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ title: "Error" }),
  })).json() as { id: string };
  const errorBody = {
    mode: "send",
    parentId: null,
    content: "fail deterministically",
    model: "simulated/dg-chat",
    expectedVersion: 0,
    idempotencyKey: "typed-stream-error",
    attachmentIds: [],
  };
  const failed = await app.request(`/api/conversations/${errorConversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify(errorBody),
  });
  const failedEvents = eventPayloads(await failed.text());
  assertEquals(failedEvents.map((event) => event.type), [
    "generation.started",
    "response.text.delta",
    "response.refusal.delta",
    "generation.error",
  ]);
  assertEquals(
    (failedEvents.at(-1)?.assistant as Record<string, unknown>).content,
    "Partial text. Then refused.",
  );
  const failedGenerationId = failedEvents[0].generationId;

  const replay = await app.request(`/api/conversations/${errorConversation.id}/generate/stream`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify(errorBody),
  });
  assertEquals(replay.status, 200);
  const replayEvents = eventPayloads(await replay.text());
  assertEquals(replayEvents[0].replay, true);
  assertEquals(replayEvents[0].generationId, failedGenerationId);
  assertEquals(replayEvents.at(-1)?.type, "generation.error");
});

Deno.test("durable owner-scoped stop crosses app replicas and persists one stopped terminal", async () => {
  const repository = new MemoryRepository();
  const providerStream = async function* (
    _request: ChatCompletionRequest,
    signal: AbortSignal,
  ) {
    yield JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
    yield "[DONE]";
  };
  const first = createApp({
    repository,
    setupToken: "stream-stop",
    providerStream,
    generationStopPollMs: 100,
  });
  const second = createApp({ repository, providerStream, generationStopPollMs: 100 });
  const auth = await session(first.app, "stream-stop");
  const conversation = await (await first.app.request("/api/conversations", {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ title: "Stop" }),
  })).json() as { id: string };
  const response = await first.app.request(
    `/api/conversations/${conversation.id}/generate/stream`,
    {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify({
        mode: "send",
        parentId: null,
        content: "stop this",
        model: "simulated/dg-chat",
        expectedVersion: 0,
        idempotencyKey: "typed-stream-stop",
        attachmentIds: [],
      }),
    },
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes("generation.started") || !body.includes("response.text.delta")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value, { stream: true });
  }
  const match = body.match(/"generationId":"([^"]+)"/);
  assertExists(match);
  const stop = await second.app.request(
    `/api/conversations/${conversation.id}/generations/${match[1]}/stop`,
    { method: "POST", headers: headers(auth) },
  );
  assertEquals(stop.status, 202);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value, { stream: true });
  }
  assertStringIncludes(body, "generation.stopped");
  const detail = await (await first.app.request(`/api/conversations/${conversation.id}`, {
    headers: { cookie: auth },
  })).json() as { messages: Array<{ role: string; status: string; content: string }> };
  assertEquals(
    detail.messages.filter((message) => message.role === "assistant").map((message) => ({
      role: message.role,
      status: message.status,
      content: message.content,
    })),
    [{ role: "assistant", status: "stopped", content: "partial" }],
    "assistant projection should be one immutable stopped node",
  );
});
