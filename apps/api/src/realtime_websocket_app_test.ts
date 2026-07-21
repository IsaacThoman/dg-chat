import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { MemoryRepository } from "@dg-chat/database";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

function opened(socket: NodeWebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function message(socket: NodeWebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, binary) => {
      if (binary) return reject(new Error("Unexpected binary frame"));
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

Deno.test("raw Realtime WebSocket relays standard JSON events and settles terminal usage", async () => {
  const previousEnvironment = Deno.env.get("DENO_ENV");
  const previousAllowedHost = Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST");
  Deno.env.set("DENO_ENV", "test");
  Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", "127.0.0.1");
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstreamServer.once("listening", resolve));
  const upstreamAddress = upstreamServer.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Missing WS port");
  let upstreamAuthorization = "";
  let upstreamPath = "";
  let upstreamSocket: NodeWebSocket | undefined;
  const upstreamConnected = new Promise<void>((resolve) => {
    upstreamServer.once("connection", (socket, request) => {
      upstreamSocket = socket;
      upstreamAuthorization = request.headers.authorization ?? "";
      upstreamPath = request.url ?? "";
      socket.send(JSON.stringify({
        type: "session.created",
        session: { model: "gpt-realtime-upstream" },
      }));
      resolve();
    });
  });

  const repository = new MemoryRepository();
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(5)]]),
  });
  const { app } = createApp({
    repository,
    setupToken: "realtime-ws-setup",
    providerKeyring: keyring,
  });
  const setup = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "realtime-ws-setup" },
    body: JSON.stringify({
      name: "Realtime WS Admin",
      email: "realtime-ws@example.com",
      password: "correct horse battery",
    }),
  });
  const user = (await setup.json()).user;
  const mutation = { actorId: user.id, action: "test.realtime-websocket" };
  const created = repository.createProvider({
    slug: "realtime-ws-provider",
    displayName: "Realtime WebSocket provider",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    protocol: "responses",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "provider-ws-secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "vendor/realtime-ws",
    upstreamModelId: "gpt-realtime-upstream",
    displayName: "Vendor Realtime WS",
    capabilities: ["realtime"],
    contextWindow: 32_000,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 500_000,
    reasoningMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 2_000_000,
    fixedCallMicros: 7,
    source: "test",
  }, mutation);
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "realtime-ws@example.com",
      password: "correct horse battery",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({ name: "Realtime WS", scopes: ["chat:write"] }),
  });
  const token = (await tokenResponse.json()).token;

  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, app.fetch);
  const address = server.addr as Deno.NetAddr;
  const client = new NodeWebSocket(
    `ws://127.0.0.1:${address.port}/v1/realtime?model=vendor%2Frealtime-ws`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  try {
    const createdEvent = message(client);
    await Promise.all([opened(client), upstreamConnected]);
    assertEquals(upstreamAuthorization, "Bearer provider-ws-secret");
    assertEquals(upstreamPath, "/v1/realtime?model=gpt-realtime-upstream");
    assertEquals(await createdEvent, {
      type: "session.created",
      session: { model: "vendor/realtime-ws" },
    });

    const forwarded = message(upstreamSocket!);
    client.send(JSON.stringify({
      type: "session.update",
      session: { model: "vendor/realtime-ws", instructions: "opaque" },
    }));
    assertEquals(await forwarded, {
      type: "session.update",
      session: { model: "gpt-realtime-upstream", instructions: "opaque" },
    });

    const terminal = message(client);
    upstreamSocket!.send(JSON.stringify({
      type: "response.done",
      response: {
        model: "gpt-realtime-upstream",
        usage: {
          input_tokens: 10,
          input_token_details: { cached_tokens: 2, text_tokens: 4, audio_tokens: 6 },
          output_tokens: 5,
          output_token_details: { text_tokens: 1, audio_tokens: 4 },
        },
      },
    }));
    assertEquals((await terminal).response, {
      model: "vendor/realtime-ws",
      usage: {
        input_tokens: 10,
        input_token_details: { cached_tokens: 2, text_tokens: 4, audio_tokens: 6 },
        output_tokens: 5,
        output_token_details: { text_tokens: 1, audio_tokens: 4 },
      },
    });
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    upstreamSocket!.close(1000, "complete");
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const usage = await repository.usage(user.id);
    assertEquals(usage.calls, 1);
    assertEquals(usage.inputTokens, 10);
    assertEquals(usage.outputTokens, 5);
    assertEquals(usage.spentMicros, 26);
  } finally {
    client.terminate();
    upstreamSocket?.terminate();
    upstreamServer.close();
    await server.shutdown();
    if (previousEnvironment === undefined) Deno.env.delete("DENO_ENV");
    else Deno.env.set("DENO_ENV", previousEnvironment);
    if (previousAllowedHost === undefined) Deno.env.delete("OPENAI_TEST_ALLOW_HTTP_HOST");
    else Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", previousAllowedHost);
  }
});
