const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 256;
const MAX_PARTS = 256;
const MAX_TOOLS = 128;
const MAX_TEXT_BYTES = 2_000_000;
const MAX_ID_BYTES = 512;
const encoder = new TextEncoder();

export type CanonicalRole = "system" | "developer" | "user" | "assistant" | "tool";
export type CanonicalContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" };
export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: string;
  status?: "in_progress" | "completed" | "incomplete";
}
export interface CanonicalToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}
export interface CanonicalMessage {
  role: CanonicalRole;
  content: CanonicalContentPart[];
  toolCalls?: CanonicalToolCall[];
  toolCallId?: string;
}
export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  tools: CanonicalToolDefinition[];
  stream: boolean;
  maxOutputTokens?: number;
  reasoningEffort?: string;
}
export interface CanonicalUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}
export interface CanonicalResult {
  id: string;
  model: string;
  createdAt?: number;
  content: CanonicalContentPart[];
  text: string;
  refusal?: string;
  error?: { code: string; message: string };
  reasoning?: { content?: string; summary?: string };
  toolCalls: CanonicalToolCall[];
  finishState:
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | "failed"
    | "cancelled"
    | "incomplete"
    | "unknown";
  usage?: CanonicalUsage;
}
export type CanonicalStreamEvent =
  | { type: "started"; id: string; model?: string }
  | { type: "role"; role: CanonicalRole }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string; summary: boolean }
  | { type: "refusal_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "finish"; state: CanonicalResult["finishState"] }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export type ProviderProtocolErrorCode =
  | "malformed_payload"
  | "payload_too_large"
  | "unsupported_feature"
  | "lossy_transform";

export class ProviderProtocolError extends TypeError {
  constructor(
    public readonly code: ProviderProtocolErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

function fail(message: string, path?: string): never {
  throw new ProviderProtocolError("malformed_payload", message, path);
}
function unsupported(path: string, message = `Unsupported provider feature '${path}'`): never {
  throw new ProviderProtocolError("unsupported_feature", message, path);
}
function lossy(
  path: string,
  message = `Cannot transform '${path}' without losing information`,
): never {
  throw new ProviderProtocolError("lossy_transform", message, path);
}
function assertPlainJson(
  value: unknown,
  active = new WeakSet<object>(),
  depth = 0,
  nodes = { count: 0 },
): void {
  nodes.count++;
  if (nodes.count > 100_000 || depth > 64) fail("Provider payload is too complex");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Provider payload contains a non-finite number");
    return;
  }
  if (typeof value !== "object") fail("Provider payload contains a non-JSON value");
  if (active.has(value)) fail("Provider payload contains a cycle");
  active.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) fail("Provider payload must use plain arrays");
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          fail("Provider payload contains a sparse or accessor array");
        }
        assertPlainJson(descriptor.value, active, depth + 1, nodes);
      }
      if (
        Reflect.ownKeys(value).some((key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^\d+$/.test(key) || String(Number(key)) !== key)
        )
      ) fail("Provider payload array contains unsupported properties");
      return;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      fail("Provider payload must use plain objects");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") fail("Provider payload contains a symbol property");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        fail("Provider payload contains an accessor property");
      }
      assertPlainJson(descriptor.value, active, depth + 1, nodes);
    }
  } finally {
    active.delete(value);
  }
}
function clonePayload(value: unknown): unknown {
  assertPlainJson(value);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    fail("Provider payload must be JSON serializable");
  }
  if (json === undefined) fail("Provider payload must be a JSON value");
  if (encoder.encode(json).byteLength > MAX_PAYLOAD_BYTES) {
    throw new ProviderProtocolError("payload_too_large", "Provider payload exceeds the size limit");
  }
  return JSON.parse(json);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`, path);
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${path} must contain ${min} to ${max} items`, path);
  }
  return value;
}
function string(value: unknown, path: string, maxBytes = MAX_TEXT_BYTES, empty = true): string {
  if (
    typeof value !== "string" || (!empty && value.length === 0) ||
    encoder.encode(value).byteLength > maxBytes
  ) {
    fail(`${path} must be a bounded string`, path);
  }
  return value;
}
function optionalString(value: unknown, path: string, max = MAX_TEXT_BYTES): string | undefined {
  return value === undefined || value === null ? undefined : string(value, path, max);
}
function integer(value: unknown, path: string, max = 10_000_000): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) {
    fail(`${path} must be a bounded integer`, path);
  }
  return Number(value);
}
function numberInRange(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${path} must be a number from ${min} to ${max}`, path);
  }
  return value;
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be boolean`, path);
  return value;
}
function reasoningEffort(value: unknown, path: string): string {
  const effort = string(value, path, 32, false);
  if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
    fail(`${path} is invalid`, path);
  }
  return effort;
}
function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) unsupported(path, `${path} contains an unsupported field`);
}
function role(value: unknown, path: string): CanonicalRole {
  if (!["system", "developer", "user", "assistant", "tool"].includes(String(value))) {
    fail(`${path} has an invalid role`, path);
  }
  return value as CanonicalRole;
}
function safeUrl(value: unknown, path: string): string {
  const url = string(value, path, 2_000_000, false);
  if (!(url.startsWith("https://") || url.startsWith("data:image/"))) {
    unsupported(path, "Only HTTPS and inline image URLs can be transformed");
  }
  return url;
}
function detail(value: unknown, path: string): "auto" | "low" | "high" | undefined {
  if (value === undefined) return undefined;
  if (!["auto", "low", "high"].includes(String(value))) fail(`${path} is invalid`, path);
  return value as "auto" | "low" | "high";
}

