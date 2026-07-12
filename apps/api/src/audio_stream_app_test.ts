import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { type DomainRepository, MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import type { AudioConcurrencyLimiter } from "./audio-concurrency.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

function wavFile(): Uint8Array {
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

async function fixture(
  audioFetch: typeof fetch,
  audioConcurrencyLimiter?: AudioConcurrencyLimiter,
  inputMicrosPerMillion = 0,
  capability: "transcription" | "translation" = "transcription",
) {
  const repository = new MemoryRepository();
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(7)]]),
  });
  const { app } = createApp({
    repository,
    setupToken: "audio-stream-setup",
    providerKeyring: keyring,
    audioFetch,
    audioConcurrencyLimiter,
  });
  const setup = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "audio-stream-setup" },
    body: JSON.stringify({
      name: "Audio Stream Admin",
      email: "audio-stream@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(setup.status, 201);
  const user = (await setup.json()).user;
  const mutation = { actorId: user.id, action: "test.audio-stream" };
  const created = repository.createProvider({
    slug: "audio-stream-provider",
    displayName: "Audio stream provider",
    baseUrl: "https://audio-stream.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "audio/stream",
    upstreamModelId: "audio-stream-upstream",
    displayName: "Audio stream",
    capabilities: [capability],
    contextWindow: 1_024,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    inputMicrosPerMillion,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 1_000_000,
    fixedCallMicros: 10,
    source: "test",
  }, mutation);
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "audio-stream@example.com",
      password: "correct horse battery",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  const request = (stream = true, idempotencyKey = `audio-stream-${crypto.randomUUID()}`) => {
    const form = new FormData();
    form.set("model", model.publicModelId);
    if (stream) form.set("stream", "true");
    form.set(
      "file",
      new File([wavFile().buffer as ArrayBuffer], "sample.wav", { type: "audio/wav" }),
    );
    return app.request(
      `/v1/audio/${capability === "translation" ? "translations" : "transcriptions"}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: "http://localhost:5173",
          "idempotency-key": idempotencyKey,
        },
        body: form as unknown as BodyInit,
      },
    );
  };
  return { app, cookie, keyring, model, provider, repository, user, request };
}

Deno.test("completed transcription and translation replays reauthorize model access", async () => {
  for (const capability of ["transcription", "translation"] as const) {
    const fx = await fixture(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ text: "stored-sentinel-transcript" }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      undefined,
      0,
      capability,
    );
    const key = `audio-entitlement-replay-${capability}`;
    const completed = await fx.request(false, key);
    assertEquals(completed.status, 200, await completed.clone().text());
    const group = fx.repository.createAccessGroup({ name: `deny-${capability}` });
    fx.repository.replaceAccessGroupModels(group.id, [fx.model.id], group.version);
    const denied = await fx.request(false, key);
    const deniedBody = await denied.text();
    assertEquals(denied.status, 404, deniedBody);
    assertEquals(deniedBody.includes("stored-sentinel"), false);
    assertEquals(JSON.parse(deniedBody).error, {
      message: "The requested model is unavailable",
      type: "invalid_request_error",
      param: null,
      code: "model_not_found",
    });
  }
});

Deno.test("audio terminal done is withheld until stream accounting is durable", async () => {
  let enterComplete!: () => void;
  const completeEntered = new Promise<void>((resolve) => enterComplete = resolve);
  let releaseComplete!: () => void;
  const completeGate = new Promise<void>((resolve) => releaseComplete = resolve);
  const value = await fixture(() =>
    Promise.resolve(
      new Response(
        'data: {"type":"transcript.text.delta","delta":"hello"}\n\n' +
          'data: {"type":"transcript.text.done","text":"hello","usage":{"input_tokens":2,"output_tokens":2}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  );
  const mutable = value.repository as DomainRepository;
  const original = mutable.completeApiStream.bind(mutable);
  mutable.completeApiStream = async (input) => {
    enterComplete();
    await completeGate;
    return await original(input);
  };
  const response = await value.request();
  assertEquals(response.status, 200);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assertStringIncludes(first, "transcript.text.delta");
  await completeEntered;
  const terminalRead = reader.read();
  const premature = await Promise.race([
    terminalRead.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  assertEquals(premature, false);
  releaseComplete();
  const terminal = new TextDecoder().decode((await terminalRead).value);
  assertStringIncludes(terminal, "transcript.text.done");
  await reader.cancel();
});

Deno.test("audio failure bills matching delta and segment representations only once", async () => {
  const value = await fixture(
    () =>
      Promise.resolve(
        new Response(
          'data: {"type":"transcript.text.delta","delta":"visible"}\n\n' +
            'data: {"type":"transcript.text.segment","text":"visible","speaker":"A"}\n\n' +
            'data: {"type":"unsupported.event"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    undefined,
    1_000_000,
  );
  const response = await value.request();
  const body = await response.text();
  assertStringIncludes(body, "visible");
  assertStringIncludes(body, "provider_error");
  const usage = value.repository.usage(value.user.id);
  assertEquals(usage.calls, 1);
  assertEquals(usage.inputTokens, wavFile().byteLength);
  assertEquals(usage.outputTokens, 2);
  assertEquals(usage.spentMicros, 58);
  const run = [...value.repository.usageRuns.values()].at(-1);
  assertExists(run);
  const attempt = value.repository.listProviderAttempts(run.id)[0];
  assertEquals(attempt.status, "failed");
  assertEquals(attempt.outputTokens, 2);
  assertEquals(attempt.visibleOutput, true);
});

Deno.test("audio admission lease loss is a retryable 503 rather than provider failure", async () => {
  const controller = new AbortController();
  controller.abort(new Error("lease lost"));
  const limiter: AudioConcurrencyLimiter = {
    acquire: () =>
      Promise.resolve({
        id: "lost-lease",
        signal: controller.signal,
        release: () => Promise.resolve(),
      }),
    close: () => Promise.resolve(),
  };
  const value = await fixture(
    () => Promise.reject(new Error("provider must not be called")),
    limiter,
  );
  const response = await value.request(false);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "5");
  assertEquals((await response.json()).error.code, "service_unavailable");
});

Deno.test("nonretryable upstream audio 4xx remains a public 400", async () => {
  const value = await fixture(() =>
    Promise.resolve(new Response("invalid audio option", { status: 400 }))
  );
  const response = await value.request(false);
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error.code, "provider_error");
});

Deno.test("completed audio replay bypasses a saturated concurrency limiter", async () => {
  let saturated = false;
  let acquisitions = 0;
  const limiter: AudioConcurrencyLimiter = {
    acquire: () => {
      acquisitions++;
      return Promise.resolve(
        saturated ? null : {
          id: "available",
          signal: new AbortController().signal,
          release: () => Promise.resolve(),
        },
      );
    },
    close: () => Promise.resolve(),
  };
  const value = await fixture(
    () => Promise.resolve(Response.json({ text: "replay me" })),
    limiter,
  );
  const key = "audio-completed-replay";
  const first = await value.request(false, key);
  assertEquals(first.status, 200);
  saturated = true;
  const replay = await value.request(false, key);
  assertEquals(replay.status, 200);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(acquisitions, 1);
});

Deno.test("audio multipart validation completes before concurrency admission", async () => {
  let acquisitions = 0;
  const limiter: AudioConcurrencyLimiter = {
    acquire: () => {
      acquisitions++;
      return Promise.resolve(null);
    },
    close: () => Promise.resolve(),
  };
  const value = await fixture(
    () => Promise.reject(new Error("provider must not run")),
    limiter,
  );
  const form = new FormData();
  form.set("model", value.model.publicModelId);
  form.set("file", new File(["not audio"], "fake.webm", { type: "audio/webm" }));
  const response = await value.app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      cookie: value.cookie,
      origin: "http://localhost:5173",
      "idempotency-key": "invalid-before-admission",
    },
    body: form as unknown as BodyInit,
  });
  assertEquals(response.status, 415);
  assertEquals(acquisitions, 0);
});

Deno.test("duration-only fallback cannot settle through a token-priced public source model", async () => {
  const value = await fixture(
    (input) => {
      const host = new URL(String(input)).hostname;
      if (host === "fixed-duration.example") {
        return Promise.resolve(Response.json({
          text: "duration transcript",
          usage: { type: "duration", seconds: 4 },
        }));
      }
      return Promise.resolve(new Response("source unavailable", { status: 503 }));
    },
    undefined,
    1_000_000,
  );
  const mutation = { actorId: value.user.id, action: "test.duration-fallback" };
  const created = value.repository.createProvider({
    slug: "fixed-duration",
    displayName: "Fixed duration fallback",
    baseUrl: "https://fixed-duration.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = value.repository.setProviderCredential(created.id, created.version, {
    envelope: await value.keyring.encrypt(created.id, created.version + 1, "fallback-secret"),
  }, mutation);
  const fallback = value.repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "audio/fixed-duration",
    upstreamModelId: "fixed-duration-upstream",
    displayName: "Fixed duration",
    capabilities: ["transcription"],
    contextWindow: 1_024,
  }, mutation);
  value.repository.createModelPriceVersion({
    providerModelId: fallback.id,
    expectedModelVersion: fallback.version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 25,
    source: "test",
  }, mutation);
  const policy = value.repository.createProviderRetryPolicy({
    name: "Duration fallback",
    maxAttempts: 2,
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplierBps: 10_000,
    jitterBps: 0,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    retryableStatuses: [503],
  }, mutation);
  value.repository.setProviderModelRoute({
    sourceModelId: value.model.id,
    expectedVersion: 0,
    retryPolicyId: policy.id,
    fallbackModelIds: [fallback.id],
  }, mutation);

  const response = await value.request(false);
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error.code, "unsupported_audio_usage");
  const usage = value.repository.usage(value.user.id);
  assertEquals(usage.calls, 0);
  assertEquals(usage.balanceMicros, 5_000_000);
  const run = [...value.repository.usageRuns.values()].find((entry) =>
    entry.userId === value.user.id && entry.executionEpoch > 0
  );
  assertExists(run);
  assertEquals(run.actualProviderCostMicros > 0, true);
});
