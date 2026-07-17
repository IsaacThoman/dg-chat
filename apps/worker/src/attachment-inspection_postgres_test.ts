import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  ATTACHMENT_INSPECTION_REASON,
  PostgresRepository,
} from "@dg-chat/database";
import postgres from "npm:postgres@3.4.7";
import {
  ATTACHMENT_EXTERNAL_SCANNER_VERSION,
  ATTACHMENT_LOCAL_SCANNER_VERSION,
  AttachmentInspectionClaimLostError,
  parseAttachmentInspectionPayload,
  recordAttachmentInspectionFailure,
  transitionClaimedAttachmentInspection,
} from "./attachment-inspection.ts";
import type { ClaimedJob } from "./job-queue.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const localAudit = {
  scannerMode: "local" as const,
  scannerVersion: ATTACHMENT_LOCAL_SCANNER_VERSION,
  policyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
};
const externalAudit = {
  scannerMode: "external" as const,
  scannerVersion: ATTACHMENT_EXTERNAL_SCANNER_VERSION,
  policyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
};

Deno.test({
  name: "inspection retry and exhaustion are claim- and epoch-fenced without leaking failures",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!, { poolMax: 2 });
    try {
      const owner = await repository.createUser({
        email: `inspection-worker-${crypto.randomUUID()}@example.test`,
        name: "Inspection worker",
      });
      await sql`UPDATE users SET role='admin',approval_status='approved',state='active'
        WHERE id=${owner.id}`;
      const digest = "a".repeat(64);
      const created = await repository.createAttachment({
        ownerId: owner.id,
        objectKey: `uploads/${owner.id}/blobs/aa/${digest}.txt`,
        filename: "scan.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: digest,
      });
      if (!created.inspectionJobId) throw new Error("Expected inspection job");
      const payload = parseAttachmentInspectionPayload({
        attachmentId: created.attachment.id,
        ownerId: owner.id,
        inspectionEpoch: created.attachment.inspectionEpoch,
        requiredInspectionMode: created.attachment.requiredInspectionMode,
        inspectionPolicyVersion: created.attachment.inspectionPolicyVersion,
      });
      const claim = async (attempts: number): Promise<ClaimedJob> => {
        const claimToken = `inspection-test:${crypto.randomUUID()}`;
        const rows = await sql<{ id: string; idempotency_key: string | null }[]>`
          UPDATE jobs SET status='running',attempts=${attempts},locked_at=now(),
            locked_by=${claimToken},last_error=NULL
          WHERE id=${created.inspectionJobId} RETURNING id,idempotency_key`;
        return {
          id: rows[0].id,
          type: "attachment.inspect",
          payload,
          attempts,
          claimToken,
          idempotencyKey: rows[0].idempotency_key,
          externalDeadlineMonotonicMs: performance.now() + 10_000,
        };
      };

      await assertRejects(
        () =>
          transitionClaimedAttachmentInspection(
            sql,
            repository,
            {
              id: created.inspectionJobId!,
              type: "attachment.inspect",
              payload,
              attempts: 0,
              claimToken: "reclaimed-token",
              idempotencyKey: null,
              externalDeadlineMonotonicMs: performance.now() + 10_000,
            },
            { ...payload, expectedState: "pending", nextState: "inspecting" },
            localAudit,
            30,
          ),
        AttachmentInspectionClaimLostError,
      );
      assertEquals(
        (await repository.getAttachment(created.attachment.id, owner.id)).state,
        "pending",
      );

      const expired = await claim(0);
      await sql`UPDATE jobs SET locked_at=now()-interval '31 seconds'
        WHERE id=${created.inspectionJobId}`;
      await assertRejects(
        () =>
          transitionClaimedAttachmentInspection(
            sql,
            repository,
            expired,
            { ...payload, expectedState: "pending", nextState: "inspecting" },
            localAudit,
            30,
          ),
        AttachmentInspectionClaimLostError,
      );
      assertEquals(
        await recordAttachmentInspectionFailure(sql, expired, payload, 30),
        false,
      );
      assertEquals(
        (await repository.getAttachment(created.attachment.id, owner.id)).state,
        "pending",
      );

      const retrying = await claim(1);
      await transitionClaimedAttachmentInspection(
        sql,
        repository,
        retrying,
        { ...payload, expectedState: "pending", nextState: "inspecting" },
        localAudit,
        30,
      );
      assertEquals(
        await recordAttachmentInspectionFailure(sql, retrying, payload, 30),
        true,
      );
      assertEquals(
        [
          ...await sql`SELECT status,attempts,last_error,locked_by FROM jobs
          WHERE id=${created.inspectionJobId}`,
        ],
        [{
          status: "queued",
          attempts: 1,
          last_error: "Attachment inspection attempt failed",
          locked_by: null,
        }],
      );
      assertEquals(
        (await repository.getAttachment(created.attachment.id, owner.id)).state,
        "inspecting",
      );

      const exhausted = await claim(4);
      assertEquals(
        await recordAttachmentInspectionFailure(sql, exhausted, payload, 30),
        true,
      );
      assertEquals(
        [...await sql`SELECT status,last_error FROM jobs WHERE id=${created.inspectionJobId}`],
        [{
          status: "failed",
          last_error: "Attachment inspection attempt failed",
        }],
      );
      const failed = await repository.getAttachment(created.attachment.id, owner.id);
      assertEquals(failed.state, "failed");
      assertEquals(failed.inspectionError, ATTACHMENT_INSPECTION_REASON.retryExhausted);
      assertEquals(
        await recordAttachmentInspectionFailure(sql, exhausted, payload, 30),
        false,
      );
      const audits = await sql<{
        action: string;
        metadata: {
          ownerId: string;
          jobId: string;
          inspectionEpoch: number;
          from: string;
          to: string;
          reason: string | null;
          scannerMode: string;
          scannerVersion: string;
          policyVersion: string;
        };
      }[]>`
        SELECT action,metadata FROM audit_events
        WHERE target_id=${created.attachment.id}
          AND action IN ('attachment.inspection.started','attachment.inspection.completed')
        ORDER BY created_at,id`;
      assertEquals(audits.length, 2);
      assertEquals(audits.map((event) => event.action), [
        "attachment.inspection.started",
        "attachment.inspection.completed",
      ]);
      assertEquals(audits[0].metadata, {
        ownerId: owner.id,
        jobId: created.inspectionJobId,
        inspectionEpoch: created.attachment.inspectionEpoch,
        from: "pending",
        to: "inspecting",
        reason: null,
        scannerMode: "local",
        scannerVersion: ATTACHMENT_LOCAL_SCANNER_VERSION,
        policyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      });
      assertEquals(audits[1].metadata, {
        ownerId: owner.id,
        jobId: created.inspectionJobId,
        inspectionEpoch: created.attachment.inspectionEpoch,
        from: "inspecting",
        to: "failed",
        reason: ATTACHMENT_INSPECTION_REASON.retryExhausted,
        scannerMode: "worker",
        scannerVersion: "inspection-worker-v1",
        policyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      });
      const serializedAudits = JSON.stringify(audits);
      assertEquals(serializedAudits.includes("reclaimed-token"), false);
      assertEquals(
        serializedAudits.includes(created.attachment.objectKey),
        false,
      );

      const preTransitionDigest = "c".repeat(64);
      const preTransition = await repository.createAttachment({
        ownerId: owner.id,
        objectKey: `uploads/${owner.id}/blobs/cc/${preTransitionDigest}.txt`,
        filename: "pre-transition-failure.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: preTransitionDigest,
      });
      if (!preTransition.inspectionJobId) throw new Error("Expected inspection job");
      const preTransitionClaim = `inspection-test:${crypto.randomUUID()}`;
      await sql`UPDATE jobs SET status='running',attempts=4,locked_at=now(),
        locked_by=${preTransitionClaim},last_error=NULL
        WHERE id=${preTransition.inspectionJobId}`;
      assertEquals(
        await recordAttachmentInspectionFailure(
          sql,
          {
            id: preTransition.inspectionJobId,
            type: "attachment.inspect",
            payload: {},
            attempts: 4,
            claimToken: preTransitionClaim,
            idempotencyKey: null,
            externalDeadlineMonotonicMs: performance.now() + 10_000,
          },
          {
            attachmentId: preTransition.attachment.id,
            ownerId: owner.id,
            inspectionEpoch: preTransition.attachment.inspectionEpoch,
            requiredInspectionMode: preTransition.attachment.requiredInspectionMode,
            inspectionPolicyVersion: preTransition.attachment.inspectionPolicyVersion,
          },
          30,
        ),
        true,
      );
      assertEquals(
        (await repository.getAttachment(preTransition.attachment.id, owner.id)).state,
        "failed",
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*)::int count FROM audit_events
            WHERE target_id=${preTransition.attachment.id}
              AND action='attachment.inspection.completed'
              AND metadata->>'from'='pending'
              AND metadata->>'to'='failed'`)[0].count,
        ),
        1,
      );

      const externalDigest = "f".repeat(64);
      const external = await repository.createAttachment({
        ownerId: owner.id,
        objectKey: `uploads/${owner.id}/blobs/ff/${externalDigest}.txt`,
        filename: "external.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: externalDigest,
        requiredInspectionMode: "external",
        inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      });
      if (!external.inspectionJobId) throw new Error("Expected external inspection job");
      const externalPayload = parseAttachmentInspectionPayload(
        (await sql<{ payload: unknown }[]>`
          SELECT payload FROM jobs WHERE id=${external.inspectionJobId}`)[0].payload,
      );
      assertEquals(externalPayload.requiredInspectionMode, "external");
      assertEquals(
        externalPayload.inspectionPolicyVersion,
        ATTACHMENT_INSPECTION_POLICY_VERSION,
      );
      const externalClaimToken = `external-inspection:${crypto.randomUUID()}`;
      const externalJob: ClaimedJob = {
        id: external.inspectionJobId,
        type: "attachment.inspect",
        payload: externalPayload,
        attempts: 0,
        claimToken: externalClaimToken,
        idempotencyKey:
          `attachment.inspect:${external.attachment.id}:${external.attachment.inspectionEpoch}`,
        externalDeadlineMonotonicMs: performance.now() + 10_000,
      };
      await sql`UPDATE jobs SET status='running',locked_at=now(),locked_by=${externalClaimToken}
        WHERE id=${external.inspectionJobId}`;
      await sql`UPDATE jobs SET payload=jsonb_set(
        payload,'{inspectionPolicyVersion}','"unknown-policy"'::jsonb
      ) WHERE id=${external.inspectionJobId}`;
      await assertRejects(
        () =>
          transitionClaimedAttachmentInspection(
            sql,
            repository,
            externalJob,
            { ...externalPayload, expectedState: "pending", nextState: "inspecting" },
            externalAudit,
            30,
          ),
        AttachmentInspectionClaimLostError,
      );
      await sql`UPDATE jobs SET payload=${sql.json({ ...externalPayload })}
        WHERE id=${external.inspectionJobId}`;
      await assertRejects(
        () =>
          transitionClaimedAttachmentInspection(
            sql,
            repository,
            externalJob,
            {
              ...externalPayload,
              requiredInspectionMode: "local",
              expectedState: "pending",
              nextState: "inspecting",
            },
            localAudit,
            30,
          ),
        AttachmentInspectionClaimLostError,
      );
      await transitionClaimedAttachmentInspection(
        sql,
        repository,
        externalJob,
        { ...externalPayload, expectedState: "pending", nextState: "inspecting" },
        externalAudit,
        30,
      );
      await transitionClaimedAttachmentInspection(
        sql,
        repository,
        externalJob,
        {
          ...externalPayload,
          expectedState: "inspecting",
          nextState: "failed",
          inspectionError: ATTACHMENT_INSPECTION_REASON.externalScannerUnavailable,
        },
        externalAudit,
        30,
      );
      const externalFailed = await repository.getAttachment(external.attachment.id, owner.id);
      assertEquals(externalFailed.state, "failed");
      assertEquals(
        externalFailed.inspectionError,
        ATTACHMENT_INSPECTION_REASON.externalScannerUnavailable,
      );

      const secondDigest = "b".repeat(64);
      const second = await repository.createAttachment({
        ownerId: owner.id,
        objectKey: `uploads/${owner.id}/blobs/bb/${secondDigest}.txt`,
        filename: "rescan.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: secondDigest,
        state: "ready",
        inspectionComplete: true,
      });
      const reinspection = await repository.requestAttachmentReinspection({
        actorId: owner.id,
        attachmentId: second.attachment.id,
        expectedVersion: second.attachment.version,
        reason: "New scanner policy",
      });
      const staleJobId = crypto.randomUUID();
      const staleClaimToken = `stale-inspection:${crypto.randomUUID()}`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key,status,attempts,locked_at,locked_by)
        VALUES(${staleJobId},'attachment.inspect',${
        sql.json({
          attachmentId: second.attachment.id,
          ownerId: owner.id,
          inspectionEpoch: 1,
          requiredInspectionMode: second.attachment.requiredInspectionMode,
          inspectionPolicyVersion: second.attachment.inspectionPolicyVersion,
        })
      },${`attachment.inspect:stale:${staleJobId}`},'running',4,now(),${staleClaimToken})`;
      assertEquals(
        await recordAttachmentInspectionFailure(
          sql,
          {
            id: staleJobId,
            type: "attachment.inspect",
            payload: {},
            attempts: 4,
            claimToken: staleClaimToken,
            idempotencyKey: `attachment.inspect:stale:${staleJobId}`,
            externalDeadlineMonotonicMs: performance.now() + 10_000,
          },
          {
            attachmentId: second.attachment.id,
            ownerId: owner.id,
            inspectionEpoch: 1,
            requiredInspectionMode: second.attachment.requiredInspectionMode,
            inspectionPolicyVersion: second.attachment.inspectionPolicyVersion,
          },
          30,
        ),
        true,
      );
      assertEquals(
        [...await sql`SELECT status,last_error FROM jobs WHERE id=${staleJobId}`],
        [{ status: "completed", last_error: null }],
      );
      const current = await repository.getAttachment(second.attachment.id, owner.id);
      assertEquals(current.state, "pending");
      assertEquals(current.inspectionEpoch, reinspection.attachment.inspectionEpoch);
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
