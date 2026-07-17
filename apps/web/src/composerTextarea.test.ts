import { describe, expect, it } from "vitest";
import { COMPOSER_TEXTAREA_MAX_HEIGHT, composerTextareaDimensions } from "./composerTextarea.ts";

describe("composer textarea sizing", () => {
  it("grows with content and shrinks back to the minimum", () => {
    expect(composerTextareaDimensions(92, 900)).toEqual({ height: 92, overflowY: "hidden" });
    expect(composerTextareaDimensions(12, 900)).toEqual({ height: 34, overflowY: "hidden" });
  });

  it("bounds long drafts and restores overflow scrolling", () => {
    expect(composerTextareaDimensions(900, 900)).toEqual({
      height: COMPOSER_TEXTAREA_MAX_HEIGHT,
      overflowY: "auto",
    });
  });

  it("uses a smaller cap in a short mobile or landscape viewport", () => {
    expect(composerTextareaDimensions(900, 320)).toEqual({ height: 102, overflowY: "auto" });
  });
});
