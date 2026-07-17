import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { embeddingsSchema } from "@dg-chat/contracts";
import {
  createEmbeddings,
  EmbeddingsProviderError,
  maximumEmbeddingsReplayBytes,
  validateEmbeddingsResponse,
} from "./embeddings.ts";

Deno.test("embeddings request validation is strict and bounded", () => {
  assertEquals(embeddingsSchema.safeParse({ model: "embed", input: "hello" }).success, true);
  assertEquals(
    embeddingsSchema.safeParse({ model: "embed", input: "hello", unknown: true }).success,
    false,
  );
  assertEquals(
    embeddingsSchema.safeParse({ model: "embed", input: [[-1]] }).success,
    false,
  );
  assertEquals(
    embeddingsSchema.safeParse({ model: "embed", input: [], dimensions: 0 }).success,
    false,
  );
});

Deno.test("embeddings replay bounds scale with requested cardinality and dimensions", () => {
  const small = embeddingsSchema.parse({ model: "embed", input: "hello", dimensions: 2 });
  const large = embeddingsSchema.parse({
    model: "embed",
    input: ["a", "b"],
    dimensions: 4_096,
  });
  assertEquals(maximumEmbeddingsReplayBytes(small) < maximumEmbeddingsReplayBytes(large), true);
  assertEquals(maximumEmbeddingsReplayBytes(large) <= 64 * 1024 * 1024, true);
});

Deno.test("embeddings adapter rewrites only the model and normalizes ordered output", async () => {
  let observedUrl = "";
  let observedBody: unknown;
  const response = await createEmbeddings(
    { model: "public/embed", input: ["a", "b"], encoding_format: "float", dimensions: 2 },
    {
      baseUrl: "https://provider.example/v1/",
      apiKey: "secret",
      upstreamModel: "text-embedding-3-small",
      publicModel: "public/embed",
      signal: new AbortController().signal,
      fetch: (input, init) => {
        observedUrl = input.toString();
        observedBody = JSON.parse(String(init?.body));
        return Promise.resolve(Response.json({
          object: "list",
          data: [
            { object: "embedding", embedding: [0.3, 0.4], index: 1 },
            { object: "embedding", embedding: [0.1, 0.2], index: 0 },
          ],
          model: "upstream-secret-name",
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }));
      },
    },
  );
  assertEquals(observedUrl, "https://provider.example/v1/embeddings");
  assertEquals(observedBody, {
    model: "text-embedding-3-small",
    input: ["a", "b"],
    encoding_format: "float",
    dimensions: 2,
  });
  assertEquals(response.model, "public/embed");
  assertEquals(response.data.map((item) => item.index), [0, 1]);
});

Deno.test("embeddings response rejects wrong cardinality, dimensions, duplicate indices, and NaN", () => {
  const request = embeddingsSchema.parse({ model: "embed", input: ["a", "b"], dimensions: 2 });
  for (
    const data of [
      [{ object: "embedding", embedding: [1, 2], index: 0 }],
      [
        { object: "embedding", embedding: [1], index: 0 },
        { object: "embedding", embedding: [1, 2], index: 1 },
      ],
      [
        { object: "embedding", embedding: [1, 2], index: 0 },
        { object: "embedding", embedding: [3, 4], index: 0 },
      ],
      [
        { object: "embedding", embedding: [1, 2], index: 0 },
        { object: "embedding", embedding: [3, Number.NaN], index: 1 },
      ],
    ]
  ) {
    try {
      validateEmbeddingsResponse(
        { object: "list", data, usage: { prompt_tokens: 2, total_tokens: 2 } },
        request,
        "embed",
      );
      throw new Error("expected validation to fail");
    } catch (error) {
      assertEquals(error instanceof EmbeddingsProviderError, true);
    }
  }
});

Deno.test("embeddings response enforces a common nonzero float vector shape without dimensions", () => {
  const request = embeddingsSchema.parse({ model: "embed", input: ["a", "b"] });
  for (
    const embeddings of [
      [[], [1, 2]],
      [[1], [1, 2]],
    ]
  ) {
    assertThrows(
      () =>
        validateEmbeddingsResponse(
          {
            object: "list",
            data: embeddings.map((embedding, index) => ({ object: "embedding", embedding, index })),
            usage: { prompt_tokens: 2, total_tokens: 2 },
          },
          request,
          "embed",
        ),
      EmbeddingsProviderError,
    );
  }
});

