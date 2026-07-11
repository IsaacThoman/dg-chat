import type { ChatCompletionRequest, ModelInfo } from "@dg-chat/contracts";

export interface UsagePrice {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface UsageTokenDetails {
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

function normalizedTokens(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Math.ceil(value)));
}

function tokenNumerator(tokens: number, rate: number): bigint {
  return BigInt(tokens) * BigInt(rate);
}

function safeCost(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Calculated price exceeds the safe accounting limit");
  }
  return Number(value);
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
  details: UsageTokenDetails = {},
): UsagePrice {
  const normalizedInput = Math.max(0, Math.ceil(inputTokens));
  const normalizedOutput = Math.max(0, Math.ceil(outputTokens));
  const cachedInput = normalizedTokens(details.cachedInputTokens ?? 0, normalizedInput);
  const reasoning = normalizedTokens(details.reasoningTokens ?? 0, normalizedOutput);
  const numerator = tokenNumerator(normalizedInput - cachedInput, model.inputMicrosPerMillion) +
    tokenNumerator(
      cachedInput,
      model.cachedInputMicrosPerMillion ?? model.inputMicrosPerMillion,
    ) +
    tokenNumerator(normalizedOutput - reasoning, model.outputMicrosPerMillion) +
    tokenNumerator(reasoning, model.reasoningMicrosPerMillion ?? model.outputMicrosPerMillion);
  const cost = BigInt(model.fixedCallMicros ?? 0) + (numerator + 999_999n) / 1_000_000n;
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    costMicros: Math.max(1, safeCost(cost)),
  };
}

export function reservationPrice(
  model: ModelInfo,
  prompt: ChatCompletionRequest["messages"] | object,
  maxOutputTokens: number,
): UsagePrice {
  const inputTokens = estimateInputTokens(prompt);
  const outputTokens = Math.max(0, Math.ceil(maxOutputTokens));
  const numerator = tokenNumerator(
    inputTokens,
    Math.max(model.inputMicrosPerMillion, model.cachedInputMicrosPerMillion ?? 0),
  ) + tokenNumerator(
    outputTokens,
    Math.max(model.outputMicrosPerMillion, model.reasoningMicrosPerMillion ?? 0),
  );
  const conservative = BigInt(model.fixedCallMicros ?? 0) +
    (numerator + 999_999n) / 1_000_000n;
  return { inputTokens, outputTokens, costMicros: Math.max(1, safeCost(conservative)) };
}
