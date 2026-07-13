import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { type DomainRepository, MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import type { AudioConcurrencyLimiter } from "./audio-concurrency.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

const audio = new Uint8Array([
  0x49,
  0x44,
  0x33,
  4,
  0,
  0,
  0,
  0,
  0,
  0,
  0xff,
  0xfb,
  0x90,
  0x64,
]);

async function fixture(options: {
  fetch?: typeof fetch;
  limiter?: AudioConcurrencyLimiter;
  sourceInputRate?: number;
  fallback?: boolean;
  replayBytes?: number;
} = {}) {
  const repository = new MemoryRepository();
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(8)]]),
  });
  let providerCalls = 0;
  const fetchedModels: string[] = [];
  const speechFetch: typeof fetch = options.fetch ?? ((_input, init) => {
    providerCalls++;
    fetchedModels.push(String(JSON.parse(String(init?.body)).model));
    if (options.fallback && providerCalls === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "primary unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(audio, { headers: { "content-type": "audio/mpeg" } }),
    );
  });
  const value = createApp({
    repository,
    setupToken: "speech-route-setup",
    providerKeyring: keyring,
    speechFetch,
    audioConcurrencyLimiter: options.limiter,
    replayQuota: options.replayBytes === undefined
      ? undefined
      : { maxRequests: 16, maxEvents: 16, maxBytes: options.replayBytes },
  });
  const setup = await value.app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "speech-route-setup" },
    body: JSON.stringify({
      name: "Speech Admin",
      email: "speech-route@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(setup.status, 201);
  const user = (await setup.json()).user;
  const mutation = { actorId: user.id, action: "test.speech-route" };
  const created = repository.createProvider({
    slug: "speech-primary",
    displayName: "Speech primary",
    baseUrl: "https://speech-primary.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "primary-secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "speech/public",
    upstreamModelId: "tts-primary",
    displayName: "Speech public",
    capabilities: ["speech"],
    contextWindow: 4_096,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    inputMicrosPerMillion: options.sourceInputRate ?? 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 10,
    source: "public-test",
  }, mutation);
  if (options.fallback) {
    const fallbackCreated = repository.createProvider({
      slug: "speech-fallback",
      displayName: "Speech fallback",
      baseUrl: "https://speech-fallback.example/v1",
      protocol: "chat_completions",
    }, mutation);
    const fallbackProvider = repository.setProviderCredential(
      fallbackCreated.id,
      fallbackCreated.version,
      {
        envelope: await keyring.encrypt(
          fallbackCreated.id,
          fallbackCreated.version + 1,
          "fallback-secret",
        ),
      },
      mutation,
    );
    const fallbackModel = repository.createProviderModel({
      providerId: fallbackProvider.id,
      publicModelId: "speech/fallback",
      upstreamModelId: "tts-fallback",
      displayName: "Speech fallback",
      capabilities: ["speech"],
      contextWindow: 4_096,
    }, mutation);
    repository.createModelPriceVersion({
      providerModelId: fallbackModel.id,
      expectedModelVersion: fallbackModel.version,
      effectiveAt: "2020-01-01T00:00:00.000Z",
      inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0,
      reasoningMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      fixedCallMicros: 100,
      source: "provider-test",
    }, mutation);
    const policy = repository.createProviderRetryPolicy({
      name: "Speech fallback",
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
    repository.setProviderModelRoute({
      sourceModelId: model.id,
      expectedVersion: 0,
      retryPolicyId: policy.id,
      fallbackModelIds: [fallbackModel.id],
    }, mutation);
  }
  const login = await value.app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "speech-route@example.com",
      password: "correct horse battery",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  const request = (
    body: Record<string, unknown> = {
      model: model.publicModelId,
      input: "Read this aloud",
      voice: "alloy",
    },
    idempotencyKey = `speech-${crypto.randomUUID()}`,
    signal?: AbortSignal,
  ) =>
    value.app.request("/v1/audio/speech", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  return {
    ...value,
    cookie,
    fetchedModels,
    get providerCalls() {
      return providerCalls;
    },
    model,
    repository,
    request,
    user,
  };
}

Deno.test("completed speech replay reauthorizes model access", async () => {
  const fx = await fixture();
  const key = "speech-entitlement-replay";
  const completed = await fx.request({
    model: fx.model.publicModelId,
    input: "stored-sentinel-speech-body",
    voice: "alloy",
  }, key);
  assertEquals(completed.status, 200, await completed.clone().text());
  const group = fx.repository.createAccessGroup({ name: "deny-speech-replay" });
  fx.repository.replaceAccessGroupModels(group.id, [fx.model.id], group.version);
  const denied = await fx.request({
    model: fx.model.publicModelId,
    input: "stored-sentinel-speech-body",
    voice: "alloy",
  }, key);
  const deniedBody = await denied.text();
  assertEquals(denied.status, 404, deniedBody);
  assertEquals(deniedBody.includes("stored-sentinel"), false);
  assertEquals(JSON.parse(deniedBody).error, {
    message: "The requested model is unavailable",
    type: "invalid_request_error",
    param: null,
    code: "model_not_found",
  });
});

Deno.test("speech returns and replays exact binary while source pricing survives fallback", async () => {
  const value = await fixture({ fallback: true });
  const models = await value.app.request("/v1/models", {
    headers: { cookie: value.cookie, origin: "http://localhost:5173" },
  });
  assertEquals(models.status, 200);
  assertEquals(
    (await models.json()).data.some((item: { id: string }) =>
      item.id === value.model.publicModelId
    ),
    true,
  );

  const key = "speech-fallback-replay";
  const response = await value.request(undefined, key);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "audio/mpeg");
  assertEquals(new Uint8Array(await response.arrayBuffer()), audio);
  const replay = await value.request(undefined, key);
  assertEquals(replay.status, 200);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(new Uint8Array(await replay.arrayBuffer()), audio);
  assertEquals(value.providerCalls, 2);
  assertEquals(value.fetchedModels, ["tts-primary", "tts-fallback"]);

  const stored = value.repository.getApiRequest(value.user.id, "audio.speech", key);
  assertExists(stored);
  const run = value.repository.usageRuns.get(stored.usageRunId);
  assertEquals({
    customerCost: run?.costMicros,
    providerCost: run?.actualProviderCostMicros,
    customerInput: run?.inputTokens,
    providerInput: run?.actualProviderInputTokens,
  }, {
    customerCost: 10,
    providerCost: 110,
    customerInput: 4,
    providerInput: 8,
  });
});

Deno.test("speech validates before admission or reservation and requires fixed public pricing", async () => {
  let admissions = 0;
  const limiter: AudioConcurrencyLimiter = {
    acquire: () => {
      admissions++;
      return Promise.resolve(null);
    },
    close: () => Promise.resolve(),
  };
  const value = await fixture({ limiter });
  const unknown = await value.request({
    model: value.model.publicModelId,
    input: "hello",
    voice: "alloy",
    surprise: true,
  });
  assertEquals(unknown.status, 422);
  assertEquals(admissions, 0);
  assertEquals(value.repository.usage(value.user.id).calls, 0);

  const oversized = await value.app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      cookie: value.cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: value.model.publicModelId,
      input: "x".repeat(70_000),
      voice: "alloy",
    }),
  });
  assertEquals(oversized.status, 413);
  const wrongType = await value.app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      cookie: value.cookie,
      origin: "http://localhost:5173",
      "content-type": "text/plain",
    },
    body: "not json",
  });
  assertEquals(wrongType.status, 415);
  assertEquals(admissions, 0);

  const variable = await fixture({ sourceInputRate: 1 });
  const invalidPrice = await variable.request();
  assertEquals(invalidPrice.status, 500);
  assertEquals((await invalidPrice.json()).error.code, "unsupported_speech_pricing");
  assertEquals(variable.providerCalls, 0);
  assertEquals(variable.repository.usage(variable.user.id).calls, 0);
});

