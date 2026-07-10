import type { DocumentChunkInput, ObjectStore, StoredObject } from "@dg-chat/database";
import postgres from "npm:postgres@3.4.7";
import type { ClaimedJob } from "./job-queue.ts";

type Sql = ReturnType<typeof postgres>;

export interface AttachmentIngestionPayload {
  attachmentId: string;
  ownerId: string;
}

export function parseAttachmentIngestionPayload(payload: unknown): AttachmentIngestionPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("attachment.ingest payload must be an object");
  }
  const { attachmentId, ownerId } = payload as Record<string, unknown>;
  if (typeof attachmentId !== "string" || typeof ownerId !== "string") {
    throw new Error("attachment.ingest payload is missing attachmentId or ownerId");
  }
  return { attachmentId, ownerId };
}

export async function requireIngestionObject(store: ObjectStore, key: string) {
  const object = await store.get(key);
  if (!object) throw new Error("Attachment object is missing");
  return object;
}

export async function recordIngestionFailure(
  sql: Sql,
  job: ClaimedJob,
  payload: AttachmentIngestionPayload,
  message: string,
  maxAttempts = 5,
): Promise<boolean> {
  const retry = job.attempts + 1 < maxAttempts;
  return await sql.begin(async (tx) => {
    const fenced = await tx`SELECT id FROM jobs WHERE id=${job.id} AND status='running'
      AND locked_by=${job.claimToken} FOR UPDATE`;
    if (!fenced.length) return false;
    await tx`UPDATE attachments SET ingestion_status=${retry ? "queued" : "failed"},
      ingestion_error=${message.slice(0, 1000)},updated_at=now()
      WHERE id=${payload.attachmentId} AND owner_id=${payload.ownerId}
        AND deleted_at IS NULL AND ingestion_status IN ('queued','processing')`;
    await tx`UPDATE jobs SET status=${retry ? "queued" : "failed"},last_error=${message},
      available_at=now() + ${Math.min(300, 2 ** job.attempts)} * interval '1 second',
      locked_at=NULL,locked_by=NULL WHERE id=${job.id}`;
    return true;
  });
}

export async function readIngestionText(
  object: StoredObject,
  mimeType: string,
  maxBytes = 4 * 1024 * 1024,
  timeoutMs = 30_000,
  expectedSha256?: string,
): Promise<string> {
  if (object.contentLength !== null && object.contentLength > maxBytes) {
    throw new Error("Attachment exceeds the ingestion byte limit");
  }
  const reader = object.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void reader.cancel("Ingestion timed out");
  }, timeoutMs);
  let text = "";
  let bytes = 0;
  const rawChunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error("Attachment ingestion timed out");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Attachment exceeds the ingestion byte limit");
      rawChunks.push(value.slice());
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (timedOut) throw new Error("Attachment ingestion timed out");
  } catch (error) {
    if (error instanceof TypeError) throw new Error("Attachment is not valid UTF-8 text");
    throw error;
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (expectedSha256) {
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of rawChunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    const actual = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (actual !== expectedSha256) {
      throw new Error("Attachment object digest does not match its record");
    }
  }
  text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (mimeType === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      throw new Error("Attachment is not valid JSON");
    }
  }
  return text;
}

async function stableChunkId(seed: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}

function newlineOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    offsets.push(index);
  }
  return offsets;
}

function codePointBoundary(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset;
  const before = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
    ? offset - 1
    : offset;
}

function lineAt(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

export async function deterministicChunks(input: {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  text: string;
  chunkChars?: number;
  overlapChars?: number;
}): Promise<DocumentChunkInput[]> {
  const chunkChars = input.chunkChars ?? 4000;
  const overlap = input.overlapChars ?? 400;
  if (chunkChars < 2 || overlap < 0 || overlap >= chunkChars) {
    throw new TypeError("Invalid chunk bounds");
  }
  if (!input.text) return [];
  const chunks: DocumentChunkInput[] = [];
  const newlines = newlineOffsets(input.text);
  for (let start = 0, ordinal = 0; start < input.text.length; ordinal++) {
    let end = codePointBoundary(input.text, Math.min(input.text.length, start + chunkChars));
    if (end < input.text.length) {
      const newline = input.text.lastIndexOf("\n", end);
      if (newline > start + Math.floor(chunkChars / 2)) end = newline + 1;
    }
    const content = input.text.slice(start, end);
    chunks.push({
      id: await stableChunkId(`${input.attachmentId}:${input.sha256}:${ordinal}:${start}:${end}`),
      ordinal,
      content,
      metadata: {
        sourceAttachmentId: input.attachmentId,
        filename: input.filename,
        mimeType: input.mimeType,
        sha256: input.sha256,
        startLine: lineAt(newlines, start),
        endLine: lineAt(newlines, Math.max(start, end - 1)),
        charStart: start,
        charEnd: end,
      },
    });
    if (end === input.text.length) break;
    const overlapped = codePointBoundary(input.text, end - overlap);
    start = overlapped > start
      ? overlapped
      : start + (input.text.codePointAt(start)! > 0xffff ? 2 : 1);
  }
  return chunks;
}
