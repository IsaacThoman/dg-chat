import postgres from "npm:postgres@3.4.7";
import { isCanonicalFileUploadObjectKey, type ObjectStore } from "@dg-chat/database";
import type { ClaimedJob } from "./job-queue.ts";

type Sql = ReturnType<typeof postgres>;

export interface FileObjectCleanupPayload {
  requestId: string;
  ownerId: string;
  objectKey: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseFileObjectCleanupPayload(value: unknown): FileObjectCleanupPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("File object cleanup payload is invalid");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.requestId !== "string" || !UUID.test(payload.requestId) ||
    typeof payload.ownerId !== "string" || !UUID.test(payload.ownerId) ||
    typeof payload.objectKey !== "string" || payload.objectKey.length > 1024
  ) throw new TypeError("File object cleanup payload is invalid");
  const digest = payload.objectKey.match(/\/([0-9a-f]{64})\.[a-z0-9]{1,12}$/)?.[1];
  if (
    !digest || !isCanonicalFileUploadObjectKey(payload.ownerId, digest, payload.objectKey)
  ) throw new TypeError("File object cleanup key is invalid");
  return {
    requestId: payload.requestId,
    ownerId: payload.ownerId,
    objectKey: payload.objectKey,
  };
}

/**
 * Deletes one abandoned content-addressed upload while holding the same PostgreSQL advisory
 * transaction lock used by all attachment reference writers. Keeping the job claim, reference
 * checks, delete, and completion in one transaction makes a lost commit acknowledgement safe:
 * the reclaimed worker repeats an idempotent DELETE, while a stale claim cannot complete the job.
 */
export async function processFileObjectCleanup(
  sql: Sql,
  objectStore: ObjectStore,
  job: ClaimedJob,
  signal?: AbortSignal,
): Promise<"deleted" | "skipped" | "deferred"> {
  const payload = parseFileObjectCleanupPayload(job.payload);
  if (job.idempotencyKey !== `file_object.cleanup:${payload.requestId}`) {
    throw new Error("File object cleanup association is invalid");
  }
  return await sql.begin(async (tx) => {
    const claim = await tx<{ id: string; idempotency_key: string | null }[]>`
      SELECT id,idempotency_key FROM jobs WHERE id=${job.id} AND status='running'
      AND locked_by=${job.claimToken} FOR UPDATE`;
    if (!claim.length) throw new Error("File object cleanup claim was reclaimed");
    if (claim[0].idempotency_key !== job.idempotencyKey) {
      throw new Error("File object cleanup association is invalid");
    }
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${payload.objectKey},0))`;
    const stages = await tx<{
      request_id: string;
      owner_id: string;
      object_key: string;
      state: string;
    }[]>`SELECT request_id,owner_id,object_key,state FROM file_upload_staging
      WHERE request_id=${payload.requestId} FOR UPDATE`;
    const stage = stages[0];
    if (
      stage &&
      (String(stage.owner_id) !== payload.ownerId ||
        String(stage.object_key) !== payload.objectKey)
    ) throw new Error("File object cleanup stage is invalid");

    const references = await tx<{
      attachment_exists: boolean;
      active_peer_exists: boolean;
      own_request_exists: boolean;
      own_request_active: boolean;
    }[]>`SELECT
      EXISTS(SELECT 1 FROM attachments WHERE object_key=${payload.objectKey})
        AS attachment_exists,
      EXISTS(
        SELECT 1 FROM file_upload_staging s
        JOIN api_idempotency_requests r ON r.id=s.request_id
        WHERE s.object_key=${payload.objectKey} AND s.request_id<>${payload.requestId}
          AND s.state<>'finalized' AND r.state='in_progress'
      ) AS active_peer_exists,
      EXISTS(
        SELECT 1 FROM api_idempotency_requests
        WHERE id=${payload.requestId}
      ) AS own_request_exists,
      EXISTS(
        SELECT 1 FROM api_idempotency_requests
        WHERE id=${payload.requestId} AND state='in_progress'
      ) AS own_request_active`;
    const reference = references[0];
    // Replay retention may prune a terminal request and cascade its ephemeral stage before a
    // backlogged cleanup runs. The exact durable job association remains sufficient authority
    // only after both origin rows are gone; an extant request without its stage is corruption.
    if (!stage && reference?.own_request_exists) {
      throw new Error("File object cleanup stage is invalid");
    }
    if (reference?.own_request_active || reference?.active_peer_exists) {
      // This fence is transient. Preserve the durable job without consuming its retry budget so
      // request terminalization can make a later attempt either delete or observe an attachment.
      const deferred = await tx`UPDATE jobs SET status='queued',
        attempts=GREATEST(attempts-1,0),available_at=now()+interval '5 minutes',
        locked_at=NULL,locked_by=NULL,last_error=NULL
        WHERE id=${job.id} AND status='running' AND locked_by=${job.claimToken} RETURNING id`;
      if (!deferred.length) throw new Error("File object cleanup claim was reclaimed");
      return "deferred";
    }
    let outcome: "deleted" | "skipped" = "skipped";
    if (reference?.attachment_exists !== true && stage?.state !== "finalized") {
      await objectStore.delete(payload.objectKey, signal);
      outcome = "deleted";
    }
    const completed = await tx`UPDATE jobs SET status='completed',completed_at=now(),
      locked_at=NULL,locked_by=NULL,last_error=NULL
      WHERE id=${job.id} AND status='running' AND locked_by=${job.claimToken} RETURNING id`;
    if (!completed.length) throw new Error("File object cleanup claim was reclaimed");
    return outcome;
  });
}
