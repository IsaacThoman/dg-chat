import type { z } from "npm:zod@4.1.12";
import { embeddingsSchema } from "@dg-chat/contracts";
import { pinnedProviderFetch } from "./provider_transport.ts";

export type EmbeddingsRequest = z.infer<typeof embeddingsSchema>;
export type ProviderFetch = typeof fetch;

export interface EmbeddingDatum {
  object: "embedding";
  embedding: number[] | string;
  index: number;
}

export interface EmbeddingsResponse {
  object: "list";
  data: EmbeddingDatum[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_EMBEDDINGS = 2_048;
const MAX_DIMENSIONS = 65_536;

export class EmbeddingsProviderError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    public readonly code = "provider_error",
    public readonly dispatchOutcome: "rejected" | "uncertain" = "uncertain",
    public readonly upstreamStatus?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmbeddingsProviderError";
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? Math.ceil(seconds * 1_000)
    : Date.parse(value) - Date.now();
  return Number.isSafeInteger(delay) && delay >= 0 ? Math.min(delay, 300_000) : undefined;
}

/** Starts best-effort response disposal without allowing a broken stream to delay error handling. */
function discardResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A locked or non-conforming stream must not replace the authoritative HTTP failure.
  }
}

/** Only protocol-level rejections that conclusively precede model execution are retry-safe. */
export function embeddingHttpResponseProvesNoExecution(status: number): boolean {
  return [400, 401, 403, 404, 405, 406, 411, 413, 414, 415, 416, 417, 421, 422, 426, 431]
    .includes(status);
}

function endpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const testHttp = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  if (
    (!testHttp && url.protocol !== "https:") || url.username || url.password || url.hash ||
    url.search
  ) {
    throw new EmbeddingsProviderError("Provider base URL is invalid", 500, "provider_config_error");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/embeddings`;
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new EmbeddingsProviderError("Provider response exceeded the size limit");
  }
  if (!response.body) throw new EmbeddingsProviderError("Provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new EmbeddingsProviderError("Provider response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EmbeddingsProviderError("Provider returned malformed JSON");
  }
}

function count(request: EmbeddingsRequest): number {
  if (typeof request.input === "string") return 1;
  if (request.input.length === 0) return 0;
  return typeof request.input[0] === "string" || Array.isArray(request.input[0])
    ? request.input.length
    : 1;
}

/** Conservative normalized JSON replay bound for a validated embeddings request. */
export function maximumEmbeddingsReplayBytes(request: EmbeddingsRequest): number {
  const dimensions = request.dimensions ?? MAX_DIMENSIONS;
  const bytesPerEmbedding = request.encoding_format === "base64"
    ? Math.ceil((dimensions * 4) / 3) * 4 + 256
    : dimensions * 32 + 256;
  return Math.min(MAX_RESPONSE_BYTES, 65_536 + count(request) * bytesPerEmbedding);
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new EmbeddingsProviderError(`Provider returned invalid ${field}`);
  }
  return Number(value);
}

function base64Dimensions(value: unknown): number {
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_DIMENSIONS * 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) throw new EmbeddingsProviderError("Provider returned an invalid base64 embedding");
  let byteLength: number;
  try {
    byteLength = atob(value).length;
  } catch {
    throw new EmbeddingsProviderError("Provider returned an invalid base64 embedding");
  }
  if (byteLength === 0 || byteLength % 4 !== 0 || byteLength / 4 > MAX_DIMENSIONS) {
    throw new EmbeddingsProviderError("Provider returned an invalid base64 embedding");
  }
  return byteLength / 4;
}

/** Strictly validates and normalizes an upstream OpenAI embeddings response. */
export function validateEmbeddingsResponse(
  value: unknown,
  request: EmbeddingsRequest,
  publicModel: string,
): EmbeddingsResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EmbeddingsProviderError("Provider returned an invalid embeddings response");
  }
  const body = value as Record<string, unknown>;
  if (body.object !== "list" || !Array.isArray(body.data)) {
    throw new EmbeddingsProviderError("Provider returned invalid embedding data");
  }
  const rawData = body.data;
  if (rawData.length !== count(request) || rawData.length > MAX_EMBEDDINGS) {
    throw new EmbeddingsProviderError("Provider returned invalid embedding data");
  }
  const expectedEncoding = request.encoding_format ?? "float";
  const seen = new Set<number>();
  let commonDimensions: number | undefined;
  const data = rawData.map((raw): EmbeddingDatum => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new EmbeddingsProviderError("Provider returned an invalid embedding item");
    }
    const item = raw as Record<string, unknown>;
    const index = nonnegativeInteger(item.index, "embedding index");
    if (index >= rawData.length || seen.has(index) || item.object !== "embedding") {
      throw new EmbeddingsProviderError("Provider returned invalid embedding indices");
    }
    seen.add(index);
    let embedding: number[] | string;
    let dimensions: number;
    if (expectedEncoding === "base64") {
      dimensions = base64Dimensions(item.embedding);
      embedding = item.embedding as string;
    } else {
      if (
        !Array.isArray(item.embedding) || item.embedding.length < 1 ||
        item.embedding.length > MAX_DIMENSIONS ||
        item.embedding.some((part) => typeof part !== "number" || !Number.isFinite(part))
      ) {
        throw new EmbeddingsProviderError("Provider returned an invalid float embedding");
      }
      dimensions = item.embedding.length;
      embedding = item.embedding as number[];
    }
    if (
      (request.dimensions !== undefined && dimensions !== request.dimensions) ||
      (commonDimensions !== undefined && dimensions !== commonDimensions)
    ) throw new EmbeddingsProviderError("Provider returned the wrong embedding dimensions");
    commonDimensions ??= dimensions;
    return { object: "embedding", embedding, index };
  }).sort((left, right) => left.index - right.index);
  const usage = body.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new EmbeddingsProviderError("Provider returned invalid embedding usage");
  }
  const promptTokens = nonnegativeInteger(
    (usage as Record<string, unknown>).prompt_tokens,
    "prompt token usage",
  );
  const totalTokens = nonnegativeInteger(
    (usage as Record<string, unknown>).total_tokens,
    "total token usage",
  );
  if (totalTokens < promptTokens) {
    throw new EmbeddingsProviderError("Provider returned invalid total token usage");
  }
  return {
    object: "list",
    data,
    model: publicModel,
    usage: { prompt_tokens: promptTokens, total_tokens: totalTokens },
  };
}

/** Calls an OpenAI-compatible embeddings provider through the DNS-pinned egress transport. */
export async function createEmbeddings(
  request: EmbeddingsRequest,
  options: {
    baseUrl: string;
    apiKey: string;
    upstreamModel: string;
    publicModel: string;
    signal: AbortSignal;
    fetch?: ProviderFetch;
  },
): Promise<EmbeddingsResponse> {
  options.signal.throwIfAborted();
  const upstreamRequest = { ...request, model: options.upstreamModel };
  const url = endpoint(options.baseUrl);
  const testHttp = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  const response = await (options.fetch ?? (testHttp ? fetch : pinnedProviderFetch))(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(upstreamRequest),
      redirect: "error",
      signal: options.signal,
    },
  );
  if (!response.ok) {
    // The HTTP status is authoritative even when an error body is empty, malformed, or oversized.
    // Do not let best-effort provider diagnostics erase retry/fallback/accounting semantics.
    discardResponseBody(response);
    throw new EmbeddingsProviderError(
      "Embedding provider request failed",
      response.status >= 500 ? 502 : 400,
      "provider_error",
      embeddingHttpResponseProvesNoExecution(response.status) ? "rejected" : "uncertain",
      response.status,
      retryAfterMs(response.headers),
    );
  }
  const payload = await boundedJson(response);
  return validateEmbeddingsResponse(payload, request, options.publicModel);
}
