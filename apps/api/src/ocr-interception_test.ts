import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { DomainError, MemoryRepository } from "@dg-chat/database";
import { MemoryCircuitBreaker } from "./provider-circuit.ts";
import { ProviderExecutionEngine } from "./provider-execution.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";
import {
  interceptOcrImages,
  MemoryOcrCache,
  OcrInterceptionError,
  parseOcrInterceptionConfig,
} from "./ocr-interception.ts";

const png = (width = 1, height = 1) => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};
const data = (bytes = png()) => `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
const inline = (mime: string, bytes: Uint8Array) =>
  `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`;
const gif = (frames = 1) => {
  const bytes = [
    ...new TextEncoder().encode("GIF89a"),
    1,
    0,
    1,
    0,
    0,
    0,
    0,
  ];
  for (let index = 0; index < frames; index++) {
    bytes.push(
      0x2c,
      0,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      2,
      2,
      0x4c,
      0x01,
      0,
    );
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
};
const animatedWebp = () => {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes[20] = 0x02;
  return bytes;
};
const request = (url = data()): ChatCompletionRequest => ({
  model: "visionless",
  messages: [{
    role: "user",
    content: [{ type: "text", text: "read" }, {
      type: "image_url",
      image_url: { url },
    }],
  }],
});
const config = parseOcrInterceptionConfig({
  ocr: {
    enabled: true,
    providerId: "ocr-provider",
    model: "ocr-model",
    prompt: "Extract all visible text.",
    cacheTtlSeconds: 60,
    timeoutMs: 1_000,
    maxBytes: 1_024,
    maxPixels: 100,
    maxDimension: 10,
    maxRedirects: 1,
  },
})!;

Deno.test("OCR configuration is explicit, bounded, and does not contain credentials", () => {
  assertEquals(parseOcrInterceptionConfig({}), null);
  assertEquals(config.providerId, "ocr-provider");
  assertThrows(() =>
    parseOcrInterceptionConfig({
      ocr: {
        enabled: true,
        providerId: "",
        model: "x",
        prompt: "x",
      },
    }), TypeError);
  assertThrows(
    () =>
      parseOcrInterceptionConfig({
        ocr: {
          enabled: true,
          providerId: "provider",
          model: "model",
          prompt: "read",
          apiKey: "must-never-live-in-model-settings",
        },
      }),
    TypeError,
    "unsupported field",
  );
});

Deno.test("OCR replaces images without mutating the caller and caches by image and settings", async () => {
  const cache = new MemoryOcrCache();
  let calls = 0;
  const recognize = () => {
    calls++;
    return Promise.resolve(" invoice 42 ");
  };
  const original = request();
  const first = await interceptOcrImages(
    original,
    config,
    { cache, recognize },
    new AbortController().signal,
  );
  const second = await interceptOcrImages(
    original,
    config,
    { cache, recognize },
    new AbortController().signal,
  );
  assertEquals(calls, 1);
  assertEquals(first.messages[0].content?.[1], {
    type: "text",
    text: "[OCR image 1.2]\ninvoice 42",
  });
  assertEquals(second.messages, first.messages);
  assertEquals(
    (original.messages[0].content as unknown[])[1] !== first.messages[0].content?.[1],
    true,
  );
});

Deno.test("OCR rejects provider text beyond the bounded parent-prompt volume", async () => {
  await assertRejects(
    () =>
      interceptOcrImages(request(), config, {
        cache: new MemoryOcrCache(),
        recognize: () => Promise.resolve("x".repeat(65_537)),
      }, new AbortController().signal),
    OcrInterceptionError,
    "invalid text",
  );
  await assertRejects(
    () =>
      interceptOcrImages(request(), config, {
        cache: {
          get: () => Promise.resolve("x".repeat(65_537)),
          set: () => Promise.resolve(),
        },
        recognize: () => Promise.reject(new Error("cache hit must not dispatch")),
      }, new AbortController().signal),
    OcrInterceptionError,
    "invalid text",
  );
});

Deno.test("OCR cache expires and prompt changes invalidate its hashed key", async () => {
  let now = 0;
  const cache = new MemoryOcrCache(() => now);
  let calls = 0;
  const recognize = () => Promise.resolve(String(++calls));
  await interceptOcrImages(request(), config, { cache, recognize }, new AbortController().signal);
  await interceptOcrImages(
    request(),
    { ...config, prompt: "different" },
    { cache, recognize },
    new AbortController().signal,
  );
  now = 61_000;
  await interceptOcrImages(request(), config, { cache, recognize }, new AbortController().signal);
  assertEquals(calls, 3);
});

Deno.test("OCR cache is isolated by user and invalidated by provider execution revisions", async () => {
  const cache = new MemoryOcrCache();
  let calls = 0;
  const recognize = () => Promise.resolve(String(++calls));
  const scope = {
    userId: "user-a",
    providerVersion: 2,
    credentialUpdatedAt: "2026-07-13T00:00:00.000Z",
    modelVersion: 3,
    upstreamModelId: "vision-v1",
  };
  const run = (cacheScope: typeof scope) =>
    interceptOcrImages(
      request(),
      config,
      { cache, recognize, cacheScope },
      new AbortController().signal,
    );
  await run(scope);
  await run(scope);
  assertEquals(calls, 1);
  await run({ ...scope, userId: "user-b" });
  await run({ ...scope, providerVersion: 3 });
  await run({ ...scope, credentialUpdatedAt: "2026-07-13T01:00:00.000Z" });
  await run({ ...scope, modelVersion: 4 });
  await run({ ...scope, upstreamModelId: "vision-v2" });
  assertEquals(calls, 6);
});

Deno.test("memory OCR cache eagerly expires entries and evicts least-recently-used values", async () => {
  let now = 0;
  const cache = new MemoryOcrCache(() => now, { maxEntries: 2, maxBytes: 6 });
  await cache.set("one", "111", 10);
  await cache.set("two", "22", 10);
  assertEquals(await cache.get("one"), "111");
  await cache.set("three", "3", 10);
  assertEquals(await cache.get("two"), null);
  assertEquals(await cache.get("one"), "111");
  assertEquals(await cache.get("three"), "3");

  now = 10_001;
  await cache.set("four", "4444", 10);
  assertEquals(await cache.get("one"), null);
  assertEquals(await cache.get("three"), null);
  assertEquals(await cache.get("four"), "4444");
  assertThrows(() => cache.set("oversized", "1234567", 10), TypeError, "safe bounds");
});

Deno.test("OCR rejects animated GIF and WebP images before recognition", async () => {
  let recognitions = 0;
  const dependencies = {
    cache: new MemoryOcrCache(),
    recognize: () => {
      recognitions++;
      return Promise.resolve("text");
    },
  };
  const staticResult = await interceptOcrImages(
    request(inline("image/gif", gif())),
    config,
    dependencies,
    new AbortController().signal,
  );
  assertEquals(staticResult.messages[0].content?.[1], {
    type: "text",
    text: "[OCR image 1.2]\ntext",
  });
  for (
    const [value, message] of [
      [inline("image/gif", gif(2)), "Animated GIF"],
      [inline("image/webp", animatedWebp()), "Animated WebP"],
    ] as const
  ) {
    await assertRejects(
      () =>
        interceptOcrImages(
          request(value),
          config,
          dependencies,
          new AbortController().signal,
        ),
      OcrInterceptionError,
      message,
    );
  }
  assertEquals(recognitions, 1);
});

Deno.test("OCR rejects MIME confusion, oversized dimensions, and private targets with context", async () => {
  const dependencies = { cache: new MemoryOcrCache(), recognize: () => Promise.resolve("x") };
  for (
    const [input, detail] of [
      [data(gif()), "declared MIME"],
      [data(png(11, 1)), "dimensions"],
      ["https://127.0.0.1/secret.png", "private"],
    ] as const
  ) {
    const error = await assertRejects(
      () => interceptOcrImages(request(input), config, dependencies, new AbortController().signal),
      OcrInterceptionError,
      detail,
    );
    assertEquals(error.context, {
      messageIndex: 0,
      partIndex: 1,
      sourceKind: input.startsWith("data:") ? "inline" : "remote",
    });
  }
});

Deno.test("OCR remote fetch enforces redirect, MIME, and streamed byte limits", async () => {
  let mode: "redirect" | "mime" | "bytes" = "redirect";
  const fetcher: typeof fetch = (_input) => {
    if (mode === "redirect") {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://example.test/again" } }),
      );
    }
    if (mode === "mime") {
      return Promise.resolve(new Response(png(), { headers: { "content-type": "text/html" } }));
    }
    return Promise.resolve(
      new Response(new Uint8Array(1_025), { headers: { "content-type": "image/png" } }),
    );
  };
  for (
    const [next, detail] of [["redirect", "redirect limit"], ["mime", "MIME"], [
      "bytes",
      "byte limit",
    ]] as const
  ) {
    mode = next;
    await assertRejects(
      () =>
        interceptOcrImages(request("https://example.test/a.png"), config, {
          cache: new MemoryOcrCache(),
          recognize: () => Promise.resolve("x"),
          fetch: fetcher,
        }, new AbortController().signal),
      OcrInterceptionError,
      detail,
    );
  }
});

Deno.test("OCR cancels rejected remote response bodies", async () => {
  let cancellations = 0;
  const rejectedResponse = (
    mode: "status" | "mime" | "length",
  ) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull() {},
        cancel() {
          cancellations++;
        },
      }),
      {
        status: mode === "status" ? 500 : 200,
        headers: mode === "mime"
          ? { "content-type": "text/html" }
          : mode === "length"
          ? { "content-type": "image/png", "content-length": "1025" }
          : { "content-type": "image/png" },
      },
    );
  for (const mode of ["status", "mime", "length"] as const) {
    await assertRejects(
      () =>
        interceptOcrImages(request("https://example.test/a.png"), config, {
          cache: new MemoryOcrCache(),
          recognize: () => Promise.resolve("must not run"),
          fetch: () => Promise.resolve(rejectedResponse(mode)),
        }, new AbortController().signal),
      OcrInterceptionError,
    );
  }
  assertEquals(cancellations, 3);
});

Deno.test("OCR uses one deadline across fetch and provider recognition", async () => {
  const timed = { ...config, timeoutMs: 100 };
  await assertRejects(
    () =>
      interceptOcrImages(request(), timed, {
        cache: new MemoryOcrCache(),
        recognize: ({ signal }) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      }, new AbortController().signal),
    OcrInterceptionError,
    "timeout",
  );
});

Deno.test("provider execution applies model-level OCR config before the billed chat attempt", async () => {
  const repo = new MemoryRepository();
  const user = repo.bootstrapAdmin({
    email: "ocr@example.com",
    name: "OCR",
    passwordHash: "unused",
  }, 10_000_000);
  const mutation = { actorId: user.id, action: "test.ocr" };
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(3)]]),
  });
  const created = repo.createProvider({
    slug: "ocr",
    displayName: "OCR",
    baseUrl: "https://ocr.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const provider = repo.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "secret"),
  }, mutation);
  const ocrModel = repo.createProviderModel({
    providerId: provider.id,
    publicModelId: "ocr/vision",
    upstreamModelId: "vision-upstream",
    displayName: "OCR vision",
    capabilities: ["chat", "vision"],
    contextWindow: 8_192,
  }, mutation);
  const ocrPrice = repo.createModelPriceVersion({
    providerModelId: ocrModel.id,
    expectedModelVersion: ocrModel.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 1,
    cachedInputMicrosPerMillion: 1,
    reasoningMicrosPerMillion: 1,
    outputMicrosPerMillion: 1_000_000,
    fixedCallMicros: 10,
    source: "test-ocr",
  }, mutation);
  const model = repo.createProviderModel({
    providerId: provider.id,
    publicModelId: "ocr/chat",
    upstreamModelId: "chat-upstream",
    displayName: "OCR chat",
    capabilities: ["chat", "vision"],
    contextWindow: 8_192,
    customParams: {
      ocr: {
        enabled: true,
        providerId: provider.id,
        model: "ocr/vision",
        prompt: "Read it",
        maxBytes: 1_024,
        maxPixels: 100,
        maxDimension: 10,
        timeoutMs: 1_000,
      },
    },
  }, mutation);
  const price = repo.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 1,
    reasoningMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
    fixedCallMicros: 0,
    source: "test",
  }, mutation);
  const run = repo.reserve(
    user.id,
    "ocr-run",
    model.publicModelId,
    1,
    provider.slug,
    undefined,
    {
      pricingVersionId: price.id,
      inputMicrosPerMillion: 1_000_000,
      cachedInputMicrosPerMillion: 1,
      reasoningMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
      fixedCallMicros: 0,
      source: "test",
    },
  );
  const seen: ChatCompletionRequest[] = [];
  const engine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 2,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    complete: (input) => {
      seen.push(structuredClone(input));
      const isOcr = Array.isArray(input.messages[0].content) &&
        input.messages[0].content.some((part) => part.type === "image_url");
      return Promise.resolve({
        text: isOcr ? "receipt total $42" : "understood",
        inputTokens: 2,
        outputTokens: 2,
        upstream: { id: isOcr ? "ocr-call" : "chat-call" },
      });
    },
  });
  const result = await engine.complete(
    model.id,
    run.id,
    run.runLeaseToken!,
    request(),
    new AbortController().signal,
  );
  assertEquals(result.text, "understood");
  assertEquals(seen.length, 2);
  assertEquals(seen[0].max_tokens, 4_096);
  assertEquals(seen[1].messages[0].content?.[1], {
    type: "text",
    text: "[OCR image 1.2]\nreceipt total $42",
  });
  assertEquals(repo.listProviderAttempts(run.id).length, 1);
  assertEquals(repo.usageRuns.get(run.id)!.reservedMicros > 1, true);
  assertEquals(
    repo.ledger.filter((entry) => entry.usageRunId === run.id && entry.kind === "reserve").length,
    2,
  );
  const childRuns = [...repo.usageRuns.values()].filter((candidate) => candidate.id !== run.id);
  assertEquals(childRuns.length, 1);
  assertEquals(childRuns[0].status, "completed");
  assertEquals(childRuns[0].pricingSnapshot?.pricingVersionId, ocrPrice.id);
  assertEquals(repo.listProviderAttempts(childRuns[0].id).length, 1);
  assertEquals(
    repo.ledger.filter((entry) => entry.usageRunId === childRuns[0].id).map((entry) => entry.kind),
    ["reserve", "refund"],
  );

  const failedParent = repo.reserve(
    user.id,
    "ocr-failed-parent",
    model.publicModelId,
    1_000,
    provider.slug,
    undefined,
    {
      pricingVersionId: price.id,
      inputMicrosPerMillion: 1_000_000,
      cachedInputMicrosPerMillion: 1,
      reasoningMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
      fixedCallMicros: 0,
      source: "test",
    },
  );
  const failingEngine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 2,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    complete: () => Promise.reject(new Error("OCR upstream failed")),
  });
  await assertRejects(
    () =>
      failingEngine.complete(
        model.id,
        failedParent.id,
        failedParent.runLeaseToken!,
        request(),
        new AbortController().signal,
      ),
    OcrInterceptionError,
    "OCR upstream failed",
  );
  const failedChild = [...repo.usageRuns.values()].find((candidate) =>
    candidate.id !== run.id && candidate.id !== childRuns[0].id &&
    candidate.id !== failedParent.id
  )!;
  assertEquals(failedChild.status, "failed");
  assertEquals(repo.listProviderAttempts(failedChild.id).map((attempt) => attempt.status), [
    "failed",
  ]);
  assertEquals(
    repo.ledger.filter((entry) => entry.usageRunId === failedChild.id).map((entry) => entry.kind),
    ["reserve", "refund"],
  );

  const balance = repo.ledger.at(-1)!.balanceAfterMicros;
  repo.reserve(user.id, "ocr-credit-drain", model.publicModelId, balance - 1);
  const underfunded = repo.reserve(
    user.id,
    "ocr-underfunded-parent",
    model.publicModelId,
    0,
    provider.slug,
    undefined,
    {
      pricingVersionId: price.id,
      inputMicrosPerMillion: 1_000_000,
      cachedInputMicrosPerMillion: 1,
      reasoningMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
      fixedCallMicros: 0,
      source: "test",
    },
  );
  let primaryDispatches = 0;
  const underfundedEngine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 2,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    ocrRecognize: () => Promise.resolve("expanded OCR text that must be reserved"),
    complete: () => {
      primaryDispatches++;
      return Promise.resolve({
        text: "must not dispatch",
        inputTokens: 0,
        outputTokens: 0,
        upstream: {},
      });
    },
  });
  await assertRejects(
    () =>
      underfundedEngine.complete(
        model.id,
        underfunded.id,
        underfunded.runLeaseToken!,
        request(),
        new AbortController().signal,
      ),
    DomainError,
    "Insufficient credit for expanded input",
  );
  assertEquals(primaryDispatches, 0);
});
