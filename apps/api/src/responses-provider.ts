import type { ChatCompletionRequest } from "@dg-chat/contracts";
import {
  type CanonicalResult,
  type CanonicalStreamEvent,
  type CanonicalUrlCitation,
  chatCompletionsRequestToResponses,
  MAX_PROVIDER_PROTOCOL_PAYLOAD_BYTES,
  MAX_RESPONSE_CITATION_COLLECTION_BYTES,
  normalizeResponsesResult,
  normalizeResponsesStreamEvent,
  ProviderProtocolError,
} from "./provider-protocol.ts";
import { type UpstreamStreamOptions } from "./models.ts";
import { providerResponseByteLimit } from "./provider-limits.ts";
import { isSpecialUseIp, pinnedProviderFetch } from "./provider_transport.ts";
import { ProviderAttemptError } from "./provider-resilience.ts";

const MAX_SSE_LINE_BYTES = 1_048_576;
const MAX_ERROR_BODY_BYTES = 65_536;
// Large whitespace/code tokens can decode to far more than four bytes. Keep a bounded
// per-token ceiling while the transport-wide response limit remains the hard outer bound.
export const MAX_VISIBLE_BYTES_PER_OUTPUT_TOKEN = 256;
const MAX_JSON_BYTES_PER_VISIBLE_BYTE = 6;
const RESPONSES_TERMINAL_TEXT_PROJECTIONS = 2;
// The provider transport contains the first visible projection. Before the terminal response, the
// projector can repeat that accumulated value in value-done, part-done, and item-done events.
const RESPONSES_STREAM_REPEATED_TEXT_PROJECTIONS = 3;
// Citations are emitted once when added, then repeated in content-part done, output-item done,
// and the terminal response. The canonical protocol boundary caps their accumulated public JSON.
const RESPONSES_STREAM_REPEATED_CITATION_PROJECTIONS = 2;
const RESPONSES_TERMINAL_ENVELOPE_BYTES = 65_536;
const RESPONSES_BUFFERED_PROVIDER_PROJECTIONS = 3;
const RESPONSES_STREAM_EVENT_ENVELOPE_BYTES = 512;
const encoder = new TextEncoder();

/**
 * Bounds a projected terminal Responses object before provider work begins. Completed assistant
 * text appears in both `output_text` and the message output item, and a one-byte control character
 * can require a six-byte JSON escape in each projection.
 */
export function responsesTerminalReplayUpperBound(
  maxOutputTokens: number,
  echoedRequestBytes: number,
  providerResponseBytes = providerResponseByteLimit(),
): number {
  if (
    !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0 ||
    !Number.isSafeInteger(echoedRequestBytes) || echoedRequestBytes < 0 ||
    !Number.isSafeInteger(providerResponseBytes) || providerResponseBytes < 0
  ) throw new TypeError("Responses replay bounds must be non-negative safe integers");
  const escapedVisibleBytes = BigInt(maxOutputTokens) *
    BigInt(MAX_VISIBLE_BYTES_PER_OUTPUT_TOKEN) * BigInt(MAX_JSON_BYTES_PER_VISIBLE_BYTE);
  const providerBytes = BigInt(providerResponseBytes);
  const boundedEscapedVisibleBytes = escapedVisibleBytes < providerBytes
    ? escapedVisibleBytes
    : providerBytes;
  const total = BigInt(echoedRequestBytes) +
    boundedEscapedVisibleBytes * BigInt(RESPONSES_TERMINAL_TEXT_PROJECTIONS) +
    BigInt(MAX_RESPONSE_CITATION_COLLECTION_BYTES) +
    BigInt(RESPONSES_TERMINAL_ENVELOPE_BYTES);
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
}

/**
 * Buffered provider payloads cross the protocol's whole-JSON clone boundary before projection.
 * Three copies cover the normalized output, the extra top-level output_text projection, and
 * structural/key expansion; the request echo and public envelope are budgeted separately.
 */
export function responsesBufferedReplayUpperBound(echoedRequestBytes: number): number {
  if (!Number.isSafeInteger(echoedRequestBytes) || echoedRequestBytes < 0) {
    throw new TypeError("Responses replay bounds must be non-negative safe integers");
  }
  const total = BigInt(echoedRequestBytes) +
    BigInt(MAX_PROVIDER_PROTOCOL_PAYLOAD_BYTES) *
      BigInt(RESPONSES_BUFFERED_PROVIDER_PROJECTIONS) +
    BigInt(RESPONSES_TERMINAL_ENVELOPE_BYTES);
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
}

/**
 * Includes every accumulated-value projection emitted before the final terminal response. The
 * final response itself is covered by `responsesTerminalReplayUpperBound`; this additional bound
 * covers deltas plus the value-, part-, and item-done lifecycle events.
 */
