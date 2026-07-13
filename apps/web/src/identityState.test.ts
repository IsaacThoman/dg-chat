import { describe, expect, it } from "vitest";
import {
  identityDestination,
  identityTokenFromUrl,
  pendingMode,
  recoveryPasswordError,
} from "./identityState.ts";

describe("identity state", () => {
  it("never sends a limited approved user into the workspace", () => {
    expect(identityDestination({ status: "approved", limited: true })).toBe("/pending");
    expect(identityDestination({ status: "approved", limited: false })).toBe("/");
    expect(identityDestination({ status: "pending", limited: true })).toBe("/pending");
  });

  it("distinguishes approval, verification, and fresh-sign-in states", () => {
    const base = {
      approvalStatus: "approved" as const,
      state: "active" as const,
      emailVerified: true,
      emailVerificationRequired: false,
      sessionLimited: true,
      fullSessionEligible: true,
      fullAccess: false,
    };
    expect(pendingMode({ ...base, approvalStatus: "pending", fullSessionEligible: false }))
      .toBe("approval");
    expect(
      pendingMode({
        ...base,
        emailVerified: false,
        emailVerificationRequired: true,
        fullSessionEligible: false,
      }),
    ).toBe("verification");
    expect(pendingMode(base)).toBe("refresh");
    expect(pendingMode({ ...base, sessionLimited: false, fullAccess: true })).toBe("ready");
  });

  it("validates recovery passwords without exposing server state", () => {
    expect(recoveryPasswordError("short", "short")).toMatch(/10/);
    expect(recoveryPasswordError("a".repeat(129), "a".repeat(129))).toMatch(/128/);
    expect(recoveryPasswordError("Valid-Pass-42", "different-42")).toMatch(/match/);
    expect(recoveryPasswordError("Valid-Pass-42", "Valid-Pass-42")).toBeNull();
  });

  it("prefers fragment identity tokens while supporting old query links", () => {
    expect(identityTokenFromUrl("https://chat.test/reset-password#token=fragment-secret"))
      .toBe("fragment-secret");
    expect(identityTokenFromUrl("https://chat.test/reset-password?token=query-secret"))
      .toBe("query-secret");
    expect(
      identityTokenFromUrl(
        "https://chat.test/reset-password?token=query-secret#token=fragment-secret",
      ),
    ).toBe("fragment-secret");
  });
});
