import { describe, expect, it } from "vitest";
import { branchControlLabels } from "./branchControlA11y.ts";

describe("branchControlLabels", () => {
  it("gives every control and status an owning message", () => {
    expect(branchControlLabels("assistant", 2, 2, 3)).toEqual({
      group: "Branch navigation for assistant message 2",
      status: "Branch position for assistant message 2: 2 of 3",
      previous: "Previous branch for assistant message 2",
      next: "Next branch for assistant message 2",
      tree: "View conversation tree from assistant message 2",
    });
  });

  it("distinguishes controls belonging to separate branched turns", () => {
    const earlier = branchControlLabels("assistant", 2, 1, 2);
    const later = branchControlLabels("user", 3, 2, 2);

    expect(earlier.group).not.toBe(later.group);
    expect(earlier.previous).not.toBe(later.previous);
    expect(earlier.status).toContain("assistant message 2");
    expect(later.status).toContain("user message 3");
  });
});
