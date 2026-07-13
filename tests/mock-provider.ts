const port = Number(Deno.env.get("MOCK_PROVIDER_PORT") ?? "4010");
const apiKey = Deno.env.get("MOCK_PROVIDER_API_KEY") ?? "ci-mock-provider-key";
const controlToken = Deno.env.get("MOCK_PROVIDER_CONTROL_TOKEN") ?? "ci-mock-control-token";
const encoder = new TextEncoder();
const attempts = new Map<string, number>();

interface AudioState {
  calls: number;
  lastAuthorized: boolean;
  lastEndpoint: string | null;
  lastModel: string | null;
  lastFilename: string | null;
  lastMime: string | null;
  lastBytes: number;
  sawStream: boolean;
  sawDiarization: boolean;
}

const audio: AudioState = {
  calls: 0,
  lastAuthorized: false,
  lastEndpoint: null,
  lastModel: null,
  lastFilename: null,
  lastMime: null,
  lastBytes: 0,
  sawStream: false,
  sawDiarization: false,
};

const speech = {
  calls: 0,
  aborted: 0,
  lastModel: null as string | null,
  lastVoice: null as unknown,
  lastFormat: null as string | null,
  sawCustomVoice: false,
  sawSse: false,
};

const images = {
  calls: 0,
  lastAuthorized: false,
  lastModel: null as string | null,
  lastResponseFormat: null as string | null,
  lastCount: 0,
  lastPrompt: null as string | null,
};

// Valid 1x1 PNG. The API decodes and validates dimensions before persistence.
const imagePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

interface ScenarioState {
  opened: number;
  completed: number;
  aborted: number;
  lastAccept: string | null;
  lastAuthorized: boolean;
  lastStream: boolean;
  lastPath: string | null;
  lastHasInput: boolean;
  lastHasMessages: boolean;
  responsesPathViolations: number;
  responsesMissingInput: number;
  responsesMessagesViolations: number;
  authorizationViolations: number;
  sawResponsesTools: boolean;
  sawResponsesImage: boolean;
  sawResponsesToolResult: boolean;
}

const scenarios = new Map<string, ScenarioState>();

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

