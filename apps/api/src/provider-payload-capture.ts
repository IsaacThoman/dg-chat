const MAX_CAPTURE_BYTES = 1_048_576;
const MAX_STREAM_FRAMES = 10_000;
const encoder = new TextEncoder();
const sensitiveKey =
  /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|headers?)/iu;
const embeddedSecret = /(?:\b(?:Bearer|Basic)\s+|\bsk-[A-Za-z0-9_-]{8,})/iu;
const embeddedWebUrl = /https?:\/\//iu;
const connectionUrl =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/)/iu;
const signedQuery = /[?&](?:x-amz-[^=&#]*|x-goog-[^=&#]*|signature|sig|token)=/iu;
const base64Media = /(?:data:[^,;]+;base64,|\b[A-Za-z0-9+/_-]{256,}={0,2}\b)/u;

function unsafeString(value: string): boolean {
  return embeddedSecret.test(value) || embeddedWebUrl.test(value) || connectionUrl.test(value) ||
    signedQuery.test(value) || base64Media.test(value);
}

function sanitized(value: unknown, active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (unsafeString(value)) return "[SENSITIVE STRING OMITTED]";
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return "[BINARY OMITTED]";
  if (typeof value !== "object") return "[UNSUPPORTED OMITTED]";
  if (active.has(value)) return "[CYCLE OMITTED]";
  active.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitized(item, active));
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sensitiveKey.test(key) ? "[SECRET OMITTED]" : sanitized(item, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

/** Returns a bounded diagnostic JSON body, or null when safe capture would exceed 1 MiB. */
export function providerDiagnosticBody(value: unknown): string | null {
  let body: string;
  try {
    body = JSON.stringify(sanitized(value));
  } catch {
    return null;
  }
  return encoder.encode(body).byteLength <= MAX_CAPTURE_BYTES ? body : null;
}

/** Builds the only error shape permitted in diagnostic capture; never includes stacks or headers. */
export function providerDiagnosticError(error: unknown): {
  name: string;
  status: number | null;
  code: string | null;
  message: string;
} {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const options = value.options && typeof value.options === "object"
    ? value.options as Record<string, unknown>
    : {};
  const bounded = (candidate: unknown, maximum: number, fallback: string | null) =>
    typeof candidate === "string" && candidate ? candidate.slice(0, maximum) : fallback;
  const rawStatus = options.status ?? value.status ?? value.providerStatus;
  const status = Number.isSafeInteger(rawStatus) && Number(rawStatus) >= 100 &&
      Number(rawStatus) <= 599
    ? Number(rawStatus)
    : null;
  return {
    name: bounded(value.name, 120, "Error")!,
    status,
    code: bounded(value.code ?? options.category, 120, null),
    message: bounded(value.message, 4_096, "Provider request failed")!,
  };
}

export class ProviderStreamDiagnostic {
  #events: unknown[] = [];
  #omitted = false;
  #budgetBytes = encoder.encode('{"events":[]}').byteLength;

  observe(frame: string): void {
    if (this.#omitted) return;
    // Reserve fixed headroom for JSON punctuation and conservative sanitizer expansion without
    // repeatedly serializing the entire accumulated stream.
    this.#budgetBytes += encoder.encode(frame).byteLength + 32;
    if (this.#events.length >= MAX_STREAM_FRAMES || this.#budgetBytes > MAX_CAPTURE_BYTES) {
      this.#events = [];
      this.#omitted = true;
      return;
    }
    let value: unknown = frame;
    if (frame !== "[DONE]") {
      try {
        value = JSON.parse(frame);
      } catch {
        // Preserve bounded non-JSON provider diagnostics as text.
      }
    }
    this.#events.push(value);
  }

  body(): string | null {
    return this.#omitted ? null : providerDiagnosticBody({ events: this.#events });
  }
}
