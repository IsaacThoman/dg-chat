import type { DomainRepository } from "@dg-chat/database";
import {
  type EmbeddingBillingConfig,
  embeddingCostMicros,
  embeddingTokenUpperBound,
  reserveEmbeddingMicros,
} from "@dg-chat/database";

export async function runAccountedEmbeddingCall<T>(options: {
  repository: DomainRepository;
  userId: string;
  usageRunId: string;
  parentUsageRunId?: string;
  purpose: "document" | "query";
  provider: string;
  model: string;
  upstreamModel: string;
  content: string[];
  billing: EmbeddingBillingConfig;
  call: () => Promise<{ value: T; inputTokens: number }>;
}): Promise<T> {
  const reserved = reserveEmbeddingMicros(options.content, options.billing);
  const maximumInputTokens = embeddingTokenUpperBound(options.content);
  await options.repository.reserve(
    options.userId,
    options.usageRunId,
    options.model,
    reserved,
    `embedding:${options.provider}`,
  );
  await options.repository.startEmbeddingProviderAttempt({
    usageRunId: options.usageRunId,
    parentUsageRunId: options.parentUsageRunId,
    purpose: options.purpose,
    provider: options.provider,
    model: options.model,
    upstreamModel: options.upstreamModel,
    itemCount: options.content.length,
  });
  const started = performance.now();
  const finalize = async (
    input: Parameters<DomainRepository["finalizeEmbeddingProviderUsage"]>[0],
  ) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await options.repository.finalizeEmbeddingProviderUsage(input);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
  let result: { value: T; inputTokens: number };
  try {
    result = await options.call();
  } catch (error) {
    const latency = Math.max(0, Math.round(performance.now() - started));
    await finalize({
      usageRunId: options.usageRunId,
      status: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed",
      inputTokens: 0,
      costMicros: 0,
      tokenSource: "none",
      costSource: "none",
      latencyMs: latency,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const latency = Math.max(0, Math.round(performance.now() - started));
  if (result.inputTokens > maximumInputTokens) {
    await finalize({
      usageRunId: options.usageRunId,
      status: "failed",
      inputTokens: maximumInputTokens,
      costMicros: reserved,
      tokenSource: "estimated",
      costSource: "calculated",
      latencyMs: latency,
      error: "Provider reported impossible embedding token usage",
    });
    throw new Error("Provider reported impossible embedding token usage");
  }
  const cost = embeddingCostMicros(result.inputTokens, options.billing);
  await finalize({
    usageRunId: options.usageRunId,
    status: "succeeded",
    inputTokens: result.inputTokens,
    costMicros: cost,
    tokenSource: "provider",
    costSource: "calculated",
    latencyMs: latency,
  });
  return result.value;
}
