import { useContext, useEffect, useRef } from "react";
import { Mic, RotateCcw, Square, X } from "lucide-react";
import { ChatSessionActivityContext } from "../chatSessionActivity.ts";
import { useVoiceRecorder } from "./useVoiceRecorder.ts";

function duration(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceRecorder(
  { model, disabled, targetKey, onTranscript, onBusyChange }: {
    model?: string;
    disabled?: boolean;
    targetKey?: string;
    onTranscript: (text: string) => void;
    onBusyChange?: (busy: boolean) => void;
  },
) {
  const sessionActive = useContext(ChatSessionActivityContext);
  const voice = useVoiceRecorder(model ?? "", onTranscript, sessionActive, targetKey);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const phaseActionRef = useRef<HTMLButtonElement>(null);
  const { state } = voice;
  const idle = state.phase === "idle";
  useEffect(() => {
    onBusyChange?.(!idle);
  }, [idle, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    if (idle || !sessionActive) return;
    const frame = requestAnimationFrame(() => phaseActionRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [idle, sessionActive, state.phase]);
  const cancelAndFocus = () => {
    voice.cancel();
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  return (
    <div className="voice-input">
      {idle
        ? (
          <button
            ref={triggerRef}
            type="button"
            className="icon-button"
            aria-label={voice.supported
              ? "Start voice input"
              : `Voice input unavailable: ${voice.unavailableReason}`}
            title={voice.supported
              ? "Start voice input"
              : `Voice input unavailable: ${voice.unavailableReason}`}
            disabled={disabled || !voice.supported}
            onClick={voice.start}
          >
            <Mic size={19} />
          </button>
        )
        : (
          <div
            className="voice-panel"
            aria-label="Voice input"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelAndFocus();
              }
            }}
          >
            <div className="voice-status" role="status" aria-live="polite">
              {state.phase === "requesting_permission" && (
                <span>Waiting for microphone permission…</span>
              )}
              {state.phase === "recording" && (
                <span>
                  <i className="recording-dot" /> Recording{" "}
                  <b aria-hidden="true">
                    {duration(state.elapsedSeconds)}
                  </b>
                </span>
              )}
              {state.phase === "preview" && <span>Recording ready</span>}
              {state.phase === "transcribing" && <span>Transcribing…</span>}
            </div>
            {state.previewUrl && <audio controls src={state.previewUrl}>Audio preview</audio>}
            {state.error && <p role="alert">{state.error}</p>}
            <div className="voice-actions">
              {state.phase === "recording" && (
                <button
                  ref={phaseActionRef}
                  type="button"
                  className="secondary"
                  onClick={voice.stop}
                >
                  <Square size={14} /> Stop
                </button>
              )}
              {(state.phase === "preview" || (state.phase === "error" && state.previewUrl)) && (
                <>
                  <button type="button" className="secondary" onClick={voice.start}>
                    <RotateCcw size={14} /> Re-record
                  </button>
                  <button
                    ref={phaseActionRef}
                    type="button"
                    className="primary"
                    onClick={voice.transcribe}
                  >
                    Insert transcript
                  </button>
                </>
              )}
              {state.phase === "error" && !state.previewUrl && (
                <button
                  ref={phaseActionRef}
                  type="button"
                  className="secondary"
                  onClick={voice.start}
                >
                  <RotateCcw size={14} /> Try again
                </button>
              )}
              <button
                ref={state.phase === "requesting_permission" || state.phase === "transcribing"
                  ? phaseActionRef
                  : undefined}
                type="button"
                className="icon-button"
                aria-label={state.phase === "transcribing"
                  ? "Cancel transcription"
                  : "Cancel voice input"}
                onClick={cancelAndFocus}
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}
    </div>
  );
}
