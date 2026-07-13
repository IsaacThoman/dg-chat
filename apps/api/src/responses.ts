import type { CanonicalResult } from "./provider-protocol.ts";

export interface ResponseUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface ResponseRequestEcho {
  background?: boolean;
  instructions?: unknown;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
  parallelToolCalls?: boolean;
  previousResponseId?: string;
  reasoning?: unknown;
  store?: boolean;
  temperature?: number;
  text?: unknown;
  toolChoice?: unknown;
  tools?: unknown[];
  topP?: number;
  user?: string;
}

/** Required, public request fields repeated on every official Responses object. */
export function responseRequestFields(input: ResponseRequestEcho = {}) {
  return {
    background: input.background ?? false,
    instructions: input.instructions ?? null,
    max_output_tokens: input.maxOutputTokens ?? null,
    max_tool_calls: null,
    metadata: structuredClone(input.metadata ?? {}),
    parallel_tool_calls: input.parallelToolCalls ?? true,
    previous_response_id: input.previousResponseId ?? null,
    reasoning: structuredClone(input.reasoning ?? { effort: null, summary: null }),
    store: input.store ?? true,
    temperature: input.temperature ?? 1,
    text: structuredClone(input.text ?? { format: { type: "text" } }),
    tool_choice: input.toolChoice ?? "auto",
    tools: structuredClone(input.tools ?? []),
    top_p: input.topP ?? 1,
    truncation: "disabled",
    user: input.user ?? null,
  };
}

export function responseMessage(messageId: string, text: string, status = "completed") {
  return {
    id: messageId,
    type: "message" as const,
    status,
    role: "assistant" as const,
    content: [{ type: "output_text" as const, text, annotations: [] }],
  };
}

export function responseOutput(
  result: CanonicalResult,
  messageId: string,
  itemStatus: "completed" | "incomplete" = "completed",
) {
  const output: Record<string, unknown>[] = [];
  if (result.reasoning?.content || result.reasoning?.summary) {
    output.push({
      id: `rs_${crypto.randomUUID()}`,
      type: "reasoning",
      status: itemStatus,
      summary: result.reasoning.summary
        ? [{ type: "summary_text", text: result.reasoning.summary }]
        : [],
      content: result.reasoning.content
        ? [{ type: "reasoning_text", text: result.reasoning.content }]
        : [],
    });
  }
  const content: Record<string, unknown>[] = result.text
    ? [{
      type: "output_text",
      text: result.text,
      annotations: (result.annotations ?? []).map((annotation) => ({
        type: annotation.type,
        start_index: annotation.startIndex,
        end_index: annotation.endIndex,
        title: annotation.title,
        url: annotation.url,
      })),
    }]
    : [];
  if (result.refusal) content.push({ type: "refusal", refusal: result.refusal });
  if (content.length > 0) {
    output.push({
      id: messageId,
      type: "message",
      status: itemStatus,
      role: "assistant",
      content,
    });
  }
  for (const call of result.toolCalls) {
    output.push({
      id: `fc_${crypto.randomUUID()}`,
      type: "function_call",
      status: itemStatus === "incomplete" ? "incomplete" : call.status ?? "completed",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return output;
}

export function responseObject(input: {
  id: string;
  messageId: string;
  model: string;
  createdAt: number;
  status: "in_progress" | "completed" | "incomplete";
  text?: string;
  usage?: ResponseUsage;
  result?: CanonicalResult;
  request?: ResponseRequestEcho;
}) {
  const terminal = input.status !== "in_progress";
  const outputText = terminal ? input.result?.text ?? input.text ?? "" : "";
  return {
    id: input.id,
    object: "response" as const,
    created_at: input.createdAt,
    completed_at: input.status === "completed" ? Math.floor(Date.now() / 1000) : null,
    status: input.status,
    error: null,
    incomplete_details: input.status === "incomplete"
      ? input.result?.finishState === "unknown" ? null : {
        reason: input.result?.finishState === "content_filter"
          ? "content_filter"
          : "max_output_tokens",
      }
      : null,
    model: input.model,
    output_text: outputText,
    ...responseRequestFields(input.request),
    output: terminal
      ? input.result
        ? responseOutput(
          input.result,
          input.messageId,
          input.status === "incomplete" ? "incomplete" : "completed",
        )
        : [
          responseMessage(
            input.messageId,
            input.text ?? "",
            input.status === "incomplete" ? "incomplete" : "completed",
          ),
        ]
      : [],
    usage: input.usage
      ? {
        input_tokens: input.usage.inputTokens,
        input_tokens_details: { cached_tokens: input.usage.cachedInputTokens ?? 0 },
        output_tokens: input.usage.outputTokens,
        output_tokens_details: { reasoning_tokens: input.usage.reasoningTokens ?? 0 },
        total_tokens: input.usage.inputTokens + input.usage.outputTokens,
      }
      : null,
  };
}
