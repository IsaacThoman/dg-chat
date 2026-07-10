import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  discoverProviderModels,
  normalizeProviderBaseUrl,
  ProviderTestError,
} from "./provider-admin.ts";

Deno.test("provider base URLs normalize and reject unsafe URL features", () => {
  assertEquals(normalizeProviderBaseUrl("https://EXAMPLE.com/v1///"), "https://example.com/v1");
  for (
    const invalid of [
      "http://example.com/v1",
      "https://user:pass@example.com/v1",
      "https://example.com/v1?target=elsewhere",
      "https://example.com/v1#fragment",
    ]
  ) {
    try {
      normalizeProviderBaseUrl(invalid);
      throw new Error("expected rejection");
    } catch (error) {
      assertEquals(error instanceof TypeError, true);
    }
  }
});

Deno.test("provider discovery validates, deduplicates, and sorts a bounded OpenAI model list", async () => {
  let requestUrl = "";
  let authorization = "";
  const result = await discoverProviderModels("https://provider.example/v1", "secret", {
    fetch: (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "z-model", owned_by: "vendor" },
              { id: "a-model" },
              { id: "z-model", owned_by: "vendor" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
  assertEquals(requestUrl, "https://provider.example/v1/models");
  assertEquals(authorization, "Bearer secret");
  assertEquals(result.models, [
    { id: "a-model", ownedBy: null },
    { id: "z-model", ownedBy: "vendor" },
  ]);
});

Deno.test("provider discovery exposes only safe failure categories", async () => {
  await assertRejects(
    () =>
      discoverProviderModels("https://provider.example/v1", "bad", {
        fetch: () => Promise.resolve(new Response("raw upstream secret", { status: 401 })),
      }),
    ProviderTestError,
    "authentication_failed",
  );
  await assertRejects(
    () =>
      discoverProviderModels("https://provider.example/v1", "key", {
        fetch: () =>
          Promise.resolve(
            new Response("<html>oops</html>", {
              headers: { "content-type": "text/html" },
            }),
          ),
      }),
    ProviderTestError,
    "invalid_response",
  );
});

Deno.test("provider discovery propagates caller cancellation", async () => {
  const controller = new AbortController();
  const pending = discoverProviderModels("https://provider.example/v1", "key", {
    signal: controller.signal,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  });
  controller.abort(new DOMException("Client disconnected", "AbortError"));
  await assertRejects(() => pending, DOMException, "Client disconnected");
});

Deno.test("provider discovery propagates cancellation while reading the response body", async () => {
  const controller = new AbortController();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pending = discoverProviderModels("https://provider.example/v1", "key", {
    signal: controller.signal,
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              streamController = value;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
  });
  await Promise.resolve();
  controller.abort(new DOMException("Client disconnected during body", "AbortError"));
  streamController?.error(controller.signal.reason);
  await assertRejects(() => pending, DOMException, "Client disconnected during body");
});
