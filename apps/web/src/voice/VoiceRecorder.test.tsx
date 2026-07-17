import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorder } from "./VoiceRecorder.tsx";
import {
  cancelInactiveVoiceSession,
  createVoiceRecorderEventGate,
  finalizeVoiceRecording,
  handleVoicePermissionFailure,
  isVoiceTargetCurrent,
} from "./useVoiceRecorder.ts";

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

  it("cancels microphone and transcription work when its retained session becomes inactive", () => {
    const cancel = vi.fn();
    cancelInactiveVoiceSession(true, cancel);
    expect(cancel).not.toHaveBeenCalled();
    cancelInactiveVoiceSession(false, cancel);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts a transcript only for the conversation, branch, and edit that started it", () => {
    expect(isVoiceTargetCurrent("chat-1:leaf-1:edit-1", "chat-1:leaf-1:edit-1")).toBe(true);
    expect(isVoiceTargetCurrent("chat-1:leaf-1:edit-1", "chat-2:leaf-2:")).toBe(false);
    expect(isVoiceTargetCurrent("chat-1:leaf-1:", "chat-1:leaf-2:")).toBe(false);
    expect(isVoiceTargetCurrent("chat-1:leaf-1:edit-1", "chat-1:leaf-1:")).toBe(false);
  });

  it("treats recorder errors as terminal before final data and stop events arrive", () => {
    let current = true;
    const invalidate = vi.fn(() => {
      current = false;
    });
    const gate = createVoiceRecorderEventGate(() => current, invalidate);
    const accepted: string[] = [];
    const recorder = new EventTarget();
    recorder.addEventListener("error", () => {
      if (gate.fail()) accepted.push("error");
    });
    recorder.addEventListener("dataavailable", () => {
      if (gate.acceptsEvent()) accepted.push("dataavailable");
    });
    recorder.addEventListener("stop", () => {
      if (gate.finish()) accepted.push("stop");
    });

    recorder.dispatchEvent(new Event("error"));
    recorder.dispatchEvent(new Event("dataavailable"));
    recorder.dispatchEvent(new Event("stop"));

    expect(accepted).toEqual(["error"]);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("does not let a stale rejected permission request stop a newer resolved stream", () => {
    const oldSession = 1;
    const newSession = 2;
    const newerTrack = { stop: vi.fn() };
    const reportFailure = vi.fn();
    let currentSession = newSession;

    // Request A is still waiting when request B becomes current and resolves.
    // A then rejects; its failure handler must not touch B's installed track.
    const handledOldFailure = handleVoicePermissionFailure(
      oldSession,
      () => currentSession,
      () => newerTrack.stop(),
      reportFailure,
    );

    expect(handledOldFailure).toBe(false);
    expect(newerTrack.stop).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();

    // The same handler still cleans up when the failure belongs to the current
    // request, proving the ownership guard is not merely suppressing failures.
    currentSession = newSession;
    const handledCurrentFailure = handleVoicePermissionFailure(
      newSession,
      () => currentSession,
      () => newerTrack.stop(),
      reportFailure,
    );
    expect(handledCurrentFailure).toBe(true);
    expect(newerTrack.stop).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty", []],
    ["oversized", [new Blob([new Uint8Array(25 * 1024 * 1024 + 1)])]],
  ])("clears recorder, chunks, and a prior blob after an %s recording stops", (_, chunks) => {
    const recorder = { state: "inactive" };
    const priorBlob = new Blob(["previous recording"]);
    const refs = {
      recorder: { current: recorder as typeof recorder | undefined },
      chunks: { current: chunks },
      blob: { current: priorBlob as Blob | undefined },
    };

    const finalized = finalizeVoiceRecording(refs, "audio/webm");

    expect(finalized.size).toBe(chunks.reduce((total, chunk) => total + chunk.size, 0));
    expect(refs.recorder.current).toBeUndefined();
    expect(refs.chunks.current).toEqual([]);
    expect(refs.blob.current).toBeUndefined();
  });
});
