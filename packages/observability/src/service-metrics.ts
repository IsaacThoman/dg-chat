import {
  boundedHttpMethod,
  boundedRoute,
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  statusClass,
} from "./metrics.ts";
import type { ResponseLifecycleOutcome } from "./response-lifecycle.ts";
import { withHttpServerSpan } from "./tracing.ts";

const REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const JOB_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300];
const JOB_TYPES = new Set([
  "attachment.inspect",
  "attachment.ingest",
  "document.embed",
  "file_object.cleanup",
  "generated_object.cleanup",
  "retention.scrub",
]);
const JOB_OUTCOMES = new Set(["completed", "deferred", "failed", "cancelled"]);
const PROVIDER_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "skipped"]);
const BREAKER_STATES = new Set(["closed", "open", "half_open", "unavailable", "none"]);

let providerAttemptObserver = (
  _outcome: string,
  _breakerAfter: string | null | undefined,
): void => {};
type RealtimeTransport = "websocket" | "webrtc";
type RealtimeOutcome =
  | "completed"
  | "client_closed"
  | "provider_closed"
  | "capacity_lost"
  | "failed";
let realtimeStartObserver = (_transport: RealtimeTransport): void => {};
let realtimeEndObserver = (
  _transport: RealtimeTransport,
  _outcome: RealtimeOutcome,
  _clientEvents: number,
  _serverEvents: number,
): void => {};

export function recordRealtimeSessionStarted(transport: RealtimeTransport): void {
  realtimeStartObserver(transport);
}

export function recordRealtimeSessionEnded(
  transport: RealtimeTransport,
  outcome: RealtimeOutcome,
  clientEvents = 0,
  serverEvents = 0,
): void {
  realtimeEndObserver(transport, outcome, clientEvents, serverEvents);
}

/** Record only the categorical terminal provider state; provider/model/error identities are excluded. */
export function recordProviderAttemptMetric(
  outcome: string,
  breakerAfter: string | null | undefined,
): void {
  providerAttemptObserver(outcome, breakerAfter);
}

export function boundedJobType(type: string): string {
  return JOB_TYPES.has(type) ? type : "other";
}

function safeJobOutcome(outcome: string): string {
  return JOB_OUTCOMES.has(outcome) ? outcome : "failed";
}

export interface ApiMetrics {
  readonly registry: MetricsRegistry;
  instrument(
    handler: (request: Request) => Response | Promise<Response>,
  ): (request: Request) => Promise<Response>;
  setDependencyReady(dependency: "postgres" | "redis" | "s3", ready: boolean): void;
}

