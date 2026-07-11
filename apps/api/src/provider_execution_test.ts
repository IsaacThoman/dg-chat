import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import type { ModelCapability } from "@dg-chat/contracts";
import { MemoryCircuitBreaker } from "./provider-circuit.ts";
import {
  ProviderExecutionEngine,
  TerminalAccountingPersistenceError,
} from "./provider-execution.ts";
import { ProviderAttemptError } from "./provider-resilience.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

Deno.test("provider execution retries through the breaker, falls back, and persists exact attempts", async () => {
  const repo = new MemoryRepository();
  const user = repo.bootstrapAdmin({
    email: "executor@example.com",
    name: "Executor",
    passwordHash: "not-used",
  }, 50_000_000);
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(6)]]),
  });
  const mutation = { actorId: user.id, action: "test.resilience" };
  const createTarget = async (slug: string, inputRate = 100_000) => {
    const created = repo.createProvider({
      slug,
      displayName: slug,
      baseUrl: `https://${slug}.example/v1`,
      protocol: "chat_completions",
    }, mutation);
    const provider = repo.setProviderCredential(created.id, created.version, {
      envelope: await keyring.encrypt(created.id, created.version + 1, `${slug}-secret`),
    }, mutation);
    const model = repo.createProviderModel({
      providerId: provider.id,
      publicModelId: `${slug}/chat`,
      upstreamModelId: `${slug}-upstream`,
      displayName: `${slug} chat`,
      capabilities: ["chat", "streaming", "tools"],
      contextWindow: 32_000,
    }, mutation);
    const price = repo.createModelPriceVersion({
      providerModelId: model.id,
      expectedModelVersion: model.version,
      effectiveAt: "2026-01-01T00:00:00.000Z",
      inputMicrosPerMillion: inputRate,
      cachedInputMicrosPerMillion: 50_000,
      reasoningMicrosPerMillion: 200_000,
      outputMicrosPerMillion: 300_000,
      fixedCallMicros: 10,
      source: "test",
    }, mutation);
    return { provider, model, price };
  };
  const primary = await createTarget("primary-exec");
  const fallback = await createTarget("fallback-exec", 100_000_003);
  const retryPolicy = repo.createProviderRetryPolicy({
    name: "Executor policy",
    maxAttempts: 3,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplierBps: 20_000,
    jitterBps: 0,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 10_000,
    retryableStatuses: [503],
  }, mutation);
  repo.setProviderModelRoute({
    sourceModelId: primary.model.id,
    expectedVersion: 0,
    retryPolicyId: retryPolicy.id,
    fallbackModelIds: [fallback.model.id],
  }, mutation);
  const runId = "provider-execution-test";
  const executionRun = repo.reserve(
    user.id,
    runId,
    primary.model.publicModelId,
    1_000_000,
    primary.provider.slug,
    undefined,
    {
      pricingVersionId: primary.price.id,
      inputMicrosPerMillion: primary.price.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: primary.price.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: primary.price.reasoningMicrosPerMillion,
      outputMicrosPerMillion: primary.price.outputMicrosPerMillion,
      fixedCallMicros: primary.price.fixedCallMicros,
      source: primary.price.source,
    },
  );
  if (!executionRun.runLeaseToken) throw new Error("execution lease missing");
  const calls: string[] = [];
  const breaker = new MemoryCircuitBreaker();
  const engine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: breaker,
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    complete: (_request, _signal, options) => {
      const upstreamModel = options?.upstreamModel ?? "missing";
      calls.push(upstreamModel);
      if (upstreamModel === primary.model.upstreamModelId) {
        return Promise.reject(new ProviderAttemptError("busy", { status: 503 }));
      }
      return Promise.resolve({
        text: "fallback won",
        inputTokens: 100_000_007,
        outputTokens: 20,
        cachedInputTokens: 10,
        reasoningTokens: 5,
        upstream: { id: "chatcmpl_fallback" },
      });
    },
  });
  const frozenPlan = await engine.resolvePlan(primary.model.id);
  const boundInputTokens = 32_000;
  const boundOutputTokens = 4_000;
  const highestInputRate = Math.max(
    fallback.price.inputMicrosPerMillion,
    fallback.price.cachedInputMicrosPerMillion,
  );
  const highestOutputRate = Math.max(
    fallback.price.outputMicrosPerMillion,
    fallback.price.reasoningMicrosPerMillion,
  );
  const boundNumerator = BigInt(boundInputTokens) * BigInt(highestInputRate) +
    BigInt(boundOutputTokens) * BigInt(highestOutputRate);
  const highestAttemptBound = Number((boundNumerator + 999_999n) / 1_000_000n) +
    fallback.price.fixedCallMicros;
  assertEquals(
    engine.reservationMicros(frozenPlan, boundInputTokens, boundOutputTokens),
    highestAttemptBound * retryPolicy.maxAttempts,
  );
  const result = await engine.complete(
    primary.model.id,
    runId,
    executionRun.runLeaseToken,
    {
      model: primary.model.publicModelId,
      messages: [{ role: "user", content: "hello" }],
    },
    new AbortController().signal,
    frozenPlan,
  );
  assertEquals(result.text, "fallback won");
  assertEquals(calls, [primary.model.upstreamModelId, fallback.model.upstreamModelId]);
  const attempts = repo.listProviderAttempts(runId);
  assertEquals(
    attempts.map((attempt) => ({
      ordinal: attempt.attemptNumber,
      target: attempt.providerModelId,
      reason: attempt.reason,
      status: attempt.status,
      breakerBefore: attempt.breakerBefore,
      breakerAfter: attempt.breakerAfter,
      retryable: attempt.retryable,
    })),
    [
      {
        ordinal: 1,
        target: primary.model.id,
        reason: "primary",
        status: "failed",
        breakerBefore: "closed",
        breakerAfter: "open",
        retryable: true,
      },
      {
        ordinal: 2,
        target: primary.model.id,
        reason: "circuit_skip",
        status: "skipped",
        breakerBefore: "open",
        breakerAfter: "open",
        retryable: true,
      },
      {
        ordinal: 3,
        target: fallback.model.id,
        reason: "fallback",
        status: "succeeded",
        breakerBefore: "closed",
        breakerAfter: "closed",
        retryable: false,
      },
    ],
  );
  assertEquals(attempts[2].upstreamRequestId, "chatcmpl_fallback");
  assertEquals(attempts[2].inputTokens, 100_000_007);
  assertEquals(attempts[2].outputTokens, 20);
  assertEquals(attempts[2].costSource, "calculated");
  const expectedNumerator = BigInt(100_000_007 - 10) * 100_000_003n + 10n * 50_000n +
    5n * 200_000n + 15n * 300_000n;
  assertEquals(attempts[2].costMicros, Number((expectedNumerator + 999_999n) / 1_000_000n + 10n));
  assertEquals(attempts[2].ttftMs, null);
  assertEquals(attempts[2].tokensPerSecond, null);

  executionRun.runLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  const reclaimed = repo.reclaimProviderExecutionLease(runId, executionRun.runLeaseToken);
  await engine.complete(
    primary.model.id,
    runId,
    reclaimed.leaseToken,
    { model: primary.model.publicModelId, messages: [{ role: "user", content: "resume" }] },
    new AbortController().signal,
    frozenPlan,
  );
  assertEquals(calls.length, 3);
  repo.usageRuns.get(runId)!.runLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  const exhausted = repo.reclaimProviderExecutionLease(runId, reclaimed.leaseToken);
  await assertRejects(
    () =>
      engine.complete(
        primary.model.id,
        runId,
        exhausted.leaseToken,
        { model: primary.model.publicModelId, messages: [{ role: "user", content: "again" }] },
        new AbortController().signal,
        frozenPlan,
      ),
    ProviderAttemptError,
    "budget is exhausted",
  );
  assertEquals(calls.length, 3);

  const sharedModel = repo.createProviderModel({
    providerId: primary.provider.id,
    publicModelId: "primary-exec/shared",
    upstreamModelId: "shared-upstream",
    displayName: "Shared provider model",
    capabilities: ["chat", "streaming", "tools"],
    contextWindow: 32_000,
  }, mutation);
  const sharedPrice = repo.createModelPriceVersion({
    providerModelId: sharedModel.id,
    expectedModelVersion: sharedModel.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 100_000,
    cachedInputMicrosPerMillion: 50_000,
    reasoningMicrosPerMillion: 200_000,
    outputMicrosPerMillion: 300_000,
    fixedCallMicros: 10,
    source: "test",
  }, mutation);
  const sharedRun = "provider-shared-circuit";
  const sharedUsageRun = repo.reserve(
    user.id,
    sharedRun,
    sharedModel.publicModelId,
    1_000_000,
    primary.provider.slug,
    undefined,
    {
      pricingVersionId: sharedPrice.id,
      inputMicrosPerMillion: sharedPrice.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: sharedPrice.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: sharedPrice.reasoningMicrosPerMillion,
      outputMicrosPerMillion: sharedPrice.outputMicrosPerMillion,
      fixedCallMicros: sharedPrice.fixedCallMicros,
      source: sharedPrice.source,
    },
  );
  if (!sharedUsageRun.runLeaseToken) throw new Error("shared execution lease missing");
  await assertRejects(() =>
    engine.complete(
      sharedModel.id,
      sharedRun,
      sharedUsageRun.runLeaseToken!,
      {
        model: sharedModel.publicModelId,
        messages: [{ role: "user", content: "must be skipped" }],
      },
      new AbortController().signal,
    )
  );
  assertEquals(calls.includes(sharedModel.upstreamModelId), false);

  const streamRun = "provider-usage-less-stream";
  const streamUsageRun = repo.reserve(
    user.id,
    streamRun,
    fallback.model.publicModelId,
    1_000_000,
    fallback.provider.slug,
    undefined,
    {
      pricingVersionId: fallback.price.id,
      inputMicrosPerMillion: fallback.price.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: fallback.price.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: fallback.price.reasoningMicrosPerMillion,
      outputMicrosPerMillion: fallback.price.outputMicrosPerMillion,
      fixedCallMicros: fallback.price.fixedCallMicros,
      source: fallback.price.source,
    },
  );
  if (!streamUsageRun.runLeaseToken) throw new Error("stream execution lease missing");
  const toolCalls = [{
    index: 0,
    id: "call_1",
    type: "function",
    function: { name: "lookup", arguments: '{"city":"NYC"}' },
  }];
  const streamEngine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: breaker,
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    stream: async function* () {
      yield JSON.stringify({
        choices: [{
          delta: {
            content: "answer",
            reasoning_content: "thinking",
            refusal: "declined",
            tool_calls: toolCalls,
          },
        }],
      });
      yield "[DONE]";
    },
  });
  for await (
    const _chunk of streamEngine.stream(
      fallback.model.id,
      streamRun,
      streamUsageRun.runLeaseToken,
      {
        model: fallback.model.publicModelId,
        messages: [{ role: "user", content: "stream" }],
        stream: true,
      },
      new AbortController().signal,
    )
  ) { /* consume */ }
  const streamAttempt = repo.listProviderAttempts(streamRun)[0];
  assertEquals(streamAttempt.tokenSource, "estimated");
  assertEquals(streamAttempt.inputTokens > 0, true);
  assertEquals(streamAttempt.outputTokens > 0, true);
  assertEquals(streamAttempt.reasoningTokens > 0, true);

  const providerUsageRun = "provider-final-stream-usage";
  const providerFinalUsageRun = repo.reserve(
    user.id,
    providerUsageRun,
    fallback.model.publicModelId,
    1_000_000,
    fallback.provider.slug,
    undefined,
    {
      pricingVersionId: fallback.price.id,
      inputMicrosPerMillion: fallback.price.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: fallback.price.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: fallback.price.reasoningMicrosPerMillion,
      outputMicrosPerMillion: fallback.price.outputMicrosPerMillion,
      fixedCallMicros: fallback.price.fixedCallMicros,
      source: fallback.price.source,
    },
  );
  if (!providerFinalUsageRun.runLeaseToken) throw new Error("provider usage lease missing");
  const providerUsageEngine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: breaker,
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    stream: async function* () {
      yield JSON.stringify({ choices: [{ delta: { content: "estimated first" } }] });
      yield JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 17,
          completion_tokens: 9,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      });
      yield "[DONE]";
    },
  });
  for await (
    const _chunk of providerUsageEngine.stream(
      fallback.model.id,
      providerUsageRun,
      providerFinalUsageRun.runLeaseToken,
      {
        model: fallback.model.publicModelId,
        messages: [{ role: "user", content: "replace estimates" }],
        stream: true,
      },
      new AbortController().signal,
    )
  ) { /* consume */ }
  const providerUsageAttempt = repo.listProviderAttempts(providerUsageRun)[0];
  assertEquals(providerUsageAttempt.tokenSource, "provider");
  assertEquals(providerUsageAttempt.inputTokens, 17);
  assertEquals(providerUsageAttempt.cachedInputTokens, 4);
  assertEquals(providerUsageAttempt.outputTokens, 9);
  assertEquals(providerUsageAttempt.reasoningTokens, 3);

  const reservePartialRun = (runId: string) => {
    const run = repo.reserve(
      user.id,
      runId,
      fallback.model.publicModelId,
      1_000_000,
      fallback.provider.slug,
      undefined,
      {
        pricingVersionId: fallback.price.id,
        inputMicrosPerMillion: fallback.price.inputMicrosPerMillion,
        cachedInputMicrosPerMillion: fallback.price.cachedInputMicrosPerMillion,
        reasoningMicrosPerMillion: fallback.price.reasoningMicrosPerMillion,
        outputMicrosPerMillion: fallback.price.outputMicrosPerMillion,
        fixedCallMicros: fallback.price.fixedCallMicros,
        source: fallback.price.source,
      },
    );
    if (!run.runLeaseToken) throw new Error("partial usage execution lease missing");
    return run.runLeaseToken;
  };

  const partialStreamRun = "provider-partial-stream-usage";
  const partialStreamLease = reservePartialRun(partialStreamRun);
  const partialStreamEngine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 3,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    stream: async function* () {
      yield JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 23, completion_tokens: 1 },
      });
      yield JSON.stringify({ choices: [{ delta: { content: "output after early usage" } }] });
      yield "[DONE]";
    },
  });
  for await (
    const _chunk of partialStreamEngine.stream(
      fallback.model.id,
      partialStreamRun,
      partialStreamLease,
      {
        model: fallback.model.publicModelId,
        messages: [{ role: "user", content: "partial stream" }],
        stream: true,
      },
      new AbortController().signal,
    )
  ) { /* consume */ }
  const partialStreamAttempt = repo.listProviderAttempts(partialStreamRun)[0];
  assertEquals(partialStreamAttempt.inputTokens, 23);
  assertEquals(partialStreamAttempt.outputTokens > 1, true);
  assertEquals(partialStreamAttempt.tokenSource, "estimated");

  const partialCompleteRun = "provider-partial-complete-usage";
  const partialCompleteLease = reservePartialRun(partialCompleteRun);
  const partialCompleteEngine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 3,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    complete: () =>
      Promise.resolve({
        text: "completion estimated from output",
        inputTokens: 19,
        outputTokens: 8,
        upstream: {
          id: "partial-complete",
          choices: [{ message: { content: "completion estimated from output" } }],
          usage: { prompt_tokens: 19 },
        },
      }),
  });
  await partialCompleteEngine.complete(
    fallback.model.id,
    partialCompleteRun,
    partialCompleteLease,
    {
      model: fallback.model.publicModelId,
      messages: [{ role: "user", content: "partial complete" }],
    },
    new AbortController().signal,
  );
  const partialCompleteAttempt = repo.listProviderAttempts(partialCompleteRun)[0];
  assertEquals(partialCompleteAttempt.inputTokens, 19);
  assertEquals(partialCompleteAttempt.outputTokens, 8);
  assertEquals(partialCompleteAttempt.tokenSource, "estimated");

  const dispatchTarget = await createTarget("dispatch-fence");
  const dispatchRun = "provider-dispatch-fence";
  const dispatchUsage = repo.reserve(
    user.id,
    dispatchRun,
    dispatchTarget.model.publicModelId,
    1_000_000,
    dispatchTarget.provider.slug,
    undefined,
    {
      pricingVersionId: dispatchTarget.price.id,
      inputMicrosPerMillion: dispatchTarget.price.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: dispatchTarget.price.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: dispatchTarget.price.reasoningMicrosPerMillion,
      outputMicrosPerMillion: dispatchTarget.price.outputMicrosPerMillion,
      fixedCallMicros: dispatchTarget.price.fixedCallMicros,
      source: dispatchTarget.price.source,
    },
  );
  if (!dispatchUsage.runLeaseToken) throw new Error("dispatch execution lease missing");
  const originalClaim = repo.claimProviderExecution.bind(repo);
  let dispatchCalls = 0;
  Object.defineProperty(repo, "claimProviderExecution", {
    configurable: true,
    value: (usageRunId: string, ownerLeaseToken: string) => {
      const claim = originalClaim(usageRunId, ownerLeaseToken);
      if (usageRunId === dispatchRun) {
        const current = repo.findProvider(dispatchTarget.provider.id)!;
        repo.updateProvider(dispatchTarget.provider.id, current.version, {
          baseUrl: "https://rotated-after-prepare.example/v1",
        }, mutation);
      }
      return claim;
    },
  });
  try {
    const dispatchEngine = new ProviderExecutionEngine({
      repository: repo,
      keyring,
      circuitBreaker: new MemoryCircuitBreaker(),
      breakerPolicy: {
        failureThreshold: 1,
        failureWindowSeconds: 60,
        openSeconds: 30,
        halfOpenLeaseSeconds: 5,
      },
      complete: () => {
        dispatchCalls++;
        return Promise.resolve({ text: "unsafe", inputTokens: 1, outputTokens: 1 });
      },
    });
    await assertRejects(
      () =>
        dispatchEngine.complete(
          dispatchTarget.model.id,
          dispatchRun,
          dispatchUsage.runLeaseToken!,
          {
            model: dispatchTarget.model.publicModelId,
            messages: [{ role: "user", content: "rotate after prepare" }],
          },
          new AbortController().signal,
        ),
      ProviderAttemptError,
      "changed before dispatch",
    );
    assertEquals(dispatchCalls, 0);
  } finally {
    Object.defineProperty(repo, "claimProviderExecution", {
      configurable: true,
      value: originalClaim,
    });
  }

  const rotationRun = "provider-credential-rotation";
  const rotationUsageRun = repo.reserve(
    user.id,
    rotationRun,
    fallback.model.publicModelId,
    1_000_000,
    fallback.provider.slug,
    undefined,
    {
      pricingVersionId: fallback.price.id,
      inputMicrosPerMillion: fallback.price.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: fallback.price.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: fallback.price.reasoningMicrosPerMillion,
      outputMicrosPerMillion: fallback.price.outputMicrosPerMillion,
      fixedCallMicros: fallback.price.fixedCallMicros,
      source: fallback.price.source,
    },
  );
  if (!rotationUsageRun.runLeaseToken) throw new Error("rotation execution lease missing");
  const originalCredentialReader = repo.getProviderCredential.bind(repo);
  let rotated = false;
  let rotationCalls = 0;
  Object.defineProperty(repo, "getProviderCredential", {
    configurable: true,
    value: (providerId: string) => {
      const credential = originalCredentialReader(providerId);
      if (providerId === fallback.provider.id && !rotated) {
        rotated = true;
        const current = repo.findProvider(providerId);
        if (!current) throw new Error("provider disappeared during rotation test");
        repo.updateProvider(providerId, current.version, {
          baseUrl: "https://rotated-fallback.example/v1",
        }, mutation);
      }
      return credential;
    },
  });
  try {
    const rotationEngine = new ProviderExecutionEngine({
      repository: repo,
      keyring,
      circuitBreaker: new MemoryCircuitBreaker(),
      breakerPolicy: {
        failureThreshold: 1,
        failureWindowSeconds: 60,
        openSeconds: 30,
        halfOpenLeaseSeconds: 5,
      },
      complete: () => {
        rotationCalls += 1;
        return Promise.resolve({
          text: "must not dispatch",
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          upstream: {},
        });
      },
    });
    await assertRejects(
      () =>
        rotationEngine.complete(
          fallback.model.id,
          rotationRun,
          rotationUsageRun.runLeaseToken!,
          {
            model: fallback.model.publicModelId,
            messages: [{ role: "user", content: "rotate now" }],
          },
          new AbortController().signal,
        ),
      ProviderAttemptError,
      "changed before dispatch",
    );
    assertEquals(rotationCalls, 0);
  } finally {
    Object.defineProperty(repo, "getProviderCredential", {
      configurable: true,
      value: originalCredentialReader,
    });
  }
});

