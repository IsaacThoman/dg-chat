import { describe, expect, it } from "vitest";
import { defaultAnalyticsRange } from "./AdminOperations.tsx";

describe("operational admin defaults", () => {
  it("uses an inclusive thirty-day UTC range", () => {
    expect(defaultAnalyticsRange(new Date("2026-07-11T23:59:59Z"))).toEqual({
      from: "2026-06-12",
      to: "2026-07-11",
    });
  });
});
