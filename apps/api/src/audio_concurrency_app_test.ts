import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import type { AudioConcurrencyLimiter } from "./audio-concurrency.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

const emptyWav = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46,
  0x24,
  0,
  0,
  0,
  0x57,
  0x41,
  0x56,
  0x45,
  0x66,
  0x6d,
  0x74,
  0x20,
  16,
  0,
  0,
  0,
  1,
  0,
  1,
  0,
  0x40,
  0x1f,
  0,
  0,
  0x80,
  0x3e,
  0,
  0,
  2,
  0,
  16,
  0,
  0x64,
  0x61,
  0x74,
  0x61,
  0,
  0,
  0,
  0,
]);

async function adminCookie(app: ReturnType<typeof createApp>["app"]): Promise<string> {
  const response = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "audio-admission-test" },
    body: JSON.stringify({
      email: "audio-admission@example.com",
      password: "correct horse battery",
      name: "Audio Admin",
    }),
  });
  assertEquals(response.status, 201);
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "audio-admission@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return cookie;
}

async function audioRequest(
  app: ReturnType<typeof createApp>["app"],
  cookie: string,
): Promise<Response> {
  const form = new FormData();
  form.set("model", "audio/model");
  form.set("file", new File([emptyWav], "clip.wav", { type: "audio/wav" }));
  return await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173" },
    body: form as unknown as BodyInit,
  });
}

async function admissionApp(limiter: AudioConcurrencyLimiter) {
  const repository = new MemoryRepository();
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(4)]]),
  });
  const value = createApp({
    repository,
    setupToken: "audio-admission-test",
    providerKeyring: keyring,
    audioConcurrencyLimiter: limiter,
  });
  const cookie = await adminCookie(value.app);
  const admin = repository.listUsers()[0];
  const mutation = { actorId: admin.id, action: "test.audio-admission" };
  const created = repository.createProvider({
    slug: "audio-admission",
    displayName: "Audio admission",
    baseUrl: "https://audio.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "audio/model",
    upstreamModelId: "audio-model",
    displayName: "Audio model",
    capabilities: ["transcription"],
    contextWindow: 1_024,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 1,
    source: "test",
  }, mutation);
  return { app: value.app, cookie };
}

Deno.test("audio admission infrastructure outages fail closed with an OpenAI 503", async () => {
  const limiter: AudioConcurrencyLimiter = {
    acquire: () => Promise.reject(new Error("redis unavailable")),
    close: () => Promise.resolve(),
  };
  const { app, cookie } = await admissionApp(limiter);
  const response = await audioRequest(app, cookie);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "5");
  assertEquals((await response.json()).error.code, "service_unavailable");
});

Deno.test("audio admission capacity remains a 429", async () => {
  const limiter: AudioConcurrencyLimiter = {
    acquire: () => Promise.resolve(null),
    close: () => Promise.resolve(),
  };
  const { app, cookie } = await admissionApp(limiter);
  const response = await audioRequest(app, cookie);
  assertEquals(response.status, 429);
  assertEquals((await response.json()).error.code, "audio_capacity_exceeded");
});