function chatParts(value: unknown, path: string): CanonicalContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: string(value, path) }];
  if (value === null || value === undefined) return [];
  return array(value, path, MAX_PARTS).map((raw, index) => {
    const part = object(raw, `${path}[${index}]`);
    if (part.type === "text") {
      allowedKeys(part, ["type", "text"], `${path}[${index}]`);
      return { type: "text", text: string(part.text, `${path}[${index}].text`) };
    }
    if (part.type === "image_url") {
      allowedKeys(part, ["type", "image_url"], `${path}[${index}]`);
      const image = typeof part.image_url === "string"
        ? { url: part.image_url }
        : object(part.image_url, `${path}[${index}].image_url`);
      allowedKeys(image, ["url", "detail"], `${path}[${index}].image_url`);
      const imageDetail = detail(image.detail, `${path}[${index}].image_url.detail`);
      return {
        type: "image",
        url: safeUrl(image.url, `${path}[${index}].image_url.url`),
        ...(imageDetail ? { detail: imageDetail } : {}),
      };
    }
    unsupported(`${path}[${index}].type`, "Chat content contains an unsupported part type");
  });
}

function responseParts(value: unknown, path: string): CanonicalContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: string(value, path) }];
  return array(value, path, MAX_PARTS).map((raw, index) => {
    const part = object(raw, `${path}[${index}]`);
    if (part.type === "input_text" || part.type === "text") {
      allowedKeys(part, ["type", "text"], `${path}[${index}]`);
      return { type: "text", text: string(part.text, `${path}[${index}].text`) };
    }
    if (part.type === "input_image") {
      allowedKeys(part, ["type", "image_url", "detail"], `${path}[${index}]`);
      const imageDetail = detail(part.detail, `${path}[${index}].detail`);
      return {
        type: "image",
        url: safeUrl(part.image_url, `${path}[${index}].image_url`),
        ...(imageDetail ? { detail: imageDetail } : {}),
      };
    }
    unsupported(`${path}[${index}].type`, "Responses content contains an unsupported part type");
  });
}

function toResponsesContent(parts: CanonicalContentPart[]) {
  return parts.map((part) =>
    part.type === "text" ? { type: "input_text", text: part.text } : {
      type: "input_image",
      image_url: part.url,
      ...(part.detail ? { detail: part.detail } : {}),
    }
  );
}
function toChatContent(parts: CanonicalContentPart[]): string | Array<Record<string, unknown>> {
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : {
      type: "image_url",
      image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) },
    }
  );
}

function chatTool(raw: unknown, path: string) {
  const tool = object(raw, path);
  allowedKeys(tool, ["type", "function"], path);
  if (tool.type !== "function") {
    unsupported(`${path}.type`, "Only function tools can be transformed");
  }
  const fn = object(tool.function, `${path}.function`);
  allowedKeys(fn, ["name", "description", "parameters", "strict"], `${path}.function`);
  if (fn.strict !== undefined && typeof fn.strict !== "boolean") {
    fail(`${path}.function.strict must be boolean`, `${path}.function.strict`);
  }
  return {
    type: "function",
    name: string(fn.name, `${path}.function.name`, 128, false),
    ...(fn.description === undefined
      ? {}
      : { description: string(fn.description, `${path}.function.description`, 8_192) }),
    ...(fn.parameters === undefined
      ? {}
      : { parameters: object(fn.parameters, `${path}.function.parameters`) }),
    ...(fn.strict === undefined ? {} : { strict: fn.strict }),
  };
}
function responseTool(raw: unknown, path: string) {
  const tool = object(raw, path);
  allowedKeys(tool, ["type", "name", "description", "parameters", "strict"], path);
  if (tool.type !== "function") {
    unsupported(`${path}.type`, "Only function tools can be transformed");
  }
  if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
    fail(`${path}.strict must be boolean`, `${path}.strict`);
  }
  return {
    type: "function",
    function: {
      name: string(tool.name, `${path}.name`, 128, false),
      ...(tool.description === undefined
        ? {}
        : { description: string(tool.description, `${path}.description`, 8_192) }),
      ...(tool.parameters === undefined
        ? {}
        : { parameters: object(tool.parameters, `${path}.parameters`) }),
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  };
}
function toolCall(raw: unknown, path: string): CanonicalToolCall {
  const call = object(raw, path);
  allowedKeys(call, ["id", "type", "function", "call_id", "name", "arguments", "status"], path);
  if (call.type !== "function" && call.type !== "function_call") {
    fail(`${path}.type is invalid`, `${path}.type`);
  }
  const fn = call.function === undefined ? call : object(call.function, `${path}.function`);
  if (call.function !== undefined) allowedKeys(fn, ["name", "arguments"], `${path}.function`);
  const status = call.status === undefined
    ? undefined
    : ["in_progress", "completed", "incomplete"].includes(String(call.status))
    ? call.status as "in_progress" | "completed" | "incomplete"
    : fail(`${path}.status is invalid`, `${path}.status`);
  return {
    id: string(
      call.type === "function_call" ? call.call_id ?? call.id : call.id ?? call.call_id,
      `${path}.id`,
      MAX_ID_BYTES,
      false,
    ),
    name: string(fn.name, `${path}.name`, 128, false),
    arguments: string(fn.arguments, `${path}.arguments`, 1_000_000),
    ...(status ? { status } : {}),
  };
}

function chatToolChoice(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    if (!["none", "auto", "required"].includes(value)) fail(`${path} is invalid`, path);
    return value;
  }
  const choice = object(value, path);
  allowedKeys(choice, ["type", "function"], path);
  if (choice.type !== "function") unsupported(`${path}.type`);
  const fn = object(choice.function, `${path}.function`);
  allowedKeys(fn, ["name"], `${path}.function`);
  return { type: "function", name: string(fn.name, `${path}.function.name`, 128, false) };
}

