import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminAnalytics, boundedAnalyticsFilters } from "./AdminAnalytics.tsx";

const filters = {
  from: "2026-07-01",
  to: "2026-07-11",
  bucket: "day" as const,
  status: "" as const,
  userId: "",
  model: "",
  provider: "",
};

describe("AdminAnalytics", () => {
  it("renders accessible metrics, chart, and exact table equivalent", () => {
    const markup = renderToStaticMarkup(
      <AdminAnalytics
        filters={filters}
        onApply={() => {}}
        onRetry={() => {}}
        data={analyticsData([{
          start: "2026-07-11",
          calls: 12,
          completed: 11,
          failed: 1,
          customerCostMicros: 123000,
          inputTokens: 100,
          outputTokens: 50,
          avgLatencyMs: 500,
          avgTtftMs: 100,
        }])}
      />,
    );
    expect(markup).toContain("Usage summary");
    expect(markup).toContain('role="img"');
    expect(markup).toContain("exact values follow in the table");
    expect(markup).toContain("Exact usage values");
    expect(markup).toContain("91.7%");
    expect(markup).toContain("Average latency");
    expect(markup).toContain("500 ms");
  });

  it("does not describe an empty or in-progress-only sample as a zero percent success rate", () => {
    const markup = renderToStaticMarkup(
      <AdminAnalytics
        filters={filters}
        onApply={() => {}}
        onRetry={() => {}}
        data={analyticsData([], { calls: 1, completed: 0, failed: 0, successRate: 0 })}
      />,
    );
    expect(markup).toContain("Success rate");
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("0.0%");
  });

  it("excludes in-progress requests from the terminal success-rate percentage", () => {
    const markup = renderToStaticMarkup(
      <AdminAnalytics
        filters={filters}
        onApply={() => {}}
        onRetry={() => {}}
        data={analyticsData([], { calls: 3, completed: 1, failed: 1, successRate: 0.5 })}
      />,
    );
    expect(markup).toContain("50.0%");
  });

  it("distinguishes blocking, stale, and empty states", () => {
    const failed = renderToStaticMarkup(
      <AdminAnalytics
        filters={filters}
        error="Usage unavailable"
        onApply={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Retry loading analytics");
    const stale = renderToStaticMarkup(
      <AdminAnalytics
        filters={filters}
        error="Refresh failed"
        data={analyticsData([])}
        onApply={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(stale).toContain('role="status"');
    expect(stale).toContain("Showing older data");
    expect(stale).toContain("No usage matches these filters");
  });

  it("bounds values before sending them to a client", () => {
    expect(boundedAnalyticsFilters({ ...filters, model: "x".repeat(200) }).model).toHaveLength(160);
  });
});

function analyticsData(
  points: import("./types.ts").AdminAnalyticsPoint[],
  summary: Partial<import("./types.ts").AdminAnalyticsSummary> = {},
) {
  return {
    query: {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-12T00:00:00.000Z",
      bucket: "day" as const,
    },
    summary: {
      calls: 12,
      completed: 11,
      failed: 1,
      inputTokens: 100,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      outputTokens: 50,
      customerCostMicros: 123000,
      providerCostMicros: 100000,
      successRate: 11 / 12,
      avgLatencyMs: 500,
      p95LatencyMs: 850,
      avgTtftMs: 100,
      ...summary,
    },
    points,
    models: [],
    providers: [],
    statuses: [],
  };
}
