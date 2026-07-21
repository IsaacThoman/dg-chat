import { describe, expect, it } from "vitest";
import { conversationTimestampLabel } from "./conversationTimestamp.ts";

describe("conversation timestamp presentation", () => {
  it("localizes a canonical timestamp only at presentation time", () => {
    expect(
      conversationTimestampLabel(
        { updatedAt: "2026-07-15T10:00:00.000Z" },
        "en-US",
      ),
    ).toContain("2026");
  });

  it("supports intentional demo copy without changing the canonical timestamp", () => {
    expect(
      conversationTimestampLabel({
        updatedAt: "2026-07-15T10:00:00.000Z",
        updatedAtLabel: "Now",
      }),
    ).toBe("Now");
  });

  it("keeps legacy mock labels readable", () => {
    expect(conversationTimestampLabel({ updatedAt: "now" })).toBe("now");
  });
});
