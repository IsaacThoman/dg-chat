import { describe, expect, it } from "vitest";
import { rebaseConversationTagSelection, sameConversationTagSelection } from "./tagSelection.ts";

describe("conversation tag conflict rebasing", () => {
  it("preserves a concurrently added tag while applying the user's addition", () => {
    expect(rebaseConversationTagSelection(["a"], ["a", "b"], ["a", "c"]))
      .toEqual(["a", "c", "b"]);
  });

  it("applies the user's removal without reverting unrelated concurrent changes", () => {
    expect(rebaseConversationTagSelection(["a", "b"], ["b"], ["a", "b", "c"]))
      .toEqual(["b", "c"]);
  });

  it("compares selections as sets and emits unique rebased IDs", () => {
    expect(sameConversationTagSelection(["a", "b"], ["b", "a"])).toBe(true);
    expect(rebaseConversationTagSelection(["a"], ["a", "b", "b"], ["a", "c", "c"]))
      .toEqual(["a", "c", "b"]);
  });
});
