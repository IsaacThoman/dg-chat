import type { ChatCompletionRequest, ModelInfo } from "@dg-chat/contracts";

export interface UsagePrice {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export function estimateInputTokens(input: ChatCompletionRequest["messages"] | object): number {
  // UTF-8 bytes are a conservative tokenizer-independent reservation bound: modern
  // byte-level tokenizers cannot represent more tokens than the encoded byte count.
  return Math.max(1, new TextEncoder().encode(JSON.stringify(input)).length);
}

export function priceUsage(
  model: ModelInfo,
  inputTokens: number,
  outputTokens: number,
): UsagePrice {
  const normalizedInput = Math.max(0, Math.ceil(inputTokens));
  const normalizedOutput = Math.max(0, Math.ceil(outputTokens));
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    costMicros: Math.max(
      1,
      Math.ceil(
        normalizedInput * model.inputMicrosPerMillion / 1_000_000 +
          normalizedOutput * model.outputMicrosPerMillion / 1_000_000,
      ),
    ),
  };
}

export function reservationPrice(
  model: ModelInfo,
  prompt: ChatCompletionRequest["messages"] | object,
  maxOutputTokens: number,
): UsagePrice {
  return priceUsage(model, estimateInputTokens(prompt), maxOutputTokens);
}
