import type { CanonicalResult } from "./provider-protocol.ts";

export interface ResponseUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
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

export function responseOutput(result: CanonicalResult, messageId: string) {
  const output: Record<string, unknown>[] = [];
  if (result.reasoning?.content || result.reasoning?.summary) {
    output.push({
      id: `rs_${crypto.randomUUID()}`,
      type: "reasoning",
      status: "completed",
      summary: result.reasoning.summary
        ? [{ type: "summary_text", text: result.reasoning.summary }]
        : [],
      content: result.reasoning.content
        ? [{ type: "reasoning_text", text: result.reasoning.content }]
        : [],
    });
  }
  const content: Record<string, unknown>[] = result.content
    .filter((part) => part.type === "text")
    .map((part) => ({ type: "output_text", text: part.text, annotations: [] }));
  if (result.refusal) content.push({ type: "refusal", refusal: result.refusal });
  if (content.length > 0) {
    output.push({
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content,
    });
  }
  for (const call of result.toolCalls) {
    output.push({
      id: `fc_${crypto.randomUUID()}`,
      type: "function_call",
      status: call.status ?? "completed",
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
  status: "in_progress" | "completed";
  text?: string;
  usage?: ResponseUsage;
  result?: CanonicalResult;
}) {
  const completed = input.status === "completed";
  return {
    id: input.id,
    object: "response" as const,
    created_at: input.createdAt,
    completed_at: completed ? Math.floor(Date.now() / 1000) : null,
    status: input.status,
    error: null,
    incomplete_details: null,
    model: input.model,
    output: completed
      ? input.result
        ? responseOutput(input.result, input.messageId)
        : [responseMessage(input.messageId, input.text ?? "")]
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
