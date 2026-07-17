import {
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  ATTACHMENT_INSPECTION_REASON,
  type AttachmentRecord,
  attachmentReinspectionEligibility,
  DomainError,
  type DomainRepository,
  INGESTIBLE_DOCUMENT_MIME_TYPES,
  type ObjectStore,
  type RequiredAttachmentInspectionMode,
  type StoredObject,
  type TransitionAttachmentInspectionInput,
} from "@dg-chat/database";
import { createHash } from "node:crypto";
import {
  type MalwareScannerConfig,
  MalwareScannerError,
  scanWithExternalService,
} from "./malware-scanner.ts";
import type { ClaimedJob } from "./job-queue.ts";
import postgres from "npm:postgres@3.4.7";
import type { DnsResolver } from "./malware-scanner.ts";

type Sql = ReturnType<typeof postgres>;

export interface AttachmentInspectionPayload {
  attachmentId: string;
  ownerId: string;
  inspectionEpoch: number;
  requiredInspectionMode: RequiredAttachmentInspectionMode;
  inspectionPolicyVersion: typeof ATTACHMENT_INSPECTION_POLICY_VERSION;
}

export function parseAttachmentInspectionPayload(payload: unknown): AttachmentInspectionPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("attachment.inspect payload must be an object");
  }
  const {
    attachmentId,
    ownerId,
    inspectionEpoch,
    requiredInspectionMode,
    inspectionPolicyVersion,
  } = payload as Record<string, unknown>;
  if (
    typeof attachmentId !== "string" || !attachmentId ||
    typeof ownerId !== "string" || !ownerId ||
    !Number.isSafeInteger(inspectionEpoch) || Number(inspectionEpoch) < 1 ||
    !["local", "external"].includes(String(requiredInspectionMode)) ||
    inspectionPolicyVersion !== ATTACHMENT_INSPECTION_POLICY_VERSION
  ) {
    throw new Error(
      "attachment.inspect payload has invalid identity, epoch, mode, or policy version",
    );
  }
  return {
    attachmentId,
    ownerId,
    inspectionEpoch: Number(inspectionEpoch),
    requiredInspectionMode: requiredInspectionMode as RequiredAttachmentInspectionMode,
    inspectionPolicyVersion,
  };
}

export type AttachmentInspectionOutcome =
  | { status: "ready"; attachment: AttachmentRecord }
  | { status: "quarantined"; attachment: AttachmentRecord }
  | { status: "failed"; attachment: AttachmentRecord }
  | { status: "superseded" };

export interface AttachmentInspectionLimits {
  maxBytes: number;
}

export const ATTACHMENT_LOCAL_SCANNER_VERSION = "local-integrity-v1";
export const ATTACHMENT_EXTERNAL_SCANNER_VERSION = "external-json-v1";

export interface AttachmentInspectionAuditContext {
  scannerMode: "local" | "external" | "worker";
  scannerVersion: string;
  policyVersion: string;
}

type FencedAttachmentInspectionTransitionInput = TransitionAttachmentInspectionInput & {
  requiredInspectionMode: RequiredAttachmentInspectionMode;
  inspectionPolicyVersion: typeof ATTACHMENT_INSPECTION_POLICY_VERSION;
};

function requireLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new TypeError("Attachment inspection lease duration is invalid");
  }
}

