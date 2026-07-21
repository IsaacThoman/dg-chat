import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForMermaidStability } from "./mermaidRuntime.ts";

describe("Mermaid streaming stability gate", () => {
  afterEach(() => vi.useRealTimers());

  it("cancels superseded token updates before they can reach the renderer", async () => {
    vi.useFakeTimers();
    const stale = Array.from({ length: 8 }, () => new AbortController());
    const current = new AbortController();
    let renderCalls = 0;
    const schedule = async (controller: AbortController) => {
      await waitForMermaidStability(controller.signal);
      renderCalls += 1;
    };
    // Attach rejection handlers before aborting so the test models React's immediate `.catch()`
    // ownership and never emits a transient unhandled-rejection warning.
    const staleWork = stale.map((controller) =>
      schedule(controller).then(() => "fulfilled" as const, () => "rejected" as const)
    );
    const currentWork = schedule(current);
    stale.forEach((controller) => controller.abort());

    await vi.advanceTimersByTimeAsync(500);
    const staleResults = await Promise.all(staleWork);
    await currentWork;

    expect(staleResults.every((result) => result === "rejected")).toBe(true);
    expect(renderCalls).toBe(1);
  });
});
