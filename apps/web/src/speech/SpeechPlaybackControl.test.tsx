import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatSpeechTime, SpeechPlaybackControl } from "./SpeechPlaybackControl.tsx";
import type { SpeechPlaybackController, SpeechPlaybackState } from "./playback.ts";

const controller = {
  generate() {},
  cancel() {},
  pause() {},
  play() {},
  seek() {},
  stop() {},
} as unknown as SpeechPlaybackController;
const state = (phase: SpeechPlaybackState["phase"], messageId: string | null = "message") =>
  ({
    phase,
    messageId,
    epoch: 1,
    currentTime: 72,
    duration: 183,
    error: phase === "error" ? "Try again" : null,
    errorKind: phase === "error" ? "generation" : null,
  }) satisfies SpeechPlaybackState;
const props = {
  messageId: "message",
  input: { model: "m", input: "Hello", voice: "v" },
  controller,
};

describe("SpeechPlaybackControl", () => {
  it("exposes precise state labels and progress semantics", () => {
    expect(renderToStaticMarkup(<SpeechPlaybackControl {...props} state={state("playing")} />))
      .toContain('aria-label="Pause read aloud"');
    expect(renderToStaticMarkup(<SpeechPlaybackControl {...props} state={state("paused")} />))
      .toContain('aria-label="Resume read aloud"');
    expect(renderToStaticMarkup(<SpeechPlaybackControl {...props} state={state("loading")} />))
      .toContain('role="status"');
    expect(renderToStaticMarkup(<SpeechPlaybackControl {...props} state={state("error")} />))
      .toContain('role="alert"');
  });
  it("offers playback retry without presenting generation retry", () => {
    const playbackBlocked = {
      ...state("ready"),
      error: "Playback was blocked",
      errorKind: "playback" as const,
    };
    const html = renderToStaticMarkup(
      <SpeechPlaybackControl {...props} state={playbackBlocked} />,
    );
    expect(html).toContain('aria-label="Try playback again"');
    expect(html).toContain('role="alert"');
  });
  it("announces capability-aware disabled reasons", () => {
    const html = renderToStaticMarkup(
      <SpeechPlaybackControl
        {...props}
        state={state("idle", null)}
        disabledReason="no speech model"
      />,
    );
    expect(html).toContain('aria-label="Read aloud unavailable: no speech model"');
    expect(html).toContain("disabled");
  });
});

it("formats speech duration compactly", () => {
  expect(formatSpeechTime(72.9)).toBe("1:12");
  expect(formatSpeechTime(Number.NaN)).toBe("0:00");
});
