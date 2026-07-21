import { assert, assertEquals, assertNotMatch, assertRejects } from "jsr:@std/assert@1.0.16";
import { context, SpanStatusCode, trace, TraceFlags } from "@opentelemetry/api";
import { InMemorySpanExporter, SamplingDecision } from "@opentelemetry/sdk-trace-base";
import {
  LocalRandomRatioSampler,
  startTelemetry,
  withHttpServerSpan,
  withOperationalSpan,
} from "./tracing.ts";

Deno.test("manual tracing exports only bounded attributes and never raw request data", async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = startTelemetry({
    enabled: true,
    serviceName: "dg-chat-test",
    protocol: "http/protobuf",
    endpoint: "https://collector.example/",
    sampleRatio: 1,
  }, {
    exporter,
    random: () => {
      throw new Error("ratio one must not draw randomness");
    },
  });
  const request = new Request(
    "https://chat.example/api/public/shares/CAPABILITY_SECRET?token=QUERY_SECRET",
    {
      headers: {
        authorization: "Bearer AUTH_SECRET",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "evil=TRACE_STATE_SECRET",
        baggage: "prompt=PROMPT_SECRET",
      },
    },
  );
  const boundedResponse = await withHttpServerSpan(
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
  assertEquals(await boundedResponse.text(), "ok");

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const streamingResponse = await withHttpServerSpan(
    new Request("https://chat.example/v1/chat/completions"),
    "GET",
    "v1_chat_completions",
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
  );
  await telemetry.forceFlush();
  assertEquals(
    exporter.getFinishedSpans().some((span) => span.name === "GET v1_chat_completions"),
    false,
  );
  streamController!.enqueue(new TextEncoder().encode("visible"));
  streamController!.close();
  assertEquals(await streamingResponse.text(), "visible");

  const cancelledResponse = await withHttpServerSpan(
    new Request("https://chat.example/v1/responses"),
    "GET",
    "v1_responses",
    () => Promise.resolve(new Response(new ReadableStream<Uint8Array>())),
  );
  await cancelledResponse.body!.cancel("CLIENT_CANCEL_SECRET");

  const failedBodyResponse = await withHttpServerSpan(
    new Request("https://chat.example/v1/files"),
    "GET",
    "v1_files",
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("BODY_STREAM_SECRET"));
            },
          }),
        ),
      ),
  );
  await assertRejects(() => failedBodyResponse.arrayBuffer());

  const headCancellation = Promise.withResolvers<unknown>();
  const headResponse = await withHttpServerSpan(
    new Request("https://chat.example/health", { method: "HEAD" }),
    "HEAD",
    "health",
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel(reason) {
              headCancellation.resolve(reason);
            },
          }),
        ),
      ),
  );
  assertEquals(headResponse.body, null);
  assertEquals(await headCancellation.promise, "head_response_body_not_transmitted");

  const bodylessResponse = await withHttpServerSpan(
    new Request("https://chat.example/ready"),
    "GET",
    "ready",
    () => Promise.resolve(new Response(null, { status: 503 })),
  );
  assertEquals(bodylessResponse.body, null);

  await assertRejects(() =>
    withHttpServerSpan(
      new Request("https://chat.example/api/failure"),
      "GET",
      "api",
      () => Promise.reject(new Error("HANDLER_FAILURE_SECRET")),
    )
  );

  await telemetry.forceFlush();
  const spans = exporter.getFinishedSpans();
  assertEquals(spans.length, 8);
  const server = spans.find((span) => span.name === "GET api_public");
  assert(server);
  assertEquals(server.spanContext().traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assertEquals(server.attributes, {
    "http.request.method": "GET",
    "http.route": "api_public",
  });
  assertEquals(
    spans.find((span) => span.name === "GET v1_chat_completions")?.status,
    { code: SpanStatusCode.OK },
  );
  assertEquals(
    spans.find((span) => span.name === "GET v1_responses")?.status,
    { code: SpanStatusCode.ERROR, message: "response_body_cancelled" },
  );
  assertEquals(
    spans.find((span) => span.name === "GET v1_files")?.status,
    { code: SpanStatusCode.ERROR, message: "response_body_failed" },
  );
  assertEquals(
    spans.find((span) => span.name === "HEAD health")?.status,
    { code: SpanStatusCode.OK },
  );
  assertEquals(
    spans.find((span) => span.name === "GET ready")?.status,
    { code: SpanStatusCode.ERROR, message: "request_failed" },
  );
  assertEquals(
    spans.find((span) => span.name === "GET api")?.status,
    { code: SpanStatusCode.ERROR, message: "request_failed" },
  );
  const serialized = JSON.stringify(spans.map((span) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
    traceState: span.spanContext().traceState?.serialize(),
    parentTraceState: span.parentSpanContext?.traceState?.serialize(),
  })));
  assertNotMatch(
    serialized,
    /CAPABILITY_SECRET|QUERY_SECRET|AUTH_SECRET|TRACE_STATE_SECRET|PROMPT_SECRET|CLIENT_CANCEL_SECRET|BODY_STREAM_SECRET|HANDLER_FAILURE_SECRET|chat\.example/u,
  );
  await telemetry.shutdown();
});

Deno.test("known sampled trace IDs receive fresh local decisions with exact ratio boundaries", () => {
  const traceId = "00000000000000000000000000000001";
  const sampledRemoteParent = trace.setSpanContext(context.active(), {
    traceId,
    spanId: "0000000000000001",
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  const noRandomness = () => {
    throw new Error("ratio boundaries must not draw randomness");
  };
  assertEquals(
    new LocalRandomRatioSampler(0, noRandomness).shouldSample(sampledRemoteParent).decision,
    SamplingDecision.NOT_RECORD,
  );
  assertEquals(
    new LocalRandomRatioSampler(1, noRandomness).shouldSample(sampledRemoteParent).decision,
    SamplingDecision.RECORD_AND_SAMPLED,
  );

  const draws = [0.9, 0.1, 0.8, 0.2];
  let drawIndex = 0;
  const sampler = new LocalRandomRatioSampler(0.5, () => draws[drawIndex++]);
  const decisions = draws.map(() => sampler.shouldSample(sampledRemoteParent).decision);
  assertEquals(drawIndex, draws.length);
  assertEquals(decisions, [
    SamplingDecision.NOT_RECORD,
    SamplingDecision.RECORD_AND_SAMPLED,
    SamplingDecision.NOT_RECORD,
    SamplingDecision.RECORD_AND_SAMPLED,
  ]);

  const sampledLocalParent = trace.setSpanContext(context.active(), {
    traceId,
    spanId: "0000000000000002",
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  });
  const unsampledLocalParent = trace.setSpanContext(context.active(), {
    traceId,
    spanId: "0000000000000003",
    traceFlags: TraceFlags.NONE,
    isRemote: false,
  });
  assertEquals(
    sampler.shouldSample(sampledLocalParent).decision,
    SamplingDecision.RECORD_AND_SAMPLED,
  );
  assertEquals(
    sampler.shouldSample(unsampledLocalParent).decision,
    SamplingDecision.NOT_RECORD,
  );
  assertEquals(drawIndex, draws.length);
});
