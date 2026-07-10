import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { createApp } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

// deno-lint-ignore no-explicit-any
async function json(response: Response): Promise<any> {
  return await response.json();
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("admin resilience policies and routes are versioned, cycle-safe, and no-store", async () => {
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(4)]]),
  });
  const { app } = createApp({
    setupToken: "resilience-setup-token",
    providerKeyring: keyring,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "resilience-setup-token" },
    body: JSON.stringify({
      email: "resilience-admin@example.com",
      name: "Resilience Admin",
      password: "correct horse battery staple",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "resilience-admin@example.com",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: sessionCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };

  const createModel = async (slug: string) => {
    const createdProvider = await app.request("/api/admin/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug,
        displayName: `${slug} Provider`,
        baseUrl: `https://${slug}.example/v1`,
        protocol: "chat_completions",
      }),
    });
    assertEquals(createdProvider.status, 201);
    const provider = await json(createdProvider);
    const credential = await app.request(`/api/admin/providers/${provider.id}/credential`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedVersion: provider.version, credential: `${slug}-secret` }),
    });
    assertEquals(credential.status, 200);
    const modelResponse = await app.request("/api/admin/models", {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: provider.id,
        publicModelId: `${slug}/chat`,
        upstreamModelId: `${slug}-upstream-chat`,
        displayName: `${slug} Chat`,
        capabilities: ["chat", "streaming", "tools"],
        contextWindow: 32_000,
      }),
    });
    assertEquals(modelResponse.status, 201);
    const model = await json(modelResponse);
    const price = await app.request(`/api/admin/models/${model.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerModelId: model.id,
        expectedModelVersion: model.version,
        effectiveAt: "2026-01-01T00:00:00.000Z",
        inputMicrosPerMillion: 100_000,
        cachedInputMicrosPerMillion: 50_000,
        reasoningMicrosPerMillion: 200_000,
        outputMicrosPerMillion: 300_000,
        fixedCallMicros: 10,
        source: "resilience-test",
      }),
    });
    assertEquals(price.status, 201);
    return model;
  };

  const primary = await createModel("primary");
  const fallback = await createModel("fallback");
  const invalidPolicy = await app.request("/api/admin/resilience/policies", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Unsafe",
      enabled: true,
      maxAttempts: 3,
      maxRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 500,
      backoffMultiplierBps: 20_000,
      jitterBps: 1_000,
      firstTokenTimeoutMs: 10_000,
      idleTimeoutMs: 20_000,
      totalTimeoutMs: 60_000,
      retryableStatuses: [401],
    }),
  });
  assertEquals(invalidPolicy.status, 422);

  const policyResponse = await app.request("/api/admin/resilience/policies", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Fast fallback",
      enabled: true,
      maxAttempts: 3,
      maxRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 500,
      backoffMultiplierBps: 20_000,
      jitterBps: 1_000,
      firstTokenTimeoutMs: 10_000,
      idleTimeoutMs: 20_000,
      totalTimeoutMs: 60_000,
      retryableStatuses: [408, 429, 503],
    }),
  });
  assertEquals(policyResponse.status, 201);
  const policy = await json(policyResponse);
  const policies = await app.request("/api/admin/resilience/policies", { headers });
  assertEquals(policies.status, 200);
  assertEquals(policies.headers.get("cache-control"), "private, no-store");
  assertEquals((await json(policies)).data.length, 1);

  const routeResponse = await app.request(
    `/api/admin/resilience/routes/${primary.id}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        sourceModelId: primary.id,
        expectedVersion: 0,
        retryPolicyId: policy.id,
        fallbackModelIds: [fallback.id],
      }),
    },
  );
  assertEquals(routeResponse.status, 200);
  const route = await json(routeResponse);
  assertEquals(route.version, 1);
  const stale = await app.request(`/api/admin/resilience/routes/${primary.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      sourceModelId: primary.id,
      expectedVersion: 0,
      retryPolicyId: policy.id,
      fallbackModelIds: [fallback.id],
    }),
  });
  assertEquals(stale.status, 409);
  const cycle = await app.request(`/api/admin/resilience/routes/${fallback.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      sourceModelId: fallback.id,
      expectedVersion: 0,
      retryPolicyId: policy.id,
      fallbackModelIds: [primary.id],
    }),
  });
  assertEquals(cycle.status, 422);

  const planResponse = await app.request(`/api/admin/resilience/plans/${primary.id}`, { headers });
  assertEquals(planResponse.status, 200);
  const plan = await json(planResponse);
  assertEquals(plan.targets.map((target: { providerModelId: string }) => target.providerModelId), [
    primary.id,
    fallback.id,
  ]);
  assertEquals(plan.retryPolicy.id, policy.id);
  assertEquals(JSON.stringify(plan).includes("secret"), false);

  const routes = await json(
    await app.request("/api/admin/resilience/routes", { headers }),
  );
  assertEquals(routes.data.length, 2);
  assertEquals(
    routes.data.find((item: { model: { id: string } }) => item.model.id === primary.id).route.id,
    route.id,
  );
});
