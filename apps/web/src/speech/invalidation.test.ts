import { describe, expect, it } from "vitest";
import { reconcileSpeechMessageSnapshot, speechMessageSnapshot } from "./invalidation.ts";

describe("speechMessageSnapshot", () => {
  it("keeps immutable message identity without copying very large content", () => {
    const messages = [{ id: "large", content: "x".repeat(2_000_000) }];

    expect(speechMessageSnapshot(messages)).toBe(messages);
  });

  it("treats a cloned active path with identical speech semantics as a no-op", () => {
    const previous = [
      { id: "user", content: "Hello", status: "complete", ignored: "old metadata" },
      { id: "assistant", content: "Hi", status: "complete", ignored: "old metadata" },
    ];
    const clone = previous.map((message) => ({ ...message, ignored: "new metadata" }));

    expect(reconcileSpeechMessageSnapshot(previous, clone)).toBe(previous);
  });

  it("does not copy a 2MB body when accepting a meaningful content change", () => {
    const content = "x".repeat(2_000_000);
    const previous = [{ id: "assistant", content, status: "complete" }];
    const changed = [{ id: "assistant", content: `${content.slice(0, -1)}y`, status: "complete" }];

    expect(reconcileSpeechMessageSnapshot(previous, changed)).toBe(changed);
    expect(reconcileSpeechMessageSnapshot(changed, changed.map((message) => ({ ...message }))))
      .toBe(changed);
  });

  it("invalidates for visible path identity, order, status, additions, and removals", () => {
    const path = [
      { id: "user", content: "Question", status: "complete" },
      { id: "assistant", content: "Answer", status: "complete" },
    ];
    const changedId = [{ ...path[0] }, { ...path[1], id: "assistant-branch" }];
    const changedStatus = [{ ...path[0] }, { ...path[1], status: "stopped" }];
    const reordered = [path[1], path[0]];
    const added = [...path, { id: "next", content: "Next", status: "complete" }];

    expect(reconcileSpeechMessageSnapshot(path, changedId)).toBe(changedId);
    expect(reconcileSpeechMessageSnapshot(path, changedStatus)).toBe(changedStatus);
    expect(reconcileSpeechMessageSnapshot(path, reordered)).toBe(reordered);
    expect(reconcileSpeechMessageSnapshot(path, added)).toBe(added);
    expect(reconcileSpeechMessageSnapshot(path, path.slice(0, 1))).toEqual(path.slice(0, 1));
  });
});
