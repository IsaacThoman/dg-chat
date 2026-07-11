import type { ReactNode } from "react";
import type { SpeechInput } from "../speechApi.ts";
import type { SpeechPlaybackController, SpeechPlaybackState } from "./playback.ts";

export function formatSpeechTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function SpeechPlaybackControl({
  messageId,
  input,
  controller,
  state,
  disabledReason,
  icon,
}: {
  messageId: string;
  input: Omit<SpeechInput, "signal">;
  controller: SpeechPlaybackController;
  state: SpeechPlaybackState;
  disabledReason?: string;
  icon?: ReactNode;
}) {
  const active = state.messageId === messageId;
  const phase = active ? state.phase : "idle";
  const label = disabledReason
    ? `Read aloud unavailable: ${disabledReason}`
    : phase === "loading"
    ? "Cancel speech generation"
    : phase === "playing"
    ? "Pause read aloud"
    : phase === "paused"
    ? "Resume read aloud"
    : phase === "ready" && state.errorKind === "playback"
    ? "Try playback again"
    : phase === "error"
    ? "Retry read aloud"
    : "Read aloud";
  const activate = () => {
    if (phase === "loading") controller.cancel();
    else if (phase === "playing") controller.pause();
    else if (phase === "paused" || phase === "ready") void controller.play();
    else void controller.generate(messageId, input);
  };
  return (
    <span className="speech-playback-control">
      <button
        type="button"
        className="icon-button speech-trigger"
        aria-label={label}
        title={label}
        aria-pressed={phase === "playing" ? true : undefined}
        disabled={Boolean(disabledReason)}
        onClick={activate}
      >
        {icon ?? (phase === "loading"
          ? "Cancel"
          : phase === "playing"
          ? "Pause"
          : phase === "paused"
          ? "Resume"
          : "Listen")}
      </button>
      {active && (phase === "ready" || phase === "playing" || phase === "paused") && (
        <span className="speech-playback-progress">
          <input
            type="range"
            aria-label="Speech playback position"
            aria-valuetext={`${formatSpeechTime(state.currentTime)} of ${
              formatSpeechTime(state.duration ?? 0)
            }`}
            min={0}
            max={state.duration ?? 0}
            step={0.1}
            value={Math.min(state.currentTime, state.duration ?? 0)}
            disabled={state.duration === null}
            onChange={(event) => controller.seek(Number(event.currentTarget.value))}
          />
          <output>
            {formatSpeechTime(state.currentTime)} / {formatSpeechTime(state.duration ?? 0)}
          </output>
          <button
            type="button"
            className="speech-stop"
            aria-label="Stop read aloud"
            onClick={controller.stop}
          >
            Stop
          </button>
        </span>
      )}
      {active && phase === "loading" && (
        <span role="status" aria-live="polite">Generating audio…</span>
      )}
      {active && state.error && <span role="alert">{state.error}</span>}
    </span>
  );
}
