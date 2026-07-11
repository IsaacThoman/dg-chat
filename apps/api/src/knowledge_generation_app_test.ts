import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";

const json = (response: Response) => response.json() as Promise<Record<string, unknown>>;

Deno.test("bound knowledge changes nonstream and stream provider payloads and persists sources", async () => {
  const repo = new MemoryRepository();
  const completeRequests: ChatCompletionRequest[] = [];
  const streamRequests: ChatCompletionRequest[] = [];
  let completeFails = false;
  let streamFails = false;
  let streamStops = false;
  const { app } = createApp({
    repository: repo,
    setupToken: "knowledge-generation",
    webComplete: (request) => {
      completeRequests.push(structuredClone(request));
      if (completeFails) throw new Error("provider failed");
      return Promise.resolve({ text: "complete", inputTokens: 2, outputTokens: 1 });
    },
    providerStream: async function* (request, signal) {
      streamRequests.push(structuredClone(request));
      if (streamFails) throw new Error("stream failed");
      yield JSON.stringify({
        id: "rag-stream",
        model: request.model,
        choices: [{ index: 0, delta: { content: "stream" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
      if (streamStops) {
        signal.throwIfAborted();
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        );
      }
      yield "[DONE]";
    },
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "knowledge-generation" },
    body: JSON.stringify({
      email: "rag-admin@example.com",
      password: "correct horse battery",
      name: "Rag",
    }),
  });
  const owner = (await json(bootstrap)).user as { id: string };
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "rag-admin@example.com", password: "correct horse battery" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  const headers = { cookie, origin: "http://localhost:5173", "content-type": "application/json" };
  const conversation = repo.createConversation(owner.id, "RAG");
  const collection = repo.createKnowledgeCollection(owner.id, {
    name: "Ops",
    idempotencyKey: "ops",
  });
  const attachment = repo.createAttachment({
    ownerId: owner.id,
    objectKey: `users/${owner.id}/ops`,
    filename: "ops.txt",
    mimeType: "text/plain",
    sizeBytes: 20,
    sha256: "b".repeat(64),
    state: "ready",
  }).attachment;
  repo.beginAttachmentIngestion(attachment.id, owner.id);
  repo.completeAttachmentIngestion(attachment.id, owner.id, [{
    id: crypto.randomUUID(),
    ordinal: 0,
    content: "Reset turbine with blue lever.",
    metadata: {
      sourceAttachmentId: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sha256: attachment.sha256,
      extractorVersion: "builtin-document-v1",
      chunkerVersion: "character-overlap-v1",
    },
  }]);
  repo.linkKnowledgeAttachment(collection.id, attachment.id, owner.id, 1);
  repo.bindKnowledgeCollection(conversation.id, collection.id, owner.id, "retrieval");

  const first = await app.request(`/api/conversations/${conversation.id}/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      parentId: null,
      content: "reset turbine",
      model: "simulated/dg-chat",
      expectedVersion: 0,
      idempotencyKey: "rag-nonstream",
      attachmentIds: [],
    }),
  });
  assertEquals(first.status, 201);
  const firstPayload = await json(first) as unknown as {
    assistant: { id: string; metadata: { knowledgeSources: Array<{ filename: string }> } };
    conversation: { version: number };
  };
  assertStringIncludes(
    String(completeRequests[0].messages[0].content),
    "Reset turbine with blue lever",
  );
  assertEquals(firstPayload.assistant.metadata.knowledgeSources[0].filename, "ops.txt");

  const stream = await app.request(`/api/conversations/${conversation.id}/generate/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: "send",
      parentId: firstPayload.assistant.id,
      content: "blue lever",
      model: "simulated/dg-chat",
      expectedVersion: firstPayload.conversation.version,
      idempotencyKey: "rag-stream",
      attachmentIds: [],
    }),
  });
  assertEquals(stream.status, 200);
  await stream.text();
  assertStringIncludes(
    String(streamRequests[0].messages[0].content),
    "Reset turbine with blue lever",
  );
  const detail = await repo.detail(conversation.id, owner.id);
  const streamed = detail.messages.find((message) =>
    message.metadata.runId === `${owner.id}:web-generation:rag-stream`
  );
  assertExists(streamed);
  assertEquals(
    (streamed.metadata.knowledgeSources as Array<{ filename: string }>)[0].filename,
    "ops.txt",
  );

  const replay = await app.request(`/api/conversations/${conversation.id}/generate/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: "send",
      parentId: firstPayload.assistant.id,
      content: "blue lever",
      model: "simulated/dg-chat",
      expectedVersion: firstPayload.conversation.version,
      idempotencyKey: "rag-stream",
      attachmentIds: [],
    }),
  });
  assertStringIncludes(await replay.text(), '"knowledgeSources"');

  completeFails = true;
  const failedConversation = repo.createConversation(owner.id, "Failed RAG");
  repo.bindKnowledgeCollection(
    failedConversation.id,
    collection.id,
    owner.id,
    "retrieval",
  );
  const failedBody = {
    parentId: null,
    content: "reset turbine",
    model: "simulated/dg-chat",
    expectedVersion: 0,
    idempotencyKey: "rag-failure",
    attachmentIds: [],
  };
  const failed = await app.request(`/api/conversations/${failedConversation.id}/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(failedBody),
  });
  assertEquals(failed.status, 502);
  const failedDetail = await repo.detail(failedConversation.id, owner.id);
  const failedAssistant = failedDetail.messages.find((message) => message.status === "error");
  assertExists(failedAssistant);
  assertEquals(
    (failedAssistant.metadata.localCitations as Array<{ filename: string }>)[0].filename,
    "ops.txt",
  );
  const failedReplay = await app.request(`/api/conversations/${failedConversation.id}/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(failedBody),
  });
  assertEquals(failedReplay.status, 200);
  const failedReplayPayload = await json(failedReplay) as unknown as {
    assistant: { metadata: { localCitations: Array<{ filename: string }> } };
  };
  assertEquals(failedReplayPayload.assistant.metadata.localCitations[0].filename, "ops.txt");

  streamFails = true;
  const errorConversation = repo.createConversation(owner.id, "Stream error RAG");
  repo.bindKnowledgeCollection(errorConversation.id, collection.id, owner.id, "retrieval");
  const errorBody = {
    mode: "send",
    parentId: null,
    content: "reset turbine",
    model: "simulated/dg-chat",
    expectedVersion: 0,
    idempotencyKey: "rag-stream-error",
    attachmentIds: [],
  };
  const errored = await app.request(
    `/api/conversations/${errorConversation.id}/generate/stream`,
    { method: "POST", headers, body: JSON.stringify(errorBody) },
  );
  const erroredText = await errored.text();
  assertStringIncludes(erroredText, "generation.error");
  const errorDetail = await repo.detail(errorConversation.id, owner.id);
  const errorAssistant = errorDetail.messages.find((message) => message.status === "error");
  assertExists(errorAssistant);
  assertEquals(
    (errorAssistant.metadata.localCitations as Array<{ filename: string }>)[0].filename,
    "ops.txt",
  );
  const errorReplay = await app.request(
    `/api/conversations/${errorConversation.id}/generate/stream`,
    { method: "POST", headers, body: JSON.stringify(errorBody) },
  );
  assertStringIncludes(await errorReplay.text(), '"localCitations"');

  streamFails = false;
  streamStops = true;
  const stoppedConversation = repo.createConversation(owner.id, "Stream stop RAG");
  repo.bindKnowledgeCollection(stoppedConversation.id, collection.id, owner.id, "retrieval");
  const stoppedResponse = await app.request(
    `/api/conversations/${stoppedConversation.id}/generate/stream`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        mode: "send",
        parentId: null,
        content: "reset turbine",
        model: "simulated/dg-chat",
        expectedVersion: 0,
        idempotencyKey: "rag-stream-stop",
        attachmentIds: [],
      }),
    },
  );
  const reader = stoppedResponse.body!.getReader();
  const decoder = new TextDecoder();
  let stoppedText = "";
  let generationId: string | undefined;
  while (!generationId) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stoppedText += decoder.decode(chunk.value, { stream: true });
    generationId = /"generationId":"([^"]+)"/.exec(stoppedText)?.[1];
  }
  assertExists(generationId);
  const stop = await app.request(
    `/api/conversations/${stoppedConversation.id}/generations/${generationId}/stop`,
    { method: "POST", headers },
  );
  assertEquals(stop.status, 202);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stoppedText += decoder.decode(chunk.value, { stream: true });
  }
  assertStringIncludes(stoppedText, "generation.stopped");
  const stoppedDetail = await repo.detail(stoppedConversation.id, owner.id);
  const stoppedAssistant = stoppedDetail.messages.find((message) => message.status === "stopped");
  assertExists(stoppedAssistant);
  assertEquals(
    (stoppedAssistant.metadata.localCitations as Array<{ filename: string }>)[0].filename,
    "ops.txt",
  );
});
