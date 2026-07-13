export interface TemporaryLifecycleEnvironment {
  TEMPORARY_CHAT_RETENTION_DAYS?: string;
  TEMPORARY_CHAT_PURGE_INTERVAL_SECONDS?: string;
  TEMPORARY_CHAT_PURGE_BATCH_SIZE?: string;
}

export interface TemporaryLifecycleConfig {
  retentionDays: number;
  purgeIntervalMs: number;
  purgeBatchSize: number;
}

function integerInRange(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseTemporaryLifecycleConfig(
  environment: TemporaryLifecycleEnvironment = {},
): TemporaryLifecycleConfig {
  return {
    retentionDays: integerInRange(
      "TEMPORARY_CHAT_RETENTION_DAYS",
      environment.TEMPORARY_CHAT_RETENTION_DAYS,
      30,
      1,
      3650,
    ),
    purgeIntervalMs: integerInRange(
      "TEMPORARY_CHAT_PURGE_INTERVAL_SECONDS",
      environment.TEMPORARY_CHAT_PURGE_INTERVAL_SECONDS,
      300,
      10,
      86_400,
    ) * 1000,
    purgeBatchSize: integerInRange(
      "TEMPORARY_CHAT_PURGE_BATCH_SIZE",
      environment.TEMPORARY_CHAT_PURGE_BATCH_SIZE,
      100,
      1,
      1000,
    ),
  };
}
