import { assert, assertEquals, assertNotMatch } from "jsr:@std/assert@1.0.16";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startTelemetry, withHttpServerSpan, withOperationalSpan } from "./tracing.ts";

Deno.test("manual tracing exports only bounded attributes and never raw request data", async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = startTelemetry({
    enabled: true,
    serviceName: "dg-chat-test",
    protocol: "http/protobuf",
    endpoint: "https://collector.example/",
    sampleRatio: 1,
  }, { exporter });
  const request = new Request(
    "https://chat.example/api/public/shares/CAPABILITY_SECRET?token=QUERY_SECRET",
    {
      headers: {
        authorization: "Bearer AUTH_SECRET",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        baggage: "prompt=PROMPT_SECRET",
      },
    },
  );
  await withHttpServerSpan(
    request,
    "GET",
    "api_public",
    () =>
      withOperationalSpan(
        "safe.operation",
        { "job.type": "attachment.inspect" },
        () => Promise.resolve(new Response("ok")),
      ),
  );
  await telemetry.forceFlush();
  const spans = exporter.getFinishedSpans();
  assertEquals(spans.length, 2);
  const server = spans.find((span) => span.name === "GET api_public");
  assert(server);
  assertEquals(server.attributes, {
    "http.request.method": "GET",
    "http.route": "api_public",
  });
  const serialized = JSON.stringify(spans.map((span) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
  })));
  assertNotMatch(
    serialized,
    /CAPABILITY_SECRET|QUERY_SECRET|AUTH_SECRET|PROMPT_SECRET|chat\.example/u,
  );
  await telemetry.shutdown();
});
