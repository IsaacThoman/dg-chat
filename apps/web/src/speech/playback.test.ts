import { describe, expect, it, vi } from "vitest";
import {
  initialSpeechPlaybackState,
  type PlaybackAudio,
  SpeechPlaybackController,
  speechPlaybackReducer,
} from "./playback.ts";

class FakeAudio extends EventTarget implements PlaybackAudio {
  src = "";
  currentTime = 0;
  duration = 12;
  preload = "";
  play = vi.fn((): Promise<void> => {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  pause = vi.fn(() => this.dispatchEvent(new Event("pause")));
  load = vi.fn();
}

const input = { model: "voice", input: "Hello", voice: "alloy" };

describe("speechPlaybackReducer", () => {
  it("ignores stale asynchronous events", () => {
    const loading = speechPlaybackReducer(initialSpeechPlaybackState, {
      type: "load",
      epoch: 2,
      messageId: "new",
    });
    expect(speechPlaybackReducer(loading, { type: "play", epoch: 1 })).toBe(loading);
  });
});

describe("SpeechPlaybackController", () => {
  it("generates and exclusively replaces playback while revoking old URLs", async () => {
    const audio = new FakeAudio();
    const revoke = vi.fn();
    let url = 0;
    const controller = new SpeechPlaybackController({
      createAudio: () => audio,
      request: vi.fn(() => Promise.resolve(new Blob(["audio"]))),
      createObjectURL: () => `blob:${++url}`,
      revokeObjectURL: revoke,
    });
    await controller.generate("one", input);
    expect(controller.getSnapshot()).toMatchObject({ phase: "playing", messageId: "one" });
    expect(audio.src).toBe("blob:1");
    await controller.generate("two", input);
    expect(revoke).toHaveBeenCalledWith("blob:1");
    expect(controller.getSnapshot()).toMatchObject({ phase: "playing", messageId: "two" });
    controller.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:2");
    expect(audio.src).toBe("");
  });

  it("aborts cancellation and ignores a stale response", async () => {
    const audio = new FakeAudio();
    let resolve!: (blob: Blob) => void;
    let observedSignal: AbortSignal | undefined;
    const createUrl = vi.fn(() => "blob:late");
    const controller = new SpeechPlaybackController({
      createAudio: () => audio,
      request: ({ signal }) => {
        observedSignal = signal;
        return new Promise<Blob>((done) => resolve = done);
      },
      createObjectURL: createUrl,
      revokeObjectURL: vi.fn(),
    });
    const pending = controller.generate("one", input);
    controller.cancel();
    expect(observedSignal?.aborted).toBe(true);
    resolve(new Blob(["late"]));
    await pending;
    expect(createUrl).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("supports pause, resume, seek, stop, and recoverable media errors", async () => {
    const audio = new FakeAudio();
    const controller = new SpeechPlaybackController({
      createAudio: () => audio,
      request: () => Promise.resolve(new Blob(["audio"])),
      createObjectURL: () => "blob:audio",
      revokeObjectURL: vi.fn(),
    });
    await controller.generate("one", input);
    controller.pause();
    expect(controller.getSnapshot().phase).toBe("paused");
    controller.seek(30);
    expect(controller.getSnapshot().currentTime).toBe(12);
    await controller.play();
    expect(controller.getSnapshot().phase).toBe("playing");
    audio.dispatchEvent(new Event("error"));
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      errorKind: "playback",
      error: "This audio could not be played. Press play to try again.",
    });
    controller.stop();
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", messageId: null });
  });

  it("keeps generated audio ready after autoplay rejection and retries without another charge", async () => {
    const audio = new FakeAudio();
    audio.play.mockRejectedValueOnce(new Error("Playback requires a user gesture"));
    const revoke = vi.fn();
    const request = vi.fn(() => Promise.resolve(new Blob(["audio"])));
    const controller = new SpeechPlaybackController({
      createAudio: () => audio,
      request,
      createObjectURL: () => "blob:audio",
      revokeObjectURL: revoke,
    });
    await controller.generate("one", input);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      error: "Playback requires a user gesture",
      errorKind: "playback",
    });
    await controller.play();
    expect(controller.getSnapshot()).toMatchObject({ phase: "playing", error: null });
    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:audio");
  });

  it("ignores delayed media events from the replaced audio generation", async () => {
    const oldAudio = new FakeAudio();
    const newAudio = new FakeAudio();
    const audios = [oldAudio, newAudio];
    const controller = new SpeechPlaybackController({
      createAudio: () => audios.shift()!,
      request: () => Promise.resolve(new Blob(["audio"])),
      createObjectURL: () => `blob:${audios.length}`,
      revokeObjectURL: vi.fn(),
    });
    await controller.generate("old", input);
    await controller.generate("new", input);
    oldAudio.dispatchEvent(new Event("error"));
    oldAudio.dispatchEvent(new Event("pause"));
    oldAudio.duration = 999;
    oldAudio.dispatchEvent(new Event("durationchange"));
    expect(controller.getSnapshot()).toMatchObject({
      phase: "playing",
      messageId: "new",
      duration: 12,
      error: null,
    });
  });
});
