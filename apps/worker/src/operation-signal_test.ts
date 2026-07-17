import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { embedKnowledgeChunks } from "./knowledge-embedding.ts";
import { operationSignal, raceAbort } from "./operation-signal.ts";

Deno.test("operation signal cancels active work immediately on worker shutdown", async () => {
  const shutdown = new AbortController();
  const operation = operationSignal(shutdown.signal, Date.now() + 60_000);
  const pending = raceAbort(new Promise<never>(() => {}), operation.signal);
  const reason = new DOMException("Worker stopping", "AbortError");
  shutdown.abort(reason);
  await assertRejects(() => pending, DOMException, "Worker stopping");
  assertEquals(operation.signal.reason, reason);
  operation.dispose();
  operation.dispose();
});

Deno.test("operation signal enforces the absolute job deadline", async () => {
  const operation = operationSignal(
    new AbortController().signal,
    Date.now() + 5,
    () => new DOMException("Lease deadline", "TimeoutError"),
  );
  await assertRejects(
    () => raceAbort(new Promise<never>(() => {}), operation.signal),
    DOMException,
    "Lease deadline",
  );
  operation.dispose();
});

Deno.test({
  name: "worker shutdown aborts an active embedding provider request",
  permissions: {
    net: ["127.0.0.1"],
    env: ["DENO_ENV", "OPENAI_TEST_ALLOW_HTTP_HOST"],
  },
  async fn() {
    const previousEnvironment = Deno.env.get("DENO_ENV");
    const previousAllowedHost = Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST");
    Deno.env.set("DENO_ENV", "test");
    Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", "127.0.0.1");
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => requestStarted = resolve);
    let providerCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => providerCancelled = resolve);
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (request) => {
      requestStarted();
      return new Promise<Response>((resolve) => {
        const fallback = setTimeout(
          () => resolve(Response.json({ error: "client did not cancel" }, { status: 500 })),
          1_000,
        );
        request.signal.addEventListener("abort", () => {
          clearTimeout(fallback);
          providerCancelled();
          resolve(Response.json({ error: "cancelled" }, { status: 499 }));
        }, { once: true });
      });
    });
    try {
      const shutdown = new AbortController();
      const provider = embedKnowledgeChunks(["content"], {
        baseUrl: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/v1`,
        apiKey: "test-key",
        model: "embed",
        upstreamModel: "embed",
        version: "embed-v1",
        batchSize: 1,
        billing: { inputMicrosPerMillion: 0, fixedCallMicros: 0 },
      }, shutdown.signal);
      await started;
      shutdown.abort(new DOMException("Worker stopping", "AbortError"));
      await assertRejects(() => provider, Error);
      await cancelled;
    } finally {
      await server.shutdown();
      if (previousEnvironment === undefined) Deno.env.delete("DENO_ENV");
      else Deno.env.set("DENO_ENV", previousEnvironment);
      if (previousAllowedHost === undefined) Deno.env.delete("OPENAI_TEST_ALLOW_HTTP_HOST");
      else Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", previousAllowedHost);
    }
  },
});
