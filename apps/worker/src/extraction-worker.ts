import { extractDocument } from "./document-extraction.ts";

interface RequestMessage {
  bytes: Uint8Array;
  mimeType: string;
  limits: Record<string, number>;
}

interface ExtractionWorkerScope {
  onmessage: ((event: MessageEvent<RequestMessage>) => void | Promise<void>) | null;
  postMessage(message: unknown): void;
}

// The file is included in the compiled worker binary but executes only inside a Web Worker.
// Keep the worker-global boundary explicit because Deno compile otherwise supplies Window types.
const scope = self as unknown as ExtractionWorkerScope;

scope.onmessage = async (event) => {
  try {
    const result = await extractDocument(event.data.bytes, event.data.mimeType, event.data.limits);
    scope.postMessage({ ok: true, result });
  } catch (error) {
    scope.postMessage({
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
