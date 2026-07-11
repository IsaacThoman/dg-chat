import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  MAX_PROVIDER_CONTEXT_WINDOW,
  modelPriceCreate,
  providerCreate,
  providerCredential,
  providerModelCreate,
  providerPatch,
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
  assertThrows(
    () =>
      providerCreate({
        slug: "vendor",
        displayName: "Vendor",
        baseUrl: "https://provider.example/v1",
        protocol: "responses",
      }),
    ProviderValidationError,
    "Chat Completions",
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
