export interface EmbeddingBillingConfig {
  inputMicrosPerMillion: number;
  fixedCallMicros: number;
}

function nonnegativeSafeInteger(name: string, raw: string | undefined): number {
  const value = Number(raw ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function parseEmbeddingBillingConfig(
  env: Record<string, string | undefined>,
): EmbeddingBillingConfig {
  return {
    inputMicrosPerMillion: nonnegativeSafeInteger(
      "KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION",
      env.KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION,
    ),
    fixedCallMicros: nonnegativeSafeInteger(
      "KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS",
      env.KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS,
    ),
  };
}

/** One token per Unicode code point is deliberately conservative for credit reservation. */
export function reserveEmbeddingMicros(
  content: readonly string[],
  billing: EmbeddingBillingConfig,
): number {
  const maximumTokens = content.reduce((sum, value) => sum + [...value].length, 0);
  return embeddingCostMicros(maximumTokens, billing);
}

export function embeddingCostMicros(
  inputTokens: number,
  billing: EmbeddingBillingConfig,
): number {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new TypeError("Embedding input tokens must be a non-negative safe integer");
  }
  const variable = BigInt(inputTokens) * BigInt(billing.inputMicrosPerMillion);
  const result = (variable + 999_999n) / 1_000_000n + BigInt(billing.fixedCallMicros);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Embedding cost is too large");
  return Number(result);
}
