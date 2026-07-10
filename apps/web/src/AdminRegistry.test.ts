import { describe, expect, it } from "vitest";
import {
  dateTimeLocalValue,
  effectivePrice,
  formatMicrosAsUsd,
  microsToUsd,
  modelAvailabilityBlockers,
  selectionAfterSuccessfulImports,
  usdToMicros,
} from "./AdminRegistry.tsx";
import type { AdminModel, AdminProvider, ModelPriceVersion } from "./types.ts";

const price = (id: string, effectiveAt: string): ModelPriceVersion => ({
  id,
  providerModelId: "model-1",
  effectiveAt,
  inputMicrosPerMillion: 1_000_000,
  cachedInputMicrosPerMillion: 0,
  reasoningMicrosPerMillion: 0,
  outputMicrosPerMillion: 2_000_000,
  fixedCallMicros: 0,
  source: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("admin registry presentation", () => {
  it("selects the latest effective price without activating future revisions", () => {
    const prices = [
      price("old", "2026-01-01T00:00:00.000Z"),
      price("current", "2026-06-01T00:00:00.000Z"),
      price("future", "2027-01-01T00:00:00.000Z"),
    ];
    expect(effectivePrice(prices, Date.parse("2026-07-10T00:00:00.000Z"))?.id).toBe("current");
    expect(effectivePrice([prices[2]], Date.parse("2026-07-10T00:00:00.000Z"))).toBeUndefined();
  });

  it("converts admin USD fields to exact integer microdollars", () => {
    expect(usdToMicros("1.25")).toBe(1_250_000);
    expect(microsToUsd(1_250_000)).toBe(1.25);
  });

  it("formats a local datetime input without applying the timezone twice", () => {
    const date = new Date(2026, 6, 10, 9, 30);
    expect(dateTimeLocalValue(date)).toBe("2026-07-10T09:30");
  });

  it("does not round nonzero microdollar rates down to zero", () => {
    expect(formatMicrosAsUsd(1)).toBe("0.000001");
    expect(formatMicrosAsUsd(500)).toBe("0.0005");
    expect(formatMicrosAsUsd(1_000_000)).toBe("1");
  });

  it("explains each condition blocking model availability", () => {
    const model = {
      enabled: true,
      prices: [],
    } as unknown as AdminModel;
    const provider = {
      enabled: true,
      hasCredential: false,
      protocol: "chat_completions",
    } as AdminProvider;
    expect(modelAvailabilityBlockers(model, provider, undefined)).toEqual([
      "Credential required",
      "Pricing required",
    ]);
    expect(modelAvailabilityBlockers(
      { ...model, enabled: false },
      undefined,
      price(
        "active",
        "2026-01-01T00:00:00.000Z",
      ),
    )).toEqual(["Model disabled", "Provider missing"]);
  });

  it("leaves only failed discovery imports selected for a safe retry", () => {
    expect(
      [...selectionAfterSuccessfulImports(new Set(["created", "failed"]), ["created"])],
    ).toEqual(["failed"]);
  });
});