function responseToolChoice(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    if (!["none", "auto", "required"].includes(value)) fail(`${path} is invalid`, path);
    return value;
  }
  const choice = object(value, path);
  allowedKeys(choice, ["type", "name"], path);
  if (choice.type !== "function") unsupported(`${path}.type`);
  return {
    type: "function",
    function: { name: string(choice.name, `${path}.name`, 128, false) },
  };
}

const chatRequestKeys = [
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stream_options",
  "tools",
  "tool_choice",
  "response_format",
  "parallel_tool_calls",
  "stop",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "n",
  "user",
  "reasoning_effort",
];

/** Converts a Chat Completions request into a Responses API request without silent field loss. */
export function chatCompletionsRequestToResponses(input: unknown): Record<string, unknown> {
  const body = object(clonePayload(input), "request");
  allowedKeys(body, chatRequestKeys, "request");
  for (const field of ["stop", "frequency_penalty", "presence_penalty", "seed", "user"] as const) {
    if (body[field] !== undefined) unsupported(`request.${field}`);
  }
  if (body.n !== undefined && body.n !== 1) unsupported("request.n");
  if (body.stream_options !== undefined) {
    const streamOptions = object(body.stream_options, "request.stream_options");
    allowedKeys(streamOptions, ["include_usage"], "request.stream_options");
    if (
      streamOptions.include_usage !== undefined && typeof streamOptions.include_usage !== "boolean"
    ) fail("include_usage must be boolean", "request.stream_options.include_usage");
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (
    body.max_tokens !== undefined && body.max_completion_tokens !== undefined &&
    body.max_tokens !== body.max_completion_tokens
  ) {
    lossy(
      "request.max_tokens",
      "Conflicting max_tokens and max_completion_tokens cannot be transformed",
    );
  }
  const output: Record<string, unknown> = {
    model: string(body.model, "request.model", 200, false),
    input: [],
  };
  const items: Array<Record<string, unknown>> = [];
  for (const [index, raw] of array(body.messages, "request.messages", MAX_MESSAGES, 1).entries()) {
    const message = object(raw, `request.messages[${index}]`);
    allowedKeys(message, [
      "role",
      "content",
      "name",
      "tool_call_id",
      "tool_calls",
      "reasoning_content",
      "reasoning_summary",
    ], `request.messages[${index}]`);
    const messageRole = role(message.role, `request.messages[${index}].role`);
    if (message.name !== undefined) lossy(`request.messages[${index}].name`);
    if (message.reasoning_content !== undefined || message.reasoning_summary !== undefined) {
      lossy(
        `request.messages[${index}].reasoning_content`,
        "Prior raw reasoning cannot be represented safely in a Responses request",
      );
    }
    if (messageRole === "tool") {
      if (message.tool_call_id === undefined) {
        fail("Tool result requires tool_call_id", `request.messages[${index}].tool_call_id`);
      }
      const parts = chatParts(message.content, `request.messages[${index}].content`);
      if (parts.some((part) => part.type !== "text")) {
        unsupported(`request.messages[${index}].content`, "Tool results cannot contain images");
      }
      items.push({
        type: "function_call_output",
        call_id: string(
          message.tool_call_id,
          `request.messages[${index}].tool_call_id`,
          MAX_ID_BYTES,
          false,
        ),
        output: parts.map((part) => part.type === "text" ? part.text : "").join(""),
      });
      continue;
    }
    const content = chatParts(message.content, `request.messages[${index}].content`);
    if (content.length || !message.tool_calls) {
      items.push({ role: messageRole, content: toResponsesContent(content) });
    }
    if (message.tool_calls !== undefined) {
      if (messageRole !== "assistant") {
        fail(
          "Only assistant messages may contain tool_calls",
          `request.messages[${index}].tool_calls`,
        );
      }
      for (
        const [callIndex, rawCall] of array(
          message.tool_calls,
          `request.messages[${index}].tool_calls`,
          MAX_TOOLS,
        ).entries()
      ) {
        const call = toolCall(rawCall, `request.messages[${index}].tool_calls[${callIndex}]`);
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    }
  }
  output.input = items;
  if (body.stream !== undefined) output.stream = boolean(body.stream, "request.stream");
  if (body.temperature !== undefined) {
    output.temperature = numberInRange(body.temperature, "request.temperature", 0, 2);
  }
  if (body.top_p !== undefined) output.top_p = numberInRange(body.top_p, "request.top_p", 0, 1);
  if (body.parallel_tool_calls !== undefined) {
    output.parallel_tool_calls = boolean(body.parallel_tool_calls, "request.parallel_tool_calls");
  }
  if (maxTokens !== undefined) {
    output.max_output_tokens = integer(maxTokens, "request.max_output_tokens", 131_072);
    if (output.max_output_tokens === 0) {
      fail("max output tokens must be positive", "request.max_output_tokens");
    }
  }
  if (body.tools !== undefined) {
    output.tools = array(body.tools, "request.tools", MAX_TOOLS).map((tool, index) =>
      chatTool(tool, `request.tools[${index}]`)
    );
  }
  if (body.tool_choice !== undefined) {
    output.tool_choice = chatToolChoice(body.tool_choice, "request.tool_choice");
  }
  if (body.response_format !== undefined) {
    output.text = { format: object(body.response_format, "request.response_format") };
  }
  if (body.reasoning_effort !== undefined) {
    output.reasoning = {
      effort: reasoningEffort(body.reasoning_effort, "request.reasoning_effort"),
    };
  }
  return output;
}

const responsesRequestKeys = [
  "model",
  "input",
  "instructions",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "text",
  "reasoning",
  "previous_response_id",
  "include",
  "store",
  "metadata",
  "background",
  "user",
];

/** Converts a Responses request into a Chat Completions request without silent field loss. */
export function responsesRequestToChatCompletions(input: unknown): Record<string, unknown> {
  const body = object(clonePayload(input), "request");
  allowedKeys(body, responsesRequestKeys, "request");
  for (
    const field of [
      "previous_response_id",
      "include",
      "store",
      "metadata",
      "background",
      "user",
    ] as const
  ) if (body[field] !== undefined) unsupported(`request.${field}`);
  const messages: Array<Record<string, unknown>> = [];
  if (body.instructions !== undefined) {
    messages.push({ role: "system", content: string(body.instructions, "request.instructions") });
  }
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: string(body.input, "request.input") });
  } else {
    for (const [index, raw] of array(body.input, "request.input", MAX_MESSAGES, 1).entries()) {
      const item = object(raw, `request.input[${index}]`);
      if (item.type === "function_call") {
        const call = toolCall(item, `request.input[${index}]`);
        if (call.status !== undefined) lossy(`request.input[${index}].status`);
        const serialized = {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        };
        const previous = messages.at(-1);
        if (
          previous?.role === "assistant" && previous.content === null &&
          Array.isArray(previous.tool_calls)
        ) previous.tool_calls.push(serialized);
        else messages.push({ role: "assistant", content: null, tool_calls: [serialized] });
      } else if (item.type === "function_call_output") {
        allowedKeys(item, ["type", "call_id", "output"], `request.input[${index}]`);
        messages.push({
          role: "tool",
          tool_call_id: string(
            item.call_id,
            `request.input[${index}].call_id`,
            MAX_ID_BYTES,
            false,
          ),
          content: string(item.output, `request.input[${index}].output`),
        });
      } else {
        allowedKeys(item, ["type", "role", "content"], `request.input[${index}]`);
        messages.push({
          role: role(item.role, `request.input[${index}].role`),
          content: toChatContent(responseParts(item.content, `request.input[${index}].content`)),
        });
      }
    }
  }
  const output: Record<string, unknown> = {
    model: string(body.model, "request.model", 200, false),
    messages,
  };
  if (body.stream !== undefined) output.stream = boolean(body.stream, "request.stream");
  if (body.temperature !== undefined) {
    output.temperature = numberInRange(body.temperature, "request.temperature", 0, 2);
  }
  if (body.top_p !== undefined) output.top_p = numberInRange(body.top_p, "request.top_p", 0, 1);
  if (body.parallel_tool_calls !== undefined) {
    output.parallel_tool_calls = boolean(body.parallel_tool_calls, "request.parallel_tool_calls");
  }
  if (body.max_output_tokens !== undefined) {
    output.max_completion_tokens = integer(
      body.max_output_tokens,
      "request.max_output_tokens",
      131_072,
    );
    if (output.max_completion_tokens === 0) {
      fail("max output tokens must be positive", "request.max_output_tokens");
    }
  }
  if (body.tools !== undefined) {
    output.tools = array(body.tools, "request.tools", MAX_TOOLS).map((tool, index) =>
      responseTool(tool, `request.tools[${index}]`)
    );
  }
  if (body.tool_choice !== undefined) {
    output.tool_choice = responseToolChoice(body.tool_choice, "request.tool_choice");
  }
  if (body.text !== undefined) {
    const text = object(body.text, "request.text");
    allowedKeys(text, ["format", "verbosity"], "request.text");
    if (text.verbosity !== undefined) unsupported("request.text.verbosity");
    if (text.format !== undefined) output.response_format = text.format;
  }
  if (body.reasoning !== undefined) {
    const reasoning = object(body.reasoning, "request.reasoning");
    allowedKeys(reasoning, ["effort", "summary"], "request.reasoning");
    if (reasoning.summary !== undefined && reasoning.summary !== "none") {
      unsupported("request.reasoning.summary");
    }
    if (reasoning.effort !== undefined) {
      output.reasoning_effort = reasoningEffort(reasoning.effort, "request.reasoning.effort");
    }
  }
  return output;
}

