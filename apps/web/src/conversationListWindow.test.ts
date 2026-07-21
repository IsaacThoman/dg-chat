import { describe, expect, it } from "vitest";
import type { Conversation } from "./types.ts";
import { conversationListWindow } from "./conversationListWindow.ts";

function conversation(id: string, pinned = false): Conversation {
  return {
    id,
    title: id,
    preview: "",
    activeLeafId: null,
    version: 1,
    pinned,
    archived: false,
    deleted: false,
    updatedAt: id,
  };
}

describe("conversationListWindow", () => {
  it("prioritizes pinned chats while preserving stable server order", () => {
    const source = [conversation("new"), conversation("pinned-old", true), conversation("old")];
    expect(conversationListWindow(source, 2, new Set()).conversations.map((item) => item.id))
      .toEqual(["new", "pinned-old"]);
  });

  it("keeps active and unfinished chats outside the recency window", () => {
    const source = [conversation("one"), conversation("two"), conversation("protected")];
    expect(conversationListWindow(source, 1, new Set(["protected"]))).toEqual({
      conversations: [source[0], source[2]],
      hiddenCount: 1,
    });
  });

  it("expands deterministically and rejects invalid limits", () => {
    const source = Array.from({ length: 5 }, (_, index) => conversation(String(index)));
    expect(conversationListWindow(source, 2, new Set()).hiddenCount).toBe(3);
    expect(conversationListWindow(source, 4, new Set()).conversations).toHaveLength(4);
    expect(() => conversationListWindow(source, 0, new Set())).toThrow(RangeError);
  });
});
