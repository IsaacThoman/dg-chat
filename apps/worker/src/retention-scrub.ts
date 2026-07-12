import type { DomainRepository, RetentionScrubBatchResult } from "@dg-chat/database";

export interface RetentionScrubPayload {
  runId: string;
}

export function parseRetentionScrubPayload(value: unknown): RetentionScrubPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Retention scrub payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "runId") ||
    typeof record.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.runId,
    )
  ) {
    throw new TypeError("Retention scrub payload contains an invalid run id");
  }
  return { runId: record.runId };
}

export async function processRetentionScrub(
  repository: Pick<DomainRepository, "scrubRetentionBatch">,
  payload: RetentionScrubPayload,
  batchSize = 100,
): Promise<RetentionScrubBatchResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError("Retention scrub batch size must be between 1 and 500");
  }
  return await repository.scrubRetentionBatch(payload.runId, batchSize);
}