export function responsesStreamReplayUpperBound(
  maxOutputTokens: number,
  echoedRequestBytes: number,
  maxEvents: number,
  providerResponseBytes = providerResponseByteLimit(),
): number {
  if (
    !Number.isSafeInteger(maxEvents) || maxEvents < 0 ||
    !Number.isSafeInteger(providerResponseBytes) || providerResponseBytes < 0
  ) {
    throw new TypeError("Responses replay event and provider bounds must be non-negative integers");
  }
  const visibleBytes = BigInt(maxOutputTokens) * BigInt(MAX_VISIBLE_BYTES_PER_OUTPUT_TOKEN);
  const escapedVisibleBytes = visibleBytes * BigInt(MAX_JSON_BYTES_PER_VISIBLE_BYTE);
  const providerBytes = BigInt(providerResponseBytes);
  const repeatedVisibleBytes = escapedVisibleBytes < providerBytes
    ? escapedVisibleBytes
    : providerBytes;
  const projectedLifecycleBytes = providerBytes +
    repeatedVisibleBytes * BigInt(RESPONSES_STREAM_REPEATED_TEXT_PROJECTIONS) +
    BigInt(MAX_RESPONSE_CITATION_COLLECTION_BYTES) *
      BigInt(RESPONSES_STREAM_REPEATED_CITATION_PROJECTIONS) +
    BigInt(maxEvents) * BigInt(RESPONSES_STREAM_EVENT_ENVELOPE_BYTES);
  const total = BigInt(responsesTerminalReplayUpperBound(
    maxOutputTokens,
    echoedRequestBytes,
    providerResponseBytes,
  )) + projectedLifecycleBytes + BigInt(echoedRequestBytes) * 2n;
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
}

class ResponsesStreamConsistency {
  readonly #text = new Map<string, string>();
  readonly #tools = new Map<number, { id: string; name: string; arguments: string }>();
  #refusal = "";
  #reasoning = "";
  #summary = "";
  readonly #annotations: Array<{ key: string; annotation: CanonicalUrlCitation }> = [];

  observe(events: CanonicalStreamEvent[]) {
    for (const event of events) {
      if (event.type === "text_delta") {
        const key = `${event.outputIndex ?? 0}:${event.contentIndex ?? 0}`;
        this.#text.set(key, (this.#text.get(key) ?? "") + event.text);
      } else if (event.type === "refusal_delta") this.#refusal += event.text;
      else if (event.type === "reasoning_delta") {
        if (event.summary) this.#summary += event.text;
        else this.#reasoning += event.text;
      } else if (event.type === "tool_call_delta") {
        const current = this.#tools.get(event.index) ?? { id: "", name: "", arguments: "" };
        this.#tools.set(event.index, {
          id: event.id ?? current.id,
          name: event.name ?? current.name,
          arguments: current.arguments + (event.arguments ?? ""),
        });
      } else if (event.type === "annotation") {
        const key = `${event.outputIndex ?? 0}:${event.contentIndex ?? 0}`;
        if (!this.#text.has(key)) this.#text.set(key, "");
        this.#annotations.push({ key, annotation: { ...event.annotation } });
      }
    }
  }

  validate(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const event = input as Record<string, unknown>;
    const type = event.type;
    const text = (field: string) => {
      if (typeof event[field] !== "string") {
        throw new Error(`Responses ${String(type)} omitted ${field}`);
      }
      return event[field] as string;
    };
    const index = (field: string) => {
      const value = event[field] ?? 0;
      if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`Responses ${String(type)} has an invalid ${field}`);
      }
      return Number(value);
    };
    if (type === "response.output_text.done") {
      this.#equal(
        text("text"),
        this.#text.get(`${index("output_index")}:${index("content_index")}`) ?? "",
        type,
      );
    } else if (type === "response.refusal.done") {
      this.#equal(text("refusal"), this.#refusal, type);
    } else if (type === "response.reasoning_summary_text.done") {
      this.#equal(text("text"), this.#summary, type);
    } else if (type === "response.reasoning_text.done") {
      this.#equal(text("text"), this.#reasoning, type);
    } else if (type === "response.function_call_arguments.done") {
      const tool = this.#tools.get(index("output_index"));
      if (!tool) throw new Error("Responses function-call done event has no matching item");
      this.#equal(text("name"), tool.name, type);
      this.#equal(text("arguments"), tool.arguments, type);
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = event.response;
      {
        const result = normalizeResponsesResult(response);
        const textParts = [...this.#text.entries()].sort(([left], [right]) =>
          left.localeCompare(right, undefined, { numeric: true })
        );
        const streamedText = textParts.map(([, value]) => value).join("");
        this.#equal(result.text, streamedText, "terminal response text");
        this.#equal(result.refusal ?? "", this.#refusal, "terminal response refusal");
        this.#equal(result.reasoning?.summary ?? "", this.#summary, "terminal reasoning summary");
        this.#equal(result.reasoning?.content ?? "", this.#reasoning, "terminal reasoning content");
        let textOffset = 0;
        const textPartOffsets = new Map<string, number>();
        for (const [key, value] of textParts) {
          textPartOffsets.set(key, textOffset);
          textOffset += value.length;
        }
        const streamedAnnotations = this.#annotations.map(({ key, annotation }) => ({
          ...annotation,
          startIndex: annotation.startIndex + (textPartOffsets.get(key) ?? 0),
          endIndex: annotation.endIndex + (textPartOffsets.get(key) ?? 0),
        }));
        if (JSON.stringify(result.annotations ?? []) !== JSON.stringify(streamedAnnotations)) {
          throw new Error("Responses terminal citations conflict with streamed annotations");
        }
        const terminalTools = result.toolCalls.map(({ id, name, arguments: value }) => ({
          id,
          name,
          arguments: value,
        }));
        const streamedTools = [...this.#tools.entries()].sort(([left], [right]) => left - right)
          .map(
            ([, value]) => value,
          );
        if (JSON.stringify(terminalTools) !== JSON.stringify(streamedTools)) {
          throw new Error("Responses terminal function calls conflict with streamed deltas");
        }
      }
    }
  }

  #equal(actual: string, expected: string, context: unknown) {
    if (actual !== expected) throw new Error(`${String(context)} conflicts with streamed deltas`);
  }
}

