import OpenAI, { toFile } from "npm:openai@6.16.0";

const apiKey = Deno.env.get("OPENAI_API_KEY");
const baseURL = Deno.env.get("OPENAI_BASE_URL") ?? "http://localhost:8000/v1";
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
const model = "openai/mock-fast";

const models = await client.models.list();
if (!models.data.some((candidate) => candidate.id === "openai/default")) {
  throw new Error("Official JavaScript client did not receive the configured upstream model");
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
