import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.16";
import { metricsListenerConfig, telemetryConfig } from "./config.ts";

Deno.test("metrics listener defaults are service-owned and configuration is bounded", () => {
  assertEquals(metricsListenerConfig({}, { port: 9090, enabled: true }), {
    enabled: true,
    hostname: "127.0.0.1",
    port: 9090,
  });
  assertEquals(
    metricsListenerConfig({
      METRICS_ENABLED: "false",
      METRICS_HOST: "0.0.0.0",
      METRICS_PORT: "9191",
    }, { port: 9090, enabled: true }),
    {
      enabled: false,
      hostname: "0.0.0.0",
      port: 9191,
    },
  );
  for (const port of ["0", "65536", "1.5", "nope"]) {
    assertThrows(() => metricsListenerConfig({ METRICS_PORT: port }, { port: 9090 }));
  }
  assertThrows(() => metricsListenerConfig({ METRICS_HOST: "http://0.0.0.0" }, { port: 9090 }));
});

Deno.test("telemetry configuration requires an explicit credential-free OTLP endpoint", () => {
  assertEquals(telemetryConfig({}, "dg-chat-api"), {
    enabled: false,
    serviceName: "dg-chat-api",
    protocol: "http/protobuf",
    endpoint: null,
    sampleRatio: 0.1,
  });
  assertEquals(
    telemetryConfig({
      DG_CHAT_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/v1/",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_SERVICE_NAME: "dg-chat-api-2",
      OTEL_TRACES_SAMPLER_ARG: "0.25",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret-that-must-not-be-returned",
    }, "unused"),
    {
      enabled: true,
      serviceName: "dg-chat-api-2",
      protocol: "http/protobuf",
      endpoint: "https://collector.example/v1/",
      sampleRatio: 0.25,
    },
  );
  assertThrows(() => telemetryConfig({ DG_CHAT_OTEL_ENABLED: "true" }, "dg-chat-api"));
  assertThrows(() => telemetryConfig({ OTEL_DENO: "true" }, "dg-chat-api"));
  assertThrows(() => telemetryConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }, "dg-chat-api"));
  assertThrows(() =>
    telemetryConfig({
      DG_CHAT_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:password@collector.example",
    }, "dg-chat-api")
  );
  assertThrows(() =>
    telemetryConfig({
      DG_CHAT_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/v1/traces?token=secret",
    }, "dg-chat-api")
  );
  assertThrows(() => telemetryConfig({ OTEL_TRACES_SAMPLER_ARG: "1.1" }, "dg-chat-api"));
});
