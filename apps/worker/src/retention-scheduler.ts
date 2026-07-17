import type { DomainRepository, RetentionScheduleResult } from "@dg-chat/database";

export const DEFAULT_RETENTION_SCRUB_INTERVAL_SECONDS = 86_400;
export const MIN_RETENTION_SCRUB_INTERVAL_SECONDS = 300;
export const MAX_RETENTION_SCRUB_INTERVAL_SECONDS = 2_592_000;

export interface RetentionSchedulerConfig {
  intervalSeconds: number;
  pollIntervalMs: number;
}

function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function parseRetentionSchedulerConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): RetentionSchedulerConfig {
  const intervalSeconds = boundedInteger(
    "RETENTION_SCRUB_INTERVAL_SECONDS",
    env.RETENTION_SCRUB_INTERVAL_SECONDS,
    DEFAULT_RETENTION_SCRUB_INTERVAL_SECONDS,
    MIN_RETENTION_SCRUB_INTERVAL_SECONDS,
    MAX_RETENTION_SCRUB_INTERVAL_SECONDS,
  );
  const pollSeconds = boundedInteger(
    "RETENTION_SCHEDULER_POLL_SECONDS",
    env.RETENTION_SCHEDULER_POLL_SECONDS,
    60,
    10,
    3_600,
  );
  return {
    intervalSeconds,
    pollIntervalMs: Math.min(pollSeconds, intervalSeconds) * 1_000,
  };
}

export async function scheduleAutomaticRetention(
  repository: Pick<DomainRepository, "scheduleRetentionScrub">,
  config: RetentionSchedulerConfig,
  now = new Date().toISOString(),
): Promise<RetentionScheduleResult> {
  return await repository.scheduleRetentionScrub({
    intervalSeconds: config.intervalSeconds,
    now,
  });
}
