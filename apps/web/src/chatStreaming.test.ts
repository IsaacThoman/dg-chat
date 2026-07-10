import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatStreamAdapter,
  enqueuePrompt,
  nextQueuedPrompt,
  type QueuedPrompt,
  removeQueuedPrompt,
  retryQueuedPrompt,
  streamTextChunks,
} from "./chatStreaming.ts";

afterEach(() => vi.restoreAllMocks());

const prompt = (id: string): QueuedPrompt => ({
  id,
  content: id,
  model: "model",
  attachmentIds: [],
  mode: "send",
  operationId: `operation-${id}`,
});

const rawConversation = {
  id: "conversation",
  title: "Chat",
  activeLeafId: "assistant",
  version: 2,
  pinned: false,
  archivedAt: null,
  deletedAt: null,
  updatedAt: "2026-07-10T12:00:00.000Z",
};
const rawUser = {
  id: "user",
  parentId: null,
  supersedesId: null,
  siblingIndex: 0,
  role: "user",
  content: "hello",
  model: "model",
  metadata: {},
  createdAt: "2026-07-10T12:00:00.000Z",
};
const rawAssistant = {
  id: "assistant",
  parentId: "user",
  supersedesId: null,
  siblingIndex: 0,
  role: "assistant",
  content: "Hello streaming world",
  model: "model",
  metadata: {},
  createdAt: "2026-07-10T12:00:01.000Z",
};

function eventStream(events: unknown[], splitAt?: number): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n";
  const encoder = new TextEncoder();
  const encoded = encoder.encode(payload);
  const chunks = splitAt === undefined
    ? [encoded]
    : [encoded.slice(0, splitAt), encoded.slice(splitAt)];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

describe("chat stream adapter", () => {
  it("parses split SSE frames into accepted, delta, and one completed result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(eventStream([
      {
        type: "generation.started",
        generationId: "generation",
        sequence: 0,
        user: rawUser,
        conversation: { ...rawConversation, activeLeafId: "user", version: 1 },
      },
      {
        type: "response.text.delta",
        generationId: "generation",
        sequence: 1,
        delta: "Hello streaming ",
      },
      {
        type: "response.text.delta",
        generationId: "generation",
        sequence: 2,
        delta: "world",
      },
      {
        type: "response.reasoning.delta",
        generationId: "generation",
        sequence: 3,
        delta: "Brief reasoning",
      },
      {
        type: "response.tool_call.delta",
        generationId: "generation",
        sequence: 4,
        index: 0,
        id: "call-1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "response.usage",
        generationId: "generation",
        sequence: 5,
        inputTokens: 4,
        cachedInputTokens: 1,
        outputTokens: 3,
        reasoningTokens: 2,
      },
      {
        type: "generation.completed",
        generationId: "generation",
        sequence: 6,
        assistant: rawAssistant,
        conversation: rawConversation,
      },
    ], 17));
    const events = [];
    for await (
      const event of chatStreamAdapter.stream({
        conversation: {
          id: "conversation",
          title: "Chat",
          preview: "",
          updatedAt: "now",
          activeLeafId: null,
          version: 0,
        },
        content: "hello",
        model: "model",
        operationId: "operation",
        attachmentIds: [],
        mode: "send",
      }, new AbortController().signal)
    ) events.push(event);
    expect(events[0]).toMatchObject({ type: "accepted", user: { id: "user" } });
    expect(events.filter((event) => event.type === "delta").map((event) => event.text).join(""))
      .toBe(rawAssistant.content);
    expect(events).toContainEqual({ type: "reasoning", text: "Brief reasoning" });
    expect(events).toContainEqual({
      type: "tool",
      index: 0,
      id: "call-1",
      name: "lookup",
      arguments: "{}",
    });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 4,
      cachedInputTokens: 1,
      outputTokens: 3,
      reasoningTokens: 2,
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      assistant: { id: "assistant", content: rawAssistant.content },
    });
  });

  it("rejects a sequence gap without accepting a corrupt terminal event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(eventStream([
      {
        type: "generation.started",
        generationId: "generation",
        sequence: 0,
        user: rawUser,
        conversation: rawConversation,
      },
      {
        type: "generation.completed",
        generationId: "generation",
        sequence: 2,
        assistant: rawAssistant,
        conversation: rawConversation,
      },
    ]));
    const consume = async () => {
      for await (
        const _event of chatStreamAdapter.stream({
          conversation: {
            id: "conversation",
            title: "Chat",
            preview: "",
            updatedAt: "now",
            activeLeafId: null,
            version: 0,
          },
          content: "hello",
          model: "model",
          operationId: "operation",
          attachmentIds: [],
          mode: "send",
        }, new AbortController().signal)
      ) {
        // Drain the stream.
      }
    };
    await expect(consume()).rejects.toThrow("sequence is invalid");
  });

  it("maps an accepted operation to the stable generation stop endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(eventStream([
        {
          type: "generation.started",
          generationId: "generation-stable",
          sequence: 0,
          user: rawUser,
          conversation: rawConversation,
        },
        {
          type: "generation.stopped",
          generationId: "generation-stable",
          sequence: 1,
          assistant: { ...rawAssistant, content: "partial" },
          conversation: rawConversation,
        },
      ]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const controller = new AbortController();
    const stream = chatStreamAdapter.stream({
      conversation: {
        id: "conversation",
        title: "Chat",
        preview: "",
        updatedAt: "now",
        activeLeafId: null,
        version: 0,
      },
      content: "hello",
      model: "model",
      operationId: "operation-stop",
      attachmentIds: [],
      mode: "send",
    }, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await chatStreamAdapter.stop?.({
      conversationId: "conversation",
      userMessageId: "user",
      operationId: "operation-stop",
    });
    await iterator.return?.();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/conversations/conversation/generations/generation-stable/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("streaming chat queue", () => {
  it("preserves FIFO ordering and supports cancelling a waiting prompt", () => {
    const queue = enqueuePrompt(enqueuePrompt([], prompt("first")), prompt("second"));
    expect(removeQueuedPrompt(queue, "first").map((item) => item.id)).toEqual(["second"]);
    const { next, remaining } = nextQueuedPrompt(queue);
    expect(next?.id).toBe("first");
    expect(remaining.map((item) => item.id)).toEqual(["second"]);
  });

  it("does not mutate the previous queue", () => {
    const original = [prompt("first")];
    expect(enqueuePrompt(original, prompt("second"))).not.toBe(original);
    expect(original).toHaveLength(1);
  });

  it("reconstructs streamed markdown without losing whitespace", () => {
    const markdown = "Hello **world**\n\n- one\n- two";
    expect(streamTextChunks(markdown).join("")).toBe(markdown);
  });

  it("reuses an operation only when the start frame may have been lost", () => {
    const uncertain = { ...prompt("uncertain"), reuseOperationOnRetry: true };
    expect(retryQueuedPrompt(uncertain, () => "new-item")).toMatchObject({
      id: "new-item",
      operationId: uncertain.operationId,
      reuseOperationOnRetry: false,
    });
    const ids = ["new-item", "new-operation"];
    expect(retryQueuedPrompt(prompt("terminal"), () => ids.shift()!)).toMatchObject({
      id: "new-item",
      operationId: "new-operation",
      reuseOperationOnRetry: false,
    });
  });
});
