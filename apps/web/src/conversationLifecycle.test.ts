import { describe, expect, it } from "vitest";
import {
  conversationsForView,
  fallbackConversationId,
  mergeConversationSnapshot,
} from "./conversationLifecycle.ts";
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
  it("publishes newer graph versions without regressing concurrent metadata", () => {
    const current = conversation("chat", {
      title: "Renamed elsewhere",
      archived: true,
      version: 8,
    });
    const stale = conversation("chat", { title: "Old title", archived: false, version: 7 });
    const fresh = conversation("chat", { title: "Fresh title", archived: false, version: 9 });

    expect(mergeConversationSnapshot([current], stale)).toEqual([current]);
    expect(mergeConversationSnapshot([current], fresh)).toEqual([fresh]);
    expect(mergeConversationSnapshot(undefined, fresh)).toBeUndefined();
  });
});
