import type { SpeechInput } from "../speechApi.ts";
import { createSpeech } from "../speechApi.ts";

export type SpeechPlaybackPhase = "idle" | "loading" | "ready" | "playing" | "paused" | "error";
export interface SpeechPlaybackState {
  phase: SpeechPlaybackPhase;
  epoch: number;
  messageId: string | null;
  currentTime: number;
  duration: number | null;
  error: string | null;
  errorKind: "generation" | "playback" | null;
}

export const initialSpeechPlaybackState: SpeechPlaybackState = {
  phase: "idle",
  epoch: 0,
  messageId: null,
  currentTime: 0,
  duration: null,
  error: null,
  errorKind: null,
};

export type SpeechPlaybackAction =
  | { type: "load"; epoch: number; messageId: string }
  | { type: "ready"; epoch: number; duration: number | null }
  | { type: "play"; epoch: number }
  | { type: "pause"; epoch: number }
  | { type: "time"; epoch: number; currentTime: number; duration: number | null }
  | { type: "error"; epoch: number; messageId: string; error: string }
  | { type: "playback-error"; epoch: number; error: string }
  | { type: "reset"; epoch: number };

export function speechPlaybackReducer(
  state: SpeechPlaybackState,
  action: SpeechPlaybackAction,
): SpeechPlaybackState {
  if (action.type !== "load" && action.type !== "reset" && action.epoch !== state.epoch) {
    return state;
  }
  switch (action.type) {
    case "load":
      return {
        phase: "loading",
        epoch: action.epoch,
        messageId: action.messageId,
        currentTime: 0,
        duration: null,
        error: null,
        errorKind: null,
      };
    case "ready":
      return { ...state, phase: "ready", duration: action.duration };
    case "play":
      return { ...state, phase: "playing", error: null, errorKind: null };
    case "pause":
      return { ...state, phase: "paused" };
    case "time":
      return { ...state, currentTime: action.currentTime, duration: action.duration };
    case "error":
      return {
        phase: "error",
        epoch: action.epoch,
        messageId: action.messageId,
        currentTime: 0,
        duration: null,
        error: action.error,
        errorKind: "generation",
      };
    case "playback-error":
      return { ...state, phase: "ready", error: action.error, errorKind: "playback" };
    case "reset":
      return { ...initialSpeechPlaybackState, epoch: action.epoch };
  }
}

