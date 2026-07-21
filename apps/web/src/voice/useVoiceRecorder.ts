import { useCallback, useEffect, useReducer, useRef } from "react";
import { transcribeAudio } from "../audioApi.ts";
import { initialVoiceState, voiceErrorMessage, voiceReducer } from "./voiceState.ts";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const MAX_SECONDS = 300;
const MAX_BYTES = 25 * 1024 * 1024;

function supportedMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported?.(mime));
}

export function createVoiceRecorderEventGate(
  isCurrent: () => boolean,
  invalidate: () => void,
) {
  let terminal = false;
  const acceptsEvent = () => !terminal && isCurrent();
  return {
    acceptsEvent,
    finish: () => {
      if (!acceptsEvent()) return false;
      terminal = true;
      return true;
    },
    fail: () => {
      if (!acceptsEvent()) return false;
      terminal = true;
      invalidate();
      return true;
    },
  };
}

export function cancelInactiveVoiceSession(active: boolean, cancel: () => void): void {
  if (!active) cancel();
}

export function isVoiceTargetCurrent(expected: string, current: string): boolean {
  return expected === current;
}

export function handleVoicePermissionFailure(
  session: number,
  currentSession: () => number,
  stopCurrentResources: () => void,
  reportCurrentFailure: () => void,
): boolean {
  // Permission requests cannot be aborted in every browser. An older request may
  // therefore reject after a newer request has already installed its stream.
  // Only the request that still owns the session may touch shared resources.
  if (session !== currentSession()) return false;
  stopCurrentResources();
  reportCurrentFailure();
  return true;
}

export function clearVoiceRecordingBuffers<TRecorder>(refs: {
  recorder: { current: TRecorder | undefined };
  chunks: { current: Blob[] };
  blob: { current: Blob | undefined };
}): void {
  refs.recorder.current = undefined;
  refs.chunks.current = [];
  refs.blob.current = undefined;
}

export function finalizeVoiceRecording<TRecorder>(
  refs: {
    recorder: { current: TRecorder | undefined };
    chunks: { current: Blob[] };
    blob: { current: Blob | undefined };
  },
  mimeType: string,
): Blob {
  const blob = new Blob(refs.chunks.current, { type: mimeType });
  clearVoiceRecordingBuffers(refs);
  return blob;
}

