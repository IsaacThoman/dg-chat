import type { MetricsListenerConfig } from "./config.ts";

type Labels = Readonly<Record<string, string>>;
type Sample = { labels: Labels; value: number };

function escapeHelp(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labelKey(labels: Labels): string {
  return Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(
    ([name, value]) => `${name}=${JSON.stringify(value)}`,
  ).join(",");
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0
    ? ""
    : `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

abstract class Metric {
  readonly name: string;
  readonly help: string;
  abstract readonly type: "counter" | "gauge" | "histogram";

  constructor(name: string, help: string) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(name)) throw new Error(`Invalid metric name ${name}`);
    this.name = name;
    this.help = help;
  }

  abstract render(): string[];

  header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }
}

export class Counter extends Metric {
  readonly type = "counter" as const;
  #samples = new Map<string, Sample>();

  add(value = 1, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) throw new Error("Counter increments must be finite");
    const key = labelKey(labels);
    const prior = this.#samples.get(key);
    this.#samples.set(key, { labels, value: (prior?.value ?? 0) + value });
  }

  render(): string[] {
    return [
      ...this.header(),
      ...[...this.#samples.values()].map((sample) =>
        `${this.name}${renderLabels(sample.labels)} ${sample.value}`
      ),
    ];
  }
}

export class Gauge extends Metric {
  readonly type = "gauge" as const;
  #samples = new Map<string, Sample>();

  set(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) throw new Error("Gauge values must be finite");
    this.#samples.set(labelKey(labels), { labels, value });
  }

  add(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    this.set((this.#samples.get(key)?.value ?? 0) + value, labels);
  }

  render(): string[] {
    return [
      ...this.header(),
      ...[...this.#samples.values()].map((sample) =>
        `${this.name}${renderLabels(sample.labels)} ${sample.value}`
      ),
    ];
  }
}

export class Histogram extends Metric {
  readonly type = "histogram" as const;
  readonly #buckets: readonly number[];
  #samples = new Map<string, { labels: Labels; values: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, buckets: readonly number[]) {
    super(name, help);
    if (
      buckets.some((value, index) =>
        !Number.isFinite(value) || value <= 0 ||
        (index > 0 && value <= buckets[index - 1])
      )
    ) {
      throw new Error("Histogram buckets must be finite, positive, and strictly increasing");
    }
    this.#buckets = [...buckets];
  }

  observe(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Histogram values must be nonnegative");
    }
    const key = labelKey(labels);
    const sample = this.#samples.get(key) ?? {
      labels,
      values: this.#buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    this.#buckets.forEach((bound, index) => {
      if (value <= bound) sample.values[index] += 1;
    });
    sample.sum += value;
    sample.count += 1;
    this.#samples.set(key, sample);
  }

  render(): string[] {
    const lines = this.header();
    for (const sample of this.#samples.values()) {
      this.#buckets.forEach((bound, index) => {
        lines.push(
          `${this.name}_bucket${renderLabels({ ...sample.labels, le: String(bound) })} ${
            sample.values[index]
          }`,
        );
      });
      lines.push(
        `${this.name}_bucket${renderLabels({ ...sample.labels, le: "+Inf" })} ${sample.count}`,
      );
      lines.push(`${this.name}_sum${renderLabels(sample.labels)} ${sample.sum}`);
      lines.push(`${this.name}_count${renderLabels(sample.labels)} ${sample.count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  #metrics = new Map<string, Metric>();

  register<T extends Metric>(metric: T): T {
    if (this.#metrics.has(metric.name)) {
      throw new Error(`Metric ${metric.name} is already registered`);
    }
    this.#metrics.set(metric.name, metric);
    return metric;
  }

  render(): string {
    const lines = [...this.#metrics.values()].flatMap((metric) => metric.render());
    return `${lines.join("\n")}\n`;
  }
}

export interface MetricsServer {
  readonly address: { hostname: string; port: number };
  close(): Promise<void>;
}

export function startMetricsServer(
  registry: MetricsRegistry,
  config: MetricsListenerConfig,
): MetricsServer | null {
  if (!config.enabled) return null;
  const abort = new AbortController();
  const server = Deno.serve({
    hostname: config.hostname,
    port: config.port,
    signal: abort.signal,
    onListen: () => {},
  }, (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (url.pathname === "/healthz") return new Response(null, { status: 204 });
    if (url.pathname !== "/metrics") return new Response("Not found\n", { status: 404 });
    const body = request.method === "HEAD" ? null : registry.render();
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  let closing: Promise<void> | undefined;
  const address = server.addr as Deno.NetAddr;
  return {
    address: { hostname: address.hostname, port: address.port },
    close() {
      closing ??= (async () => {
        abort.abort(new DOMException("Metrics server stopping", "AbortError"));
        await server.finished.catch((error) => {
          if (!abort.signal.aborted) throw error;
        });
      })();
      return closing;
    },
  };
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

export function boundedHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : "OTHER";
}

export function boundedRoute(pathname: string): string {
  if (pathname === "/health") return "health";
  if (pathname === "/ready") return "ready";
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return "api_auth";
  if (pathname === "/api/admin" || pathname.startsWith("/api/admin/")) return "api_admin";
  if (pathname === "/api/public" || pathname.startsWith("/api/public/")) return "api_public";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  if (pathname === "/v1/chat/completions") return "v1_chat_completions";
  if (pathname === "/v1/responses") return "v1_responses";
  if (pathname === "/v1/embeddings") return "v1_embeddings";
  if (pathname === "/v1/models") return "v1_models";
  if (pathname === "/v1/files" || pathname.startsWith("/v1/files/")) return "v1_files";
  if (pathname === "/v1/images/generations") return "v1_images";
  if (pathname === "/v1/audio" || pathname.startsWith("/v1/audio/")) return "v1_audio";
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return "v1_other";
  return "other";
}

export function statusClass(status: number): string {
  return status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "other";
}
