const port = Number(Deno.env.get("MOCK_PROVIDER_PORT") ?? "4010");
const encoder = new TextEncoder();
const attempts = new Map<string, number>();

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type,idempotency-key",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "content-type": "application/json",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers });
}

function error(message: string, status: number, code: string): Response {
  return json({ error: { message, type: "mock_provider_error", param: null, code } }, status);
}

function modelFrom(body: Record<string, unknown>): string {
  return typeof body.model === "string" ? body.model : "mock-fast";
}

function textFrom(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1) as Record<string, unknown> | undefined;
  if (typeof last?.content === "string") return last.content;
  if (Array.isArray(last?.content)) {
    return last.content.map((part) => {
      const value = part as Record<string, unknown>;
      return value.type === "text" || value.type === "input_text" ? String(value.text ?? "") : "";
    }).join(" ");
  }
  if (typeof body.input === "string") return body.input;
  return "Hello";
}

function completionText(model: string, prompt: string): string {
  if (model.includes("reasoning")) return `The deterministic answer to “${prompt}” is 42.`;
  if (model.includes("tool")) return "I will use the requested tool.";
  return `Mock response: ${prompt}`;
}

function maybeFail(model: string): Response | undefined {
  const attempt = (attempts.get(model) ?? 0) + 1;
  attempts.set(model, attempt);
  if (model.includes("fail-first") && attempt === 1) {
    return error("Intentional first-attempt failure", 503, "mock_retryable");
  }
  if (model.includes("fail")) return error("Intentional provider failure", 503, "mock_failure");
}

function chatStream(model: string, content: string, id: string): Response {
  const words = content.split(/(\s+)/).filter(Boolean);
  const slow = model.includes("slow");
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (value: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      emit({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
      for (const word of words) {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 125));
        emit({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
        });
      }
      emit({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 8,
          completion_tokens: words.length,
          total_tokens: 8 + words.length,
        },
      });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

async function handleChat(request: Request): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const model = modelFrom(body);
  const failure = maybeFail(model);
  if (failure) return failure;
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const prompt = textFrom(body);
  const content = completionText(model, prompt);
  if (body.stream === true) return chatStream(model, content, id);
  return json({
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
  });
}

async function handleResponses(request: Request): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const model = modelFrom(body);
  const failure = maybeFail(model);
  if (failure) return failure;
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const content = completionText(model, textFrom(body));
  if (body.stream === true) {
    const events = [
      {
        type: "response.created",
        response: { id, object: "response", status: "in_progress", model },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_mock",
        output_index: 0,
        content_index: 0,
        delta: content,
      },
      {
        type: "response.output_text.done",
        item_id: "msg_mock",
        output_index: 0,
        content_index: 0,
        text: content,
      },
      {
        type: "response.completed",
        response: { id, object: "response", status: "completed", model },
      },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      {
        headers: { ...headers, "content-type": "text/event-stream" },
      },
    );
  }
  return json({
    id,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_mock",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content, annotations: [] }],
    }],
    usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
  });
}

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (url.pathname === "/health") return json({ status: "ok" });
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return json({
      object: "list",
      data: [
        "mock-fast",
        "mock-slow",
        "mock-reasoning",
        "mock-tool",
        "mock-fail",
        "mock-fail-first",
      ].map((id) => ({ id, object: "model", created: 1_700_000_000, owned_by: "dg-chat-tests" })),
    });
  }
  if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
    return await handleChat(request);
  }
  if (url.pathname === "/v1/responses" && request.method === "POST") {
    return await handleResponses(request);
  }
  if (url.pathname === "/v1/embeddings" && request.method === "POST") {
    const body = await request.json() as Record<string, unknown>;
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return json({
      object: "list",
      model: modelFrom(body),
      data: inputs.map((_, index) => ({
        object: "embedding",
        index,
        embedding: [0.1, 0.2, 0.3, 0.4],
      })),
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    });
  }
  if (url.pathname === "/v1/images/generations" && request.method === "POST") {
    return json({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" }],
    });
  }
  if (url.pathname.startsWith("/v1/audio/") && request.method === "POST") {
    if (url.pathname.endsWith("/speech")) {
      return new Response(new Uint8Array([73, 68, 51]), {
        headers: { "content-type": "audio/mpeg" },
      });
    }
    return json({ text: "Mock transcription" });
  }
  return error(`No mock route for ${request.method} ${url.pathname}`, 404, "not_found");
});
