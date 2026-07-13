import OpenAI, { toFile } from "npm:openai@6.16.0";

const apiKey = Deno.env.get("OPENAI_API_KEY");
const baseURL = Deno.env.get("OPENAI_BASE_URL") ?? "http://localhost:8000/v1";
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
const model = "openai/mock-fast";
const responsesModel = "contracts-responses/mock-responses";
const embeddingModel = "contracts/mock-embedding";
const audioModel = "contracts/mock-transcribe";
const imageModel = "contracts/mock-image";
const speechBytes = new Uint8Array([
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
]);

function wavFile(): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 2, true);
  return bytes;
}

const models = await client.models.list();
if (!models.data.some((candidate) => candidate.id === "openai/default")) {
  throw new Error("Official JavaScript client did not receive the configured upstream model");
}
if (!models.data.some((candidate) => candidate.id === embeddingModel)) {
  throw new Error("Official JavaScript client did not receive the embeddings model");
}
if (!models.data.some((candidate) => candidate.id === audioModel)) {
  throw new Error("Official JavaScript client did not receive the transcription model");
}
if (!models.data.some((candidate) => candidate.id === imageModel)) {
  throw new Error("Official JavaScript client did not receive the image generation model");
}
if (!models.data.some((candidate) => candidate.id === responsesModel)) {
  throw new Error("Official JavaScript client did not receive the native Responses model");
}

const imageReplayKey = `javascript-image-${crypto.randomUUID()}`;
const createImage = () =>
  client.images.generate({
    model: imageModel,
    prompt: "JavaScript image contract",
    n: 1,
    response_format: "b64_json",
    size: "1024x1024",
  }, { headers: { "Idempotency-Key": imageReplayKey } });