async function singleProviderFixture(
  protocol: "chat_completions" | "responses",
  capabilities: ModelCapability[] = ["chat"],
  fixedCallOnly = false,
) {
  const repo = new MemoryRepository();
  const user = repo.bootstrapAdmin({
    email: `${protocol}@example.com`,
    name: protocol,
    passwordHash: "not-used",
  }, 10_000_000);
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(9)]]),
  });
  const mutation = { actorId: user.id, action: "test.execution-guard" };
  const created = repo.createProvider({
    slug: `single-${protocol.replace("_", "-")}`,
    displayName: protocol,
    baseUrl: "https://single.example/v1",
    protocol,
  }, mutation);
  const provider = repo.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "secret"),
  }, mutation);
  const model = repo.createProviderModel({
    providerId: provider.id,
    publicModelId: `single/${protocol}`,
    upstreamModelId: "single-upstream",
    displayName: "Single",
    capabilities,
    contextWindow: 8_192,
  }, mutation);
  const price = repo.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: fixedCallOnly ? 0 : 100_000,
    cachedInputMicrosPerMillion: fixedCallOnly ? 0 : 50_000,
    reasoningMicrosPerMillion: fixedCallOnly ? 0 : 200_000,
    outputMicrosPerMillion: fixedCallOnly ? 0 : 300_000,
    fixedCallMicros: 10,
    source: "test",
  }, mutation);
  const runId = `single-${protocol}`;
  const run = repo.reserve(user.id, runId, model.publicModelId, 1_000_000, provider.slug);
  if (!run.runLeaseToken) throw new Error("execution lease missing");
  return { repo, user, keyring, provider, model, price, runId, run };
}