type ResponsesLifecycleItem = {
  id: string;
  type: string;
  done: boolean;
  valueDone: boolean;
};
type ResponsesLifecyclePart = { type: string; valueDone: boolean; done: boolean };
type ResponsesLifecycleSummaryPart = { valueDone: boolean; done: boolean };

/**
 * Enforces the ordering and identity invariants promised by the Responses SSE protocol before
 * canonical events become visible to the caller. In particular, a malformed prefix must fail
 * while the resilience layer can still retry or select a fallback provider.
 */
class ResponsesStreamLifecycle {
  readonly #items = new Map<number, ResponsesLifecycleItem>();
  readonly #contentParts = new Map<string, ResponsesLifecyclePart>();
  readonly #summaryParts = new Map<string, ResponsesLifecycleSummaryPart>();
  #created = false;
  #terminal = false;
  #responseId?: string;
  #model?: string;

  observe(input: unknown): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const event = input as Record<string, unknown>;
    if (typeof event.type !== "string") return;
    const type = event.type;
    if (this.#terminal) throw new Error("Responses stream sent data after its terminal event");
    if (type !== "response.created" && !this.#created) {
      throw new Error("Responses stream must begin with response.created");
    }
    if (type === "response.created") {
      if (this.#created) throw new Error("Responses stream sent duplicate response.created");
      this.#created = true;
      this.#observeResponseIdentity(event.response, type, true);
      return;
    }
    if (["response.queued", "response.in_progress"].includes(type)) {
      this.#observeResponseIdentity(event.response, type, false);
      return;
    }
    if (
      ["response.completed", "response.incomplete", "response.failed"].includes(type)
    ) {
      this.#observeResponseIdentity(event.response, type, false);
      if (type !== "response.failed") this.#validateTerminalOutput(event.response, type);
      this.#terminal = true;
      return;
    }
    if (type === "error") {
      this.#terminal = true;
      return;
    }
    if (type === "response.output_item.added") {
      const outputIndex = this.#index(event.output_index, "output_index");
      if (this.#items.has(outputIndex)) {
        throw new Error("Responses stream added the same output item twice");
      }
      const item = this.#record(event.item, "item");
      const id = this.#string(item.id, "item.id");
      const itemType = this.#string(item.type, "item.type");
      this.#items.set(outputIndex, { id, type: itemType, done: false, valueDone: false });
      return;
    }
    if (type === "response.output_item.done") {
      const outputIndex = this.#index(event.output_index, "output_index");
      const item = this.#requireItem(outputIndex, event.item_id);
      if (item.done) throw new Error("Responses stream completed the same output item twice");
      this.#requireItemPartsDone(outputIndex, item);
      const doneItem = this.#record(event.item, "item");
      if (doneItem.id !== item.id || doneItem.type !== item.type) {
        throw new Error("Responses output_item.done conflicts with its added item");
      }
      item.done = true;
      return;
    }
    if (type === "response.content_part.added") {
      const outputIndex = this.#index(event.output_index, "output_index");
      const contentIndex = this.#index(event.content_index, "content_index");
      this.#requireItem(outputIndex, event.item_id);
      const part = this.#record(event.part, "part");
      const partType = this.#string(part.type, "part.type");
      const key = this.#contentKey(outputIndex, contentIndex);
      if (this.#contentParts.has(key)) {
        throw new Error("Responses stream added the same content part twice");
      }
      this.#contentParts.set(key, { type: partType, valueDone: false, done: false });
      return;
    }
    if (type === "response.content_part.done") {
      const outputIndex = this.#index(event.output_index, "output_index");
      const contentIndex = this.#index(event.content_index, "content_index");
      const part = this.#requireContentPart(outputIndex, contentIndex, event.item_id);
      if (part.done) throw new Error("Responses stream completed the same content part twice");
      if (!part.valueDone) {
        throw new Error("Responses content_part.done preceded its content done event");
      }
      const donePart = event.part === undefined ? undefined : this.#record(event.part, "part");
      if (donePart && donePart.type !== part.type) {
        throw new Error("Responses content_part.done conflicts with its added content part");
      }
      part.done = true;
      return;
    }
    if (type === "response.reasoning_summary_part.added") {
      const outputIndex = this.#index(event.output_index, "output_index");
      const summaryIndex = this.#index(event.summary_index, "summary_index");
      const item = this.#requireItem(outputIndex, event.item_id);
      if (item.type !== "reasoning") {
        throw new Error("Responses reasoning summary belongs to a non-reasoning item");
      }
      const key = this.#summaryKey(outputIndex, summaryIndex);
      if (this.#summaryParts.has(key)) {
        throw new Error("Responses stream added the same reasoning summary part twice");
      }
      this.#summaryParts.set(key, { valueDone: false, done: false });
      return;
    }
    if (type === "response.reasoning_summary_part.done") {
      const outputIndex = this.#index(event.output_index, "output_index");
      const summaryIndex = this.#index(event.summary_index, "summary_index");
      const part = this.#requireSummaryPart(outputIndex, summaryIndex, event.item_id);
      if (part.done) {
        throw new Error("Responses stream completed the same reasoning summary part twice");
      }
      if (!part.valueDone) {
        throw new Error("Responses reasoning_summary_part.done preceded its text done event");
      }
      part.done = true;
      return;
    }
    if (
      type === "response.output_text.delta" || type === "response.output_text.done" ||
      type === "response.output_text.annotation.added"
    ) {
      const part = this.#requireTypedContentPart(event, "output_text");
      this.#observeContentValueEvent(part, type);
      return;
    }
    if (type === "response.refusal.delta" || type === "response.refusal.done") {
      const part = this.#requireTypedContentPart(event, "refusal");
      this.#observeContentValueEvent(part, type);
      return;
    }
    if (type === "response.reasoning_text.delta" || type === "response.reasoning_text.done") {
      const part = this.#requireTypedContentPart(event, "reasoning_text");
      this.#observeContentValueEvent(part, type);
      return;
    }
    if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_summary_text.done"
    ) {
      const outputIndex = this.#index(event.output_index, "output_index");
      const summaryIndex = this.#index(event.summary_index, "summary_index");
      const part = this.#requireSummaryPart(outputIndex, summaryIndex, event.item_id);
      if (part.valueDone) {
        throw new Error("Responses reasoning summary sent data after its text done event");
      }
      if (type.endsWith(".done")) part.valueDone = true;
      return;
    }
    if (
      type === "response.function_call_arguments.delta" ||
      type === "response.function_call_arguments.done"
    ) {
      const item = this.#requireItem(
        this.#index(event.output_index, "output_index"),
        event.item_id,
      );
      if (item.type !== "function_call") {
        throw new Error("Responses function-call arguments belong to a non-function item");
      }
      if (item.valueDone) {
        throw new Error("Responses function call sent data after its arguments done event");
      }
      if (type.endsWith(".done")) item.valueDone = true;
    }
  }

  #validateTerminalOutput(value: unknown, eventType: string): void {
    const response = this.#record(value, `${eventType}.response`);
    if (!Array.isArray(response.output)) {
      throw new Error(`Responses ${eventType}.response.output is invalid`);
    }
    if (response.output.length !== this.#items.size) {
      throw new Error("Responses terminal output does not match its streamed output items");
    }
    for (const [outputIndex, rawItem] of response.output.entries()) {
      const streamed = this.#items.get(outputIndex);
      if (!streamed || !streamed.done) {
        throw new Error("Responses terminal event preceded output_item.done");
      }
      const terminal = this.#record(rawItem, `${eventType}.response.output[${outputIndex}]`);
      if (terminal.id !== streamed.id || terminal.type !== streamed.type) {
        throw new Error("Responses terminal output item conflicts with its streamed identity");
      }
    }
  }

  #requireItemPartsDone(outputIndex: number, item: ResponsesLifecycleItem): void {
    for (const [key, part] of this.#contentParts) {
      if (key.startsWith(`${outputIndex}:`) && !part.done) {
        throw new Error("Responses output_item.done preceded content_part.done");
      }
    }
    for (const [key, part] of this.#summaryParts) {
      if (key.startsWith(`${outputIndex}:`) && !part.done) {
        throw new Error("Responses output_item.done preceded reasoning_summary_part.done");
      }
    }
    if (item.type === "function_call" && !item.valueDone) {
      throw new Error("Responses output_item.done preceded function_call_arguments.done");
    }
  }

  #observeContentValueEvent(part: ResponsesLifecyclePart, type: string): void {
    if (part.valueDone) throw new Error(`Responses ${type} followed its content done event`);
    if (type.endsWith(".done")) part.valueDone = true;
  }

  #observeResponseIdentity(
    value: unknown,
    eventType: string,
    initialize: boolean,
  ): void {
    const response = this.#record(value, `${eventType}.response`);
    const id = this.#string(response.id, `${eventType}.response.id`);
    const model = response.model === undefined
      ? undefined
      : this.#string(response.model, `${eventType}.response.model`);
    if (initialize) {
      this.#responseId = id;
      this.#model = model;
      return;
    }
    if (id !== this.#responseId) throw new Error("Responses stream changed response id");
    if (model !== undefined && this.#model !== undefined && model !== this.#model) {
      throw new Error("Responses stream changed response model");
    }
    if (this.#model === undefined) this.#model = model;
  }

  #requireTypedContentPart(
    event: Record<string, unknown>,
    expectedType: string,
  ): ResponsesLifecyclePart {
    const outputIndex = this.#index(event.output_index, "output_index");
    const contentIndex = this.#index(event.content_index, "content_index");
    const part = this.#requireContentPart(outputIndex, contentIndex, event.item_id);
    if (part.type !== expectedType) {
      throw new Error(`Responses ${event.type} conflicts with its added content part`);
    }
    return part;
  }

  #requireContentPart(
    outputIndex: number,
    contentIndex: number,
    itemId: unknown,
  ): ResponsesLifecyclePart {
    this.#requireItem(outputIndex, itemId);
    const part = this.#contentParts.get(this.#contentKey(outputIndex, contentIndex));
    if (!part) throw new Error("Responses content event preceded content_part.added");
    return part;
  }

  #requireSummaryPart(
    outputIndex: number,
    summaryIndex: number,
    itemId: unknown,
  ): ResponsesLifecycleSummaryPart {
    const item = this.#requireItem(outputIndex, itemId);
    if (item.type !== "reasoning") {
      throw new Error("Responses reasoning summary belongs to a non-reasoning item");
    }
    const part = this.#summaryParts.get(this.#summaryKey(outputIndex, summaryIndex));
    if (!part) {
      throw new Error("Responses reasoning event preceded reasoning_summary_part.added");
    }
    return part;
  }

  #requireItem(outputIndex: number, itemId: unknown): ResponsesLifecycleItem {
    const item = this.#items.get(outputIndex);
    if (!item) throw new Error("Responses item event preceded output_item.added");
    if (itemId !== undefined && this.#string(itemId, "item_id") !== item.id) {
      throw new Error("Responses item identity changed during the stream");
    }
    return item;
  }

  #record(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Responses ${field} is invalid`);
    }
    return value as Record<string, unknown>;
  }

  #string(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Responses ${field} is invalid`);
    }
    return value;
  }

  #index(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`Responses ${field} is invalid`);
    }
    return Number(value);
  }

  #contentKey(outputIndex: number, contentIndex: number): string {
    return `${outputIndex}:${contentIndex}`;
  }

  #summaryKey(outputIndex: number, summaryIndex: number): string {
    return `${outputIndex}:${summaryIndex}`;
  }
}