const firstImage = await createImage();
const replayedImage = await createImage();
const imageBase64 = firstImage.data?.[0]?.b64_json;
if (!imageBase64 || replayedImage.data?.[0]?.b64_json !== imageBase64) {
  throw new Error("JavaScript images.generate() or its exact replay was invalid");
}
const imageBytes = Uint8Array.from(atob(imageBase64), (character) => character.charCodeAt(0));
const alternateImageBytes = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
if (new TextDecoder().decode(imageBytes.subarray(1, 4)) !== "PNG") {
  throw new Error("JavaScript images.generate() did not return a valid PNG signature");
}
const editedImage = await client.images.edit({
  model: imageModel,
  prompt: "JavaScript image edit contract",
  image: [
    await toFile(imageBytes, "edit-source-one.png", { type: "image/png" }),
    await toFile(alternateImageBytes, "edit-source-two.png", { type: "image/png" }),
  ],
  response_format: "b64_json",
});
if (editedImage.data?.[0]?.b64_json !== imageBase64) {
  throw new Error("JavaScript images.edit() did not return a valid edited image");
}
const editStream = await client.images.edit({
  model: imageModel,
  prompt: "JavaScript streaming image edit contract",
  image: await toFile(imageBytes, "edit-stream-source.png", { type: "image/png" }),
  stream: true,
  partial_images: 0,
  response_format: "b64_json",
});
let completedEdit = false;
for await (const event of editStream) {
  if (event.type === "image_edit.completed" && event.b64_json === imageBase64) {
    completedEdit = true;
  }
}
if (!completedEdit) throw new Error("JavaScript images.edit() stream was invalid");
const imageStreamKey = `javascript-image-stream-${crypto.randomUUID()}`;
const streamImage = () =>
  fetch(`${baseURL}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": imageStreamKey,
    },
    body: JSON.stringify({
      model: imageModel,
      prompt: "JavaScript streaming image contract",
      stream: true,
      partial_images: 0,
      response_format: "b64_json",
    }),
  });
const streamedImage = await streamImage();
const streamedImageBody = await streamedImage.text();
if (
  !streamedImage.ok || !streamedImage.headers.get("content-type")?.includes("text/event-stream") ||
  streamedImageBody.indexOf("image_generation.completed") < 0
) throw new Error("Raw JavaScript streaming image contract was invalid");
const replayedImageStream = await streamImage();
if (
  replayedImageStream.headers.get("x-idempotent-replay") !== "true" ||
  await replayedImageStream.text() !== streamedImageBody
) throw new Error("Raw JavaScript streaming image replay was not exact");
try {
  await client.images.generate({
    model: imageModel,
    prompt: "Invalid image count",
    n: 0,
    response_format: "b64_json",
  });
  throw new Error("JavaScript malformed image request was accepted");
} catch (error) {
  if (
    error instanceof Error && error.message === "JavaScript malformed image request was accepted"
  ) {
    throw error;
  }
  if (!(error instanceof OpenAI.APIError) || error.status !== 422) {
    throw new Error("JavaScript malformed image request did not return compatible 422", {
      cause: error,
    });
  }
}

const speech = await client.audio.speech.create({
  model: audioModel,
  input: "JavaScript speech contract",
  voice: "alloy",
});
if (JSON.stringify(new Uint8Array(await speech.arrayBuffer())) !== JSON.stringify(speechBytes)) {
  throw new Error("JavaScript audio.speech.create() returned invalid MP3 bytes");
}
const speechReplayKey = `javascript-speech-${crypto.randomUUID()}`;
const customSpeech = () =>
  client.audio.speech.create({
    model: audioModel,
    input: "Custom voice contract",
    // The service supports the current OpenAI custom-voice object even though SDK 6.16's
    // generated TypeScript union still only lists built-in string voices.
    voice: { id: "voice_contract" } as unknown as "alloy",
    instructions: "Warmly",
    response_format: "wav",
    speed: 1.25,
  }, { headers: { "Idempotency-Key": speechReplayKey } });
const firstSpeech = new Uint8Array(await (await customSpeech()).arrayBuffer());
const replayedSpeech = new Uint8Array(await (await customSpeech()).arrayBuffer());
if (
  new TextDecoder().decode(firstSpeech.subarray(0, 4)) !== "RIFF" ||
  JSON.stringify(firstSpeech) !== JSON.stringify(replayedSpeech)
) throw new Error("JavaScript custom WAV speech or exact replay was invalid");
const speechSse = await client.audio.speech.create({
  model: audioModel,
  input: "Stream speech",
  voice: "alloy",
  stream_format: "sse",
});
const speechSseText = await speechSse.text();
if (
  !speechSseText.includes("speech.audio.delta") ||
  (speechSseText.match(/speech\.audio\.done/g)?.length ?? 0) !== 1
) throw new Error("JavaScript speech SSE contract was invalid");
try {
  await client.audio.speech.create({
    model: audioModel,
    input: "Invalid speed",
    voice: "alloy",
    speed: 5,
  });
  throw new Error("JavaScript malformed speech request was accepted");
} catch (error) {
  if (
    error instanceof Error && error.message === "JavaScript malformed speech request was accepted"
  ) throw error;
  if (!(error instanceof OpenAI.APIError) || error.status !== 422) {
    throw new Error("JavaScript malformed speech did not return compatible 422", { cause: error });
  }
}
const speechAbort = new AbortController();
const cancelledSpeech = client.audio.speech.create({
  model: audioModel,
  input: "__slow_cancel__",
  voice: "alloy",
}, { signal: speechAbort.signal });
setTimeout(() => speechAbort.abort(), 20);
try {
  await cancelledSpeech;
  throw new Error("JavaScript cancelled speech request completed");
} catch (error) {
  if (error instanceof Error && error.message === "JavaScript cancelled speech request completed") {
    throw error;
  }
}

const transcription = await client.audio.transcriptions.create({
  file: await toFile(wavFile(), "javascript-contract.wav", { type: "audio/wav" }),
  model: audioModel,
});
if (transcription.text !== "Mock transcription") {
  throw new Error("JavaScript audio.transcriptions.create() returned an invalid response");
}

const transcriptionStream = await client.audio.transcriptions.create({
  file: await toFile(wavFile(), "javascript-stream.wav", { type: "audio/wav" }),
  model: audioModel,
  stream: true,
  include: ["logprobs"],
});
let streamedTranscription = "";
let transcriptionUsage = 0;
for await (const event of transcriptionStream) {
  if (event.type === "transcript.text.delta") streamedTranscription += event.delta;
  if (event.type === "transcript.text.done") transcriptionUsage = event.usage?.total_tokens ?? 0;
}
if (streamedTranscription !== "Mock " || transcriptionUsage !== 5) {
  throw new Error("JavaScript streaming transcription contract was invalid");
}

const diarized = await client.audio.transcriptions.create({
  file: await toFile(wavFile(), "javascript-diarized.wav", { type: "audio/wav" }),
  model: audioModel,
  response_format: "diarized_json",
  chunking_strategy: "auto",
  known_speaker_names: ["agent"],
  known_speaker_references: ["data:audio/wav;base64,UklGRg=="],
});
const diarizedSegments = (diarized as typeof diarized & {
  segments?: Array<{ speaker?: string }>;
}).segments;
if (diarized.text !== "Mock transcription" || diarizedSegments?.[0]?.speaker !== "agent") {
  throw new Error("JavaScript diarized transcription contract was invalid");
}

const replayKey = `javascript-audio-${crypto.randomUUID()}`;
const replayRequest = async () =>
  client.audio.translations.create({
    file: await toFile(wavFile(), "javascript-translation.wav", { type: "audio/wav" }),
    model: audioModel,
  }, { headers: { "Idempotency-Key": replayKey } });
const firstTranslation = await replayRequest();
const replayedTranslation = await replayRequest();
if (
  firstTranslation.text !== "Mock translation" || replayedTranslation.text !== firstTranslation.text
) {
  throw new Error("JavaScript audio.translations.create() or its idempotent replay was invalid");
}
try {
  await client.audio.transcriptions.create({
    file: await toFile(wavFile(), "javascript-invalid.wav", { type: "audio/wav" }),
    model: audioModel,
    language: "not_a_language",
  });
  throw new Error("JavaScript malformed audio request was accepted");
} catch (error) {
  if (
    error instanceof Error && error.message === "JavaScript malformed audio request was accepted"
  ) {
    throw error;
  }
  if (!(error instanceof OpenAI.APIError) || error.status !== 422) {
    throw new Error("JavaScript malformed audio request did not return a compatible 422", {
      cause: error,
    });
  }
}

const embeddings = await client.embeddings.create({
  model: embeddingModel,
  input: ["JavaScript embeddings one", "JavaScript embeddings two"],
  encoding_format: "float",
});
if (
  embeddings.object !== "list" || embeddings.model !== embeddingModel ||
  embeddings.data.length !== 2 || embeddings.data[0]?.index !== 0 ||
  embeddings.data[1]?.index !== 1 ||
  JSON.stringify(embeddings.data[0]?.embedding) !== JSON.stringify([0.1, 0.2, 0.3, 0.4]) ||
  embeddings.usage.prompt_tokens !== 2 || embeddings.usage.total_tokens !== 2
) {
  throw new Error("JavaScript embeddings.create() returned an invalid response");
}

const completion = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "JavaScript SDK contract" }],
});
const completionText = completion.choices[0]?.message.content;
if (!completionText?.includes("JavaScript SDK contract")) {
  throw new Error("JavaScript non-streaming completion did not contain the expected content");
}

const stream = await client.chat.completions.create({
  model,
  stream: true,
  messages: [{ role: "user", content: "JavaScript streaming contract" }],
});
let streamedText = "";
for await (const chunk of stream) streamedText += chunk.choices[0]?.delta.content ?? "";
if (!streamedText.includes("JavaScript streaming contract")) {
  throw new Error("JavaScript streaming completion did not contain the expected content");
}

const nullableCompletion = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "JavaScript nullable Chat contract" }],
  temperature: null,
  max_completion_tokens: null,
  stop: null,
});
if (!nullableCompletion.choices[0]?.message.content?.includes("nullable Chat contract")) {
  throw new Error("JavaScript Chat Completions rejected nullable SDK parameters");
}

const response = await client.responses.create({
  model,
  input: "JavaScript Responses contract",
});
if (!response.output_text.includes("JavaScript Responses contract")) {
  throw new Error("JavaScript Responses result did not contain the expected content");
}

const responseStream = await client.responses.create({
  model,
  input: "JavaScript Responses streaming contract",
  stream: true,
});
let responseStreamText = "";
for await (const event of responseStream) {
  if (event.type === "response.output_text.delta") responseStreamText += event.delta;
}
if (!responseStreamText.includes("JavaScript Responses streaming contract")) {
  throw new Error("JavaScript Responses stream did not contain the expected content");
}

const nullableResponseStream = await client.responses.create({
  model,
  input: "JavaScript nullable Responses contract",
  instructions: null,
  stream: true,
  stream_options: { include_obfuscation: false },
  temperature: null,
  top_p: null,
  parallel_tool_calls: null,
  max_output_tokens: null,
  reasoning: null,
});
let nullableResponseText = "";
for await (const event of nullableResponseStream) {
  if (event.type === "response.output_text.delta") nullableResponseText += event.delta;
}
if (!nullableResponseText.includes("nullable Responses contract")) {
  throw new Error("JavaScript Responses rejected nullable SDK or disabled obfuscation options");
}

const nativeCompletion = await client.chat.completions.create({
  model: responsesModel,
  messages: [{ role: "user", content: "JavaScript native Responses chat contract" }],
});
if (!nativeCompletion.choices[0]?.message.content?.includes("native Responses chat contract")) {
  throw new Error("JavaScript Chat Completions did not translate through a Responses upstream");
}
const nativeToolCompletion = await client.chat.completions.create({
  model: responsesModel,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Inspect this image and look up the weather" },
      {
        type: "image_url",
        image_url: {
          url:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
          detail: "low",
        },
      },
    ],
  }],
  tools: [{
    type: "function",
    function: {
      name: "lookup_weather",
      description: "Look up weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      strict: true,
    },
  }],
  tool_choice: { type: "function", function: { name: "lookup_weather" } },
});
const nativeToolCall = nativeToolCompletion.choices[0]?.message.tool_calls?.[0];
if (
  nativeToolCompletion.choices[0]?.finish_reason !== "tool_calls" ||
  nativeToolCall?.type !== "function" || nativeToolCall.function.name !== "lookup_weather" ||
  JSON.parse(nativeToolCall.function.arguments).city !== "New York"
) {
  throw new Error("JavaScript native Responses tool or multimodal translation was invalid");
}
const nativeToolResult = await client.chat.completions.create({
  model: responsesModel,
  messages: [
    { role: "user", content: "Use the weather tool" },
    { role: "assistant", content: null, tool_calls: [nativeToolCall] },
    {
      role: "tool",
      tool_call_id: nativeToolCall.id,
      content: '{"temperature":72}',
    },
  ],
});
if (!nativeToolResult.choices[0]?.message.content?.includes("Mock response")) {
  throw new Error("JavaScript native Responses tool-result history was not translated");
}
const nativeCompletionStream = await client.chat.completions.create({
  model: responsesModel,
  stream: true,
  messages: [{ role: "user", content: "JavaScript native Responses chat stream" }],
});
let nativeCompletionText = "";
for await (const chunk of nativeCompletionStream) {
  nativeCompletionText += chunk.choices[0]?.delta.content ?? "";
}
if (!nativeCompletionText.includes("native Responses chat stream")) {
  throw new Error("JavaScript streaming Chat Completions did not use a Responses upstream");
}
const nativeResponse = await client.responses.create({
  model: responsesModel,
  input: "JavaScript native Responses public contract",
});
if (!nativeResponse.output_text.includes("native Responses public contract")) {
  throw new Error("JavaScript Responses API did not use a native Responses upstream");
}
const nativeResponseStream = await client.responses.create({
  model: responsesModel,
  input: "JavaScript native Responses public stream",
  stream: true,
});
let nativeResponseText = "";
const nativeResponseEvents: Array<Record<string, unknown>> = [];
for await (const event of nativeResponseStream) {
  nativeResponseEvents.push(event as unknown as Record<string, unknown>);
  if (event.type === "response.output_text.delta") nativeResponseText += event.delta;
}
if (!nativeResponseText.includes("native Responses public stream")) {
  throw new Error("JavaScript streaming Responses API did not use a native Responses upstream");
}
if (
  nativeResponseEvents[0]?.type !== "response.created" ||
  nativeResponseEvents[1]?.type !== "response.in_progress" ||
  nativeResponseEvents.at(-1)?.type !== "response.completed" ||
  nativeResponseEvents.some((event, index) => event.sequence_number !== index)
) {
  throw new Error("JavaScript Responses stream lifecycle or sequence numbers were invalid");
}
const nativeTerminal = nativeResponseEvents.at(-1)?.response as Record<string, unknown> | undefined;
if (
  nativeTerminal?.status !== "completed" || !Array.isArray(nativeTerminal.output) ||
  !(nativeTerminal.usage && typeof nativeTerminal.usage === "object")
) throw new Error("JavaScript Responses stream terminal snapshot was incomplete");

const managedResponseStream = client.responses.stream({
  model: responsesModel,
  input: "JavaScript managed Responses stream contract",
});
const managedResponse = await managedResponseStream.finalResponse();
if (
  managedResponse.status !== "completed" ||
  !managedResponse.output_text.includes("managed Responses stream contract") ||
  !managedResponse.usage || managedResponse.usage.total_tokens <= 0
) throw new Error("JavaScript responses.stream().finalResponse() contract failed");

const fileText = `JavaScript files contract ${crypto.randomUUID()}\n`;
const fileName = `javascript-contract-${crypto.randomUUID()}.txt`;
const uploaded = await client.files.create({
  file: await toFile(new TextEncoder().encode(fileText), fileName, { type: "text/plain" }),
  purpose: "assistants",
});
let deleted = false;
try {
  if (
    uploaded.object !== "file" || uploaded.filename !== fileName ||
    uploaded.bytes !== new TextEncoder().encode(fileText).byteLength ||
    uploaded.status !== "processed"
  ) {
    throw new Error("JavaScript files.create() returned an invalid file object");
  }

  const files = await client.files.list();
  if (
    !Array.isArray(files.data) || files.has_more !== false ||
    !files.data.some((file) => file.id === uploaded.id)
  ) {
    throw new Error("JavaScript files.list() did not include the uploaded file");
  }

  const retrieved = await client.files.retrieve(uploaded.id);
  if (retrieved.id !== uploaded.id || retrieved.filename !== fileName) {
    throw new Error("JavaScript files.retrieve() returned the wrong file");
  }

  const content = await client.files.content(uploaded.id);
  if (await content.text() !== fileText) {
    throw new Error("JavaScript files.content() did not preserve the uploaded bytes");
  }

  const result = await client.files.delete(uploaded.id);
  deleted = true;
  if (result.id !== uploaded.id || result.object !== "file" || result.deleted !== true) {
    throw new Error("JavaScript files.delete() returned an invalid deletion object");
  }

  try {
    await client.files.retrieve(uploaded.id);
    throw new Error("JavaScript deleted file remained retrievable");
  } catch (error) {
    if (
      error instanceof Error && error.message === "JavaScript deleted file remained retrievable"
    ) {
      throw error;
    }
    if (!(error instanceof OpenAI.APIError) || error.status !== 404) {
      throw new Error("JavaScript deleted file did not return an OpenAI-compatible 404", {
        cause: error,
      });
    }
  }
} finally {
  if (!deleted) await client.files.delete(uploaded.id).catch(() => undefined);
}

async function expectApiError(
  label: string,
  request: Promise<unknown>,
  status: number,
  code?: string,
) {
  try {
    await request;
    throw new Error(`${label} was accepted`);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} was accepted`) throw error;
    if (
      !(error instanceof OpenAI.APIError) || error.status !== status ||
      (code !== undefined && error.code !== code)
    ) {
      throw new Error(`${label} did not return the expected OpenAI error`, { cause: error });
    }
  }
}

await expectApiError(
  "JavaScript malformed Chat Completions request",
  client.chat.completions.create({ model, messages: [] }),
  422,
);
await expectApiError(
  "JavaScript malformed Responses request",
  client.responses.create({ model, input: [], max_output_tokens: -1 }),
  422,
);

const rateApiKey = Deno.env.get("CONTRACT_JS_RATE_API_KEY");
const emptyCreditApiKey = Deno.env.get("CONTRACT_EMPTY_CREDIT_API_KEY");
if (!rateApiKey || !emptyCreditApiKey) {
  throw new Error("JavaScript governance contract API keys are required");
}
const rateClient = new OpenAI({ apiKey: rateApiKey, baseURL, maxRetries: 0 });
await rateClient.models.list();
await expectApiError(
  "JavaScript token rate limit",
  rateClient.models.list(),
  429,
  "rate_limit_exceeded",
);
const emptyCreditClient = new OpenAI({ apiKey: emptyCreditApiKey, baseURL, maxRetries: 0 });
await expectApiError(
  "JavaScript insufficient credit request",
  emptyCreditClient.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Must not dispatch without credit" }],
  }),
  402,
  "insufficient_credit",
);

console.log("Official OpenAI JavaScript client contracts passed");
