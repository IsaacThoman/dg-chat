import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  MAX_PROVIDER_CONTEXT_WINDOW,
  MAX_PROVIDER_CUSTOM_PARAMS_BYTES,
  modelPriceCreate,
  providerCreate,
  providerCredential,
  providerModelCreate,
  providerModelCustomParams,
  providerPatch,
  providerUpstreamDefaults,
  ProviderValidationError,
} from "./provider-validation.ts";

Deno.test("provider admin validation normalizes safe provider input and rejects unknown fields", () => {
  assertEquals(
    providerCreate({
      slug: "Vendor-One",
      displayName: " Vendor One ",
      baseUrl: "https://provider.example/v1/",
      protocol: "chat_completions",
    }),
    {
      slug: "vendor-one",
      displayName: "Vendor One",
      baseUrl: "https://provider.example/v1",
      protocol: "chat_completions",
      enabled: undefined,
    },
  );
  assertThrows(
    () => providerCreate({ slug: "x", unknown: true }),
    ProviderValidationError,
    "Unknown field",
  );
  assertThrows(
    () =>
      providerModelCreate({
        providerId: crypto.randomUUID(),
        publicModelId: "safe/model",
        upstreamModelId: "upstream-model",
        displayName: "Too large",
        capabilities: ["chat"],
        contextWindow: MAX_PROVIDER_CONTEXT_WINDOW + 1,
      }),
    ProviderValidationError,
    "contextWindow",
  );
  assertThrows(
    () => providerPatch({ expectedVersion: 1 }),
    ProviderValidationError,
    "At least one",
  );
  assertEquals(
    providerCreate({
      slug: "responses-vendor",
      displayName: "Responses Vendor",
      baseUrl: "https://provider.example/v1",
      protocol: "responses",
    }).protocol,
    "responses",
  );
});

Deno.test("provider admin permits HTTP only for the exact isolated contract-test host", () => {
  const previousEnvironment = Deno.env.get("DENO_ENV");
  const previousHost = Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST");
  try {
    Deno.env.set("DENO_ENV", "test");
    Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", "127.0.0.1");
    assertEquals(
      providerCreate({
        slug: "local-contract",
        displayName: "Local contract",
        baseUrl: "http://127.0.0.1:4010/v1/",
        protocol: "responses",
      }).baseUrl,
      "http://127.0.0.1:4010/v1",
    );
    assertThrows(
      () =>
        providerCreate({
          slug: "wrong-host",
          displayName: "Wrong host",
          baseUrl: "http://localhost:4010/v1",
          protocol: "responses",
        }),
      TypeError,
      "HTTPS URL",
    );
  } finally {
    if (previousEnvironment === undefined) Deno.env.delete("DENO_ENV");
    else Deno.env.set("DENO_ENV", previousEnvironment);
    if (previousHost === undefined) Deno.env.delete("OPENAI_TEST_ALLOW_HTTP_HOST");
    else Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", previousHost);
  }
});

Deno.test("model custom parameters accept only bounded non-authoritative defaults", () => {
  const value = providerModelCustomParams({
    temperature: 0.25,
    top_p: 0.9,
    presence_penalty: -0.5,
    frequency_penalty: 0.5,
    seed: 42,
    stop: ["END", "STOP"],
    parallel_tool_calls: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "safe_result",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    },
    ocr: {
      enabled: true,
      providerId: "provider-id",
      model: "provider/vision",
      prompt: "Read all visible text.",
      cacheTtlSeconds: 86_400,
      timeoutMs: 15_000,
      maxBytes: 10 * 1024 * 1024,
      maxPixels: 40_000_000,
      maxDimension: 16_384,
      maxRedirects: 2,
    },
  });
  assertEquals(value.temperature, 0.25);
  assertEquals(value.parallel_tool_calls, false);
  assertEquals((value.ocr as Record<string, unknown>).model, "provider/vision");
});

Deno.test("upstream defaults omit internal OCR configuration and enforce protocol support", () => {
  assertEquals(
    providerUpstreamDefaults({
      temperature: 0.25,
      top_p: 0.8,
      ocr: {
        enabled: true,
        providerId: "provider-id",
        model: "provider/vision",
        prompt: "Read all visible text.",
      },
    }, "responses"),
    { temperature: 0.25, top_p: 0.8 },
  );
  assertThrows(
    () => providerUpstreamDefaults({ stop: "END" }, "responses"),
    ProviderValidationError,
    "not supported by Responses providers",
  );
  assertEquals(providerUpstreamDefaults({ stop: "END" }, "chat_completions"), { stop: "END" });
});

