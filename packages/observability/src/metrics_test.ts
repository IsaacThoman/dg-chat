import { assertEquals, assertMatch, assertNotMatch, assertRejects } from "jsr:@std/assert@1.0.16";
import {
  boundedHttpMethod,
  boundedRoute,
  createApiMetrics,
  createWorkerMetrics,
  recordProviderAttemptMetric,
  startMetricsServer,
} from "../mod.ts";
import { Counter, Gauge, Histogram, MetricsRegistry } from "./metrics.ts";

Deno.test("Prometheus registry renders escaped deterministic counters, gauges, and histograms", () => {
  const registry = new MetricsRegistry();
  const counter = registry.register(new Counter("test_events_total", "Counted events"));
  counter.add(2, { result: 'ok"value' });
  const gauge = registry.register(new Gauge("test_ready", "Readiness"));
  gauge.set(1);
  const histogram = registry.register(new Histogram("test_seconds", "Duration", [0.1, 1]));
  histogram.observe(0.5, { operation: "safe" });
  const output = registry.render();
  assertMatch(output, /test_events_total\{result="ok\\"value"\} 2/u);
  assertMatch(output, /test_ready 1/u);
  assertMatch(output, /test_seconds_bucket\{le="0\.1",operation="safe"\} 0/u);
  assertMatch(output, /test_seconds_bucket\{le="1",operation="safe"\} 1/u);
  assertMatch(output, /test_seconds_count\{operation="safe"\} 1/u);
});

Deno.test("private metrics listener serves only Prometheus and health endpoints and closes", async () => {
  const registry = new MetricsRegistry();
  const gauge = registry.register(new Gauge("listener_ready", "Listener test"));
  gauge.set(1);
  const server = startMetricsServer(registry, {
    enabled: true,
    hostname: "127.0.0.1",
    port: 0,
  });
  if (!server) throw new Error("Metrics server did not start");
  const origin = `http://${server.address.hostname}:${server.address.port}`;
  try {
    const response = await fetch(`${origin}/metrics`);
    assertEquals(response.status, 200);
    assertMatch(await response.text(), /listener_ready 1/u);
    assertEquals((await fetch(`${origin}/healthz`)).status, 204);
    assertEquals((await fetch(`${origin}/anything-else`)).status, 404);
    assertEquals((await fetch(`${origin}/metrics`, { method: "POST" })).status, 405);
  } finally {
    await server.close();
  }
  await assertRejects(() => fetch(`${origin}/healthz`));
});

Deno.test("HTTP metrics collapse attacker-controlled methods and paths into bounded labels", async () => {
  assertEquals(boundedHttpMethod("invented-method"), "OTHER");
  assertEquals(boundedRoute(`/api/conversations/${crypto.randomUUID()}?token=secret`), "api");
  assertEquals(boundedRoute(`/untrusted/${crypto.randomUUID()}`), "other");
  const metrics = createApiMetrics();
  const handler = metrics.instrument(() => new Response("ok", { status: 201 }));
  const response = await handler(
    new Request("https://example.test/api/conversations/private-id", {
      method: "POST",
    }),
  );
  await response.body?.cancel();
  recordProviderAttemptMetric("failed", "open");
  const output = metrics.registry.render();
  assertMatch(
    output,
    /dg_chat_http_requests_total\{method="POST",route="api",status_class="2xx"\} 1/u,
  );
  assertMatch(
    output,
    /dg_chat_http_response_lifecycle_total\{method="POST",outcome="cancelled",route="api"\} 1/u,
  );
  assertMatch(
    output,
    /dg_chat_provider_circuit_last_open_timestamp_seconds 1[0-9]{9}(?:\.[0-9]+)?/u,
  );
  assertNotMatch(output, /private-id/u);
  assertMatch(
    output,
    /dg_chat_provider_attempts_total\{breaker_after="open",outcome="failed"\} 1/u,
  );
});

Deno.test("HTTP metrics keep streaming responses in flight through completion and cancellation", async () => {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sourceBody: ReadableStream<Uint8Array> | undefined;
  const metrics = createApiMetrics();
  const handler = metrics.instrument(() => {
    sourceBody = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode("first"));
      },
    });
    return new Response(
      sourceBody,
      { status: 200, headers: { "X-Stream-Metadata": "preserved" } },
    );
  });
  const response = await handler(new Request("https://example.test/v1/chat/completions"));
  assertEquals(response.headers.get("X-Stream-Metadata"), "preserved");
  let output = metrics.registry.render();
  assertMatch(
    output,
    /dg_chat_http_requests_in_flight\{method="GET",route="v1_chat_completions"\} 1/u,
  );
  assertNotMatch(output, /dg_chat_http_requests_total\{/u);

  const reader = response.body!.getReader();
  const first = await reader.read();
  assertEquals(new TextDecoder().decode(first.value), "first");
  output = metrics.registry.render();
  assertMatch(
    output,
    /dg_chat_http_requests_in_flight\{method="GET",route="v1_chat_completions"\} 1/u,
  );
  streamController!.close();
  assertEquals((await reader.read()).done, true);
  assertEquals(sourceBody!.locked, false);
  output = metrics.registry.render();
  assertMatch(
    output,
    /dg_chat_http_requests_in_flight\{method="GET",route="v1_chat_completions"\} 0/u,
  );
  assertMatch(
    output,
    /dg_chat_http_requests_total\{method="GET",route="v1_chat_completions",status_class="2xx"\} 1/u,
  );
  assertMatch(
    output,
    /dg_chat_http_response_lifecycle_total\{method="GET",outcome="completed",route="v1_chat_completions"\} 1/u,
  );

  let cancellationReason: unknown;
  let cancellationSource: ReadableStream<Uint8Array> | undefined;
  const cancellationMetrics = createApiMetrics();
  const cancellationHandler = cancellationMetrics.instrument(() => {
    cancellationSource = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    return new Response(cancellationSource);
  });
  const cancelled = await cancellationHandler(new Request("https://example.test/v1/responses"));
  await cancelled.body!.cancel("client_disconnected");
  assertEquals(cancellationReason, "client_disconnected");
  assertEquals(cancellationSource!.locked, false);
  const cancelledOutput = cancellationMetrics.registry.render();
  assertMatch(
    cancelledOutput,
    /dg_chat_http_requests_in_flight\{method="GET",route="v1_responses"\} 0/u,
  );
  assertMatch(
    cancelledOutput,
    /dg_chat_http_requests_total\{method="GET",route="v1_responses",status_class="2xx"\} 1/u,
  );
  assertMatch(
    cancelledOutput,
    /dg_chat_http_response_lifecycle_total\{method="GET",outcome="cancelled",route="v1_responses"\} 1/u,
  );

  const headCancellation = Promise.withResolvers<unknown>();
  const headMetrics = createApiMetrics();
  const headHandler = headMetrics.instrument(() =>
    new Response(
      new ReadableStream({
        cancel(reason) {
          headCancellation.resolve(reason);
        },
      }),
    )
  );
  const headResponse = await headHandler(
    new Request("https://example.test/health", { method: "HEAD" }),
  );
  assertEquals(headResponse.body, null);
  assertEquals(await headCancellation.promise, "head_response_body_not_transmitted");
  const headOutput = headMetrics.registry.render();
  assertMatch(
    headOutput,
    /dg_chat_http_requests_in_flight\{method="HEAD",route="health"\} 0/u,
  );
  assertMatch(
    headOutput,
    /dg_chat_http_requests_total\{method="HEAD",route="health",status_class="2xx"\} 1/u,
  );
  assertMatch(
    headOutput,
    /dg_chat_http_response_lifecycle_total\{method="HEAD",outcome="completed",route="health"\} 1/u,
  );
});

