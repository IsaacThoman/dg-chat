export type ProviderProtocol = "chat_completions" | "responses";

export interface ProviderModelInvariantRecord {
  id: string;
  providerId: string;
  publicModelId: string;
  enabled: boolean;
  capabilities: readonly string[];
  customParams: Record<string, unknown>;
}

export interface ProviderInvariantRecord {
  id: string;
  enabled: boolean;
}

export interface ProviderModelInvariantViolation {
  code:
    | "provider_defaults_invalid"
    | "provider_defaults_incompatible"
    | "ocr_target_invalid"
    | "ocr_target_unavailable"
    | "ocr_target_recursive";
  message: string;
}

const CUSTOM_PARAM_KEYS = new Set([
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "stop",
  "response_format",
  "parallel_tool_calls",
  "ocr",
]);
const UNSAFE_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return;
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function safeJson(value: unknown, state: { nodes: number }, depth = 0): boolean {
  state.nodes++;
  if (state.nodes > 512 || depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 8_192;
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  }
  if (Array.isArray(value)) {
    return value.length <= 64 && value.every((item) => safeJson(item, state, depth + 1));
  }
  const record = plainObject(value);
  if (!record) return false;
  const entries = Object.entries(record);
  return entries.length <= 64 &&
    entries.every(([key, item]) =>
      key.length <= 128 && !UNSAFE_JSON_KEYS.has(key) && safeJson(item, state, depth + 1)
    );
}

function boundedNumber(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum &&
    value <= maximum;
}

