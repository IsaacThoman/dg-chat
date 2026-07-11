import OpenAI, { toFile } from "npm:openai@6.16.0";

const apiKey = Deno.env.get("OPENAI_API_KEY");
const baseURL = Deno.env.get("OPENAI_BASE_URL") ?? "http://localhost:8000/v1";
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
const model = "openai/mock-fast";
const embeddingModel = "contracts/mock-embedding";
const audioModel = "contracts/mock-transcribe";

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

console.log("Official OpenAI JavaScript client contracts passed");