const EICAR_MARKER = new TextEncoder().encode("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer:
  for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Local checks establish that storage still contains the immutable bytes admitted by the API.
 * Any read, length, or digest ambiguity throws and therefore fails closed through durable retry.
 */
export async function inspectAttachmentLocally(
  object: StoredObject,
  attachment: Pick<
    AttachmentRecord,
    "ownerId" | "sizeBytes" | "sha256" | "mimeType"
  >,
  limits: AttachmentInspectionLimits,
  signal?: AbortSignal,
): Promise<"clean" | "infected"> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new TypeError("Attachment inspection byte limit is invalid");
  }
  if (
    attachment.sizeBytes > limits.maxBytes ||
    (object.contentLength !== null && object.contentLength > limits.maxBytes)
  ) throw new Error("Attachment exceeds the inspection byte limit");
  if (object.contentLength !== null && object.contentLength !== attachment.sizeBytes) {
    throw new Error("Attachment object size does not match its record");
  }
  if (object.metadata.owner !== attachment.ownerId) {
    throw new Error("Attachment object ownership does not match its record");
  }
  if (object.metadata.sha256 !== attachment.sha256) {
    throw new Error("Attachment object digest metadata does not match its record");
  }
  if (
    object.contentType && object.contentType.split(";", 1)[0].trim().toLowerCase() !==
      attachment.mimeType.toLowerCase()
  ) throw new Error("Attachment object media type does not match its record");

  const hash = createHash("sha256");
  const reader = object.body.getReader();
  let total = 0;
  let tail = new Uint8Array();
  let infected = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes || total > attachment.sizeBytes) {
        throw new Error("Attachment object exceeds its recorded size");
      }
      hash.update(value);
      const searchable = new Uint8Array(tail.byteLength + value.byteLength);
      searchable.set(tail);
      searchable.set(value, tail.byteLength);
      infected ||= containsBytes(searchable, EICAR_MARKER);
      tail = searchable.slice(Math.max(0, searchable.length - EICAR_MARKER.length + 1));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (total !== attachment.sizeBytes) {
    throw new Error("Attachment object size does not match its record");
  }
  if (hash.digest("hex") !== attachment.sha256) {
    throw new Error("Attachment object digest does not match its record");
  }
  return infected ? "infected" : "clean";
}

function isInspectionConflict(error: unknown): boolean {
  return error instanceof DomainError &&
    (error.code === "attachment_inspection_conflict" || error.code === "not_found");
}

async function currentAttachment(
  repository: Pick<DomainRepository, "getAttachment">,
  payload: AttachmentInspectionPayload,
): Promise<AttachmentRecord | undefined> {
  try {
    return await repository.getAttachment(payload.attachmentId, payload.ownerId, true);
  } catch (error) {
    if (error instanceof DomainError && error.code === "not_found") return undefined;
    throw error;
  }
}

function inspectionEpochIsTerminal(
  attachment: Pick<AttachmentRecord, "state" | "inspectionError" | "deletedAt">,
): boolean {
  return attachmentReinspectionEligibility(attachment).blockedReason !== "nonterminal";
}

async function transitionOrSuperseded(
  repository: Pick<DomainRepository, "getAttachment">,
  transition: (
    input: FencedAttachmentInspectionTransitionInput,
    audit: AttachmentInspectionAuditContext,
  ) => AttachmentRecord | Promise<AttachmentRecord>,
  payload: AttachmentInspectionPayload,
  expectedState: "pending" | "inspecting",
  nextState: "inspecting" | "ready" | "quarantined" | "failed",
  audit: AttachmentInspectionAuditContext,
  inspectionError?: string,
): Promise<AttachmentRecord | undefined> {
  try {
    return await transition(
      { ...payload, expectedState, nextState, inspectionError },
      audit,
    );
  } catch (error) {
    if (!isInspectionConflict(error)) throw error;
    const latest = await currentAttachment(repository, payload);
    if (
      !latest || latest.inspectionEpoch !== payload.inspectionEpoch ||
      latest.requiredInspectionMode !== payload.requiredInspectionMode ||
      latest.inspectionPolicyVersion !== payload.inspectionPolicyVersion ||
      inspectionEpochIsTerminal(latest)
    ) return undefined;
    throw error;
  }
}

