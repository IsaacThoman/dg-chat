import type {
  CreateModelPriceVersionInput,
  CreateProviderInput,
  CreateProviderModelInput,
  UpdateProviderInput,
  UpdateProviderModelInput,
} from "@dg-chat/database";
import { isModelCapability, type ModelCapability } from "@dg-chat/contracts";
import { normalizeProviderBaseUrl } from "./provider-admin.ts";

export class ProviderValidationError extends Error {}

export const MAX_PROVIDER_CONTEXT_WINDOW = 4_194_304;
export const MAX_PROVIDER_CUSTOM_PARAMS_BYTES = 16 * 1024;
const MAX_PROVIDER_CUSTOM_PARAMS_DEPTH = 8;
const MAX_PROVIDER_CUSTOM_PARAMS_NODES = 512;
const MAX_PROVIDER_CUSTOM_PARAMS_ARRAY = 64;
const MAX_PROVIDER_CUSTOM_PARAMS_STRING = 8_192;
const UNSAFE_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
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

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderValidationError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ProviderValidationError(`Unknown field '${unknown}'`);
}

function string(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ProviderValidationError(`${name} is invalid`);
  }
  return value.trim();
}

function integer(
  value: unknown,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ProviderValidationError(`${name} is invalid`);
  }
  return Number(value);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ProviderValidationError(`${name} is invalid`);
  return value;
}

export function providerCreate(value: unknown): CreateProviderInput {
  const body = record(value);
  exact(body, ["slug", "displayName", "baseUrl", "protocol", "enabled"]);
  const slug = string(body.slug, "slug", 63).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new ProviderValidationError("slug is invalid");
  }
  if (body.protocol !== "chat_completions" && body.protocol !== "responses") {
    throw new ProviderValidationError("protocol is invalid");
  }
  return {
    slug,
    displayName: string(body.displayName, "displayName", 120),
    baseUrl: normalizeProviderBaseUrl(string(body.baseUrl, "baseUrl", 2_048)),
    protocol: body.protocol,
    enabled: optionalBoolean(body.enabled, "enabled"),
  };
}

export function providerPatch(
  value: unknown,
): { expectedVersion: number; patch: UpdateProviderInput } {
  const body = record(value);
  exact(body, ["expectedVersion", "displayName", "baseUrl", "protocol", "enabled"]);
  const expectedVersion = integer(body.expectedVersion, "expectedVersion", 1);
  const patch: UpdateProviderInput = {};
  if (body.displayName !== undefined) {
    patch.displayName = string(body.displayName, "displayName", 120);
  }
  if (body.baseUrl !== undefined) {
    patch.baseUrl = normalizeProviderBaseUrl(string(body.baseUrl, "baseUrl", 2_048));
  }
  if (body.protocol !== undefined) {
    if (body.protocol !== "chat_completions" && body.protocol !== "responses") {
      throw new ProviderValidationError("protocol is invalid");
    }
    patch.protocol = body.protocol;
  }
  patch.enabled = optionalBoolean(body.enabled, "enabled");
  if (Object.values(patch).every((item) => item === undefined)) {
    throw new ProviderValidationError("At least one provider field must change");
  }
  return { expectedVersion, patch };
}

export function providerCredential(value: unknown): { expectedVersion: number; secret: string } {
  const body = record(value);
  exact(body, ["expectedVersion", "credential"]);
  if (
    typeof body.credential !== "string" || !body.credential.trim() ||
    body.credential.length > 32_768
  ) throw new ProviderValidationError("credential is invalid");
  return {
    expectedVersion: integer(body.expectedVersion, "expectedVersion", 1),
    secret: body.credential,
  };
}

export function providerExpectedVersion(value: unknown): number {
  const body = record(value);
  exact(body, ["expectedVersion"]);
  return integer(body.expectedVersion, "expectedVersion", 1);
}

