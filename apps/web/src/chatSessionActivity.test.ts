import { describe, expect, it } from "vitest";
import { shouldPollAttachmentIngestion } from "./App.tsx";

describe("chat session activity", () => {
  it("polls attachment ingestion only while the owning chat session is active", () => {
    const pending = [{
      attachments: [
        { ingestionStatus: "queued" },
        { ingestionStatus: "processing" },
      ],
    }] as const;
    expect(shouldPollAttachmentIngestion(pending, true)).toBe(true);
    expect(shouldPollAttachmentIngestion(pending, false)).toBe(false);
    expect(shouldPollAttachmentIngestion([{
      attachments: [{ ingestionStatus: "ready" }],
    }], true)).toBe(false);
    expect(shouldPollAttachmentIngestion([], true)).toBe(false);
  });
});
