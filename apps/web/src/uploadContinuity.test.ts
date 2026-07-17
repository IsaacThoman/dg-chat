import { describe, expect, it } from "vitest";
import { visibleComposerUploads } from "./uploadContinuity.ts";

describe("upload cleanup continuity", () => {
  it("shows active uploads and cleanup work from a canceled edit scope", () => {
    const uploads = [
      { key: "draft", scope: "draft", status: "ready" },
      { key: "old-ready", scope: "edit:old", status: "ready" },
      { key: "removing", scope: "edit:old", status: "removing" },
      { key: "failed", scope: "edit:older", status: "delete-failed" },
      { key: "cancelled", scope: "edit:old", status: "cancelled" },
    ];

    expect(visibleComposerUploads(uploads, "draft").map((item) => item.key)).toEqual([
      "draft",
      "removing",
      "failed",
    ]);
  });
});
