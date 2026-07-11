import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp, redactRequestLog } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";
import { TestObjectStore } from "./test-object-store.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { maximumImageStreamReplayBytes } from "./images.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

Deno.test("signed image capability queries are always redacted from request logs", () => {
  for (const query of ["token=secret", "%74oken=secret", "x=1&to%6ben=secret"]) {
    const redacted = redactRequestLog(
      `--> GET /v1/images/assets/00000000-0000-4000-8000-000000000001/content?${query} 200`,
    );
    assertEquals(redacted.includes("secret"), false);
    assertEquals(redacted.includes("?[REDACTED]"), true);
  }
});

async function fixture(options: {
  providerUsage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  rateLimiter?: RateLimiter;
  streaming?: "success" | "before_partial_failure" | "after_partial_failure" | "disconnect";
  replayMaxBytes?: number;
  fallback?: boolean;
} = {}) {
  const repository = new MemoryRepository();
  const objectStore = new TestObjectStore();
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(9)]]),
  });
  let calls = 0;
  const calledModels: string[] = [];
  const value = createApp({
    repository,
    objectStore,
    setupToken: "image-route-setup",
    providerKeyring: keyring,
    imageUrlSigningSecret: "image-url-signing-secret-for-tests-32-bytes",
    ...(options.replayMaxBytes
      ? { replayQuota: { maxBytes: options.replayMaxBytes, maxEvents: 10_000, maxRequests: 1_000 } }
      : {}),
    rateLimiter: options.rateLimiter,
    imageFetch: (_input, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      calledModels.push(request.model);
      assertEquals(request.response_format, "b64_json");
      if (options.fallback && request.model === "upstream-image") {
        return Promise.resolve(new Response("retry", { status: 500 }));
      }
      if (options.streaming) {
        assertEquals(request.stream, true);
        const events = [
          `event: image_generation.partial_image\ndata: ${
            JSON.stringify({
              type: "image_generation.partial_image",
              b64_json: png,
              created_at: 122,
              partial_image_index: 0,
            })
          }\n\n`,
          `event: image_generation.completed\ndata: ${
            JSON.stringify({
              type: "image_generation.completed",
              b64_json: png,
              created_at: 123,
              ...(options.providerUsage ? { usage: options.providerUsage } : {}),
            })
          }\n\n`,
        ].join("");
        if (options.streaming === "before_partial_failure") {
          return Promise.resolve(
            new Response("data: not-json\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }
        if (options.streaming === "after_partial_failure") {
          return Promise.resolve(
            new Response(events.slice(0, events.indexOf("event: image_generation.completed")), {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }
        if (options.streaming === "disconnect") {
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(
                    events.slice(0, events.indexOf("event: image_generation.completed")),
                  ));
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(new Blob([events]).stream(), {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      return Promise.resolve(Response.json({
        created: 123,
        data: [{ b64_json: png, revised_prompt: "A polished robot" }],
        ...(options.providerUsage ? { usage: options.providerUsage } : {}),
      }));
    },
  });
  const setup = await value.app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "image-route-setup" },
    body: JSON.stringify({
      name: "Image Admin",
      email: "image-route@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(setup.status, 201);
  const user = (await setup.json()).user;
  const mutation = { actorId: user.id, action: "test.image-route" };
  const created = repository.createProvider({
    slug: "image-primary",
    displayName: "Image primary",
    baseUrl: "https://image-primary.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "image-secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "images/public",
    upstreamModelId: "upstream-image",
    displayName: "Image public",
    capabilities: ["image_generation"],
    contextWindow: 32_000,
  }, mutation);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 25,
    source: "test",
  }, mutation);
  let fallbackModel;
  let fallbackProvider;
  if (options.fallback) {
    const createdFallback = repository.createProvider({
      slug: "image-fallback",
      displayName: "Image fallback",
      baseUrl: "https://image-fallback.example/v1",
      protocol: "chat_completions",
    }, mutation);
    fallbackProvider = repository.setProviderCredential(
      createdFallback.id,
      createdFallback.version,
      {
        envelope: await keyring.encrypt(
          createdFallback.id,
          createdFallback.version + 1,
          "fallback",
        ),
      },
      mutation,
    );
    fallbackModel = repository.createProviderModel({
      providerId: fallbackProvider.id,
      publicModelId: "images/fallback",
      upstreamModelId: "fallback-upstream-image",
      displayName: "Fallback image",
      capabilities: ["image_generation"],
      contextWindow: 32_000,
    }, mutation);
    repository.createModelPriceVersion({
      providerModelId: fallbackModel.id,
      expectedModelVersion: fallbackModel.version,
      effectiveAt: "2020-01-01T00:00:00.000Z",
      inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0,
      reasoningMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      fixedCallMicros: 999,
      source: "fallback-test",
    }, mutation);
    const policy = repository.createProviderRetryPolicy({
      name: "Image route fallback",
      maxAttempts: 2,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplierBps: 10_000,
      jitterBps: 0,
      firstTokenTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 10_000,
      retryableStatuses: [500],
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
      email: "image-route@example.com",
      password: "correct horse battery",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return {
    ...value,
    repository,
    objectStore,
    cookie,
    calls: () => calls,
    calledModels,
    fallbackModel,
    fallbackProvider,
  };
}

Deno.test("image streaming persists and settles before its terminal event and replays exactly", async () => {
  const { app, repository, objectStore, cookie, calls } = await fixture({
    streaming: "success",
    replayMaxBytes: 80 * 1024 * 1024,
  });
  const headers = {
    cookie,
    origin: "http://localhost:5173",
    "content-type": "application/json",
    "idempotency-key": "image-stream-replay-key",
  };
  const payload = JSON.stringify({
    model: "images/public",
    prompt: "A streamed robot",
    response_format: "b64_json",
    stream: true,
    partial_images: 1,
  });
  const response = await app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body: payload,
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type")?.startsWith("text/event-stream"), true);
  const body = await response.text();
  assertEquals(body.includes("image_generation.partial_image"), true);
  assertEquals(body.includes("image_generation.completed"), true);
  assertEquals(body.indexOf("partial_image") < body.indexOf("completed"), true);
  assertEquals(repository.listGeneratedAssets((await repository.listUsers())[0].id).length, 1);
  assertEquals(objectStore.objects.size, 1);
  assertEquals([...repository.usageRuns.values()].at(-1)?.status, "completed");

  const replay = await app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body: payload,
  });
  assertEquals(replay.status, 200);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await replay.text(), body);
  assertEquals(calls(), 1);
});

for (const stream of [false, true]) {
  Deno.test(`image ${stream ? "SSE" : "buffered"} fallback persists winning provenance and source billing`, async () => {
    const fx = await fixture({
      fallback: true,
      ...(stream ? { streaming: "success" as const } : {}),
    });
    const response = await fx.app.request("/v1/images/generations", {
      method: "POST",
      headers: { cookie: fx.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        model: "images/public",
        prompt: "fallback billing robot",
        ...(stream ? { stream: true, partial_images: 1 } : {}),
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.text();
    assertEquals(body.includes(stream ? "image_generation.completed" : "b64_json"), true);
    assertEquals(fx.calledModels, ["upstream-image", "fallback-upstream-image"]);
    const asset = fx.repository.listGeneratedAssets(
      (await fx.repository.listUsers())[0].id,
    )[0];
    assertEquals(asset.providerModelId, fx.fallbackModel!.id);
    assertEquals(asset.publicModelId, "images/public");
    assertEquals(asset.upstreamModelId, "fallback-upstream-image");
    assertEquals(asset.providerSlug, fx.fallbackProvider!.slug);
    assertEquals(asset.pricingSnapshot.fixedCallMicros, 25);
    const run = [...fx.repository.usageRuns.values()].at(-1)!;
    assertEquals([run.status, run.costMicros, run.pricingSnapshot?.fixedCallMicros], [
      "completed",
      25,
      25,
    ]);
  });
}

Deno.test("idempotent image stream replay capacity is rejected before dispatch at the boundary", async () => {
  const required = maximumImageStreamReplayBytes({ partialImages: 1 });
  const rejected = await fixture({ streaming: "success", replayMaxBytes: required - 1 });
  const request = (app: typeof rejected.app, cookie: string) =>
    app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "content-type": "application/json",
        "idempotency-key": "image-capacity-boundary-key",
      },
      body: JSON.stringify({
        model: "images/public",
        prompt: "Replay capacity boundary",
        stream: true,
        partial_images: 1,
      }),
    });
  const tooSmall = await request(rejected.app, rejected.cookie);
  assertEquals(tooSmall.status, 413);
  assertEquals(rejected.calls(), 0);
  assertEquals(rejected.repository.usageRuns.size, 0);

  const accepted = await fixture({ streaming: "success", replayMaxBytes: required });
  const exact = await request(accepted.app, accepted.cookie);
  assertEquals(exact.status, 200);
  assertEquals((await exact.text()).includes("image_generation.completed"), true);
  assertEquals(accepted.calls(), 1);
});

Deno.test("completed image stream replay survives a lower quota after restart", async () => {
  const required = maximumImageStreamReplayBytes({ partialImages: 1 });
  const original = await fixture({
    streaming: "success",
    replayMaxBytes: required,
  });
  const headers = {
    cookie: original.cookie,
    "content-type": "application/json",
    "idempotency-key": "image-quota-restart-key",
  };
  const body = JSON.stringify({
    model: "images/public",
    prompt: "quota restart robot",
    stream: true,
    partial_images: 1,
  });
  const first = await original.app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body,
  });
  const firstBody = await first.text();
  assertEquals(first.status, 200);
  const restarted = createApp({
    repository: original.repository,
    replayQuota: { maxBytes: required - 1, maxEvents: 10_000, maxRequests: 1_000 },
  });
  const replay = await restarted.app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body,
  });
  assertEquals(replay.status, 200);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await replay.text(), firstBody);
  assertEquals(original.calls(), 1);
});

for (const scenario of ["before_partial_failure", "after_partial_failure"] as const) {
  Deno.test(`image streaming ${scenario.replaceAll("_", " ")} accounts safely`, async () => {
    const { app, repository, objectStore, cookie } = await fixture({
      streaming: scenario,
      replayMaxBytes: 80 * 1024 * 1024,
    });
    const response = await app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "content-type": "application/json",
        "idempotency-key": `image-${scenario}-key`,
      },
      body: JSON.stringify({
        model: "images/public",
        prompt: "A failing streamed robot",
        stream: true,
        partial_images: 1,
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.text();
    assertEquals(body.includes("provider_error"), true, body);
    assertEquals(body.includes("image_generation.completed"), false);
    assertEquals(repository.listGeneratedAssets((await repository.listUsers())[0].id).length, 0);
    assertEquals(objectStore.objects.size, 0);
    const run = [...repository.usageRuns.values()].at(-1)!;
    assertEquals(run.status, scenario === "after_partial_failure" ? "completed" : "failed");
    assertEquals(run.costMicros, scenario === "after_partial_failure" ? run.reservedMicros : 0);
  });
}

Deno.test("cancelling an image stream aborts upstream and settles an exposed partial", async () => {
  const { app, repository, objectStore, cookie } = await fixture({ streaming: "disconnect" });
  const response = await app.request("/v1/images/generations", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({
      model: "images/public",
      prompt: "A cancelled streamed robot",
      stream: true,
      partial_images: 1,
    }),
  });
  const reader = response.body!.getReader();
  const first = await reader.read();
  assertEquals(new TextDecoder().decode(first.value).includes("partial_image"), true);
  await reader.cancel("test disconnect");
  for (let attempt = 0; attempt < 50; attempt++) {
    if ([...repository.usageRuns.values()].at(-1)?.status !== "reserved") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = [...repository.usageRuns.values()].at(-1)!;
  assertEquals(run.status, "completed");
  assertEquals(run.costMicros, run.reservedMicros);
  assertEquals(repository.listGeneratedAssets((await repository.listUsers())[0].id).length, 0);
  assertEquals(objectStore.objects.size, 0);
});

Deno.test("image generation persists immutable assets, accounts usage, and replays safely", async () => {
  const { app, repository, objectStore, cookie, calls } = await fixture();
  const headers = {
    cookie,
    origin: "http://localhost:5173",
    "content-type": "application/json",
    "idempotency-key": "image-replay-key",
  };
  const payload = JSON.stringify({
    model: "images/public",
    prompt: "A polished robot",
    response_format: "b64_json",
  });
  const response = await app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body: payload,
  });
  assertEquals(response.status, 200);
  const generated = await response.json();
  assertEquals(generated, {
    created: 123,
    data: [{ b64_json: png, revised_prompt: "A polished robot" }],
  });
  assertEquals(calls(), 1);
  assertEquals(objectStore.objects.size, 1);
  const assets = repository.listGeneratedAssets((await repository.listUsers())[0].id);
  assertEquals(assets.length, 1);
  assertEquals([assets[0].width, assets[0].height], [1, 1]);
  const run = [...repository.usageRuns.values()].at(-1);
  assertExists(run);
  assertEquals([run.status, run.costMicros], ["completed", 25]);

  const replay = await app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body: payload,
  });
  assertEquals(replay.status, 200);
  assertEquals(await replay.json(), generated);
  assertEquals(calls(), 1);

  const listed = await app.request("/api/images", { headers });
  assertEquals(listed.status, 200);
  const listedBody = await listed.json();
  assertEquals(listedBody.data.length, 1);
  const assetId = listedBody.data[0].id;
  const content = await app.request(`/api/images/${assetId}/content`, { headers });
  assertEquals(content.status, 200);
  assertEquals(content.headers.get("content-type"), "image/png");
  assertEquals(btoa(String.fromCharCode(...new Uint8Array(await content.arrayBuffer()))), png);

  // Generated history owns its lifecycle independently from the attachment picker. The retained
  // immutable object remains readable through the live asset, but not through arbitrary deleted
  // attachment routes.
  repository.deleteAttachment(assets[0].attachmentId, assets[0].ownerId);
  assertEquals((await app.request(`/api/images/${assetId}/content`, { headers })).status, 200);
  assertEquals(
    (await app.request(`/api/attachments/${assets[0].attachmentId}/content`, { headers })).status,
    404,
  );

  assertEquals(
    (await app.request(`/api/images/${assetId}`, {
      method: "DELETE",
      headers,
    })).status,
    204,
  );
  assertEquals((await app.request(`/api/images/${assetId}/content`, { headers })).status, 404);
  const deletedView = await app.request(`/api/images/${assetId}`, { headers });
  assertEquals(deletedView.status, 200);
  assertEquals((await deletedView.json()).contentUrl, null);
  assertEquals(
    (await app.request(`/api/images/${assetId}/restore`, {
      method: "POST",
      headers,
    })).status,
    200,
  );
  assertEquals((await app.request(`/api/images/${assetId}/content`, { headers })).status, 200);

  const rich = await app.request("/api/images/generations", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "image-rich-key" },
    body: JSON.stringify({ model: "images/public", prompt: "A second robot", n: 1 }),
  });
  assertEquals(rich.status, 200);
  const richBody = await rich.json();
  assertEquals(richBody.data, undefined);
  assertEquals(richBody.assets.length, 1);
  assertEquals({
    operation: richBody.assets[0].operation,
    prompt: richBody.assets[0].prompt,
    model: richBody.assets[0].model,
    mimeType: richBody.assets[0].mimeType,
    sizeBytes: richBody.assets[0].sizeBytes,
    status: richBody.assets[0].status,
  }, {
    operation: "generation",
    prompt: "A second robot",
    model: "images/public",
    mimeType: "image/png",
    sizeBytes: Uint8Array.from(atob(png), (part) => part.charCodeAt(0)).byteLength,
    status: "ready",
  });

  const callsBeforeUrl = calls();
  const rejectedUrlReplay = await app.request("/v1/images/generations", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "image-signed-url-key" },
    body: JSON.stringify({
      model: "images/public",
      prompt: "A signed robot",
      response_format: "url",
    }),
  });
  assertEquals(rejectedUrlReplay.status, 422);
  assertEquals(calls(), callsBeforeUrl);
  const urlResponse = await app.request("/v1/images/generations", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({
      model: "images/public",
      prompt: "A signed robot",
      response_format: "url",
    }),
  });
  assertEquals(urlResponse.status, 200);
  const signedUrl = (await urlResponse.json()).data[0].url as string;
  const signedContent = await app.request(signedUrl);
  assertEquals(signedContent.status, 200);
  assertEquals(signedContent.headers.get("content-type"), "image/png");
  const tampered = new URL(signedUrl);
  const token = tampered.searchParams.get("token")!;
  tampered.searchParams.set("token", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`);
  assertEquals((await app.request(tampered)).status, 403);

  const firstPage = await app.request("/api/images?limit=1&include_deleted=true", { headers });
  assertEquals(firstPage.status, 200);
  const firstPageBody = await firstPage.json();
  assertEquals(firstPageBody.data.length, 1);
  assertEquals(typeof firstPageBody.nextCursor, "string");
  const secondPage = await app.request(
    `/api/images?limit=1&include_deleted=true&cursor=${
      encodeURIComponent(firstPageBody.nextCursor)
    }`,
    { headers },
  );
  assertEquals(secondPage.status, 200);
  const secondPageBody = await secondPage.json();
  assertEquals(secondPageBody.data.length, 1);
  assertEquals(secondPageBody.data[0].id === firstPageBody.data[0].id, false);
  assertEquals(
    (await app.request("/api/images?cursor=not-a-cursor", { headers })).status,
    422,
  );
});

Deno.test("completed image replay remains exact after provider and model rename and disable", async () => {
  const { app, repository, cookie, calls } = await fixture();
  const headers = {
    cookie,
    "content-type": "application/json",
    "idempotency-key": "image-disabled-complete-key",
  };
  const body = JSON.stringify({ model: "images/public", prompt: "immutable replay robot" });
  const first = await app.request("/v1/images/generations", { method: "POST", headers, body });
  const firstBody = await first.text();
  assertEquals(first.status, 200);
  const model = repository.findProviderModel("images/public")!;
  const provider = repository.findProvider(model.providerId)!;
  const actorId = (await repository.listUsers())[0].id;
  repository.updateProviderModel(model.id, model.version, {
    publicModelId: "images/renamed-disabled",
    upstreamModelId: "renamed-upstream",
    enabled: false,
  }, { actorId, action: "test.model-disabled" });
  repository.updateProvider(provider.id, provider.version, {
    slug: "renamed-disabled-provider",
    enabled: false,
  }, { actorId, action: "test.provider-disabled" });
  const replay = await app.request("/v1/images/generations", { method: "POST", headers, body });
  assertEquals(replay.status, 200);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await replay.text(), firstBody);
  assertEquals(calls(), 1);
});

Deno.test("token-priced images use authoritative usage and expose it on the OpenAI response", async () => {
  const providerUsage = { input_tokens: 7, output_tokens: 13, total_tokens: 20 };
  const { app, repository, cookie, calls } = await fixture({ providerUsage });
  const model = (await repository.listProviderModels()).find((candidate) =>
    candidate.publicModelId === "images/public"
  );
  assertExists(model);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: new Date(Date.now() + 1).toISOString(),
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 2_000_000,
    fixedCallMicros: 5,
    source: "token-image-test",
  }, { action: "test.token-image-price" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const response = await app.request("/v1/images/generations", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ model: "images/public", prompt: "robot" }),
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.usage, providerUsage);
  assertEquals(calls(), 1);
  const run = [...repository.usageRuns.values()].at(-1);
  assertExists(run);
  assertEquals(run.reservedMicros, 96_005);
  assertEquals(run.costMicros, 38);
});

Deno.test("image generation rejects usage-less token pricing after dispatch", async () => {
  const { app, repository, cookie, calls } = await fixture();
  const model = (await repository.listProviderModels()).find((candidate) =>
    candidate.publicModelId === "images/public"
  );
  assertExists(model);
  const current = await repository.effectiveModelPrice(model.id);
  assertExists(current);
  repository.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: new Date(Date.now() + 1).toISOString(),
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 0,
    source: "invalid-image-test",
  }, { action: "test.invalid-image-price" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const response = await app.request("/v1/images/generations", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ model: "images/public", prompt: "robot" }),
  });
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error.code, "provider_error");
  assertEquals(calls(), 1);
  const run = [...repository.usageRuns.values()].at(-1);
  assertExists(run);
  assertEquals(run.status, "failed");
  assertEquals(run.costMicros, 0);
});

Deno.test("provider usage outside image reservation bounds is rejected and charges the reservation", async () => {
  const providerUsage = { input_tokens: 32_001, output_tokens: 1, total_tokens: 32_002 };
  const { app, repository, cookie, calls } = await fixture({ providerUsage });
  const response = await app.request("/v1/images/generations", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ model: "images/public", prompt: "robot" }),
  });
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error.code, "invalid_provider_usage");
  assertEquals(calls(), 1);
  const run = [...repository.usageRuns.values()].at(-1);
  assertExists(run);
  assertEquals(run.status, "completed");
  assertEquals(run.costMicros, run.reservedMicros);
});

Deno.test("completed provider work is charged when immutable storage fails", async () => {
  const { app, repository, objectStore, cookie, calls } = await fixture();
  objectStore.put = () => Promise.reject(new Error("storage unavailable"));
  const response = await app.request("/v1/images/generations", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": "image-storage-failure",
    },
    body: JSON.stringify({ model: "images/public", prompt: "robot" }),
  });
  assertEquals(response.status, 502);
  assertEquals(calls(), 1);
  const run = [...repository.usageRuns.values()].at(-1);
  assertExists(run);
  assertEquals([run.status, run.costMicros], ["completed", 25]);
  assertEquals(repository.listGeneratedAssets(run.userId).length, 0);
});

Deno.test("reclaimed image idempotency uses its immutable pricing without provider redispatch", async () => {
  const { app, repository, cookie, calls } = await fixture();
  const originalComplete = repository.completeApiJson.bind(repository);
  const originalFail = repository.failApiRequest.bind(repository);
  let interruptComplete = true;
  let interruptFailure = true;
  repository.completeApiJson = (input) => {
    if (interruptComplete) {
      interruptComplete = false;
      throw new Error("simulated crash after asset finalization");
    }
    return originalComplete(input);
  };
  repository.failApiRequest = (input) => {
    if (interruptFailure) {
      interruptFailure = false;
      throw new Error("simulated accounting connection loss");
    }
    return originalFail(input);
  };
  const headers = {
    cookie,
    "content-type": "application/json",
    "idempotency-key": "image-finalize-crash-key",
  };
  const body = JSON.stringify({ model: "images/public", prompt: "recover this robot" });
  const interrupted = await app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body,
  });
  assertEquals(interrupted.status, 500);
  assertEquals(calls(), 1);
  assertEquals(repository.generatedAssets.size, 1);
  const request = [...repository.apiIdempotencyRequests.values()].find((candidate) =>
    candidate.idempotencyKey === "image-finalize-crash-key"
  );
  assertExists(request);
  request.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
  const currentModel = repository.findProviderModel("images/public")!;
  repository.createModelPriceVersion({
    providerModelId: currentModel.id,
    expectedModelVersion: currentModel.version,
    effectiveAt: "2025-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    reasoningMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    fixedCallMicros: 10_000,
    source: "changed-after-finalization",
  }, { actorId: (await repository.listUsers())[0].id, action: "test.price-change" });
  const renamedModel = repository.findProviderModel("images/public")!;
  const renamedProvider = repository.findProvider(renamedModel.providerId)!;
  const actorId = (await repository.listUsers())[0].id;
  repository.updateProviderModel(renamedModel.id, renamedModel.version, {
    publicModelId: "images/recovery-renamed",
    upstreamModelId: "recovery-renamed-upstream",
    enabled: false,
  }, { actorId, action: "test.recovery-model-disabled" });
  repository.updateProvider(renamedProvider.id, renamedProvider.version, {
    slug: "recovery-provider-renamed",
    enabled: false,
  }, { actorId, action: "test.recovery-provider-disabled" });

  const recovered = await app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body,
  });
  assertEquals(recovered.status, 200);
  assertEquals((await recovered.json()).data[0].b64_json, png);
  assertEquals(calls(), 1);
  assertEquals(request.state, "completed");
  assertEquals([...repository.usageRuns.values()].at(-1)?.costMicros, 25);
  const immutable = [...repository.generatedAssets.values()][0];
  assertEquals([immutable.publicModelId, immutable.upstreamModelId, immutable.providerSlug], [
    "images/public",
    "upstream-image",
    "image-primary",
  ]);
});

Deno.test("stream crash recovery preserves exact partial SSE frames and provider timestamp", async () => {
  const { app, repository, cookie, calls } = await fixture({
    streaming: "success",
    replayMaxBytes: 80 * 1024 * 1024,
  });
  const originalComplete = repository.completeApiStream.bind(repository);
  const originalFail = repository.failApiRequest.bind(repository);
  let crashComplete = true;
  let crashFailure = true;
  repository.completeApiStream = (input) => {
    if (crashComplete) {
      crashComplete = false;
      throw new Error("simulated stream crash after asset finalization");
    }
    return originalComplete(input);
  };
  repository.failApiRequest = (input) => {
    if (crashFailure) {
      crashFailure = false;
      throw new Error("simulated accounting transport loss");
    }
    return originalFail(input);
  };
  const headers = {
    cookie,
    "content-type": "application/json",
    "idempotency-key": "image-partial-crash-key",
  };
  const body = JSON.stringify({
    model: "images/public",
    prompt: "recover progressive robot",
    stream: true,
    partial_images: 1,
  });
  const interrupted = await app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body,
  });
  await interrupted.text().catch(() => undefined);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (repository.generatedAssets.size === 1 && !crashComplete && !crashFailure) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(repository.generatedAssets.size, 1);
  const stored = [...repository.apiIdempotencyRequests.values()].find((candidate) =>
    candidate.idempotencyKey === "image-partial-crash-key"
  )!;
  stored.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
  const recovered = await app.request("/v1/images/generations", { method: "POST", headers, body });
  const recoveredBody = await recovered.text();
  assertEquals(recovered.status, 200);
  assertEquals(recoveredBody.includes('"created_at":122'), true);
  assertEquals(recoveredBody.includes('"created_at":123'), true);
  assertEquals(recoveredBody.includes("image_generation.partial_image"), true);
  const replay = await app.request("/v1/images/generations", { method: "POST", headers, body });
  assertEquals(await replay.text(), recoveredBody);
  assertEquals(calls(), 1);
});

Deno.test("generated image content rejects same-length object tampering", async () => {
  const { app, repository, objectStore, cookie } = await fixture();
  const response = await app.request("/v1/images/generations", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ model: "images/public", prompt: "integrity robot" }),
  });
  assertEquals(response.status, 200);
  const asset = repository.listGeneratedAssets((await repository.listUsers())[0].id)[0];
  const attachment = repository.getAttachment(asset.attachmentId, asset.ownerId, true);
  const stored = objectStore.objects.get(attachment.objectKey)!;
  stored.bytes[stored.bytes.length - 1] ^= 1;
  const content = await app.request(`/api/images/${asset.id}/content`, {
    headers: { cookie },
  });
  assertEquals(content.status, 503);
  assertEquals((await content.json()).error.code, "generated_asset_corrupt");
});

Deno.test("image concurrency refusal is fail-closed before provider dispatch", async () => {
  const limiter = {
    acquire: () => Promise.resolve(null),
    close: () => Promise.resolve(),
  };
  const repository = new MemoryRepository();
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(4)]]),
  });
  let calls = 0;
  const value = createApp({
    repository,
    objectStore: new TestObjectStore(),
    setupToken: "capacity-setup",
    providerKeyring: keyring,
    imageConcurrencyLimiter: limiter,
    imageFetch: () => {
      calls++;
      return Promise.resolve(Response.json({ created: 1, data: [{ b64_json: png }] }));
    },
  });
  const setup = await value.app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "capacity-setup" },
    body: JSON.stringify({
      name: "Capacity Admin",
      email: "capacity@example.test",
      password: "correct horse battery",
    }),
  });
  const user = (await setup.json()).user;
  const mutation = { actorId: user.id, action: "test.capacity" };
  const created = repository.createProvider({
    slug: "capacity-images",
    displayName: "Capacity images",
    baseUrl: "https://capacity.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repository.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "secret"),
  }, mutation);
  const model = repository.createProviderModel({
    providerId: provider.id,
    publicModelId: "images/capacity",
    upstreamModelId: "capacity",
    displayName: "Capacity",
    capabilities: ["image_generation"],
    contextWindow: 1,
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
  const login = await value.app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "capacity@example.test",
      password: "correct horse battery",
    }),
  });
  const response = await value.app.request("/v1/images/generations", {
    method: "POST",
    headers: {
      cookie: login.headers.get("set-cookie")!.split(";", 1)[0],
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "images/capacity", prompt: "robot" }),
  });
  assertEquals(response.status, 429);
  assertEquals((await response.json()).error.code, "image_capacity_exceeded");
  assertEquals(calls, 0);
});

Deno.test("OpenAI and rich image generation share the distributed generation rate policy", async () => {
  const keys: string[] = [];
  const limiter: RateLimiter = {
    consume: (key, limit) => {
      keys.push(`${key}:${limit}`);
      return Promise.resolve({ allowed: true, limit, remaining: limit - 1, retryAfterSeconds: 60 });
    },
    health: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  const { app, cookie } = await fixture({ rateLimiter: limiter });
  keys.length = 0;
  for (
    const [path, prompt] of [
      ["/v1/images/generations", "rate one"],
      ["/api/images/generations", "rate two"],
    ] as const
  ) {
    const response = await app.request(path, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "images/public", prompt }),
    });
    assertEquals(response.status, 200);
  }
  assertEquals(keys.length, 2);
  assertEquals(keys.every((key) => key.startsWith("generation:") && key.endsWith(":30")), true);
  assertEquals(keys[0].split(":").slice(0, -1), keys[1].split(":").slice(0, -1));
});