Deno.test("speech provider execution retries 429, preserves telemetry, and requires capability and fixed pricing", async () => {
  const fixture = await singleProviderFixture("chat_completions", ["speech"], true);
  const mutation = { actorId: fixture.user.id, action: "test.speech-execution" };
  const retryPolicy = fixture.repo.createProviderRetryPolicy({
    name: "Speech retry",
    maxAttempts: 2,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplierBps: 10_000,
    jitterBps: 0,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 10_000,
    retryableStatuses: [429],
  }, mutation);
  fixture.repo.setProviderModelRoute({
    sourceModelId: fixture.model.id,
    expectedVersion: 0,
    retryPolicyId: retryPolicy.id,
    fallbackModelIds: [],
  }, mutation);
  let calls = 0;
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 10,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    speechFetch: ((_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      assertEquals((JSON.parse(String(init?.body)) as { model: string }).model, "single-upstream");
      if (calls === 1) {
        return Promise.resolve(
          new Response("busy", { status: 429, headers: { "retry-after": "0" } }),
        );
      }
      return Promise.resolve(
        new Response(
          new Uint8Array([
            73,
            68,
            51,
            4,
            0,
            0,
            0,
            0,
            0,
            0,
            0xff,
            0xfb,
            0x90,
            0x64,
          ]).buffer,
          {
            headers: { "content-type": "audio/mpeg" },
          },
        ),
      );
    }) as typeof fetch,
  });
  const result = await engine.speech(
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    {
      model: fixture.model.publicModelId,
      input: "Retry safely",
      voice: "alloy",
      responseFormat: "mp3",
      speed: 1,
      streamFormat: "audio",
    },
    new AbortController().signal,
  );
  assertEquals(
    result.body,
    new Uint8Array([
      73,
      68,
      51,
      4,
      0,
      0,
      0,
      0,
      0,
      0,
      0xff,
      0xfb,
      0x90,
      0x64,
    ]),
  );
  assertEquals(calls, 2);
  const attempts = fixture.repo.listProviderAttempts(fixture.runId);
  assertEquals(attempts.map(({ status }) => status), ["failed", "succeeded"]);
  assertEquals(attempts[0].httpStatus, 429);
  assertEquals(attempts[0].retryable, true);
  assertEquals(attempts[1].tokenSource, "estimated");
  assertEquals(attempts[1].costMicros, fixture.price.fixedCallMicros);
  assertEquals(attempts[1].ttftMs !== null, true);

  const variable = await singleProviderFixture("chat_completions", ["speech"]);
  const variableEngine = new ProviderExecutionEngine({
    repository: variable.repo,
    keyring: variable.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
  });
  await assertRejects(
    () =>
      variableEngine.speech(
        variable.model.id,
        variable.runId,
        variable.run.runLeaseToken!,
        {
          model: variable.model.publicModelId,
          input: "Unsafe pricing",
          voice: "alloy",
          responseFormat: "mp3",
          speed: 1,
          streamFormat: "audio",
        },
        new AbortController().signal,
      ),
    Error,
    "fixed-call-only",
  );
});