export async function processAttachmentInspection(input: {
  payload: AttachmentInspectionPayload;
  repository: Pick<DomainRepository, "getAttachment" | "transitionAttachmentInspection">;
  objectStore: Pick<ObjectStore, "get">;
  limits: AttachmentInspectionLimits;
  scanner?: MalwareScannerConfig;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  resolveDns?: DnsResolver;
  transition?: (
    transition: FencedAttachmentInspectionTransitionInput,
    audit: AttachmentInspectionAuditContext,
  ) => AttachmentRecord | Promise<AttachmentRecord>;
}): Promise<AttachmentInspectionOutcome> {
  input.signal?.throwIfAborted();
  const { payload, repository } = input;
  const transition = input.transition ??
    ((value: FencedAttachmentInspectionTransitionInput, _audit: AttachmentInspectionAuditContext) =>
      repository.transitionAttachmentInspection(value));
  const configuredAudit: AttachmentInspectionAuditContext =
    payload.requiredInspectionMode === "external"
      ? {
        scannerMode: "external",
        scannerVersion: ATTACHMENT_EXTERNAL_SCANNER_VERSION,
        policyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      }
      : {
        scannerMode: "local",
        scannerVersion: ATTACHMENT_LOCAL_SCANNER_VERSION,
        policyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      };
  let attachment = await currentAttachment(repository, payload);
  if (
    !attachment || attachment.inspectionEpoch !== payload.inspectionEpoch ||
    attachment.requiredInspectionMode !== payload.requiredInspectionMode ||
    attachment.inspectionPolicyVersion !== payload.inspectionPolicyVersion ||
    inspectionEpochIsTerminal(attachment)
  ) return { status: "superseded" };
  if (attachment.state === "pending") {
    attachment = await transitionOrSuperseded(
      repository,
      transition,
      payload,
      "pending",
      "inspecting",
      configuredAudit,
    );
    if (!attachment) return { status: "superseded" };
  } else if (attachment.state !== "inspecting") {
    return { status: "superseded" };
  }

  if (payload.requiredInspectionMode === "external" && !input.scanner) {
    const failed = await transitionOrSuperseded(
      repository,
      transition,
      payload,
      "inspecting",
      "failed",
      configuredAudit,
      ATTACHMENT_INSPECTION_REASON.externalScannerUnavailable,
    );
    return failed ? { status: "failed", attachment: failed } : { status: "superseded" };
  }

  const localObject = await input.objectStore.get(attachment.objectKey, input.signal);
  if (!localObject) throw new Error("Attachment object is unavailable for inspection");
  const local = await inspectAttachmentLocally(
    localObject,
    attachment,
    input.limits,
    input.signal,
  );
  if (local === "infected") {
    const quarantined = await transitionOrSuperseded(
      repository,
      transition,
      payload,
      "inspecting",
      "quarantined",
      {
        scannerMode: "local",
        scannerVersion: ATTACHMENT_LOCAL_SCANNER_VERSION,
        policyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      },
      ATTACHMENT_INSPECTION_REASON.localPolicyRejected,
    );
    return quarantined
      ? { status: "quarantined", attachment: quarantined }
      : { status: "superseded" };
  }

  if (payload.requiredInspectionMode === "external" && input.scanner) {
    const scannerObject = await input.objectStore.get(attachment.objectKey, input.signal);
    if (!scannerObject) throw new Error("Attachment object is unavailable for scanning");
    const scanned = await scanWithExternalService(scannerObject, input.scanner, {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sha256: attachment.sha256,
      signal: input.signal,
      fetch: input.fetch,
      resolveDns: input.resolveDns,
    });
    if (scanned.status === "error") throw new MalwareScannerError();
    if (scanned.status === "infected") {
      const quarantined = await transitionOrSuperseded(
        repository,
        transition,
        payload,
        "inspecting",
        "quarantined",
        configuredAudit,
        ATTACHMENT_INSPECTION_REASON.malwareDetected,
      );
      return quarantined
        ? { status: "quarantined", attachment: quarantined }
        : { status: "superseded" };
    }
  }

  const ready = await transitionOrSuperseded(
    repository,
    transition,
    payload,
    "inspecting",
    "ready",
    configuredAudit,
  );
  return ready ? { status: "ready", attachment: ready } : { status: "superseded" };
}

export class AttachmentInspectionClaimLostError extends Error {
  override name = "AttachmentInspectionClaimLostError";
  constructor() {
    super("Attachment inspection job claim was reclaimed");
  }
}

/**
 * PostgreSQL worker transition that atomically proves the durable claim, advances the epoch-bound
 * state, schedules ingestion, and records a secret-free audit. The external scan can therefore
 * never mutate state after another replica has reclaimed its job.
 */