export function useVoiceRecorder(
  model: string,
  onTranscript: (text: string) => void,
  active = true,
  targetKey = "",
) {
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef(0);
  const previewUrlRef = useRef<string | undefined>(undefined);
  // This ref is assigned during render, rather than in an effect, so a transcription which
  // resolves in the same task as a conversation/branch/edit transition is still rejected.
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  const previousTargetKeyRef = useRef(targetKey);

  const clearRecordingBuffers = useCallback(() => {
    clearVoiceRecordingBuffers({
      recorder: recorderRef,
      chunks: chunksRef,
      blob: blobRef,
    });
  }, []);

  const stopResources = useCallback(() => {
    if (timerRef.current !== undefined) globalThis.clearInterval(timerRef.current);
    timerRef.current = undefined;
    if (stopTimeoutRef.current !== undefined) globalThis.clearTimeout(stopTimeoutRef.current);
    stopTimeoutRef.current = undefined;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = undefined;
  }, []);

  const revokePreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = undefined;
  }, []);

  const cancel = useCallback(() => {
    sessionRef.current++;
    abortRef.current?.abort();
    abortRef.current = undefined;
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    if (recorder?.state === "recording") recorder.stop();
    stopResources();
    revokePreview();
    clearRecordingBuffers();
    dispatch({ type: "reset" });
  }, [clearRecordingBuffers, revokePreview, stopResources]);

  useEffect(() => cancel, [cancel]);
  useEffect(() => cancelInactiveVoiceSession(active, cancel), [active, cancel]);
  useEffect(() => {
    if (previousTargetKeyRef.current === targetKey) return;
    previousTargetKeyRef.current = targetKey;
    cancel();
  }, [cancel, targetKey]);

  const start = useCallback(async () => {
    if (!active) return;
    cancel();
    const session = ++sessionRef.current;
    const target = targetKeyRef.current;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      dispatch({ type: "error", message: "Voice input is not supported by this browser." });
      return;
    }
    dispatch({ type: "request" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (
        session !== sessionRef.current ||
        !isVoiceTargetCurrent(target, targetKeyRef.current)
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = supportedMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      const events = createVoiceRecorderEventGate(
        () =>
          session === sessionRef.current &&
          isVoiceTargetCurrent(target, targetKeyRef.current),
        () => sessionRef.current++,
      );
      recorder.addEventListener("dataavailable", (event) => {
        if (!events.acceptsEvent()) return;
        if (event.data.size) chunksRef.current.push(event.data);
        const size = chunksRef.current.reduce((total, chunk) => total + chunk.size, 0);
        if (size > MAX_BYTES && recorder.state === "recording") recorder.stop();
      });
      recorder.addEventListener("error", () => {
        if (!events.fail()) return;
        try {
          if (recorder.state === "recording") recorder.stop();
        } catch {
          // Some browsers already transition an errored recorder to an unusable state.
        }
        stopResources();
        revokePreview();
        clearRecordingBuffers();
        dispatch({ type: "error", message: "The recording stopped unexpectedly." });
      });
      recorder.addEventListener("stop", () => {
        if (!events.finish()) return;
        stopResources();
        // A stopped recorder and its individual chunks are no longer useful.
        // Clear them before either terminal branch so invalid recordings cannot
        // retain a prior blob or a potentially oversized chunk allocation.
        const blob = finalizeVoiceRecording(
          { recorder: recorderRef, chunks: chunksRef, blob: blobRef },
          recorder.mimeType || "audio/webm",
        );
        if (!blob.size || blob.size > MAX_BYTES) {
          dispatch({
            type: "error",
            message: blob.size
              ? "The recording is too large. Record a shorter message."
              : "No audio was captured.",
          });
          return;
        }
        blobRef.current = blob;
        revokePreview();
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        dispatch({ type: "preview", previewUrl: url });
      });
      stream.getTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (recorder.state === "recording") recorder.stop();
        })
      );
      recorder.start(1_000);
      dispatch({ type: "recording" });
      timerRef.current = globalThis.setInterval(() => dispatch({ type: "tick" }), 1_000);
      stopTimeoutRef.current = globalThis.setTimeout(() => {
        stopTimeoutRef.current = undefined;
        if (session === sessionRef.current && recorder.state === "recording") recorder.stop();
      }, MAX_SECONDS * 1_000);
    } catch (error) {
      handleVoicePermissionFailure(
        session,
        () => sessionRef.current,
        stopResources,
        () => {
          dispatch({ type: "error", message: voiceErrorMessage(error) });
        },
      );
    }
  }, [active, cancel, clearRecordingBuffers, revokePreview, stopResources]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const transcribe = useCallback(async () => {
    if (!active || !blobRef.current || !model) return;
    const session = sessionRef.current;
    const target = targetKeyRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "transcribing" });
    try {
      const text = await transcribeAudio({
        audio: blobRef.current,
        model,
        signal: controller.signal,
      });
      if (
        session !== sessionRef.current ||
        !isVoiceTargetCurrent(target, targetKeyRef.current)
      ) return;
      if (!text) {
        dispatch({
          type: "error",
          message: "No speech was detected. Try recording again.",
          keepPreview: true,
        });
        return;
      }
      onTranscript(text);
      cancel();
    } catch (error) {
      if (controller.signal.aborted || session !== sessionRef.current) return;
      dispatch({ type: "error", message: voiceErrorMessage(error), keepPreview: true });
    }
  }, [active, cancel, model, onTranscript]);

  const browserSupported = typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
  return {
    state,
    supported: Boolean(model) && browserSupported,
    unavailableReason: !model
      ? "no transcription model is configured"
      : !browserSupported
      ? "voice recording is not supported by this browser"
      : undefined,
    start,
    stop,
    cancel,
    transcribe,
  };
}