function authorized(request: Request, expected: string): boolean {
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

function controlAuthorized(request: Request): boolean {
  return authorized(request, controlToken);
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
  if (Array.isArray(body.input)) {
    for (const raw of [...body.input].reverse()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      if (!Array.isArray(item.content)) continue;
      const text = item.content.map((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return "";
        const value = part as Record<string, unknown>;
        return value.type === "text" || value.type === "input_text" ? String(value.text ?? "") : "";
      }).filter(Boolean).join(" ");
      if (text) return text;
    }
  }
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
  if (model.includes("error") || model.includes("fail")) {
    return error("Intentional provider failure", 503, "mock_failure");
  }
}

function stateFor(model: string): ScenarioState {
  const state = scenarios.get(model) ?? {
    opened: 0,
    completed: 0,
    aborted: 0,
    lastAccept: null,
    lastAuthorized: false,
    lastStream: false,
    lastPath: null,
    lastHasInput: false,
    lastHasMessages: false,
    responsesPathViolations: 0,
    responsesMissingInput: 0,
    responsesMessagesViolations: 0,
    authorizationViolations: 0,
    sawResponsesTools: false,
    sawResponsesImage: false,
    sawResponsesToolResult: false,
  };
  scenarios.set(model, state);
  return state;
}

function observe(request: Request, model: string, body: Record<string, unknown>): ScenarioState {
  const state = stateFor(model);
  state.opened++;
  state.lastAccept = request.headers.get("accept");
  state.lastAuthorized = authorized(request, apiKey);
  state.lastStream = body.stream === true;
  state.lastPath = new URL(request.url).pathname;
  state.lastHasInput = Object.hasOwn(body, "input");
  state.lastHasMessages = Object.hasOwn(body, "messages");
  if (!state.lastAuthorized) state.authorizationViolations++;
  if (model === "mock-responses") {
    if (state.lastPath !== "/v1/responses") state.responsesPathViolations++;
    if (!state.lastHasInput) state.responsesMissingInput++;
    if (state.lastHasMessages) state.responsesMessagesViolations++;
    state.sawResponsesTools ||= Array.isArray(body.tools) && body.tools.length > 0;
    const input = Array.isArray(body.input) ? body.input as Record<string, unknown>[] : [];
    state.sawResponsesImage ||= input.some((item) =>
      Array.isArray(item.content) &&
      (item.content as Record<string, unknown>[]).some((part) => part.type === "input_image")
    );
    state.sawResponsesToolResult ||= input.some((item) => item.type === "function_call_output");
  }
  return state;
}

function chatChunk(
  model: string,
  id: string,
  delta: Record<string, unknown>,
  finish: string | null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function normalChatStream(
  request: Request,
  model: string,
  content: string,
  id: string,
  state: ScenarioState,
): Response {
  const words = content.split(/(\s+)/).filter(Boolean);
  const slow = model.includes("slow");
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        state.aborted++;
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      const emit = (value: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      try {
        emit(chatChunk(model, id, { role: "assistant", content: "" }, null));
        for (const word of words) {
          if (slow) await new Promise((resolve) => setTimeout(resolve, 125));
          if (aborted) return;
          emit(chatChunk(model, id, { content: word }, null));
        }
        emit({
          ...chatChunk(model, id, {}, "stop"),
          usage: {
            prompt_tokens: 8,
            completion_tokens: words.length,
            total_tokens: 8 + words.length,
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        state.completed++;
      } catch (streamError) {
        if (!aborted) controller.error(streamError);
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    },
  });
  return new Response(stream, {
    headers: { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function splitChatStream(
  model: string,
  content: string,
  id: string,
  state: ScenarioState,
): Response {
  const role = JSON.stringify(chatChunk(model, id, { role: "assistant", content: "" }, null));
  const delta = JSON.stringify(chatChunk(model, id, { content }, null));
  const splitAt = delta.indexOf('"choices"');
  const finish = JSON.stringify({
    ...chatChunk(model, id, {}, "stop"),
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  });
  const wire = [
    ": keepalive\r",
    `\ndata: ${role}\r\n\r`,
    `\ndata: ${delta.slice(0, splitAt)}`,
    `\ndata: ${delta.slice(splitAt)}\n\n`,
    `data: ${finish}\n\n`,
    "data: [DO",
    "NE]\n\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of wire) controller.enqueue(encoder.encode(part));
      controller.close();
      state.completed++;
    },
  });
  return new Response(stream, {
    headers: { ...headers, "content-type": "text/event-stream; charset=utf-8" },
  });
}

function roleStallStream(
  request: Request,
  model: string,
  id: string,
  state: ScenarioState,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify(chatChunk(model, id, { role: "assistant" }, null))}\n\n`,
      ));
      const onAbort = () => {
        state.aborted++;
        try {
          controller.close();
        } catch {
          // A downstream cancellation may already have closed the controller.
        }
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      state.aborted++;
    },
  });
  return new Response(stream, {
    headers: { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

async function handleChat(request: Request): Promise<Response> {
  if (!authorized(request, apiKey)) return error("Invalid mock provider key", 401, "unauthorized");
  const body = await request.json() as Record<string, unknown>;
  const model = modelFrom(body);
  const state = observe(request, model, body);
  const failure = maybeFail(model);
  if (failure) return failure;
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const prompt = textFrom(body);
  const content = completionText(model, prompt);
  if (body.stream === true) {
    if (model.includes("split")) return splitChatStream(model, content, id, state);
    if (model.includes("role-stall")) return roleStallStream(request, model, id, state);
    return normalChatStream(request, model, content, id, state);
  }
  state.completed++;
  return json({
    id,
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
  });
}

async function handleResponses(request: Request): Promise<Response> {
  if (!authorized(request, apiKey)) return error("Invalid mock provider key", 401, "unauthorized");
  const body = await request.json() as Record<string, unknown>;
  const model = modelFrom(body);
  const state = observe(request, model, body);
  const failure = maybeFail(model);
  if (failure) return failure;
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const content = completionText(model, textFrom(body));
  const tools = Array.isArray(body.tools) ? body.tools as Record<string, unknown>[] : [];
  const requestedTool = tools[0];
  if (requestedTool) {
    state.completed++;
    return json({
      id,
      object: "response",
      status: "completed",
      model,
      output: [{
        id: "fc_mock",
        type: "function_call",
        status: "completed",
        call_id: "call_mock_weather",
        name: String(requestedTool.name ?? "lookup_weather"),
        arguments: '{"city":"New York"}',
      }],
      usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
    });
  }
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
        response: {
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
        },
      },
    ];
    state.completed++;
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { ...headers, "content-type": "text/event-stream" } },
    );
  }
  state.completed++;
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
  if (url.pathname === "/__test/reset" && request.method === "POST") {
    if (!controlAuthorized(request)) return error("Invalid control token", 401, "unauthorized");
    attempts.clear();
    scenarios.clear();
    Object.assign(audio, {
      calls: 0,
      lastAuthorized: false,
      lastEndpoint: null,
      lastModel: null,
      lastFilename: null,
      lastMime: null,
      lastBytes: 0,
      sawStream: false,
      sawDiarization: false,
    });
    Object.assign(speech, {
      calls: 0,
      aborted: 0,
      lastModel: null,
      lastVoice: null,
      lastFormat: null,
      sawCustomVoice: false,
      sawSse: false,
    });
    Object.assign(images, {
      calls: 0,
      lastAuthorized: false,
      lastModel: null,
      lastResponseFormat: null,
      lastCount: 0,
      lastPrompt: null,
    });
    return json({ reset: true });
  }
  if (url.pathname === "/__test/state" && request.method === "GET") {
    if (!controlAuthorized(request)) return error("Invalid control token", 401, "unauthorized");
    return json({
      attempts: Object.fromEntries(attempts),
      scenarios: Object.fromEntries(scenarios),
      audio,
      speech,
      images,
    });
  }
  if (url.pathname === "/v1/models" && request.method === "GET") {
    if (!authorized(request, apiKey)) {
      return error("Invalid mock provider key", 401, "unauthorized");
    }
    return json({
      object: "list",
      data: [
        "mock-fast",
        "mock-split",
        "mock-error",
        "mock-role-stall",
        "mock-slow",
        "mock-reasoning",
        "mock-tool",
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
    if (!authorized(request, apiKey)) {
      return error("Invalid mock provider key", 401, "unauthorized");
    }
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
    if (!authorized(request, apiKey)) {
      return error("Invalid mock provider key", 401, "unauthorized");
    }
    const body = await request.json() as Record<string, unknown>;
    images.calls++;
    images.lastAuthorized = true;
    images.lastModel = typeof body.model === "string" ? body.model : null;
    images.lastResponseFormat = typeof body.response_format === "string"
      ? body.response_format
      : null;
    images.lastCount = typeof body.n === "number" ? body.n : 1;
    images.lastPrompt = typeof body.prompt === "string" ? body.prompt : null;
    if (body.stream === true) {
      const partial = {
        type: "image_generation.partial_image",
        b64_json: imagePngBase64,
        created_at: 1_700_000_000,
        partial_image_index: 0,
      };
      const completed = {
        type: "image_generation.completed",
        b64_json: imagePngBase64,
        created_at: 1_700_000_001,
      };
      return new Response(
        (Number(body.partial_images ?? 0) > 0
          ? `event: ${partial.type}\ndata: ${JSON.stringify(partial)}\n\n`
          : "") +
          `event: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return json({
      created: 1_700_000_000,
      data: Array.from({ length: images.lastCount }, () => ({
        b64_json: imagePngBase64,
        revised_prompt: images.lastPrompt,
      })),
    });
  }
  if (url.pathname === "/v1/images/edits" && request.method === "POST") {
    if (!authorized(request, apiKey)) {
      return error("Invalid mock provider key", 401, "unauthorized");
    }
    const form = await request.formData();
    const model = String(form.get("model") ?? "");
    const prompt = String(form.get("prompt") ?? "");
    const inputs = [...form.getAll("image"), ...form.getAll("image[]")];
    const mixedImageFields = form.has("image") && form.has("image[]");
    if (
      !model || !prompt || !inputs.length || mixedImageFields ||
      (inputs.length > 1 && !form.has("image[]")) ||
      inputs.some((input) => !(input instanceof File))
    ) {
      return error("Invalid image edit multipart", 400, "invalid_request");
    }
    images.calls++;
    images.lastAuthorized = true;
    images.lastModel = model;
    images.lastPrompt = prompt;
    images.lastResponseFormat = String(form.get("response_format") ?? "");
    if (form.get("stream") === "true") {
      const completed = {
        type: "image_edit.completed",
        b64_json: imagePngBase64,
        created_at: 1_700_000_002,
      };
      return new Response(`event: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return json({
      created: 1_700_000_002,
      data: [{ b64_json: imagePngBase64, revised_prompt: prompt }],
    });
  }
  if (url.pathname.startsWith("/v1/audio/") && request.method === "POST") {
    if (!authorized(request, apiKey)) {
      return error("Invalid mock provider key", 401, "unauthorized");
    }
    if (url.pathname.endsWith("/speech")) {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return error("Invalid speech JSON", 400, "invalid_json");
      }
      if (
        typeof body.model !== "string" || typeof body.input !== "string" || !body.input ||
        !(typeof body.voice === "string" ||
          (body.voice && typeof body.voice === "object" && !Array.isArray(body.voice) &&
            typeof (body.voice as Record<string, unknown>).id === "string")) ||
        (body.speed !== undefined &&
          (typeof body.speed !== "number" || body.speed < 0.25 || body.speed > 4))
      ) return error("Invalid speech request", 400, "invalid_request");
      speech.calls++;
      speech.lastModel = body.model;
      speech.lastVoice = body.voice;
      speech.lastFormat = typeof body.response_format === "string" ? body.response_format : "mp3";
      speech.sawCustomVoice ||= typeof body.voice === "object";
      if (body.input === "__slow_cancel__") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const aborted = () => {
                speech.aborted++;
                controller.error(request.signal.reason);
              };
              request.signal.addEventListener("abort", aborted, { once: true });
            },
          }),
          { headers: { "content-type": "audio/mpeg" } },
        );
      }
      if (body.stream_format === "sse") {
        speech.sawSse = true;
        return new Response(
          'event: speech.audio.delta\nid: mock-delta\nretry: 1000\ndata: {"type":"speech.audio.delta","audio":"YXVkaW8="}\n\n' +
            'event: speech.audio.done\nid: mock-done\ndata: {"type":"speech.audio.done","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (body.response_format === "wav") {
        const wav = new Uint8Array(12);
        wav.set(encoder.encode("RIFF"));
        wav.set(encoder.encode("WAVE"), 8);
        return new Response(wav, { headers: { "content-type": "audio/wav" } });
      }
      return new Response(
        new Uint8Array([
          73,
          68,
          51,
          4,
          0,
          0,
          0,
          0,
          0,
          0,
          0xff,
          0xfb,
          0x90,
          0x64,
        ]),
        {
          headers: { "content-type": "audio/mpeg" },
        },
      );
    }
    const form = await request.formData();
    const file = form.get("file");
    audio.calls++;
    audio.lastAuthorized = authorized(request, apiKey);
    audio.lastEndpoint = url.pathname.split("/").at(-1) ?? null;
    audio.lastModel = typeof form.get("model") === "string" ? String(form.get("model")) : null;
    audio.lastFilename = file instanceof File ? file.name : null;
    audio.lastMime = file instanceof File ? file.type : null;
    audio.lastBytes = file instanceof File ? file.size : 0;
    if (!(file instanceof File) || !file.size || !audio.lastModel) {
      return error("Invalid audio multipart body", 400, "invalid_multipart");
    }
    const streaming = form.get("stream") === "true";
    const diarized = form.get("response_format") === "diarized_json";
    audio.sawStream ||= streaming;
    audio.sawDiarization ||= diarized && form.get("chunking_strategy") === "auto" &&
      form.get("known_speaker_names[]") === "agent" &&
      form.get("known_speaker_references[]") === "data:audio/wav;base64,UklGRg==";
    if (streaming) {
      return new Response(
        'data: {"type":"transcript.text.delta","delta":"Mock "}\n\n' +
          'data: {"type":"transcript.text.done","text":"Mock transcription","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (diarized) {
      return json({
        task: "transcribe",
        duration: 1,
        text: "Mock transcription",
        segments: [{
          type: "transcript.text.segment",
          id: "seg_1",
          start: 0,
          end: 1,
          text: "Mock transcription",
          speaker: "agent",
        }],
      });
    }
    return json({
      text: audio.lastEndpoint === "translations" ? "Mock translation" : "Mock transcription",
    });
  }
  return error(`No mock route for ${request.method} ${url.pathname}`, 404, "not_found");
});