export interface ResponsesUpstreamOptions extends UpstreamStreamOptions {
  protocol?: "responses";
  /** Responses-only fields preserved by the public Responses compatibility route. */
  requestFields?: NativeResponsesRequestFields;
}

export interface NativeResponsesRequestFields {
  store?: boolean;
  metadata?: Record<string, unknown>;
  /** Validated stateless Responses input items preserved for a native Responses provider. */
  input?: unknown;
  /** The original request contains Responses items that cannot pass through Chat Completions. */
  requiresNativeInput?: boolean;
}

export interface ResponsesChatCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  upstream: Record<string, unknown>;
}

function providerTimeoutMs(override?: number): number {
  const value = override ?? Number(Deno.env.get("OPENAI_TIMEOUT_MS") ?? 120_000);
  if (!Number.isSafeInteger(value) || value < 100 || value > 600_000) {
    throw new Error("OPENAI_TIMEOUT_MS must be an integer between 100 and 600000");
  }
  return value;
}

function responsesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || isSpecialUseIp(host);
  const testHost = Deno.env.get("DENO_ENV") === "test" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === host;
  if (
    url.protocol !== "https:" &&
    !(Deno.env.get("DENO_ENV") !== "production" && (privateHost || testHost))
  ) throw new Error("Provider URL must use HTTPS");
  if (Deno.env.get("DENO_ENV") === "production" && privateHost) {
    throw new Error("Provider URL may not target a private network");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Provider URL must not contain credentials, a query, or a fragment");
  }
  return `${url.toString().replace(/\/$/, "")}/responses`;
}

