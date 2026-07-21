import { describe, expect, it } from "vitest";
import {
  artifactForFence,
  deriveArtifacts,
  safeArtifactFilename,
  shouldPromoteArtifact,
} from "./artifacts.ts";

describe("rich output artifact derivation", () => {
  it("promotes long blocks and explicit artifacts while leaving short examples inline", () => {
    expect(shouldPromoteArtifact("const ok = true;", "ts")).toBe(false);
    expect(shouldPromoteArtifact("const ok = true;", "ts filename=example.ts")).toBe(true);
    expect(shouldPromoteArtifact(Array.from({ length: 18 }, (_, i) => `line ${i}`).join("\n")))
      .toBe(true);
  });

  it("derives safe repeated-filename version navigation without grouping anonymous blocks", () => {
    const markdown = [
      '```tsx filename="Widget.tsx" version=1',
      "export const Widget = () => <div />;",
      "```",
      "",
      "```text",
      "independent",
      "```",
      "",
      '```tsx filename="Widget.tsx" version=2',
      "export const Widget = () => <main />;",
      "```",
    ].join("\n");
    const artifacts = deriveArtifacts(markdown);
    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]).toMatchObject({
      versionIndex: 0,
      versionCount: 2,
      siblingIndexes: [0, 2],
    });
    expect(artifacts[1]).toMatchObject({ versionIndex: 0, versionCount: 1, siblingIndexes: [1] });
    expect(artifacts[2]).toMatchObject({
      versionIndex: 1,
      versionCount: 2,
      siblingIndexes: [0, 2],
    });
    expect(artifactForFence(artifacts, artifacts[2].source, "tsx", artifacts[2].startLine)).toBe(
      artifacts[2],
    );
  });

  it("never exports traversal paths or unsafe filename characters", () => {
    expect(safeArtifactFilename("../../private/<script>.tsx", "tsx", 0)).toBe("-script-.tsx");
    expect(safeArtifactFilename("...", "python", 1)).toBe("artifact-2.py");
    expect(safeArtifactFilename(null, "unknown", 2)).toBe("artifact-3.txt");
  });

  it("does not collapse distinct source paths into false versions", () => {
    const artifacts = deriveArtifacts([
      "```tsx filename=src/Widget.tsx",
      "export const Widget = 'app';",
      "```",
      "",
      "```tsx filename=tests/Widget.tsx",
      "export const Widget = 'test';",
      "```",
    ].join("\n"));

    expect(artifacts.map((artifact) => artifact.filename)).toEqual(["Widget.tsx", "Widget.tsx"]);
    expect(artifacts.map((artifact) => artifact.versionCount)).toEqual([1, 1]);
  });
});
