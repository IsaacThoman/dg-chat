const MAX_CAPTURE_BYTES = 1_048_576;
const MAX_STREAM_FRAMES = 10_000;
const encoder = new TextEncoder();
const embeddedSecret =
  /(?:\b(?:Bearer|Basic)\s+|\b(?:sk|rk|pk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,})/iu;
const cloudCredential =
  /(?:\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{30,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;
const secretAssignment =
  /(?:["']?\b(?:authorization|proxy[-_ ]?authorization|api[-_ ]?key|x[-_ ]?api[-_ ]?key|subscription[-_ ]?key|access[-_ ]?key|secret[-_ ]?(?:access[-_ ]?)?key|client[-_ ]?secret|password|token|signature|credential)\b["']?\s*[:=]\s*["']?[^\s"',;}]+)/iu;
const opaqueCredential = /[A-Za-z0-9+/_=]{32,}/gu;
const hexCredential = /\b[a-f0-9]{32,}\b/iu;
const uuidCredential = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const embeddedWebUrl = /https?:\/\//iu;
const connectionUrl =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/)/iu;
const signedQuery =
  /[?&](?:x-amz-[^=&#]*|x-goog-[^=&#]*|googleaccessid|signature|sig|token|se|sp|sv|sr)=/iu;
const base64Media = /(?:data:[^,;]+;base64,|\b[A-Za-z0-9+/_-]{256,}={0,2}\b)/u;
const MAX_CANONICALIZATION_PASSES = 12;
const exactSensitiveKeys = new Set([
  "authorization",
  "proxy_authorization",
  "auth",
  "cookie",
  "set_cookie",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "access_key",
  "private_key",
  "public_key",
  "client_secret",
  "signing_key",
  "header",
  "headers",
  "key",
]);

function normalizedKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function isSensitiveKey(value: string): boolean {
  const key = normalizedKey(value);
  if (exactSensitiveKeys.has(key)) return true;
  const collapsed = key.replaceAll("_", "");
  if (/^(?:x|aws|google|openai|anthropic|provider)?apikey(?:value|hash)?$/u.test(collapsed)) {
    return true;
  }
  const segments = key.split("_").filter(Boolean);
  if (["value", "hash"].includes(segments.at(-1) ?? "")) segments.pop();
  const last = segments.at(-1);
  if (
    ["auth", "token", "password", "secret", "authorization", "credential"].includes(last ?? "")
  ) {
    return true;
  }
  if (
    last === "header" && segments.some((segment) => ["auth", "authorization"].includes(segment))
  ) {
    return true;
  }
  if (last !== "key") return false;
  if (segments.join("_") === "x_functions_key") return true;
  return segments.some((segment) =>
    [
      "api",
      "xapi",
      "subscription",
      "access",
      "private",
      "public",
      "client",
      "signing",
      "secret",
    ].includes(segment)
  );
}

function containsOpaqueCredential(value: string): boolean {
  opaqueCredential.lastIndex = 0;
  for (const match of value.matchAll(opaqueCredential)) {
    const candidate = match[0];
    // Long unbroken credential material is unsafe even without a recognizable prefix. Require
    // either mixed character classes or base64 punctuation so ordinary prose is not discarded.
    if (
      (/[a-z]/u.test(candidate) && /[A-Z]/u.test(candidate) && /[0-9]/u.test(candidate)) ||
      /[+/_=]/u.test(candidate)
    ) return true;
  }
  return false;
}

function containsHyphenatedCredential(value: string): boolean {
  // Generic mixed-case/digit phrases include ordinary model and protocol names. Known credential
  // prefixes are handled by `embeddedSecret`; only exact UUID syntax is safe to classify here.
  return uuidCredential.test(value);
}

function hasFormCredentialMarker(value: string): boolean {
  return /(?:\b(?:bearer|basic|authorization|proxy[-_ ]?authorization|api[-_ ]?key|x[-_ ]?api[-_ ]?key|subscription[-_ ]?key|access[-_ ]?key|client[-_ ]?secret|password|token|signature|credential)\b["']?\s*(?:[:=]\s*)?)\+/iu
    .test(value);
}

function canonicalStrings(value: string): { values: string[]; ambiguous: boolean } {
  const values = [value];
  let current = value;
  for (let pass = 0; pass < MAX_CANONICALIZATION_PASSES; pass++) {
    let next = current
      .replace(/&amp;/giu, "&")
      .replace(/(?:&#0*61;|&#x0*3d;|&equals;)/giu, "=")
      .replace(/(?:&#0*58;|&#x0*3a;|&colon;)/giu, ":");
    if (next.includes("+") && hasFormCredentialMarker(next)) next = next.replaceAll("+", " ");
    if (/%[0-9a-f]{2}/iu.test(next)) {
      try {
        next = decodeURIComponent(next);
      } catch {
        return { values, ambiguous: true };
      }
    }
    if (next === current) return { values, ambiguous: false };
    current = next;
    values.push(current);
  }
  const pending = /(?:&amp;|&#0*(?:58|61);|&#x0*(?:3a|3d);|&(?:colon|equals);|%[0-9a-f]{2})/iu.test(
    current,
  );
  return { values, ambiguous: pending };
}

function directlyUnsafeString(value: string): boolean {
  return embeddedSecret.test(value) || cloudCredential.test(value) ||
    secretAssignment.test(value) || hexCredential.test(value) ||
    containsOpaqueCredential(value) || containsHyphenatedCredential(value) ||
    embeddedWebUrl.test(value) || connectionUrl.test(value) || signedQuery.test(value) ||
    base64Media.test(value) || containsSerializedSensitiveKeys(value);
}

function containsSerializedSensitiveKeys(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const visit = (item: unknown, active = new WeakSet<object>()): boolean => {
    if (!item || typeof item !== "object") return false;
    if (active.has(item)) return true;
    active.add(item);
    try {
      if (Array.isArray(item)) return item.some((entry) => visit(entry, active));
      return Object.entries(item).some(([key, entry]) =>
        isSensitiveKey(key) || isErrorLikeKey(key) || visit(entry, active)
      );
    } finally {
      active.delete(item);
    }
  };
  return visit(parsed);
}

function unsafeString(value: string): boolean {
  const canonical = canonicalStrings(value);
  return canonical.ambiguous || canonical.values.some(directlyUnsafeString);
}

function isErrorLikeKey(value: string): boolean {
  return normalizedKey(value).split("_").some((segment) =>
    ["error", "errors", "exception", "exceptions", "failed", "failure", "failures"].includes(
      segment,
    )
  );
}

function isAllowedErrorProjection(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 && keys.includes("category") && keys.includes("status") &&
    typeof record.category === "string" &&
    providerErrorCategories.has(record.category as ProviderDiagnosticCategory) &&
    (record.status === null ||
      (Number.isSafeInteger(record.status) && Number(record.status) >= 100 &&
        Number(record.status) <= 599));
}

function safeErrorSubtree(value: unknown, active: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (isAllowedErrorProjection(value)) return sanitized(value, active);
  if (Array.isArray(value) && value.every(isAllowedErrorProjection)) {
    return value.map((item) => sanitized(item, active));
  }
  return "[ERROR DETAIL OMITTED]";
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
      output[key] = isSensitiveKey(key)
        ? "[SECRET OMITTED]"
        : isErrorLikeKey(key)
        ? safeErrorSubtree(item, active)
        : sanitized(item, active);
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

const providerErrorCategories = new Set(
  [
    "aborted",
    "timeout",
    "rate_limited",
    "upstream_unavailable",
    "network",
    "authentication",
    "invalid_request",
    "invalid_response",
    "unknown",
  ] as const,
);

type ProviderDiagnosticCategory =
  | "aborted"
  | "timeout"
  | "rate_limited"
  | "upstream_unavailable"
  | "network"
  | "authentication"
  | "invalid_request"
  | "invalid_response"
  | "unknown";

function diagnosticCategory(
  value: Record<string, unknown>,
  options: Record<string, unknown>,
  status: number | null,
): ProviderDiagnosticCategory {
  const explicit = options.category;
  if (
    typeof explicit === "string" &&
    providerErrorCategories.has(explicit as ProviderDiagnosticCategory)
  ) return explicit as ProviderDiagnosticCategory;
  const name = typeof value.name === "string" ? value.name : "";
  if (name === "AbortError") return "aborted";
  if (name === "TimeoutError") return "timeout";
  if (status === 401 || status === 403) return "authentication";
  if (status === 408 || status === 425 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 500) return "upstream_unavailable";
  if (status !== null && status >= 400) return "invalid_request";
  if (value instanceof TypeError) return "network";
  return "unknown";
}

/** Builds the only error shape permitted in diagnostic capture; never includes free-form text. */
export function providerDiagnosticError(error: unknown): {
  category: ProviderDiagnosticCategory;
  status: number | null;
} {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const options = value.options && typeof value.options === "object"
    ? value.options as Record<string, unknown>
    : {};
  const rawStatus = options.status ?? value.status ?? value.providerStatus;
  const status = Number.isSafeInteger(rawStatus) && Number(rawStatus) >= 100 &&
      Number(rawStatus) <= 599
    ? Number(rawStatus)
    : null;
  return {
    category: diagnosticCategory(value, options, status),
    status,
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
