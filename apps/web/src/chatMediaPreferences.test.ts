import { describe, expect, it } from "vitest";
import { availableMediaModel, isSpeechVoice } from "./chatMediaPreferences.ts";
import type { Model } from "./types.ts";

const models: Model[] = [
  {
    id: "media/speech-one",
    name: "Speech one",
    provider: "media",
    context: "1K",
    capabilities: ["speech"],
    healthy: true,
  },
  {
    id: "media/speech-two",
    name: "Speech two",
    provider: "media",
    context: "1K",
    capabilities: ["speech"],
    healthy: true,
  },
  {
    id: "media/transcription",
    name: "Transcription",
    provider: "media",
    context: "1K",
    capabilities: ["transcription"],
    healthy: true,
  },
];

describe("shared chat media preferences", () => {
  it("preserves stored selections until discovery resolves and then validates them globally", () => {
    expect(availableMediaModel([], "speech", "stored/speech")).toBe("stored/speech");
    expect(availableMediaModel(models, "speech", "media/speech-two")).toBe("media/speech-two");
    expect(availableMediaModel(models, "speech", "removed/speech")).toBe("media/speech-one");
    expect(availableMediaModel(models, "transcription", "media/speech-two"))
      .toBe("media/transcription");
  });

  it("accepts only supported speech voices", () => {
    expect(isSpeechVoice("coral")).toBe(true);
    expect(isSpeechVoice("not-a-voice")).toBe(false);
  });
});
