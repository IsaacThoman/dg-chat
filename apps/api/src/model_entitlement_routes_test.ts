import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";
import { TestObjectStore } from "./test-object-store.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const alternatePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const speech = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);

function wav(): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 2, true);
  return bytes;
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("canonical and alias entitlement parity spans catalogs and model routes", async () => {
  const repository = new MemoryRepository();
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(5)]]),
  });
  let imageCreated = 0;
  const { app } = createApp({
    repository,
    objectStore: new TestObjectStore(),
    setupToken: "entitlement-matrix",
    providerKeyring: keyring,
    providerComplete: () =>
      Promise.resolve({ text: "matrix response", inputTokens: 1, outputTokens: 2 }),
    providerStream: async function* () {
      yield JSON.stringify({
        id: "chatcmpl-matrix",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "matrix stream" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      });
      yield "[DONE]";
    },
    embeddingsFetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: [0.5], index: 0 }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    imageFetch: () => {
      const created = ++imageCreated;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            created,
            data: [{ b64_json: created % 2 ? png : alternatePng }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
    audioFetch: (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/speech")) {
        return Promise.resolve(new Response(speech, { headers: { "content-type": "audio/mpeg" } }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ text: "matrix transcript" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    },
    speechFetch: () =>
      Promise.resolve(new Response(speech, { headers: { "content-type": "audio/mpeg" } })),
  });
  const setup = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "entitlement-matrix" },
    body: JSON.stringify({
      email: "matrix@example.com",
      name: "Matrix Admin",
      password: "correct horse battery staple",
    }),
  });
  const setupUser = (await setup.json()).user;
  const user = repository.findUser(setupUser.id)!;
  const mutation = { actorId: user.id, action: "test.entitlement_matrix" };
  const created = repository.createProvider({
    slug: "matrix",
    displayName: "Matrix",
    baseUrl: "https://matrix.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "matrix-secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "matrix/all",
    upstreamModelId: "matrix-upstream",
    displayName: "Matrix All",
    capabilities: [
      "chat",
      "streaming",
      "embeddings",
      "image_generation",
      "transcription",
      "translation",
      "speech",
    ],
    contextWindow: 4_096,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: new Date(Date.now() - 1_000).toISOString(),
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 1,
    source: "matrix",
  }, mutation);
  let alias = repository.createModelAlias(
    { alias: "friendly/matrix", targetModelId: model.id },
    {
      actorId: user.id,
      action: "test.model_alias.created",
      targetType: "model_alias",
      requireEmailVerification: false,
      expectedAuthorityEpoch: user.authorityEpoch,
    },
  );
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "matrix@example.com",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };

  const catalogs = async (expected: boolean) => {
    for (const path of ["/api/models", "/v1/models"]) {
      const response = await app.request(path, { headers });
      assertEquals(response.status, 200);
      const data = (await response.json()).data as Array<{ id: string }>;
      assertEquals(data.some((entry) => entry.id === model.publicModelId), expected);
    }
  };
  const invoke = async (modelId: string): Promise<number[]> => {
    const statuses: number[] = [];
    const conversationResponse = await app.request("/api/conversations", {
      method: "POST",
      headers: { ...headers, "idempotency-key": `matrix-conversation-${crypto.randomUUID()}` },
      body: JSON.stringify({ title: "Matrix" }),
    });
    assertEquals(conversationResponse.status, 201);
    const conversation = await conversationResponse.json();
    statuses.push(
      (await app.request(`/api/conversations/${conversation.id}/generate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: "matrix",
          model: modelId,
          parentId: null,
          supersedesId: null,
          expectedVersion: 0,
          idempotencyKey: `matrix-generation-${crypto.randomUUID()}`,
        }),
      })).status,
    );
    for (
      const [path, payload] of [
        ["/v1/chat/completions", {
          model: modelId,
          messages: [{ role: "user", content: "matrix" }],
        }],
        ["/v1/responses", { model: modelId, input: "matrix" }],
        ["/v1/embeddings", { model: modelId, input: "matrix" }],
        ["/v1/images/generations", {
          model: modelId,
          prompt: `matrix ${modelId}`,
          response_format: "b64_json",
        }],
        ["/v1/audio/speech", { model: modelId, input: "matrix", voice: "alloy" }],
      ] as const
    ) {
      const response = await app.request(path, {
        method: "POST",
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(payload),
      });
      statuses.push(response.status);
    }
    for (const path of ["transcriptions", "translations"]) {
      const form = new FormData();
      form.set("model", modelId);
      const audio = wav();
      form.set(
        "file",
        new File([audio.buffer as ArrayBuffer], "matrix.wav", { type: "audio/wav" }),
      );
      statuses.push(
        (await app.request(`/v1/audio/${path}`, {
          method: "POST",
          headers: { cookie: headers.cookie, origin: headers.origin },
          body: form,
        })).status,
      );
    }
    return statuses;
  };

  await catalogs(true);
  for (const id of [model.publicModelId, "friendly/matrix"]) {
    assertEquals(await invoke(id), [201, 200, 200, 200, 200, 200, 200, 200]);
  }

  const replayCases = [
    ["/v1/chat/completions", "matrix-alias-chat-replay", {
      model: alias.alias,
      messages: [{ role: "user", content: "alias replay" }],
    }],
    ["/v1/responses", "matrix-alias-responses-replay", {
      model: alias.alias,
      input: "alias replay",
    }],
  ] as const;
  for (const [path, idempotencyKey, payload] of replayCases) {
    assertEquals(
      (await app.request(path, {
        method: "POST",
        headers: { ...headers, "idempotency-key": idempotencyKey },
        body: JSON.stringify(payload),
      })).status,
      200,
    );
  }
  const retarget = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "matrix/retarget",
    upstreamModelId: "matrix-retarget-upstream",
    displayName: "Matrix Retarget",
    capabilities: ["chat", "streaming"],
    contextWindow: 4_096,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: retarget.id,
    expectedModelVersion: retarget.version,
    effectiveAt: new Date(Date.now() - 1_000).toISOString(),
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 1,
    source: "matrix-retarget",
  }, mutation);
  const replayRestriction = repository.createAccessGroup(
    { name: "matrix-replay-restricted" },
    {
      actorId: user.id,
      action: "test.model_access_group.created",
      targetType: "model_access_group",
      requireEmailVerification: false,
      expectedAuthorityEpoch: user.authorityEpoch,
    },
  );
  const replayRestrictionPolicy = repository.replaceAccessGroupModels(
    replayRestriction.id,
    [model.id],
    replayRestriction.version,
    [],
    {
      actorId: user.id,
      action: "test.model_access_group.models_replaced",
      targetType: "model_access_group",
      targetId: replayRestriction.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: user.authorityEpoch,
    },
  );
  alias = repository.updateModelAlias(alias.id, {
    expectedVersion: alias.version,
    targetModelId: retarget.id,
  }, {
    actorId: user.id,
    action: "test.model_alias.updated",
    targetType: "model_alias",
    targetId: alias.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  for (const [path, idempotencyKey, payload] of replayCases) {
    const denied = await app.request(path, {
      method: "POST",
      headers: { ...headers, "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    });
    assertEquals(denied.status, 404);
    assertEquals((await denied.json()).error.message, "The requested model is unavailable");
  }
  alias = repository.updateModelAlias(alias.id, {
    expectedVersion: alias.version,
    targetModelId: model.id,
  }, {
    actorId: user.id,
    action: "test.model_alias.updated",
    targetType: "model_alias",
    targetId: alias.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  repository.deleteAccessGroup(
    replayRestriction.id,
    replayRestrictionPolicy.version,
    [model.id],
    {
      actorId: user.id,
      action: "test.model_access_group.deleted",
      targetType: "model_access_group",
      targetId: replayRestriction.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: user.authorityEpoch,
    },
  );

  const group = repository.createAccessGroup({ name: "matrix-restricted" }, {
    actorId: user.id,
    action: "test.model_access_group.created",
    targetType: "model_access_group",
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  let policy = repository.replaceAccessGroupPolicy(group.id, {
    expectedVersion: group.version,
    userIds: [user.id],
    modelIds: [model.id],
    tokenIds: [],
    acknowledgePublicModelIds: [],
  }, {
    actorId: user.id,
    action: "test.model_access_group.policy_replaced",
    targetType: "model_access_group",
    targetId: group.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  const entitledLogin = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "matrix@example.com",
      password: "correct horse battery staple",
    }),
  });
  headers.cookie = cookie(entitledLogin);
  await catalogs(true);
  for (const id of [model.publicModelId, "friendly/matrix"]) {
    assertEquals(await invoke(id), [201, 200, 200, 200, 200, 200, 200, 200]);
  }
  assertEquals(
    [...repository.generatedAssets.values()].every((asset) =>
      asset.publicModelId === model.publicModelId
    ),
    true,
  );

  policy = repository.replaceAccessGroupPolicy(group.id, {
    expectedVersion: policy.version,
    userIds: [],
    modelIds: [model.id],
    tokenIds: [],
    acknowledgePublicModelIds: [],
  }, {
    actorId: user.id,
    action: "test.model_access_group.policy_replaced",
    targetType: "model_access_group",
    targetId: group.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  assertEquals(policy.userIds, []);
  const refreshedLogin = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "matrix@example.com",
      password: "correct horse battery staple",
    }),
  });
  headers.cookie = cookie(refreshedLogin);
  await catalogs(false);
  for (const id of [model.publicModelId, "friendly/matrix"]) {
    assertEquals(await invoke(id), [404, 404, 404, 404, 404, 404, 404, 404]);
  }
});
