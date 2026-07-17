import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanExporter,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type { TelemetryConfig } from "./config.ts";

const tracer = trace.getTracer("dg-chat", "0.1.0");

export interface TelemetryRuntime {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Install a manual privacy-bounded SDK instead of Deno's native auto instrumentation. Native
 * incoming spans retain duplicate raw URL attributes even after user code overwrites them, which
 * can disclose share capabilities and query content to an OTLP backend.
 */
export function startTelemetry(
  config: TelemetryConfig,
  options: { exporter?: SpanExporter } = {},
): TelemetryRuntime {
  if (!config.enabled) {
    return { forceFlush: () => Promise.resolve(), shutdown: () => Promise.resolve() };
  }
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": config.serviceName,
      "service.version": "0.1.0",
      "process.runtime.name": "deno",
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRatio) }),
    spanLimits: {
      attributeCountLimit: 16,
      attributeValueLengthLimit: 128,
      eventCountLimit: 0,
      linkCountLimit: 0,
    },
    spanProcessors: [
      new BatchSpanProcessor(options.exporter ?? new OTLPTraceExporter(), {
        maxQueueSize: 1_024,
        maxExportBatchSize: 256,
        scheduledDelayMillis: 5_000,
        exportTimeoutMillis: 2_000,
      }),
    ],
    forceFlushTimeoutMillis: 2_500,
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(contextManager)) {
    contextManager.disable();
    throw new Error("OpenTelemetry context manager was already registered");
  }
  if (!propagation.setGlobalPropagator(new W3CTraceContextPropagator())) {
    contextManager.disable();
    throw new Error("OpenTelemetry propagator was already registered");
  }
  if (!trace.setGlobalTracerProvider(provider)) {
    contextManager.disable();
    throw new Error("OpenTelemetry tracer provider was already registered");
  }
  let closing: Promise<void> | undefined;
  return {
    forceFlush() {
      return provider.forceFlush();
    },
    shutdown() {
      closing ??= provider.shutdown().finally(() => {
        contextManager.disable();
        trace.disable();
        context.disable();
        propagation.disable();
      });
      return closing;
    },
  };
}

const headerGetter: TextMapGetter<Headers> = {
  keys(carrier) {
    return [...carrier.keys()];
  },
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
};

/** Create a server span containing no URL, query, header, identity, or request-body attributes. */
export async function withHttpServerSpan<T>(
  request: Request,
  method: string,
  route: string,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = propagation.extract(context.active(), request.headers, headerGetter);
  return await context.with(parent, () =>
    tracer.startActiveSpan(`${method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": method,
        "http.route": route,
      },
    }, async (span) => {
      try {
        const result = await operation();
        span.setStatus(
          result instanceof Response && result.status >= 500
            ? { code: SpanStatusCode.ERROR, message: "request_failed" }
            : { code: SpanStatusCode.OK },
        );
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "request_failed" });
        throw error;
      } finally {
        span.end();
      }
    })) as T;
}

/** Run bounded internal work in the configured OpenTelemetry context. */
export async function withOperationalSpan<T>(
  name: string,
  attributes: Readonly<Record<string, string | number | boolean>>,
  operation: () => Promise<T>,
): Promise<T> {
  return await tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      // The exception itself may contain provider URLs, user input, object keys, or SQL. Record a
      // categorical outcome only; durable domain records retain the detailed failure where allowed.
      span.setStatus({ code: SpanStatusCode.ERROR, message: "operation_failed" });
      throw error;
    } finally {
      span.end();
    }
  });
}
