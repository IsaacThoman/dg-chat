import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  providerCustomParamsViolation,
  providerModelOcrGraphViolation,
  providerOcrTargetProviderViolation,
} from "./provider-model-invariants.ts";

Deno.test("provider custom parameters share full bounded domain validation", () => {
  assertEquals(
    providerCustomParamsViolation({
      temperature: 0.2,
      top_p: 0.9,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object" },
          strict: true,
        },
      },
      ocr: {
        enabled: true,
        providerId: crypto.randomUUID(),
        model: "provider/vision",
        prompt: "Read the image",
        timeoutMs: 5_000,
      },
    }),
    undefined,
  );
  for (
    const invalid of [
      { temperature: "hot" },
      { unknown: true },
      { stop: [] },
      { response_format: { type: "json_schema", json_schema: { name: "", schema: {} } } },
      {
        response_format: {
          type: "json_schema",
          json_schema: { name: "not a valid name", schema: {} },
        },
      },
      {
        response_format: {
          type: "json_schema",
          json_schema: { name: "valid", description: "x".repeat(1_025), schema: {} },
        },
      },
      { ocr: { enabled: true, providerId: "provider", model: "vision" } },
      { parallel_tool_calls: "yes" },
    ]
  ) {
    assertEquals(providerCustomParamsViolation(invalid)?.code, "provider_defaults_invalid");
  }
});

Deno.test("OCR graph rejects a disabled target", () => {
  const providerId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  assertEquals(
    providerModelOcrGraphViolation([{
      id: targetId,
      providerId,
      publicModelId: "provider/vision",
      enabled: false,
      capabilities: ["chat", "vision"],
      customParams: {},
    }, {
      id: crypto.randomUUID(),
      providerId,
      publicModelId: "provider/source",
      enabled: true,
      capabilities: ["chat"],
      customParams: {
        ocr: {
          enabled: true,
          providerId,
          model: targetId,
          prompt: "Extract text",
        },
      },
    }])?.code,
    "ocr_target_unavailable",
  );
});

Deno.test("OCR graph rejects a disabled target provider", () => {
  const providerId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  const models = [{
    id: targetId,
    providerId,
    publicModelId: "provider/vision",
    enabled: true,
    capabilities: ["chat", "vision"],
    customParams: {},
  }, {
    id: crypto.randomUUID(),
    providerId,
    publicModelId: "provider/source",
    enabled: true,
    capabilities: ["chat"],
    customParams: {
      ocr: {
        enabled: true,
        providerId,
        model: targetId,
        prompt: "Extract text",
      },
    },
  }];
  assertEquals(
    providerOcrTargetProviderViolation(models, [{ id: providerId, enabled: false }])?.code,
    "ocr_target_unavailable",
  );
  assertEquals(
    providerOcrTargetProviderViolation(models, [{ id: providerId, enabled: true }]),
    undefined,
  );
});

Deno.test("disabled OCR sources do not keep targets or providers enabled", () => {
  const providerId = crypto.randomUUID();
  const source = {
    id: crypto.randomUUID(),
    providerId,
    publicModelId: "provider/source",
    enabled: false,
    capabilities: ["chat"],
    customParams: {
      ocr: {
        enabled: true,
        providerId,
        model: "removed-target",
        prompt: "Extract text",
      },
    },
  };
  assertEquals(providerModelOcrGraphViolation([source]), undefined);
  assertEquals(
    providerOcrTargetProviderViolation([source], [{ id: providerId, enabled: false }]),
    undefined,
  );
});