function usage(
  value: unknown,
  kind: "chat" | "responses",
  path = "usage",
): CanonicalUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const data = object(value, path);
  const input = integer(
    data[kind === "chat" ? "prompt_tokens" : "input_tokens"],
    `${path}.input_tokens`,
  );
  const output = integer(
    data[kind === "chat" ? "completion_tokens" : "output_tokens"],
    `${path}.output_tokens`,
  );
  const inputDetails =
    data[kind === "chat" ? "prompt_tokens_details" : "input_tokens_details"] === undefined
      ? {}
      : object(
        data[kind === "chat" ? "prompt_tokens_details" : "input_tokens_details"],
        `${path}.input_tokens_details`,
      );
  const outputDetails =
    data[kind === "chat" ? "completion_tokens_details" : "output_tokens_details"] === undefined
      ? {}
      : object(
        data[kind === "chat" ? "completion_tokens_details" : "output_tokens_details"],
        `${path}.output_tokens_details`,
      );
  const cached = inputDetails.cached_tokens === undefined
    ? 0
    : integer(inputDetails.cached_tokens, `${path}.cached_tokens`);
  const reasoning = outputDetails.reasoning_tokens === undefined
    ? 0
    : integer(outputDetails.reasoning_tokens, `${path}.reasoning_tokens`);
  if (cached > input || reasoning > output) fail("Usage detail tokens exceed totals", path);
  const total = data.total_tokens === undefined
    ? input + output
    : integer(data.total_tokens, `${path}.total_tokens`);
  if (total !== input + output) {
    fail("Usage total does not equal input plus output", `${path}.total_tokens`);
  }
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: total,
  };
}
function finish(value: unknown): CanonicalResult["finishState"] {
  if (value === "stop" || value === "completed") return "stop";
  if (value === "length" || value === "max_output_tokens") return "length";
  if (value === "tool_calls") return "tool_calls";
  if (value === "content_filter") return "content_filter";
  if (value === "failed") return "failed";
  if (value === "cancelled") return "cancelled";
  if (value === "incomplete") return "incomplete";
  return "unknown";
}