export async function transitionClaimedAttachmentInspection(
  sql: Sql,
  repository: Pick<DomainRepository, "getAttachment">,
  job: ClaimedJob,
  input: FencedAttachmentInspectionTransitionInput,
  audit: AttachmentInspectionAuditContext,
  leaseSeconds: number,
): Promise<AttachmentRecord> {
  requireLeaseSeconds(leaseSeconds);
  const reason = input.inspectionError?.trim() || null;
  const requiresReason = ["quarantined", "failed"].includes(input.nextState);
  if (
    !Number.isSafeInteger(input.inspectionEpoch) || input.inspectionEpoch < 1 ||
    (input.expectedState === "pending" && input.nextState !== "inspecting") ||
    (input.expectedState === "inspecting" &&
      !["ready", "quarantined", "failed"].includes(input.nextState)) ||
    (requiresReason ? reason === null : reason !== null) ||
    (reason !== null && reason.length > 1_000)
  ) throw new TypeError("Attachment inspection transition is invalid");
  await sql.begin(async (tx) => {
    const claim = await tx`SELECT id FROM jobs WHERE id=${job.id} AND type='attachment.inspect'
      AND status='running' AND locked_by=${job.claimToken}
      AND payload->>'attachmentId'=${input.attachmentId}
      AND payload->>'ownerId'=${input.ownerId}
      AND payload->>'inspectionEpoch'=${String(input.inspectionEpoch)}
      AND payload->>'requiredInspectionMode'=${input.requiredInspectionMode}
      AND payload->>'inspectionPolicyVersion'=${input.inspectionPolicyVersion}
      AND locked_at > now() - ${leaseSeconds} * interval '1 second' FOR UPDATE`;
    if (!claim.length) throw new AttachmentInspectionClaimLostError();
    const rows = await tx<{ id: string; ingestion_status: string }[]>`
      UPDATE attachments SET state=${input.nextState},
        inspection_error=${reason},version=version+1,
        ingestion_status=CASE
          WHEN ${input.nextState}='ready' AND ingestion_status<>'ready'
            AND mime_type=ANY(${[...INGESTIBLE_DOCUMENT_MIME_TYPES]})
          THEN 'queued' ELSE ingestion_status END,
        ingestion_error=CASE WHEN ${input.nextState}='ready' THEN NULL ELSE ingestion_error END,
        updated_at=now()
      WHERE id=${input.attachmentId} AND owner_id=${input.ownerId}
        AND deleted_at IS NULL AND inspection_epoch=${input.inspectionEpoch}
        AND required_inspection_mode=${input.requiredInspectionMode}
        AND inspection_policy_version=${input.inspectionPolicyVersion}
        AND state=${input.expectedState}
      RETURNING id,ingestion_status`;
    if (!rows[0]) {
      const exists = await tx`SELECT id FROM attachments WHERE id=${input.attachmentId}
        AND owner_id=${input.ownerId}`;
      if (!exists.length) throw new DomainError("not_found", "Attachment not found", 404);
      throw new DomainError(
        "attachment_inspection_conflict",
        "Attachment inspection epoch or state changed",
        409,
      );
    }
    if (input.nextState === "ready" && rows[0].ingestion_status === "queued") {
      await tx`INSERT INTO jobs(type,payload,idempotency_key)
        VALUES('attachment.ingest',${
        tx.json({ attachmentId: input.attachmentId, ownerId: input.ownerId })
      },${`attachment.ingest:${input.attachmentId}`})
        ON CONFLICT(idempotency_key) DO NOTHING`;
    }
    await tx`INSERT INTO audit_events(action,target_type,target_id,metadata)
      VALUES(${
      input.nextState === "inspecting"
        ? "attachment.inspection.started"
        : "attachment.inspection.completed"
    },'attachment',${input.attachmentId},${
      tx.json({
        ownerId: input.ownerId,
        jobId: job.id,
        inspectionEpoch: input.inspectionEpoch,
        from: input.expectedState,
        to: input.nextState,
        reason,
        scannerMode: audit.scannerMode,
        scannerVersion: audit.scannerVersion,
        policyVersion: audit.policyVersion,
      })
    })`;
  });
  return await repository.getAttachment(input.attachmentId, input.ownerId, true);
}

