export type VoicePhase =
  | "idle"
  | "requesting_permission"
  | "recording"
  | "preview"
  | "transcribing"
  | "error";

export interface VoiceState {
  phase: VoicePhase;
  elapsedSeconds: number;
  previewUrl?: string;
  error?: string;
}

export type VoiceAction =
  | { type: "request" }
  | { type: "recording" }
  | { type: "tick" }
  | { type: "preview"; previewUrl: string }
  | { type: "transcribing" }
  | { type: "error"; message: string; keepPreview?: boolean }
  | { type: "reset" };

export const initialVoiceState: VoiceState = { phase: "idle", elapsedSeconds: 0 };

export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "request":
      return { phase: "requesting_permission", elapsedSeconds: 0 };
    case "recording":
      return { phase: "recording", elapsedSeconds: 0 };
    case "tick":
      return state.phase === "recording"
        ? { ...state, elapsedSeconds: state.elapsedSeconds + 1 }
        : state;
    case "preview":
      return {
        phase: "preview",
        elapsedSeconds: state.elapsedSeconds,
        previewUrl: action.previewUrl,
      };
    case "transcribing":
      return { ...state, phase: "transcribing", error: undefined };
    case "error":
      return {
        phase: "error",
        elapsedSeconds: state.elapsedSeconds,
        previewUrl: action.keepPreview ? state.previewUrl : undefined,
        error: action.message,
      };
    case "reset":
      return initialVoiceState;
  }
}

export function insertTranscript(
  value: string,
  transcript: string,
  selectionStart = value.length,
  selectionEnd = selectionStart,
): { value: string; caret: number } {
  const cleaned = transcript.trim();
  if (!cleaned) return { value, caret: selectionStart };
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const inserted = `${prefix}${cleaned}${suffix}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + prefix.length + cleaned.length,
  };
}

export function voiceErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Microphone access was denied. Allow it in browser settings and try again.";
    }
    if (error.name === "NotFoundError") return "No microphone was found.";
    if (error.name === "NotReadableError") return "The microphone is busy or unavailable.";
  }
  return error instanceof Error ? error.message : "Voice input could not start.";
}