Deno.test("speech admission failure is refunded once and replays without reacquiring", async () => {
  let admissions = 0;
  const limiter: AudioConcurrencyLimiter = {
    acquire: () => {
      admissions++;
      return Promise.resolve(null);
    },
    close: () => Promise.resolve(),
  };
  const value = await fixture({ limiter });
  const key = "speech-capacity-replay";
  const response = await value.request(undefined, key);
  assertEquals(response.status, 429);
  assertEquals((await response.json()).error.code, "audio_capacity_exceeded");
  const replay = await value.request(undefined, key);
  assertEquals(replay.status, 429);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(admissions, 1);
  assertEquals(value.providerCalls, 0);
  assertEquals(value.repository.usage(value.user.id).calls, 0);
});

Deno.test("speech replay capacity rejects before provider work", async () => {
  const value = await fixture({ replayBytes: 2 });
  const key = "speech-replay-quota";
  const response = await value.request(undefined, key);
  assertEquals(response.status, 413);
  assertEquals((await response.json()).error.code, "response_too_large");
  assertEquals(value.providerCalls, 0);
  assertEquals(value.repository.getApiRequest(value.user.id, "audio.speech", key), undefined);
  assertEquals(value.repository.usage(value.user.id).calls, 0);
});

Deno.test("speech response is withheld until binary replay and settlement are durable", async () => {
  const value = await fixture();
  const repository = value.repository as DomainRepository;
  const complete = repository.completeApiJson.bind(repository);
  let entered!: () => void;
  const completeEntered = new Promise<void>((resolve) => entered = resolve);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  repository.completeApiJson = async (input) => {
    entered();
    await gate;
    return await complete(input);
  };
  let returned = false;
  const pending = Promise.resolve(value.request()).then((response) => {
    returned = true;
    return response;
  });
  await completeEntered;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(returned, false);
  release();
  const response = await pending;
  assertEquals(response.status, 200);
  assertEquals(new Uint8Array(await response.arrayBuffer()), audio);
});

