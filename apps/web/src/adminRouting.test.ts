import { describe, expect, it } from "vitest";
import { adminSections, isAdminSection, parseAdminSearch } from "./adminRouting.ts";

describe("admin routing", () => {
  it("recognizes every bookmarkable admin section", () => {
    expect(adminSections.every(isAdminSection)).toBe(true);
  });

  it("rejects unknown and unsafe route parameters", () => {
    expect(isAdminSection("usage")).toBe(true);
    expect(isAdminSection("jobs")).toBe(true);
    expect(isAdminSection("../settings")).toBe(false);
    expect(isAdminSection("unknown")).toBe(false);
  });

  it("keeps only bounded operational search parameters", () => {
    expect(parseAdminSearch({
      from: "2026-07-01",
      bucket: "hour",
      status: "failed",
      cursor: "opaque",
      unexpected: "discarded",
    })).toEqual({
      from: "2026-07-01",
      bucket: "hour",
      status: "failed",
      cursor: "opaque",
      to: undefined,
      userId: undefined,
      model: undefined,
      provider: undefined,
      type: undefined,
    });
    expect(parseAdminSearch({ model: "x".repeat(161), bucket: "week" })).toMatchObject({
      model: undefined,
      bucket: undefined,
    });
    expect(parseAdminSearch({ from: "2026-02-29", to: "bad" })).toMatchObject({
      from: undefined,
      to: undefined,
    });
  });
});
