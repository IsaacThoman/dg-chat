import type { DomainRepository } from "@dg-chat/database";
import {
  type EmbeddingBillingConfig,
  embeddingCostMicros,
  embeddingTokenUpperBound,
  reserveEmbeddingMicros,
} from "@dg-chat/database";

function causedByAbort(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (value instanceof DOMException && value.name === "AbortError") return true;
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) pending.push(cause);
  }
  return false;
}

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
  call: () => Promise<{ value: T; inputTokens: number; latencyMs?: number }>;
  /** True only when dispatch may have reached the provider despite the missing usable response. */
  isDispatchOutcomeUncertain?: (error: unknown) => boolean;
  /** Marks repository-only calls for a worker that must distinguish DB and provider transports. */
  databaseOperation?: <R>(operation: () => R | PromiseLike<R>) => Promise<R>;
  /**
   * Optional crash-boundary settlement path. A worker may abort provider I/O during shutdown while
   * still allowing one short, independently bounded database window to persist conservative
   * accounting. Normal request paths use databaseOperation for both phases.
   */
  terminalDatabaseOperation?: <R>(operation: () => R | PromiseLike<R>) => Promise<R>;
}): Promise<T> {
  const databaseOperation = options.databaseOperation ??
    (<R>(operation: () => R | PromiseLike<R>) => Promise.resolve(operation()));
  const terminalDatabaseOperation = options.terminalDatabaseOperation ?? databaseOperation;
  const reserved = reserveEmbeddingMicros(options.content, options.billing);
  const maximumInputTokens = embeddingTokenUpperBound(options.content);
  await databaseOperation(() =>
    options.repository.ensureIdempotentReservation({
      userId: options.userId,
      usageRunId: options.usageRunId,
      model: options.model,
      reservedMicros: reserved,
      provider: `embedding:${options.provider}`,
      recoveryOwner: options.purpose === "document" ? "document_embedding" : "provider",
    })
  );
  await databaseOperation(() =>
    options.repository.startEmbeddingProviderAttempt({
      usageRunId: options.usageRunId,
      parentUsageRunId: options.parentUsageRunId,
      purpose: options.purpose,
      provider: options.provider,
      model: options.model,
      upstreamModel: options.upstreamModel,
      itemCount: options.content.length,
    })
  );
  const started = performance.now();
  const finalize = async (
    input: Parameters<DomainRepository["finalizeEmbeddingProviderUsage"]>[0],
  ) => {
    let lastError: unknown;
    // A supplied terminal path owns its retry/deadline policy (the worker uses a bounded backoff
    // window). Do not multiply that shutdown budget by nesting the generic lost-response retries.
    const attempts = options.terminalDatabaseOperation ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await terminalDatabaseOperation(() =>
          options.repository.finalizeEmbeddingProviderUsage(input)
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
  let result: { value: T; inputTokens: number; latencyMs?: number };
  try {
    result = await options.call();
  } catch (error) {
    const latency = Math.max(0, Math.round(performance.now() - started));
    const uncertain = options.isDispatchOutcomeUncertain?.(error) ?? false;
    await finalize({
      usageRunId: options.usageRunId,
      // A worker wraps post-dispatch transport loss in an uncertainty error so it can fence the
      // durable job. Preserve the causal shutdown classification without weakening conservative
      // cost settlement for the uncertain call.
      status: causedByAbort(error) ? "cancelled" : "failed",
      inputTokens: uncertain ? maximumInputTokens : 0,
      costMicros: uncertain ? reserved : 0,
      tokenSource: uncertain ? "estimated" : "none",
      costSource: uncertain ? "calculated" : "none",
      latencyMs: latency,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const latency = result.latencyMs ?? Math.max(0, Math.round(performance.now() - started));
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
