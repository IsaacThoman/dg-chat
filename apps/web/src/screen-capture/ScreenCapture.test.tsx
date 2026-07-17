import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenCapture } from "./ScreenCapture.tsx";

describe("ScreenCapture capability controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains that capture is unavailable for a non-vision model", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn() },
    });
    const markup = renderToStaticMarkup(
      <ScreenCapture visionCapable={false} targetKey="chat:leaf:model" onCapture={() => {}} />,
    );
    expect(markup).toContain(
      "Capture screen unavailable: the selected model does not support images",
    );
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("tool-pill-explanation");
    expect(markup).not.toMatch(/<button[^>]+disabled=""/u);
  });

  it("offers capture for a vision model in a supporting browser", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn() },
    });
    const markup = renderToStaticMarkup(
      <ScreenCapture visionCapable targetKey="chat:leaf:model" onCapture={() => {}} />,
    );
    expect(markup).toContain('aria-label="Capture screen"');
    expect(markup).not.toContain(
      "Capture screen unavailable: screen sharing is not supported by this browser",
    );
  });

  it("names browser support failure without exposing a dead control", () => {
    vi.stubGlobal("navigator", { mediaDevices: {} });
    const markup = renderToStaticMarkup(
      <ScreenCapture visionCapable targetKey="chat:leaf:model" onCapture={() => {}} />,
    );
    expect(markup).toContain(
      "Capture screen unavailable: screen sharing is not supported by this browser",
    );
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("tool-pill-explanation");
  });

  it("does not allow a supporting vision capture while its composer is disabled", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn() },
    });
    const markup = renderToStaticMarkup(
      <ScreenCapture
        visionCapable
        disabled
        targetKey="chat:leaf:model"
        onCapture={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Capture screen"');
    expect(markup).toContain("disabled");
  });
});
