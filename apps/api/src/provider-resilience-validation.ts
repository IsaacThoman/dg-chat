import type {
  CreateProviderRetryPolicyInput,
  SetProviderModelRouteInput,
  UpdateProviderRetryPolicyInput,
} from "@dg-chat/database";

export class ProviderResilienceValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderResilienceValidationError";
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderResilienceValidationError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) throw new ProviderResilienceValidationError(`Unsupported field '${extra}'`);
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ProviderResilienceValidationError(
      `${name} must be an integer from ${min} to ${max}`,
    );
  }
  return Number(value);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProviderResilienceValidationError(`${name} must be a boolean`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuid.test(value)) {
    throw new ProviderResilienceValidationError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function statuses(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > RETRYABLE_STATUSES.size) {
    throw new ProviderResilienceValidationError("retryableStatuses must be a bounded array");
  }
  const normalized = value.map((status) => integer(status, "retryable status", 400, 599));
  if (new Set(normalized).size !== normalized.length) {
    throw new ProviderResilienceValidationError("retryableStatuses cannot contain duplicates");
  }
  if (normalized.some((status) => !RETRYABLE_STATUSES.has(status))) {
    throw new ProviderResilienceValidationError("retryableStatuses contains an unsafe status");
  }
  return normalized.sort((a, b) => a - b);
}

const policyFields = [
  "name",
  "enabled",
  "maxAttempts",
  "maxRetries",
  "baseDelayMs",
  "maxDelayMs",
  "backoffMultiplierBps",
  "jitterBps",
  "firstTokenTimeoutMs",
  "idleTimeoutMs",
  "totalTimeoutMs",
  "retryableStatuses",
] as const;

function policyValues(body: Record<string, unknown>, partial: boolean) {
  exactKeys(body, partial ? ["expectedVersion", ...policyFields] : policyFields);
  const output: Record<string, unknown> = {};
  const read = (
    name: string,
    min: number,
    max: number,
  ) => {
    if (!partial || body[name] !== undefined) output[name] = integer(body[name], name, min, max);
  };
  if (!partial || body.name !== undefined) {
    if (
      typeof body.name !== "string" || body.name.trim().length < 1 ||
      body.name.trim().length > 120
    ) throw new ProviderResilienceValidationError("name must contain 1 to 120 characters");
    output.name = body.name.trim();
  }
  const enabled = optionalBoolean(body.enabled, "enabled");
  if (enabled !== undefined) output.enabled = enabled;
  read("maxAttempts", 1, 8);
  read("maxRetries", 0, 3);
  read("baseDelayMs", 0, 60_000);
  read("maxDelayMs", 0, 300_000);
  read("backoffMultiplierBps", 10_000, 40_000);
  read("jitterBps", 0, 10_000);
  read("firstTokenTimeoutMs", 250, 300_000);
  read("idleTimeoutMs", 250, 300_000);
  read("totalTimeoutMs", 1_000, 900_000);
  if (!partial || body.retryableStatuses !== undefined) {
    output.retryableStatuses = statuses(body.retryableStatuses);
  }
  const base = Number(output.baseDelayMs ?? body.baseDelayMs);
  const max = Number(output.maxDelayMs ?? body.maxDelayMs);
  if (Number.isFinite(base) && Number.isFinite(max) && max < base) {
    throw new ProviderResilienceValidationError("maxDelayMs cannot be less than baseDelayMs");
  }
  const attempts = Number(output.maxAttempts ?? body.maxAttempts);
  const retries = Number(output.maxRetries ?? body.maxRetries);
  if (Number.isFinite(attempts) && Number.isFinite(retries) && retries >= attempts) {
    throw new ProviderResilienceValidationError("maxRetries must be less than maxAttempts");
  }
  if (partial && Object.keys(output).length === 0) {
    throw new ProviderResilienceValidationError("At least one policy field must change");
  }
  return output;
}

export function providerRetryPolicyCreate(value: unknown): CreateProviderRetryPolicyInput {
  return policyValues(record(value), false) as unknown as CreateProviderRetryPolicyInput;
}

export function providerRetryPolicyPatch(value: unknown): {
  expectedVersion: number;
  changes: UpdateProviderRetryPolicyInput;
} {
  const body = record(value);
  const expectedVersion = integer(body.expectedVersion, "expectedVersion", 1, 2_147_483_647);
  return {
    expectedVersion,
    changes: policyValues(body, true) as UpdateProviderRetryPolicyInput,
  };
}

export function providerModelRouteSet(value: unknown): SetProviderModelRouteInput {
  const body = record(value);
  exactKeys(body, ["sourceModelId", "expectedVersion", "retryPolicyId", "fallbackModelIds"]);
  const sourceModelId = identifier(body.sourceModelId, "sourceModelId");
  if (!Array.isArray(body.fallbackModelIds) || body.fallbackModelIds.length > 8) {
    throw new ProviderResilienceValidationError("fallbackModelIds must be a bounded array");
  }
  const fallbackModelIds = body.fallbackModelIds.map((id) => identifier(id, "fallback model id"));
  if (new Set(fallbackModelIds).size !== fallbackModelIds.length) {
    throw new ProviderResilienceValidationError("Fallback targets cannot contain duplicates");
  }
  if (fallbackModelIds.includes(sourceModelId)) {
    throw new ProviderResilienceValidationError("A model cannot fall back to itself");
  }
  return {
    sourceModelId,
    expectedVersion: integer(body.expectedVersion, "expectedVersion", 0, 2_147_483_647),
    retryPolicyId: body.retryPolicyId === null || body.retryPolicyId === undefined
      ? null
      : identifier(body.retryPolicyId, "retryPolicyId"),
    fallbackModelIds,
  };
}
