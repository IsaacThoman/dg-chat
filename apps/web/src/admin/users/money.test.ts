import { describe, expect, it } from "vitest";
import { formatUsdInputMicros, formatUsdMicros, parseUsdMicros } from "./money.ts";

describe("exact admin billing money", () => {
  it("parses decimal dollars without floating-point rounding", () => {
    expect(parseUsdMicros("1.234567")).toEqual({
      ok: true,
      micros: 1_234_567,
      normalized: "1.234567",
    });
    expect(parseUsdMicros(".5")).toMatchObject({ ok: true, micros: 500_000 });
    expect(parseUsdMicros("5.")).toMatchObject({ ok: true, micros: 5_000_000 });
    expect(parseUsdMicros("9007199254.740991")).toMatchObject({
      ok: true,
      micros: Number.MAX_SAFE_INTEGER,
    });
  });

  it("rejects ambiguous, over-precise, negative, and unsafe amounts", () => {
    expect(parseUsdMicros("")).toEqual({ ok: false, error: "required" });
    expect(parseUsdMicros("1.0000001")).toEqual({ ok: false, error: "too_precise" });
    expect(parseUsdMicros("-1")).toEqual({ ok: false, error: "negative_not_allowed" });
    expect(parseUsdMicros("01")).toEqual({ ok: false, error: "invalid_format" });
    expect(parseUsdMicros("1e2")).toEqual({ ok: false, error: "invalid_format" });
    expect(parseUsdMicros("9,000")).toEqual({ ok: false, error: "invalid_format" });
    expect(parseUsdMicros("9007199254.740992")).toEqual({
      ok: false,
      error: "above_maximum",
    });
  });

  it("supports explicit debit bounds and produces normalized form values", () => {
    expect(parseUsdMicros("-0.000125", { allowNegative: true })).toEqual({
      ok: true,
      micros: -125,
      normalized: "-0.000125",
    });
    expect(parseUsdMicros("0", { minimumMicros: 1 })).toEqual({
      ok: false,
      error: "below_minimum",
    });
    expect(parseUsdMicros("10.01", { maximumMicros: 10_000_000 })).toEqual({
      ok: false,
      error: "above_maximum",
    });
    expect(formatUsdInputMicros(-1_230_000)).toBe("-1.23");
  });

  it("formats money honestly down to one microdollar", () => {
    expect(formatUsdMicros(0, { locale: "en-US" })).toBe("$0.00");
    expect(formatUsdMicros(1, { locale: "en-US" })).toBe("$0.000001");
    expect(formatUsdMicros(1_230_000, { locale: "en-US" })).toBe("$1.23");
    expect(formatUsdMicros(1_000_000_000, { locale: "en-US" })).toBe("$1,000.00");
    expect(formatUsdMicros(-125, { locale: "en-US" })).toBe("−$0.000125");
    expect(formatUsdMicros(500_000, { locale: "en-US", showPlus: true })).toBe("+$0.50");
  });

  it("rejects unsafe values and invalid formatter precision", () => {
    expect(() => formatUsdMicros(0.5)).toThrow(RangeError);
    expect(() => formatUsdInputMicros(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => formatUsdMicros(1, { minimumFractionDigits: 7 })).toThrow(RangeError);
  });
});