export function normalizeChatCompletionResult(input: unknown): CanonicalResult {
  const body = object(clonePayload(input), "response");
  const choices = array(body.choices, "response.choices", 1, 1);
  const choice = object(choices[0], "response.choices[0]");
  const message = object(choice.message, "response.choices[0].message");
  const content = message.content === null || message.content === undefined
    ? []
    : chatParts(message.content, "response.choices[0].message.content");
  const reasoningContent = optionalString(
    message.reasoning_content ??
      (typeof message.reasoning === "string" ? message.reasoning : undefined),
    "response.choices[0].message.reasoning_content",
  );
  const reasoningSummary = optionalString(
    message.reasoning_summary,
    "response.choices[0].message.reasoning_summary",
  );
  return {
    id: string(body.id, "response.id", MAX_ID_BYTES, false),
    model: string(body.model, "response.model", 200, false),
    ...(body.created === undefined
      ? {}
      : { createdAt: integer(body.created, "response.created", 4_294_967_295) }),
    content,
    text: content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
    ...(message.refusal === undefined || message.refusal === null
      ? {}
      : { refusal: string(message.refusal, "response.choices[0].message.refusal") }),
    ...(reasoningContent || reasoningSummary
      ? {
        reasoning: {
          ...(reasoningContent ? { content: reasoningContent } : {}),
          ...(reasoningSummary ? { summary: reasoningSummary } : {}),
        },
      }
      : {}),
    toolCalls: message.tool_calls === undefined
      ? []
      : array(message.tool_calls, "response.choices[0].message.tool_calls", MAX_TOOLS).map((
        call,
        index,
      ) => toolCall(call, `response.choices[0].message.tool_calls[${index}]`)),
    finishState: finish(choice.finish_reason),
    ...(body.usage === undefined ? {} : { usage: usage(body.usage, "chat", "response.usage")! }),
  };
}

