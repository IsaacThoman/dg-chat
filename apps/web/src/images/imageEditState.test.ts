import { describe, expect, it } from "vitest";
import { imageMaskValidationError, shouldCleanupImageMask } from "./imageEditState.ts";

describe("image edit mask validation", () => {
  it("accepts bounded PNG masks and rejects ambiguous or oversized inputs", () => {
    expect(imageMaskValidationError({ type: "image/png", size: 1024 })).toBeNull();
    expect(imageMaskValidationError({ type: "image/jpeg", size: 1024 })).toContain("PNG");
    expect(imageMaskValidationError({ type: "image/png", size: 25 * 1024 * 1024 + 1 }))
      .toContain("25 MB");
  });
  it("cleans only unconsumed replacement masks across successive edits", () => {
    const consumed = new Set(["mask-a"]);
    expect(shouldCleanupImageMask("mask-a", consumed)).toBe(false);
    expect(shouldCleanupImageMask("mask-b", consumed)).toBe(true);
    consumed.add("mask-b");
    expect(shouldCleanupImageMask("mask-b", consumed)).toBe(false);
    expect(shouldCleanupImageMask(undefined, consumed)).toBe(false);
  });
});
