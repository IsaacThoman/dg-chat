import type { ChatCompletionRequest, ModelInfo } from "@dg-chat/contracts";

export const models: ModelInfo[] = [
  {
    id: "simulated/dg-chat",
    displayName: "DG Chat Simulated",
    provider: "simulated",
    capabilities: ["chat", "streaming", "tools", "vision"],
    contextWindow: 128000,
    inputMicrosPerMillion: 100_000,
    outputMicrosPerMillion: 300_000,
  },
  {
    id: "openai/default",
    displayName: "Configured OpenAI model",
    provider: "openai-compatible",
    capabilities: ["chat", "streaming", "tools", "vision"],
    contextWindow: 128000,
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 3_000_000,
  },
];

export function contentText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) =>
    typeof part.text === "string" ? part.text : part.type === "image_url" ? "[image]" : ""
  ).filter(Boolean).join("\n");
}

export function simulate(request: ChatCompletionRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  const prompt = last ? contentText(last.content) : "Hello";
  return `This is a simulated response to: ${prompt}`;
}

function providerEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  const privateHost = host === "localhost" || host === "::1" || host === "0.0.0.0" ||
    host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "169.254.169.254";
  if (url.protocol !== "https:" && !(Deno.env.get("DENO_ENV") !== "production" && privateHost)) {
    throw new Error("Provider URL must use HTTPS");
  }
  if (Deno.env.get("DENO_ENV") === "production" && privateHost) {
    throw new Error("Provider URL may not target a private network");
  }
  return `${url.toString().replace(/\/$/, "")}/chat/completions`;
}

export async function complete(
  request: ChatCompletionRequest,
  signal: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number; upstream?: unknown }> {
  const inputTokens = Math.max(1, Math.ceil(JSON.stringify(request.messages).length / 4));
  if (request.model.startsWith("simulated/")) {
    const text = simulate(request);
    return { text, inputTokens, outputTokens: Math.ceil(text.length / 4) };
  }
  const baseUrl = Deno.env.get("OPENAI_BASE_URL");
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!baseUrl || !apiKey) throw new Error("The OpenAI-compatible provider is not configured");
  const upstreamModel = request.model === "openai/default"
    ? (Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini")
    : request.model.replace(/^openai\//, "");
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetch(providerEndpoint(baseUrl), {
    method: "POST",
    signal: AbortSignal.any([signal, timeout]),
    redirect: "error",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ...request, model: upstreamModel, stream: false }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      (payload as { error?: { message?: string } }).error?.message ??
        `Provider returned ${response.status}`,
    );
  }
  const data = payload as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? inputTokens,
    outputTokens: data.usage?.completion_tokens ?? Math.ceil(text.length / 4),
    upstream: payload,
  };
}