function responseFetch(endpoint: string, options: ResponsesUpstreamOptions): typeof fetch {
  if (options.fetch) return options.fetch;
  const url = new URL(endpoint);
  const testHttp = Deno.env.get("DENO_ENV") === "test" && url.protocol === "http:" &&
    Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST")?.toLowerCase() === url.hostname.toLowerCase();
  return testHttp ? fetch : pinnedProviderFetch;
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

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error("Provider response exceeded the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Provider response exceeded the size limit");
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function providerErrorPayload(payload: string): { message: string; code?: string } | undefined {
  try {
    const body = JSON.parse(payload) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const error = (body as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
    const fields = error as Record<string, unknown>;
    if (typeof fields.message !== "string" || fields.message.length > 500) return undefined;
    const code = typeof fields.code === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(fields.code)
      ? fields.code
      : undefined;
    return { message: code ? `${fields.message} (${code})` : fields.message, code };
  } catch {
    return undefined;
  }
}

async function requireSuccessfulResponse(
  response: Response,
  expectedContentType: "application/json" | "text/event-stream",
  bodyLimit: number,
): Promise<string | undefined> {
  if (!response.ok) {
    const payload = await readBoundedBody(response, Math.min(bodyLimit, MAX_ERROR_BODY_BYTES));
    const providerError = providerErrorPayload(payload);
    const category = response.status === 429
      ? "rate_limited"
      : response.status >= 400 && response.status < 500
      ? response.status === 401 || response.status === 403 ? "authentication" : "invalid_request"
      : "upstream_unavailable";
    throw new ProviderAttemptError(
      providerError?.message ?? `Provider returned ${response.status}`,
      {
        status: response.status,
        category,
        transient: response.status === 429 || response.status >= 500,
        retryAfterMs: retryAfterMs(response.headers),
        code: providerError?.code,
      },
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith(expectedContentType)) {
    await response.body?.cancel();
    throw new ProviderAttemptError(
      `Provider returned an unexpected content type for a ${
        expectedContentType === "text/event-stream" ? "streaming" : "buffered"
      } request`,
      { category: "invalid_response", transient: true },
    );
  }
  if (expectedContentType === "application/json") return await readBoundedBody(response, bodyLimit);
  if (!response.body) {
    throw new ProviderAttemptError("Provider returned an empty event stream", {
      category: "invalid_response",
      transient: true,
    });
  }
  return undefined;
}

function outputLimit(request: ChatCompletionRequest): number {
  return request.max_completion_tokens ?? request.max_tokens ?? 4_096;
}

function requestInputBound(request: ChatCompletionRequest): number {
  return Math.max(1, encoder.encode(JSON.stringify(request)).byteLength);
}

function visibleResultBytes(result: CanonicalResult): number {
  return encoder.encode([
    result.text,
    result.refusal ?? "",
    result.reasoning?.content ?? "",
    result.reasoning?.summary ?? "",
    ...result.toolCalls.map((call) => `${call.name}${call.arguments}`),
  ].join("")).byteLength;
}

function visibleOutputByteLimit(request: ChatCompletionRequest, responseLimit: number): number {
  return Math.min(responseLimit, outputLimit(request) * MAX_VISIBLE_BYTES_PER_OUTPUT_TOKEN);
}

function validateUsageBounds(
  result: CanonicalResult,
  request: ChatCompletionRequest,
  responseLimit: number,
): void {
  if (visibleResultBytes(result) > visibleOutputByteLimit(request, responseLimit)) {
    throw new Error("Provider output exceeds the requested output bound");
  }
  if (!result.usage) return;
  if (result.usage.inputTokens > requestInputBound(request)) {
    throw new Error("Upstream input token usage exceeds the reserved request bound");
  }
  if (result.usage.outputTokens > outputLimit(request)) {
    throw new Error("Upstream output token usage exceeds the requested output bound");
  }
}

function finishReason(state: CanonicalResult["finishState"]): string {
  switch (state) {
    case "stop":
      return "stop";
    case "length":
    case "incomplete":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      throw new Error(`Provider returned a non-terminal Responses status (${state})`);
  }
}

function chatUsage(result: CanonicalResult): Record<string, unknown> | undefined {
  if (!result.usage) return undefined;
  return {
    prompt_tokens: result.usage.inputTokens,
    completion_tokens: result.usage.outputTokens,
    total_tokens: result.usage.totalTokens,
    prompt_tokens_details: { cached_tokens: result.usage.cachedInputTokens },
    completion_tokens_details: { reasoning_tokens: result.usage.reasoningTokens },
  };
}

function responsesFailure(code: string, message: string): ProviderAttemptError {
  const authentication = new Set([
    "authentication_error",
    "invalid_api_key",
    "invalid_authentication",
  ]).has(code);
  const transient = new Set([
    "rate_limit_exceeded",
    "server_error",
    "overloaded",
    "timeout",
    "temporarily_unavailable",
    "vector_store_timeout",
  ]).has(code);
  const category = authentication
    ? "authentication"
    : code === "rate_limit_exceeded"
    ? "rate_limited"
    : code === "timeout" || code === "vector_store_timeout"
    ? "timeout"
    : transient
    ? "upstream_unavailable"
    : "invalid_response";
  const status = authentication
    ? 401
    : code === "rate_limit_exceeded"
    ? 429
    : new Set(["invalid_prompt", "invalid_request_error"]).has(code)
    ? 400
    : undefined;
  return new ProviderAttemptError(`${message} (${code})`, { category, transient, code, status });
}

/** Rebuild a Responses result as a strict Chat Completion for the gateway's canonical boundary. */
export function responsesResultToChatCompletion(result: CanonicalResult): Record<string, unknown> {
  if (result.error) {
    throw responsesFailure(result.error.code, result.error.message);
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text || result.toolCalls.length || result.refusal ? result.text || null : "",
  };
  if (result.refusal) message.refusal = result.refusal;
  if (result.reasoning?.content) message.reasoning_content = result.reasoning.content;
  if (result.reasoning?.summary) message.reasoning_summary = result.reasoning.summary;
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (result.annotations?.length) {
    message.annotations = result.annotations.map((citation) => ({
      type: "url_citation",
      url_citation: {
        start_index: citation.startIndex,
        end_index: citation.endIndex,
        title: citation.title,
        url: citation.url,
      },
    }));
  }
  return {
    id: result.id,
    object: "chat.completion",
    created: result.createdAt ?? Math.floor(Date.now() / 1_000),
    model: result.model,
    choices: [{ index: 0, message, finish_reason: finishReason(result.finishState) }],
    ...(chatUsage(result) ? { usage: chatUsage(result) } : {}),
  };
}

function responseRequest(
  request: ChatCompletionRequest,
  upstreamModel: string,
  stream: boolean,
  customParams: Readonly<Record<string, unknown>> = {},
  requestFields: NativeResponsesRequestFields = {},
): Record<string, unknown> {
  try {
    const withDefaults = { ...customParams, ...request };
    const translated = {
      ...chatCompletionsRequestToResponses(withDefaults),
      model: upstreamModel,
      stream,
    };
    return {
      ...translated,
      ...(requestFields.input === undefined ? {} : { input: structuredClone(requestFields.input) }),
      ...(requestFields.store === undefined ? {} : { store: requestFields.store }),
      ...(requestFields.metadata === undefined
        ? {}
        : { metadata: structuredClone(requestFields.metadata) }),
    };
  } catch (error) {
    if (error instanceof ProviderProtocolError) {
      throw new ProviderAttemptError(error.message, {
        category: "invalid_request",
        transient: false,
        candidateLocal: true,
      });
    }
    throw error;
  }
}

export async function completeResponsesChat(
  request: ChatCompletionRequest,
  signal: AbortSignal,
  options: ResponsesUpstreamOptions = {},
): Promise<ResponsesChatCompletion> {
  try {
    signal.throwIfAborted();
    const baseUrl = options.baseUrl ?? Deno.env.get("OPENAI_BASE_URL");
    const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY");
    if (!baseUrl || !apiKey) {
      throw new ProviderAttemptError("The OpenAI-compatible provider is not configured", {
        category: "invalid_request",
        transient: false,
      });
    }
    const upstreamModel = options.upstreamModel ?? request.model;
    const endpoint = responsesEndpoint(baseUrl);
    const combinedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(providerTimeoutMs(options.timeoutMs)),
    ]);
    const response = await responseFetch(endpoint, options)(endpoint, {
      method: "POST",
      signal: combinedSignal,
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        responseRequest(
          request,
          upstreamModel,
          false,
          options.customParams,
          options.requestFields,
        ),
      ),
    });
    const body = await requireSuccessfulResponse(
      response,
      "application/json",
      providerResponseByteLimit(options.maxResponseBytes),
    );
    let payload: unknown;
    try {
      payload = JSON.parse(body!);
    } catch {
      throw new Error("Provider returned malformed JSON");
    }
    const result = normalizeResponsesResult(payload);
    const maxResponseBytes = providerResponseByteLimit(options.maxResponseBytes);
    validateUsageBounds(result, request, maxResponseBytes);
    const upstream = responsesResultToChatCompletion(result);
    const fallbackInput = Math.max(1, Math.ceil(JSON.stringify(request.messages).length / 4));
    const estimatedOutput = Math.min(
      outputLimit(request),
      Math.ceil(visibleResultBytes(result) / 4),
    );
    return {
      text: result.text,
      inputTokens: result.usage?.inputTokens ?? fallbackInput,
      outputTokens: result.usage?.outputTokens ?? estimatedOutput,
      ...(result.usage ? { cachedInputTokens: result.usage.cachedInputTokens } : {}),
      ...(result.usage ? { reasoningTokens: result.usage.reasoningTokens } : {}),
      upstream,
    };
  } catch (error) {
    if (
      !signal.aborted && error instanceof DOMException &&
      ["AbortError", "TimeoutError"].includes(error.name)
    ) {
      throw new ProviderAttemptError("Provider request timed out", {
        category: "timeout",
        status: 504,
        transient: true,
        code: "timeout",
      });
    }
    if (
      signal.aborted || error instanceof ProviderAttemptError ||
      (error instanceof TypeError && !(error instanceof ProviderProtocolError))
    ) throw error;
    throw new ProviderAttemptError(
      error instanceof Error ? error.message : "Provider returned an invalid Responses result",
      { category: "invalid_response", transient: true },
    );
  }
}

