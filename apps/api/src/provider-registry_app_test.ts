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
  const responsesProvider = await app.request("/api/admin/providers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      slug: "responses-vendor",
      displayName: "Responses Vendor",
      baseUrl: "https://provider.example/v1",
      protocol: "responses",
    }),
  });
  assertEquals(responsesProvider.status, 201);
  assertEquals((await body(responsesProvider)).protocol, "responses");
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
  assertEquals(listed.data.find((item: { slug: string }) => item.slug === "vendor")?.modelCount, 1);
  assertEquals(
    (await repository.listAudit()).data.some((event) =>
      event.action === "provider.credential_replaced"
    ),
    true,
  );
});

Deno.test("model OCR configuration requires an available non-recursive vision target", async () => {
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(6)]]),
  });
  const { app } = createApp({
    setupToken: "ocr-registry-setup",
    providerKeyring: keyring,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "ocr-registry-setup" },
    body: JSON.stringify({
      email: "ocr-admin@example.com",
      name: "OCR Admin",
      password: "correct horse battery staple",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "ocr-admin@example.com",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const provider = await body(
    await app.request("/api/admin/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "ocr-vendor",
        displayName: "OCR Vendor",
        baseUrl: "https://ocr.example/v1",
        protocol: "chat_completions",
      }),
    }),
  );
  const credentialed = await body(
    await app.request(`/api/admin/providers/${provider.id}/credential`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedVersion: provider.version, credential: "ocr-secret" }),
    }),
  );
  const createModel = async (id: string, capabilities: string[]) =>
    await body(
      await app.request("/api/admin/models", {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: provider.id,
          publicModelId: `ocr-vendor/${id}`,
          upstreamModelId: id,
          displayName: id,
          capabilities,
          contextWindow: 16_384,
        }),
      }),
    );
  const vision = await createModel("vision", ["chat", "vision"]);
  const unpricedVision = await createModel("unpriced", ["chat", "vision"]);
  const secondVision = await createModel("second-vision", ["chat", "vision"]);
  const visionOnly = await createModel("vision-only", ["vision"]);
  assertEquals(
    (await app.request(`/api/admin/models/${vision.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerModelId: vision.id,
        expectedModelVersion: vision.version,
        effectiveAt: new Date(Date.now() - 1_000).toISOString(),
        inputMicrosPerMillion: 1,
        cachedInputMicrosPerMillion: 1,
        reasoningMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
        fixedCallMicros: 0,
        source: "test",
      }),
    })).status,
    201,
  );
  assertEquals(
    (await app.request(`/api/admin/models/${visionOnly.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerModelId: visionOnly.id,
        expectedModelVersion: visionOnly.version,
        effectiveAt: new Date(Date.now() - 1_000).toISOString(),
        inputMicrosPerMillion: 1,
        cachedInputMicrosPerMillion: 1,
        reasoningMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
        fixedCallMicros: 0,
        source: "test",
      }),
    })).status,
    201,
  );
  assertEquals(
    (await app.request(`/api/admin/models/${secondVision.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerModelId: secondVision.id,
        expectedModelVersion: secondVision.version,
        effectiveAt: new Date(Date.now() - 1_000).toISOString(),
        inputMicrosPerMillion: 1,
        cachedInputMicrosPerMillion: 1,
        reasoningMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
        fixedCallMicros: 0,
        source: "test",
      }),
    })).status,
    201,
  );
  const ocr = (model: string) => ({
    enabled: true,
    providerId: provider.id,
    model,
    prompt: "Extract all visible text.",
  });
  const unavailable = await app.request("/api/admin/models", {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: provider.id,
      publicModelId: "ocr-vendor/unavailable-source",
      upstreamModelId: "unavailable-source",
      displayName: "Unavailable source",
      capabilities: ["chat"],
      contextWindow: 16_384,
      customParams: { ocr: ocr(unpricedVision.id) },
    }),
  });
  assertEquals(unavailable.status, 409);
  const incapable = await app.request("/api/admin/models", {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: provider.id,
      publicModelId: "ocr-vendor/incapable-source",
      upstreamModelId: "incapable-source",
      displayName: "Incapable source",
      capabilities: ["chat"],
      contextWindow: 16_384,
      customParams: { ocr: ocr(visionOnly.id) },
    }),
  });
  assertEquals(incapable.status, 422);
  assertEquals((await body(incapable)).error.code, "ocr_target_invalid");

  const sourceResponse = await app.request("/api/admin/models", {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: provider.id,
      publicModelId: "ocr-vendor/source",
      upstreamModelId: "source",
      displayName: "OCR source",
      capabilities: ["chat", "vision"],
      contextWindow: 16_384,
      customParams: { ocr: ocr(vision.id) },
    }),
  });
  assertEquals(sourceResponse.status, 201, await sourceResponse.clone().text());
  const source = await body(sourceResponse);
  const recursive = await app.request(`/api/admin/models/${source.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedVersion: source.version,
      customParams: { ocr: ocr(source.id) },
    }),
  });
  assertEquals(recursive.status, 422);
  assertEquals((await body(recursive)).error.code, "ocr_target_recursive");

  const listed = await body(await app.request("/api/admin/models", { headers }));
  const currentVision = listed.data.find((item: { id: string }) => item.id === vision.id);
  const referencedTarget = await app.request(`/api/admin/models/${vision.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedVersion: currentVision.version,
      customParams: { ocr: ocr(secondVision.id) },
    }),
  });
  assertEquals(referencedTarget.status, 422);
  assertEquals((await body(referencedTarget)).error.code, "ocr_target_recursive");

  const disableTarget = await app.request(`/api/admin/models/${vision.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: currentVision.version, enabled: false }),
  });
  assertEquals(disableTarget.status, 422);
  assertEquals((await body(disableTarget)).error.code, "ocr_target_unavailable");

  const disableProvider = await app.request(`/api/admin/providers/${provider.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: credentialed.version, enabled: false }),
  });
  assertEquals(disableProvider.status, 409);
  assertEquals((await body(disableProvider)).error.code, "ocr_target_unavailable");

  const stopModel = await app.request("/api/admin/models", {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: provider.id,
      publicModelId: "ocr-vendor/chat-defaults",
      upstreamModelId: "chat-defaults",
      displayName: "Chat defaults",
      capabilities: ["chat"],
      contextWindow: 16_384,
      customParams: { stop: "END" },
    }),
  });
  assertEquals(stopModel.status, 201);
  const incompatibleSwitch = await app.request(`/api/admin/providers/${provider.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: credentialed.version, protocol: "responses" }),
  });
  assertEquals(incompatibleSwitch.status, 422);
  assertEquals((await body(incompatibleSwitch)).error.code, "provider_defaults_incompatible");

  const disabledSource = await app.request(`/api/admin/models/${source.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: source.version, enabled: false }),
  });
  assertEquals(disabledSource.status, 200, await disabledSource.clone().text());
  const providerDisabledAfterSource = await app.request(`/api/admin/providers/${provider.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: credentialed.version, enabled: false }),
  });
  assertEquals(
    providerDisabledAfterSource.status,
    200,
    await providerDisabledAfterSource.clone().text(),
  );
});

