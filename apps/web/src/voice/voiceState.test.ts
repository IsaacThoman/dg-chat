import { describe, expect, it } from "vitest";
import { initialVoiceState, insertTranscript, voiceReducer } from "./voiceState.ts";

describe("voice state", () => {
  it("moves through permission, recording, preview, and transcription", () => {
    let state = voiceReducer(initialVoiceState, { type: "request" });
    expect(state.phase).toBe("requesting_permission");
    state = voiceReducer(state, { type: "recording" });
    state = voiceReducer(state, { type: "tick" });
    expect(state.elapsedSeconds).toBe(1);
    state = voiceReducer(state, { type: "preview", previewUrl: "blob:test" });
    expect(state).toMatchObject({ phase: "preview", previewUrl: "blob:test" });
    state = voiceReducer(state, { type: "transcribing" });
    expect(state.phase).toBe("transcribing");
  });

  it("keeps a preview for a retryable transcription error", () => {
    const state = voiceReducer(
      { phase: "transcribing", elapsedSeconds: 2, previewUrl: "blob:test" },
      { type: "error", message: "Try again", keepPreview: true },
    );
    expect(state).toMatchObject({ phase: "error", previewUrl: "blob:test", error: "Try again" });
  });
});

describe("transcript insertion", () => {
  it("inserts at the current selection without replacing the draft", () => {
    expect(insertTranscript("hello world", "new words", 6, 11)).toEqual({
      value: "hello new words",
      caret: 15,
    });
  });
  it("adds readable spacing and preserves following text", () => {
    expect(insertTranscript("beforeafter", "middle", 6, 6)).toEqual({
      value: "before middle after",
      caret: 13,
    });
  });
  it("does nothing for an empty transcript", () => {
    expect(insertTranscript("draft", "  ", 2, 2)).toEqual({ value: "draft", caret: 2 });
  });
});