async function* parseResponsesEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes: number,
): AsyncGenerator<CanonicalStreamEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineBytes: number[] = [];
  let pendingCarriageReturn = false;
  let dataLines: string[] = [];
  let dataBytes = 0;
  let received = 0;
  let terminal = false;
  const consistency = new ResponsesStreamConsistency();
  const lifecycle = new ResponsesStreamLifecycle();
  const abortReader = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abortReader, { once: true });
  const dispatch = () => {
    if (!dataLines.length) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    dataBytes = 0;
    let value: unknown = data;
    if (data !== "[DONE]") {
      try {
        value = JSON.parse(data);
      } catch {
        throw new Error("Upstream sent malformed JSON in its Responses event stream");
      }
    }
    lifecycle.observe(value);
    const events = normalizeResponsesStreamEvent(value);
    consistency.validate(value);
    consistency.observe(events);
    return { events, doneMarker: data === "[DONE]" };
  };
  const processLine = (line: string): CanonicalStreamEvent[] | undefined => {
    if (line === "") {
      const frame = dispatch();
      if (!frame) return;
      if (frame.doneMarker) {
        throw new Error("Responses stream sent [DONE] before an official terminal event");
      }
      terminal = frame.events.some((event) => event.type === "done");
      return frame.events;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (field === "data") {
      dataLines.push(fieldValue);
      dataBytes += encoder.encode(fieldValue).byteLength + (dataLines.length > 1 ? 1 : 0);
      if (dataBytes > MAX_SSE_LINE_BYTES) {
        throw new Error("Upstream Responses event exceeded the size limit");
      }
    }
  };
  const completeLine = () => {
    const line = decoder.decode(Uint8Array.from(lineBytes));
    lineBytes = [];
    return processLine(line);
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      received += value?.byteLength ?? 0;
      if (received > maxBytes) throw new Error("Provider response exceeded the size limit");
      for (const byte of value ?? []) {
        if (pendingCarriageReturn) {
          const events = completeLine();
          if (events) yield events;
          if (terminal) return;
          pendingCarriageReturn = false;
          if (byte === 10) continue;
        }
        if (byte === 13) {
          pendingCarriageReturn = true;
        } else if (byte === 10) {
          const events = completeLine();
          if (events) yield events;
          if (terminal) return;
        } else {
          lineBytes.push(byte);
          if (lineBytes.length > MAX_SSE_LINE_BYTES) {
            throw new Error("Upstream Responses event stream line exceeded the size limit");
          }
        }
      }
      if (!done) continue;
      if (pendingCarriageReturn) {
        const events = completeLine();
        if (events) yield events;
        if (terminal) return;
        pendingCarriageReturn = false;
      } else if (lineBytes.length) {
        const events = completeLine();
        if (events) yield events;
        if (terminal) return;
      }
      // Dispatch a complete pending event at EOF even if the producer omitted the customary
      // trailing blank line. The normal JSON parser still rejects a genuinely truncated payload.
      if (dataLines.length) {
        const events = processLine("");
        if (events) yield events;
        if (terminal) return;
      }
      break;
    }
    if (dataLines.length) throw new Error("Upstream Responses event stream ended mid-frame");
    if (!terminal) {
      throw new Error("Upstream Responses event stream ended without a terminal event");
    }
  } finally {
    signal.removeEventListener("abort", abortReader);
    await reader.cancel(signal.aborted ? signal.reason : undefined).catch(() => undefined);
    reader.releaseLock();
  }
}

