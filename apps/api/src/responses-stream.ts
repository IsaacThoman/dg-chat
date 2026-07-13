import {
  type CanonicalResult,
  type CanonicalStreamEvent,
  type CanonicalUrlCitation,
  type CanonicalUsage,
  normalizeChatStreamChunk,
  ProviderProtocolError,
  ResponseCitationBudget,
} from "./provider-protocol.ts";
import { type ResponseRequestEcho, responseRequestFields } from "./responses.ts";

type OutputState = ReasoningState | MessageState | ToolState;

interface BaseState {
  id: string;
  index: number;
  added: boolean;
}

interface ReasoningState extends BaseState {
  type: "reasoning";
  summary: string;
  content: string;
  summaryAdded: boolean;
  contentAdded: boolean;
}

interface MessageState extends BaseState {
  type: "message";
  text: string;
  refusal: string;
  annotations: CanonicalUrlCitation[];
  textAdded: boolean;
  refusalAdded: boolean;
  textIndex?: number;
  refusalIndex?: number;
}

interface ToolState extends BaseState {
  type: "function_call";
  callId: string;
  name: string;
  arguments: string;
}

export interface ResponsesStreamSnapshot {
  response: Record<string, unknown>;
  terminalEvents: Record<string, unknown>[];
  usage?: CanonicalUsage;
  visibleBytes: number;
  sawDone: boolean;
}

const encoder = new TextEncoder();

/**
 * Projects the gateway's canonical Chat stream into one stateful OpenAI Responses stream.
 * Item IDs and output indexes are owned here so live events and the terminal response agree.
 */
export class ResponsesStreamProjector {
  readonly #responseId: string;
  readonly #messageId: string;
  readonly #model: string;
  readonly #createdAt: number;
  readonly #request: ResponseRequestEcho;
  readonly #outputs: OutputState[] = [];
  readonly #tools = new Map<number, ToolState>();
  #reasoning?: ReasoningState;
  #message?: MessageState;
  #usage?: CanonicalUsage;
  #finishState: CanonicalResult["finishState"] = "unknown";
  #visibleBytes = 0;
  readonly #citationBudget = new ResponseCitationBudget();
  #sawDone = false;

  constructor(input: {
    responseId: string;
    messageId: string;
    model: string;
    createdAt: number;
    request?: ResponseRequestEcho;
  }) {
    this.#responseId = input.responseId;
    this.#messageId = input.messageId;
    this.#model = input.model;
    this.#createdAt = input.createdAt;
    this.#request = input.request ?? {};
  }

  get usage(): CanonicalUsage | undefined {
    return this.#usage && { ...this.#usage };
  }

  get visibleBytes(): number {
    return this.#visibleBytes;
  }

  get sawDone(): boolean {
    return this.#sawDone;
  }

