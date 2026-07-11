import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorder } from "./VoiceRecorder.tsx";

describe("VoiceRecorder", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("explains when no transcription model is available", () => {
    const markup = renderToStaticMarkup(<VoiceRecorder onTranscript={() => undefined} />);
    expect(markup).toContain("Voice input unavailable: no transcription model");
    expect(markup).toContain("disabled");
  });

  it("offers voice input when a transcription model is configured", () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => Promise.resolve() } });
    vi.stubGlobal("MediaRecorder", class {});
    const markup = renderToStaticMarkup(
      <VoiceRecorder model="provider/transcribe" onTranscript={() => undefined} />,
    );
    expect(markup).toContain("Start voice input");
    expect(markup).not.toContain("disabled");
  });
});
