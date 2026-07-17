import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";
import { TestObjectStore } from "./test-object-store.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { maximumImageStreamReplayBytes } from "./images.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const alternatePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngCrc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  view.setUint32(8 + data.byteLength, pngCrc32(result.subarray(4, 8 + data.byteLength)));
  return result;
}

async function rgbaPng(width: number, red: number): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, 1);
  header.set([8, 6, 0, 0, 0], 8);
  const pixels = new Uint8Array(1 + width * 4);
  for (let offset = 1; offset < pixels.length; offset += 4) {
    pixels.set([red, 17, 29, 255], offset);
  }
  const compressed = new Uint8Array(
    await new Response(
      new Blob([pixels]).stream().pipeThrough(
        new CompressionStream("deflate"),
      ),
    ).arrayBuffer(),
  );
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

const onePixelPng = (red: number) => rgbaPng(1, red);

async function fixture(options: {
  providerUsage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  rateLimiter?: RateLimiter;
  streaming?: "success" | "before_partial_failure" | "after_partial_failure" | "disconnect";
  replayMaxBytes?: number;
  fallback?: boolean;
  editing?: boolean;
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
    imageFetch: async (input, init) => {
      calls++;
      const contentType = new Headers(init?.headers).get("content-type") ?? "";
      if (contentType.startsWith("multipart/form-data;")) {
        const form = await new Request(input, init).formData();
        assertEquals(form.get("model"), "upstream-image");
        assertEquals(form.get("response_format"), "b64_json");
        if (form.get("stream") === "true") {
          return new Response(
            `event: image_edit.completed\ndata: ${
              JSON.stringify({
                type: "image_edit.completed",
                b64_json: png,
                created_at: 125,
              })
            }\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({
          created: 125,
          data: [{ b64_json: png, revised_prompt: "Edited robot" }],
        });
      }
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
  const setupUser = (await setup.json()).user;
  const user = repository.findUser(setupUser.id)!;
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
    capabilities: ["image_generation", ...(options.editing ? ["image_editing" as const] : [])],
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
    model,
    user,
  };
}

Deno.test("completed image generation and edit replays reauthorize model access", async () => {
  for (const editing of [false, true]) {
    const fx = await fixture({ editing });
    const key = `image-entitlement-replay-${editing ? "edit" : "generation"}`;
    const headers = { cookie: fx.cookie, "idempotency-key": key };
    const request = () => {
      if (!editing) {
        return fx.app.request("/v1/images/generations", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            model: fx.model.publicModelId,
            prompt: "stored-sentinel-image-body",
            response_format: "b64_json",
          }),
        });
      }
      const form = new FormData();
      form.set("model", fx.model.publicModelId);
      form.set("prompt", "stored-sentinel-edit-body");
      form.set("response_format", "b64_json");
      form.set(
        "image[]",
        new Blob([Uint8Array.from(atob(png), (part) => part.charCodeAt(0))], {
          type: "image/png",
        }),
        "source.png",
      );
      return fx.app.request("/v1/images/edits", {
        method: "POST",
        headers,
        body: form,
      });
    };
    const completed = await request();
    assertEquals(completed.status, 200, await completed.clone().text());
    const group = fx.repository.createAccessGroup({ name: `deny-${editing}` }, {
      actorId: fx.user.id,
      action: "test.model_access_group.created",
      targetType: "model_access_group",
      requireEmailVerification: false,
      expectedAuthorityEpoch: fx.user.authorityEpoch,
    });
    fx.repository.replaceAccessGroupModels(group.id, [fx.model.id], group.version, [], {
      actorId: fx.user.id,
      action: "test.model_access_group.models_replaced",
      targetType: "model_access_group",
      targetId: group.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: fx.user.authorityEpoch,
    });
    const denied = await request();
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

Deno.test("rich image replay reserves metadata rather than an unused base64 payload", async () => {
  const fx = await fixture({ replayMaxBytes: 8 * 1024 * 1024 });
  const response = await fx.app.request("/api/images/generations", {
    method: "POST",
    headers: {
      cookie: fx.cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
      "idempotency-key": "rich-image-metadata-replay",
    },
    body: JSON.stringify({
      model: "images/public",
      prompt: "Asset metadata should fit without reserving base64 bytes",
      response_format: "url",
    }),
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(fx.calls(), 1);
  const body = await response.json();
  assertEquals(body.assets.length, 1);
  assertEquals(typeof body.assets[0].contentUrl, "string");
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
  assertEquals(first.status, 200, firstBody);
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

Deno.test("image edits support multipart, immutable lineage, JSON file IDs, and exact replay", async () => {
  const fx = await fixture({ editing: true });
  const editForm = () => {
    const form = new FormData();
    form.append("model", "images/public");
    form.append("prompt", "Polish this robot");
    form.append(
      "image",
      new Blob([
        Uint8Array.from(atob(png), (part) => part.charCodeAt(0)),
      ], { type: "image/png" }),
      "source.png",
    );
    form.append(
      "mask",
      new Blob([Uint8Array.from(atob(alternatePng), (part) => part.charCodeAt(0))], {
        type: "image/png",
      }),
      "mask.png",
    );
    return form;
  };
  const headers = { cookie: fx.cookie, "idempotency-key": "image-edit-multipart-key" };
  const first = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers,
    body: editForm(),
  });
  const firstBody = await first.text();
  assertEquals(first.status, 200, firstBody);
  const asset = fx.repository.listGeneratedAssets((await fx.repository.listUsers())[0].id)[0];
  assertEquals(asset.operation, "edit");
  assertEquals(asset.inputs.map((input) => [input.role, input.ordinal]), [
    ["source", 0],
    ["mask", 0],
  ]);
  const gallery = await fx.app.request("/api/images", { headers: { cookie: fx.cookie } });
  const galleryBody = await gallery.json();
  assertEquals(galleryBody.data[0].sourceAttachmentIds, [asset.inputs[0].attachmentId]);
  const replay = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers,
    body: editForm(),
  });
  assertEquals(await replay.text(), firstBody);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");

  const rich = await fx.app.request("/api/images/edits", {
    method: "POST",
    headers: {
      cookie: fx.cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "images/public",
      prompt: "Edit by owned file ID",
      images: [{ file_id: asset.attachmentId }],
    }),
  });
  assertEquals(rich.status, 200);
  const richBody = await rich.json();
  assertEquals(richBody.assets[0].operation, "edit");
  const sourceLookup = await fx.app.request(
    `/api/images/by-attachment/${asset.attachmentId}?before=${
      encodeURIComponent(richBody.assets[0].createdAt)
    }&exclude=${richBody.assets[0].id}`,
    { headers: { cookie: fx.cookie } },
  );
  assertEquals(sourceLookup.status, 200);
  assertEquals((await sourceLookup.json()).id, asset.id);
  const invalidLookup = await fx.app.request(
    `/api/images/by-attachment/${asset.attachmentId}?exclude=not-a-uuid`,
    { headers: { cookie: fx.cookie } },
  );
  assertEquals(invalidLookup.status, 422);
  const missingSource = await fx.app.request(
    `/api/images/by-attachment/${crypto.randomUUID()}`,
    { headers: { cookie: fx.cookie } },
  );
  assertEquals(missingSource.status, 404);
  assertEquals(fx.calls(), 2);

  const remote = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      model: "images/public",
      prompt: "No remote fetch",
      images: [{ image_url: "http://127.0.0.1/private" }],
    }),
  });
  assertEquals(remote.status, 422);
  assertEquals((await remote.json()).error.code, "remote_image_url_unsupported");
});

Deno.test("image edit SSE uses official event names and settles before completion", async () => {
  const fx = await fixture({ editing: true });
  const form = new FormData();
  form.append("model", "images/public");
  form.append("prompt", "Stream this edit");
  form.append("stream", "true");
  form.append(
    "image",
    new Blob([
      Uint8Array.from(atob(png), (part) => part.charCodeAt(0)),
    ], { type: "image/png" }),
    "source.png",
  );
  const response = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie },
    body: form,
  });
  assertEquals(response.status, 200);
  const body = await response.text();
  assertEquals(body.includes("image_edit.completed"), true, body);
  assertEquals(body.includes("image_generation.completed"), false);
  const run = [...fx.repository.usageRuns.values()].at(-1)!;
  assertEquals([run.status, run.costMicros], ["completed", 25]);
});

Deno.test("image edit persists sixteen sources plus a mask before provider dispatch", async () => {
  const fx = await fixture({ editing: true });
  const form = new FormData();
  form.append("model", "images/public");
  form.append("prompt", "Composite every layer");
  for (let index = 0; index < 16; index++) {
    form.append(
      "image[]",
      new Blob([(await onePixelPng(index + 1)).buffer as ArrayBuffer], { type: "image/png" }),
      `source-${index + 1}.png`,
    );
  }
  form.append(
    "mask",
    new Blob([(await onePixelPng(200)).buffer as ArrayBuffer], { type: "image/png" }),
    "mask.png",
  );
  const response = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie },
    body: form,
  });
  assertEquals(response.status, 200, await response.text());
  assertEquals(fx.calls(), 1);
  const asset = fx.repository.listGeneratedAssets((await fx.repository.listUsers())[0].id)[0];
  assertEquals(asset.inputs.filter((input) => input.role === "source").length, 16);
  assertEquals(asset.inputs.filter((input) => input.role === "mask").length, 1);
});

Deno.test("image edit input persistence failure refunds and terminates idempotency before dispatch", async () => {
  const fx = await fixture({ editing: true });
  const originalPut = fx.objectStore.put.bind(fx.objectStore);
  fx.objectStore.put = async (input) => {
    if (input.key.includes("/edit-inputs/") && input.key.endsWith("/0.png")) {
      throw new Error("injected edit input storage failure");
    }
    if (input.key.includes("/edit-inputs/") && input.key.endsWith("/1.png")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return await originalPut(input);
  };
  const form = new FormData();
  form.append("model", "images/public");
  form.append("prompt", "Fail before provider dispatch");
  form.append(
    "image[]",
    new Blob([
      Uint8Array.from(atob(png), (part) => part.charCodeAt(0)),
    ], { type: "image/png" }),
    "source.png",
  );
  form.append(
    "image[]",
    new Blob([Uint8Array.from(atob(alternatePng), (part) => part.charCodeAt(0))], {
      type: "image/png",
    }),
    "delayed-source.png",
  );
  const response = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie, "idempotency-key": "image-edit-storage-failure-key" },
    body: form,
  });
  assertEquals(response.status, 502);
  assertEquals(fx.calls(), 0);
  const run = [...fx.repository.usageRuns.values()].at(-1)!;
  assertEquals([run.status, run.costMicros], ["failed", 0]);
  const inputStages = [...fx.repository.generatedObjectStages.values()].filter((stage) =>
    stage.purpose === "edit_input"
  );
  assertEquals(inputStages.length, 2);
  assertEquals(inputStages.every((stage) => stage.state === "cleanup_pending"), true);
  const apiRequest = [...fx.repository.apiIdempotencyRequests.values()].at(-1)!;
  assertEquals(apiRequest.state, "failed");
  const replayForm = new FormData();
  replayForm.append("model", "images/public");
  replayForm.append("prompt", "Fail before provider dispatch");
  replayForm.append(
    "image[]",
    new Blob([
      Uint8Array.from(atob(png), (part) => part.charCodeAt(0)),
    ], { type: "image/png" }),
    "source.png",
  );
  replayForm.append(
    "image[]",
    new Blob([Uint8Array.from(atob(alternatePng), (part) => part.charCodeAt(0))], {
      type: "image/png",
    }),
    "delayed-source.png",
  );
  const replay = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie, "idempotency-key": "image-edit-storage-failure-key" },
    body: replayForm,
  });
  assertEquals(replay.status, 502);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(fx.calls(), 0);
});

Deno.test("duplicate source and mask fail before reservation and provider dispatch", async () => {
  const fx = await fixture({ editing: true });
  const imageBytes = Uint8Array.from(atob(png), (part) => part.charCodeAt(0));
  const multipart = new FormData();
  multipart.append("model", "images/public");
  multipart.append("prompt", "Reject duplicate mask bytes");
  multipart.append("image", new Blob([imageBytes], { type: "image/png" }), "source.png");
  multipart.append("mask", new Blob([imageBytes], { type: "image/png" }), "mask.png");
  const multipartResponse = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie },
    body: multipart,
  });
  assertEquals(multipartResponse.status, 422);

  const jsonResponse = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      model: "images/public",
      prompt: "Reject duplicate mask ID",
      images: [{ file_id: "same-attachment" }],
      mask: { file_id: "same-attachment" },
    }),
  });
  assertEquals(jsonResponse.status, 422);
  assertEquals(fx.calls(), 0);
  assertEquals(fx.repository.usageRuns.size, 0);
});

Deno.test("invalid stored JSON edit input returns a stable validation error", async () => {
  const fx = await fixture({ editing: true });
  const generated = await fx.app.request("/v1/images/generations", {
    method: "POST",
    headers: { cookie: fx.cookie, "content-type": "application/json" },
    body: JSON.stringify({ model: "images/public", prompt: "source to corrupt" }),
  });
  assertEquals(generated.status, 200);
  const owner = (await fx.repository.listUsers())[0].id;
  const source = fx.repository.listGeneratedAssets(owner)[0];
  const mismatch = await rgbaPng(2, 211);
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", mismatch.buffer as ArrayBuffer),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const objectKey = `users/${owner}/image-edit-tests/${digest}.png`;
  await fx.objectStore.put({
    key: objectKey,
    body: new Blob([mismatch.buffer as ArrayBuffer]).stream(),
    contentLength: mismatch.byteLength,
    contentType: "image/png",
    metadata: { sha256: digest },
  });
  const mismatchAttachment = fx.repository.createAttachment({
    ownerId: owner,
    objectKey,
    filename: "two-pixels.png",
    mimeType: "image/png",
    sizeBytes: mismatch.byteLength,
    sha256: digest,
    state: "ready",
    inspectionComplete: true,
  }).attachment;
  const response = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      model: "images/public",
      prompt: "must not become a 500",
      images: [{ file_id: source.attachmentId }, { file_id: mismatchAttachment.id }],
    }),
  });
  assertEquals(response.status, 422);
  assertEquals((await response.json()).error.code, "invalid_image_edit");
  assertEquals(fx.calls(), 1);
});

Deno.test("repeated multipart edits deduplicate safely across run-scoped stages", async () => {
  const fx = await fixture({ editing: true });
  const form = () => {
    const value = new FormData();
    value.append("model", "images/public");
    value.append("prompt", "Repeat safely");
    value.append(
      "image[]",
      new Blob([
        Uint8Array.from(atob(png), (part) => part.charCodeAt(0)),
      ], { type: "image/png" }),
      "same.png",
    );
    return value;
  };
  for (let index = 0; index < 2; index++) {
    const response = await fx.app.request("/v1/images/edits", {
      method: "POST",
      headers: { cookie: fx.cookie },
      body: form(),
    });
    assertEquals(response.status, 200);
  }
  assertEquals(fx.calls(), 2);
  assertEquals(fx.repository.generatedObjectStages.size, 4);
  assertEquals(
    [...fx.repository.generatedObjectStages.values()].every((stage) =>
      ["finalized", "cleanup_pending"].includes(stage.state)
    ),
    true,
  );
  const cleanup = [...fx.repository.generatedObjectStages.values()].filter((stage) =>
    stage.state === "cleanup_pending"
  );
  assertEquals(cleanup.length > 0, true);
  assertEquals(
    cleanup.every((stage) =>
      fx.repository.jobs.some((job) =>
        job.type === "generated_object.cleanup" &&
        (job.payload as { stageId?: string }).stageId === stage.id
      )
    ),
    true,
  );
});

Deno.test("completed JSON edit replay needs metadata but not deleted source bytes", async () => {
  const fx = await fixture({ editing: true });
  const generated = await fx.app.request("/v1/images/generations", {
    method: "POST",
    headers: { cookie: fx.cookie, "content-type": "application/json" },
    body: JSON.stringify({ model: "images/public", prompt: "source" }),
  });
  assertEquals(generated.status, 200);
  const source = fx.repository.listGeneratedAssets((await fx.repository.listUsers())[0].id)[0];
  const headers = {
    cookie: fx.cookie,
    "content-type": "application/json",
    "idempotency-key": "image-edit-json-outage-key",
  };
  const body = JSON.stringify({
    model: "images/public",
    prompt: "replay without bytes",
    images: [{ file_id: source.attachmentId }],
  });
  const first = await fx.app.request("/v1/images/edits", { method: "POST", headers, body });
  const firstBody = await first.text();
  assertEquals(first.status, 200);
  fx.repository.deleteAttachment(source.attachmentId, source.ownerId);
  const originalGet = fx.objectStore.get.bind(fx.objectStore);
  fx.objectStore.get = () => Promise.reject(new Error("storage outage"));
  const replay = await fx.app.request("/v1/images/edits", { method: "POST", headers, body });
  fx.objectStore.get = originalGet;
  assertEquals(replay.status, 200);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await replay.text(), firstBody);
  assertEquals(fx.calls(), 2);
});

Deno.test("crash-left objects plus attachment dedup schedule durable cleanup for edit inputs and outputs", async () => {
  const fx = await fixture({ editing: true });
  const form = () => {
    const value = new FormData();
    value.append("model", "images/public");
    value.append("prompt", "Recover staged duplicates");
    value.append(
      "image[]",
      new Blob([Uint8Array.from(atob(png), (part) => part.charCodeAt(0))], {
        type: "image/png",
      }),
      "same.png",
    );
    return value;
  };
  assertEquals(
    (await fx.app.request("/v1/images/edits", {
      method: "POST",
      headers: { cookie: fx.cookie },
      body: form(),
    })).status,
    200,
  );
  const originalPut = fx.objectStore.put.bind(fx.objectStore);
  fx.objectStore.put = async (input) => {
    await originalPut(input);
    return await originalPut(input);
  };
  const recovered = await fx.app.request("/v1/images/edits", {
    method: "POST",
    headers: { cookie: fx.cookie },
    body: form(),
  });
  fx.objectStore.put = originalPut;
  assertEquals(recovered.status, 200, await recovered.text());
  const pending = [...fx.repository.generatedObjectStages.values()].filter((stage) =>
    stage.state === "cleanup_pending"
  );
  assertEquals(new Set(pending.map((stage) => stage.purpose)), new Set(["output", "edit_input"]));
  assertEquals(pending.every((stage) => stage.cleanupAttachment === false), true);
});

Deno.test("completed image replay is denied after provider and model disable", async () => {
  const { app, repository, cookie, calls } = await fixture();
  const headers = {
    cookie,
    "content-type": "application/json",
    "idempotency-key": "image-disabled-complete-key",
  };
  const body = JSON.stringify({ model: "images/public", prompt: "immutable replay robot" });
  const first = await app.request("/v1/images/generations", { method: "POST", headers, body });
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
  assertEquals(replay.status, 404);
  assertEquals(await replay.json(), {
    error: {
      message: "The requested model is unavailable",
      type: "invalid_request_error",
      param: null,
      code: "model_not_found",
    },
  });
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

Deno.test("generated persistence failures retain bytes for durable cleanup, including ambiguous commits", async () => {
  for (const ambiguousCommit of [false, true]) {
    const { app, repository, objectStore, cookie } = await fixture();
    const original = repository.createAttachmentFromGeneratedObjectStage.bind(repository);
    let deletionAttempts = 0;
    objectStore.delete = (key) => {
      deletionAttempts++;
      objectStore.objects.delete(key);
      return Promise.resolve();
    };
    repository.createAttachmentFromGeneratedObjectStage = (id, ownerId, input, quota) => {
      if (ambiguousCommit) original(id, ownerId, input, quota);
      throw new Error(
        ambiguousCommit
          ? "simulated lost commit acknowledgement"
          : "simulated attachment transaction failure",
      );
    };
    const response = await app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": `generated-attachment-${ambiguousCommit ? "ambiguous" : "failed"}`,
      },
      body: JSON.stringify({ model: "images/public", prompt: "retain durable bytes" }),
    });
    assertEquals(response.status, 502);
    assertEquals(deletionAttempts, 0, "the request path must never race durable cleanup");
    assertEquals(
      objectStore.objects.size,
      1,
      "stored bytes remain available to the cleanup worker",
    );
    const stages = [...repository.generatedObjectStages.values()];
    assertEquals(stages.length, 1);
    assertEquals(stages[0].state, "cleanup_pending");
    assertEquals(
      [...repository.attachments.values()].filter((attachment) => attachment.deletedAt === null)
        .length,
      ambiguousCommit ? 1 : 0,
    );
    assertEquals(
      repository.jobs.some((job) =>
        job.idempotencyKey === `generated_object.cleanup:${stages[0].id}` &&
        job.status === "queued"
      ),
      true,
    );
  }
});

Deno.test("stale image finalization reauthorizes its stored canonical model before reclaim", async () => {
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
  assertEquals(recovered.status, 404);
  assertEquals((await recovered.json()).error, {
    message: "The requested model is unavailable",
    type: "invalid_request_error",
    param: null,
    code: "model_not_found",
  });
  assertEquals(calls(), 1);
  assertEquals(request.state, "in_progress");
  assertEquals([...repository.usageRuns.values()].at(-1)?.costMicros, 0);
  const immutable = [...repository.generatedAssets.values()][0];
  assertEquals([immutable.publicModelId, immutable.upstreamModelId, immutable.providerSlug], [
    "images/public",
    "upstream-image",
    "image-primary",
  ]);
});

Deno.test("buffered image crash recovery accepts an alias for its canonical asset", async () => {
  const { app, repository, cookie, calls, model, user } = await fixture();
  repository.createModelAlias(
    { alias: "images/buffered-recovery-alias", targetModelId: model.id },
    {
      actorId: user.id,
      action: "test.model_alias.created",
      targetType: "model_alias",
      requireEmailVerification: false,
      expectedAuthorityEpoch: user.authorityEpoch,
    },
  );
  const originalComplete = repository.completeApiJson.bind(repository);
  const originalFail = repository.failApiRequest.bind(repository);
  let crashComplete = true;
  let crashFailure = true;
  repository.completeApiJson = (input) => {
    if (crashComplete) {
      crashComplete = false;
      throw new Error("simulated crash after aliased asset finalization");
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
    "idempotency-key": "image-alias-buffered-crash-key",
  };
  const body = JSON.stringify({
    model: "images/buffered-recovery-alias",
    prompt: "recover aliased buffered robot",
  });
  const interrupted = await app.request("/v1/images/generations", {
    method: "POST",
    headers,
    body,
  });
  assertEquals(interrupted.status, 500);
  const stored = [...repository.apiIdempotencyRequests.values()].find((candidate) =>
    candidate.idempotencyKey === "image-alias-buffered-crash-key"
  )!;
  stored.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
  const recovered = await app.request("/v1/images/generations", { method: "POST", headers, body });
  assertEquals(recovered.status, 200, await recovered.clone().text());
  assertEquals(calls(), 1);
  assertEquals([...repository.generatedAssets.values()][0].publicModelId, model.publicModelId);
});

Deno.test("stream crash recovery preserves exact partial SSE frames and provider timestamp", async () => {
  const { app, repository, cookie, calls, user } = await fixture({
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
  const canonical = repository.findProviderModel("images/public")!;
  repository.createModelAlias({
    alias: "images/stream-recovery-alias",
    targetModelId: canonical.id,
  }, {
    actorId: user.id,
    action: "test.model_alias.created",
    targetType: "model_alias",
    requireEmailVerification: false,
    expectedAuthorityEpoch: user.authorityEpoch,
  });
  const headers = {
    cookie,
    "content-type": "application/json",
    "idempotency-key": "image-partial-crash-key",
  };
  const body = JSON.stringify({
    model: "images/stream-recovery-alias",
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
