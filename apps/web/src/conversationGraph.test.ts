import { describe, expect, it } from "vitest";
import {
  activeMessagePath,
  conversationTree,
  messageBranch,
  preferredLeaf,
} from "./conversationGraph.ts";
import type { Message } from "./types.ts";

const node = (
  id: string,
  parentId: string | null,
  siblingIndex: number,
  createdAt: string,
): Message => ({
  id,
  parentId,
  siblingIndex,
  createdAt,
  role: id.startsWith("a") ? "assistant" : "user",
  content: id,
});
const messages = [
  node("u1", null, 0, "2026-01-01T00:00:00Z"),
  node("a1", "u1", 0, "2026-01-01T00:01:00Z"),
  node("u2-original", "a1", 0, "2026-01-01T00:02:00Z"),
  node("a2-original", "u2-original", 0, "2026-01-01T00:03:00Z"),
  node("u2-edit", "a1", 1, "2026-01-01T00:04:00Z"),
  node("a2-edit", "u2-edit", 0, "2026-01-01T00:05:00Z"),
];

describe("immutable conversation graph", () => {
  it("derives only the ancestors of the server active leaf", () => {
    expect(activeMessagePath(messages, "a2-original").map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2-original",
      "a2-original",
    ]);
  });
  it("builds working previous and next sibling targets", () => {
    expect(messageBranch(messages, "u2-original")).toEqual({
      index: 1,
      total: 2,
      previousId: null,
      nextId: "u2-edit",
    });
    expect(messageBranch(messages, "u2-edit")).toEqual({
      index: 2,
      total: 2,
      previousId: "u2-original",
      nextId: null,
    });
  });
  it("selects the newest descendant leaf when entering an existing branch", () => {
    expect(preferredLeaf(messages, "u2-original")).toBe("a2-original");
  });
  it("builds a truthful tree and marks the complete active path", () => {
    const tree = conversationTree(messages, "a2-edit");
    expect(tree).toHaveLength(1);
    expect(tree[0].active).toBe(true);
    expect(tree[0].children[0].children.map((child) => child.message.id)).toEqual([
      "u2-original",
      "u2-edit",
    ]);
    expect(tree[0].children[0].children[0].active).toBe(false);
    expect(tree[0].children[0].children[1].children[0].active).toBe(true);
  });
});
