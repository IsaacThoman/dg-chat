import { mapConversation, mapMessage, responseError } from "./api.ts";
import type { Conversation, Message } from "./types.ts";

export type ChatStreamMode = "send" | "regenerate" | "continue";

export interface ChatStreamRequest {
  conversation: Conversation;
  content: string;
  model: string;
  edit?: Message;
  sourceMessageId?: string;
  operationId: string;
  attachmentIds: string[];
  toolExecutionIds?: string[];
  mode: ChatStreamMode;
}

export type ChatStreamEvent =
  | { type: "accepted"; user: Message; assistant: Message; conversation: Conversation }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; index: number; id?: string; name?: string; arguments?: string }
  | {
    type: "usage";
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  }
  | { type: "completed"; user: Message; assistant: Message; conversation: Conversation };

export interface ChatStreamAdapter {
  stream(request: ChatStreamRequest, signal: AbortSignal): AsyncIterable<ChatStreamEvent>;
  stop?(request: {
    conversationId: string;
    userMessageId: string;
    operationId: string;
  }): Promise<void>;
}

export interface QueuedPrompt {
  id: string;
  content: string;
  model: string;
  edit?: Message;
  sourceMessageId?: string;
  attachmentIds: string[];
  toolExecutionIds?: string[];
  mode: ChatStreamMode;
  operationId: string;
  reuseOperationOnRetry?: boolean;
}

export function enqueuePrompt(queue: QueuedPrompt[], item: QueuedPrompt): QueuedPrompt[] {
  return [...queue, item];
}

export function removeQueuedPrompt(queue: QueuedPrompt[], id: string): QueuedPrompt[] {
  return queue.filter((item) => item.id !== id);
}

export function nextQueuedPrompt(queue: QueuedPrompt[]): {
  next?: QueuedPrompt;
  remaining: QueuedPrompt[];
} {
  return { next: queue[0], remaining: queue.slice(1) };
}

export function retryQueuedPrompt(
  item: QueuedPrompt,
  createId: () => string = () => crypto.randomUUID(),
): QueuedPrompt {
  return {
    ...item,
    id: createId(),
    operationId: item.reuseOperationOnRetry ? item.operationId : createId(),
    reuseOperationOnRetry: false,
  };
}

export function streamTextChunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? (text ? [text] : []);
}

type RawMessage = Parameters<typeof mapMessage>[0];
type RawConversation = Parameters<typeof mapConversation>[0];
type RawEvent = {
  type: string;
  generationId: string;
  sequence: number;
  replay?: boolean;
  delta?: string;
  index?: number;
  id?: string;
  name?: string;
  arguments?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  user?: RawMessage;
  assistant?: RawMessage;
  conversation?: RawConversation;
};

const activeGenerationIds = new Map<string, string>();

async function* sseData(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw new Error("Streaming response body is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const boundary = buffer.search(/\r?\n\r?\n/);
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
        buffer = buffer.slice(boundary + separator.length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) yield data;
      }
      if (buffer.length > 2_097_152) throw new Error("Streaming event exceeded the client limit");
      if (done) break;
    }
    if (buffer.trim()) throw new Error("Streaming response ended mid-event");
  } finally {
    await reader.cancel(signal.aborted ? signal.reason : undefined).catch(() => undefined);
    reader.releaseLock();
  }
}

