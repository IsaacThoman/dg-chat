const encoder = new TextEncoder();
const MAX_AUTH_SECRET_BYTES = 256;
const MAX_AUTH_SECRET_CODE_UNITS = 256;

export const DOCUMENTED_APP_SECRET_PLACEHOLDER = "replace-with-at-least-32-random-bytes";
export const DOCUMENTED_SETUP_TOKEN_PLACEHOLDER = "replace-with-one-time-bootstrap-token";

const boundedSecret = (
  name: string,
  value: string | undefined,
  options: {
    required: boolean;
    minimumBytes: number;
    maximumBytes: number;
    rejectedValues: readonly string[];
  },
): string | undefined => {
  if (!value) {
    if (options.required) throw new Error(`${name} is required`);
    return undefined;
  }
  const bytes = encoder.encode(value).byteLength;
  if (
    bytes < options.minimumBytes || bytes > options.maximumBytes ||
    options.rejectedValues.includes(value)
  ) {
    throw new Error(
      `${name} must be a non-placeholder secret between ${options.minimumBytes} and ${options.maximumBytes} bytes`,
    );
  }
  return value;
};

export function validateAppSecret(
  value: string | undefined,
  required: boolean,
): string | undefined {
  return boundedSecret("APP_SECRET", value, {
    required,
    minimumBytes: 32,
    maximumBytes: 256,
    rejectedValues: [DOCUMENTED_APP_SECRET_PLACEHOLDER],
  });
}

export function validateSetupToken(
  value: string | undefined,
  production: boolean,
): string | undefined {
  if (!production) {
    if (!value) return undefined;
    if (encoder.encode(value).byteLength > MAX_AUTH_SECRET_BYTES) {
      throw new Error(`SETUP_TOKEN must contain at most ${MAX_AUTH_SECRET_BYTES} bytes`);
    }
    return value;
  }
  return boundedSecret("SETUP_TOKEN", value, {
    required: false,
    minimumBytes: 32,
    maximumBytes: MAX_AUTH_SECRET_BYTES,
    rejectedValues: [DOCUMENTED_SETUP_TOKEN_PLACEHOLDER],
  });
}

/**
 * Compare bounded operator credentials without attacker-controlled loop work or an early byte
 * mismatch. The configured credential is validated to at most 256 UTF-8 bytes before this helper
 * is used; an oversized candidate is folded into the result without encoding its complete value.
 */
export function timingSafeTextEqual(left: string | undefined, right: string): boolean {
  const rightBytes = encoder.encode(right);
  if (rightBytes.byteLength > MAX_AUTH_SECRET_BYTES) {
    throw new TypeError("Configured authentication secret exceeds the supported byte limit");
  }
  const candidateWithinBound = left !== undefined &&
    left.length <= MAX_AUTH_SECRET_CODE_UNITS;
  const leftBytes = encoder.encode(candidateWithinBound ? left : "");
  const candidateBytesWithinBound = leftBytes.byteLength <= MAX_AUTH_SECRET_BYTES;
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  if (!candidateWithinBound || !candidateBytesWithinBound) difference |= 1;
  for (let index = 0; index < MAX_AUTH_SECRET_BYTES; index++) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
