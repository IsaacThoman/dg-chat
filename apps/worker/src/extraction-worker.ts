import { extractDocument } from "./document-extraction.ts";

interface RequestMessage {
  bytes: Uint8Array;
  mimeType: string;
  limits: Record<string, number>;
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  try {
    const result = await extractDocument(event.data.bytes, event.data.mimeType, event.data.limits);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" && "code" in error
          ? String(error.code)
          : undefined,
      },
    });
  }
};