function streamChunk(
  event: CanonicalStreamEvent,
  state: {
    id: string;
    model: string;
    started: boolean;
    sawToolCall: boolean;
    toolIndexes: Map<number, number>;
    textPartOffsets: Map<string, number>;
    textLength: number;
    created: number;
  },
): string | undefined {
  if (event.type === "started") {
    state.id = event.id;
    if (event.model) state.model = event.model;
    state.started = true;
    state.created = Math.floor(Date.now() / 1_000);
    return JSON.stringify({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [],
    });
  }
  if (event.type === "error") {
    throw responsesFailure(event.code, event.message);
  }
  if (event.type === "done") return "[DONE]";
  if (!state.started) throw new Error("Responses stream emitted output before response.created");
  const base = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
  };
  if (event.type === "usage") {
    return JSON.stringify({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: event.usage.inputTokens,
        completion_tokens: event.usage.outputTokens,
        total_tokens: event.usage.totalTokens,
        prompt_tokens_details: { cached_tokens: event.usage.cachedInputTokens },
        completion_tokens_details: { reasoning_tokens: event.usage.reasoningTokens },
      },
    });
  }
  const delta: Record<string, unknown> = {};
  let finish_reason: string | null = null;
  if (event.type === "role") delta.role = event.role;
  if (event.type === "text_delta") {
    const key = `${event.outputIndex ?? 0}:${event.contentIndex ?? 0}`;
    if (!state.textPartOffsets.has(key)) state.textPartOffsets.set(key, state.textLength);
    state.textLength += event.text.length;
    delta.content = event.text;
  }
  if (event.type === "refusal_delta") delta.refusal = event.text;
  if (event.type === "reasoning_delta") {
    delta[event.summary ? "reasoning_summary" : "reasoning_content"] = event.text;
  }
  if (event.type === "annotation") {
    const key = `${event.outputIndex ?? 0}:${event.contentIndex ?? 0}`;
    const offset = state.textPartOffsets.get(key) ?? state.textLength;
    state.textPartOffsets.set(key, offset);
    delta.annotations = [{
      type: "url_citation",
      url_citation: {
        start_index: event.annotation.startIndex + offset,
        end_index: event.annotation.endIndex + offset,
        title: event.annotation.title,
        url: event.annotation.url,
      },
    }];
  }
  if (event.type === "tool_call_delta") {
    state.sawToolCall = true;
    let index = state.toolIndexes.get(event.index);
    if (index === undefined) {
      index = state.toolIndexes.size;
      state.toolIndexes.set(event.index, index);
    }
    delta.tool_calls = [{
      index,
      ...(event.id === undefined ? {} : { id: event.id }),
      type: "function",
      function: {
        ...(event.name === undefined ? {} : { name: event.name }),
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
      },
    }];
  }
  if (event.type === "finish") {
    finish_reason = finishReason(
      event.state === "stop" && state.sawToolCall ? "tool_calls" : event.state,
    );
  }
  return JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] });
}

