import {
  type DnsResolver,
  type NetworkPolicy,
  NetworkPolicyError,
  resolveNetworkTarget,
  validateNetworkTarget,
} from "./network-policy.ts";
import { Agent, fetch as pinnedFetch } from "undici";

export interface WebSearchRequest {
  query: string;
  count?: number;
  language?: string;
  safeSearch?: 0 | 1 | 2;
  signal?: AbortSignal;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
}

export interface WebSearchAdapter {
  readonly id: string;
  /**
   * Advisory policy metadata only. Adapters are trusted in-process code and must independently
   * enforce their transport boundary; WebSearchToolAdapter cannot sandbox a custom implementation.
   */
  readonly networkTarget: Readonly<{ hostname: string; privateNetwork: boolean }>;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}

export class WebSearchError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_configured"
      | "request_failed"
      | "invalid_response"
      | "response_too_large"
      | "request_timeout",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

export interface SearxngOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  resolveDns?: DnsResolver;
  /** A private endpoint is allowed only for the explicitly configured SearXNG origin. */
  allowPrivateEndpoint?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebSearchError("response_too_large", "Search response exceeded the size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WebSearchError("invalid_response", "Search response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WebSearchError("response_too_large", "Search response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WebSearchError("invalid_response", "Search service returned invalid JSON");
  }
}

export class SearxngSearchAdapter implements WebSearchAdapter {
  readonly id = "searxng";
  readonly targetHostname: string;
  readonly usesPrivateEndpoint: boolean;
  readonly networkTarget: Readonly<{ hostname: string; privateNetwork: boolean }>;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #resolveDns?: DnsResolver;
  readonly #policy: NetworkPolicy;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: SearxngOptions) {
    try {
      this.#baseUrl = new URL(options.baseUrl);
    } catch {
      throw new WebSearchError("not_configured", "SearXNG URL is invalid");
    }
    if (
      this.#baseUrl.username || this.#baseUrl.password || this.#baseUrl.search ||
      this.#baseUrl.hash
    ) {
      throw new WebSearchError(
        "not_configured",
        "SearXNG URL must not contain credentials or a query",
      );
    }
    this.#fetch = options.fetch ?? fetch;
    this.targetHostname = this.#baseUrl.hostname;
    this.usesPrivateEndpoint = options.allowPrivateEndpoint === true;
    this.networkTarget = Object.freeze({
      hostname: this.targetHostname,
      privateNetwork: this.usesPrivateEndpoint,
    });
    this.#resolveDns = options.resolveDns;
    this.#policy = {
      allowedDomains: [this.#baseUrl.hostname],
      allowedPorts: [
        this.#baseUrl.port
          ? Number(this.#baseUrl.port)
          : this.#baseUrl.protocol === "https:"
          ? 443
          : 80,
      ],
      allowPrivateNetwork: options.allowPrivateEndpoint === true,
    };
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 100 ||
      this.#timeoutMs > 60_000
    ) {
      throw new WebSearchError("not_configured", "SearXNG timeout is invalid");
    }
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const query = request.query.trim();
    const count = request.count ?? 8;
    if (!query || query.length > 1_000 || !Number.isSafeInteger(count) || count < 1 || count > 20) {
      throw new WebSearchError("invalid_request", "Search query or result count is invalid");
    }
    const url = new URL(
      "search",
      this.#baseUrl.href.endsWith("/") ? this.#baseUrl : `${this.#baseUrl.href}/`,
    );
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", String(request.safeSearch ?? 1));
    if (request.language) url.searchParams.set("language", request.language.slice(0, 32));
    try {
      if (this.#fetch !== fetch) {
        const validated = await validateNetworkTarget(url, this.#policy, this.#resolveDns);
        return await this.#request(request, validated, [], count, query);
      }
      const resolved = await resolveNetworkTarget(url, this.#policy, this.#resolveDns);
      return await this.#request(request, resolved.url, resolved.addresses, count, query);
    } catch (error) {
      if (error instanceof NetworkPolicyError) {
        throw new WebSearchError("request_failed", `Search endpoint blocked: ${error.code}`);
      }
      throw error;
    }
  }

  async #request(
    request: WebSearchRequest,
    url: URL,
    addresses: string[],
    count: number,
    query: string,
  ): Promise<WebSearchResponse> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    let dispatcher: Agent | undefined;
    try {
      if (this.#fetch !== fetch) {
        response = await this.#fetch(url, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal,
        });
      } else {
        let cursor = 0;
        dispatcher = new Agent({
          connect: {
            lookup(_hostname, options, callback) {
              const records = addresses.map((address) => ({
                address,
                family: address.includes(":") ? 6 as const : 4 as const,
              }));
              if (options.all) {
                callback(null, records);
              } else {
                const record = records[cursor++ % records.length];
                callback(null, record.address, record.family);
              }
            },
          },
        });
        response = await pinnedFetch(url, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal,
          dispatcher,
        }) as unknown as Response;
      }
    } catch {
      await dispatcher?.close();
      if (signal.aborted) {
        throw new WebSearchError(
          "request_timeout",
          "Search request was cancelled or timed out",
          true,
        );
      }
      throw new WebSearchError("request_failed", "Search service could not be reached", true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      await dispatcher?.close();
      throw new WebSearchError(
        "request_failed",
        `Search service returned HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
    if (contentType !== "application/json") {
      await response.body?.cancel();
      await dispatcher?.close();
      throw new WebSearchError("invalid_response", "Search service did not return JSON");
    }
    let data: unknown;
    try {
      data = await readBoundedJson(response, this.#maxResponseBytes);
    } finally {
      await dispatcher?.close();
    }
    if (
      !data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)
    ) {
      throw new WebSearchError("invalid_response", "Search service response is malformed");
    }
    const results: WebSearchResult[] = [];
    for (const raw of (data as { results: unknown[] }).results) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const title = boundedString(item.title, 500);
      const target = boundedString(item.url, 4_096);
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        continue;
      }
      // Returned links are displayed/cited, never fetched here. Still exclude dangerous schemes.
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        continue;
      }
      if (!title) continue;
      const source = boundedString(item.engine, 120);
      const publishedAt = boundedString(item.publishedDate, 120);
      results.push({
        title,
        url: parsed.href,
        snippet: boundedString(item.content, 4_000),
        ...(source ? { source } : {}),
        ...(publishedAt ? { publishedAt } : {}),
      });
      if (results.length >= count) break;
    }
    return { query, results };
  }
}