  createdEvent(): Record<string, unknown> {
    return { type: "response.created", response: this.#response("in_progress", []) };
  }

  inProgressEvent(): Record<string, unknown> {
    return { type: "response.in_progress", response: this.#response("in_progress", []) };
  }

  push(data: string): Record<string, unknown>[] {
    const input: unknown = data === "[DONE]" ? data : JSON.parse(data);
    const outward: Record<string, unknown>[] = [];
    for (const event of normalizeChatStreamChunk(input)) this.#consume(event, outward);
    return outward;
  }

  finish(usage?: CanonicalUsage): ResponsesStreamSnapshot {
    if (!this.#sawDone) throw new Error("Provider stream ended without a terminal marker");
    if (this.#finishState === "unknown") {
      throw new Error("Provider stream ended without a valid finish state");
    }
    if (usage) this.#usage = { ...usage };
    const terminalEvents: Record<string, unknown>[] = [];
    const incomplete = this.#finishState !== "stop" && this.#finishState !== "tool_calls";
    const itemStatus = incomplete ? "incomplete" : "completed";
    for (const output of this.#outputs) {
      if (output.type === "reasoning") this.#finishReasoning(output, terminalEvents, itemStatus);
      else if (output.type === "message") this.#finishMessage(output, terminalEvents, itemStatus);
      else this.#finishTool(output, terminalEvents, itemStatus);
    }
    const response = this.#response(
      incomplete ? "incomplete" : "completed",
      this.#outputs
        .filter((output) => output.type !== "function_call" || output.added)
        .map((output) => this.#item(output, itemStatus)),
    );
    terminalEvents.push({
      type: incomplete ? "response.incomplete" : "response.completed",
      response,
    });
    return {
      response,
      terminalEvents,
      usage: this.usage,
      visibleBytes: this.#visibleBytes,
      sawDone: this.#sawDone,
    };
  }

  #consume(event: CanonicalStreamEvent, outward: Record<string, unknown>[]) {
    if (event.type === "started" || event.type === "role") return;
    if (event.type === "done") {
      this.#sawDone = true;
      return;
    }
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "usage") {
      this.#usage = { ...event.usage };
      return;
    }
    if (event.type === "finish") {
      this.#finishState = event.state;
      return;
    }
    if (event.type === "text_delta") {
      const message = this.#ensureMessage(outward);
      this.#ensureTextPart(message, outward);
      message.text += event.text;
      this.#observe(event.text);
      outward.push({
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: message.index,
        content_index: message.textIndex,
        delta: event.text,
        logprobs: [],
      });
      return;
    }
    if (event.type === "annotation") {
      const message = this.#ensureMessage(outward);
      this.#ensureTextPart(message, outward);
      if (event.annotation.endIndex > message.text.length) {
        throw new ProviderProtocolError(
          "malformed_payload",
          "Provider citation range exceeds accumulated output text",
          "response.annotations",
        );
      }
      this.#citationBudget.add(event.annotation);
      message.annotations.push({ ...event.annotation });
      outward.push({
        type: "response.output_text.annotation.added",
        item_id: message.id,
        output_index: message.index,
        content_index: message.textIndex,
        annotation_index: message.annotations.length - 1,
        annotation: this.#annotation(event.annotation),
      });
      return;
    }
    if (event.type === "refusal_delta") {
      const message = this.#ensureMessage(outward);
      this.#ensureRefusalPart(message, outward);
      message.refusal += event.text;
      this.#observe(event.text);
      outward.push({
        type: "response.refusal.delta",
        item_id: message.id,
        output_index: message.index,
        content_index: message.refusalIndex,
        delta: event.text,
      });
      return;
    }
    if (event.type === "reasoning_delta") {
      const reasoning = this.#ensureReasoning(outward);
      const summary = event.summary;
      this.#ensureReasoningPart(reasoning, summary, outward);
      if (summary) reasoning.summary += event.text;
      else reasoning.content += event.text;
      this.#observe(event.text);
      outward.push({
        type: summary ? "response.reasoning_summary_text.delta" : "response.reasoning_text.delta",
        item_id: reasoning.id,
        output_index: reasoning.index,
        ...(summary ? { summary_index: 0 } : { content_index: 0 }),
        delta: event.text,
      });
      return;
    }
    const tool = this.#tools.get(event.index) ?? this.#newTool(event.index);
    if (event.id) tool.callId = event.id;
    if (event.name) tool.name = event.name;
    const delta = event.arguments ?? "";
    tool.arguments += delta;
    this.#observe(`${event.name ?? ""}${delta}`);
    const wasAdded = tool.added;
    if (!tool.added && tool.name && tool.callId) this.#addTool(tool, outward);
    if (wasAdded && delta) {
      outward.push({
        type: "response.function_call_arguments.delta",
        item_id: tool.id,
        output_index: tool.index,
        delta,
      });
    }
  }

  #newTool(sourceIndex: number): ToolState {
    const tool: ToolState = {
      type: "function_call",
      id: `fc_${crypto.randomUUID()}`,
      index: this.#outputs.length,
      added: false,
      callId: "",
      name: "",
      arguments: "",
    };
    this.#tools.set(sourceIndex, tool);
    this.#outputs.push(tool);
    return tool;
  }

