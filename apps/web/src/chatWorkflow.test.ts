import { describe, expect, it, vi } from "vitest";
import { conversationForFirstSend } from "./chatWorkflow.ts";
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
});
