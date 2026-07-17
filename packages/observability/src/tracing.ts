import {
  type Context,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { TelemetryConfig } from "./config.ts";
import { observeResponseLifecycle, type ResponseLifecycleOutcome } from "./response-lifecycle.ts";

const tracer = trace.getTracer("dg-chat", "0.1.0");

export interface TelemetryRuntime {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

function secureRandomUnit(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 0x1_0000_0000;
}

/**
 * Inherit a decision only from an in-process parent. Every remote/root request receives a fresh,
 * locally unpredictable draw, so callers cannot grind or reuse trace IDs to force telemetry export.
 */
export class LocalRandomRatioSampler implements Sampler {
  readonly #ratio: number;
  readonly #random: () => number;

  constructor(ratio: number, random: () => number) {
    this.#ratio = ratio;
    this.#random = random;
  }

  shouldSample(parentContext: Context): SamplingResult {
    const parent = trace.getSpanContext(parentContext);
    if (parent && !parent.isRemote) {
      return {
        decision: (parent.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD,
      };
    }
    if (this.#ratio <= 0) return { decision: SamplingDecision.NOT_RECORD };
    if (this.#ratio >= 1) return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    const draw = this.#random();
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return {
      decision: draw < this.#ratio
        ? SamplingDecision.RECORD_AND_SAMPLED
        : SamplingDecision.NOT_RECORD,
    };
  }

  toString(): string {
    return `LocalRandomRatioSampler{${this.#ratio}}`;
  }
}

/**
 * Install a manual privacy-bounded SDK instead of Deno's native auto instrumentation. Native
 * incoming spans retain duplicate raw URL attributes even after user code overwrites them, which
 * can disclose share capabilities and query content to an OTLP backend.
 */
export function startTelemetry(
  config: TelemetryConfig,
  options: { exporter?: SpanExporter; random?: () => number } = {},
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
    // Preserve the remote trace ID for correlation, but make a fresh local decision so neither its
    // sampled bit nor a deliberately ground/reused trace ID can override the installation budget.
    sampler: new LocalRandomRatioSampler(
      config.sampleRatio,
      options.random ?? secureRandomUnit,
    ),
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
    return carrier.has("traceparent") ? ["traceparent"] : [];
  },
  get(carrier, key) {
    // W3CTraceContextPropagator also asks for `tracestate`. It is arbitrary caller-controlled text
    // and must never be inherited into an exported span.
    return key.toLowerCase() === "traceparent"
      ? carrier.get("traceparent") ?? undefined
      : undefined;
  },
};

export interface HttpServerSpanOptions {
  onResponseSettled?: (outcome: ResponseLifecycleOutcome, status: number) => void;
}

function terminalHttpSpanStatus(outcome: ResponseLifecycleOutcome, status: number) {
  if (outcome === "cancelled") {
    return { code: SpanStatusCode.ERROR, message: "response_body_cancelled" } as const;
  }
  if (outcome === "failed") {
    return { code: SpanStatusCode.ERROR, message: "response_body_failed" } as const;
  }
  return status >= 500
    ? { code: SpanStatusCode.ERROR, message: "request_failed" } as const
    : { code: SpanStatusCode.OK } as const;
}

/** Create a server span containing no URL, query, header, identity, or request-body attributes. */
export async function withHttpServerSpan(
  request: Request,
  method: string,
  route: string,
  operation: () => Promise<Response>,
  options: HttpServerSpanOptions = {},
): Promise<Response> {
  const parent = propagation.extract(context.active(), request.headers, headerGetter);
  return await context.with(parent, () =>
    tracer.startActiveSpan(`${method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": method,
        "http.route": route,
      },
    }, async (span) => {
      let ended = false;
      const finish = (
        outcome: ResponseLifecycleOutcome,
        status: number,
        spanStatus: ReturnType<typeof terminalHttpSpanStatus>,
      ) => {
        if (ended) return;
        ended = true;
        span.setStatus(spanStatus);
        span.end();
        // Observability callbacks must never alter response bytes or request success.
        try {
          options.onResponseSettled?.(outcome, status);
        } catch {
          // The owned metrics callback is non-throwing; this remains fail-safe for other consumers.
        }
      };
      const settle = (outcome: ResponseLifecycleOutcome, status: number) =>
        finish(outcome, status, terminalHttpSpanStatus(outcome, status));
      try {
        const response = await operation();
        return observeResponseLifecycle(
          response,
          method !== "HEAD",
          (outcome) => settle(outcome, response.status),
        );
      } catch (error) {
        finish("failed", 500, {
          code: SpanStatusCode.ERROR,
          message: "request_failed",
        });
        throw error;
      }
    }));
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