Deno.test("audio streaming attempts remain active through final usage and persist truthful telemetry", async () => {
  const fixture = await singleProviderFixture("chat_completions", ["transcription"]);
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    audioFetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"type":"transcript.text.delta","delta":"hello"}\n\n',
              ));
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(
                  'data: {"type":"transcript.text.done","text":"hello","usage":{"input_tokens":11,"output_tokens":4}}\n\n',
                ));
                controller.close();
              }, 20);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  const response = await engine.audio(
    "transcriptions",
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    {
      model: fixture.model.publicModelId,
      file: new Uint8Array([1]),
      filename: "sample.wav",
      mime: "audio/wav",
      fileSha256: "a".repeat(64),
      responseFormat: "json",
      stream: true,
    },
    new AbortController().signal,
  );
  const iterator = response.stream![Symbol.asyncIterator]();
  const frames: Uint8Array[] = [];
  const first = await iterator.next();
  if (!first.done) frames.push(first.value);
  assertEquals(fixture.repo.listProviderAttempts(fixture.runId)[0]?.status, "running");
  while (true) {
    const item = await iterator.next();
    if (item.done) break;
    frames.push(item.value);
  }
  assertEquals(frames.length, 1);
  assertEquals(await response.usage, {
    inputTokens: 11,
    outputTokens: 4,
    source: "provider_tokens",
  });
  assertEquals(
    new TextDecoder().decode(await response.terminalFrame).includes("transcript.text.done"),
    true,
  );
  const attempt = fixture.repo.listProviderAttempts(fixture.runId)[0];
  assertEquals(attempt.status, "succeeded");
  assertEquals(attempt.visibleOutput, true);
  assertEquals(attempt.inputTokens, 11);
  assertEquals(attempt.outputTokens, 4);
  assertEquals(attempt.tokenSource, "provider");
  assertEquals(attempt.ttftMs !== null, true);
});

