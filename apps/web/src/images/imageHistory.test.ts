import { describe, expect, it, vi } from "vitest";
import { imageMutationBelongsToQuery, restoreGeneratedAssetFocus } from "./imageHistory.ts";

describe("image history interaction fences", () => {
  it("restores focus to the originating generated-image preview", () => {
    const focus = vi.fn();
    const querySelector = vi.fn().mockReturnValue({ focus });
    expect(restoreGeneratedAssetFocus({ querySelector }, 'asset-"safe')).toBe(true);
    expect(querySelector).toHaveBeenCalledWith(
      '[data-generated-asset-id="asset-\\"safe"] .generated-image-preview',
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects a mutation result after the active filter query changes", () => {
    expect(imageMutationBelongsToQuery(4, 4)).toBe(true);
    expect(imageMutationBelongsToQuery(4, 5)).toBe(false);
  });
});
