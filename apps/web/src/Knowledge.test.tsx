import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Attachment } from "./types.ts";
import { hasActiveIngestion, ingestionStatusText, retryIngestionAndRefresh } from "./Knowledge.tsx";

const attachment = (status: Attachment["ingestionStatus"], error?: string): Attachment => ({
  id: `file-${status}`,
  filename: "guide.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  state: "ready",
  ingestionStatus: status,
  ingestionError: error,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("knowledge ingestion status", () => {
  it("polls only while at least one extraction is active", () => {
    expect(hasActiveIngestion(undefined)).toBe(false);
    expect(hasActiveIngestion([attachment("ready"), attachment("failed")])).toBe(false);
    expect(hasActiveIngestion([attachment("ready"), attachment("queued")])).toBe(true);
    expect(hasActiveIngestion([attachment("processing")])).toBe(true);
  });

  it("shows actionable progress and backend failure details", () => {
    expect(ingestionStatusText(attachment("queued"))).toContain("waiting for a worker");
    expect(ingestionStatusText(attachment("processing"))).toContain("Extracting and indexing");
    expect(ingestionStatusText(attachment("failed", "PDF parser timed out"))).toBe(
      "Extraction failed: PDF parser timed out",
    );
    expect(ingestionStatusText(attachment("failed"))).toContain("Retry");
    expect(ingestionStatusText(attachment("ready"))).toBe("Extraction ready");
  });

  it("keeps the picker retry control outside its radio label and refreshes after retry", async () => {
    const source = readFileSync(new URL("./Knowledge.tsx", import.meta.url), "utf8");
    const row = source.slice(
      source.indexOf('<div className="knowledge-file-picker-row"'),
      source.indexOf('{file.ingestionStatus === "failed"'),
    );
    expect(row).toContain("</label>");
    expect(source).toContain("aria-label={`Retry extraction for ${file.filename}`}");
    const retry = vi.fn().mockResolvedValue(attachment("queued"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    await retryIngestionAndRefresh("failed-file", retry, refresh);
    expect(retry).toHaveBeenCalledWith("failed-file");
    expect(refresh).toHaveBeenCalledOnce();
    expect(retry.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
  });
});
