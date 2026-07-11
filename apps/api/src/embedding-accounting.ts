import type { DomainRepository } from "@dg-chat/database";
import {
  type EmbeddingBillingConfig,
  embeddingCostMicros,
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
  let result: { value: T; inputTokens: number };
  try {
    result = await options.call();
  } catch (error) {
    const latency = Math.max(0, Math.round(performance.now() - started));
    await Promise.resolve(options.repository.finishEmbeddingProviderAttempt({
      usageRunId: options.usageRunId,
      status: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed",
      inputTokens: 0,
      costMicros: 0,
      tokenSource: "none",
      costSource: "none",
      latencyMs: latency,
      error: error instanceof Error ? error.message : String(error),
    })).catch(() => undefined);
    await Promise.resolve(options.repository.refund(options.usageRunId)).catch(() => undefined);
    throw error;
  }
  // Once the provider returned successfully, never enter the refund path. A terminal persistence
  // error leaves the reservation intact so stale-run reconciliation charges conservatively.
  const cost = Math.min(reserved, embeddingCostMicros(result.inputTokens, options.billing));
  const latency = Math.max(0, Math.round(performance.now() - started));
  await options.repository.settle(options.usageRunId, cost, result.inputTokens, 0, latency);
  await options.repository.finishEmbeddingProviderAttempt({
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