Deno.test("non-stream audio persists provider-reported usage in attempt telemetry", async () => {
  const fixture = await singleProviderFixture("chat_completions", ["transcription"]);
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    audioFetch: () =>
      Promise.resolve(Response.json({
        text: "complete",
        usage: { type: "tokens", input_tokens: 13, output_tokens: 6, total_tokens: 19 },
      })),
  });
  await engine.audio(
    "transcriptions",
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    {
      model: fixture.model.publicModelId,
      file: new Uint8Array([1]),
      filename: "sample.wav",
      mime: "audio/wav",
      fileSha256: "a".repeat(64),
      responseFormat: "json",
    },
    new AbortController().signal,
  );
  const attempt = fixture.repo.listProviderAttempts(fixture.runId)[0];
  assertEquals(attempt.status, "succeeded");
  assertEquals(attempt.inputTokens, 13);
  assertEquals(attempt.outputTokens, 6);
  assertEquals(attempt.tokenSource, "provider");
});

Deno.test("audio streaming retries when terminal-tail validation fails before visible output", async () => {
  const fixture = await singleProviderFixture("chat_completions", ["transcription"]);
  const policy = fixture.repo.createProviderRetryPolicy({
    name: "Audio first-event retry",
    maxAttempts: 2,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplierBps: 10_000,
    jitterBps: 0,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    retryableStatuses: [502],
  }, { actorId: fixture.user.id, action: "test.audio-retry" });
  fixture.repo.setProviderModelRoute({
    sourceModelId: fixture.model.id,
    expectedVersion: 0,
    retryPolicyId: policy.id,
    fallbackModelIds: [],
  }, { actorId: fixture.user.id, action: "test.audio-retry" });
  let calls = 0;
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 2,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    audioFetch: () => {
      calls++;
      return Promise.resolve(
        new Response(
          calls === 1
            ? 'data: {"type":"transcript.text.done","text":"discarded"}\n\n' +
              'data: {"type":"transcript.text.delta","delta":"invalid tail"}\n\n'
            : 'data: {"type":"transcript.text.done","text":"recovered","usage":{"input_tokens":5,"output_tokens":2}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  });
  const response = await engine.audio(
    "transcriptions",
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    {
      model: fixture.model.publicModelId,
      file: new Uint8Array([1]),
      filename: "sample.wav",
      mime: "audio/wav",
      fileSha256: "a".repeat(64),
      responseFormat: "json",
      stream: true,
    },
    new AbortController().signal,
  );
  const frames: string[] = [];
  for await (const frame of response.stream!) frames.push(new TextDecoder().decode(frame));
  assertEquals(calls, 2);
  assertEquals(frames.length, 0);
  assertEquals(await response.usage, {
    inputTokens: 5,
    outputTokens: 2,
    source: "provider_tokens",
  });
  assertEquals(
    new TextDecoder().decode(await response.terminalFrame).includes("recovered"),
    true,
  );
  const attempts = fixture.repo.listProviderAttempts(fixture.runId);
  assertEquals(attempts.map((attempt) => attempt.status), ["failed", "succeeded"]);
  assertEquals(attempts[0].visibleOutput, false);
  assertEquals(attempts[1].visibleOutput, false);
});

Deno.test("audio resilience preserves upstream 429 and honors Retry-After before retry", async () => {
  const fixture = await singleProviderFixture("chat_completions", ["transcription"]);
  const policy = fixture.repo.createProviderRetryPolicy({
    name: "Audio rate limit retry",
    maxAttempts: 2,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplierBps: 10_000,
    jitterBps: 0,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    retryableStatuses: [429],
  }, { actorId: fixture.user.id, action: "test.audio-rate-limit" });
  fixture.repo.setProviderModelRoute({
    sourceModelId: fixture.model.id,
    expectedVersion: 0,
    retryPolicyId: policy.id,
    fallbackModelIds: [],
  }, { actorId: fixture.user.id, action: "test.audio-rate-limit" });
  const callTimes: number[] = [];
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 2,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    audioFetch: () => {
      callTimes.push(performance.now());
      if (callTimes.length === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0.01" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          'data: {"type":"transcript.text.done","text":"ok","usage":{"input_tokens":1,"output_tokens":1}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  });
  const response = await engine.audio(
    "transcriptions",
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    {
      model: fixture.model.publicModelId,
      file: new Uint8Array([1]),
      filename: "sample.wav",
      mime: "audio/wav",
      fileSha256: "a".repeat(64),
      responseFormat: "json",
      stream: true,
    },
    new AbortController().signal,
  );
  for await (const _frame of response.stream!) { /* consume */ }
  await response.terminalFrame;
  assertEquals(callTimes.length, 2);
  assertEquals(callTimes[1] - callTimes[0] >= 8, true);
  const attempts = fixture.repo.listProviderAttempts(fixture.runId);
  assertEquals(attempts[0].httpStatus, 429);
  assertEquals(attempts.map((attempt) => attempt.status), ["failed", "succeeded"]);
});

Deno.test("provider execution rejects native Responses targets before dispatch", async () => {
  const fixture = await singleProviderFixture("responses");
  let calls = 0;
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    complete: () => {
      calls++;
      throw new Error("must not dispatch");
    },
  });
  await assertRejects(
    () =>
      engine.complete(
        fixture.model.id,
        fixture.runId,
        fixture.run.runLeaseToken!,
        { model: fixture.model.publicModelId, messages: [{ role: "user", content: "hello" }] },
        new AbortController().signal,
      ),
    ProviderAttemptError,
    "Native Responses provider execution is not enabled",
  );
  assertEquals(calls, 0);
  assertEquals(fixture.repo.listProviderAttempts(fixture.runId), []);
});

Deno.test("terminal attempt persistence retries idempotently without another provider call", async () => {
  const fixture = await singleProviderFixture("chat_completions");
  const originalFinish = fixture.repo.finishProviderAttempt.bind(fixture.repo);
  const payloads: string[] = [];
  let finishCalls = 0;
  Object.defineProperty(fixture.repo, "finishProviderAttempt", {
    configurable: true,
    value: (input: Parameters<typeof originalFinish>[0]) => {
      payloads.push(JSON.stringify(input));
      finishCalls++;
      if (finishCalls <= 2) throw new Error("transient database outage");
      return originalFinish(input);
    },
  });
  let providerCalls = 0;
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    complete: () => {
      providerCalls++;
      return Promise.resolve({
        text: "done",
        inputTokens: 100,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        outputTokens: 20,
        upstream: { id: "chatcmpl_once", usage: { prompt_tokens: 100, completion_tokens: 20 } },
      });
    },
  });
  const result = await engine.complete(
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    { model: fixture.model.publicModelId, messages: [{ role: "user", content: "hello" }] },
    new AbortController().signal,
  );
  assertEquals(result.text, "done");
  assertEquals(providerCalls, 1);
  assertEquals(finishCalls, 3);
  assertEquals(new Set(payloads).size, 1);
  const expectedCost = 26;
  assertEquals(fixture.repo.listProviderAttempts(fixture.runId)[0].costMicros, expectedCost);
  assertEquals(fixture.repo.usageRuns.get(fixture.runId)?.actualProviderCostMicros, expectedCost);
});

Deno.test("exhausted terminal accounting persistence is distinct and never redispatches", async () => {
  const fixture = await singleProviderFixture("chat_completions");
  Object.defineProperty(fixture.repo, "finishProviderAttempt", {
    configurable: true,
    value: () => {
      throw new Error("database unavailable");
    },
  });
  let providerCalls = 0;
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    complete: () => {
      providerCalls++;
      return Promise.resolve({
        text: "paid",
        inputTokens: 10,
        outputTokens: 5,
        upstream: { id: "chatcmpl_paid" },
      });
    },
  });
  await assertRejects(
    () =>
      engine.complete(
        fixture.model.id,
        fixture.runId,
        fixture.run.runLeaseToken!,
        { model: fixture.model.publicModelId, messages: [{ role: "user", content: "hello" }] },
        new AbortController().signal,
      ),
    TerminalAccountingPersistenceError,
  );
  assertEquals(providerCalls, 1);
  assertEquals(fixture.repo.usageRuns.get(fixture.runId)?.status, "reserved");
  const runningAttempt = structuredClone(fixture.repo.listProviderAttempts(fixture.runId)[0]);
  const balanceBeforeReap = fixture.repo.users.get(fixture.user.id)!.balanceMicros;
  fixture.repo.usageRuns.get(fixture.runId)!.runLeaseExpiresAt = new Date(
    Date.now() - 1,
  ).toISOString();
  assertEquals(fixture.repo.reapStaleProviderExecutionLeases(), 1);
  const reaped = fixture.repo.usageRuns.get(fixture.runId)!;
  assertEquals({ status: reaped.status, costMicros: reaped.costMicros }, {
    status: "failed",
    costMicros: 0,
  });
  assertEquals(
    fixture.repo.users.get(fixture.user.id)!.balanceMicros,
    balanceBeforeReap + reaped.reservedMicros,
  );
  assertEquals(
    fixture.repo.listProviderAttempts(fixture.runId).map((attempt) => ({
      status: attempt.status,
      errorCode: attempt.errorCode,
    })),
    [{ status: "cancelled", errorCode: "accounting_unknown" }],
  );

  const api = fixture.repo.beginApiRequest({
    userId: fixture.user.id,
    endpoint: "chat.completions",
    idempotencyKey: "uncertain-api-reaper",
    requestHash: "d".repeat(64),
    stream: false,
    model: fixture.model.publicModelId,
    provider: fixture.provider.slug,
    runId: "uncertain-api-run",
    reserveMicros: 100,
  });
  if (api.kind !== "started") throw new Error("API request did not start");
  fixture.repo.usageRuns.get(api.usageRun.id)!.executionEpoch = 1;
  fixture.repo.providerAttempts.set(crypto.randomUUID(), {
    ...structuredClone(runningAttempt),
    id: crypto.randomUUID(),
    usageRunId: api.usageRun.id,
    executionEpoch: 1,
  });
  fixture.repo.apiIdempotencyRequests.get(api.request.id)!.leaseExpiresAt = new Date(
    Date.now() - 1,
  ).toISOString();
  const apiBalance = fixture.repo.users.get(fixture.user.id)!.balanceMicros;
  assertEquals(fixture.repo.reapStaleApiRequests(), 1);
  assertEquals(fixture.repo.usageRuns.get(api.usageRun.id)?.costMicros, 0);
  assertEquals(fixture.repo.users.get(fixture.user.id)!.balanceMicros, apiBalance + 100);

  const conversation = fixture.repo.createConversation(fixture.user.id, "Uncertain generation");
  const generation = fixture.repo.beginGeneration({
    message: {
      conversationId: conversation.id,
      ownerId: fixture.user.id,
      parentId: null,
      role: "user",
      content: "hello",
      model: fixture.model.publicModelId,
      expectedVersion: conversation.version,
      idempotencyKey: "uncertain-generation-user",
    },
    runId: "uncertain-generation-run",
    provider: fixture.provider.slug,
    reserveMicros: 100,
  });
  if (generation.kind !== "started") throw new Error("generation did not start");
  generation.usageRun.executionEpoch = 1;
  fixture.repo.providerAttempts.set(crypto.randomUUID(), {
    ...structuredClone(runningAttempt),
    id: crypto.randomUUID(),
    usageRunId: generation.usageRun.id,
    executionEpoch: 1,
  });
  generation.usageRun.generationLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  const generationBalance = fixture.repo.users.get(fixture.user.id)!.balanceMicros;
  assertEquals(fixture.repo.reapStaleGenerations(), 1);
  assertEquals(fixture.repo.usageRuns.get(generation.usageRun.id)?.costMicros, 0);
  assertEquals(fixture.repo.users.get(fixture.user.id)!.balanceMicros, generationBalance + 100);
});

