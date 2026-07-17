import postgres from "npm:postgres@3.4.7";
import type { ObjectStore } from "@dg-chat/database";
import type { ClaimedJob } from "./job-queue.ts";

type Sql = ReturnType<typeof postgres>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AttachmentObjectCleanupPayload {
  stageId: string;
  ownerId: string;
}

export function parseAttachmentObjectCleanupPayload(
  value: unknown,
): AttachmentObjectCleanupPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Attachment object cleanup payload is invalid");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.stageId !== "string" || !UUID.test(payload.stageId) ||
    typeof payload.ownerId !== "string" || !UUID.test(payload.ownerId)
  ) throw new TypeError("Attachment object cleanup payload is invalid");
  return { stageId: payload.stageId, ownerId: payload.ownerId };
}

function validObjectKey(ownerId: string, objectKey: string): boolean {
  const escapedOwner = ownerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = objectKey.match(
    new RegExp(
      `^uploads/${escapedOwner}/([0-9a-f]{2})/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.[a-z0-9]{1,12}$`,
      "i",
    ),
  );
  return Boolean(match && match[2].slice(0, 2).toLowerCase() === match[1].toLowerCase());
}

/** Reference-fenced, replay-safe cleanup for browser uploads staged before their object PUT. */
export async function processAttachmentObjectCleanup(
  sql: Sql,
  objectStore: ObjectStore,
  job: ClaimedJob,
  leaseSeconds: number,
  signal?: AbortSignal,
): Promise<"deleted" | "finalized" | "deferred"> {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new TypeError("Attachment object cleanup lease duration is invalid");
  }
  const payload = parseAttachmentObjectCleanupPayload(job.payload);
  if (job.idempotencyKey !== `attachment_object.cleanup:${payload.stageId}`) {
    throw new Error("Attachment object cleanup association is invalid");
  }
  const prepared:
    | { outcome: "deleted" | "finalized" | "deferred" }
    | { objectKey: string } = await sql.begin(async (tx) => {
      const claim = await tx`SELECT id FROM jobs WHERE id=${job.id} AND status='running'
      AND locked_by=${job.claimToken}
      AND locked_at > now() - ${leaseSeconds} * interval '1 second' FOR UPDATE`;
      if (!claim.length) throw new Error("Attachment object cleanup claim was reclaimed");
      const stages = await tx<{
        owner_id: string;
        object_key: string;
        state: string;
        attachment_id: string | null;
        upload_lease_active: boolean;
      }[]>`SELECT owner_id,object_key,state,attachment_id,
        upload_lease_expires_at>now() AS upload_lease_active
      FROM attachment_upload_staging
      WHERE id=${payload.stageId} FOR UPDATE`;
      const stage = stages[0];
      if (!stage || String(stage.owner_id) !== payload.ownerId) {
        throw new Error("Attachment object cleanup stage is invalid");
      }
      if (!validObjectKey(payload.ownerId, String(stage.object_key))) {
        throw new Error("Attachment object cleanup key is invalid");
      }
      if (["finalized", "cleaned"].includes(stage.state)) {
        await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,
        locked_by=NULL,last_error=NULL WHERE id=${job.id}`;
        return {
          outcome: stage.state === "finalized" ? "finalized" as const : "deleted" as const,
        };
      }
      if (!["cleanup_pending", "cleaning"].includes(stage.state)) {
        throw new Error("Attachment object cleanup stage is not ready");
      }
      if (stage.upload_lease_active) {
        await tx`UPDATE jobs SET status='queued',attempts=GREATEST(attempts-1,0),
          available_at=(SELECT upload_lease_expires_at FROM attachment_upload_staging
            WHERE id=${payload.stageId}),locked_at=NULL,locked_by=NULL,
          last_error=NULL WHERE id=${job.id}`;
        return { outcome: "deferred" as const };
      }
      // Every repository attachment writer takes this same transaction-scoped object-key lock.
      // Once the stage becomes `cleaning`, a later writer must reject it rather than publishing a
      // durable attachment whose bytes this worker is authorized to delete.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${String(stage.object_key)},0))`;
      const attachments = await tx<{ id: string }[]>`SELECT id FROM attachments
      WHERE owner_id=${payload.ownerId} AND object_key=${stage.object_key}
      ORDER BY id FOR UPDATE`;
      if (attachments[0]) {
        await tx`UPDATE attachment_upload_staging SET state='finalized',
        attachment_id=${String(attachments[0].id)},cleanup_error=NULL,updated_at=now()
        WHERE id=${payload.stageId}`;
        await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,
        locked_by=NULL,last_error=NULL WHERE id=${job.id}`;
        return { outcome: "finalized" as const };
      }
      const activePeer = await tx`SELECT 1 FROM attachment_upload_staging
      WHERE object_key=${stage.object_key} AND id<>${payload.stageId}
        AND state NOT IN('finalized','cleaned') LIMIT 1`;
      if (activePeer.length) {
        await tx`UPDATE jobs SET status='queued',attempts=GREATEST(attempts-1,0),
        available_at=now()+interval '5 minutes',locked_at=NULL,locked_by=NULL,last_error=NULL
        WHERE id=${job.id}`;
        return { outcome: "deferred" as const };
      }
      await tx`UPDATE attachment_upload_staging SET state='cleaning',updated_at=now()
      WHERE id=${payload.stageId} AND state IN('cleanup_pending','cleaning')`;
      return { objectKey: String(stage.object_key) };
    });
  if ("outcome" in prepared) return prepared.outcome;

  // Object storage is an external system: never hold PostgreSQL row locks or a pooled connection
  // while DELETE is in flight. The durable `cleaning` state prevents upload finalization and makes
  // a crash replay safe; S3 DELETE is idempotent and may be repeated after an ambiguous response.
  await objectStore.delete(prepared.objectKey, signal);

  return await sql.begin(async (tx) => {
    const claim = await tx`SELECT id FROM jobs WHERE id=${job.id} AND status='running'
      AND locked_by=${job.claimToken}
      AND locked_at > now() - ${leaseSeconds} * interval '1 second' FOR UPDATE`;
    if (!claim.length) throw new Error("Attachment object cleanup claim was reclaimed");
    const stages = await tx<{
      owner_id: string;
      object_key: string;
      state: string;
    }[]>`
      SELECT owner_id,object_key,state FROM attachment_upload_staging
      WHERE id=${payload.stageId} FOR UPDATE`;
    const stage = stages[0];
    if (
      !stage || String(stage.owner_id) !== payload.ownerId ||
      String(stage.object_key) !== prepared.objectKey || stage.state !== "cleaning"
    ) throw new Error("Attachment object cleanup stage changed before settlement");
    const published = await tx`SELECT 1 FROM attachments
      WHERE owner_id=${payload.ownerId} AND object_key=${prepared.objectKey} LIMIT 1`;
    if (published.length) {
      throw new Error("Attachment object became referenced during cleanup");
    }
    await tx`UPDATE attachment_upload_staging SET state='cleaned',cleanup_error=NULL,
      updated_at=now() WHERE id=${payload.stageId}`;
    await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,
      locked_by=NULL,last_error=NULL WHERE id=${job.id}`;
    return "deleted" as const;
  });
}
