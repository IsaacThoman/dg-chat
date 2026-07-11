import type {
  DomainRepository,
  FinishProviderAttemptInput,
  ProviderAttempt,
  ProviderAttemptReason,
  ProviderBreakerState,
  ProviderExecutionClaim,
  ProviderExecutionPlan,
  ProviderExecutionTarget,
  UsagePricingSnapshot,
} from "@dg-chat/database";
import { DomainError } from "@dg-chat/database";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { Buffer } from "node:buffer";
import { type ProviderSecretEnvelope, ProviderSecretKeyring } from "./provider-secrets.ts";
import { complete, streamChatCompletion, type UpstreamStreamOptions } from "./models.ts";
import {
  type AttemptContext,
  type AttemptEvent,
  type CircuitPermit,
  type CircuitStore,
  executeProviderRequest,
  openAIVisibleUnits,
  ProviderAttemptError,
  type ProviderCandidate,
  type ResiliencePolicy,
  streamProviderRequest,
} from "./provider-resilience.ts";
import {
  type BreakerPolicy,
  type CircuitBreaker,
  CircuitBreakerStoreAdapter,
} from "./provider-circuit.ts";
import { estimateInputTokens } from "./pricing.ts";
import {
  createEmbeddings,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type ProviderFetch,
} from "./embeddings.ts";
import {
  interceptOcrImages,
  MemoryOcrCache,
  type OcrCache,
  type OcrRecognize,
  parseOcrInterceptionConfig,
} from "./ocr-interception.ts";
import {
  type AudioEndpoint,
  AudioProviderError,
  type AudioProviderResponse,
  type AudioProviderUsage,
  type AudioRequest,
  createAudioTranscription,
  estimateAudioInputTokens,
} from "./audio.ts";
import {
  type AudioTranscriptVisibility,
  createAudioTranscriptVisibility,
  observeAudioTranscriptFrame,
} from "./audio-stream-accounting.ts";

const OCR_MAX_OUTPUT_TOKENS = 4_096;

type Completion = Awaited<ReturnType<typeof complete>>;

interface RuntimeCandidate extends ProviderCandidate {
  target: ProviderExecutionTarget;
  credentialEnvelope: Record<string, unknown>;
}

interface AttemptMetrics {
  dispatched: boolean;
  estimatedInputTokens: number;
  providerInputTokens: number | null;
  providerOutputTokens: number | null;
  providerReasoningTokens: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  upstreamRequestId: string | null;
  firstVisibleAt: number | null;
  visibleCharacters: number;
  reasoningCharacters: number;
  tokenSource: "provider" | "estimated" | "none";
  audioVisibility: AudioTranscriptVisibility;
}

export interface ProviderExecutionOptions {
  repository: DomainRepository;
  keyring: ProviderSecretKeyring;
  circuitBreaker: CircuitBreaker;
  breakerPolicy: BreakerPolicy;
  complete?: typeof complete;
  stream?: typeof streamChatCompletion;
  embeddingsFetch?: ProviderFetch;
  audioFetch?: typeof fetch;
  now?: () => number;
  ocrCache?: OcrCache;
  ocrFetch?: typeof fetch;
  /** Accounting-aware installations can replace the direct OCR provider call with a child run. */
  ocrRecognize?: (
    input: Parameters<OcrRecognize>[0] & {
      sourceModelId: string;
      parentUsageRunId: string;
      ownerLeaseToken: string;
    },
  ) => ReturnType<OcrRecognize>;
  slowStream?: {
    windowMs: number;
    minimumVisibleUnitsPerSecond: number;
  };
}

const defaultRetryableStatuses = [408, 425, 429, 500, 502, 503, 504];
const terminalPersistenceDelaysMs = [0, 10, 50, 200] as const;

export class TerminalAccountingPersistenceError extends Error {
  constructor(public readonly persistenceCause: unknown) {
    super("Provider completed, but its terminal accounting record could not be persisted");
    this.name = "TerminalAccountingPersistenceError";
  }
}

function retryablePersistenceError(error: unknown): boolean {
  return !(error instanceof DomainError) || error.status >= 500;
}

async function accountingBackoff(delayMs: number): Promise<void> {
  if (delayMs === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function pricingCost(pricing: UsagePricingSnapshot, metrics: AttemptMetrics): number {
  const uncached = BigInt(Math.max(0, metrics.inputTokens - metrics.cachedInputTokens));
  const ordinaryOutput = BigInt(Math.max(0, metrics.outputTokens - metrics.reasoningTokens));
  const numerator = uncached * BigInt(pricing.inputMicrosPerMillion) +
    BigInt(metrics.cachedInputTokens) * BigInt(pricing.cachedInputMicrosPerMillion) +
    BigInt(metrics.reasoningTokens) * BigInt(pricing.reasoningMicrosPerMillion) +
    ordinaryOutput * BigInt(pricing.outputMicrosPerMillion);
  const cost = (numerator + 999_999n) / 1_000_000n + BigInt(pricing.fixedCallMicros);
  if (cost < 0 || cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProviderAttemptError("Provider attempt cost exceeds accounting bounds", {
      category: "invalid_response",
      transient: false,
    });
  }
  return Number(cost);
}

function requestId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
}

function policyFor(
  plan: ProviderExecutionPlan,
  remainingAttempts?: number,
  slowStream?: ProviderExecutionOptions["slowStream"],
): ResiliencePolicy {
  const policy = plan.retryPolicy;
  const configuredAttempts = policy?.maxAttempts ?? Math.max(1, Math.min(8, plan.targets.length));
  const maxAttempts = remainingAttempts ?? configuredAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > configuredAttempts) {
    throw new ProviderAttemptError("Provider execution attempt budget is exhausted", {
      category: "invalid_request",
      transient: false,
    });
  }
  return {
    maxRetries: Math.min(policy?.maxRetries ?? 0, maxAttempts - 1),
    baseDelayMs: policy?.baseDelayMs ?? 200,
    maxDelayMs: policy?.maxDelayMs ?? 2_000,
    backoffMultiplier: (policy?.backoffMultiplierBps ?? 20_000) / 10_000,
    jitterRatio: (policy?.jitterBps ?? 2_000) / 10_000,
    maxAttempts,
    // Circuit skips do not spend the physical-call budget, so one remaining call may still
    // traverse the complete frozen fallback path to find a runnable target.
    maxHops: Math.max(0, Math.min(7, plan.targets.length - 1)),
    totalTimeoutMs: policy?.totalTimeoutMs ?? 120_000,
    firstVisibleTimeoutMs: policy?.firstTokenTimeoutMs ?? 15_000,
    idleTimeoutMs: policy?.idleTimeoutMs ?? 30_000,
    maxPreVisibleChunks: 256,
    maxPreVisibleBytes: 4_194_304,
    circuitFailureThreshold: 3,
    circuitOpenMs: 30_000,
    ...(slowStream
      ? {
        slowWindowMs: slowStream.windowMs,
        minimumVisibleUnitsPerSecond: slowStream.minimumVisibleUnitsPerSecond,
      }
      : {}),
  };
}