Deno.test("speech client cancellation aborts upstream and refunds customer credit", async () => {
  let dispatched!: () => void;
  const providerDispatched = new Promise<void>((resolve) => dispatched = resolve);
  let upstreamAborted = false;
  const value = await fixture({
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        dispatched();
        const signal = init?.signal;
        const abort = () => {
          upstreamAborted = true;
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
  });
  const controller = new AbortController();
  const pending = Promise.resolve(
    value.request(undefined, "speech-client-cancel", controller.signal),
  );
  await providerDispatched;
  controller.abort(new DOMException("Client disconnected", "AbortError"));
  const response = await pending;
  assertEquals(response.status, 499);
  assertEquals(upstreamAborted, true);
  const stored = value.repository.getApiRequest(
    value.user.id,
    "audio.speech",
    "speech-client-cancel",
  );
  assertExists(stored);
  const run = value.repository.usageRuns.get(stored.usageRunId);
  assertEquals({ status: run?.status, customerCost: run?.costMicros }, {
    status: "failed",
    customerCost: 0,
  });
});

Deno.test("speech admission lease loss fences dispatch and returns replayable 503", async () => {
  const controller = new AbortController();
  controller.abort(new Error("lease lost"));
  let releases = 0;
  const limiter: AudioConcurrencyLimiter = {
    acquire: () =>
      Promise.resolve({
        id: crypto.randomUUID(),
        signal: controller.signal,
        release: () => {
          releases++;
          return Promise.resolve();
        },
      }),
    close: () => Promise.resolve(),
  };
  const value = await fixture({ limiter });
  const key = "speech-lease-lost";
  const response = await value.request(undefined, key);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "5");
  assertEquals((await response.json()).error.code, "service_unavailable");
  const replay = await value.request(undefined, key);
  assertEquals(replay.status, 503);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(releases, 1);
  assertEquals(value.providerCalls, 0);
  assertEquals(value.repository.usage(value.user.id).calls, 0);
});