export const chatStreamAdapter: ChatStreamAdapter = {
  async *stream(input, signal) {
    const body = input.mode === "send"
      ? {
        mode: "send",
        content: input.content,
        model: input.model,
        parentId: input.edit ? input.edit.parentId : input.conversation.activeLeafId,
        supersedesId: input.edit?.id ?? null,
        expectedVersion: input.conversation.version ?? 0,
        idempotencyKey: input.operationId,
        attachmentIds: input.attachmentIds,
        toolExecutionIds: input.toolExecutionIds ?? [],
      }
      : {
        mode: input.mode,
        sourceMessageId: input.sourceMessageId,
        model: input.model,
        expectedVersion: input.conversation.version ?? 0,
        idempotencyKey: input.operationId,
      };
    if (input.mode !== "send" && !input.sourceMessageId) {
      throw new Error("A source assistant is required for this generation mode");
    }
    const response = await fetch(`/api/conversations/${input.conversation.id}/generate/stream`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await responseError(response);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new Error("Generation endpoint did not return an event stream");
    }
    let generationId = "";
    let expectedSequence = 0;
    let acceptedUser: Message | undefined;
    let started = false;
    let terminal = false;
    try {
      for await (const data of sseData(response, signal)) {
        if (data === "[DONE]") break;
        if (terminal) throw new Error("Generation stream continued after its terminal event");
        let event: RawEvent;
        try {
          event = JSON.parse(data) as RawEvent;
        } catch {
          throw new Error("Generation stream contained invalid JSON");
        }
        if (
          !Number.isSafeInteger(event.sequence) || event.sequence !== expectedSequence++ ||
          typeof event.generationId !== "string" || !event.generationId
        ) throw new Error("Generation stream sequence is invalid");
        if (generationId && event.generationId !== generationId) {
          throw new Error("Generation stream identity changed");
        }
        generationId ||= event.generationId;
        activeGenerationIds.set(input.operationId, generationId);
        if (event.type === "generation.started") {
          if (started || event.sequence !== 0) {
            throw new Error("Generation stream start is invalid");
          }
          if (!event.user || !event.conversation) throw new Error("Generation start is incomplete");
          started = true;
          acceptedUser = mapMessage(event.user);
          yield {
            type: "accepted",
            user: acceptedUser,
            assistant: {
              id: `draft-${generationId}`,
              parentId: acceptedUser.id,
              role: "assistant",
              content: "",
              model: input.model,
              createdAt: "",
            },
            conversation: mapConversation(event.conversation),
          };
        } else if (
          event.type === "response.text.delta" || event.type === "response.refusal.delta"
        ) {
          if (!started) throw new Error("Generation stream delta arrived before start");
          if (typeof event.delta !== "string") throw new Error("Generation delta is invalid");
          yield { type: "delta", text: event.delta };
        } else if (event.type === "response.reasoning.delta") {
          if (!started || typeof event.delta !== "string") {
            throw new Error("Generation reasoning delta is invalid");
          }
          yield { type: "reasoning", text: event.delta };
        } else if (event.type === "response.tool_call.delta") {
          if (!started || !Number.isSafeInteger(event.index)) {
            throw new Error("Generation tool delta is invalid");
          }
          yield {
            type: "tool",
            index: event.index!,
            ...(event.id ? { id: event.id } : {}),
            ...(event.name ? { name: event.name } : {}),
            ...(event.arguments ? { arguments: event.arguments } : {}),
          };
        } else if (event.type === "response.usage") {
          const usage = [
            event.inputTokens,
            event.cachedInputTokens,
            event.outputTokens,
            event.reasoningTokens,
          ];
          if (!started || usage.some((value) => !Number.isSafeInteger(value) || value! < 0)) {
            throw new Error("Generation usage is invalid");
          }
          yield {
            type: "usage",
            inputTokens: event.inputTokens!,
            cachedInputTokens: event.cachedInputTokens!,
            outputTokens: event.outputTokens!,
            reasoningTokens: event.reasoningTokens!,
          };
        } else if (
          event.type === "generation.completed" || event.type === "generation.stopped" ||
          event.type === "generation.error"
        ) {
          if (!started || !acceptedUser || !event.assistant || !event.conversation) {
            throw new Error("Generation terminal event is incomplete");
          }
          terminal = true;
          yield {
            type: "completed",
            user: acceptedUser,
            assistant: mapMessage(event.assistant),
            conversation: mapConversation(event.conversation),
          };
          if (event.type === "generation.error") {
            throw new Error("Generation failed. Retry to create a new branch.");
          }
        }
      }
      if (!terminal) throw new Error("Generation stream ended without a terminal event");
    } finally {
      activeGenerationIds.delete(input.operationId);
    }
  },
  async stop(input) {
    const generationId = activeGenerationIds.get(input.operationId);
    if (!generationId) throw new Error("Generation has not been accepted yet");
    const response = await fetch(
      `/api/conversations/${input.conversationId}/generations/${generationId}/stop`,
      { method: "POST", credentials: "include", headers: { "content-type": "application/json" } },
    );
    if (!response.ok) throw await responseError(response);
  },
};