/** Open a native Responses stream and expose strict Chat chunks to the gateway core. */
export async function* streamResponsesChat(
  request: ChatCompletionRequest,
  signal: AbortSignal,
  options: ResponsesUpstreamOptions = {},
): AsyncGenerator<string> {
  try {
    signal.throwIfAborted();
    const baseUrl = options.baseUrl ?? Deno.env.get("OPENAI_BASE_URL");
    const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY");
    if (!baseUrl || !apiKey) {
      throw new ProviderAttemptError("The OpenAI-compatible provider is not configured", {
        category: "invalid_request",
        transient: false,
      });
    }
    const upstreamModel = options.upstreamModel ?? request.model;
    const endpoint = responsesEndpoint(baseUrl);
    const combinedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(providerTimeoutMs(options.timeoutMs)),
    ]);
    const response = await responseFetch(endpoint, options)(endpoint, {
      method: "POST",
      signal: combinedSignal,
      redirect: "error",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        responseRequest(
          request,
          upstreamModel,
          true,
          options.customParams,
          options.requestFields,
        ),
      ),
    });
    await requireSuccessfulResponse(
      response,
      "text/event-stream",
      providerResponseByteLimit(options.maxResponseBytes),
    );
    const state = {
      id: "",
      model: upstreamModel,
      started: false,
      sawToolCall: false,
      toolIndexes: new Map<number, number>(),
      textPartOffsets: new Map<string, number>(),
      textLength: 0,
      created: 0,
    };
    let visibleBytes = 0;
    for await (
      const events of parseResponsesEvents(
        response.body!,
        combinedSignal,
        providerResponseByteLimit(options.maxResponseBytes),
      )
    ) {
      for (const event of events) {
        if (
          event.type === "text_delta" || event.type === "refusal_delta" ||
          event.type === "reasoning_delta"
        ) visibleBytes += encoder.encode(event.text).byteLength;
        if (event.type === "tool_call_delta") {
          visibleBytes += encoder.encode(`${event.name ?? ""}${event.arguments ?? ""}`).byteLength;
        }
        if (event.type === "usage") {
          if (event.usage.inputTokens > requestInputBound(request)) {
            throw new Error("Upstream input token usage exceeds the reserved request bound");
          }
          if (event.usage.outputTokens > outputLimit(request)) {
            throw new Error("Upstream output token usage exceeds the requested output bound");
          }
        }
        if (
          visibleBytes > visibleOutputByteLimit(
            request,
            providerResponseByteLimit(options.maxResponseBytes),
          )
        ) {
          throw new Error("Provider output exceeds the requested output bound");
        }
        const chunk = streamChunk(event, state);
        if (chunk !== undefined) yield chunk;
      }
    }
  } catch (error) {
    if (
      !signal.aborted && error instanceof DOMException &&
      ["AbortError", "TimeoutError"].includes(error.name)
    ) {
      throw new ProviderAttemptError("Provider request timed out", {
        category: "timeout",
        status: 504,
        transient: true,
        code: "timeout",
      });
    }
    if (
      signal.aborted || error instanceof ProviderAttemptError ||
      (error instanceof TypeError && !(error instanceof ProviderProtocolError))
    ) throw error;
    throw new ProviderAttemptError(
      error instanceof Error ? error.message : "Provider returned an invalid Responses stream",
      { category: "invalid_response", transient: true },
    );
  }
}
