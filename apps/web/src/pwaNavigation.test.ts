import { describe, expect, it } from "vitest";
import { pwaNavigationDenylist } from "./pwaNavigation.ts";

function denied(path: string) {
  return pwaNavigationDenylist.some((pattern) => pattern.test(path));
}

describe("PWA navigation fallback", () => {
  it("never intercepts API callbacks or operational endpoints", () => {
    expect(denied("/api")).toBe(true);
    expect(denied("/api?probe=1")).toBe(true);
    expect(denied("/api/auth/oidc/callback?code=secret&state=opaque")).toBe(true);
    expect(denied("/v1")).toBe(true);
    expect(denied("/v1?probe=1")).toBe(true);
    expect(denied("/v1/models")).toBe(true);
    expect(denied("/health")).toBe(true);
    expect(denied("/health?probe=1")).toBe(true);
    expect(denied("/health/")).toBe(true);
    expect(denied("/ready")).toBe(true);
    expect(denied("/ready?probe=1")).toBe(true);
    expect(denied("/ready/replica")).toBe(true);
    expect(denied("/metrics")).toBe(true);
    expect(denied("/metrics?probe=1")).toBe(true);
    expect(denied("/metrics/")).toBe(true);
    expect(denied("/%61pi/setup/status")).toBe(true);
    expect(denied("/%76%31/models")).toBe(true);
    expect(denied("/%68ealth")).toBe(true);
    expect(denied("/%6detrics?probe=1")).toBe(true);
    expect(denied("/chat/%2e%2e/api/setup/status")).toBe(true);
  });

  it("keeps product routes eligible for the offline app shell", () => {
    expect(denied("/")).toBe(false);
    expect(denied("/login")).toBe(false);
    expect(denied("/pending")).toBe(false);
    expect(denied("/forgot-password")).toBe(false);
    expect(denied("/reset-password?token=opaque")).toBe(false);
    expect(denied("/verify-email?token=opaque")).toBe(false);
    expect(denied("/apiary?view=detail")).toBe(false);
    expect(denied("/v1beta?model=preview")).toBe(false);
    expect(denied("/healthcheck?from=sidebar")).toBe(false);
    expect(denied("/readiness?from=admin")).toBe(false);
    expect(denied("/metrics-dashboard?range=day")).toBe(false);
    expect(denied("/chat?query=hello%20world")).toBe(false);
  });
});
