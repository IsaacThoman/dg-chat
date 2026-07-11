import { describe, expect, it } from "vitest";
import { imageGenerationReducer, initialImageGenerationState } from "./imageGenerationState.ts";
import type { GeneratedAsset } from "./types.ts";

const asset = {
  id: "a",
  attachmentId: "att",
  contentUrl: "/content",
  sourceAttachmentIds: [],
  operation: "generation",
  prompt: "p",
  model: "m",
  width: 1,
  height: 1,
  mimeType: "image/png",
  sizeBytes: 1,
  status: "ready",
  createdAt: "2026-01-01T00:00:00Z",
} satisfies GeneratedAsset;

describe("imageGenerationReducer", () => {
  it("preserves durable prior results while retrying and cancelling", () => {
    const success = imageGenerationReducer(initialImageGenerationState, {
      type: "succeed",
      assets: [asset],
    });
    const submitting = imageGenerationReducer(success, { type: "submit", operation: "edit" });
    expect(submitting).toMatchObject({ phase: "submitting", operation: "edit", assets: [asset] });
    expect(imageGenerationReducer(submitting, { type: "cancel" })).toMatchObject({
      phase: "cancelled",
      assets: [asset],
    });
  });
  it("clears stale errors on submit and reset", () => {
    const failed = imageGenerationReducer(initialImageGenerationState, {
      type: "fail",
      error: "No credit",
    });
    expect(imageGenerationReducer(failed, { type: "submit", operation: "generation" }).error)
      .toBeNull();
    expect(imageGenerationReducer(failed, { type: "reset" })).toEqual(initialImageGenerationState);
  });
});
