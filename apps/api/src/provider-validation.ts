import type {
  CreateModelPriceVersionInput,
  CreateProviderInput,
  CreateProviderModelInput,
  UpdateProviderInput,
  UpdateProviderModelInput,
} from "@dg-chat/database";
import { normalizeProviderBaseUrl } from "./provider-admin.ts";

export class ProviderValidationError extends Error {}

export const MAX_PROVIDER_CONTEXT_WINDOW = 4_194_304;

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
  if (body.protocol !== "chat_completions") {
    throw new ProviderValidationError("Only the Chat Completions upstream protocol is supported");
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
    if (body.protocol !== "chat_completions") {
      throw new ProviderValidationError(
        "Only the Chat Completions upstream protocol is supported",
      );
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

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ProviderValidationError("capabilities are invalid");
  }
  const result = value.map((item) => string(item, "capability", 64));
  if (new Set(result).size !== result.length) {
    throw new ProviderValidationError("capabilities must be unique");
  }
  return result;
}

function customParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const result = record(value);
  if (Object.keys(result).length > 64) {
    throw new ProviderValidationError("customParams are invalid");
  }
  if (Object.keys(result).length) {
    throw new ProviderValidationError("Custom provider parameters are not yet supported");
  }
  return structuredClone(result);
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
    customParams: customParams(body.customParams),
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
  if (body.customParams !== undefined) patch.customParams = customParams(body.customParams);
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