function key(candidateId: string, context: Pick<AttemptContext, "attempt" | "hop" | "retry">) {
  return `${candidateId}:${context.attempt}:${context.hop}:${context.retry}`;
}

function breakerState(value: string | undefined): ProviderBreakerState | null {
  return value && ["closed", "open", "half_open", "unavailable"].includes(value)
    ? value as ProviderBreakerState
    : null;
}

function attemptReason(context: AttemptContext): ProviderAttemptReason {
  if (context.circuitState === "half_open") return "half_open";
  if (context.retry > 0) return "retry";
  return context.hop > 0 ? "fallback" : "primary";
}

function emptyMetrics(estimatedInput = 0): AttemptMetrics {
  return {
    dispatched: false,
    estimatedInputTokens: estimatedInput,
    providerInputTokens: null,
    providerOutputTokens: null,
    providerReasoningTokens: null,
    inputTokens: estimatedInput,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    upstreamRequestId: null,
    firstVisibleAt: null,
    visibleCharacters: 0,
    reasoningCharacters: 0,
    tokenSource: estimatedInput > 0 ? "estimated" : "none",
    audioVisibility: createAudioTranscriptVisibility(),
  };
}

function reconcileObservedTokens(metrics: AttemptMetrics) {
  const estimatedOutput = Math.ceil(metrics.visibleCharacters / 4);
  const estimatedReasoning = Math.ceil(metrics.reasoningCharacters / 4);
  metrics.inputTokens = metrics.providerInputTokens ?? metrics.estimatedInputTokens;
  metrics.outputTokens = Math.max(metrics.providerOutputTokens ?? 0, estimatedOutput);
  metrics.reasoningTokens = Math.min(
    metrics.outputTokens,
    Math.max(metrics.providerReasoningTokens ?? 0, estimatedReasoning),
  );
  metrics.cachedInputTokens = Math.min(metrics.cachedInputTokens, metrics.inputTokens);
  const providerCoversObservedOutput = metrics.providerOutputTokens !== null &&
    metrics.providerOutputTokens >= estimatedOutput &&
    (estimatedReasoning === 0 ||
      (metrics.providerReasoningTokens !== null &&
        metrics.providerReasoningTokens >= estimatedReasoning));
  metrics.tokenSource = metrics.providerInputTokens !== null && providerCoversObservedOutput
    ? "provider"
    : metrics.inputTokens > 0 || metrics.outputTokens > 0
    ? "estimated"
    : "none";
}

function observeChunk(metrics: AttemptMetrics, data: string, now: number) {
  if (data === "[DONE]") return;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  metrics.upstreamRequestId ??= requestId(value.id);
  const usage = value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
    ? value.usage as Record<string, unknown>
    : {};
  const prompt = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  const output = usage.completion_tokens_details &&
      typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : {};
  const hasPromptUsage = Number.isSafeInteger(usage.prompt_tokens) &&
    Number(usage.prompt_tokens) >= 0;
  const hasOutputUsage = Number.isSafeInteger(usage.completion_tokens) &&
    Number(usage.completion_tokens) >= 0;
  if (hasPromptUsage) metrics.providerInputTokens = safeCount(usage.prompt_tokens);
  if (hasOutputUsage) metrics.providerOutputTokens = safeCount(usage.completion_tokens);
  if (Number.isSafeInteger(prompt.cached_tokens) && Number(prompt.cached_tokens) >= 0) {
    metrics.cachedInputTokens = safeCount(prompt.cached_tokens);
  }
  if (Number.isSafeInteger(output.reasoning_tokens) && Number(output.reasoning_tokens) >= 0) {
    metrics.providerReasoningTokens = safeCount(output.reasoning_tokens);
  }
  const choices = Array.isArray(value.choices) ? value.choices : [];
  let characters = 0;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
    const delta = (choice as Record<string, unknown>).delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    const fields = delta as Record<string, unknown>;
    for (const name of ["content", "refusal"]) {
      if (typeof fields[name] === "string") characters += fields[name].length;
    }
    for (const name of ["reasoning_content", "reasoning"]) {
      if (typeof fields[name] === "string") {
        characters += fields[name].length;
        metrics.reasoningCharacters = Math.min(
          33_554_432,
          metrics.reasoningCharacters + fields[name].length,
        );
      }
    }
    if (Array.isArray(fields.tool_calls)) {
      characters += JSON.stringify(fields.tool_calls).length;
    }
  }
  metrics.visibleCharacters = Math.min(33_554_432, metrics.visibleCharacters + characters);
  reconcileObservedTokens(metrics);
  if (metrics.firstVisibleAt === null && openAIVisibleUnits(value) > 0) {
    metrics.firstVisibleAt = now;
  }
}

function audioFrameVisibleUnits(frame: Uint8Array, state: AudioTranscriptVisibility): number {
  try {
    return observeAudioTranscriptFrame(
      new TextDecoder("utf-8", { fatal: true }).decode(frame),
      state,
    ).newVisibleCharacters;
  } catch {
    return 0;
  }
}

function audioFrameType(frame: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame).trim();
    const event = JSON.parse(text.replace(/^data:\s*/, ""));
    return event && typeof event === "object" ? event.type : undefined;
  } catch {
    return undefined;
  }
}

function validateAudioUsagePricing(usage: AudioProviderUsage, pricing: UsagePricingSnapshot): void {
  if (
    usage.source === "provider_duration" &&
    (pricing.fixedCallMicros <= 0 || pricing.inputMicrosPerMillion > 0 ||
      pricing.cachedInputMicrosPerMillion > 0 || pricing.reasoningMicrosPerMillion > 0 ||
      pricing.outputMicrosPerMillion > 0)
  ) {
    throw new AudioProviderError(
      "Duration usage requires fixed-call-only model pricing",
      502,
      "unsupported_audio_usage",
    );
  }
}

