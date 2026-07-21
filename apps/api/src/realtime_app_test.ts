import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { MemoryRepository } from "@dg-chat/database";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

Deno.test("Realtime session endpoints authorize, rewrite model IDs, and replace credentials", async () => {
  const sidebandServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => sidebandServer.once("listening", resolve));
  const sidebandAddress = sidebandServer.address();
  if (!sidebandAddress || typeof sidebandAddress === "string") throw new Error("Missing WS port");
  let providerSideband: NodeWebSocket | undefined;
  sidebandServer.on("connection", (socket) => providerSideband = socket);
  let createdCalls = 0;
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
    realtimeCallSigningSecret: "realtime-call-test-secret-32-bytes-minimum",
    realtimeFetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/realtime/calls")) {
        createdCalls += 1;
        const session = request.headers.get("content-type")?.startsWith("application/sdp")
          ? { rawSdp: await request.text() }
          : JSON.parse(await ((await request.formData()).get("session") as File).text());
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization") ?? "",
          body: session,
        });
        return new Response("v=0\r\nanswer", {
          status: 201,
          headers: {
            "content-type": "application/sdp",
            location: `/v1/realtime/calls/call_provider_${createdCalls}`,
          },
        });
      }
      if (/\/realtime\/calls\/call_provider_\d+\/hangup$/.test(request.url)) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
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
    realtimeWebSocketConnect: async (input) => {
      assertEquals(/^call_provider_\d+$/.test(input.callId ?? ""), true);
      const socket = new NodeWebSocket(`ws://127.0.0.1:${sidebandAddress.port}`);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return socket;
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
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({ name: "Realtime", scopes: ["chat:write"] }),
  });
  const apiToken = (await tokenResponse.json()).token as string;
  const tokenHeaders = {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
  };

  const response = await app.request("/v1/realtime/client_secrets", {
    method: "POST",
    headers: tokenHeaders,
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
  const managedSecretResponse = await response.json();
  assertEquals(managedSecretResponse.session, {
    model: "vendor/realtime",
    type: "realtime",
  });
  assertEquals(managedSecretResponse.value.startsWith("ek_dg_"), true);
  assertEquals(managedSecretResponse.value.includes("ek_provider_ephemeral"), false);

  const missing = await app.request("/v1/realtime/sessions", {
    method: "POST",
    headers: tokenHeaders,
    body: JSON.stringify({ instructions: "no implicit self-hosted default" }),
  });
  assertEquals(missing.status, 422);
  assertEquals((await missing.json()).error.code, "model_required");

  const form = new FormData();
  form.set("sdp", new Blob(["v=0\r\noffer"], { type: "application/sdp" }), "offer.sdp");
  form.set(
    "session",
    new Blob([JSON.stringify({
      type: "realtime",
      model: "vendor/realtime",
      instructions: "voice",
    })], { type: "application/json" }),
    "session.json",
  );
  const callResponse = await app.request("/api/realtime/calls", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173" },
    body: form,
  });
  assertEquals(callResponse.status, 201, await callResponse.clone().text());
  assertEquals(await callResponse.text(), "v=0\r\nanswer");
  const localLocation = callResponse.headers.get("location");
  assertExists(localLocation);
  assertEquals(localLocation.startsWith("/api/realtime/calls/"), true);
  assertEquals(localLocation.includes("call_provider_1"), false);
  assertEquals(requests.at(-1), {
    url: "https://realtime.example/v1/realtime/calls",
    authorization: "Bearer provider-secret",
    body: { type: "realtime", model: "gpt-realtime-upstream", instructions: "voice" },
  });
  assertExists(providerSideband);
  providerSideband.send(JSON.stringify({
    type: "response.done",
    response: {
      usage: {
        input_tokens: 3,
        input_token_details: { cached_tokens: 1, text_tokens: 1, audio_tokens: 2 },
        output_tokens: 2,
        output_token_details: { text_tokens: 1, audio_tokens: 1 },
      },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const closed = new Promise<void>((resolve) => providerSideband!.once("close", () => resolve()));
  const { app: secondReplica } = createApp({
    repository,
    providerKeyring: keyring,
    realtimeCallSigningSecret: "realtime-call-test-secret-32-bytes-minimum",
    realtimeFetch: (input, init) => {
      const request = new Request(input, init);
      assertEquals(
        request.url,
        "https://realtime.example/v1/realtime/calls/call_provider_1/hangup",
      );
      assertEquals(request.headers.get("authorization"), "Bearer provider-secret");
      providerSideband!.close(1000, "hangup");
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });
  const hangup = await secondReplica.request(`${localLocation}/hangup`, {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173" },
  });
  assertEquals(hangup.status, 200);
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals((await repository.usage(user.id)).calls, 1);

  const ephemeralCall = await app.request("/v1/realtime/calls", {
    method: "POST",
    headers: {
      authorization: `Bearer ${managedSecretResponse.value}`,
      "content-type": "application/sdp",
    },
    body: "v=0\r\nephemeral-offer",
  });
  assertEquals(ephemeralCall.status, 201, await ephemeralCall.clone().text());
  assertEquals(requests.at(-1), {
    url: "https://realtime.example/v1/realtime/calls",
    authorization: "Bearer ek_provider_ephemeral",
    body: { rawSdp: "v=0\r\nephemeral-offer" },
  });
  const ephemeralLocation = ephemeralCall.headers.get("location");
  assertExists(ephemeralLocation);
  assertEquals(ephemeralLocation.startsWith("/v1/realtime/calls/"), true);
  assertExists(providerSideband);
  const ephemeralClosed = new Promise<void>((resolve) =>
    providerSideband!.once("close", () => resolve())
  );
  const ephemeralHangup = await app.request(`${ephemeralLocation}/hangup`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assertEquals(ephemeralHangup.status, 200);
  await ephemeralClosed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals((await repository.usage(user.id)).calls, 2);
  sidebandServer.close();
});