Deno.test("HTTP metrics expose response-body source failures without unbounded labels", async () => {
  const metrics = createApiMetrics();
  const handler = metrics.instrument(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("PRIVATE_STREAM_FAILURE"));
        },
      }),
      { status: 200 },
    )
  );
  const response = await handler(
    new Request("https://example.test/v1/chat/completions?prompt=PRIVATE_PROMPT"),
  );
  await assertRejects(() => response.arrayBuffer());

  const output = metrics.registry.render();
  assertMatch(
    output,
    /dg_chat_http_response_lifecycle_total\{method="GET",outcome="failed",route="v1_chat_completions"\} 1/u,
  );
  assertMatch(
    output,
    /dg_chat_http_requests_total\{method="GET",route="v1_chat_completions",status_class="2xx"\} 1/u,
  );
  assertNotMatch(output, /PRIVATE_STREAM_FAILURE|PRIVATE_PROMPT/u);
});

Deno.test("Deno HTTP client cancellation settles streaming request metrics without buffering", async () => {
  const cancellation = Promise.withResolvers<void>();
  const metrics = createApiMetrics();
  const handler = metrics.instrument(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: visible-now\n\n"));
        },
        cancel() {
          cancellation.resolve();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  );
  const abort = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: abort.signal, onListen: () => {} },
    handler,
  );
  const address = server.addr as Deno.NetAddr;
  try {
    const response = await fetch(
      `http://${address.hostname}:${address.port}/v1/chat/completions`,
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    assertEquals(new TextDecoder().decode(first.value), "data: visible-now\n\n");
    assertMatch(
      metrics.registry.render(),
      /dg_chat_http_requests_in_flight\{method="GET",route="v1_chat_completions"\} 1/u,
    );
    await reader.cancel();
    const timeout = setTimeout(
      () => cancellation.reject(new Error("HTTP cancellation did not reach the source stream")),
      1_000,
    );
    try {
      await cancellation.promise;
    } finally {
      clearTimeout(timeout);
    }
    assertMatch(
      metrics.registry.render(),
      /dg_chat_http_requests_in_flight\{method="GET",route="v1_chat_completions"\} 0/u,
    );
  } finally {
    abort.abort();
    await server.finished.catch(() => undefined);
  }
});

Deno.test("worker metrics bound job types and expose queue health without identifiers", () => {
  const metrics = createWorkerMetrics();
  metrics.setReady(true);
  metrics.setQueue("queued", 3, 15);
  metrics.recordJobOutcome("attacker-controlled-type", "completed", 0.2);
  metrics.recordJobOutcome("file_object.cleanup", "completed", 0.3);
  metrics.setRetentionScheduleOverdue(75);
  metrics.recordRetentionScheduleOutcome("scheduled");
  metrics.recordRetentionScheduleOutcome("failed");
  const output = metrics.registry.render();
  assertMatch(output, /dg_chat_job_queue_depth\{status="queued"\} 3/u);
  assertMatch(output, /dg_chat_worker_jobs_total\{outcome="completed",type="other"\} 1/u);
  assertMatch(
    output,
    /dg_chat_worker_jobs_total\{outcome="completed",type="file_object\.cleanup"\} 1/u,
  );
  assertMatch(output, /dg_chat_retention_schedule_overdue_seconds 75/u);
  assertMatch(
    output,
    /dg_chat_retention_schedule_checks_total\{outcome="scheduled"\} 1/u,
  );
  assertMatch(output, /dg_chat_retention_schedule_checks_total\{outcome="failed"\} 1/u);
  assertNotMatch(output, /attacker-controlled-type/u);
});