Deno.test("speech SSE settles before terminal, replays exact frames, and never exposes provider terminal early", async () => {
  const wire = 'data: {"type":"speech.audio.delta","audio":"YXVkaW8="}\r\n\r\n' +
    'data: {"type":"speech.audio.done","usage":{"input_tokens":4,"output_tokens":6,"total_tokens":10}}\r\n\r\n';
  const value = await fixture({
    fetch: () =>
      Promise.resolve(
        new Response(wire, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
  });
  const repository = value.repository as DomainRepository;
  const complete = repository.completeApiStream.bind(repository);
  let entered!: () => void;
  const completeEntered = new Promise<void>((resolve) => entered = resolve);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  repository.completeApiStream = async (input) => {
    entered();
    await gate;
    return await complete(input);
  };
  const key = "speech-sse-terminal-replay";
  const response = await value.request({
    model: value.model.publicModelId,
    input: "stream this",
    voice: "alloy",
    stream_format: "sse",
  }, key);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assertEquals(new TextDecoder().decode(first.value).includes("speech.audio.delta"), true);
  await completeEntered;
  let terminalVisible = false;
  const pendingTerminal = reader.read().then((part) => {
    terminalVisible = true;
    return part;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(terminalVisible, false);
  release();
  const terminal = await pendingTerminal;
  assertEquals(new TextDecoder().decode(terminal.value).includes("speech.audio.done"), true);
  await reader.cancel();
  const replay = await value.request({
    model: value.model.publicModelId,
    input: "stream this",
    voice: "alloy",
    stream_format: "sse",
  }, key);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  const replayText = await replay.text();
  assertEquals(replayText.includes("speech.audio.delta"), true);
  assertEquals(replayText.match(/speech\.audio\.done/g)?.length, 1);
  const stored = value.repository.getApiRequest(value.user.id, "audio.speech", key);
  assertExists(stored);
  const attempt = value.repository.listProviderAttempts(stored.usageRunId)[0];
  assertEquals({
    status: attempt?.status,
    visible: attempt?.visibleOutput,
    tokenSource: attempt?.tokenSource,
    ttft: attempt?.ttftMs !== null,
  }, {
    status: "succeeded",
    visible: true,
    tokenSource: "provider",
    ttft: true,
  });
});

Deno.test("speech SSE settles visible partial audio and refunds pre-visible failure", async () => {
  const visible = await fixture({
    fetch: () =>
      Promise.resolve(
        new Response(
          'data: {"type":"speech.audio.delta","audio":"YXVkaW8="}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  const visibleKey = "speech-sse-visible-failure";
  const visibleResponse = await visible.request({
    model: visible.model.publicModelId,
    input: "partial",
    voice: "alloy",
    stream_format: "sse",
  }, visibleKey);
  const visibleText = await visibleResponse.text();
  assertEquals(visibleText.includes("speech.audio.delta"), true);
  assertEquals(visibleText.includes("provider_error"), true);
  const visibleStored = visible.repository.getApiRequest(
    visible.user.id,
    "audio.speech",
    visibleKey,
  );
  assertExists(visibleStored);
  const visibleRun = visible.repository.usageRuns.get(visibleStored.usageRunId);
  assertEquals({ status: visibleRun?.status, cost: visibleRun?.costMicros }, {
    status: "completed",
    cost: 10,
  });
  assertEquals(visibleRun?.outputTokens, 0);
  const visibleAttempt = visible.repository.listProviderAttempts(visibleStored.usageRunId)[0];
  assertEquals({
    visible: visibleAttempt?.visibleOutput,
    outputTokens: visibleAttempt?.outputTokens,
    tokenSource: visibleAttempt?.tokenSource,
  }, { visible: true, outputTokens: 0, tokenSource: "estimated" });

  const hidden = await fixture({
    fetch: () =>
      Promise.resolve(
        new Response(
          'data: {"type":"speech.audio.done","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  const hiddenKey = "speech-sse-hidden-failure";
  const hiddenResponse = await hidden.request({
    model: hidden.model.publicModelId,
    input: "nothing",
    voice: "alloy",
    stream_format: "sse",
  }, hiddenKey);
  assertEquals((await hiddenResponse.text()).includes("provider_error"), true);
  const hiddenStored = hidden.repository.getApiRequest(hidden.user.id, "audio.speech", hiddenKey);
  assertExists(hiddenStored);
  const hiddenRun = hidden.repository.usageRuns.get(hiddenStored.usageRunId);
  assertEquals({ status: hiddenRun?.status, cost: hiddenRun?.costMicros }, {
    status: "failed",
    cost: 0,
  });
});

Deno.test("speech SSE downstream cancellation aborts stalled upstream, settles visible work, and releases admission", async () => {
  let upstreamCancelled = false;
  let releases = 0;
  const limiter: AudioConcurrencyLimiter = {
    acquire: () =>
      Promise.resolve({
        id: crypto.randomUUID(),
        signal: new AbortController().signal,
        release: () => {
          releases++;
          return Promise.resolve();
        },
      }),
    close: () => Promise.resolve(),
  };
  const value = await fixture({
    limiter,
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"type":"speech.audio.delta","audio":"YXVkaW8="}\n\n',
              ));
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  const key = "speech-sse-downstream-cancel";
  const response = await value.request({
    model: value.model.publicModelId,
    input: "cancel after audio",
    voice: "alloy",
    stream_format: "sse",
  }, key);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assertEquals(new TextDecoder().decode(first.value).includes("speech.audio.delta"), true);
  await reader.cancel("consumer stopped");
  for (let index = 0; index < 50 && (!upstreamCancelled || releases === 0); index++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(upstreamCancelled, true);
  assertEquals(releases, 1);
  const stored = value.repository.getApiRequest(value.user.id, "audio.speech", key);
  assertExists(stored);
  const run = value.repository.usageRuns.get(stored.usageRunId);
  assertEquals({ status: run?.status, cost: run?.costMicros, outputTokens: run?.outputTokens }, {
    status: "completed",
    cost: 10,
    outputTokens: 0,
  });
});
