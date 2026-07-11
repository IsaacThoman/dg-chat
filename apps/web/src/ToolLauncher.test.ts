import { describe, expect, it } from "vitest";
import { toolResultForMessage } from "./ToolLauncher.tsx";
import type { ToolExecution } from "./api.ts";

describe("tool result chat provenance", () => {
  it("keeps the immutable execution id and bounds inserted context", () => {
    const execution = {
      id: "execution-123",
      result: { content: "x".repeat(100) },
    } as ToolExecution;
    const context = toolResultForMessage(execution, 20);
    expect(context).toContain("approved execution execution-123");
    expect(context).toContain("result truncated for chat context");
    expect(context.length).toBeLessThan(150);
  });
});