function completionMetrics(result: Completion): AttemptMetrics {
  const upstream = result.upstream && typeof result.upstream === "object" &&
      !Array.isArray(result.upstream)
    ? result.upstream as Record<string, unknown>
    : {};
  const usage =
    upstream.usage && typeof upstream.usage === "object" && !Array.isArray(upstream.usage)
      ? upstream.usage as Record<string, unknown>
      : {};
  const providerInputTokens = Number.isSafeInteger(usage.prompt_tokens)
    ? safeCount(usage.prompt_tokens)
    : null;
  const providerOutputTokens = Number.isSafeInteger(usage.completion_tokens)
    ? safeCount(usage.completion_tokens)
    : null;
  const fullyProviderCounted = providerInputTokens !== null && providerOutputTokens !== null &&
    providerInputTokens === result.inputTokens && providerOutputTokens === result.outputTokens;
  return {
    dispatched: true,
    estimatedInputTokens: result.inputTokens,
    providerInputTokens,
    providerOutputTokens,
    providerReasoningTokens: result.reasoningTokens ?? null,
    inputTokens: result.inputTokens,
    cachedInputTokens: result.cachedInputTokens ?? 0,
    reasoningTokens: result.reasoningTokens ?? 0,
    outputTokens: result.outputTokens,
    upstreamRequestId: requestId(upstream.id),
    firstVisibleAt: null,
    visibleCharacters: result.text.length,
    reasoningCharacters: 0,
    tokenSource: fullyProviderCounted ? "provider" : "estimated",
    audioVisibility: createAudioTranscriptVisibility(),
  };
}

export class ProviderExecutionEngine {
  readonly #repository: DomainRepository;
  readonly #keyring: ProviderSecretKeyring;
  readonly #circuitBreaker: CircuitBreaker;
  readonly #breakerPolicy: BreakerPolicy;
  readonly #complete: typeof complete;
  readonly #stream: typeof streamChatCompletion;
  readonly #embeddingsFetch?: ProviderFetch;
  readonly #audioFetch?: typeof fetch;
  readonly #now: () => number;
  readonly #slowStream?: ProviderExecutionOptions["slowStream"];
  readonly #ocrCache: OcrCache;
  readonly #ocrFetch?: typeof fetch;
  readonly #ocrRecognize?: ProviderExecutionOptions["ocrRecognize"];

