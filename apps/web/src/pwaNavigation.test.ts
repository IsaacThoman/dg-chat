import { describe, expect, it } from "vitest";
import { pwaNavigationDenylist } from "./pwaNavigation.ts";

function denied(path: string) {
  return pwaNavigationDenylist.some((pattern) => pattern.test(path));
}

describe("PWA navigation fallback", () => {
  it("never intercepts API callbacks or operational endpoints", () => {
    expect(denied("/api/auth/oidc/callback?code=secret&state=opaque")).toBe(true);
    expect(denied("/v1/models")).toBe(true);
    expect(denied("/health")).toBe(true);
    expect(denied("/ready")).toBe(true);
    expect(denied("/metrics")).toBe(true);
  });

  it("keeps product routes eligible for the offline app shell", () => {
    expect(denied("/")).toBe(false);
    expect(denied("/login")).toBe(false);
    expect(denied("/pending")).toBe(false);
  });
});
