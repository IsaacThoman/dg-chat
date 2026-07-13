import { assertEquals } from "jsr:@std/assert@1.0.14";
import { MemoryRepository, type ProviderPayloadCaptureInput } from "@dg-chat/database";
import { MemoryCircuitBreaker } from "./provider-circuit.ts";
import { ProviderExecutionEngine } from "./provider-execution.ts";
import { ProviderAttemptError } from "./provider-resilience.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

async function fixture() {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: "capture@example.com",
    name: "Capture",
    passwordHash: "unused",
  }, 5_000_000);
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "capture-test",
    keys: new Map([["capture-test", new Uint8Array(32).fill(4)]]),
  });
  const mutation = { actorId: user.id, action: "test.capture" };
  const created = repository.createProvider({
    slug: "capture",
    displayName: "Capture",
    baseUrl: "https://capture.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "provider-secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "capture/chat",
    upstreamModelId: "capture-upstream",
    displayName: "Capture chat",
    capabilities: ["chat", "streaming"],
    contextWindow: 32_000,
  }, mutation);
  const price = repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 1,
    cachedInputMicrosPerMillion: 1,
    reasoningMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
    fixedCallMicros: 1,
    source: "capture-test",
  }, mutation);
  const retryPolicy = repository.createProviderRetryPolicy({
    name: "Capture retry",
    maxAttempts: 2,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplierBps: 10_000,
    jitterBps: 0,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 10_000,
    retryableStatuses: [503],
  }, mutation);
  repository.setProviderModelRoute({
    sourceModelId: model.id,
    expectedVersion: 0,
    retryPolicyId: retryPolicy.id,
    fallbackModelIds: [],
  }, mutation);
  const run = (id: string) => {
    const usage = repository.reserve(
      user.id,
      id,
      model.publicModelId,
      100,
      provider.slug,
      undefined,
      {
        pricingVersionId: price.id,
        inputMicrosPerMillion: 1,
        cachedInputMicrosPerMillion: 1,
        reasoningMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
        fixedCallMicros: 1,
        source: "capture-test",
      },
    );
    if (!usage.runLeaseToken) throw new Error("run lease missing");
    return usage.runLeaseToken;
  };
  return { repository, keyring, model, run };
}

Deno.test("provider diagnostic capture is sanitized, repository-gated, and failure-isolated", async () => {
  const fx = await fixture();
  const captures: ProviderPayloadCaptureInput[] = [];
  let mode: "disabled" | "throw" | "capture" = "disabled";
  let failNextProvider = false;
  fx.repository.captureProviderPayload = (input) => {
    captures.push(input);
    if (mode === "throw") throw new Error("diagnostic store unavailable");
    return null;
  };
  const engine = new ProviderExecutionEngine({
    repository: fx.repository,
    keyring: fx.keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 3,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    complete: () => {
      if (failNextProvider) {
        failNextProvider = false;
        return Promise.reject(
          Object.assign(new ProviderAttemptError("Bearer failed-attempt-secret", { status: 503 }), {
            headers: { authorization: "Bearer raw-header-secret" },
            stack: "private provider stack",
          }),
        );
      }
      return Promise.resolve({
        text: "safe result",
        inputTokens: 1,
        outputTokens: 1,
        upstream: {
          id: "chatcmpl_capture",
          choices: [{ message: { content: "safe result" } }],
          headers: { authorization: "Bearer response-secret" },
          signed_url: "https://objects.example/result?signature=secret",
        },
      });
    },
    stream: async function* () {
      yield JSON.stringify({
        id: "chatcmpl_stream_capture",
        choices: [{ delta: { content: "streamed result" } }],
        api_key: "sk-stream-secret-value",
        source_url: "https://objects.example/stream?signature=secret",
      });
      yield JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
      yield "[DONE]";
    },
  });
  const request = {
    model: fx.model.publicModelId,
    messages: [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "hello" },
        {
          type: "image_url" as const,
          image_url: { url: "https://objects.example/image?signature=secret" },
        },
      ],
    }],
  };

  const disabled = await engine.complete(
    fx.model.id,
    "capture-disabled",
    fx.run("capture-disabled"),
    request,
    new AbortController().signal,
  );
  assertEquals(disabled.text, "safe result");
  await Promise.resolve();
  assertEquals(captures.length, 1);

  mode = "throw";
  const failureIsolated = await engine.complete(
    fx.model.id,
    "capture-failure",
    fx.run("capture-failure"),
    request,
    new AbortController().signal,
  );
  assertEquals(failureIsolated.text, "safe result");
  await Promise.resolve();
  assertEquals(captures.length, 2);
  const persisted = JSON.stringify(captures);
  assertEquals(persisted.includes("response-secret"), false);
  assertEquals(persisted.includes("signature=secret"), false);
  assertEquals(persisted.includes("provider-secret"), false);

  mode = "capture";
  const oversizedRequest = {
    model: fx.model.publicModelId,
    messages: [{ role: "user" as const, content: "large text ".repeat(120_000) }],
  };
  const oversized = await engine.complete(
    fx.model.id,
    "capture-oversized",
    fx.run("capture-oversized"),
    oversizedRequest,
    new AbortController().signal,
  );
  assertEquals(oversized.text, "safe result");
  await Promise.resolve();
  assertEquals(captures.at(-1)?.requestBody, null);
  assertEquals(captures.at(-1)?.responseBody !== null, true);

  const streamed: string[] = [];
  for await (
    const frame of engine.stream(
      fx.model.id,
      "capture-stream",
      fx.run("capture-stream"),
      request,
      new AbortController().signal,
    )
  ) streamed.push(frame);
  assertEquals(streamed.at(-1), "[DONE]");
  await Promise.resolve();
  assertEquals(captures.length, 4);
  assertEquals(captures.at(-1)?.responseBody?.includes("streamed result"), true);
  assertEquals(captures.at(-1)?.responseBody?.includes("sk-stream"), false);
  assertEquals(captures.at(-1)?.responseBody?.includes("signature=secret"), false);

  failNextProvider = true;
  const beforeRetryCaptures = captures.length;
  const retried = await engine.complete(
    fx.model.id,
    "capture-retry-success",
    fx.run("capture-retry-success"),
    request,
    new AbortController().signal,
  );
  assertEquals(retried.text, "safe result");
  await Promise.resolve();
  const retryCaptures = captures.slice(beforeRetryCaptures);
  assertEquals(retryCaptures.length, 2);
  const failed = JSON.parse(retryCaptures[0].responseBody!) as { error: Record<string, unknown> };
  assertEquals(Object.keys(failed.error), ["name", "status", "code", "message"]);
  assertEquals(failed.error.status, 503);
  assertEquals(JSON.stringify(failed).includes("failed-attempt-secret"), false);
  assertEquals(JSON.stringify(failed).includes("raw-header-secret"), false);
  assertEquals(JSON.stringify(failed).includes("private provider stack"), false);
  assertEquals(retryCaptures[1].responseBody?.includes("safe result"), true);
});
