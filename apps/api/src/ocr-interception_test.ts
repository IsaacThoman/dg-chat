import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { MemoryRepository } from "@dg-chat/database";
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

Deno.test("OCR rejects MIME confusion, oversized dimensions, and private targets with context", async () => {
  const dependencies = { cache: new MemoryOcrCache(), recognize: () => Promise.resolve("x") };
  for (
    const [input, detail] of [
      [data(new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0])), "declared MIME"],
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
  const model = repo.createProviderModel({
    providerId: provider.id,
    publicModelId: "ocr/chat",
    upstreamModelId: "vision-upstream",
    displayName: "OCR chat",
    capabilities: ["chat", "vision"],
    contextWindow: 8_192,
    customParams: {
      ocr: {
        enabled: true,
        providerId: provider.id,
        model: "ocr/chat",
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
    inputMicrosPerMillion: 1,
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
    1_000,
    provider.slug,
    undefined,
    {
      pricingVersionId: price.id,
      inputMicrosPerMillion: 1,
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
  assertEquals(seen[1].messages[0].content?.[1], {
    type: "text",
    text: "[OCR image 1.2]\nreceipt total $42",
  });
  assertEquals(repo.listProviderAttempts(run.id).length, 1);
});
