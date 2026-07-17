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
  await handler(
    new Request("https://example.test/api/conversations/private-id", {
      method: "POST",
    }),
  );
  recordProviderAttemptMetric("failed", "open");
  const output = metrics.registry.render();
  assertMatch(
    output,
    /dg_chat_http_requests_total\{method="POST",route="api",status_class="2xx"\} 1/u,
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

Deno.test("worker metrics bound job types and expose queue health without identifiers", () => {
  const metrics = createWorkerMetrics();
  metrics.setReady(true);
  metrics.setQueue("queued", 3, 15);
  metrics.recordJobOutcome("attacker-controlled-type", "completed", 0.2);
  const output = metrics.registry.render();
  assertMatch(output, /dg_chat_job_queue_depth\{status="queued"\} 3/u);
  assertMatch(output, /dg_chat_worker_jobs_total\{outcome="completed",type="other"\} 1/u);
  assertNotMatch(output, /attacker-controlled-type/u);
});
