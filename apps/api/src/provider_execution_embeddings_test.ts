import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { MemoryCircuitBreaker } from "./provider-circuit.ts";
import { ProviderExecutionEngine } from "./provider-execution.ts";
import { ProviderAttemptError } from "./provider-resilience.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

async function fixture(retryableStatuses: number[] = []) {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: `embedding-engine-${crypto.randomUUID()}@example.com`,
    name: "Embedding engine",
    passwordHash: "not-used",
  }, 10_000_000);
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(4)]]),
  });
  const mutation = { actorId: user.id, action: "test.embedding-engine" };
  const created = repository.createProvider({
    slug: `embedding-${crypto.randomUUID()}`,
    displayName: "Embedding provider",
    baseUrl: "https://embedding-engine.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: `embedding/${crypto.randomUUID()}`,
    upstreamModelId: "embedding-upstream",
    displayName: "Embedding model",
    capabilities: ["embeddings"],
    contextWindow: 8_192,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 100_000,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 10,
    source: "test",
  }, mutation);
  if (retryableStatuses.length) {
    const policy = repository.createProviderRetryPolicy({
      name: "Embedding retry",
      maxAttempts: 4,
      maxRetries: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplierBps: 10_000,
      jitterBps: 0,
      firstTokenTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 10_000,
      retryableStatuses,
    }, mutation);
    repository.setProviderModelRoute({
      sourceModelId: model.id,
      expectedVersion: 0,
      retryPolicyId: policy.id,
      fallbackModelIds: [],
    }, mutation);
  }
  const runId = `embedding-run-${crypto.randomUUID()}`;
  const run = repository.reserve(user.id, runId, model.publicModelId, 1_000_000, provider.slug);
  if (!run.runLeaseToken) throw new Error("execution lease missing");
  return { repository, keyring, model, runId, lease: run.runLeaseToken };
}

const breakerPolicy = {
  failureThreshold: 10,
  failureWindowSeconds: 60,
  openSeconds: 30,
  halfOpenLeaseSeconds: 5,
};

Deno.test("embedding execution retries classified malformed 408/429/5xx responses with truthful accounting", async () => {
  const value = await fixture([408, 429, 500]);
  let calls = 0;
  const engine = new ProviderExecutionEngine({
    repository: value.repository,
    keyring: value.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy,
    embeddingsFetch: () => {
      calls++;
      if (calls === 1) return Promise.resolve(new Response("{", { status: 408 }));
      if (calls === 2) {
        return Promise.resolve(
          new Response("not-json", { status: 429, headers: { "retry-after": "0" } }),
        );
      }
      if (calls === 3) return Promise.resolve(new Response("{", { status: 500 }));
      return Promise.resolve(Response.json({
        object: "list",
        data: [{ object: "embedding", embedding: [0.25, -0.5], index: 0 }],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }));
    },
  });
  const result = await engine.embeddings(
    value.model.id,
    value.runId,
    value.lease,
    { model: value.model.publicModelId, input: "hello" },
    new AbortController().signal,
  );
  assertEquals(result.usage.prompt_tokens, 7);
  assertEquals(calls, 4);
  const attempts = value.repository.listProviderAttempts(value.runId);
  assertEquals(
    attempts.map((attempt) => ({
      status: attempt.status,
      httpStatus: attempt.httpStatus,
      retryable: attempt.retryable,
      inputTokens: attempt.inputTokens,
      costMicros: attempt.costMicros,
    })),
    [
      { status: "failed", httpStatus: 408, retryable: true, inputTokens: 17, costMicros: 12 },
      { status: "failed", httpStatus: 429, retryable: true, inputTokens: 17, costMicros: 12 },
      { status: "failed", httpStatus: 500, retryable: true, inputTokens: 17, costMicros: 12 },
      { status: "succeeded", httpStatus: null, retryable: false, inputTokens: 7, costMicros: 11 },
    ],
  );
});

Deno.test("definitive embedding HTTP rejections preserve status and record zero dispatch cost", async () => {
  for (const status of [401, 422]) {
    const value = await fixture();
    const engine = new ProviderExecutionEngine({
      repository: value.repository,
      keyring: value.keyring,
      circuitBreaker: new MemoryCircuitBreaker(),
      breakerPolicy,
      embeddingsFetch: () => Promise.resolve(new Response("not-json", { status })),
    });
    const error = await assertRejects(() =>
      engine.embeddings(
        value.model.id,
        value.runId,
        value.lease,
        { model: value.model.publicModelId, input: "hello" },
        new AbortController().signal,
      ), ProviderAttemptError);
    assertEquals((error as ProviderAttemptError).options.status, status);
    const attempt = value.repository.listProviderAttempts(value.runId)[0];
    assertEquals({
      status: attempt.status,
      httpStatus: attempt.httpStatus,
      retryable: attempt.retryable,
      inputTokens: attempt.inputTokens,
      costMicros: attempt.costMicros,
      costSource: attempt.costSource,
    }, {
      status: "failed",
      httpStatus: status,
      retryable: false,
      inputTokens: 0,
      costMicros: 0,
      costSource: "none",
    });
  }
});
