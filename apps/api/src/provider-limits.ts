export const DEFAULT_PROVIDER_RESPONSE_BYTES = 16_777_216;
export const MAX_PROVIDER_RESPONSE_BYTES = 67_108_864;

/** Shared transport ceiling for Chat Completions and native Responses providers. */
export function providerResponseByteLimit(override?: number): number {
  const value = override ?? Number(
    Deno.env.get("OPENAI_MAX_RESPONSE_BYTES") ?? DEFAULT_PROVIDER_RESPONSE_BYTES,
  );
  if (!Number.isSafeInteger(value) || value < 1_024 || value > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("OPENAI_MAX_RESPONSE_BYTES must be between 1024 and 67108864");
  }
  return value;
}