function integer(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function responseFormatValid(value: unknown): boolean {
  const format = plainObject(value);
  if (!format || !exactKeys(format, ["type", "json_schema"])) return false;
  if (format.type === "text" || format.type === "json_object") {
    return format.json_schema === undefined;
  }
  if (format.type !== "json_schema") return false;
  const schema = plainObject(format.json_schema);
  if (
    !schema || !exactKeys(schema, ["name", "description", "schema", "strict"]) ||
    typeof schema.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(schema.name) ||
    (schema.description !== undefined &&
      (typeof schema.description !== "string" || schema.description.length > 1_024)) ||
    !plainObject(schema.schema) ||
    (schema.strict !== undefined && typeof schema.strict !== "boolean")
  ) return false;
  return true;
}

function ocrValid(value: unknown): boolean {
  const ocr = plainObject(value);
  if (
    !ocr || !exactKeys(ocr, [
      "enabled",
      "providerId",
      "model",
      "prompt",
      "cacheTtlSeconds",
      "timeoutMs",
      "maxBytes",
      "maxPixels",
      "maxDimension",
      "maxRedirects",
    ]) || ocr.enabled !== true
  ) return false;
  for (
    const [field, maximum] of [["providerId", 200], ["model", 200], ["prompt", 8_192]] as const
  ) {
    const fieldValue = ocr[field];
    if (typeof fieldValue !== "string" || !fieldValue.trim() || fieldValue.length > maximum) {
      return false;
    }
  }
  const bounds = {
    cacheTtlSeconds: [1, 2_592_000],
    timeoutMs: [100, 120_000],
    maxBytes: [1_024, 50 * 1024 * 1024],
    maxPixels: [1, 100_000_000],
    maxDimension: [1, 65_535],
    maxRedirects: [0, 5],
  } as const;
  return Object.entries(bounds).every(([field, [minimum, maximum]]) =>
    ocr[field] === undefined || integer(ocr[field], minimum, maximum)
  );
}

/** Full domain validation used by every repository and by staged backup restore. */
export function providerCustomParamsViolation(
  value: unknown,
  modelLabel?: string,
): ProviderModelInvariantViolation | undefined {
  const params = plainObject(value);
  const prefix = modelLabel ? `${modelLabel}: ` : "";
  if (!params || Object.keys(params).some((key) => !CUSTOM_PARAM_KEYS.has(key))) {
    return {
      code: "provider_defaults_invalid",
      message: `${prefix}model custom parameters are invalid`,
    };
  }
  for (const [key, item] of Object.entries(params)) {
    const valid = key === "temperature"
      ? boundedNumber(item, 0, 2)
      : key === "top_p"
      ? boundedNumber(item, 0, 1)
      : key === "presence_penalty" || key === "frequency_penalty"
      ? boundedNumber(item, -2, 2)
      : key === "seed"
      ? integer(item, -2_147_483_648, 2_147_483_647)
      : key === "parallel_tool_calls"
      ? typeof item === "boolean"
      : key === "stop"
      ? (typeof item === "string" && item.length > 0 && item.length <= 1_024) ||
        (Array.isArray(item) && item.length >= 1 && item.length <= 4 &&
          item.every((entry) =>
            typeof entry === "string" && entry.length > 0 && entry.length <= 1_024
          ))
      : key === "response_format"
      ? responseFormatValid(item)
      : key === "ocr"
      ? ocrValid(item)
      : false;
    if (!valid) {
      return {
        code: "provider_defaults_invalid",
        message: `${prefix}customParams.${key} is invalid`,
      };
    }
  }
  if (
    !safeJson(params, { nodes: 0 }) ||
    new TextEncoder().encode(JSON.stringify(params)).length > 16 * 1_024
  ) {
    return {
      code: "provider_defaults_invalid",
      message: `${prefix}model custom parameters exceed safe bounds`,
    };
  }
  return;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function providerDefaultsViolation(
  protocol: ProviderProtocol,
  customParams: Record<string, unknown>,
  modelLabel?: string,
): ProviderModelInvariantViolation | undefined {
  if (protocol !== "responses") return;
  const unsupported = ["presence_penalty", "frequency_penalty", "seed", "stop"]
    .find((key) => customParams[key] !== undefined);
  return unsupported
    ? {
      code: "provider_defaults_incompatible",
      message: `${
        modelLabel ? `${modelLabel}: ` : ""
      }${unsupported} is not supported by Responses providers`,
    }
    : undefined;
}

function ocrReference(customParams: Record<string, unknown>) {
  const ocr = object(customParams.ocr);
  if (
    ocr?.enabled !== true || typeof ocr.providerId !== "string" || typeof ocr.model !== "string"
  ) {
    return;
  }
  return { providerId: ocr.providerId, model: ocr.model };
}

/**
 * Enforces the deliberately one-hop OCR graph. A target may not intercept again or be its own
 * source. This stronger invariant prevents cycles and makes OCR billing/failure context bounded.
 */
export function providerModelOcrGraphViolation(
  models: readonly ProviderModelInvariantRecord[],
): ProviderModelInvariantViolation | undefined {
  const byId = new Map(models.map((model) => [model.id, model]));
  const byPublicId = new Map(models.map((model) => [model.publicModelId, model]));
  for (const source of models) {
    // Disabled sources are inert configuration. Keeping their OCR reference allows an
    // administrator (or a redacted restore) to disable dependencies in either order; re-enabling
    // the source revalidates the complete graph before it can become selectable again.
    if (!source.enabled) continue;
    const reference = ocrReference(source.customParams);
    if (!reference) continue;
    const target = byId.get(reference.model) ?? byPublicId.get(reference.model);
    if (!target || target.providerId !== reference.providerId) {
      return {
        code: "ocr_target_invalid",
        message:
          `OCR target for ${source.publicModelId} does not resolve to its configured provider`,
      };
    }
    if (target.id === source.id || ocrReference(target.customParams)) {
      return {
        code: "ocr_target_recursive",
        message: `OCR target for ${source.publicModelId} cannot intercept OCR itself`,
      };
    }
    if (!target.enabled) {
      return {
        code: "ocr_target_unavailable",
        message: `OCR target for ${source.publicModelId} must remain enabled`,
      };
    }
    if (!target.capabilities.includes("chat") || !target.capabilities.includes("vision")) {
      return {
        code: "ocr_target_invalid",
        message: `OCR target for ${source.publicModelId} must support both chat and vision`,
      };
    }
  }
  return;
}

/**
 * OCR targets are privileged service dependencies, but their provider must still be operational.
 * Keep this check at the persistence boundary so API routes, direct repository callers, and
 * backup restore cannot leave an enabled OCR source pointing at a disabled provider.
 */
export function providerOcrTargetProviderViolation(
  models: readonly ProviderModelInvariantRecord[],
  providers: readonly ProviderInvariantRecord[],
): ProviderModelInvariantViolation | undefined {
  const enabledById = new Map(providers.map((provider) => [provider.id, provider.enabled]));
  for (const source of models) {
    if (!source.enabled) continue;
    const reference = ocrReference(source.customParams);
    if (!reference) continue;
    if (enabledById.get(reference.providerId) !== true) {
      return {
        code: "ocr_target_unavailable",
        message: `OCR target provider for ${source.publicModelId} must remain enabled`,
      };
    }
  }
  return;
}