Deno.test("model custom parameters reject authoritative, accounting, and identity fields", () => {
  for (
    const key of [
      "model",
      "stream",
      "messages",
      "input",
      "tools",
      "tool_choice",
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
      "reasoning_effort",
      "service_tier",
      "store",
      "metadata",
      "user",
    ]
  ) {
    assertThrows(
      () => providerModelCustomParams({ [key]: key === "stream" ? true : "override" }),
      ProviderValidationError,
      "is not allowed",
    );
  }
});

Deno.test("model custom parameters reject recursive pollution and complexity", () => {
  assertThrows(
    () => providerModelCustomParams({ response_format: { type: ["text"] } }),
    ProviderValidationError,
    "type is invalid",
  );
  const polluted = JSON.parse(
    '{"response_format":{"type":"json_schema","json_schema":{"name":"x","schema":{"properties":{"__proto__":{"type":"string"}}}}}}',
  );
  assertThrows(
    () => providerModelCustomParams(polluted),
    ProviderValidationError,
    "unsafe field",
  );
  let nested: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < 12; index++) nested = { properties: nested };
  assertThrows(
    () =>
      providerModelCustomParams({
        response_format: {
          type: "json_schema",
          json_schema: { name: "deep", schema: nested },
        },
      }),
    ProviderValidationError,
    "complexity limit",
  );
  assertThrows(
    () =>
      providerModelCustomParams({
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "large",
            schema: { description: "x".repeat(MAX_PROVIDER_CUSTOM_PARAMS_BYTES) },
          },
        },
      }),
    ProviderValidationError,
    "oversized string",
  );
  assertThrows(
    () =>
      providerModelCustomParams({
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "large_serialized",
            schema: { enum: ["x".repeat(8_190), "y".repeat(8_190)] },
          },
        },
      }),
    ProviderValidationError,
    "serialized size limit",
  );
});

Deno.test("provider credential validation requires explicit bounded replacement", () => {
  assertEquals(providerCredential({ expectedVersion: 2, credential: " new-key " }), {
    expectedVersion: 2,
    secret: " new-key ",
  });
  assertThrows(() => providerCredential({ expectedVersion: 2, credential: "" }));
});

Deno.test("model and price validation reject duplicates and unsafe numbers", () => {
  assertThrows(
    () =>
      providerModelCreate({
        providerId: "provider",
        publicModelId: "provider/model",
        upstreamModelId: "model",
        displayName: "Model",
        capabilities: ["chat", "chat"],
        contextWindow: 10,
      }),
    ProviderValidationError,
    "unique",
  );
  assertThrows(
    () =>
      providerModelCreate({
        providerId: "provider",
        publicModelId: "provider/model",
        upstreamModelId: "model",
        displayName: "Model",
        capabilities: ["chat", "transcripton"],
        contextWindow: 10,
      }),
    ProviderValidationError,
    "unsupported value",
  );
  assertThrows(
    () =>
      providerModelCreate({
        providerId: "provider",
        publicModelId: "provider/model\nunsafe",
        upstreamModelId: "model",
        displayName: "Model",
        capabilities: ["chat"],
        contextWindow: 10,
      }),
    ProviderValidationError,
    "unsupported characters",
  );
  assertThrows(
    () =>
      modelPriceCreate({
        providerModelId: "model",
        expectedModelVersion: 1,
        effectiveAt: new Date().toISOString(),
        inputMicrosPerMillion: Number.MAX_SAFE_INTEGER + 1,
        cachedInputMicrosPerMillion: 0,
        reasoningMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
        fixedCallMicros: 0,
        source: "admin",
      }),
    ProviderValidationError,
    "inputMicrosPerMillion",
  );
  assertThrows(
    () =>
      modelPriceCreate({
        providerModelId: "model",
        expectedModelVersion: 1,
        effectiveAt: new Date().toISOString(),
        inputMicrosPerMillion: Number.MAX_SAFE_INTEGER,
        cachedInputMicrosPerMillion: 0,
        reasoningMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
        fixedCallMicros: 0,
        source: "admin",
      }),
    ProviderValidationError,
    "safe accounting",
  );
});
