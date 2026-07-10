import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";
import type { UpstreamStreamOptions } from "./models.ts";

// deno-lint-ignore no-explicit-any
async function body(response: Response): Promise<Record<string, any>> {
  return await response.json();
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("admin provider registry protects credentials and powers dynamic OpenAI models", async () => {
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(9)]]),
  });
  let discoveryAuthorization = "";
  let runtime: UpstreamStreamOptions | undefined;
  const { app, repository } = createApp({
    setupToken: "provider-registry-setup",
    providerKeyring: keyring,
    providerDiscoveryFetch: (_input, init) => {
      discoveryAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "upstream-chat", owned_by: "test-vendor" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
    providerComplete: (_request, _signal, options) => {
      runtime = options;
      return Promise.resolve({
        text: "registry response",
        inputTokens: 10_000,
        outputTokens: 20_000,
        cachedInputTokens: 4_000,
        reasoningTokens: 5_000,
      });
    },
    providerStream: async function* () {
      yield JSON.stringify({
        id: "chatcmpl-registry-stream",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "registry stream" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10_000,
          completion_tokens: 20_000,
          prompt_tokens_details: { cached_tokens: 4_000 },
          completion_tokens_details: { reasoning_tokens: 5_000 },
        },
      });
      yield "[DONE]";
    },
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "provider-registry-setup" },
    body: JSON.stringify({
      email: "provider-admin@example.com",
      name: "Provider Admin",
      password: "correct horse battery staple",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "provider-admin@example.com",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const unsupportedProtocol = await app.request("/api/admin/providers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      slug: "responses-vendor",
      displayName: "Responses Vendor",
      baseUrl: "https://provider.example/v1",
      protocol: "responses",
    }),
  });
  assertEquals(unsupportedProtocol.status, 422);
  const reservedProvider = await app.request("/api/admin/providers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      slug: "openai",
      displayName: "Collision",
      baseUrl: "https://provider.example/v1",
      protocol: "chat_completions",
    }),
  });
  assertEquals(reservedProvider.status, 409);
  const createdResponse = await app.request("/api/admin/providers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      slug: "vendor",
      displayName: "Vendor",
      baseUrl: "https://provider.example/v1/",
      protocol: "chat_completions",
    }),
  });
  assertEquals(createdResponse.status, 201);
  const provider = await body(createdResponse);
  assertEquals(provider.baseUrl, "https://provider.example/v1");
  assertEquals(provider.hasCredential, false);

  const secret = "canary-provider-secret-never-return";
  const credentialResponse = await app.request(`/api/admin/providers/${provider.id}/credential`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ expectedVersion: provider.version, credential: secret }),
  });
  assertEquals(credentialResponse.status, 200);
  const credentialProvider = await body(credentialResponse);
  const credentialJson = JSON.stringify(credentialProvider);
  assertEquals(credentialProvider.hasCredential, true);
  assertEquals(credentialJson.includes(secret), false);
  assertEquals(credentialJson.includes("ciphertext"), false);
  assertEquals(credentialJson.includes("wrappedKey"), false);
  const stored = await repository.getProviderCredential(provider.id);
  assertExists(stored);
  assertEquals(await keyring.decrypt(provider.id, stored.envelope), secret);

  const stale = await app.request(`/api/admin/providers/${provider.id}/credential`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ expectedVersion: provider.version, credential: "stale-secret" }),
  });
  assertEquals(stale.status, 409);

  const discoveryResponse = await app.request(`/api/admin/providers/${provider.id}/discover`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: credentialProvider.version }),
  });
  assertEquals(discoveryResponse.status, 200);
  const discovery = await body(discoveryResponse);
  assertEquals(discoveryAuthorization, `Bearer ${secret}`);
  assertEquals(discovery.models, [{ id: "upstream-chat", ownedBy: "test-vendor" }]);
  assertEquals(JSON.stringify(discovery).includes(secret), false);

  const modelResponse = await app.request("/api/admin/models", {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: provider.id,
      publicModelId: "vendor/chat",
      upstreamModelId: "upstream-chat",
      displayName: "Vendor Chat",
      capabilities: ["chat", "streaming", "tools"],
      contextWindow: 32_000,
    }),
  });
  assertEquals(modelResponse.status, 201);
  const model = await body(modelResponse);
  const unpricedModels = await body(await app.request("/api/models", { headers }));
  assertEquals(
    unpricedModels.data.some((item: { id: string }) => item.id === "vendor/chat"),
    false,
  );
  const unpricedCompletion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "unpriced-registry-completion" },
    body: JSON.stringify({
      model: "vendor/chat",
      messages: [{ role: "user", content: "must not spend upstream funds" }],
    }),
  });
  assertEquals(unpricedCompletion.status, 404);
  assertEquals(runtime, undefined);
  const priceResponse = await app.request(`/api/admin/models/${model.id}/prices`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerModelId: model.id,
      expectedModelVersion: model.version,
      effectiveAt: new Date(Date.now() - 1_000).toISOString(),
      inputMicrosPerMillion: 100_000,
      cachedInputMicrosPerMillion: 50_000,
      reasoningMicrosPerMillion: 200_000,
      outputMicrosPerMillion: 300_000,
      fixedCallMicros: 10,
      source: "test",
    }),
  });
  assertEquals(priceResponse.status, 201);
  const price = await body(priceResponse);

  const publicModels = await body(await app.request("/api/models", { headers }));
  assertEquals(publicModels.data.some((item: { id: string }) => item.id === "vendor/chat"), true);
  const completion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "provider-registry-completion" },
    body: JSON.stringify({
      model: "vendor/chat",
      messages: [{ role: "user", content: "hello registry" }],
      max_tokens: 20_000,
    }),
  });
  assertEquals(completion.status, 200);
  assertStringIncludes(JSON.stringify(await body(completion)), "registry response");
  assertEquals(runtime?.baseUrl, "https://provider.example/v1");
  assertEquals(runtime?.apiKey, secret);
  assertEquals(runtime?.upstreamModel, "upstream-chat");
  const idempotencyRequest = [...(repository as MemoryRepository).apiIdempotencyRequests.values()]
    .find((request) => request.idempotencyKey === "provider-registry-completion");
  assertExists(idempotencyRequest);
  const usageRun = (repository as MemoryRepository).usageRuns.get(idempotencyRequest.usageRunId);
  assertEquals(usageRun?.costMicros, 6_310);
  assertEquals(usageRun?.inputTokens, 10_000);
  assertEquals(usageRun?.outputTokens, 20_000);
  assertEquals(usageRun?.pricingSnapshot, {
    pricingVersionId: price.id,
    inputMicrosPerMillion: 100_000,
    cachedInputMicrosPerMillion: 50_000,
    reasoningMicrosPerMillion: 200_000,
    outputMicrosPerMillion: 300_000,
    fixedCallMicros: 10,
    source: "test",
  });

  const streamed = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "provider-registry-stream" },
    body: JSON.stringify({
      model: "vendor/chat",
      messages: [{ role: "user", content: "stream registry" }],
      max_tokens: 20_000,
      stream: true,
    }),
  });
  assertEquals(streamed.status, 200);
  assertStringIncludes(await streamed.text(), "registry stream");
  const streamRequest = [...(repository as MemoryRepository).apiIdempotencyRequests.values()].find((
    request,
  ) => request.idempotencyKey === "provider-registry-stream");
  assertExists(streamRequest);
  const streamRun = (repository as MemoryRepository).usageRuns.get(streamRequest.usageRunId);
  const streamAttempts = (repository as MemoryRepository).listProviderAttempts(
    streamRequest.usageRunId,
  );
  const streamAttempt = streamAttempts[0];
  assertEquals({
    inputTokens: streamAttempt.inputTokens,
    cachedInputTokens: streamAttempt.cachedInputTokens,
    reasoningTokens: streamAttempt.reasoningTokens,
    outputTokens: streamAttempt.outputTokens,
    costMicros: streamAttempt.costMicros,
    tokenSource: streamAttempt.tokenSource,
  }, {
    inputTokens: 10_000,
    cachedInputTokens: 4_000,
    reasoningTokens: 5_000,
    outputTokens: 20_000,
    costMicros: 6_310,
    tokenSource: "provider",
  });
  assertEquals(streamRun?.costMicros, 6_310);
  assertEquals(streamRun?.inputTokens, 10_000);
  assertEquals(streamRun?.outputTokens, 20_000);

  const priorRunIds = new Set((repository as MemoryRepository).usageRuns.keys());
  const ordinaryCompletion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "vendor/chat",
      messages: [{ role: "user", content: "exercise the ordinary execution lease" }],
      max_tokens: 20_000,
    }),
  });
  assertEquals(ordinaryCompletion.status, 200);
  const ordinaryRun = [...(repository as MemoryRepository).usageRuns.values()].find((run) =>
    !priorRunIds.has(run.id)
  );
  assertExists(ordinaryRun);
  assertEquals(ordinaryRun.status, "completed");
  assertEquals(ordinaryRun.executionEpoch, 1);
  assertEquals(ordinaryRun.runLeaseToken, null);
  assertEquals(
    (await repository.listProviderAttempts(ordinaryRun.id)).map((attempt) => attempt.status),
    ["succeeded"],
  );

  const listed = await body(await app.request("/api/admin/providers", { headers }));
  const listedJson = JSON.stringify(listed);
  assertEquals(listedJson.includes(secret), false);
  assertEquals(listedJson.includes("ciphertext"), false);
  assertEquals(listed.data[0].modelCount, 1);
  assertEquals(
    (await repository.listAudit()).data.some((event) =>
      event.action === "provider.credential_replaced"
    ),
    true,
  );
});
