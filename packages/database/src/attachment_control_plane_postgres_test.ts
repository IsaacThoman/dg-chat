import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import {
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  ATTACHMENT_INSPECTION_REASON,
} from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

function input(ownerId: string, ordinal: number) {
  return {
    ownerId,
    objectKey: `control/${ownerId}/${ordinal}`,
    filename: `${ordinal}.txt`,
    mimeType: "text/plain",
    sizeBytes: 40,
    sha256: ordinal.toString(16).padStart(64, "0"),
    state: "ready" as const,
    inspectionComplete: true,
  };
}

Deno.test({
  name: "Postgres attachment quota admission and reinspection serialize across replicas",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 8 });
    const repositories = await Promise.all(
      Array.from({ length: 4 }, () => PostgresRepository.connect(databaseUrl!)),
    );
    try {
      const suffix = crypto.randomUUID();
      const owner = await repositories[0].createUser({
        email: `control-owner-${suffix}@example.test`,
        name: "Storage owner",
      });
      const admin = await repositories[0].createUser({
        email: `control-admin-${suffix}@example.test`,
        name: "Storage admin",
      });
      await sql`UPDATE users SET role='admin',approval_status='approved',state='active'
        WHERE id=${admin.id}`;
      const baseline = Number(
        (await sql`SELECT physical_bytes FROM attachment_storage_installation
          WHERE singleton_id=1`)[0].physical_bytes,
      );
      const attempts = await Promise.allSettled(
        repositories.slice(0, 2).map((repository, index) =>
          repository.createAttachment(input(owner.id, index + 100), {
            perUserBytes: 40,
            perUserObjects: 10,
            installationBytes: baseline + 40,
            installationObjects: 100,
          })
        ),
      );
      assertEquals(attempts.filter((item) => item.status === "fulfilled").length, 1);
      const rejection = attempts.find((item) => item.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      assertEquals(rejection?.reason instanceof DomainError, true);
      assertEquals(rejection?.reason.code, "storage_quota_exceeded");
      const created = (attempts.find((item) =>
        item.status === "fulfilled"
      ) as PromiseFulfilledResult<Awaited<ReturnType<typeof repositories[0]["createAttachment"]>>>)
        .value.attachment;
      assertEquals(await repositories[0].attachmentStorageUsage(owner.id), {
        ownerId: owner.id,
        physicalBytes: 40,
        physicalObjects: 1,
      });

      const requests = await Promise.allSettled(
        repositories.slice(0, 2).map((repository) =>
          repository.requestAttachmentReinspection({
            actorId: admin.id,
            attachmentId: created.id,
            expectedVersion: created.version,
            reason: "Scanner policy epoch changed",
            requiredInspectionMode: "external",
            inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
          })
        ),
      );
      assertEquals(
        requests.filter((item) =>
          item.status === "fulfilled"
        ).length,
        1,
        JSON.stringify(
          requests.map((item) =>
            item.status === "rejected"
              ? {
                code: item.reason instanceof DomainError ? item.reason.code : undefined,
                message: item.reason instanceof Error ? item.reason.message : String(item.reason),
              }
              : { status: "fulfilled" }
          ),
        ),
      );
      const requested = (requests.find((item) =>
        item.status === "fulfilled"
      ) as PromiseFulfilledResult<
        Awaited<ReturnType<typeof repositories[0]["requestAttachmentReinspection"]>>
      >).value;
      assertEquals(requested.attachment.inspectionEpoch, 2);
      assertEquals(requested.attachment.requiredInspectionMode, "external");
      assertEquals(
        String(
          (await sql`SELECT idempotency_key FROM jobs WHERE id=${requested.inspectionJobId}`)[0]
            .idempotency_key,
        ),
        `attachment.inspect:${created.id}:2`,
      );
      assertEquals(
        (await sql<{ payload: Record<string, unknown> }[]>`
          SELECT payload FROM jobs WHERE id=${requested.inspectionJobId}`)[0].payload,
        {
          attachmentId: created.id,
          ownerId: owner.id,
          inspectionEpoch: 2,
          requiredInspectionMode: "external",
          inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
        },
      );
      assertEquals(
        (await sql<{ metadata: Record<string, unknown> }[]>`
          SELECT metadata FROM audit_events
          WHERE action='attachment.reinspection_requested'
            AND target_id=${created.id}`)[0].metadata,
        {
          ownerId: owner.id,
          reason: "Scanner policy epoch changed",
          before: {
            state: "ready",
            inspectionEpoch: 1,
            requiredInspectionMode: "local",
            inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
            version: created.version,
          },
          after: {
            state: "pending",
            inspectionEpoch: 2,
            requiredInspectionMode: "external",
            inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
            version: created.version + 1,
          },
          inspectionJobId: requested.inspectionJobId,
        },
      );
      const stale = await Promise.allSettled([
        repositories[0].transitionAttachmentInspection({
          attachmentId: created.id,
          ownerId: owner.id,
          inspectionEpoch: 1,
          expectedState: "pending",
          nextState: "inspecting",
        }),
      ]);
      assertEquals(stale[0].status, "rejected");
      await repositories[0].transitionAttachmentInspection({
        attachmentId: created.id,
        ownerId: owner.id,
        inspectionEpoch: 2,
        expectedState: "pending",
        nextState: "inspecting",
      });
      await assertRejects(
        () =>
          repositories[0].transitionAttachmentInspection({
            attachmentId: created.id,
            ownerId: owner.id,
            inspectionEpoch: 2,
            expectedState: "inspecting",
            nextState: "failed",
          }),
        DomainError,
        "transition is invalid",
      );
      const ready = await repositories[0].transitionAttachmentInspection({
        attachmentId: created.id,
        ownerId: owner.id,
        inspectionEpoch: 2,
        expectedState: "inspecting",
        nextState: "ready",
      });
      assertEquals(ready.version, 4);
      assertEquals(
        Number(
          (await sql`SELECT count(*)::int count FROM audit_events
            WHERE action='attachment.inspection.completed' AND target_id=${created.id}`)[0].count,
        ),
        1,
      );
      await assertRejects(
        () =>
          repositories[0].transitionAttachmentInspection({
            attachmentId: created.id,
            ownerId: owner.id,
            inspectionEpoch: 2,
            expectedState: "inspecting",
            nextState: "ready",
          }),
        DomainError,
        "epoch or state changed",
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*)::int count FROM audit_events
            WHERE action='attachment.inspection.completed' AND target_id=${created.id}`)[0].count,
        ),
        1,
      );
      await assertRejects(() =>
        sql`UPDATE attachments SET object_key='control/tampered' WHERE id=${created.id}`
      );

      const metadataCopy = crypto.randomUUID();
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state)
        VALUES(${metadataCopy},${owner.id},${created.objectKey},'copy.txt','text/plain',40,
          ${created.sha256},'ready')`;
      assertEquals((await repositories[0].attachmentStorageUsage(owner.id)).physicalBytes, 40);
      const page = await repositories[0].listAdminAttachments(admin.id, {
        ownerId: owner.id,
        limit: 1,
      });
      assertEquals(page.nextCursor !== null, true);
      const next = await repositories[0].listAdminAttachments(admin.id, {
        ownerId: owner.id,
        limit: 1,
        cursor: page.nextCursor!,
      });
      assertEquals(
        new Set([page.data[0].id, next.data[0].id]),
        new Set([created.id, metadataCopy]),
      );
      const synchronousQuarantine = (await repositories[0].createAttachment({
        ...input(owner.id, 150),
        state: "quarantined",
        inspectionError: "image_guard_animation_rejected",
      })).attachment;
      const synchronousResult = await Promise.allSettled([
        repositories[0].requestAttachmentReinspection({
          actorId: admin.id,
          attachmentId: synchronousQuarantine.id,
          expectedVersion: synchronousQuarantine.version,
          reason: "must not bypass upload policy",
          requiredInspectionMode: "external",
          inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
        }),
      ]);
      assertEquals(synchronousResult[0].status, "rejected");
      assertEquals(
        (synchronousResult[0] as PromiseRejectedResult).reason.code,
        "attachment_state_conflict",
      );
      const workerQuarantine = (await repositories[0].createAttachment({
        ...input(owner.id, 151),
        state: "quarantined",
        inspectionError: ATTACHMENT_INSPECTION_REASON.localPolicyRejected,
      })).attachment;
      assertEquals(
        (await repositories[0].requestAttachmentReinspection({
          actorId: admin.id,
          attachmentId: workerQuarantine.id,
          expectedVersion: workerQuarantine.version,
          reason: "worker policy signature was corrected",
          requiredInspectionMode: "external",
          inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
        })).attachment.state,
        "pending",
      );
      await repositories[0].deleteAttachment(created.id, owner.id);
      const external = await repositories[0].createAttachment({
        ...input(owner.id, 159),
        state: "pending",
        inspectionComplete: false,
        requiredInspectionMode: "external",
        inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      });
      assertEquals(external.attachment.requiredInspectionMode, "external");
      assertEquals(
        (await sql<{ payload: Record<string, unknown> }[]>`
          SELECT payload FROM jobs WHERE id=${external.inspectionJobId}
        `)[0].payload,
        {
          attachmentId: external.attachment.id,
          ownerId: owner.id,
          inspectionEpoch: 1,
          requiredInspectionMode: "external",
          inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
        },
      );
      assertEquals((await repositories[0].attachmentStorageUsage(owner.id)).physicalBytes, 160);
      const cleanupRunId = `cleanup-${suffix}`;
      await sql`INSERT INTO usage_runs(
        id,user_id,model,provider,status,recovery_owner
      ) VALUES(${cleanupRunId},${owner.id},'test/image','test','completed','provider')`;
      const orphan = (await repositories[0].createAttachment(input(owner.id, 160))).attachment;
      const stage = await repositories[0].stageGeneratedObject({
        ownerId: owner.id,
        usageRunId: cleanupRunId,
        ordinal: 0,
        objectKey: orphan.objectKey,
        mimeType: orphan.mimeType,
        sizeBytes: orphan.sizeBytes,
        sha256: orphan.sha256,
      });
      await repositories[0].markGeneratedObjectStored(stage.id, owner.id);
      await repositories[0].attachGeneratedObject(stage.id, owner.id, orphan.id);
      assertEquals(
        await repositories[0].requestGeneratedObjectCleanup(
          owner.id,
          cleanupRunId,
          "provider result abandoned",
        ),
        1,
      );
      await sql`UPDATE jobs SET status='failed',attempts=9,last_error='retry budget exhausted',
        completed_at=now() WHERE idempotency_key=${`generated_object.cleanup:${stage.id}`}`;
      assertEquals(
        await repositories[0].requestGeneratedObjectCleanup(
          owner.id,
          cleanupRunId,
          "late object write requires cleanup retry",
        ),
        1,
      );
      assertEquals(
        [
          ...await sql`SELECT status,attempts,last_error,completed_at
            FROM jobs WHERE idempotency_key=${`generated_object.cleanup:${stage.id}`}`,
        ],
        [{ status: "queued", attempts: 0, last_error: null, completed_at: null }],
      );
      await sql`UPDATE generated_object_staging SET state='cleaning' WHERE id=${stage.id}`;
      await repositories[0].deleteAttachment(orphan.id, owner.id);
      const settlement = await repositories[0].settleGeneratedObjectCleanup(stage.id, owner.id);
      assertEquals(settlement.storageReleased, true);
      assertEquals(settlement.stage.state, "cleaned");
      assertEquals(
        (await repositories[0].settleGeneratedObjectCleanup(stage.id, owner.id)).storageReleased,
        false,
      );
      assertEquals((await repositories[0].attachmentStorageUsage(owner.id)).physicalBytes, 160);
      assertEquals(
        Number(
          (await sql`SELECT count(*)::int count FROM attachment_storage_releases
            WHERE stage_id=${stage.id}`)[0].count,
        ),
        1,
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*)::int count FROM audit_events
            WHERE action='attachment.reinspection_requested' AND target_id=${created.id}`)[0].count,
        ),
        1,
      );
    } finally {
      await Promise.all(repositories.map((repository) => repository.close()));
      await sql.end();
    }
  },
});