  #ensureReasoning(outward: Record<string, unknown>[]): ReasoningState {
    if (!this.#reasoning) {
      this.#reasoning = {
        type: "reasoning",
        id: `rs_${crypto.randomUUID()}`,
        index: this.#outputs.length,
        added: true,
        summary: "",
        content: "",
        summaryAdded: false,
        contentAdded: false,
      };
      this.#outputs.push(this.#reasoning);
      outward.push({
        type: "response.output_item.added",
        output_index: this.#reasoning.index,
        item: this.#item(this.#reasoning, "in_progress"),
      });
    }
    return this.#reasoning;
  }

  #ensureMessage(outward: Record<string, unknown>[]): MessageState {
    if (!this.#message) {
      this.#message = {
        type: "message",
        id: this.#messageId,
        index: this.#outputs.length,
        added: true,
        text: "",
        refusal: "",
        annotations: [],
        textAdded: false,
        refusalAdded: false,
      };
      this.#outputs.push(this.#message);
      outward.push({
        type: "response.output_item.added",
        output_index: this.#message.index,
        item: this.#item(this.#message, "in_progress"),
      });
    }
    return this.#message;
  }

  #ensureTextPart(message: MessageState, outward: Record<string, unknown>[]) {
    if (message.textAdded) return;
    message.textAdded = true;
    message.textIndex = Number(message.refusalAdded);
    outward.push({
      type: "response.content_part.added",
      item_id: message.id,
      output_index: message.index,
      content_index: message.textIndex,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  #ensureRefusalPart(message: MessageState, outward: Record<string, unknown>[]) {
    if (message.refusalAdded) return;
    message.refusalAdded = true;
    message.refusalIndex = Number(message.textAdded);
    outward.push({
      type: "response.content_part.added",
      item_id: message.id,
      output_index: message.index,
      content_index: message.refusalIndex,
      part: { type: "refusal", refusal: "" },
    });
  }

  #ensureReasoningPart(
    reasoning: ReasoningState,
    summary: boolean,
    outward: Record<string, unknown>[],
  ) {
    if (summary ? reasoning.summaryAdded : reasoning.contentAdded) return;
    if (summary) reasoning.summaryAdded = true;
    else reasoning.contentAdded = true;
    outward.push(
      summary
        ? {
          type: "response.reasoning_summary_part.added",
          item_id: reasoning.id,
          output_index: reasoning.index,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }
        : {
          type: "response.content_part.added",
          item_id: reasoning.id,
          output_index: reasoning.index,
          content_index: 0,
          part: { type: "reasoning_text", text: "" },
        },
    );
  }

  #addTool(tool: ToolState, outward: Record<string, unknown>[]) {
    tool.added = true;
    outward.push({
      type: "response.output_item.added",
      output_index: tool.index,
      item: this.#item(tool, "in_progress"),
    });
    if (tool.arguments) {
      outward.push({
        type: "response.function_call_arguments.delta",
        item_id: tool.id,
        output_index: tool.index,
        delta: tool.arguments,
      });
    }
  }

  #finishMessage(
    message: MessageState,
    outward: Record<string, unknown>[],
    status: "completed" | "incomplete",
  ) {
    if (message.textAdded) {
      const part = this.#textPart(message);
      outward.push({
        type: "response.output_text.done",
        item_id: message.id,
        output_index: message.index,
        content_index: message.textIndex,
        text: message.text,
        logprobs: [],
      }, {
        type: "response.content_part.done",
        item_id: message.id,
        output_index: message.index,
        content_index: message.textIndex,
        part,
      });
    }
    if (message.refusalAdded) {
      const contentIndex = message.refusalIndex!;
      const part = { type: "refusal", refusal: message.refusal };
      outward.push({
        type: "response.refusal.done",
        item_id: message.id,
        output_index: message.index,
        content_index: contentIndex,
        refusal: message.refusal,
      }, {
        type: "response.content_part.done",
        item_id: message.id,
        output_index: message.index,
        content_index: contentIndex,
        part,
      });
    }
    outward.push({
      type: "response.output_item.done",
      output_index: message.index,
      item: this.#item(message, status),
    });
  }

  #finishReasoning(
    reasoning: ReasoningState,
    outward: Record<string, unknown>[],
    status: "completed" | "incomplete",
  ) {
    if (reasoning.summaryAdded) {
      const part = { type: "summary_text", text: reasoning.summary };
      outward.push({
        type: "response.reasoning_summary_text.done",
        item_id: reasoning.id,
        output_index: reasoning.index,
        summary_index: 0,
        text: reasoning.summary,
      }, {
        type: "response.reasoning_summary_part.done",
        item_id: reasoning.id,
        output_index: reasoning.index,
        summary_index: 0,
        part,
      });
    }
    if (reasoning.contentAdded) {
      const part = { type: "reasoning_text", text: reasoning.content };
      outward.push({
        type: "response.reasoning_text.done",
        item_id: reasoning.id,
        output_index: reasoning.index,
        content_index: 0,
        text: reasoning.content,
      }, {
        type: "response.content_part.done",
        item_id: reasoning.id,
        output_index: reasoning.index,
        content_index: 0,
        part,
      });
    }
    outward.push({
      type: "response.output_item.done",
      output_index: reasoning.index,
      item: this.#item(reasoning, status),
    });
  }

  #finishTool(
    tool: ToolState,
    outward: Record<string, unknown>[],
    status: "completed" | "incomplete",
  ) {
    if (status === "incomplete") {
      if (!tool.added) return;
      outward.push({
        type: "response.output_item.done",
        output_index: tool.index,
        item: this.#item(tool, status),
      });
      return;
    }
    if (!tool.callId || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)) {
      throw new Error("Provider stream ended with an invalid function call identity");
    }
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(tool.arguments);
    } catch {
      throw new Error("Provider stream ended with malformed function call arguments");
    }
    if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
      throw new Error("Provider stream ended with non-object function call arguments");
    }
    if (!tool.added) this.#addTool(tool, outward);
    outward.push({
      type: "response.function_call_arguments.done",
      item_id: tool.id,
      output_index: tool.index,
      name: tool.name,
      arguments: tool.arguments,
    }, {
      type: "response.output_item.done",
      output_index: tool.index,
      item: this.#item(tool),
    });
  }

  #item(
    output: OutputState,
    status: "in_progress" | "completed" | "incomplete" = "completed",
  ) {
    if (output.type === "message") {
      const content = [
        ...(output.textAdded ? [{ index: output.textIndex!, part: this.#textPart(output) }] : []),
        ...(output.refusalAdded
          ? [{ index: output.refusalIndex!, part: { type: "refusal", refusal: output.refusal } }]
          : []),
      ].sort((left, right) => left.index - right.index).map(({ part }) => part);
      return { id: output.id, type: "message", status, role: "assistant", content };
    }
    if (output.type === "reasoning") {
      return {
        id: output.id,
        type: "reasoning",
        status,
        summary: output.summaryAdded ? [{ type: "summary_text", text: output.summary }] : [],
        content: output.contentAdded ? [{ type: "reasoning_text", text: output.content }] : [],
      };
    }
    return {
      id: output.id,
      type: "function_call",
      status,
      call_id: output.callId,
      name: output.name,
      arguments: status === "in_progress" ? "" : output.arguments,
    };
  }

  #textPart(message: MessageState) {
    return {
      type: "output_text",
      text: message.text,
      annotations: message.annotations.map((annotation) => this.#annotation(annotation)),
    };
  }

  #annotation(annotation: CanonicalUrlCitation) {
    return {
      type: annotation.type,
      start_index: annotation.startIndex,
      end_index: annotation.endIndex,
      title: annotation.title,
      url: annotation.url,
    };
  }

  #response(
    status: "in_progress" | "completed" | "incomplete",
    output: Record<string, unknown>[],
  ) {
    const completed = status !== "in_progress";
    return {
      id: this.#responseId,
      object: "response",
      created_at: this.#createdAt,
      completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
      status,
      error: null,
      incomplete_details: status === "incomplete"
        ? {
          reason: this.#finishState === "content_filter" ? "content_filter" : "max_output_tokens",
        }
        : null,
      model: this.#model,
      output_text: completed ? this.#message?.text ?? "" : "",
      ...responseRequestFields(this.#request),
      output,
      usage: this.#usage
        ? {
          input_tokens: this.#usage.inputTokens,
          input_tokens_details: { cached_tokens: this.#usage.cachedInputTokens },
          output_tokens: this.#usage.outputTokens,
          output_tokens_details: { reasoning_tokens: this.#usage.reasoningTokens },
          total_tokens: this.#usage.totalTokens,
        }
        : null,
    };
  }

  #observe(value: string) {
    this.#visibleBytes += encoder.encode(value).byteLength;
  }
}
