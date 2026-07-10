import { describe, expect, it, vi } from "vitest";
import {
  beginInFlight,
  conversationForFirstSend,
  endInFlight,
  operationForMessage,
  refreshConversationGraph,
} from "./chatWorkflow.ts";
import type { Conversation } from "./types.ts";

const conversation: Conversation = {
  id: "new-id",
  title: "New chat",
  preview: "",
  updatedAt: "now",
  activeLeafId: null,
  version: 0,
};

describe("first message workflow", () => {
  it("creates a conversation instead of loading the empty conversation URL", async () => {
    const load = vi.fn();
    const create = vi.fn().mockResolvedValue(conversation);
    await expect(conversationForFirstSend("", undefined, { load, create })).resolves.toEqual({
      conversation,
      created: true,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
  });
  it("reuses the same operation id when an ambiguous send is retried", () => {
    const createId = vi.fn().mockReturnValueOnce("operation-1").mockReturnValueOnce("operation-2");
    const first = operationForMessage(null, "hello", createId);
    expect(operationForMessage(first, "hello", createId)).toBe(first);
    expect(operationForMessage(first, "different", createId).id).toBe("operation-2");
  });
  it("rejects a second submit synchronously while the first is in flight", () => {
    const lock = { current: false };
    expect(beginInFlight(lock)).toBe(true);
    expect(beginInFlight(lock)).toBe(false);
    endInFlight(lock);
    expect(beginInFlight(lock)).toBe(true);
  });
  it("refreshes conversation metadata and graph nodes together after a conflict", async () => {
    const updated = { ...conversation, version: 8, activeLeafId: "leaf-8" };
    const nodes = [{
      id: "leaf-8",
      role: "assistant" as const,
      content: "latest",
      createdAt: "now",
    }];
    await expect(refreshConversationGraph(conversation.id, {
      load: vi.fn().mockResolvedValue({ conversation: updated, messages: nodes }),
    })).resolves.toEqual({ conversation: updated, messages: nodes });
  });
});