Deno.test("engine slow-stream policy cuts off visible streams without retry", async () => {
  const fixture = await singleProviderFixture("chat_completions");
  const policy = fixture.repo.createProviderRetryPolicy({
    name: "Slow stream integration",
    maxAttempts: 2,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplierBps: 10_000,
    jitterBps: 0,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    retryableStatuses: [504],
  }, { actorId: fixture.user.id, action: "test.slow-stream" });
  fixture.repo.setProviderModelRoute({
    sourceModelId: fixture.model.id,
    expectedVersion: 0,
    retryPolicyId: policy.id,
    fallbackModelIds: [],
  }, { actorId: fixture.user.id, action: "test.slow-stream-route" });
  let calls = 0;
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    slowStream: { windowMs: 250, minimumVisibleUnitsPerSecond: 1_000 },
    stream: async function* () {
      calls++;
      yield JSON.stringify({ choices: [{ delta: { content: "a" } }] });
      await new Promise((resolve) => setTimeout(resolve, 275));
      yield JSON.stringify({ choices: [{ delta: { content: "b" } }] });
    },
  });
  await assertRejects(
    async () => {
      for await (
        const _chunk of engine.stream(
          fixture.model.id,
          fixture.runId,
          fixture.run.runLeaseToken!,
          {
            model: fixture.model.publicModelId,
            messages: [{ role: "user", content: "slow" }],
            stream: true,
          },
          new AbortController().signal,
        )
      ) { /* consume first visible chunk */ }
    },
    ProviderAttemptError,
    "minimum throughput",
  );
  assertEquals(calls, 1);
  const attempt = fixture.repo.listProviderAttempts(fixture.runId)[0];
  assertEquals(attempt.visibleOutput, true);
  assertEquals(attempt.breakerAfter, "open");
});