function capabilities(value: unknown): ModelCapability[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ProviderValidationError("capabilities are invalid");
  }
  const result = value.map((item) => string(item, "capability", 64));
  if (new Set(result).size !== result.length) {
    throw new ProviderValidationError("capabilities must be unique");
  }
  if (result.some((item) => !isModelCapability(item))) {
    throw new ProviderValidationError("capabilities contain an unsupported value");
  }
  return result as ModelCapability[];
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderValidationError(`${name} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProviderValidationError(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ProviderValidationError(`${name} is invalid`);
  }
  return value;
}

function assertSafeJson(
  value: unknown,
  path: string,
  state: { nodes: number },
  depth = 0,
): void {
  state.nodes++;
  if (state.nodes > MAX_PROVIDER_CUSTOM_PARAMS_NODES || depth > MAX_PROVIDER_CUSTOM_PARAMS_DEPTH) {
    throw new ProviderValidationError(`${path} exceeds the safe JSON complexity limit`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_PROVIDER_CUSTOM_PARAMS_STRING) {
      throw new ProviderValidationError(`${path} contains an oversized string`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new ProviderValidationError(`${path} contains an invalid number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PROVIDER_CUSTOM_PARAMS_ARRAY) {
      throw new ProviderValidationError(`${path} contains an oversized array`);
    }
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`, state, depth + 1));
    return;
  }
  const object = plainRecord(value, path);
  const entries = Object.entries(object);
  if (entries.length > 64) throw new ProviderValidationError(`${path} has too many fields`);
  for (const [key, item] of entries) {
    if (key.length > 128 || UNSAFE_JSON_KEYS.has(key)) {
      throw new ProviderValidationError(`${path} contains an unsafe field`);
    }
    assertSafeJson(item, `${path}.${key}`, state, depth + 1);
  }
}

function responseFormat(value: unknown): Record<string, unknown> {
  const format = plainRecord(value, "customParams.response_format");
  exact(format, ["type", "json_schema"]);
  if (
    typeof format.type !== "string" ||
    !["text", "json_object", "json_schema"].includes(format.type)
  ) {
    throw new ProviderValidationError("customParams.response_format.type is invalid");
  }
  if (format.type !== "json_schema") {
    if (format.json_schema !== undefined) {
      throw new ProviderValidationError(
        "customParams.response_format.json_schema requires type json_schema",
      );
    }
    return structuredClone(format);
  }
  const schema = plainRecord(
    format.json_schema,
    "customParams.response_format.json_schema",
  );
  exact(schema, ["name", "description", "schema", "strict"]);
  const name = string(schema.name, "customParams.response_format.json_schema.name", 64);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new ProviderValidationError("customParams.response_format.json_schema.name is invalid");
  }
  if (schema.description !== undefined && typeof schema.description !== "string") {
    throw new ProviderValidationError(
      "customParams.response_format.json_schema.description is invalid",
    );
  }
  if (typeof schema.description === "string" && schema.description.length > 1_024) {
    throw new ProviderValidationError(
      "customParams.response_format.json_schema.description is invalid",
    );
  }
  const jsonSchema = plainRecord(
    schema.schema,
    "customParams.response_format.json_schema.schema",
  );
  if (schema.strict !== undefined && typeof schema.strict !== "boolean") {
    throw new ProviderValidationError("customParams.response_format.json_schema.strict is invalid");
  }
  return {
    type: "json_schema",
    json_schema: {
      name,
      ...(schema.description === undefined ? {} : { description: schema.description }),
      schema: structuredClone(jsonSchema),
      ...(schema.strict === undefined ? {} : { strict: schema.strict }),
    },
  };
}

function ocrParams(value: unknown): Record<string, unknown> {
  const ocr = plainRecord(value, "customParams.ocr");
  exact(ocr, [
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
  ]);
  if (ocr.enabled !== true) {
    throw new ProviderValidationError(
      "customParams.ocr.enabled must be true or OCR must be omitted",
    );
  }
  const result: Record<string, unknown> = {
    enabled: true,
    providerId: string(ocr.providerId, "customParams.ocr.providerId", 200),
    model: string(ocr.model, "customParams.ocr.model", 200),
    prompt: string(ocr.prompt, "customParams.ocr.prompt", 8_192),
  };
  const bounds = {
    cacheTtlSeconds: [1, 2_592_000],
    timeoutMs: [100, 120_000],
    maxBytes: [1_024, 50 * 1024 * 1024],
    maxPixels: [1, 100_000_000],
    maxDimension: [1, 65_535],
    maxRedirects: [0, 5],
  } as const;
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    if (ocr[key] !== undefined) {
      result[key] = integer(ocr[key], `customParams.ocr.${key}`, minimum, maximum);
    }
  }
  return result;
}

export function providerModelCustomParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const input = plainRecord(value, "customParams");
  const unknown = Object.keys(input).find((key) => !CUSTOM_PARAM_KEYS.has(key));
  if (unknown) throw new ProviderValidationError(`customParams.${unknown} is not allowed`);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    switch (key) {
      case "temperature":
        result[key] = boundedNumber(item, `customParams.${key}`, 0, 2);
        break;
      case "top_p":
        result[key] = boundedNumber(item, `customParams.${key}`, 0, 1);
        break;
      case "presence_penalty":
      case "frequency_penalty":
        result[key] = boundedNumber(item, `customParams.${key}`, -2, 2);
        break;
      case "seed":
        result[key] = integer(item, `customParams.${key}`, -2_147_483_648, 2_147_483_647);
        break;
      case "parallel_tool_calls":
        if (typeof item !== "boolean") {
          throw new ProviderValidationError(`customParams.${key} is invalid`);
        }
        result[key] = item;
        break;
      case "stop": {
        const values = typeof item === "string" ? [item] : item;
        if (
          !Array.isArray(values) || values.length < 1 || values.length > 4 ||
          values.some((value) => typeof value !== "string" || !value.length || value.length > 1_024)
        ) throw new ProviderValidationError("customParams.stop is invalid");
        result[key] = typeof item === "string" ? item : [...values];
        break;
      }
      case "response_format":
        result[key] = responseFormat(item);
        break;
      case "ocr":
        result[key] = ocrParams(item);
        break;
    }
  }
  assertSafeJson(result, "customParams", { nodes: 0 });
  const serialized = JSON.stringify(result);
  if (new TextEncoder().encode(serialized).length > MAX_PROVIDER_CUSTOM_PARAMS_BYTES) {
    throw new ProviderValidationError("customParams exceed the serialized size limit");
  }
  return structuredClone(result);
}

/** Returns only generation defaults safe to merge into an upstream request. */
export function providerUpstreamDefaults(
  value: unknown,
  protocol: "chat_completions" | "responses",
): Record<string, unknown> {
  const params = providerModelCustomParams(value);
  delete params.ocr;
  if (protocol === "responses") {
    const unsupported = ["presence_penalty", "frequency_penalty", "seed", "stop"]
      .find((key) => params[key] !== undefined);
    if (unsupported) {
      throw new ProviderValidationError(
        `customParams.${unsupported} is not supported by Responses providers`,
      );
    }
  }
  return params;
}

export function providerModelCreate(value: unknown): CreateProviderModelInput {
  const body = record(value);
  exact(body, [
    "providerId",
    "publicModelId",
    "upstreamModelId",
    "displayName",
    "capabilities",
    "contextWindow",
    "enabled",
    "customParams",
  ]);
  const publicModelId = string(body.publicModelId, "publicModelId", 255);
  const upstreamModelId = string(body.upstreamModelId, "upstreamModelId", 255);
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
  if (!safeId.test(publicModelId) || !safeId.test(upstreamModelId)) {
    throw new ProviderValidationError("Model IDs contain unsupported characters");
  }
  return {
    providerId: string(body.providerId, "providerId", 64),
    publicModelId,
    upstreamModelId,
    displayName: string(body.displayName, "displayName", 120),
    capabilities: capabilities(body.capabilities),
    contextWindow: integer(
      body.contextWindow,
      "contextWindow",
      1,
      MAX_PROVIDER_CONTEXT_WINDOW,
    ),
    enabled: optionalBoolean(body.enabled, "enabled"),
    customParams: providerModelCustomParams(body.customParams),
  };
}

export function providerModelPatch(
  value: unknown,
): { expectedVersion: number; patch: UpdateProviderModelInput } {
  const body = record(value);
  exact(body, [
    "expectedVersion",
    "displayName",
    "capabilities",
    "contextWindow",
    "enabled",
    "customParams",
  ]);
  const patch: UpdateProviderModelInput = {};
  if (body.displayName !== undefined) {
    patch.displayName = string(body.displayName, "displayName", 120);
  }
  if (body.capabilities !== undefined) patch.capabilities = capabilities(body.capabilities);
  if (body.contextWindow !== undefined) {
    patch.contextWindow = integer(
      body.contextWindow,
      "contextWindow",
      1,
      MAX_PROVIDER_CONTEXT_WINDOW,
    );
  }
  patch.enabled = optionalBoolean(body.enabled, "enabled");
  if (body.customParams !== undefined) {
    patch.customParams = providerModelCustomParams(body.customParams);
  }
  if (Object.values(patch).every((item) => item === undefined)) {
    throw new ProviderValidationError("At least one model field must change");
  }
  return { expectedVersion: integer(body.expectedVersion, "expectedVersion", 1), patch };
}

export function modelPriceCreate(value: unknown): CreateModelPriceVersionInput {
  const body = record(value);
  exact(body, [
    "providerModelId",
    "expectedModelVersion",
    "effectiveAt",
    "inputMicrosPerMillion",
    "cachedInputMicrosPerMillion",
    "reasoningMicrosPerMillion",
    "outputMicrosPerMillion",
    "fixedCallMicros",
    "source",
  ]);
  const effectiveAt = string(body.effectiveAt, "effectiveAt", 64);
  if (!Number.isFinite(Date.parse(effectiveAt))) {
    throw new ProviderValidationError("effectiveAt is invalid");
  }
  const result = {
    providerModelId: string(body.providerModelId, "providerModelId", 64),
    expectedModelVersion: integer(body.expectedModelVersion, "expectedModelVersion", 1),
    effectiveAt: new Date(effectiveAt).toISOString(),
    inputMicrosPerMillion: integer(body.inputMicrosPerMillion, "inputMicrosPerMillion"),
    cachedInputMicrosPerMillion: integer(
      body.cachedInputMicrosPerMillion,
      "cachedInputMicrosPerMillion",
    ),
    reasoningMicrosPerMillion: integer(
      body.reasoningMicrosPerMillion,
      "reasoningMicrosPerMillion",
    ),
    outputMicrosPerMillion: integer(body.outputMicrosPerMillion, "outputMicrosPerMillion"),
    fixedCallMicros: integer(body.fixedCallMicros, "fixedCallMicros"),
    source: string(body.source, "source", 120),
  };
  const ceilRate = (tokens: bigint, rate: number) =>
    (tokens * BigInt(rate) + 999_999n) / 1_000_000n;
  const maximumReservation = BigInt(result.fixedCallMicros) +
    ceilRate(
      BigInt(MAX_PROVIDER_CONTEXT_WINDOW),
      Math.max(result.inputMicrosPerMillion, result.cachedInputMicrosPerMillion),
    ) +
    ceilRate(
      131_072n,
      Math.max(result.outputMicrosPerMillion, result.reasoningMicrosPerMillion),
    );
  if (maximumReservation > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProviderValidationError("Pricing exceeds the safe accounting limit");
  }
  return result;
}
