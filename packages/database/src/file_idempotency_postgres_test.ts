import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";
import { ATTACHMENT_INSPECTION_POLICY_VERSION } from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres file idempotency is fenced, replayable, and payload-bound",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE audit_events,ledger_entries,usage_runs,api_tokens,sessions,messages,
        conversations,auth_sessions,auth_accounts,auth_verifications,auth_users,users
        RESTART IDENTITY CASCADE`,
    );
    try {
      const owner = await repository.bootstrapAdmin({
        email: "postgres-file-idempotency@example.test",
        name: "Postgres file idempotency",
        passwordHash: "test-only",
      }, 0);
      const cleanupPayload = {
        requestId: crypto.randomUUID(),
        ownerId: owner.id,
        objectKey: `uploads/${owner.id}/blobs/cc/${"c".repeat(64)}.txt`,
      };
      const cleanupKey = `file_object.cleanup:${cleanupPayload.requestId}`;
      const firstCleanupJob = await repository.enqueueJob(
        "file_object.cleanup",
        cleanupPayload,
        new Date(Date.now() + 60_000).toISOString(),
        cleanupKey,
      );
      const replayedCleanupJob = await repository.enqueueJob(
        "file_object.cleanup",
        cleanupPayload,
        new Date(Date.now() + 120_000).toISOString(),
        cleanupKey,
      );
      assertEquals(replayedCleanupJob, firstCleanupJob);
      await assertRejects(
        () =>
          repository.enqueueJob(
            "file_object.cleanup",
            { ...cleanupPayload, objectKey: cleanupPayload.objectKey.replace("/cc/", "/dd/") },
            undefined,
            cleanupKey,
          ),
        DomainError,
        "payload differs",
      );
      assertEquals(
        (await sql<{ count: number }[]>`
          SELECT count(*)::int count FROM jobs WHERE idempotency_key=${cleanupKey}
        `)[0]?.count,
        1,
      );
      const input = {
        userId: owner.id,
        endpoint: "files" as const,
        idempotencyKey: "postgres-file-upload-0001",
        requestHash: "a".repeat(64),
        stream: false,
        model: "files/upload",
        runId: `${owner.id}:files:${crypto.randomUUID()}`,
        reserveMicros: 0,
        provider: "local",
        replayReservedBytes: 16 * 1024,
      };
      const invalidPurpose = await repository.beginApiRequest({
        ...input,
        idempotencyKey: "postgres-file-upload-invalid-purpose",
        requestHash: "f".repeat(64),
        runId: `${owner.id}:files:${crypto.randomUUID()}`,
      });
      if (invalidPurpose.kind !== "started") throw new Error("missing invalid-purpose request");
      await assertRejects(
        () =>
          repository.stageFileUpload({
            requestId: invalidPurpose.request.id,
            ownerId: owner.id,
            objectKey: `uploads/${owner.id}/blobs/ff/${"f".repeat(64)}.txt`,
            filename: "invalid.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            sha256: "f".repeat(64),
            purpose: "fine-tune",
            attachmentState: "ready",
            inspectionError: null,
            requiredInspectionMode: "local",
            inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
          }),
        DomainError,
        "purpose",
      );
      await repository.failApiRequest({
        id: invalidPurpose.request.id,
        leaseToken: invalidPurpose.leaseToken,
        responseStatus: 422,
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify({ error: { code: "unsupported_purpose" } }),
        billing: { mode: "refund" },
      });
      const [first, second] = await Promise.all([
        repository.beginApiRequest(input),
        repository.beginApiRequest(input),
      ]);
      assertEquals([first.kind, second.kind].sort(), ["in_progress", "started"]);
      const started = first.kind === "started" ? first : second;
      if (started.kind !== "started") throw new Error("missing file upload winner");
      const attachment = (filename: string) => ({
        ownerId: owner.id,
        objectKey: `uploads/${owner.id}/blobs/aa/${"a".repeat(64)}.txt`,
        filename,
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "a".repeat(64),
        state: "ready" as const,
        inspectionComplete: true,
      });
      const completion = (id: string, leaseToken: string) => ({
        id,
        leaseToken,
        responseStatus: 201,
        responseHeaders: { "content-type": "application/json" },
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 1,
      });
      const stage = async (id: string, leaseToken: string, filename: string) => {
        const value = attachment(filename);
        await repository.stageFileUpload({
          requestId: id,
          ownerId: owner.id,
          objectKey: value.objectKey,
          filename: value.filename,
          mimeType: value.mimeType,
          sizeBytes: value.sizeBytes,
          sha256: value.sha256,
          purpose: "assistants",
          attachmentState: value.state,
          inspectionError: null,
          requiredInspectionMode: "local",
          inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
        });
        await repository.markFileUploadStored(id, leaseToken);
      };
      await stage(started.request.id, started.leaseToken, "first.txt");
      await assertRejects(
        () =>
          repository.finalizeFileUpload({
            attachment: {
              ...attachment("first.txt"),
              state: "quarantined",
              inspectionError: "stage decision drift",
            },
            request: completion(started.request.id, started.leaseToken),
            responseBody: (file) => JSON.stringify({ id: file.id, object: "file" }),
          }),
        DomainError,
        "stage differs",
      );
      const finalized = await repository.finalizeFileUpload({
        attachment: attachment("first.txt"),
        request: completion(started.request.id, started.leaseToken),
        responseBody: (file) => JSON.stringify({ id: file.id, object: "file" }),
      });
      const body = finalized.request.responseBody;
      const replay = await repository.beginApiRequest(input);
      assertEquals(replay.kind, "completed");
      assertEquals(replay.request.responseStatus, 201);
      assertEquals(replay.request.responseBody, body);
      await assertRejects(
        () => repository.beginApiRequest({ ...input, requestHash: "b".repeat(64) }),
        DomainError,
        "Idempotency key payload differs",
      );
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int count FROM api_idempotency_requests
        WHERE user_id=${owner.id} AND endpoint='files'
          AND idempotency_key=${input.idempotencyKey}
      `;
      assertEquals(rows[0]?.count, 1);
      const ledger = await sql<{ kind: string; amount_micros: string }[]>`
        SELECT kind,amount_micros::text FROM ledger_entries
        WHERE usage_run_id=${input.runId} ORDER BY sequence
      `;
      assertEquals([...ledger], [
        { kind: "reserve", amount_micros: "0" },
      ]);
      const runs = await sql<{ status: string }[]>`
        SELECT status FROM usage_runs WHERE id=${input.runId}
      `;
      assertEquals(runs[0]?.status, "completed");

      const secondInput = {
        ...input,
        idempotencyKey: "postgres-file-upload-0002",
        requestHash: "b".repeat(64),
        runId: `${owner.id}:files:${crypto.randomUUID()}`,
      };
      const secondFile = await repository.beginApiRequest(secondInput);
      if (secondFile.kind !== "started") throw new Error("missing second file request");
      await stage(secondFile.request.id, secondFile.leaseToken, "second.txt");
      const secondFinalized = await repository.finalizeFileUpload({
        attachment: attachment("second.txt"),
        request: completion(secondFile.request.id, secondFile.leaseToken),
        responseBody: (file) => JSON.stringify({ id: file.id, object: "file" }),
      });
      assertEquals(secondFinalized.attachment.filename, "second.txt");
      assertEquals(secondFinalized.attachment.id === finalized.attachment.id, false);
      const shared = await sql<
        { id: string; filename: string; object_key: string }[]
      >`SELECT id,filename,object_key FROM attachments WHERE owner_id=${owner.id}
        ORDER BY filename`;
      assertEquals(shared.map(({ filename }) => filename), ["first.txt", "second.txt"]);
      assertEquals(new Set(shared.map(({ object_key }) => object_key)).size, 1);

      const interruptedInput = {
        ...input,
        idempotencyKey: "postgres-file-upload-interrupted",
        requestHash: "c".repeat(64),
        runId: `${owner.id}:files:${crypto.randomUUID()}`,
      };
      const interrupted = await repository.beginApiRequest(interruptedInput);
      if (interrupted.kind !== "started") throw new Error("missing interrupted request");
      await stage(interrupted.request.id, interrupted.leaseToken, "interrupted.txt");
      await assertRejects(
        () =>
          repository.finalizeFileUpload({
            attachment: attachment("interrupted.txt"),
            request: completion(interrupted.request.id, interrupted.leaseToken),
            responseBody: () => {
              throw new Error("injected pre-commit failure");
            },
          }),
        Error,
        "injected pre-commit failure",
      );
      assertEquals(
        (await sql<{ count: number }[]>`
          SELECT count(*)::int count FROM attachments WHERE filename='interrupted.txt'
        `)[0]?.count,
        0,
      );
      await repository.releaseApiRequestLease(interrupted.request.id, interrupted.leaseToken);
      const reclaimed = await repository.reclaimApiRequest(
        interrupted.request.id,
        interrupted.leaseToken,
        30,
      );
      const recovered = await repository.finalizeFileUpload({
        attachment: attachment("interrupted.txt"),
        request: completion(reclaimed.request.id, reclaimed.leaseToken),
        responseBody: (file) => JSON.stringify({ id: file.id, object: "file" }),
      });
      assertEquals(recovered.attachment.filename, "interrupted.txt");
      assertEquals(
        (await sql<{ count: number }[]>`
          SELECT count(*)::int count FROM attachments WHERE filename='interrupted.txt'
        `)[0]?.count,
        1,
      );

      const abandonedInput = {
        ...input,
        idempotencyKey: "postgres-file-upload-abandoned",
        requestHash: "d".repeat(64),
        runId: `${owner.id}:files:${crypto.randomUUID()}`,
      };
      const abandoned = await repository.beginApiRequest(abandonedInput);
      if (abandoned.kind !== "started") throw new Error("missing abandoned request");
      const abandonedKey = `uploads/${owner.id}/blobs/bb/${"b".repeat(64)}.txt`;
      await repository.stageFileUpload({
        requestId: abandoned.request.id,
        ownerId: owner.id,
        objectKey: abandonedKey,
        filename: "abandoned.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "b".repeat(64),
        purpose: "assistants",
        attachmentState: "ready",
        inspectionError: null,
        requiredInspectionMode: "local",
        inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
      });
      await repository.releaseApiRequestLease(abandoned.request.id, abandoned.leaseToken);
      assertEquals(await repository.reapStaleApiRequests(), 0);
      assertEquals(await repository.reapStaleApiRequests(), 0);
      const abandonedReplay = await repository.beginApiRequest(abandonedInput);
      assertEquals(abandonedReplay.kind, "in_progress");
      const reclaimedAbandoned = await repository.reclaimApiRequest(
        abandoned.request.id,
        abandoned.leaseToken,
        30,
      );
      await repository.failApiRequest({
        id: abandoned.request.id,
        leaseToken: reclaimedAbandoned.leaseToken,
        responseStatus: 500,
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify({ error: { code: "upload_interrupted" } }),
        billing: { mode: "refund" },
      });
      const abandonedRuns = await sql<{ status: string }[]>`
        SELECT status FROM usage_runs WHERE id=${abandonedInput.runId}`;
      assertEquals(abandonedRuns[0]?.status, "failed");
      const cleanupJobs = await sql<{ count: number }[]>`SELECT count(*)::int count FROM jobs
        WHERE idempotency_key=${`file_object.cleanup:${abandoned.request.id}`}`;
      assertEquals(cleanupJobs[0]?.count, 0);
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
