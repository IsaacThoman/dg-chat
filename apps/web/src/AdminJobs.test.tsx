import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminJobs, boundedJobFilters } from "./AdminJobs.tsx";
import type { AdminJob } from "./types.ts";

const filters = { status: "" as const, type: "" };
const failed: AdminJob = {
  id: "job-1",
  type: "attachment.ingest",
  status: "failed",
  attempts: 2,
  availableAt: "2026-07-11T10:00:00Z",
  createdAt: "2026-07-11T10:00:00Z",
  lockedAt: "2026-07-11T10:01:00Z",
  completedAt: "2026-07-11T10:02:00Z",
  lastError: "Parser deadline exceeded",
};

describe("AdminJobs", () => {
  it("renders only the safe projection with retry limited to failures", () => {
    const markup = renderToStaticMarkup(
      <AdminJobs
        filters={filters}
        page={{
          items: [failed, { ...failed, id: "job-2", status: "completed" }],
          nextCursor: null,
          previousCursor: null,
          hasPrevious: false,
        }}
        onApply={() => {}}
        onRetryLoad={() => {}}
        onRetryJob={() => {}}
        onCursor={() => {}}
      />,
    );
    expect(markup).toContain("Parser deadline exceeded");
    expect(markup.match(/Retry attachment\.ingest/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Background jobs"');
    expect(markup).not.toContain("payload");
  });

  it("provides blocking error, empty, stale, and bounded cursor controls", () => {
    const error = renderToStaticMarkup(
      <AdminJobs
        filters={filters}
        error="Queue unavailable"
        onApply={() => {}}
        onRetryLoad={() => {}}
        onRetryJob={() => {}}
        onCursor={() => {}}
      />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("Retry loading jobs");
    const empty = renderToStaticMarkup(
      <AdminJobs
        filters={filters}
        stale
        page={{ items: [], nextCursor: null, previousCursor: null, hasPrevious: false }}
        onApply={() => {}}
        onRetryLoad={() => {}}
        onRetryJob={() => {}}
        onCursor={() => {}}
      />,
    );
    expect(empty).toContain("Showing cached jobs");
    expect(empty).toContain("No jobs match these filters");
    expect(empty).not.toContain('aria-label="Job pages"');
  });

  it("bounds freeform filters and rejects unknown statuses", () => {
    expect(
      boundedJobFilters({
        status: "bogus" as never,
        type: "t".repeat(200),
      }),
    ).toEqual({ status: "", type: "t".repeat(120) });
  });

  it("distinguishes future scheduled work from immediately queued jobs", () => {
    const markup = renderToStaticMarkup(
      <AdminJobs
        filters={filters}
        page={{
          items: [{
            ...failed,
            id: "job-scheduled",
            status: "queued",
            availableAt: "2999-01-01T00:00:00Z",
            lastError: null,
          }],
          nextCursor: null,
          previousCursor: null,
          hasPrevious: false,
        }}
        onApply={() => {}}
        onRetryLoad={() => {}}
        onRetryJob={() => {}}
        onCursor={() => {}}
      />,
    );
    expect(markup).toContain("ops-status-scheduled");
    expect(markup).toContain(">scheduled</span>");
  });
});