export function normalizeResponsesResult(input: unknown): CanonicalResult {
  const body = object(clonePayload(input), "response");
  let text = "";
  let refusal = "";
  let reasoningContent = "";
  let reasoningSummary = "";
  const resultContent: CanonicalContentPart[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  for (const [index, raw] of array(body.output, "response.output", MAX_PARTS).entries()) {
    const item = object(raw, `response.output[${index}]`);
    if (item.type === "message") {
      for (
        const [partIndex, rawPart] of array(
          item.content,
          `response.output[${index}].content`,
          MAX_PARTS,
        ).entries()
      ) {
        const part = object(rawPart, `response.output[${index}].content[${partIndex}]`);
        if (part.type === "output_text") {
          const partText = string(
            part.text,
            `response.output[${index}].content[${partIndex}].text`,
          );
          text += partText;
          resultContent.push({ type: "text", text: partText });
        } else if (part.type === "output_image") {
          const imageDetail = detail(
            part.detail,
            `response.output[${index}].content[${partIndex}].detail`,
          );
          resultContent.push({
            type: "image",
            url: safeUrl(
              part.image_url,
              `response.output[${index}].content[${partIndex}].image_url`,
            ),
            ...(imageDetail ? { detail: imageDetail } : {}),
          });
        } else if (part.type === "refusal") {
          refusal += string(
            part.refusal,
            `response.output[${index}].content[${partIndex}].refusal`,
          );
        } else unsupported(`response.output[${index}].content[${partIndex}].type`);
      }
    } else if (item.type === "reasoning") {
      for (
        const rawSummary of array(
          item.summary ?? [],
          `response.output[${index}].summary`,
          MAX_PARTS,
        )
      ) {
        const summary = object(rawSummary, `response.output[${index}].summary`);
        if (summary.type !== "summary_text") unsupported(`response.output[${index}].summary.type`);
        reasoningSummary += string(summary.text, `response.output[${index}].summary.text`);
      }
      for (
        const rawContent of array(
          item.content ?? [],
          `response.output[${index}].content`,
          MAX_PARTS,
        )
      ) {
        const content = object(rawContent, `response.output[${index}].content`);
        if (content.type !== "reasoning_text") {
          unsupported(`response.output[${index}].content.type`);
        }
        reasoningContent += string(content.text, `response.output[${index}].content.text`);
      }
    } else if (item.type === "function_call") {
      toolCalls.push(toolCall(item, `response.output[${index}]`));
    } else unsupported(`response.output[${index}].type`);
  }
  const incompleteReason = body.incomplete_details === undefined
    ? undefined
    : object(body.incomplete_details, "response.incomplete_details").reason;
  return {
    id: string(body.id, "response.id", MAX_ID_BYTES, false),
    model: string(body.model, "response.model", 200, false),
    ...(body.created_at === undefined
      ? {}
      : { createdAt: integer(body.created_at, "response.created_at", 4_294_967_295) }),
    content: resultContent,
    text,
    ...(refusal ? { refusal } : {}),
    ...(body.error === undefined || body.error === null ? {} : {
      error: (() => {
        const error = object(body.error, "response.error");
        return {
          code: optionalString(error.code, "response.error.code", 120) ?? "provider_error",
          message: optionalString(error.message, "response.error.message", 500) ??
            "Provider response failed",
        };
      })(),
    }),
    ...(reasoningContent || reasoningSummary
      ? {
        reasoning: {
          ...(reasoningContent ? { content: reasoningContent } : {}),
          ...(reasoningSummary ? { summary: reasoningSummary } : {}),
        },
      }
      : {}),
    toolCalls,
    finishState: finish(
      body.status === "incomplete" ? incompleteReason ?? "incomplete" : body.status,
    ),
    ...(body.usage === undefined
      ? {}
      : { usage: usage(body.usage, "responses", "response.usage")! }),
  };
}

export function normalizeChatStreamChunk(input: unknown): CanonicalStreamEvent[] {
  if (input === "[DONE]") return [{ type: "done" }];
  const body = object(clonePayload(input), "event");
  if (body.error !== undefined) {
    const error = object(body.error, "event.error");
    return [{
      type: "error",
      code: optionalString(error.code, "event.error.code", 120) ?? "provider_error",
      message: optionalString(error.message, "event.error.message", 500) ??
        "Provider stream failed",
    }];
  }
  const events: CanonicalStreamEvent[] = [];
  if (body.id !== undefined) {
    events.push({
      type: "started",
      id: string(body.id, "event.id", MAX_ID_BYTES, false),
      ...(body.model === undefined ? {} : { model: string(body.model, "event.model", 200) }),
    });
  }
  for (const [index, rawChoice] of array(body.choices ?? [], "event.choices", 1).entries()) {
    const choice = object(rawChoice, `event.choices[${index}]`);
    const delta = object(choice.delta ?? {}, `event.choices[${index}].delta`);
    if (delta.role !== undefined) {
      events.push({ type: "role", role: role(delta.role, `event.choices[${index}].delta.role`) });
    }
    if (delta.content !== undefined && delta.content !== null) {
      events.push({
        type: "text_delta",
        text: string(delta.content, `event.choices[${index}].delta.content`),
      });
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning !== undefined && reasoning !== null) {
      events.push({
        type: "reasoning_delta",
        text: string(reasoning, `event.choices[${index}].delta.reasoning`),
        summary: false,
      });
    }
    if (delta.refusal !== undefined && delta.refusal !== null) {
      events.push({
        type: "refusal_delta",
        text: string(delta.refusal, `event.choices[${index}].delta.refusal`),
      });
    }
    if (delta.tool_calls !== undefined) {
      for (
        const rawCall of array(
          delta.tool_calls,
          `event.choices[${index}].delta.tool_calls`,
          MAX_TOOLS,
        )
      ) {
        const call = object(rawCall, `event.choices[${index}].delta.tool_calls`);
        const fn = call.function === undefined
          ? {}
          : object(call.function, `event.choices[${index}].delta.tool_calls.function`);
        events.push({
          type: "tool_call_delta",
          index: integer(call.index ?? 0, "tool call index", 127),
          ...(call.id === undefined ? {} : { id: string(call.id, "tool call id", MAX_ID_BYTES) }),
          ...(fn.name === undefined ? {} : { name: string(fn.name, "tool call name", 128) }),
          ...(fn.arguments === undefined
            ? {}
            : { arguments: string(fn.arguments, "tool call arguments", 1_000_000) }),
        });
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      events.push({ type: "finish", state: finish(choice.finish_reason) });
    }
  }
  if (body.usage !== undefined && body.usage !== null) {
    events.push({ type: "usage", usage: usage(body.usage, "chat", "event.usage")! });
  }
  return events;
}

function publicUsage(value: unknown, path: string) {
  const normalized = usage(value, "chat", path);
  if (!normalized) return undefined;
  return {
    prompt_tokens: normalized.inputTokens,
    completion_tokens: normalized.outputTokens,
    total_tokens: normalized.totalTokens,
    prompt_tokens_details: { cached_tokens: normalized.cachedInputTokens },
    completion_tokens_details: { reasoning_tokens: normalized.reasoningTokens },
  };
}

function publicCitation(value: unknown, path: string): Record<string, unknown> {
  const annotation = object(value, path);
  allowedKeys(annotation, ["type", "url_citation"], path);
  if (annotation.type !== "url_citation") unsupported(`${path}.type`);
  const citation = object(annotation.url_citation, `${path}.url_citation`);
  allowedKeys(citation, ["start_index", "end_index", "title", "url"], `${path}.url_citation`);
  const startIndex = integer(citation.start_index, `${path}.url_citation.start_index`, 2_000_000);
  const endIndex = integer(citation.end_index, `${path}.url_citation.end_index`, 2_000_000);
  if (endIndex < startIndex) fail("Citation end_index precedes start_index", path);
  const url = string(citation.url, `${path}.url_citation.url`, 16_384, false);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${path}.url_citation.url is invalid`, `${path}.url_citation.url`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    fail(`${path}.url_citation.url has an invalid protocol`, `${path}.url_citation.url`);
  }
  return {
    type: "url_citation",
    url_citation: {
      start_index: startIndex,
      end_index: endIndex,
      title: string(citation.title, `${path}.url_citation.title`, 8_192),
      url,
    },
  };
}

function publicAudio(value: unknown, path: string): Record<string, unknown> | null {
  if (value === null) return null;
  const audio = object(value, path);
  allowedKeys(audio, ["id", "data", "expires_at", "transcript"], path);
  const data = string(audio.data, `${path}.data`, 16_777_216);
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    fail(`${path}.data must be base64`, `${path}.data`);
  }
  return {
    id: string(audio.id, `${path}.id`, MAX_ID_BYTES, false),
    data,
    expires_at: integer(audio.expires_at, `${path}.expires_at`, 4_294_967_295),
    transcript: string(audio.transcript, `${path}.transcript`, MAX_TEXT_BYTES),
  };
}

function publicLogprobToken(
  value: unknown,
  path: string,
  nested: boolean,
): Record<string, unknown> {
  const token = object(value, path);
  allowedKeys(
    token,
    nested ? ["token", "logprob", "bytes"] : [
      "token",
      "logprob",
      "bytes",
      "top_logprobs",
    ],
    path,
  );
  const bytes = token.bytes === null
    ? null
    : array(token.bytes, `${path}.bytes`, 256).map((byte, index) =>
      integer(byte, `${path}.bytes[${index}]`, 255)
    );
  return {
    token: string(token.token, `${path}.token`, 65_536),
    logprob: numberInRange(token.logprob, `${path}.logprob`, -10_000, 0),
    bytes,
    ...(!nested && token.top_logprobs !== undefined
      ? {
        top_logprobs: array(token.top_logprobs, `${path}.top_logprobs`, 20).map((entry, index) =>
          publicLogprobToken(entry, `${path}.top_logprobs[${index}]`, true)
        ),
      }
      : {}),
  };
}

function publicLogprobs(value: unknown, path: string): Record<string, unknown> | null {
  if (value === null) return null;
  const logprobs = object(value, path);
  allowedKeys(logprobs, ["content", "refusal"], path);
  const result: Record<string, unknown> = {};
  for (const field of ["content", "refusal"] as const) {
    if (logprobs[field] === undefined) continue;
    result[field] = logprobs[field] === null
      ? null
      : array(logprobs[field], `${path}.${field}`, 100_000).map((entry, index) =>
        publicLogprobToken(entry, `${path}.${field}[${index}]`, false)
      );
  }
  return result;
}

function publicFinishReason(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  const result = string(value, path, 64, false);
  if (!["stop", "length", "tool_calls", "content_filter", "function_call"].includes(result)) {
    fail(`${path} is invalid`, path);
  }
  return result;
}

/** Rebuilds an upstream completion from an explicit OpenAI field allowlist. */
export function publicChatCompletion(
  input: unknown,
  publicId: string,
  publicModel: string,
): Record<string, unknown> {
  const body = object(clonePayload(input), "response");
  const rawChoice = object(array(body.choices, "response.choices", 1, 1)[0], "response.choices[0]");
  const rawMessage = object(rawChoice.message, "response.choices[0].message");
  const message: Record<string, unknown> = {
    role: "assistant",
    content: rawMessage.content === null || rawMessage.content === undefined
      ? null
      : string(rawMessage.content, "response.choices[0].message.content"),
  };
  for (const name of ["refusal", "reasoning_content", "reasoning", "reasoning_summary"] as const) {
    if (rawMessage[name] !== undefined && rawMessage[name] !== null) {
      message[name] = string(rawMessage[name], `response.choices[0].message.${name}`);
    }
  }
  if (rawMessage.tool_calls !== undefined) {
    message.tool_calls = array(
      rawMessage.tool_calls,
      "response.choices[0].message.tool_calls",
      MAX_TOOLS,
    ).map((raw, index) => {
      const call = toolCall(raw, `response.choices[0].message.tool_calls[${index}]`);
      return {
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      };
    });
  }
  if (rawMessage.annotations !== undefined) {
    message.annotations = array(
      rawMessage.annotations,
      "response.choices[0].message.annotations",
      256,
    ).map((annotation, index) =>
      publicCitation(annotation, `response.choices[0].message.annotations[${index}]`)
    );
  }
  if (rawMessage.audio !== undefined) {
    message.audio = publicAudio(rawMessage.audio, "response.choices[0].message.audio");
  }
  const choice: Record<string, unknown> = {
    index: 0,
    message,
    finish_reason: publicFinishReason(rawChoice.finish_reason, "response.choices[0].finish_reason"),
  };
  if (rawChoice.logprobs !== undefined) {
    choice.logprobs = publicLogprobs(rawChoice.logprobs, "response.choices[0].logprobs");
  }
  const output: Record<string, unknown> = {
    id: string(publicId, "response.id", MAX_ID_BYTES, false),
    object: "chat.completion",
    created: body.created === undefined
      ? Math.floor(Date.now() / 1_000)
      : integer(body.created, "response.created", 4_294_967_295),
    model: string(publicModel, "response.model", 200, false),
    choices: [choice],
  };
  const normalizedUsage = publicUsage(body.usage, "response.usage");
  if (normalizedUsage) output.usage = normalizedUsage;
  if (body.system_fingerprint !== undefined && body.system_fingerprint !== null) {
    output.system_fingerprint = string(body.system_fingerprint, "response.system_fingerprint", 512);
  }
  if (body.service_tier !== undefined && body.service_tier !== null) {
    output.service_tier = string(body.service_tier, "response.service_tier", 120);
  }
  return output;
}

/** Rebuilds an upstream chunk from an explicit OpenAI field allowlist. */
export function publicChatStreamChunk(
  input: unknown,
  publicId: string,
  publicModel: string,
): Record<string, unknown> {
  const body = object(clonePayload(input), "event");
  const events = normalizeChatStreamChunk(body);
  const error = events.find((event) => event.type === "error");
  if (error?.type === "error") {
    throw new ProviderProtocolError("malformed_payload", error.message, "event.error");
  }
  const choices = array(body.choices ?? [], "event.choices", 1);
  const publicChoices = choices.map((raw, index) => {
    const choice = object(raw, `event.choices[${index}]`);
    const rawDelta = object(choice.delta ?? {}, `event.choices[${index}].delta`);
    const delta: Record<string, unknown> = {};
    if (rawDelta.role !== undefined) {
      delta.role = role(rawDelta.role, `event.choices[${index}].delta.role`);
    }
    for (const name of ["content", "refusal", "reasoning_content", "reasoning"] as const) {
      if (rawDelta[name] !== undefined) {
        delta[name] = rawDelta[name] === null
          ? null
          : string(rawDelta[name], `event.choices[${index}].delta.${name}`);
      }
    }
    if (rawDelta.tool_calls !== undefined) {
      delta.tool_calls = array(
        rawDelta.tool_calls,
        `event.choices[${index}].delta.tool_calls`,
        MAX_TOOLS,
      ).map((rawCall, callIndex) => {
        const call = object(rawCall, `event.choices[${index}].delta.tool_calls[${callIndex}]`);
        const fn = call.function === undefined ? undefined : object(
          call.function,
          `event.choices[${index}].delta.tool_calls[${callIndex}].function`,
        );
        return {
          index: integer(call.index ?? callIndex, "tool call index", 127),
          ...(call.id === undefined ? {} : { id: string(call.id, "tool call id", MAX_ID_BYTES) }),
          ...(call.type === undefined ? {} : { type: string(call.type, "tool call type", 32) }),
          ...(fn === undefined ? {} : {
            function: {
              ...(fn.name === undefined ? {} : { name: string(fn.name, "tool call name", 128) }),
              ...(fn.arguments === undefined
                ? {}
                : { arguments: string(fn.arguments, "tool call arguments", 1_000_000) }),
            },
          }),
        };
      });
    }
    const result: Record<string, unknown> = {
      index,
      delta,
      finish_reason: publicFinishReason(
        choice.finish_reason,
        `event.choices[${index}].finish_reason`,
      ),
    };
    if (choice.logprobs !== undefined) {
      result.logprobs = publicLogprobs(choice.logprobs, `event.choices[${index}].logprobs`);
    }
    return result;
  });
  const output: Record<string, unknown> = {
    id: string(publicId, "event.id", MAX_ID_BYTES, false),
    object: "chat.completion.chunk",
    created: body.created === undefined
      ? Math.floor(Date.now() / 1_000)
      : integer(body.created, "event.created", 4_294_967_295),
    model: string(publicModel, "event.model", 200, false),
    choices: publicChoices,
  };
  const normalizedUsage = publicUsage(body.usage, "event.usage");
  if (normalizedUsage) output.usage = normalizedUsage;
  if (body.system_fingerprint !== undefined && body.system_fingerprint !== null) {
    output.system_fingerprint = string(body.system_fingerprint, "event.system_fingerprint", 512);
  }
  if (body.service_tier !== undefined && body.service_tier !== null) {
    output.service_tier = string(body.service_tier, "event.service_tier", 120);
  }
  return output;
}

export function normalizeResponsesStreamEvent(input: unknown): CanonicalStreamEvent[] {
  if (input === "[DONE]") return [{ type: "done" }];
  const event = object(clonePayload(input), "event");
  const type = string(event.type, "event.type", 120, false);
  if (type === "response.created" || type === "response.in_progress") {
    const response = object(event.response, "event.response");
    return [{
      type: "started",
      id: string(response.id, "event.response.id", MAX_ID_BYTES, false),
      ...(response.model === undefined
        ? {}
        : { model: string(response.model, "event.response.model", 200) }),
    }];
  }
  if (type === "response.output_text.delta") {
    return [{ type: "text_delta", text: string(event.delta, "event.delta") }];
  }
  if (type === "response.refusal.delta") {
    return [{ type: "refusal_delta", text: string(event.delta, "event.delta") }];
  }
  if (
    type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta"
  ) {
    return [{
      type: "reasoning_delta",
      text: string(event.delta, "event.delta"),
      summary: type.includes("summary"),
    }];
  }
  if (type === "response.function_call_arguments.delta") {
    return [{
      type: "tool_call_delta",
      index: integer(event.output_index ?? 0, "event.output_index", 127),
      ...(event.item_id === undefined
        ? {}
        : { id: string(event.item_id, "event.item_id", MAX_ID_BYTES) }),
      ...(event.name === undefined ? {} : { name: string(event.name, "event.name", 128) }),
      arguments: string(event.delta, "event.delta", 1_000_000),
    }];
  }
  if (type === "response.output_item.added") {
    const item = object(event.item, "event.item");
    if (item.type === "message") {
      return [{
        type: "role",
        role: item.role === undefined ? "assistant" : role(item.role, "event.item.role"),
      }];
    }
    if (item.type !== "function_call") return [];
    return [{
      type: "tool_call_delta",
      index: integer(event.output_index ?? 0, "event.output_index", 127),
      id: string(item.call_id ?? item.id, "event.item.call_id", MAX_ID_BYTES, false),
      name: string(item.name, "event.item.name", 128, false),
      arguments: optionalString(item.arguments, "event.item.arguments", 1_000_000) ?? "",
    }];
  }
  if (type === "response.completed") {
    const response = object(event.response, "event.response");
    const events: CanonicalStreamEvent[] = [];
    if (response.usage !== undefined) {
      events.push({
        type: "usage",
        usage: usage(response.usage, "responses", "event.response.usage")!,
      });
    }
    events.push({ type: "finish", state: finish(response.status) });
    events.push({ type: "done" });
    return events;
  }
  if (type === "response.failed" || type === "error") {
    const error = object(
      event.error ?? object(event.response, "event.response").error,
      "event.error",
    );
    return [{
      type: "error",
      code: optionalString(error.code, "event.error.code", 120) ?? "provider_error",
      message: optionalString(error.message, "event.error.message", 500) ??
        "Provider response failed",
    }];
  }
  if (
    [
      "response.output_text.done",
      "response.reasoning_summary_text.done",
      "response.reasoning_text.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.content_part.added",
      "response.content_part.done",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_part.done",
    ].includes(type)
  ) return [];
  unsupported("event.type", "Responses stream contains an unsupported event type");
}
