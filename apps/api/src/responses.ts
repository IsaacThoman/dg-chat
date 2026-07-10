export interface ResponseUsage {
  inputTokens: number;
  outputTokens: number;
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

export function responseObject(input: {
  id: string;
  messageId: string;
  model: string;
  createdAt: number;
  status: "in_progress" | "completed";
  text?: string;
  usage?: ResponseUsage;
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
    output: completed ? [responseMessage(input.messageId, input.text ?? "")] : [],
    usage: input.usage
      ? {
        input_tokens: input.usage.inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: input.usage.outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: input.usage.inputTokens + input.usage.outputTokens,
      }
      : null,
  };
}