Deno.test("image generation execution enforces capability and persists provider usage telemetry", async () => {
  const fixture = await singleProviderFixture("chat_completions", ["image_generation"], true);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
  let sentModel = "";
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 2,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    imageFetch: (_input, init) => {
      sentModel = (JSON.parse(String(init?.body)) as { model: string }).model;
      return Promise.resolve(Response.json({
        created: 1_700_000_000,
        data: [{ b64_json: png }],
        usage: { input_tokens: 7, output_tokens: 13, total_tokens: 20 },
      }));
    },
  });
  const response = await engine.imageGenerate(
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    {
      model: fixture.model.publicModelId,
      prompt: "a safe robot",
      n: 1,
      background: "auto",
      moderation: "auto",
      outputCompression: 100,
      outputFormat: "png",
      partialImages: 0,
      quality: "auto",
      responseFormat: "b64_json",
      size: "auto",
      stream: false,
      style: "vivid",
    },
    new AbortController().signal,
  );
  assertEquals(sentModel, "single-upstream");
  assertEquals(response.data?.[0].width, 1);
  assertEquals(await response.executionTarget, {
    providerModelId: fixture.model.id,
    publicModelId: fixture.model.publicModelId,
    upstreamModelId: fixture.model.upstreamModelId,
    providerSlug: fixture.provider.slug,
  });
  const attempt = fixture.repo.listProviderAttempts(fixture.runId)[0];
  assertEquals(attempt.status, "succeeded");
  assertEquals(attempt.inputTokens, 7);
  assertEquals(attempt.outputTokens, 13);
  assertEquals(attempt.tokenSource, "provider");

  const wrongCapability = await singleProviderFixture("chat_completions", ["chat"]);
  const wrongEngine = new ProviderExecutionEngine({
    repository: wrongCapability.repo,
    keyring: wrongCapability.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 1,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
  });
  await assertRejects(
    () =>
      wrongEngine.imageGenerate(
        wrongCapability.model.id,
        wrongCapability.runId,
        wrongCapability.run.runLeaseToken!,
        {
          model: wrongCapability.model.publicModelId,
          prompt: "robot",
          n: 1,
          background: "auto",
          moderation: "auto",
          outputCompression: 100,
          outputFormat: "png",
          partialImages: 0,
          quality: "auto",
          responseFormat: "b64_json",
          size: "auto",
          stream: false,
          style: "vivid",
        },
        new AbortController().signal,
      ),
    Error,
    "changed before dispatch",
  );
});

