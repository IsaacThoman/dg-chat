export type ObservabilityEnvironment = Readonly<Record<string, string | undefined>>;

export interface MetricsListenerConfig {
  enabled: boolean;
  hostname: string;
  port: number;
}

function boundedPort(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return parsed;
}

function boolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function metricsListenerConfig(
  env: ObservabilityEnvironment,
  defaults: { port: number; enabled?: boolean },
): MetricsListenerConfig {
  const hostname = env.METRICS_HOST?.trim() || "127.0.0.1";
  if (hostname.includes("/") || hostname.includes("://") || hostname.length > 255) {
    throw new Error("METRICS_HOST must be a hostname or IP address without a URL scheme");
  }
  return {
    enabled: boolean("METRICS_ENABLED", env.METRICS_ENABLED, defaults.enabled ?? false),
    hostname,
    port: boundedPort("METRICS_PORT", env.METRICS_PORT, defaults.port),
  };
}

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  protocol: "http/protobuf";
  endpoint: string | null;
  sampleRatio: number;
}

/**
 * Validate the privacy-bounded OpenTelemetry SDK configuration that DG Chat owns. Authentication
 * headers deliberately remain exporter-owned and are never returned, logged, or represented here.
 */
export function telemetryConfig(
  env: ObservabilityEnvironment,
  defaultServiceName: string,
): TelemetryConfig {
  if (env.OTEL_DENO === "true") {
    throw new Error(
      "OTEL_DENO must remain false because native auto-instrumentation exports raw capability URLs",
    );
  }
  const enabled = boolean("DG_CHAT_OTEL_ENABLED", env.DG_CHAT_OTEL_ENABLED, false);
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || defaultServiceName;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(serviceName)) {
    throw new Error("OTEL_SERVICE_NAME must contain only safe service-name characters");
  }
  const protocol = env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() || "http/protobuf";
  if (protocol !== "http/protobuf") {
    throw new Error("DG Chat's privacy-bounded trace exporter requires http/protobuf");
  }
  const rawEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  let endpoint: string | null = rawEndpoint || null;
  if (endpoint !== null) {
    const parsed = new URL(endpoint);
    if (
      !(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password ||
      parsed.search || parsed.hash
    ) {
      throw new Error(
        "OTEL_EXPORTER_OTLP_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment",
      );
    }
    endpoint = parsed.toString();
  }
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (tracesEndpoint) {
    const parsed = new URL(tracesEndpoint);
    if (
      !(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password ||
      parsed.search || parsed.hash
    ) {
      throw new Error(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment",
      );
    }
  }
  if (enabled && endpoint === null && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()) {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required when tracing is enabled",
    );
  }
  const sampler = env.OTEL_TRACES_SAMPLER?.trim() || "parentbased_traceidratio";
  if (sampler !== "parentbased_traceidratio") {
    throw new Error("OTEL_TRACES_SAMPLER must be parentbased_traceidratio");
  }
  const sampleRatio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? "0.1");
  if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1) {
    throw new Error("OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1");
  }
  return { enabled, serviceName, protocol: "http/protobuf", endpoint, sampleRatio };
}
