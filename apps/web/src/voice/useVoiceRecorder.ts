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

export function useVoiceRecorder(model: string, onTranscript: (text: string) => void) {
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef(0);
  const previewUrlRef = useRef<string | undefined>(undefined);

  const stopResources = useCallback(() => {
    if (timerRef.current !== undefined) globalThis.clearInterval(timerRef.current);
    timerRef.current = undefined;
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
    chunksRef.current = [];
    blobRef.current = undefined;
    dispatch({ type: "reset" });
  }, [revokePreview, stopResources]);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(async () => {
    cancel();
    const session = ++sessionRef.current;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      dispatch({ type: "error", message: "Voice input is not supported by this browser." });
      return;
    }
    dispatch({ type: "request" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session !== sessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = supportedMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
        const size = chunksRef.current.reduce((total, chunk) => total + chunk.size, 0);
        if (size > MAX_BYTES && recorder.state === "recording") recorder.stop();
      });
      recorder.addEventListener("error", () => {
        stopResources();
        dispatch({ type: "error", message: "The recording stopped unexpectedly." });
      });
      recorder.addEventListener("stop", () => {
        stopResources();
        if (session !== sessionRef.current) return;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
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
      globalThis.setTimeout(() => {
        if (session === sessionRef.current && recorder.state === "recording") recorder.stop();
      }, MAX_SECONDS * 1_000);
    } catch (error) {
      stopResources();
      if (session === sessionRef.current) {
        dispatch({ type: "error", message: voiceErrorMessage(error) });
      }
    }
  }, [cancel, revokePreview, stopResources]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const transcribe = useCallback(async () => {
    if (!blobRef.current || !model) return;
    const session = sessionRef.current;
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
      if (session !== sessionRef.current) return;
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
  }, [cancel, model, onTranscript]);

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
