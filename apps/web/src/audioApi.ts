export interface TranscriptionInput {
  audio: Blob;
  filename?: string;
  model: string;
  signal?: AbortSignal;
}

type OpenAIErrorBody = {
  error?: { message?: string; code?: string | null };
};

export class AudioApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "AudioApiError";
  }
}

export async function transcribeAudio(input: TranscriptionInput): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    input.audio,
    input.filename ?? `recording.${extensionForMime(input.audio.type)}`,
  );
  form.append("model", input.model);
  form.append("response_format", "json");
  const response = await fetch("/api/audio/transcriptions", {
    method: "POST",
    body: form,
    credentials: "include",
    signal: input.signal,
  });
  let body: ({ text?: unknown } & OpenAIErrorBody) | undefined;
  try {
    body = await response.json();
  } catch {
    // The normalized error below is safer and more useful than a JSON parse failure.
  }
  if (!response.ok) {
    throw new AudioApiError(
      response.status,
      body?.error?.code ?? "transcription_failed",
      body?.error?.message ?? "Voice transcription failed. Please try again.",
    );
  }
  if (typeof body?.text !== "string") {
    throw new AudioApiError(
      502,
      "invalid_transcription_response",
      "The transcription response was invalid.",
    );
  }
  return body.text.trim();
}

export function extensionForMime(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("wav")) return "wav";
  return "webm";
}