export function createApiMetrics(version = "0.1.0"): ApiMetrics {
  const registry = new MetricsRegistry();
  const build = registry.register(
    new Gauge("dg_chat_build_info", "Static service build information"),
  );
  build.set(1, { service: "api", version });
  const up = registry.register(new Gauge("dg_chat_process_up", "Whether this process is running"));
  up.set(1, { service: "api" });
  const ready = registry.register(
    new Gauge("dg_chat_process_ready", "Most recently observed process readiness"),
  );
  ready.set(0, { service: "api" });
  const dependencyReady = registry.register(
    new Gauge(
      "dg_chat_dependency_ready",
      "Most recently observed required dependency readiness",
    ),
  );
  for (const dependency of ["postgres", "redis", "s3"]) {
    dependencyReady.set(0, { service: "api", dependency });
  }
  const requests = registry.register(
    new Counter(
      "dg_chat_http_requests_total",
      "HTTP requests completed by bounded route group and status class",
    ),
  );
  const responseLifecycles = registry.register(
    new Counter(
      "dg_chat_http_response_lifecycle_total",
      "Terminal HTTP response lifecycles by bounded route group and outcome",
    ),
  );
  const inFlight = registry.register(
    new Gauge(
      "dg_chat_http_requests_in_flight",
      "HTTP requests whose response bodies have not completed or been cancelled",
    ),
  );
  const duration = registry.register(
    new Histogram(
      "dg_chat_http_request_duration_seconds",
      "Time until the HTTP response body completes, errors, or is cancelled",
      REQUEST_BUCKETS,
    ),
  );
  const providerAttempts = registry.register(
    new Counter(
      "dg_chat_provider_attempts_total",
      "Terminal provider attempts by bounded outcome and circuit state",
    ),
  );
  const providerCircuitOpened = registry.register(
    new Gauge(
      "dg_chat_provider_circuit_last_open_timestamp_seconds",
      "Unix timestamp of the most recent provider attempt that observed an open circuit",
    ),
  );
  providerCircuitOpened.set(0);
  const realtimeActive = registry.register(
    new Gauge("dg_chat_realtime_sessions_active", "Active Realtime sessions by transport"),
  );
  const realtimeSessions = registry.register(
    new Counter(
      "dg_chat_realtime_sessions_total",
      "Terminal Realtime sessions by transport and outcome",
    ),
  );
  const realtimeEvents = registry.register(
    new Counter(
      "dg_chat_realtime_events_total",
      "Validated Realtime JSON events by transport and direction",
    ),
  );
  for (const transport of ["websocket", "webrtc"] as const) realtimeActive.set(0, { transport });
  realtimeStartObserver = (transport) => realtimeActive.add(1, { transport });
  realtimeEndObserver = (transport, outcome, clientEvents, serverEvents) => {
    realtimeActive.add(-1, { transport });
    realtimeSessions.add(1, { transport, outcome });
    realtimeEvents.add(clientEvents, { transport, direction: "client" });
    realtimeEvents.add(serverEvents, { transport, direction: "server" });
  };
  providerAttemptObserver = (outcome, breakerAfter) => {
    const safeOutcome = PROVIDER_OUTCOMES.has(outcome) ? outcome : "failed";
    const candidate = breakerAfter ?? "none";
    const safeBreaker = BREAKER_STATES.has(candidate) ? candidate : "unavailable";
    providerAttempts.add(1, { outcome: safeOutcome, breaker_after: safeBreaker });
    if (safeBreaker === "open") providerCircuitOpened.set(Date.now() / 1_000);
  };

  const inspectReadiness = async (response: Response) => {
    ready.set(response.status === 200 ? 1 : 0, { service: "api" });
    try {
      const value = await response.clone().json() as Record<string, unknown>;
      for (
        const [field, dependency] of [
          ["storage", "postgres"],
          ["redis", "redis"],
          ["objects", "s3"],
        ] as const
      ) {
        const status = value[field];
        const isReady = status !== null && typeof status === "object" &&
          (status as Record<string, unknown>).ready === true;
        dependencyReady.set(isReady ? 1 : 0, { service: "api", dependency });
      }
    } catch {
      for (const dependency of ["postgres", "redis", "s3"]) {
        dependencyReady.set(0, { service: "api", dependency });
      }
    }
  };

  return {
    registry,
    instrument(handler) {
      return async (request) => {
        const route = boundedRoute(new URL(request.url).pathname);
        const method = boundedHttpMethod(request.method);
        const labels = { method, route };
        inFlight.add(1, labels);
        const started = performance.now();
        let status = 500;
        let settled = false;
        const settle = (
          outcome: ResponseLifecycleOutcome,
          responseStatus = status,
        ) => {
          if (settled) return;
          settled = true;
          status = responseStatus;
          inFlight.add(-1, labels);
          requests.add(1, { ...labels, status_class: statusClass(status) });
          responseLifecycles.add(1, { ...labels, outcome });
          duration.observe((performance.now() - started) / 1_000, labels);
        };
        try {
          const response = await withHttpServerSpan(
            request,
            method,
            route,
            () => Promise.resolve(handler(request)),
            {
              onResponseSettled: settle,
            },
          );
          status = response.status;
          if (route === "ready") void inspectReadiness(response);
          return response;
        } catch (error) {
          settle("failed");
          throw error;
        }
      };
    },
    setDependencyReady(dependency, value) {
      dependencyReady.set(value ? 1 : 0, { service: "api", dependency });
    },
  };
}

