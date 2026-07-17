export interface DerivedSignal {
  signal: AbortSignal;
  dispose(): void;
}

export interface RetentionPreviewFence {
  policyVersion: number;
  requestCutoffAt: string;
  responseCutoffAt: string;
}

export interface RetentionScrubRequest {
  expectedPolicyVersion: number;
  idempotencyKey: string;
  requestCutoffAt: string;
  responseCutoffAt: string;
}

/**
 * Retention cutoffs are server-issued fences, not durations the load client may reconstruct.
 * Keeping the preview timestamps byte-for-byte also avoids weakening a longer current policy.
 */
export function retentionScrubRequest(
  preview: RetentionPreviewFence,
  idempotencyKey: string,
): RetentionScrubRequest {
  if (
    !Number.isSafeInteger(preview.policyVersion) || preview.policyVersion < 1 ||
    !Number.isFinite(Date.parse(preview.requestCutoffAt)) ||
    !Number.isFinite(Date.parse(preview.responseCutoffAt))
  ) {
    throw new TypeError("Retention preview fence is invalid");
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new TypeError("Retention scrub idempotency key is invalid");
  }
  return {
    expectedPolicyVersion: preview.policyVersion,
    idempotencyKey,
    requestCutoffAt: preview.requestCutoffAt,
    responseCutoffAt: preview.responseCutoffAt,
  };
}

export function derivedTimeoutSignal(
  parent: AbortSignal,
  timeoutMs: number,
  label: string,
): DerivedSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Timeout must be a positive safe integer");
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onParentAbort, { once: true });
  if (parent.aborted) onParentAbort();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`${label} timed out`, "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export interface TimedSseFrame {
  atMs: number;
  event: string | null;
  data: string;
  json?: Record<string, unknown>;
}

export interface LiveSseResult {
  headerAtMs: number;
  frames: TimedSseFrame[];
  disconnected: boolean;
  completedAtMs: number;
}

function parseFrame(raw: string, atMs: number): TimedSseFrame | undefined {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return undefined;
  const value = data.join("\n");
  let json: Record<string, unknown> | undefined;
  if (value.startsWith("{")) {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
  }
  return { atMs, event, data: value, ...(json ? { json } : {}) };
}

/**
 * Reads SSE from the network as bytes arrive. Frame timestamps are captured before any configured
 * slow-consumer delay, so proxy buffering and upstream gaps cannot hide behind final body timing.
 */
export async function consumeLiveSse(
  response: Response,
  options: {
    signal: AbortSignal;
    startedAtMs: number;
    headerAtMs: number;
    slowReaderDelayMs?: number;
    disconnectAfterDataFrames?: number;
  },
): Promise<LiveSseResult> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: TimedSseFrame[] = [];
  let buffer = "";
  let disconnected = false;
  try {
    while (true) {
      if (options.signal.aborted) throw options.signal.reason;
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      while (true) {
        const boundary = buffer.search(/\r?\n\r?\n/u);
        if (boundary < 0) break;
        const raw = buffer.slice(0, boundary);
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/u)!;
        buffer = buffer.slice(boundary + match[0].length);
        const frame = parseFrame(raw, performance.now() - options.startedAtMs);
        if (frame) frames.push(frame);
        if (
          options.disconnectAfterDataFrames !== undefined &&
          frames.length >= options.disconnectAfterDataFrames
        ) {
          disconnected = true;
          await reader.cancel("intentional load-harness disconnect");
          return {
            headerAtMs: options.headerAtMs,
            frames,
            disconnected,
            completedAtMs: performance.now() - options.startedAtMs,
          };
        }
      }
      if (options.slowReaderDelayMs) {
        await abortableDelay(options.slowReaderDelayMs, options.signal);
      }
    }
    const tail = parseFrame(buffer + decoder.decode(), performance.now() - options.startedAtMs);
    if (tail) frames.push(tail);
    return {
      headerAtMs: options.headerAtMs,
      frames,
      disconnected,
      completedAtMs: performance.now() - options.startedAtMs,
    };
  } finally {
    reader.releaseLock();
  }
}

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) throw new Error("Cannot calculate a percentile of an empty sample");
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}
