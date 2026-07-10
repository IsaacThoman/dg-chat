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
