const MICROS_PER_USD = 1_000_000;
const MICROS_PER_USD_BIGINT = 1_000_000n;

export type UsdMicrosParseError =
  | "required"
  | "invalid_format"
  | "too_precise"
  | "negative_not_allowed"
  | "below_minimum"
  | "above_maximum";

export type UsdMicrosParseResult =
  | { ok: true; micros: number; normalized: string }
  | { ok: false; error: UsdMicrosParseError };

export interface ParseUsdMicrosOptions {
  allowNegative?: boolean;
  minimumMicros?: number;
  maximumMicros?: number;
}

export interface FormatUsdMicrosOptions {
  locale?: string;
  minimumFractionDigits?: number;
  showPlus?: boolean;
}

function assertSafeMicros(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer number of microdollars.`);
  }
}

function parseBounds(options: ParseUsdMicrosOptions): { minimum: number; maximum: number } {
  const minimum = options.minimumMicros ?? (options.allowNegative ? -Number.MAX_SAFE_INTEGER : 0);
  const maximum = options.maximumMicros ?? Number.MAX_SAFE_INTEGER;
  assertSafeMicros(minimum, "minimumMicros");
  assertSafeMicros(maximum, "maximumMicros");
  if (minimum > maximum) throw new RangeError("minimumMicros cannot exceed maximumMicros.");
  return { minimum, maximum };
}

/**
 * Parses a decimal USD input without passing through floating point arithmetic.
 * Inputs may contain up to six fractional digits because one microdollar is the
 * smallest accounting unit used by the application.
 */
export function parseUsdMicros(
  input: string,
  options: ParseUsdMicrosOptions = {},
): UsdMicrosParseResult {
  const value = input.trim();
  if (!value) return { ok: false, error: "required" };

  const negative = value.startsWith("-");
  if (negative && !options.allowNegative) return { ok: false, error: "negative_not_allowed" };
  const unsigned = negative ? value.slice(1) : value;
  if (!unsigned || unsigned.startsWith("+")) return { ok: false, error: "invalid_format" };

  const match = /^(?:(0|[1-9]\d*)(?:\.(\d*))?|\.(\d+))$/u.exec(unsigned);
  if (!match) return { ok: false, error: "invalid_format" };
  const fraction = match[2] ?? match[3] ?? "";
  if (fraction.length > 6) return { ok: false, error: "too_precise" };

  const whole = match[1] ?? "0";
  const paddedFraction = fraction.padEnd(6, "0");
  let micros = BigInt(whole) * MICROS_PER_USD_BIGINT + BigInt(paddedFraction || "0");
  if (negative) micros = -micros;

  const { minimum, maximum } = parseBounds(options);
  if (micros < BigInt(minimum)) return { ok: false, error: "below_minimum" };
  if (micros > BigInt(maximum)) return { ok: false, error: "above_maximum" };

  const exact = Number(micros);
  return { ok: true, micros: exact, normalized: formatUsdInputMicros(exact) };
}

/** Formats exact microdollars for a form field without grouping or a currency symbol. */
export function formatUsdInputMicros(micros: number): string {
  assertSafeMicros(micros, "micros");
  const negative = micros < 0;
  const absolute = Math.abs(micros);
  const whole = Math.floor(absolute / MICROS_PER_USD);
  const fraction = String(absolute % MICROS_PER_USD).padStart(6, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Formats exact microdollars for display. Whole-dollar values retain cents,
 * while non-zero sub-cent precision remains visible up to six decimal places.
 */
export function formatUsdMicros(
  micros: number,
  options: FormatUsdMicrosOptions = {},
): string {
  assertSafeMicros(micros, "micros");
  const minimumFractionDigits = options.minimumFractionDigits ?? 2;
  if (
    !Number.isInteger(minimumFractionDigits) || minimumFractionDigits < 0 ||
    minimumFractionDigits > 6
  ) {
    throw new RangeError("minimumFractionDigits must be an integer between 0 and 6.");
  }

  const negative = micros < 0;
  const absolute = Math.abs(micros);
  const whole = Math.floor(absolute / MICROS_PER_USD);
  const rawFraction = String(absolute % MICROS_PER_USD).padStart(6, "0");
  const significantLength = rawFraction.replace(/0+$/u, "").length;
  const fractionLength = Math.max(minimumFractionDigits, significantLength);
  const fraction = fractionLength ? `.${rawFraction.slice(0, fractionLength)}` : "";
  const groupedWhole = new Intl.NumberFormat(options.locale, {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(whole);
  const sign = negative ? "−" : options.showPlus ? "+" : "";
  return `${sign}$${groupedWhole}${fraction}`;
}
