import { describe, expect, it } from "vitest";
import {
  dateTimeLocalValue,
  effectivePrice,
  formatMicrosAsUsd,
  microsToUsd,
  modelAvailabilityBlockers,
  modelCustomParamsInput,
  modelSettingsDraft,
  OCR_ACCESS_POLICY_NOTE,
  ocrTargetAvailabilityBlockers,
  ocrTargetCandidates,
  ocrTargetSelectionValue,
  providerProtocolLabel,
  providerProtocolOptions,
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
  it("explains that OCR targets are privileged internal dependencies", () => {
    expect(OCR_ACCESS_POLICY_NOTE).toContain("Access groups control direct model selection");
    expect(OCR_ACCESS_POLICY_NOTE).toContain("isolated per user");
  });

  it("offers both supported native upstream protocols", () => {
    expect(providerProtocolOptions.map((option) => option.value)).toEqual([
      "chat_completions",
      "responses",
    ]);
  });

  it("does not mislabel a missing provider as Chat Completions", () => {
    expect(providerProtocolLabel(undefined)).toBe("Unknown provider");
    expect(providerProtocolLabel({ protocol: "responses" } as AdminProvider)).toBe("Responses");
  });

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
    expect(modelAvailabilityBlockers(
      model,
      { ...provider, hasCredential: true, protocol: "responses" },
      price("active", "2026-01-01T00:00:00.000Z"),
    )).toEqual([]);
  });

  it("round-trips safe provider defaults separately from typed OCR settings", () => {
    const draft = modelSettingsDraft({
      temperature: 0.2,
      ocr: {
        enabled: true,
        providerId: "provider-id",
        model: "provider/vision",
        prompt: "Read the image",
        timeoutMs: 1200,
      },
    });
    expect(JSON.parse(draft.customParamsJson)).toEqual({ temperature: 0.2 });
    expect(draft.ocr).toMatchObject({
      enabled: true,
      providerId: "provider-id",
      model: "provider/vision",
      prompt: "Read the image",
      timeoutMs: "1200",
      cacheTtlSeconds: "86400",
    });
    expect(modelCustomParamsInput(draft.customParamsJson, draft.ocr)).toMatchObject({
      temperature: 0.2,
      ocr: {
        enabled: true,
        providerId: "provider-id",
        model: "provider/vision",
        timeoutMs: 1200,
      },
    });
  });

  it("keeps OCR out of the untyped JSON editor and validates required typed fields", () => {
    const draft = modelSettingsDraft();
    expect(() => modelCustomParamsInput("[]", draft.ocr)).toThrow("JSON object");
    expect(() => modelCustomParamsInput('{"ocr":{"enabled":true}}', draft.ocr)).toThrow(
      "typed OCR controls",
    );
    expect(() =>
      modelCustomParamsInput("{}", {
        ...draft.ocr,
        enabled: true,
      })
    ).toThrow("provider, model, and prompt");
  });

  it("offers only operational one-hop vision models as OCR targets", () => {
    const provider = {
      id: "provider",
      enabled: true,
      hasCredential: true,
    } as AdminProvider;
    const target = {
      id: "vision",
      providerId: provider.id,
      publicModelId: "provider/vision",
      capabilities: ["chat", "vision"],
      enabled: true,
      customParams: {},
      prices: [price("active", "2026-01-01T00:00:00.000Z")],
    } as AdminModel;
    const recursive = {
      ...target,
      id: "recursive",
      customParams: { ocr: { enabled: true } },
    };
    const unpriced = { ...target, id: "unpriced", prices: [] };
    const textOnly = { ...target, id: "text", capabilities: ["chat"] } as AdminModel;
    const visionOnly = { ...target, id: "vision-only", capabilities: ["vision"] } as AdminModel;
    expect(
      ocrTargetCandidates(
        [target, recursive, unpriced, textOnly, visionOnly],
        [provider],
        provider.id,
        "text",
      ).map((model) => model.id),
    ).toEqual(["vision"]);
    expect(ocrTargetCandidates([target], [{ ...provider, enabled: false }], provider.id)).toEqual(
      [],
    );
  });

  it("normalizes a supported public OCR model ID for the target selector", () => {
    const target = {
      id: "vision-id",
      publicModelId: "provider/vision",
    } as AdminModel;
    expect(ocrTargetSelectionValue("provider/vision", [target])).toBe("vision-id");
    expect(ocrTargetSelectionValue("vision-id", [target])).toBe("vision-id");
    expect(ocrTargetSelectionValue("missing/vision", [target])).toBe("missing/vision");
  });

  it("surfaces every operational blocker for a configured OCR target", () => {
    const target = {
      providerId: "actual-provider",
      enabled: false,
      capabilities: ["chat"],
      customParams: {},
    } as AdminModel;
    const provider = {
      id: "actual-provider",
      enabled: false,
      hasCredential: false,
    } as AdminProvider;
    expect(ocrTargetAvailabilityBlockers(target, provider, "configured-provider", undefined))
      .toEqual([
        "Provider mismatch",
        "Model disabled",
        "Provider disabled",
        "Credential required",
        "Pricing required",
        "Vision capability required",
      ]);
    expect(ocrTargetAvailabilityBlockers(undefined, undefined, "provider", undefined)).toEqual([
      "Target missing",
    ]);
  });

  it("leaves only failed discovery imports selected for a safe retry", () => {
    expect(
      [...selectionAfterSuccessfulImports(new Set(["created", "failed"]), ["created"])],
    ).toEqual(["failed"]);
  });
});
