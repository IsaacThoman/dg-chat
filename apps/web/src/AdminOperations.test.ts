import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { defaultAnalyticsRange, WorkerFleet } from "./AdminOperations.tsx";

describe("operational admin defaults", () => {
  it("uses an inclusive thirty-day UTC range", () => {
    expect(defaultAnalyticsRange(new Date("2026-07-11T23:59:59Z"))).toEqual({
      from: "2026-06-12",
      to: "2026-07-11",
    });
  });

  it("renders sanitized boot health, progress, and current work", () => {
    const markup = renderToStaticMarkup(createElement(WorkerFleet, {
      loading: false,
      onRetry: () => {},
      scope: "active",
      onScope: () => {},
      hasMore: true,
      loadingMore: false,
      onLoadMore: () => {},
      workers: [{
        instanceId: "00000000-0000-4000-8000-000000000001",
        workerName: "worker-compose",
        state: "running",
        startedAt: "2026-07-16T12:00:00.000Z",
        heartbeatAt: "2026-07-16T12:00:05.000Z",
        progressAt: "2026-07-16T12:00:04.000Z",
        heartbeatAgeMs: 100,
        progressAgeMs: 2_000,
        heartbeatStaleMs: 20_000,
        progressStaleMs: 180_000,
        healthClockToleranceMs: 5_000,
        liveness: "heartbeat_stale",
        currentJobId: "00000000-0000-4000-8000-000000000002",
        currentJobType: "attachment.ingest",
        lastCompletedAt: null,
        lastCompletedJobId: null,
        lastCompletedJobType: null,
      }],
    }));
    expect(markup).toContain("Worker fleet");
    expect(markup).toContain("worker-compose");
    expect(markup).toContain("attachment.ingest");
    expect(markup).toContain("heartbeat stale");
    expect(markup).toContain('aria-label="Lifecycle: running"');
    expect(markup).toContain('aria-label="Liveness: heartbeat stale"');
    expect(markup).toContain("Load more worker boots");
    expect(markup).toContain("More active worker boots are available.");
    expect(markup).toContain('aria-label="Worker instances"');
    expect(markup).not.toContain("claimToken");
  });
});
