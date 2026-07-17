import { afterEach, describe, expect, it, vi } from "vitest";
import { LatestClipboardOperation } from "./shareClipboard.ts";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

afterEach(() => vi.useRealTimers());

describe("LatestClipboardOperation", () => {
  it("ignores an older failure that resolves after the newest write succeeds", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const writes = [first, second];
    const events: string[] = [];
    const operation = new LatestClipboardOperation();
    const callbacks = {
      onSuccess: () => events.push("success"),
      onFailure: () => events.push("failure"),
      onClearSuccess: () => events.push("clear"),
    };

    const firstWrite = operation.write("first", () => writes.shift()!.promise, callbacks);
    const secondWrite = operation.write("second", () => writes.shift()!.promise, callbacks);
    second.resolve();
    await secondWrite;
    first.reject(new Error("late clipboard denial"));
    await firstWrite;

    expect(events).toEqual(["success"]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(events).toEqual(["success", "clear"]);
  });

  it("cancels an older success timer when a newer write begins", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const operation = new LatestClipboardOperation();
    const callbacks = {
      onSuccess: () => events.push("success"),
      onFailure: () => events.push("failure"),
      onClearSuccess: () => events.push("clear"),
    };

    await operation.write("first", async () => {}, callbacks);
    await vi.advanceTimersByTimeAsync(1_000);
    await operation.write("second", async () => {}, callbacks);
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual(["success", "success"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(["success", "success", "clear"]);
  });

  it("suppresses callbacks and clears timers after disposal", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const events: string[] = [];
    const operation = new LatestClipboardOperation();
    const write = operation.write("link", () => pending.promise, {
      onSuccess: () => events.push("success"),
      onFailure: () => events.push("failure"),
      onClearSuccess: () => events.push("clear"),
    });
    operation.dispose();
    pending.resolve();
    await write;
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
  });
});
