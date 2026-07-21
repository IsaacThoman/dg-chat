import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

Deno.test("Realtime session endpoints authorize, rewrite model IDs, and replace credentials", async () => {
  const repository = new MemoryRepository();
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(4)]]),
  });
  const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
  const { app } = createApp({
    repository,
    setupToken: "realtime-setup",
    providerKeyring: keyring,
    realtimeFetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json();
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization") ?? "",
        body,
      });
      return new Response(
        JSON.stringify({
          value: "ek_provider_ephemeral",
          session: { model: "gpt-realtime-upstream", type: "realtime" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const setup = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "realtime-setup" },
    body: JSON.stringify({
      name: "Realtime Admin",
      email: "realtime@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(setup.status, 201);
  const user = (await setup.json()).user;
  const mutation = { actorId: user.id, action: "test.realtime" };
  const created = repository.createProvider({
    slug: "realtime-provider",
    displayName: "Realtime provider",
    baseUrl: "https://realtime.example/v1",
    protocol: "responses",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "provider-secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "vendor/realtime",
    upstreamModelId: "gpt-realtime-upstream",
    displayName: "Vendor Realtime",
    capabilities: ["realtime", "realtime_transcription", "realtime_translation"],
    contextWindow: 32_000,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 1,
    cachedInputMicrosPerMillion: 1,
    reasoningMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
    fixedCallMicros: 1,
    source: "test",
  }, mutation);
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "realtime@example.com",
      password: "correct horse battery",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);

  const response = await app.request("/v1/realtime/client_secrets", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: { type: "realtime", model: "vendor/realtime", instructions: "keep opaque" },
    }),
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(requests, [{
    url: "https://realtime.example/v1/realtime/client_secrets",
    authorization: "Bearer provider-secret",
    body: {
      expires_after: { anchor: "created_at", seconds: 60 },
      session: { type: "realtime", model: "gpt-realtime-upstream", instructions: "keep opaque" },
    },
  }]);
  assertEquals(await response.json(), {
    value: "ek_provider_ephemeral",
    session: { model: "vendor/realtime", type: "realtime" },
  });

  const missing = await app.request("/v1/realtime/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ instructions: "no implicit self-hosted default" }),
  });
  assertEquals(missing.status, 422);
  assertEquals((await missing.json()).error.code, "model_required");
});
