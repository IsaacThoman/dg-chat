import { describe, expect, it, vi } from "vitest";
import {
  boundedCaptureDimensions,
  chatScreenCaptureTargetKey,
  SCREEN_CAPTURE_MAX_DIMENSION,
  SCREEN_CAPTURE_MAX_PIXELS,
  screenCaptureErrorMessage,
  screenCaptureResultIsUsable,
  stopDisplayStream,
} from "./captureDisplay.ts";

describe("screen capture safety", () => {
  it("preserves aspect ratio while bounding dimensions and decoded pixels", () => {
    expect(boundedCaptureDimensions(1_920, 1_080)).toEqual({ width: 1_920, height: 1_080 });
    const huge = boundedCaptureDimensions(16_000, 9_000);
    expect(huge.width).toBeLessThanOrEqual(SCREEN_CAPTURE_MAX_DIMENSION);
    expect(huge.height).toBeLessThanOrEqual(SCREEN_CAPTURE_MAX_DIMENSION);
    expect(huge.width * huge.height).toBeLessThanOrEqual(SCREEN_CAPTURE_MAX_PIXELS);
    expect(huge.width / huge.height).toBeCloseTo(16 / 9, 2);
  });

  it("rejects missing and non-finite frame dimensions", () => {
    expect(() => boundedCaptureDimensions(0, 1_080)).toThrow("usable video frame");
    expect(() => boundedCaptureDimensions(Number.POSITIVE_INFINITY, 1_080)).toThrow(
      "usable video frame",
    );
    expect(() => boundedCaptureDimensions(1_920, 1_080, 0)).toThrow("usable video frame");
    expect(() => boundedCaptureDimensions(1_920, 1_080, 1.01)).toThrow("usable video frame");
  });

  it("never rounds an exact pixel-boundary calculation over the ceiling", () => {
    expect(boundedCaptureDimensions(7_999, 8_001)).toEqual({ width: 3_999, height: 4_000 });
    for (let width = 1; width <= 20_000; width += 137) {
      for (let height = 1; height <= 20_000; height += 263) {
        const bounded = boundedCaptureDimensions(width, height);
        expect(bounded.width).toBeGreaterThan(0);
        expect(bounded.height).toBeGreaterThan(0);
        expect(bounded.width).toBeLessThanOrEqual(SCREEN_CAPTURE_MAX_DIMENSION);
        expect(bounded.height).toBeLessThanOrEqual(SCREEN_CAPTURE_MAX_DIMENSION);
        expect(bounded.width * bounded.height).toBeLessThanOrEqual(SCREEN_CAPTURE_MAX_PIXELS);
      }
    }
  });

  it("accepts a preview only for the current eligible capture target", () => {
    expect(screenCaptureResultIsUsable("chat:model-a", "chat:model-a", true)).toBe(true);
    expect(screenCaptureResultIsUsable("chat:model-a", "chat:model-b", true)).toBe(false);
    expect(screenCaptureResultIsUsable("chat:model-a", "chat:model-a", false)).toBe(false);
    expect(
      screenCaptureResultIsUsable(
        "chat:leaf-a:model-a",
        "chat:leaf-b:model-a",
        true,
        "chat:leaf-a:model-a",
      ),
    ).toBe(false);
    expect(
      screenCaptureResultIsUsable(
        "chat:leaf-a:model-a",
        "chat:leaf-a:model-a",
        true,
        "chat:leaf-a:model-b",
      ),
    ).toBe(false);
  });

  it("binds capture ownership to chat model and vision capability, not voice preferences", () => {
    const common = {
      sessionActive: true,
      conversationId: "chat:with:delimiters",
      leafId: "leaf",
      editId: null,
    };
    const visionA = chatScreenCaptureTargetKey({
      ...common,
      selectedModelId: "provider/model-a",
      visionCapable: true,
    });
    expect(chatScreenCaptureTargetKey({
      ...common,
      selectedModelId: "provider/model-b",
      visionCapable: true,
    })).not.toBe(visionA);
    expect(chatScreenCaptureTargetKey({
      ...common,
      selectedModelId: "provider/model-a",
      visionCapable: false,
    })).not.toBe(visionA);
  });

  it("stops every display track even when one track throws", () => {
    const first = vi.fn(() => {
      throw new Error("already ended");
    });
    const second = vi.fn();
    stopDisplayStream({
      getTracks: () => [{ stop: first }, { stop: second }] as unknown as MediaStreamTrack[],
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("gives permission, cancellation, and device failures actionable copy", () => {
    expect(screenCaptureErrorMessage(new DOMException("", "NotAllowedError"))).toContain(
      "cancelled or denied",
    );
    expect(screenCaptureErrorMessage(new DOMException("", "NotFoundError"))).toContain(
      "No screen or window",
    );
    expect(screenCaptureErrorMessage(new DOMException("", "NotReadableError"))).toContain(
      "Close other capture tools",
    );
    expect(screenCaptureErrorMessage(new DOMException("", "AbortError"))).toBe(
      "Screen capture was cancelled.",
    );
  });
});