/** Settles a scanner/storage failure under both the durable job claim and inspection epoch. */
export async function recordAttachmentInspectionFailure(
  sql: Sql,
  job: ClaimedJob,
  payload: AttachmentInspectionPayload,
  leaseSeconds: number,
  maxAttempts = 5,
): Promise<boolean> {
  requireLeaseSeconds(leaseSeconds);
  const retry = job.attempts + 1 < maxAttempts;
  return await sql.begin(async (tx) => {
    const claimed = await tx`SELECT id FROM jobs WHERE id=${job.id} AND type='attachment.inspect'
      AND status='running' AND locked_by=${job.claimToken}
      AND payload->>'attachmentId'=${payload.attachmentId}
      AND payload->>'ownerId'=${payload.ownerId}
      AND payload->>'inspectionEpoch'=${String(payload.inspectionEpoch)}
      AND payload->>'requiredInspectionMode'=${payload.requiredInspectionMode}
      AND payload->>'inspectionPolicyVersion'=${payload.inspectionPolicyVersion}
      AND locked_at > now() - ${leaseSeconds} * interval '1 second' FOR UPDATE`;
    if (!claimed.length) return false;
    const current = await tx<{
      state: AttachmentRecord["state"];
      inspection_epoch: number;
      inspection_error: string | null;
      deleted_at: Date | null;
      required_inspection_mode: string;
      inspection_policy_version: string;
    }[]>`
      SELECT state,inspection_epoch,inspection_error,deleted_at,
        required_inspection_mode,inspection_policy_version FROM attachments
      WHERE id=${payload.attachmentId} AND owner_id=${payload.ownerId} FOR UPDATE`;
    if (
      !current[0] || Number(current[0].inspection_epoch) !== payload.inspectionEpoch ||
      current[0].required_inspection_mode !== payload.requiredInspectionMode ||
      current[0].inspection_policy_version !== payload.inspectionPolicyVersion ||
      inspectionEpochIsTerminal({
        state: current[0].state,
        inspectionError: current[0].inspection_error,
        deletedAt: current[0].deleted_at?.toISOString() ?? null,
      })
    ) {
      await tx`UPDATE jobs SET status='completed',completed_at=now(),last_error=NULL,
        locked_at=NULL,locked_by=NULL WHERE id=${job.id}`;
      return true;
    }
    if (!retry) {
      const failed = await tx<{ id: string }[]>`UPDATE attachments SET state='failed',
        inspection_error=${ATTACHMENT_INSPECTION_REASON.retryExhausted},
        version=version+1,updated_at=now()
        WHERE id=${payload.attachmentId} AND owner_id=${payload.ownerId}
          AND inspection_epoch=${payload.inspectionEpoch} AND state IN ('pending','inspecting')
          AND required_inspection_mode=${payload.requiredInspectionMode}
          AND inspection_policy_version=${payload.inspectionPolicyVersion}
          AND deleted_at IS NULL RETURNING id`;
      if (failed[0]) {
        await tx`INSERT INTO audit_events(action,target_type,target_id,metadata)
          VALUES('attachment.inspection.completed','attachment',${payload.attachmentId},${
          tx.json({
            ownerId: payload.ownerId,
            jobId: job.id,
            inspectionEpoch: payload.inspectionEpoch,
            from: current[0].state,
            to: "failed",
            reason: ATTACHMENT_INSPECTION_REASON.retryExhausted,
            scannerMode: "worker",
            scannerVersion: "inspection-worker-v1",
            policyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
          })
        })`;
      }
    }
    await tx`UPDATE jobs SET status=${retry ? "queued" : "failed"},
      last_error='Attachment inspection attempt failed',
      available_at=now()+${Math.min(300, 2 ** job.attempts)}*interval '1 second',
      locked_at=NULL,locked_by=NULL WHERE id=${job.id}`;
    return true;
  });
}
