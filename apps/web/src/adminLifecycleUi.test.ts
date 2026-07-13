import { describe, expect, it } from "vitest";
import {
  adminLifecycleConsequence,
  adminLifecycleErrorMessage,
  parseStartingCreditMicros,
} from "./adminLifecycleUi.ts";

describe("admin lifecycle UI helpers", () => {
  it("parses starting credit as exact bounded microdollars", () => {
    expect(parseStartingCreditMicros("0")).toBe(0);
    expect(parseStartingCreditMicros("5")).toBe(5_000_000);
    expect(parseStartingCreditMicros("5.2")).toBe(5_200_000);
    expect(parseStartingCreditMicros("1000.00")).toBe(1_000_000_000);
    for (const invalid of ["", "-1", "01", "1.001", "1000.01", "Infinity", "5 dollars"]) {
      expect(parseStartingCreditMicros(invalid), invalid).toBeNull();
    }
  });

  it("explains protected and credential-changing operations", () => {
    expect(adminLifecycleErrorMessage("final_admin", "fallback")).toContain(
      "final active administrator",
    );
    expect(adminLifecycleErrorMessage("unknown", "fallback")).toBe("fallback");
    expect(adminLifecycleConsequence("delete")).toContain("revokes full sessions");
    expect(adminLifecycleConsequence("restore")).toContain("preserves");
  });
});