Deno.test("base64 embeddings must decode to common nonempty float32 vectors", () => {
  const request = embeddingsSchema.parse({
    model: "embed",
    input: ["a", "b"],
    encoding_format: "base64",
  });
  const response = (embeddings: string[]) => ({
    object: "list",
    data: embeddings.map((embedding, index) => ({ object: "embedding", embedding, index })),
    usage: { prompt_tokens: 2, total_tokens: 2 },
  });
  const oneFloat = btoa("\0\0\0\0");
  const twoFloats = btoa("\0\0\0\0\0\0\0\0");
  for (
    const values of [["", oneFloat], ["AAAAA===", oneFloat], [btoa("abc"), oneFloat], [
      oneFloat,
      twoFloats,
    ]]
  ) {
    try {
      validateEmbeddingsResponse(response(values), request, "embed");
      throw new Error("expected validation to fail");
    } catch (error) {
      assertEquals(error instanceof EmbeddingsProviderError, true);
    }
  }
  assertEquals(
    validateEmbeddingsResponse(response([oneFloat, oneFloat]), request, "embed").data.length,
    2,
  );
  const requested = embeddingsSchema.parse({
    model: "embed",
    input: "a",
    encoding_format: "base64",
    dimensions: 2,
  });
  try {
    validateEmbeddingsResponse(response([oneFloat]), requested, "embed");
    throw new Error("expected validation to fail");
  } catch (error) {
    assertEquals(error instanceof EmbeddingsProviderError, true);
  }
});

Deno.test("embeddings adapter rejects unsafe provider URLs and upstream failures", async () => {
  const request = { model: "embed", input: "hello" };
  await assertRejects(
    () =>
      createEmbeddings(request, {
        baseUrl: "http://127.0.0.1/v1",
        apiKey: "secret",
        upstreamModel: "embed",
        publicModel: "embed",
        signal: new AbortController().signal,
        fetch,
      }),
    EmbeddingsProviderError,
    "invalid",
  );
  const serverFailure = await assertRejects(
    () =>
      createEmbeddings(request, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        upstreamModel: "embed",
        publicModel: "embed",
        signal: new AbortController().signal,
        fetch: () =>
          Promise.resolve(Response.json({ error: { message: "secret detail" } }, { status: 500 })),
      }),
    EmbeddingsProviderError,
    "request failed",
  );
  assertEquals((serverFailure as EmbeddingsProviderError).dispatchOutcome, "uncertain");
  assertEquals((serverFailure as EmbeddingsProviderError).upstreamStatus, 500);
  for (const status of [401, 408, 422, 429, 500, 503]) {
    const ambiguous = await assertRejects(() =>
      createEmbeddings(request, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        upstreamModel: "embed",
        publicModel: "embed",
        signal: new AbortController().signal,
        fetch: () =>
          Promise.resolve(
            new Response(status % 2 === 0 ? "{" : "not-json", {
              status,
              headers: { "retry-after": status === 429 ? "999999" : "2.25" },
            }),
          ),
      })
    );
    assertEquals((ambiguous as EmbeddingsProviderError).upstreamStatus, status);
    assertEquals(
      (ambiguous as EmbeddingsProviderError).dispatchOutcome,
      [401, 422].includes(status) ? "rejected" : "uncertain",
    );
    assertEquals(
      (ambiguous as EmbeddingsProviderError).retryAfterMs,
      status === 429 ? 300_000 : 2_250,
    );
  }
  const rejected = await assertRejects(() =>
    createEmbeddings(request, {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      upstreamModel: "embed",
      publicModel: "embed",
      signal: new AbortController().signal,
      fetch: () => Promise.resolve(Response.json({ error: "invalid" }, { status: 422 })),
    })
  );
  assertEquals((rejected as EmbeddingsProviderError).dispatchOutcome, "rejected");
  const transport = new TypeError("connection reset");
  assertEquals(
    await assertRejects(() =>
      createEmbeddings(request, {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        upstreamModel: "embed",
        publicModel: "embed",
        signal: new AbortController().signal,
        fetch: () => Promise.reject(transport),
      })
    ),
    transport,
  );
});

Deno.test("embeddings adapter does not wait for nonsettling error-body cancellation", async () => {
  let cancelStarted = false;
  const neverSettles = new Promise<void>(() => undefined);
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error("embedding provider status was blocked by body cancellation")),
    250,
  );
  try {
    const failure = await Promise.race([
      assertRejects(() =>
        createEmbeddings(
          { model: "embed", input: "hello" },
          {
            baseUrl: "https://provider.example/v1",
            apiKey: "secret",
            upstreamModel: "embed",
            publicModel: "embed",
            signal: new AbortController().signal,
            fetch: () =>
              Promise.resolve(
                new Response(
                  new ReadableStream({
                    cancel() {
                      cancelStarted = true;
                      return neverSettles;
                    },
                  }),
                  { status: 429, headers: { "retry-after": "7" } },
                ),
              ),
          },
        )
      ),
      timeout.promise,
    ]);
    assertEquals(cancelStarted, true);
    assertEquals((failure as EmbeddingsProviderError).upstreamStatus, 429);
    assertEquals((failure as EmbeddingsProviderError).retryAfterMs, 7_000);
  } finally {
    clearTimeout(timer);
  }
});
