import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("retention admin API", () => {
  it("uses the policy, preview, scrub, and exact run endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", fetchMock);
    await api.adminRetentionPolicy();
    await api.updateAdminRetentionPolicy({
      expectedVersion: 2,
      captureEnabled: false,
      requestBodyDays: 7,
      responseBodyDays: 14,
    });
    await api.previewAdminRetention(3);
    await api.createAdminRetentionScrub("idempotency-key", {
      policyVersion: 3,
      requestCutoffAt: "2026-07-01T00:00:00.000Z",
      responseCutoffAt: "2026-07-02T00:00:00.000Z",
      captures: 0,
      requestBodies: 0,
      responseBodies: 0,
      requestBytes: 0,
      responseBytes: 0,
    });
    await api.adminRetentionScrubRun("run/value");
    await api.adminRetentionScrubRuns();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/admin/retention/policy",
      "/api/admin/retention/policy",
      "/api/admin/retention/previews",
      "/api/admin/retention/scrub-runs",
      "/api/admin/retention/scrub-runs/run%2Fvalue",
      "/api/admin/retention/scrub-runs",
    ]);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PUT", credentials: "include" });
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ expectedPolicyVersion: 3 }),
    });
    expect(fetchMock.mock.calls[3][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: "idempotency-key",
        expectedPolicyVersion: 3,
        requestCutoffAt: "2026-07-01T00:00:00.000Z",
        responseCutoffAt: "2026-07-02T00:00:00.000Z",
      }),
    });
  });
});
