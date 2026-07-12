import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminRetention } from "./AdminRetention.tsx";

const policy = {
  version: 1,
  captureEnabled: false,
  requestBodyDays: 7 as const,
  responseBodyDays: 7 as const,
  updatedAt: "2026-07-11T00:00:00.000Z",
  updatedBy: "Admin",
};

const base = {
  recentRuns: [],
  onRetryPolicy: () => {},
  onReloadPolicy: async () => {},
  onSave: async () => {},
  onPreview: async () => {},
  onRefreshPreview: async () => {},
  onScrub: async () => {},
  onSelectRun: () => {},
  onRetryRun: () => {},
  onRetryRuns: () => {},
};

describe("AdminRetention", () => {
  it("states the preservation invariant and renders a safe disabled-default policy", () => {
    const html = renderToStaticMarkup(<AdminRetention {...base} policy={policy} />);
    expect(html).toContain("Accounting history is always preserved");
    expect(html).toContain('aria-label="Retention policy"');
    expect(html).toContain("Saved: capture disabled");
    expect(html).not.toContain('disabled="" value="7"');
    expect(html).toContain("even while new capture is disabled");
    expect(html).toContain("Review policy change");
  });

  it("distinguishes blocking, stale, empty, and terminal run states", () => {
    expect(renderToStaticMarkup(<AdminRetention {...base} policyError="Unavailable" />))
      .toContain('role="alert"');
    const html = renderToStaticMarkup(
      <AdminRetention
        {...base}
        policy={policy}
        policyStale
        selectedRun={{
          id: "run",
          idempotencyKey: "key",
          status: "completed",
          policy,
          requestCutoffAt: "2026-07-04T00:00:00Z",
          responseCutoffAt: "2026-07-04T00:00:00Z",
          capturesScrubbed: 3,
          requestBodiesScrubbed: 2,
          responseBodiesScrubbed: 3,
          bytesScrubbed: 50,
          createdAt: "2026-07-11T00:00:00Z",
          startedAt: "2026-07-11T00:00:01Z",
          completedAt: "2026-07-11T00:00:02Z",
          error: null,
        }}
      />,
    );
    expect(html).toContain("Showing the last policy");
    expect(html).toContain("Scrub run status");
    expect(html).toContain("No scrub runs yet");
  });

  it("blocks stale destructive previews and provides conflict recovery", () => {
    const html = renderToStaticMarkup(
      <AdminRetention
        {...base}
        policy={policy}
        policyStale
        scrubConflict
        scrubError="Preview is stale"
        preview={{
          policyVersion: 1,
          requestCutoffAt: "2026-07-04T00:00:00Z",
          responseCutoffAt: "2026-07-04T00:00:00Z",
          captures: 2,
          requestBodies: 2,
          responseBodies: 1,
          requestBytes: 20,
          responseBytes: 10,
        }}
      />,
    );
    expect(html).toContain("previously saved policy and cannot be queued");
    expect(html).toContain("Run scrub now");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Request cutoff");
  });
});