  constructor(options: ProviderExecutionOptions) {
    this.#repository = options.repository;
    this.#keyring = options.keyring;
    this.#circuitBreaker = options.circuitBreaker;
    this.#breakerPolicy = options.breakerPolicy;
    this.#complete = options.complete ?? complete;
    this.#stream = options.stream ?? streamChatCompletion;
    this.#embeddingsFetch = options.embeddingsFetch;
    this.#audioFetch = options.audioFetch;
    this.#now = options.now ?? Date.now;
    this.#slowStream = options.slowStream;
    this.#ocrCache = options.ocrCache ?? new MemoryOcrCache(options.now);
    this.#ocrFetch = options.ocrFetch;
    this.#ocrRecognize = options.ocrRecognize;
    if (this.#slowStream) {
      if (
        !Number.isSafeInteger(this.#slowStream.windowMs) || this.#slowStream.windowMs < 250 ||
        this.#slowStream.windowMs > 300_000 ||
        !Number.isFinite(this.#slowStream.minimumVisibleUnitsPerSecond) ||
        this.#slowStream.minimumVisibleUnitsPerSecond <= 0 ||
        this.#slowStream.minimumVisibleUnitsPerSecond > 1_000_000
      ) throw new TypeError("Slow-stream policy is outside its safe bounds");
    }
  }

  async resolvePlan(sourceModelId: string): Promise<ProviderExecutionPlan> {
    return await this.#repository.resolveProviderExecutionPlan(sourceModelId);
  }

  async #interceptOcr(
    sourceModelId: string,
    parentUsageRunId: string,
    ownerLeaseToken: string,
    request: ChatCompletionRequest,
    signal: AbortSignal,
    plan: ProviderExecutionPlan,
  ): Promise<ChatCompletionRequest> {
    const source = await this.#repository.findProviderModel(sourceModelId);
    const config = parseOcrInterceptionConfig(source?.customParams);
    if (!config) return request;
    const rewritten = await interceptOcrImages(request, config, {
      cache: this.#ocrCache,
      ...(this.#ocrFetch ? { fetch: this.#ocrFetch } : {}),
      recognize: async (input) => {
        if (this.#ocrRecognize) {
          return await this.#ocrRecognize({
            ...input,
            sourceModelId,
            parentUsageRunId,
            ownerLeaseToken,
          });
        }
        const { providerId, model, prompt, image, signal } = input;
        const provider = await this.#repository.findProvider(providerId);
        const ocrModel = await this.#repository.findProviderModel(model);
        if (
          !provider?.enabled || !ocrModel?.enabled || ocrModel.providerId !== provider.id ||
          !ocrModel.capabilities.includes("vision")
        ) throw new Error("Configured OCR provider/model is unavailable or lacks vision support");
        const encoded = Buffer.from(image.bytes).toString("base64");
        const ocrRequest: ChatCompletionRequest = {
          model: ocrModel.publicModelId,
          max_tokens: OCR_MAX_OUTPUT_TOKENS,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${image.mime};base64,${encoded}`, detail: "high" },
              },
            ],
          }],
        };
        if (parseOcrInterceptionConfig(ocrModel.customParams)) {
          throw new Error("Configured OCR model cannot recursively enable OCR interception");
        }
        const plan = await this.resolvePlan(ocrModel.id);
        const runId = crypto.randomUUID();
        const reserveMicros = this.reservationMicros(
          plan,
          estimateInputTokens(ocrRequest),
          OCR_MAX_OUTPUT_TOKENS,
        );
        const run = await this.#repository.reserveChildProviderUsage({
          parentUsageRunId,
          parentOwnerLeaseToken: ownerLeaseToken,
          runId,
          model: ocrModel.publicModelId,
          provider: `ocr:${provider.slug}`,
          reserveMicros,
          pricingSnapshot: plan.targets[0].pricing,
        });
        const childLease = run.runLeaseToken;
        if (!childLease) throw new Error("OCR usage reservation did not create an execution lease");
        const startedAt = this.#now();
        let claim: ProviderExecutionClaim | undefined;
        try {
          claim = await this.#repository.claimProviderExecution(runId, childLease);
          const result = await this.complete(
            ocrModel.id,
            runId,
            childLease,
            ocrRequest,
            signal,
            plan,
          );
          await this.#repository.settleProviderUsage({
            usageRunId: runId,
            ownerLeaseToken: childLease,
            executionEpoch: claim.executionEpoch,
            latencyMs: Math.max(0, this.#now() - startedAt),
          });
          return result.text;
        } catch (error) {
          if (claim) {
            await Promise.resolve(this.#repository.refundProviderUsage({
              usageRunId: runId,
              ownerLeaseToken: childLease,
              executionEpoch: claim.executionEpoch,
              latencyMs: Math.max(0, this.#now() - startedAt),
              error: error instanceof Error ? error.message.slice(0, 1_000) : "OCR failed",
            })).catch(() => undefined);
          } else {
            await this.#repository.refund(runId, "OCR failed before provider execution");
          }
          throw error;
        }
      },
    }, signal);
    const inputTokens = estimateInputTokens(rewritten);
    const contextRemaining = Math.max(0, source!.contextWindow - inputTokens);
    const requestedOutput = rewritten.max_completion_tokens ?? rewritten.max_tokens;
    const boundedOutput = requestedOutput === undefined
      ? contextRemaining
      : Math.min(requestedOutput, contextRemaining);
    await this.#repository.ensureUsageReservation({
      usageRunId: parentUsageRunId,
      ownerLeaseToken,
      requiredMicros: this.reservationMicros(plan, inputTokens, boundedOutput),
    });
    return rewritten;
  }

  reservationMicros(
    plan: ProviderExecutionPlan,
    inputTokens: number,
    outputTokens: number,
  ): number {
    if (
      !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0
    ) {
      throw new TypeError("Provider reservation token counts must be non-negative safe integers");
    }
    const attempts = policyFor(plan, undefined, this.#slowStream).maxAttempts;
    let largestAttempt = 0n;
    for (const target of plan.targets) {
      const pricing = target.pricing;
      const inputRate = BigInt(Math.max(
        pricing.inputMicrosPerMillion,
        pricing.cachedInputMicrosPerMillion,
      ));
      const outputRate = BigInt(Math.max(
        pricing.outputMicrosPerMillion,
        pricing.reasoningMicrosPerMillion,
      ));
      const variable = BigInt(inputTokens) * inputRate + BigInt(outputTokens) * outputRate;
      const cost = (variable + 999_999n) / 1_000_000n + BigInt(pricing.fixedCallMicros);
      if (cost > largestAttempt) largestAttempt = cost;
    }
    const reservation = largestAttempt * BigInt(attempts);
    if (reservation < 0n || reservation > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProviderAttemptError("Provider reservation exceeds accounting bounds", {
        category: "invalid_request",
        transient: false,
      });
    }
    return Number(reservation);
  }

  async #prepare(
    sourceModelId: string,
    frozenPlan?: ProviderExecutionPlan,
    capability: "chat" | "embeddings" | "transcription" | "translation" = "chat",
  ): Promise<{
    plan: ProviderExecutionPlan;
    candidates: Map<string, RuntimeCandidate>;
  }> {
    const plan = frozenPlan ?? await this.#repository.resolveProviderExecutionPlan(sourceModelId);
    if (plan.sourceModelId !== sourceModelId) {
      throw new ProviderAttemptError("Provider execution plan does not match the requested model", {
        category: "invalid_request",
        transient: false,
      });
    }
    const candidates = new Map<string, RuntimeCandidate>();
    for (const target of plan.targets) {
      if (capability === "chat" && target.protocol !== "chat_completions") {
        throw new ProviderAttemptError(
          "Native Responses provider execution is not enabled in this runtime",
          { category: "invalid_request", transient: false },
        );
      }
      const providerBefore = await this.#repository.findProvider(target.providerId);
      const modelBefore = await this.#repository.findProviderModel(target.providerModelId);
      const credential = await this.#repository.getProviderCredential(target.providerId);
      if (!credential || credential.providerId !== target.providerId) {
        throw new ProviderAttemptError("Provider execution plan changed before dispatch", {
          category: "invalid_request",
          transient: false,
        });
      }
      try {
        await this.#keyring.decrypt(
          target.providerId,
          credential.envelope as unknown as ProviderSecretEnvelope,
        );
      } catch {
        throw new ProviderAttemptError("Provider credential is unavailable", {
          category: "invalid_request",
          transient: false,
        });
      }
      const providerAfter = await this.#repository.findProvider(target.providerId);
      const modelAfter = await this.#repository.findProviderModel(target.providerModelId);
      const credentialAfter = await this.#repository.getProviderCredential(target.providerId);
      const stableCredential = credentialAfter?.providerId === credential.providerId &&
        Object.entries(credential.envelope).every(([name, value]) =>
          credentialAfter.envelope[name as keyof typeof credentialAfter.envelope] === value
        );
      const stableProvider = providerBefore && providerAfter &&
        providerBefore.version === target.providerVersion &&
        providerAfter.version === target.providerVersion &&
        providerBefore.baseUrl === providerAfter.baseUrl;
      const stableModel = modelBefore && modelAfter &&
        modelBefore.version === target.modelVersion && modelAfter.version === target.modelVersion &&
        modelBefore.providerId === target.providerId &&
        modelAfter.providerId === target.providerId &&
        modelBefore.upstreamModelId === target.upstreamModelId &&
        modelAfter.upstreamModelId === target.upstreamModelId &&
        modelBefore.capabilities.includes(capability) &&
        modelAfter.capabilities.includes(capability);
      if (!stableProvider || !stableModel || !stableCredential) {
        throw new ProviderAttemptError("Provider execution plan changed before dispatch", {
          category: "invalid_request",
          transient: false,
        });
      }
      candidates.set(target.providerModelId, {
        id: target.providerModelId,
        target,
        credentialEnvelope: structuredClone(credential.envelope) as unknown as Record<
          string,
          unknown
        >,
      });
    }
    const ordered = plan.targets;
    for (const [index, target] of ordered.entries()) {
      candidates.get(target.providerModelId)!.fallbackId = ordered[index + 1]?.providerModelId ??
        null;
    }
    if (!ordered.length) {
      throw new ProviderAttemptError("Provider execution plan has no runnable target", {
        category: "invalid_request",
        transient: false,
      });
    }
    // Preparing later fallbacks can take long enough for an earlier provider or credential to be
    // rotated. Fence the complete snapshot once more before any candidate may be dispatched.
    for (const candidate of candidates.values()) await this.#assertSnapshotCurrent(candidate);
    return { plan: { ...plan, targets: ordered }, candidates };
  }

  async #assertSnapshotCurrent(candidate: RuntimeCandidate): Promise<void> {
    const { target, credentialEnvelope } = candidate;
    const [provider, model, credential] = await Promise.all([
      this.#repository.findProvider(target.providerId),
      this.#repository.findProviderModel(target.providerModelId),
      this.#repository.getProviderCredential(target.providerId),
    ]);
    const stableCredential = credential?.providerId === target.providerId &&
      Object.entries(credentialEnvelope).every(([name, value]) =>
        credential.envelope[name as keyof typeof credential.envelope] === value
      ) && Object.keys(credential.envelope).length === Object.keys(credentialEnvelope).length;
    if (
      !provider || provider.version !== target.providerVersion || !provider.enabled ||
      !model || model.version !== target.modelVersion || !model.enabled ||
      model.providerId !== target.providerId || model.upstreamModelId !== target.upstreamModelId ||
      !stableCredential
    ) {
      throw new ProviderAttemptError("Provider execution plan changed before dispatch", {
        category: "invalid_request",
        transient: false,
      });
    }
  }

  async #upstreamFor(candidate: RuntimeCandidate): Promise<UpstreamStreamOptions> {
    await this.#assertSnapshotCurrent(candidate);
    const { target } = candidate;
    const providerBefore = await this.#repository.findProvider(target.providerId);
    const modelBefore = await this.#repository.findProviderModel(target.providerModelId);
    const credentialBefore = await this.#repository.getProviderCredential(target.providerId);
    if (!providerBefore || !modelBefore || !credentialBefore) {
      throw new ProviderAttemptError("Provider execution plan changed before dispatch", {
        category: "invalid_request",
        transient: false,
      });
    }
    let apiKey: string;
    try {
      apiKey = await this.#keyring.decrypt(
        target.providerId,
        credentialBefore.envelope as unknown as ProviderSecretEnvelope,
      );
    } catch {
      throw new ProviderAttemptError("Provider credential is unavailable", {
        category: "invalid_request",
        transient: false,
      });
    }
    const providerAfter = await this.#repository.findProvider(target.providerId);
    const modelAfter = await this.#repository.findProviderModel(target.providerModelId);
    const credentialAfter = await this.#repository.getProviderCredential(target.providerId);
    const sameCredential = credentialAfter &&
      JSON.stringify(credentialAfter.envelope) === JSON.stringify(credentialBefore.envelope) &&
      JSON.stringify(credentialAfter.envelope) === JSON.stringify(candidate.credentialEnvelope);
    if (
      !providerAfter || providerAfter.version !== providerBefore.version ||
      providerAfter.version !== target.providerVersion ||
      providerAfter.baseUrl !== providerBefore.baseUrl ||
      !modelAfter || modelAfter.version !== modelBefore.version ||
      modelAfter.version !== target.modelVersion ||
      modelAfter.upstreamModelId !== target.upstreamModelId || !sameCredential
    ) {
      apiKey = "";
      throw new ProviderAttemptError("Provider execution plan changed before dispatch", {
        category: "invalid_request",
        transient: false,
      });
    }
    return {
      baseUrl: providerAfter.baseUrl,
      apiKey,
      upstreamModel: target.upstreamModelId,
    };
  }

  #telemetry(
    usageRunId: string,
    ownerLeaseToken: string,
    claim: ProviderExecutionClaim,
    plan: ProviderExecutionPlan,
    metrics: Map<string, AttemptMetrics>,
    estimatedInput: number,
  ) {
    const attempts = new Map<string, { attempt: ProviderAttempt; startedAt: number }>();
    let pathOrdinal = claim.nextAttemptNumber - 1;
    const target = (id: string) => {
      const value = plan.targets.find((candidate) => candidate.providerModelId === id);
      if (!value) throw new Error("Provider execution target disappeared");
      return value;
    };
    return async (event: AttemptEvent) => {
      const targetSnapshot = target(event.candidateId);
      const eventKey = key(event.candidateId, event);
      if (event.type === "skipped") {
        const started = await this.#repository.startProviderAttempt({
          ...targetSnapshot,
          usageRunId,
          ownerLeaseToken,
          executionEpoch: claim.executionEpoch,
          attemptNumber: ++pathOrdinal,
          targetOrdinal: targetSnapshot.ordinal,
          retryNumber: event.retry,
          reason: "circuit_skip",
          breakerBefore: breakerState(event.circuitState),
        });
        await this.#repository.finishProviderAttempt({
          id: started.id,
          ownerLeaseToken,
          executionEpoch: claim.executionEpoch,
          status: "skipped",
          phase: "planning",
          errorCode: "circuit_open",
          visibleOutput: false,
          inputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          tokenSource: "none",
          costSource: "none",
          latencyMs: 0,
          breakerAfter: breakerState(event.circuitState),
          retryable: true,
        });
        return;
      }
      if (event.type === "started") {
        const context: AttemptContext = {
          attempt: event.attempt,
          hop: event.hop,
          retry: event.retry,
          circuitState: event.circuitState,
        };
        const started = await this.#repository.startProviderAttempt({
          ...targetSnapshot,
          usageRunId,
          ownerLeaseToken,
          executionEpoch: claim.executionEpoch,
          attemptNumber: ++pathOrdinal,
          targetOrdinal: targetSnapshot.ordinal,
          retryNumber: event.retry,
          reason: attemptReason(context),
          breakerBefore: breakerState(event.circuitState),
        });
        attempts.set(eventKey, { attempt: started, startedAt: this.#now() });
        metrics.set(eventKey, emptyMetrics(estimatedInput));
        return;
      }
      const started = attempts.get(eventKey);
      if (!started) throw new Error("Provider attempt telemetry start is missing");
      const observed = metrics.get(eventKey) ?? emptyMetrics();
      const latencyMs = Math.max(0, this.#now() - started.startedAt);
      const costMicros = !observed.dispatched
        ? 0
        : event.type === "succeeded" || observed.inputTokens > 0 || observed.outputTokens > 0
        ? pricingCost(targetSnapshot.pricing, observed)
        : targetSnapshot.pricing.fixedCallMicros;
      const ttftMs = observed.firstVisibleAt === null
        ? null
        : Math.max(0, observed.firstVisibleAt - started.startedAt);
      const finish: FinishProviderAttemptInput = {
        id: started.attempt.id,
        ownerLeaseToken,
        executionEpoch: claim.executionEpoch,
        status: event.type === "succeeded"
          ? "succeeded"
          : event.errorCategory === "aborted"
          ? "cancelled"
          : "failed",
        phase: event.type === "succeeded"
          ? "complete"
          : event.visibleOutput
          ? "streaming"
          : "complete",
        errorCode: event.errorCategory ?? null,
        httpStatus: event.httpStatus ?? null,
        visibleOutput: event.visibleOutput ?? false,
        inputTokens: observed.dispatched ? observed.inputTokens : 0,
        cachedInputTokens: observed.dispatched ? observed.cachedInputTokens : 0,
        reasoningTokens: observed.dispatched ? observed.reasoningTokens : 0,
        outputTokens: observed.dispatched ? observed.outputTokens : 0,
        costMicros,
        tokenSource: observed.dispatched ? observed.tokenSource : "none",
        costSource: observed.dispatched ? "calculated" : "none",
        latencyMs,
        ttftMs,
        breakerAfter: breakerState(event.breakerAfter),
        retryable: event.retryable ?? false,
        upstreamRequestId: observed.upstreamRequestId,
        tokensPerSecond: observed.outputTokens > 0 && ttftMs !== null && latencyMs - ttftMs > 0
          ? Math.min(
            1_000_000,
            Math.round(observed.outputTokens / ((latencyMs - ttftMs) / 1_000)),
          )
          : null,
      };
      let lastError: unknown;
      for (const delayMs of terminalPersistenceDelaysMs) {
        await accountingBackoff(delayMs);
        try {
          // The attempt id and complete terminal payload are deliberately reused. Both repository
          // implementations treat this as an idempotent replay, including when a commit succeeded
          // but its acknowledgement was lost.
          await this.#repository.finishProviderAttempt(finish);
          return;
        } catch (error) {
          lastError = error;
          if (!retryablePersistenceError(error)) break;
        }
      }
      throw new TerminalAccountingPersistenceError(lastError);
    };
  }

  #circuitStore(candidates: Map<string, RuntimeCandidate>): CircuitStore {
    const adapter = new CircuitBreakerStoreAdapter(this.#circuitBreaker, this.#breakerPolicy);
    const circuitId = (candidateId: string) => {
      const candidate = candidates.get(candidateId);
      if (!candidate) throw new TypeError("Provider execution circuit candidate is unavailable");
      return candidate.target.providerId;
    };
    return {
      acquire: (candidateId, policy) => adapter.acquire(circuitId(candidateId), policy),
      success: (candidateId, permit: CircuitPermit) =>
        adapter.success(circuitId(candidateId), permit),
      failure: (candidateId, permit: CircuitPermit, policy) =>
        adapter.failure(circuitId(candidateId), permit, policy),
    };
  }

  #normalizeError(error: unknown, plan: ProviderExecutionPlan): never {
    if (error instanceof AudioProviderError && error.providerStatus !== undefined) {
      const retryable = plan.retryPolicy?.retryableStatuses ?? defaultRetryableStatuses;
      if (!retryable.includes(error.providerStatus)) throw error;
      error = new ProviderAttemptError(error.message, {
        status: error.providerStatus,
        retryAfterMs: error.retryAfterMs,
      });
    }
    if (error instanceof ProviderAttemptError && error.options.status !== undefined) {
      const retryable = plan.retryPolicy?.retryableStatuses ?? defaultRetryableStatuses;
      if (!retryable.includes(error.options.status)) {
        throw new ProviderAttemptError(error.message, {
          ...error.options,
          transient: false,
        });
      }
    }
    throw error;
  }

  async complete(
    sourceModelId: string,
    usageRunId: string,
    ownerLeaseToken: string,
    request: ChatCompletionRequest,
    signal: AbortSignal,
    frozenPlan?: ProviderExecutionPlan,
  ): Promise<Completion> {
    const { plan, candidates } = await this.#prepare(sourceModelId, frozenPlan);
    request = await this.#interceptOcr(
      sourceModelId,
      usageRunId,
      ownerLeaseToken,
      request,
      signal,
      plan,
    );
    const claim = await this.#repository.claimProviderExecution(usageRunId, ownerLeaseToken);
    const remainingAttempts = policyFor(plan, undefined, this.#slowStream).maxAttempts -
      claim.consumedAttempts;
    const metrics = new Map<string, AttemptMetrics>();
    const upstreams = new Map<string, UpstreamStreamOptions>();
    const onAttempt = this.#telemetry(
      usageRunId,
      ownerLeaseToken,
      claim,
      plan,
      metrics,
      estimateInputTokens(request),
    );
    try {
      return await executeProviderRequest({
        initialCandidateId: plan.targets[0].providerModelId,
        resolveCandidate: (id) => candidates.get(id),
        policy: policyFor(plan, remainingAttempts, this.#slowStream),
        signal,
        circuitStore: this.#circuitStore(candidates),
        onAttempt,
        beforeAttempt: async (candidate, _signal, context) => {
          upstreams.set(
            key(candidate.id, context),
            await this.#upstreamFor(candidates.get(candidate.id)!),
          );
        },
        attempt: async (candidate, attemptSignal, context) => {
          try {
            const upstream = upstreams.get(key(candidate.id, context));
            upstreams.delete(key(candidate.id, context));
            if (!upstream) throw new Error("Provider dispatch options are missing");
            const observed = metrics.get(key(candidate.id, context));
            if (observed) observed.dispatched = true;
            const result = await this.#complete(request, attemptSignal, upstream);
            metrics.set(key(candidate.id, context), completionMetrics(result));
            return result;
          } catch (error) {
            this.#normalizeError(error, plan);
          }
        },
      });
    } catch (error) {
      this.#normalizeError(error, plan);
    }
  }

  async embeddings(
    sourceModelId: string,
    usageRunId: string,
    ownerLeaseToken: string,
    request: EmbeddingsRequest,
    signal: AbortSignal,
    frozenPlan?: ProviderExecutionPlan,
  ): Promise<EmbeddingsResponse> {
    const { plan, candidates } = await this.#prepare(sourceModelId, frozenPlan, "embeddings");
    const claim = await this.#repository.claimProviderExecution(usageRunId, ownerLeaseToken);
    const remainingAttempts = policyFor(plan, undefined, this.#slowStream).maxAttempts -
      claim.consumedAttempts;
    const estimatedInput = estimateInputTokens({ input: request.input });
    const metrics = new Map<string, AttemptMetrics>();
    const upstreams = new Map<string, UpstreamStreamOptions>();
    const onAttempt = this.#telemetry(
      usageRunId,
      ownerLeaseToken,
      claim,
      plan,
      metrics,
      estimatedInput,
    );
    try {
      return await executeProviderRequest({
        initialCandidateId: plan.targets[0].providerModelId,
        resolveCandidate: (id) => candidates.get(id),
        policy: policyFor(plan, remainingAttempts, this.#slowStream),
        signal,
        circuitStore: this.#circuitStore(candidates),
        onAttempt,
        beforeAttempt: async (candidate, _signal, context) => {
          upstreams.set(
            key(candidate.id, context),
            await this.#upstreamFor(candidates.get(candidate.id)!),
          );
        },
        attempt: async (candidate, attemptSignal, context) => {
          try {
            const upstream = upstreams.get(key(candidate.id, context));
            upstreams.delete(key(candidate.id, context));
            if (!upstream?.baseUrl || !upstream.apiKey || !upstream.upstreamModel) {
              throw new Error("Provider dispatch options are missing");
            }
            const observed = metrics.get(key(candidate.id, context)) ??
              emptyMetrics(estimatedInput);
            observed.dispatched = true;
            const result = await createEmbeddings(request, {
              baseUrl: upstream.baseUrl,
              apiKey: upstream.apiKey,
              upstreamModel: upstream.upstreamModel,
              publicModel: request.model,
              signal: attemptSignal,
              fetch: this.#embeddingsFetch,
            });
            observed.providerInputTokens = result.usage.prompt_tokens;
            observed.providerOutputTokens = 0;
            observed.inputTokens = result.usage.prompt_tokens;
            observed.outputTokens = 0;
            observed.tokenSource = "provider";
            metrics.set(key(candidate.id, context), observed);
            return result;
          } catch (error) {
            this.#normalizeError(error, plan);
          }
        },
      });
    } catch (error) {
      this.#normalizeError(error, plan);
    }
  }

  async audio(
    endpoint: AudioEndpoint,
    sourceModelId: string,
    usageRunId: string,
    ownerLeaseToken: string,
    request: AudioRequest,
    signal: AbortSignal,
    frozenPlan?: ProviderExecutionPlan,
  ): Promise<AudioProviderResponse> {
    const capability = endpoint === "transcriptions" ? "transcription" : "translation";
    const { plan, candidates } = await this.#prepare(sourceModelId, frozenPlan, capability);
    const claim = await this.#repository.claimProviderExecution(usageRunId, ownerLeaseToken);
    const remainingAttempts = policyFor(plan, undefined, this.#slowStream).maxAttempts -
      claim.consumedAttempts;
    const metrics = new Map<string, AttemptMetrics>();
    const upstreams = new Map<string, UpstreamStreamOptions>();
    const onAttempt = this.#telemetry(
      usageRunId,
      ownerLeaseToken,
      claim,
      plan,
      metrics,
      estimateAudioInputTokens(request),
    );
    if (request.stream) {
      let resilienceVisibility = createAudioTranscriptVisibility();
      let resolveUsage!: (usage: AudioProviderUsage) => void;
      let rejectUsage!: (error: unknown) => void;
      let resolveTerminal!: (frame: Uint8Array) => void;
      let rejectTerminal!: (error: unknown) => void;
      const usage = new Promise<AudioProviderUsage>(
        (resolve, reject) => {
          resolveUsage = resolve;
          rejectUsage = reject;
        },
      );
      void usage.catch(() => undefined);
      const terminalFrame = new Promise<Uint8Array>((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      });
      void terminalFrame.catch(() => undefined);
      let finalUsage: AudioProviderUsage = {
        inputTokens: 0,
        outputTokens: 0,
        source: "estimated",
      };
      const stream = (async function* (engine: ProviderExecutionEngine) {
        let usageSettled = false;
        let terminalSettled = false;
        let terminal: Uint8Array | undefined;
        try {
          const orchestrated = streamProviderRequest<Uint8Array>({
            initialCandidateId: plan.targets[0].providerModelId,
            resolveCandidate: (id) => candidates.get(id),
            policy: policyFor(plan, remainingAttempts, engine.#slowStream),
            signal,
            circuitStore: engine.#circuitStore(candidates),
            onAttempt,
            visibleUnits: (frame) => audioFrameVisibleUnits(frame, resilienceVisibility),
            allowNoVisibleOutput: true,
            beforeAttempt: async (candidate, _signal, context) => {
              resilienceVisibility = createAudioTranscriptVisibility();
              upstreams.set(
                key(candidate.id, context),
                await engine.#upstreamFor(candidates.get(candidate.id)!),
              );
            },
            attempt: async function* (candidate, attemptSignal, context) {
              try {
                const upstream = upstreams.get(key(candidate.id, context));
                upstreams.delete(key(candidate.id, context));
                if (!upstream?.baseUrl || !upstream.apiKey || !upstream.upstreamModel) {
                  throw new Error("Provider dispatch options are missing");
                }
                const observed = metrics.get(key(candidate.id, context)) ?? emptyMetrics(0);
                observed.dispatched = true;
                metrics.set(key(candidate.id, context), observed);
                const result = await createAudioTranscription(endpoint, request, {
                  baseUrl: upstream.baseUrl,
                  apiKey: upstream.apiKey,
                  upstreamModel: upstream.upstreamModel,
                  signal: attemptSignal,
                  fetch: engine.#audioFetch,
                });
                if (!result.stream || !result.usage) {
                  throw new Error("Provider dispatch did not return an audio stream");
                }
                for await (const frame of result.stream) {
                  const visibility = observeAudioTranscriptFrame(
                    new TextDecoder("utf-8", { fatal: true }).decode(frame),
                    observed.audioVisibility,
                  );
                  const visibleUnits = visibility.newVisibleCharacters;
                  if (visibleUnits > 0 && observed.firstVisibleAt === null) {
                    observed.firstVisibleAt = engine.#now();
                  }
                  observed.visibleCharacters = visibility.totalCharacters;
                  reconcileObservedTokens(observed);
                  yield frame;
                }
                const providerUsage = await result.usage;
                validateAudioUsagePricing(
                  providerUsage,
                  candidates.get(candidate.id)!.target.pricing,
                );
                observed.providerInputTokens = providerUsage.inputTokens;
                observed.providerOutputTokens = providerUsage.outputTokens;
                observed.inputTokens = providerUsage.inputTokens;
                observed.outputTokens = providerUsage.outputTokens;
                observed.tokenSource = providerUsage.source === "estimated"
                  ? "estimated"
                  : providerUsage.source === "provider_tokens"
                  ? "provider"
                  : "none";
                finalUsage = providerUsage;
              } catch (error) {
                engine.#normalizeError(error, plan);
              }
            },
          });
          for await (const frame of orchestrated) {
            if (audioFrameType(frame) === "transcript.text.done") terminal = frame;
            else yield frame;
          }
          if (!terminal) throw new Error("Provider stream terminal event is missing");
          usageSettled = true;
          resolveUsage(finalUsage);
          terminalSettled = true;
          resolveTerminal(terminal);
        } catch (error) {
          usageSettled = true;
          rejectUsage(error);
          terminalSettled = true;
          rejectTerminal(error);
          throw error;
        } finally {
          if (!usageSettled) {
            rejectUsage(new DOMException("Audio stream consumer disconnected", "AbortError"));
          }
          if (!terminalSettled) {
            rejectTerminal(new DOMException("Audio stream consumer disconnected", "AbortError"));
          }
        }
      })(this);
      return { contentType: "text/event-stream", stream, terminalFrame, usage };
    }
    try {
      return await executeProviderRequest({
        initialCandidateId: plan.targets[0].providerModelId,
        resolveCandidate: (id) => candidates.get(id),
        policy: policyFor(plan, remainingAttempts, this.#slowStream),
        signal,
        circuitStore: this.#circuitStore(candidates),
        onAttempt,
        beforeAttempt: async (candidate, _signal, context) => {
          upstreams.set(
            key(candidate.id, context),
            await this.#upstreamFor(candidates.get(candidate.id)!),
          );
        },
        attempt: async (candidate, attemptSignal, context) => {
          try {
            const upstream = upstreams.get(key(candidate.id, context));
            upstreams.delete(key(candidate.id, context));
            if (!upstream?.baseUrl || !upstream.apiKey || !upstream.upstreamModel) {
              throw new Error("Provider dispatch options are missing");
            }
            const observed = metrics.get(key(candidate.id, context)) ?? emptyMetrics(0);
            observed.dispatched = true;
            observed.inputTokens = 0;
            observed.outputTokens = 0;
            observed.tokenSource = "none";
            metrics.set(key(candidate.id, context), observed);
            const result = await createAudioTranscription(endpoint, request, {
              baseUrl: upstream.baseUrl,
              apiKey: upstream.apiKey,
              upstreamModel: upstream.upstreamModel,
              signal: attemptSignal,
              fetch: this.#audioFetch,
            });
            const providerUsage = await result.usage ?? {
              inputTokens: 0,
              outputTokens: 0,
              source: "estimated" as const,
            };
            validateAudioUsagePricing(
              providerUsage,
              candidates.get(candidate.id)!.target.pricing,
            );
            observed.providerInputTokens = providerUsage.inputTokens;
            observed.providerOutputTokens = providerUsage.outputTokens;
            observed.inputTokens = providerUsage.inputTokens;
            observed.outputTokens = providerUsage.outputTokens;
            observed.tokenSource = providerUsage.source === "estimated"
              ? "estimated"
              : providerUsage.source === "provider_tokens"
              ? "provider"
              : "none";
            return result;
          } catch (error) {
            this.#normalizeError(error, plan);
          }
        },
      });
    } catch (error) {
      this.#normalizeError(error, plan);
    }
  }

  async *#observeStream(
    upstream: AsyncIterable<string>,
    observed: AttemptMetrics,
    plan: ProviderExecutionPlan,
  ): AsyncGenerator<string> {
    try {
      for await (const data of upstream) {
        observeChunk(observed, data, this.#now());
        yield data;
      }
    } catch (error) {
      this.#normalizeError(error, plan);
    }
  }

  async *stream(
    sourceModelId: string,
    usageRunId: string,
    ownerLeaseToken: string,
    request: ChatCompletionRequest,
    signal: AbortSignal,
    frozenPlan?: ProviderExecutionPlan,
  ): AsyncGenerator<string> {
    const { plan, candidates } = await this.#prepare(sourceModelId, frozenPlan);
    request = await this.#interceptOcr(
      sourceModelId,
      usageRunId,
      ownerLeaseToken,
      request,
      signal,
      plan,
    );
    const claim = await this.#repository.claimProviderExecution(usageRunId, ownerLeaseToken);
    const remainingAttempts = policyFor(plan, undefined, this.#slowStream).maxAttempts -
      claim.consumedAttempts;
    const metrics = new Map<string, AttemptMetrics>();
    const upstreams = new Map<string, UpstreamStreamOptions>();
    const onAttempt = this.#telemetry(
      usageRunId,
      ownerLeaseToken,
      claim,
      plan,
      metrics,
      estimateInputTokens(request),
    );
    try {
      yield* streamProviderRequest({
        initialCandidateId: plan.targets[0].providerModelId,
        resolveCandidate: (id) => candidates.get(id),
        policy: policyFor(plan, remainingAttempts, this.#slowStream),
        signal,
        circuitStore: this.#circuitStore(candidates),
        onAttempt,
        visibleUnits: openAIVisibleUnits,
        beforeAttempt: async (candidate, _signal, context) => {
          upstreams.set(
            key(candidate.id, context),
            await this.#upstreamFor(candidates.get(candidate.id)!),
          );
        },
        attempt: (candidate, attemptSignal, context) => {
          const upstreamOptions = upstreams.get(key(candidate.id, context));
          upstreams.delete(key(candidate.id, context));
          if (!upstreamOptions) throw new Error("Provider dispatch options are missing");
          const observed = metrics.get(key(candidate.id, context)) ??
            emptyMetrics(estimateInputTokens(request));
          observed.dispatched = true;
          const upstream = this.#stream(request, attemptSignal, upstreamOptions);
          metrics.set(key(candidate.id, context), observed);
          return this.#observeStream(upstream, observed, plan);
        },
      });
    } catch (error) {
      this.#normalizeError(error, plan);
    }
  }
}