export interface WorkerMetrics {
  readonly registry: MetricsRegistry;
  setReady(ready: boolean): void;
  setDependencyReady(dependency: "postgres" | "s3", ready: boolean): void;
  setQueue(status: "queued" | "running" | "failed", count: number, oldestSeconds: number): void;
  recordLoopFailure(kind: "database" | "heartbeat" | "storage" | "application"): void;
  setRetentionScheduleOverdue(seconds: number): void;
  recordRetentionScheduleOutcome(outcome: "scheduled" | "not_due" | "failed"): void;
  runJob<T>(type: string, operation: () => Promise<T>): Promise<T>;
  recordJobOutcome(type: string, outcome: string, durationSeconds: number): void;
}

export function createWorkerMetrics(version = "0.1.0"): WorkerMetrics {
  const registry = new MetricsRegistry();
  const build = registry.register(
    new Gauge("dg_chat_build_info", "Static service build information"),
  );
  build.set(1, { service: "worker", version });
  const up = registry.register(new Gauge("dg_chat_process_up", "Whether this process is running"));
  up.set(1, { service: "worker" });
  const ready = registry.register(
    new Gauge("dg_chat_process_ready", "Whether the worker poll loop is ready"),
  );
  ready.set(0, { service: "worker" });
  const dependencyReady = registry.register(
    new Gauge(
      "dg_chat_dependency_ready",
      "Most recently observed required dependency readiness",
    ),
  );
  dependencyReady.set(0, { service: "worker", dependency: "postgres" });
  dependencyReady.set(0, { service: "worker", dependency: "s3" });
  const queueDepth = registry.register(
    new Gauge("dg_chat_job_queue_depth", "Durable jobs by bounded status"),
  );
  const queueAge = registry.register(
    new Gauge(
      "dg_chat_job_queue_oldest_seconds",
      "Age of the oldest durable job by bounded status",
    ),
  );
  for (const status of ["queued", "running", "failed"]) {
    queueDepth.set(0, { status });
    queueAge.set(0, { status });
  }
  const jobs = registry.register(
    new Counter(
      "dg_chat_worker_jobs_total",
      "Worker job processing outcomes by bounded job type",
    ),
  );
  const duration = registry.register(
    new Histogram(
      "dg_chat_worker_job_duration_seconds",
      "Worker job processing duration by bounded type and outcome",
      JOB_BUCKETS,
    ),
  );
  const failures = registry.register(
    new Counter(
      "dg_chat_worker_loop_failures_total",
      "Categorical worker runtime failures",
    ),
  );
  const retentionScheduleOverdue = registry.register(
    new Gauge(
      "dg_chat_retention_schedule_overdue_seconds",
      "Seconds the durable automatic retention schedule was overdue at its latest check",
    ),
  );
  retentionScheduleOverdue.set(0);
  const retentionScheduleOutcomes = registry.register(
    new Counter(
      "dg_chat_retention_schedule_checks_total",
      "Automatic retention scheduler checks by bounded outcome",
    ),
  );

  const recordJobOutcome = (type: string, outcome: string, elapsed: number) => {
    const labels = { type: boundedJobType(type), outcome: safeJobOutcome(outcome) };
    jobs.add(1, labels);
    duration.observe(Math.max(0, elapsed), labels);
  };
  return {
    registry,
    setReady(value) {
      ready.set(value ? 1 : 0, { service: "worker" });
    },
    setDependencyReady(dependency, value) {
      dependencyReady.set(value ? 1 : 0, { service: "worker", dependency });
    },
    setQueue(status, count, oldestSeconds) {
      queueDepth.set(Math.max(0, count), { status });
      queueAge.set(Math.max(0, oldestSeconds), { status });
    },
    recordLoopFailure(kind) {
      failures.add(1, { kind });
    },
    setRetentionScheduleOverdue(seconds) {
      retentionScheduleOverdue.set(Math.max(0, seconds));
    },
    recordRetentionScheduleOutcome(outcome) {
      retentionScheduleOutcomes.add(1, { outcome });
    },
    async runJob(type, operation) {
      const started = performance.now();
      try {
        const result = await operation();
        recordJobOutcome(type, "completed", (performance.now() - started) / 1_000);
        return result;
      } catch (error) {
        recordJobOutcome(type, "failed", (performance.now() - started) / 1_000);
        throw error;
      }
    },
    recordJobOutcome,
  };
}