Deno.test("OpenAI embeddings route enforces capability, billing, safe failures, and replay", async () => {
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(7)]]),
  });
  let malformed = false;
  let fallbackMode = false;
  let failureStatus: number | undefined;
  let calls = 0;
  const breakerPolicy = {
    failureThreshold: 1,
    failureWindowSeconds: 60,
    openSeconds: 7,
    halfOpenLeaseSeconds: 5,
  };
  const { app, repository, circuitBreaker } = createApp({
    setupToken: "embeddings-route-setup",
    providerKeyring: keyring,
    breakerPolicy,
    embeddingsFetch: (input, init) => {
      calls++;
      const fallback = String(input).includes("fallback-embed.example");
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${fallback ? "fallback-secret" : "embeddings-secret"}`,
      );
      if (fallbackMode && !fallback) {
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      }
      if (failureStatus !== undefined) {
        return Promise.resolve(
          new Response("{", {
            status: failureStatus,
            headers: { "retry-after": failureStatus === 429 ? "1" : "0" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          malformed ? "{" : JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: [0.25, -0.5], index: 0 }],
            usage: { prompt_tokens: 10, total_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "embeddings-route-setup" },
    body: JSON.stringify({
      email: "embeddings-admin@example.com",
      name: "Embeddings Admin",
      password: "correct horse battery staple",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "embeddings-admin@example.com",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const provider = await body(
    await app.request("/api/admin/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "embedvendor",
        displayName: "Embedding Vendor",
        baseUrl: "https://provider.example/v1",
        protocol: "chat_completions",
      }),
    }),
  );
  const credential = await body(
    await app.request(`/api/admin/providers/${provider.id}/credential`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedVersion: provider.version, credential: "embeddings-secret" }),
    }),
  );
  assertEquals(credential.hasCredential, true);
  const createModel = async (id: string, capabilities: string[]) =>
    await body(
      await app.request("/api/admin/models", {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: provider.id,
          publicModelId: `embedvendor/${id}`,
          upstreamModelId: id === "embed" ? "upstream-embed" : "upstream-chat",
          displayName: id,
          capabilities,
          contextWindow: 8192,
        }),
      }),
    );
  const embeddingModel = await createModel("embed", ["embeddings"]);
  const chatModel = await createModel("chat", ["chat"]);
  for (const model of [embeddingModel, chatModel]) {
    const priced = await app.request(`/api/admin/models/${model.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerModelId: model.id,
        expectedModelVersion: model.version,
        effectiveAt: new Date(Date.now() - 1000).toISOString(),
        inputMicrosPerMillion: 100_000,
        cachedInputMicrosPerMillion: 100_000,
        reasoningMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
        fixedCallMicros: 10,
        source: "test",
      }),
    });
    assertEquals(priced.status, 201);
  }
  const adminUser = [...(repository as MemoryRepository).users.values()].find((user) =>
    user.email === "embeddings-admin@example.com"
  );
  assertExists(adminUser);
  const mutation = { actorId: adminUser.id, action: "test.embedding_fallback" };
  const fallbackCreated = await repository.createProvider({
    slug: "fallback-embed",
    displayName: "Fallback Embed",
    baseUrl: "https://fallback-embed.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const fallbackProvider = await repository.setProviderCredential(
    fallbackCreated.id,
    fallbackCreated.version,
    { envelope: await keyring.encrypt(fallbackCreated.id, 2, "fallback-secret") },
    mutation,
  );
  const fallbackModel = await repository.createProviderModel({
    providerId: fallbackProvider.id,
    publicModelId: "fallback-embed/model",
    upstreamModelId: "fallback-upstream",
    displayName: "Fallback Embed",
    capabilities: ["embeddings"],
    contextWindow: 8192,
  }, mutation);
  await repository.createModelPriceVersion({
    providerModelId: fallbackModel.id,
    expectedModelVersion: fallbackModel.version,
    effectiveAt: new Date(Date.now() - 1000).toISOString(),
    inputMicrosPerMillion: 100_000,
    cachedInputMicrosPerMillion: 100_000,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 10,
    source: "test",
  }, mutation);
  const fallbackRoute = await repository.setProviderModelRoute({
    sourceModelId: embeddingModel.id,
    expectedVersion: 0,
    fallbackModelIds: [fallbackModel.id],
  }, mutation);
  fallbackMode = true;
  const fallbackResponse = await app.request("/v1/embeddings", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "embedvendor/embed", input: "fallback please" }),
  });
  assertEquals(fallbackResponse.status, 200);
  const fallbackRun = [...(repository as MemoryRepository).usageRuns.values()].at(-1);
  assertExists(fallbackRun);
  assertEquals(
    (await repository.listProviderAttempts(fallbackRun.id)).map((attempt) => [
      attempt.reason,
      attempt.status,
      attempt.providerModelId,
    ]),
    [
      ["primary", "failed", embeddingModel.id],
      ["fallback", "succeeded", fallbackModel.id],
    ],
  );
  const openedPrimary = await circuitBreaker.inspect(provider.id, breakerPolicy);
  assertEquals(openedPrimary.state, "open");
  assertEquals(
    await circuitBreaker.reset(provider.id, openedPrimary.version),
    true,
  );
  const restrictedFallbackGroup = await repository.createAccessGroup({
    name: "restricted-embedding-fallback",
  }, {
    actorId: adminUser.id,
    action: "test.model_access_group.created",
    targetType: "model_access_group",
    requireEmailVerification: false,
    expectedAuthorityEpoch: adminUser.authorityEpoch,
  });
  const restrictedFallbackPolicy = await repository.replaceAccessGroupModels(
    restrictedFallbackGroup.id,
    [fallbackModel.id],
    restrictedFallbackGroup.version,
    [],
    {
      actorId: adminUser.id,
      action: "test.model_access_group.models_replaced",
      targetType: "model_access_group",
      targetId: restrictedFallbackGroup.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: adminUser.authorityEpoch,
    },
  );
  const callsBeforeDeniedFallback = calls;
  const runsBeforeDeniedFallback = (repository as MemoryRepository).usageRuns.size;
  const balanceBeforeDeniedFallback = adminUser.balanceMicros;
  const deniedFallback = await app.request("/v1/embeddings", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: embeddingModel.publicModelId, input: "must not dispatch" }),
  });
  assertEquals(deniedFallback.status, 404);
  assertEquals((await body(deniedFallback)).error.message, "The requested model is unavailable");
  assertEquals(calls, callsBeforeDeniedFallback);
  assertEquals((repository as MemoryRepository).usageRuns.size, runsBeforeDeniedFallback);
  assertEquals(adminUser.balanceMicros, balanceBeforeDeniedFallback);
  await repository.deleteAccessGroup(
    restrictedFallbackGroup.id,
    restrictedFallbackPolicy.version,
    [fallbackModel.id],
    {
      actorId: adminUser.id,
      action: "test.model_access_group.deleted",
      targetType: "model_access_group",
      targetId: restrictedFallbackGroup.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: adminUser.authorityEpoch,
    },
  );
  await repository.setProviderModelRoute({
    sourceModelId: embeddingModel.id,
    expectedVersion: fallbackRoute.version,
    fallbackModelIds: [],
  }, mutation);
  fallbackMode = false;
  const request = { model: "embedvendor/embed", input: "hello" };
  const callsBeforeSuccess = calls;
  const first = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-success-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(first.status, 200);
  assertEquals(await first.json(), {
    object: "list",
    data: [{ object: "embedding", embedding: [0.25, -0.5], index: 0 }],
    model: "embedvendor/embed",
    usage: { prompt_tokens: 10, total_tokens: 10 },
  });
  const replay = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-success-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(replay.status, 200);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(calls, callsBeforeSuccess + 1);
  const storedEmbeddingModel = (repository as MemoryRepository).providerModels.get(
    embeddingModel.id,
  );
  assertExists(storedEmbeddingModel);
  storedEmbeddingModel.enabled = false;
  const disabledReplay = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-success-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(disabledReplay.status, 404);
  assertEquals(disabledReplay.headers.get("x-idempotent-replay"), null);
  assertEquals((await body(disabledReplay)).error.message, "The requested model is unavailable");
  const disabledConflict = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-success-replay" },
    body: JSON.stringify({ model: "model-that-no-longer-exists", input: "changed" }),
  });
  assertEquals(disabledConflict.status, 409);
  assertEquals((await body(disabledConflict)).error.code, "idempotency_conflict");
  storedEmbeddingModel.enabled = true;
  const usageRequest = [...(repository as MemoryRepository).apiIdempotencyRequests.values()].find(
    (item) => item.idempotencyKey === "embeddings-success-replay",
  );
  assertExists(usageRequest);
  const run = (repository as MemoryRepository).usageRuns.get(usageRequest.usageRunId);
  assertEquals({ input: run?.inputTokens, output: run?.outputTokens, cost: run?.costMicros }, {
    input: 10,
    output: 0,
    cost: 11,
  });
  usageRequest.expiresAt = new Date(0).toISOString();
  const callsBeforeExpiredReplay = calls;
  const afterReplayExpiry = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-success-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(afterReplayExpiry.status, 200);
  assertEquals(afterReplayExpiry.headers.get("x-idempotent-replay"), null);
  assertEquals(calls, callsBeforeExpiredReplay + 1);
  assertEquals((repository as MemoryRepository).apiIdempotencyRequests.has(usageRequest.id), false);
  const replacementRequest = [
    ...(repository as MemoryRepository).apiIdempotencyRequests.values(),
  ].find((item) => item.idempotencyKey === "embeddings-success-replay");
  assertExists(replacementRequest);
  assertEquals(replacementRequest.id === usageRequest.id, false);
  const rejected = await app.request("/v1/embeddings", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "embedvendor/chat", input: "hello" }),
  });
  assertEquals(rejected.status, 404);
  const nonChatRejected = await app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "embedvendor/embed",
      messages: [{ role: "user", content: "This model is embeddings-only" }],
    }),
  });
  assertEquals(nonChatRejected.status, 404);
  malformed = true;
  const failed = await app.request("/v1/embeddings", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  assertEquals(failed.status, 502);
  assertEquals((await body(failed)).error.code, "provider_error");
  malformed = false;
  failureStatus = 429;
  const rateLimited = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-rate-limit-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(rateLimited.status, 429);
  // The one-second upstream delay is not sufficient while the same candidate's breaker remains
  // open for seven seconds. The route exposes the later, actually actionable deadline.
  assertEquals(rateLimited.headers.get("retry-after"), "7");
  assertEquals((await body(rateLimited)).error.code, "rate_limit_exceeded");
  const rateLimitedRun = [...(repository as MemoryRepository).usageRuns.values()].at(-1);
  assertExists(rateLimitedRun);
  const rateLimitedAttempt = (await repository.listProviderAttempts(rateLimitedRun.id))[0];
  assertEquals({
    status: rateLimitedAttempt.status,
    httpStatus: rateLimitedAttempt.httpStatus,
    retryable: rateLimitedAttempt.retryable,
    costMicros: rateLimitedAttempt.costMicros,
  }, { status: "failed", httpStatus: 429, retryable: true, costMicros: 12 });
  const callsBeforeRateLimitReplay = calls;
  const rateLimitedReplay = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-rate-limit-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(rateLimitedReplay.status, 429);
  assertEquals(rateLimitedReplay.headers.get("retry-after"), "7");
  assertEquals(rateLimitedReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals((await body(rateLimitedReplay)).error.code, "rate_limit_exceeded");
  assertEquals(calls, callsBeforeRateLimitReplay);
  failureStatus = undefined;
  const balanceBeforeOpenCircuit = adminUser.balanceMicros;
  const callsBeforeOpenCircuit = calls;
  const openCircuitRequest = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-open-circuit-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(openCircuitRequest.status, 503);
  assertEquals(openCircuitRequest.headers.get("retry-after"), "7");
  assertEquals(await body(openCircuitRequest), {
    error: {
      message: "Provider request failed",
      type: "server_error",
      param: null,
      code: "provider_error",
    },
  });
  assertEquals(calls, callsBeforeOpenCircuit);
  assertEquals(adminUser.balanceMicros, balanceBeforeOpenCircuit);
  const openCircuitRun = [...(repository as MemoryRepository).usageRuns.values()].at(-1);
  assertExists(openCircuitRun);
  assertEquals({ cost: openCircuitRun.costMicros, status: openCircuitRun.status }, {
    cost: 0,
    status: "failed",
  });
  assertEquals(
    (await repository.listProviderAttempts(openCircuitRun.id)).map((attempt) => ({
      reason: attempt.reason,
      status: attempt.status,
      cost: attempt.costMicros,
      input: attempt.inputTokens,
      output: attempt.outputTokens,
    })),
    [{ reason: "circuit_skip", status: "skipped", cost: 0, input: 0, output: 0 }],
  );
  const openCircuitReplay = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-open-circuit-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(openCircuitReplay.status, 503);
  assertEquals(openCircuitReplay.headers.get("retry-after"), "7");
  assertEquals(openCircuitReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(calls, callsBeforeOpenCircuit);
  assertEquals(adminUser.balanceMicros, balanceBeforeOpenCircuit);
  const storedOpenCircuitRequest = [
    ...(repository as MemoryRepository).apiIdempotencyRequests.values(),
  ].find((item) => item.idempotencyKey === "embeddings-open-circuit-replay");
  assertExists(storedOpenCircuitRequest);
  storedOpenCircuitRequest.completedAt = new Date(Date.now() - 8_000).toISOString();
  const expiredRetryReplay = await app.request("/v1/embeddings", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "embeddings-open-circuit-replay" },
    body: JSON.stringify(request),
  });
  assertEquals(expiredRetryReplay.status, 503);
  assertEquals(expiredRetryReplay.headers.get("retry-after"), null);
  assertEquals(expiredRetryReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(calls, callsBeforeOpenCircuit);
  assertEquals(adminUser.balanceMicros, balanceBeforeOpenCircuit);
  adminUser.balanceMicros = 0;
  const insufficient = await app.request("/v1/embeddings", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  assertEquals(insufficient.status, 402);
});
