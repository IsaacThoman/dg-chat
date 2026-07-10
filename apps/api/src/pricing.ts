import type { ChatCompletionRequest, ModelInfo } from "@dg-chat/contracts";

export interface UsagePrice {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export function estimateInputTokens(messages: ChatCompletionRequest["messages"]): number {
  return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
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
  messages: ChatCompletionRequest["messages"],
  maxOutputTokens: number,
): UsagePrice {
  return priceUsage(model, estimateInputTokens(messages), maxOutputTokens);
}