Deno.test("image generation reports the actual winning fallback target", async () => {
  const fixture = await singleProviderFixture("chat_completions", ["image_generation"], true);
  const mutation = { actorId: fixture.user.id, action: "test.image-fallback" };
  const createdProvider = fixture.repo.createProvider({
    slug: "image-fallback",
    displayName: "Image fallback",
    baseUrl: "https://image-fallback.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const fallbackProvider = fixture.repo.setProviderCredential(
    createdProvider.id,
    createdProvider.version,
    {
      envelope: await fixture.keyring.encrypt(
        createdProvider.id,
        createdProvider.version + 1,
        "fallback-secret",
      ),
    },
    mutation,
  );
  const fallbackModel = fixture.repo.createProviderModel({
    providerId: fallbackProvider.id,
    publicModelId: "image-fallback/artist",
    upstreamModelId: "fallback-artist-v2",
    displayName: "Fallback artist",
    capabilities: ["image_generation"],
    contextWindow: 8_192,
  }, mutation);
  fixture.repo.createModelPriceVersion({
    providerModelId: fallbackModel.id,
    expectedModelVersion: fallbackModel.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 20,
    source: "fallback-test",
  }, mutation);
  const policy = fixture.repo.createProviderRetryPolicy({
    name: "Image fallback policy",
    maxAttempts: 2,
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplierBps: 10_000,
    jitterBps: 0,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 10_000,
    retryableStatuses: [500],
  }, mutation);
  fixture.repo.setProviderModelRoute({
    sourceModelId: fixture.model.id,
    expectedVersion: 0,
    retryPolicyId: policy.id,
    fallbackModelIds: [fallbackModel.id],
  }, mutation);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
  const calls: string[] = [];
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 2,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    imageFetch: (_input, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      calls.push(model);
      return Promise.resolve(
        model === fixture.model.upstreamModelId
          ? new Response("failed", { status: 500 })
          : Response.json({ created: 123, data: [{ b64_json: png }] }),
      );
    },
  });
  const result = await engine.imageGenerate(
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    {
      model: fixture.model.publicModelId,
      prompt: "fallback",
      n: 1,
      background: "auto",
      moderation: "auto",
      outputCompression: 100,
      outputFormat: "png",
      partialImages: 0,
      quality: "auto",
      responseFormat: "b64_json",
      size: "auto",
      stream: false,
      style: "vivid",
    },
    new AbortController().signal,
  );
  assertEquals(calls, [fixture.model.upstreamModelId, fallbackModel.upstreamModelId]);
  assertEquals(await result.executionTarget, {
    providerModelId: fallbackModel.id,
    publicModelId: fallbackModel.publicModelId,
    upstreamModelId: fallbackModel.upstreamModelId,
    providerSlug: fallbackProvider.slug,
  });
});

Deno.test("engine persists a truthful half-open transition after a successful probe", async () => {
  const fixture = await singleProviderFixture("chat_completions");
  let now = 0;
  const breaker = new MemoryCircuitBreaker({ now: () => now });
  const breakerPolicy = {
    failureThreshold: 1,
    failureWindowSeconds: 60,
    openSeconds: 1,
    halfOpenLeaseSeconds: 5,
  };
  const closedPermit = await breaker.beforeAttempt(fixture.provider.id, breakerPolicy);
  await breaker.recordFailure(fixture.provider.id, closedPermit, breakerPolicy);
  now = 1_001;
  const engine = new ProviderExecutionEngine({
    repository: fixture.repo,
    keyring: fixture.keyring,
    circuitBreaker: breaker,
    breakerPolicy,
    complete: () =>
      Promise.resolve({
        text: "probe recovered",
        inputTokens: 4,
        outputTokens: 3,
        upstream: {
          id: "chatcmpl_probe",
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        },
      }),
  });
  await engine.complete(
    fixture.model.id,
    fixture.runId,
    fixture.run.runLeaseToken!,
    { model: fixture.model.publicModelId, messages: [{ role: "user", content: "probe" }] },
    new AbortController().signal,
  );
  const attempt = fixture.repo.listProviderAttempts(fixture.runId)[0];
  assertEquals(attempt.breakerBefore, "half_open");
  assertEquals(attempt.breakerAfter, "closed");
});
