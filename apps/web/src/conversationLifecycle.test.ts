import { describe, expect, it } from "vitest";
import { conversationsForView, fallbackConversationId } from "./conversationLifecycle.ts";
import type { Conversation } from "./types.ts";

const conversation = (id: string, state: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  preview: "",
  updatedAt: "now",
  ...state,
});
const all = [
  conversation("chat"),
  conversation("archived", { archived: true }),
  conversation("trash", { deleted: true }),
];

describe("conversation lifecycle lists", () => {
  it("keeps active, archived, and deleted conversations in distinct views", () => {
    expect(conversationsForView(all, "chat").map((item) => item.id)).toEqual(["chat"]);
    expect(conversationsForView(all, "archived").map((item) => item.id)).toEqual(["archived"]);
    expect(conversationsForView(all, "trash").map((item) => item.id)).toEqual(["trash"]);
  });
  it("chooses the next visible conversation after a lifecycle mutation", () => {
    expect(fallbackConversationId([conversation("first"), conversation("second")], "chat", "first"))
      .toBe("second");
    expect(fallbackConversationId([conversation("only")], "chat", "only")).toBe("");
  });
});
