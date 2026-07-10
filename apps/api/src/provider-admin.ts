import { pinnedProviderFetch } from "./provider_transport.ts";

const MAX_DISCOVERY_BYTES = 1_048_576;
const MAX_DISCOVERED_MODELS = 1_000;
const MAX_MODEL_ID_LENGTH = 512;

export interface DiscoveredProviderModel {
  id: string;
  ownedBy: string | null;
}

export interface ProviderDiscoveryResult {
  models: DiscoveredProviderModel[];
  latencyMs: number;
}

export type ProviderTestFailure =
  | "authentication_failed"
  | "timeout"
  | "unreachable"
  | "invalid_response"
  | "upstream_error";

export class ProviderTestError extends Error {
  constructor(public category: ProviderTestFailure) {
    super(`Provider test failed: ${category}`);
  }
}

export function normalizeProviderBaseUrl(value: string): string {
  if (!value || value.length > 2_048) throw new TypeError("Provider base URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Provider base URL is invalid");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !url.hostname || url.port === "0"
  ) {
    throw new TypeError(
      "Provider base URL must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function discoveryUrl(baseUrl: string): string {
  return `${normalizeProviderBaseUrl(baseUrl)}/models`;
}

async function readBoundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderTestError("invalid_response");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DISCOVERY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderTestError("invalid_response");
  }
  if (!response.body) throw new ProviderTestError("invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DISCOVERY_BYTES) throw new ProviderTestError("invalid_response");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ProviderTestError) throw error;
    throw new ProviderTestError("invalid_response");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    signal?.throwIfAborted();
    return JSON.parse(body);
  } catch {
    throw new ProviderTestError("invalid_response");
  }
}

function validateDiscovery(payload: unknown): DiscoveredProviderModel[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProviderTestError("invalid_response");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length > MAX_DISCOVERED_MODELS) {
    throw new ProviderTestError("invalid_response");
  }
  const found = new Map<string, DiscoveredProviderModel>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProviderTestError("invalid_response");
    }
    const record = item as Record<string, unknown>;
    const hasControlCharacter = [...String(record.id)].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    if (
      typeof record.id !== "string" || !record.id.trim() ||
      record.id.length > MAX_MODEL_ID_LENGTH || hasControlCharacter
    ) throw new ProviderTestError("invalid_response");
    const id = record.id.trim();
    const ownedBy = record.owned_by === undefined || record.owned_by === null
      ? null
      : typeof record.owned_by === "string" && record.owned_by.length <= 256
      ? record.owned_by
      : undefined;
    if (ownedBy === undefined) throw new ProviderTestError("invalid_response");
    found.set(id, { id, ownedBy });
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function discoverProviderModels(
  baseUrl: string,
  apiKey: string,
  options: { timeoutMs?: number; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ProviderDiscoveryResult> {
  if (!apiKey || apiKey.length > 32_768) throw new ProviderTestError("authentication_failed");
  const started = performance.now();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? pinnedProviderFetch)(discoveryUrl(baseUrl), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      signal,
    });
  } catch (error) {
    if (error instanceof ProviderTestError) throw error;
    if (options.signal?.aborted) throw options.signal.reason;
    throw new ProviderTestError(timeout.aborted ? "timeout" : "unreachable");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderTestError("authentication_failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderTestError("upstream_error");
  }
  let payload: unknown;
  try {
    payload = await readBoundedJson(response, signal);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timeout.aborted) throw new ProviderTestError("timeout");
    throw error;
  }
  return {
    models: validateDiscovery(payload),
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  };
}
