const MAX_OPENAI_PARAMETER_BYTES = 256;
const MAX_OPENAI_PARAMETER_SEGMENTS = 32;
const MAX_OPENAI_PARAMETER_NAME_BYTES = 64;
const MAX_OPENAI_PARAMETER_INDEX = 1_000_000;
const safeName = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const unsafeNames = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

type ParameterSegment = string | number;

function safeSegment(segment: PropertyKey): ParameterSegment | undefined {
  if (typeof segment === "number") {
    return Number.isSafeInteger(segment) && segment >= 0 && segment <= MAX_OPENAI_PARAMETER_INDEX
      ? segment
      : undefined;
  }
  if (
    typeof segment !== "string" || !safeName.test(segment) || unsafeNames.has(segment) ||
    encoder.encode(segment).byteLength > MAX_OPENAI_PARAMETER_NAME_BYTES
  ) return undefined;
  return segment;
}

/** Convert a trusted validator path to OpenAI dot/index notation without reflecting hostile keys. */
export function openAIParameterFromSegments(
  path: readonly PropertyKey[] | undefined,
): string | null {
  if (!path?.length || path.length > MAX_OPENAI_PARAMETER_SEGMENTS) return null;
  const segments: ParameterSegment[] = [];
  for (const raw of path) {
    const segment = safeSegment(raw);
    if (segment === undefined) return null;
    segments.push(segment);
  }
  const value = segments.reduce<string>((current, segment) => {
    if (typeof segment === "number") return `${current}[${segment}]`;
    return current.length === 0 ? segment : `${current}.${segment}`;
  }, "");
  return value && encoder.encode(value).byteLength <= MAX_OPENAI_PARAMETER_BYTES ? value : null;
}

/** Select the most specific safe path from Zod issues, including nested union alternatives. */
export function openAIParameterFromZodIssues(issues: unknown): string | null {
  let best: { value: string; depth: number } | undefined;
  let visited = 0;
  const visit = (value: unknown, prefix: readonly PropertyKey[], depth: number): void => {
    if (++visited > 256 || depth > 16 || !Array.isArray(value)) return;
    for (const raw of value) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const issue = raw as Record<string, unknown>;
      const issuePath = Array.isArray(issue.path) ? issue.path as PropertyKey[] : [];
      const combined = [...prefix, ...issuePath];
      const candidate = openAIParameterFromSegments(combined);
      if (candidate && (!best || combined.length > best.depth)) {
        best = { value: candidate, depth: combined.length };
      }
      const alternatives = issue.errors;
      if (Array.isArray(alternatives)) {
        for (const alternative of alternatives) visit(alternative, combined, depth + 1);
      }
    }
  };
  visit(issues, [], 0);
  return best?.value ?? null;
}

/**
 * Accept only the dot/index notation emitted by our protocol converters. Bracketed properties,
 * control characters, and prototype keys are rejected instead of reflected into public errors.
 */
export function safeOpenAIParameter(path: string | undefined | null): string | null {
  if (
    !path || encoder.encode(path).byteLength > MAX_OPENAI_PARAMETER_BYTES ||
    [...path].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  ) return null;
  const segments: ParameterSegment[] = [];
  let offset = 0;
  while (offset < path.length) {
    if (segments.length >= MAX_OPENAI_PARAMETER_SEGMENTS) return null;
    const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(offset))?.[0];
    if (
      !name || unsafeNames.has(name) ||
      encoder.encode(name).byteLength > MAX_OPENAI_PARAMETER_NAME_BYTES
    ) return null;
    segments.push(name);
    offset += name.length;
    while (path[offset] === "[") {
      if (segments.length >= MAX_OPENAI_PARAMETER_SEGMENTS) return null;
      const match = /^\[(0|[1-9]\d{0,6})\]/.exec(path.slice(offset));
      if (!match) return null;
      const index = Number(match[1]);
      if (index > MAX_OPENAI_PARAMETER_INDEX) return null;
      segments.push(index);
      offset += match[0].length;
    }
    if (offset === path.length) break;
    if (path[offset] !== ".") return null;
    offset++;
    if (offset === path.length) return null;
  }
  return openAIParameterFromSegments(segments);
}