export interface PlaybackAudio {
  src: string;
  currentTime: number;
  duration: number;
  preload: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface SpeechPlaybackDependencies {
  request?: (input: SpeechInput) => Promise<Blob>;
  createAudio?: () => PlaybackAudio;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

const finiteDuration = (value: number) => Number.isFinite(value) && value >= 0 ? value : null;
const errorMessage = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "Speech playback failed. Please try again.";

/** Owns exactly one audio element, request, and object URL for a chat view. */
export class SpeechPlaybackController {
  #state = initialSpeechPlaybackState;
  #listeners = new Set<() => void>();
  #audio: PlaybackAudio | null = null;
  #mediaListener: EventListener | null = null;
  #abort: AbortController | null = null;
  #url: string | null = null;
  #request: (input: SpeechInput) => Promise<Blob>;
  #createObjectURL: (blob: Blob) => string;
  #revokeObjectURL: (url: string) => void;
  #createAudio: () => PlaybackAudio;
  #disposed = false;

  constructor(dependencies: SpeechPlaybackDependencies = {}) {
    this.#request = dependencies.request ?? createSpeech;
    this.#createObjectURL = dependencies.createObjectURL ?? URL.createObjectURL.bind(URL);
    this.#revokeObjectURL = dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
    this.#createAudio = dependencies.createAudio ?? (() => new Audio());
  }

  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async generate(messageId: string, input: Omit<SpeechInput, "signal">): Promise<void> {
    if (this.#disposed) return;
    const epoch = this.#state.epoch + 1;
    this.#clearMedia();
    const abort = new AbortController();
    this.#abort = abort;
    this.#dispatch({ type: "load", epoch, messageId });
    try {
      const blob = await this.#request({ ...input, signal: abort.signal });
      if (this.#disposed || epoch !== this.#state.epoch || abort.signal.aborted) return;
      const url = this.#createObjectURL(blob);
      if (this.#disposed || epoch !== this.#state.epoch) {
        this.#revokeObjectURL(url);
        return;
      }
      this.#url = url;
      const audio = this.#createAudio();
      this.#audio = audio;
      audio.preload = "metadata";
      const listener: EventListener = (event) => this.#onMediaEvent(event, audio, epoch);
      this.#mediaListener = listener;
      for (const event of ["play", "pause", "timeupdate", "durationchange", "ended", "error"]) {
        audio.addEventListener(event, listener);
      }
      audio.src = url;
      audio.load();
      this.#dispatch({ type: "ready", epoch, duration: finiteDuration(audio.duration) });
      await this.play();
    } catch (error) {
      if (epoch !== this.#state.epoch || this.#disposed) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#dispatch({ type: "error", epoch, messageId, error: errorMessage(error) });
    }
  }

  async play(): Promise<void> {
    if (this.#state.phase !== "ready" && this.#state.phase !== "paused") return;
    if (!this.#audio) return;
    const epoch = this.#state.epoch;
    try {
      const duration = finiteDuration(this.#audio.duration);
      if (duration !== null && this.#audio.currentTime >= duration) this.#audio.currentTime = 0;
      await this.#audio.play();
      if (epoch === this.#state.epoch) this.#dispatch({ type: "play", epoch });
    } catch (error) {
      if (epoch === this.#state.epoch) {
        this.#dispatch({ type: "playback-error", epoch, error: errorMessage(error) });
      }
    }
  }

  pause(): void {
    if (this.#state.phase === "playing") this.#audio?.pause();
  }

  seek(seconds: number): void {
    if (!this.#audio) return;
    const duration = finiteDuration(this.#audio.duration);
    if (duration === null) return;
    this.#audio.currentTime = Math.min(duration, Math.max(0, seconds));
    this.#dispatch({
      type: "time",
      epoch: this.#state.epoch,
      currentTime: this.#audio.currentTime,
      duration,
    });
  }

  cancel(): void {
    if (this.#disposed) return;
    const epoch = this.#state.epoch + 1;
    this.#clearMedia();
    this.#dispatch({ type: "reset", epoch });
  }

  stop = () => this.cancel();

  dispose(): void {
    if (this.#disposed) return;
    this.cancel();
    this.#disposed = true;
  }

  #onMediaEvent(event: Event, audio: PlaybackAudio, epoch: number): void {
    if (
      this.#disposed || !this.#state.messageId || audio !== this.#audio ||
      epoch !== this.#state.epoch
    ) return;
    if (event.type === "play") this.#dispatch({ type: "play", epoch });
    else if (event.type === "pause" && this.#state.phase === "playing") {
      this.#dispatch({ type: "pause", epoch });
    } else if (event.type === "ended") {
      this.#dispatch({ type: "ready", epoch, duration: finiteDuration(audio.duration) });
    } else if (event.type === "error") {
      this.#dispatch({
        type: "playback-error",
        epoch,
        error: "This audio could not be played. Press play to try again.",
      });
    } else {
      this.#dispatch({
        type: "time",
        epoch,
        currentTime: audio.currentTime,
        duration: finiteDuration(audio.duration),
      });
    }
  }

  #clearMedia(): void {
    this.#abort?.abort();
    this.#abort = null;
    if (this.#audio) {
      const audio = this.#audio;
      const listener = this.#mediaListener;
      if (listener) {
        for (const event of ["play", "pause", "timeupdate", "durationchange", "ended", "error"]) {
          audio.removeEventListener(event, listener);
        }
      }
      audio.pause();
      audio.currentTime = 0;
      audio.src = "";
    }
    this.#audio = null;
    this.#mediaListener = null;
    if (this.#url) this.#revokeObjectURL(this.#url);
    this.#url = null;
  }

  #dispatch(action: SpeechPlaybackAction): void {
    const next = speechPlaybackReducer(this.#state, action);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
