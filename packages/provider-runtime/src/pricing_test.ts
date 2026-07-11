import { assertEquals } from "jsr:@std/assert@1.0.14";
import type { ModelInfo } from "@dg-chat/contracts";
import { estimateInputTokens, priceUsage, reservationPrice } from "./pricing.ts";

const model: ModelInfo = {
  id: "test/model",
  displayName: "Test",
  provider: "test",
  capabilities: ["chat"],
  contextWindow: 128_000,
  inputMicrosPerMillion: 100_000,
  outputMicrosPerMillion: 300_000,
};

Deno.test("usage pricing uses model rates for reservation and settlement", () => {
  assertEquals(priceUsage(model, 10_000, 20_000), {
    inputTokens: 10_000,
    outputTokens: 20_000,
    costMicros: 7_000,
  });
  const messages = [{ role: "user" as const, content: "hello" }];
  assertEquals(
    reservationPrice(model, messages, 100).costMicros,
    priceUsage(model, estimateInputTokens(messages), 100).costMicros,
  );
});

Deno.test("usage pricing has a one-micro minimum and rounds token counts safely", () => {
  assertEquals(priceUsage(model, 0, 0).costMicros, 1);
  assertEquals(priceUsage(model, 0.1, 0.1).inputTokens, 1);
  assertEquals(priceUsage(model, 0.1, 0.1).outputTokens, 1);
});

Deno.test("usage pricing applies an effective fixed per-call charge", () => {
  assertEquals(priceUsage({ ...model, fixedCallMicros: 17 }, 0, 0).costMicros, 17);
  assertEquals(priceUsage({ ...model, fixedCallMicros: 17 }, 10_000, 20_000).costMicros, 7_017);
});

Deno.test("usage pricing separates cached input and reasoning tokens", () => {
  const detailed = {
    ...model,
    cachedInputMicrosPerMillion: 10_000,
    reasoningMicrosPerMillion: 900_000,
  };
  assertEquals(
    priceUsage(detailed, 10_000, 20_000, {
      cachedInputTokens: 4_000,
      reasoningTokens: 5_000,
    }).costMicros,
    9_640,
  );
  assertEquals(reservationPrice(detailed, {}, 20_000).costMicros >= 18_000, true);
});

Deno.test("pricing fails closed before unsafe integer accounting", () => {
  assertEquals(
    (() => {
      try {
        priceUsage({ ...model, inputMicrosPerMillion: Number.MAX_SAFE_INTEGER }, 4_000_000, 0);
        return false;
      } catch (error) {
        return error instanceof RangeError;
      }
    })(),
    true,
  );
});

Deno.test("input reservations conservatively count UTF-8 bytes", () => {
  const messages = [{ role: "user" as const, content: "😀漢字" }];
  assertEquals(
    estimateInputTokens(messages),
    new TextEncoder().encode(JSON.stringify(messages)).length,
  );
});
