import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { BackupOperationError, PostgresBackupStore } from "./backup-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres backup operations use CAS and globally fence restore maintenance",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const first = await PostgresBackupStore.connect(databaseUrl!);
    const second = await PostgresBackupStore.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        "TRUNCATE backup_operations,installation_state,users RESTART IDENTITY CASCADE",
      );
      await sql`INSERT INTO installation_state(singleton_id) VALUES(1)`;
      const actorId = crypto.randomUUID();
      await sql`INSERT INTO users(
        id,email,name,password_hash,role,approval_status,state,balance_micros,email_verified_at
      ) VALUES(
        ${actorId},'backup-store@example.com','Backup Store',NULL,
        'admin','approved','active',0,now()
      )`;

      const exported = await first.create({
        kind: "export",
        actorId,
        idempotencyKey: "backup-export-idempotency",
        options: { diagnostics: false },
      });
      assertEquals(
        (await first.create({
          kind: "export",
          actorId,
          idempotencyKey: "backup-export-idempotency",
          options: { diagnostics: false },
        })).id,
        exported.id,
      );
      assertEquals(
        (await first.findByIdempotency(actorId, "export", "backup-export-idempotency"))?.id,
        exported.id,
      );
      assertEquals(
        await first.findByIdempotency(actorId, "restore", "backup-export-idempotency"),
        undefined,
      );
      await assertRejects(
        () =>
          first.create({
            kind: "export",
            actorId,
            idempotencyKey: "backup-export-idempotency",
            options: { diagnostics: true },
          }),
        BackupOperationError,
      );

      const claims = await Promise.allSettled([
        first.claimExport(exported.id, exported.version, crypto.randomUUID(), 60),
        second.claimExport(exported.id, exported.version, crypto.randomUUID(), 60),
      ]);
      assertEquals(claims.filter((result) => result.status === "fulfilled").length, 1);
      assertEquals(claims.filter((result) => result.status === "rejected").length, 1);
      const queuedBehindLease = await first.create({
        kind: "export",
        actorId,
        idempotencyKey: "backup-export-queued-behind-lease",
        options: { diagnostics: false },
      });
      await assertRejects(
        () =>
          second.claimExport(
            queuedBehindLease.id,
            queuedBehindLease.version,
            crypto.randomUUID(),
            60,
          ),
        BackupOperationError,
      );
      await sql`UPDATE backup_operations SET export_lease_expires_at=now()-interval '1 second'
        WHERE id=${exported.id}`;
      assertEquals(await second.expireExportLeases(), 1);
      const claimedAfterExpiry = await second.claimExport(
        queuedBehindLease.id,
        queuedBehindLease.version,
        crypto.randomUUID(),
        60,
      );
      assertEquals(claimedAfterExpiry.status, "running");
      await sql`UPDATE backup_operations SET export_lease_expires_at=now()-interval '1 second'
        WHERE id=${claimedAfterExpiry.id}`;
      assertEquals(await first.expireExportLeases(), 1);

      const hiddenQueued = await first.create({
        kind: "export",
        actorId,
        idempotencyKey: "oldest-export-hidden-by-history",
      });
      await sql`INSERT INTO backup_operations(
          kind,status,actor_id,actor_email,actor_name,idempotency_key,stage,started_at,
          completed_at,archive_sha256,created_at,updated_at
        ) SELECT 'export','completed',${actorId},'backup-store@example.com','Backup Store',
          'terminal-history-' || value,'completed',future,future,${"b".repeat(64)},future,future
        FROM generate_series(1, 125) value
        CROSS JOIN LATERAL (SELECT now() + (value || ' seconds')::interval AS future) time`;
      const durableClaim = await second.claimNextQueuedExport(crypto.randomUUID(), 60);
      assertEquals(durableClaim?.id, hiddenQueued.id);
      await sql`UPDATE backup_operations SET export_lease_expires_at=now()-interval '1 second'
        WHERE id=${hiddenQueued.id}`;
      assertEquals(await first.expireExportLeases(), 1);

      const crashPlanned = await first.create({
        kind: "export",
        actorId,
        idempotencyKey: "export-crash-durable-artifact-plan",
      });
      const crashLease = crypto.randomUUID();
      let crashOwner = await first.claimExport(
        crashPlanned.id,
        crashPlanned.version,
        crashLease,
        60,
      );
      const crashKey = `backups/exports/${crashOwner.id}/${crashLease}-${"c".repeat(64)}.dgbackup`;
      crashOwner = await first.planExportArtifact(
        crashOwner.id,
        crashOwner.version,
        crashLease,
        crashKey,
        "c".repeat(64),
      );
      assertEquals(crashOwner.artifactObjectKey, crashKey);
      await sql`UPDATE backup_operations SET export_lease_expires_at=now()-interval '1 second'
        WHERE id=${crashOwner.id}`;
      assertEquals(await first.expireExportLeases(), 1);
      const cleanupLease = crypto.randomUUID();
      assertEquals(
        (await first.claimRecoverableExportArtifacts(cleanupLease, 60, 60_000, 4_000))[0]?.id,
        crashOwner.id,
      );
      assertEquals(
        await first.recordExportArtifactCleanup(
          crashOwner.id,
          crashKey,
          "c".repeat(64),
          cleanupLease,
        ),
        true,
      );
      const secondCleanupLease = crypto.randomUUID();
      await sql`UPDATE backup_operations SET artifact_cleanup_checked_at=now()-interval '61 seconds'
        WHERE id=${crashOwner.id}`;
      await first.claimRecoverableExportArtifacts(secondCleanupLease, 60, 60_000, 4_000);
      assertEquals(
        await first.recordExportArtifactCleanup(
          crashOwner.id,
          crashKey,
          "c".repeat(64),
          secondCleanupLease,
        ),
        true,
      );
      const durableTombstone = await first.get(crashOwner.id);
      assertEquals(durableTombstone.artifactObjectKey, crashKey);
      assertEquals(durableTombstone.archiveSha256, "c".repeat(64));
      assertEquals(durableTombstone.artifactCleanupCheckedAt !== null, true);

      const privilegedPlan = await first.create({
        kind: "export",
        actorId,
        idempotencyKey: "privileged-export-paired-artifacts",
        providerSecretsRequested: true,
      });
      assertEquals(privilegedPlan.providerSecretsRequested, true);
      const privilegedLease = crypto.randomUUID();
      let privilegedOwner = await first.claimExport(
        privilegedPlan.id,
        privilegedPlan.version,
        privilegedLease,
        60,
      );
      const privilegedBaseKey = `backups/exports/${privilegedOwner.id}/${privilegedLease}-${
        "e".repeat(64)
      }.dgbackup`;
      const privilegedSecretKey = `backups/secrets/${privilegedOwner.id}/${privilegedLease}-${
        "f".repeat(64)
      }.dgsecrets`;
      await assertRejects(
        () =>
          first.planExportArtifact(
            privilegedOwner.id,
            privilegedOwner.version,
            privilegedLease,
            privilegedBaseKey,
            "e".repeat(64),
          ),
        BackupOperationError,
      );
      privilegedOwner = await first.planPrivilegedExportArtifacts(
        privilegedOwner.id,
        privilegedOwner.version,
        privilegedLease,
        privilegedBaseKey,
        "e".repeat(64),
        {
          artifactObjectKey: privilegedSecretKey,
          archiveSha256: "f".repeat(64),
          archiveBytes: 4096,
          providerCount: 2,
          recoveryKeyId: "recovery-2026-01",
        },
      );
      assertEquals(privilegedOwner.secretArtifactObjectKey, privilegedSecretKey);
      assertEquals(privilegedOwner.secretProviderCount, 2);
      await assertRejects(
        () =>
          first.complete(privilegedOwner.id, privilegedOwner.version, {
            artifactObjectKey: privilegedBaseKey,
            archiveSha256: "e".repeat(64),
          }),
        BackupOperationError,
      );
      await sql`UPDATE backup_operations SET export_lease_expires_at=now()-interval '1 second'
        WHERE id=${privilegedOwner.id}`;
      assertEquals(await first.expireExportLeases(), 1);
      const baseCleanupLease = crypto.randomUUID();
      const secretCleanupLease = crypto.randomUUID();
      assertEquals(
        (await first.claimRecoverableExportArtifacts(baseCleanupLease, 60, 60_000, 4_000))
          .some((operation) => operation.id === privilegedOwner.id),
        true,
      );
      assertEquals(
        (await first.claimRecoverableProviderSecretArtifacts(
          secretCleanupLease,
          60,
          60_000,
          4_000,
        )).some((operation) => operation.id === privilegedOwner.id),
        true,
      );
      assertEquals(
        await first.recordProviderSecretArtifactCleanup(
          privilegedOwner.id,
          privilegedSecretKey,
          "f".repeat(64),
          secretCleanupLease,
        ),
        true,
      );
      const privilegedTombstone = await first.get(privilegedOwner.id);
      assertEquals(privilegedTombstone.secretArtifactObjectKey, privilegedSecretKey);
      assertEquals(privilegedTombstone.secretArtifactCleanupCheckedAt !== null, true);

      const pairedCompletion = await first.create({
        kind: "export",
        actorId,
        idempotencyKey: "privileged-export-completes-pair",
        providerSecretsRequested: true,
      });
      const pairedLease = crypto.randomUUID();
      let pairedOwner = await first.claimExport(
        pairedCompletion.id,
        pairedCompletion.version,
        pairedLease,
        60,
      );
      const pairedBaseKey = `backups/exports/${pairedOwner.id}/${pairedLease}.dgbackup`;
      const pairedSecretKey = `backups/secrets/${pairedOwner.id}/${pairedLease}.dgsecrets`;
      pairedOwner = await first.planPrivilegedExportArtifacts(
        pairedOwner.id,
        pairedOwner.version,
        pairedLease,
        pairedBaseKey,
        "1".repeat(64),
        {
          artifactObjectKey: pairedSecretKey,
          archiveSha256: "2".repeat(64),
          archiveBytes: 1024,
          providerCount: 0,
          recoveryKeyId: "recovery-empty",
        },
      );
      pairedOwner = await first.complete(pairedOwner.id, pairedOwner.version, {
        artifactObjectKey: pairedBaseKey,
        archiveSha256: "1".repeat(64),
        secretArtifactObjectKey: pairedSecretKey,
        secretArchiveSha256: "2".repeat(64),
        secretArchiveBytes: 1024,
        secretProviderCount: 0,
        secretRecoveryKeyId: "recovery-empty",
      });
      assertEquals(pairedOwner.status, "completed");
      assertEquals(pairedOwner.secretArchiveBytes, 1024);
      assertEquals(
        await first.recordProviderSecretArtifactCleanup(
          pairedOwner.id,
          pairedSecretKey,
          "2".repeat(64),
          crypto.randomUUID(),
        ),
        false,
      );

      const completedPlan = await first.create({
        kind: "export",
        actorId,
        idempotencyKey: "export-completed-artifact-owner",
      });
      const completedLease = crypto.randomUUID();
      let completedOwner = await first.claimExport(
        completedPlan.id,
        completedPlan.version,
        completedLease,
        60,
      );
      const completedKey = `backups/exports/${completedOwner.id}/${completedLease}-${
        "d".repeat(64)
      }.dgbackup`;
      completedOwner = await first.planExportArtifact(
        completedOwner.id,
        completedOwner.version,
        completedLease,
        completedKey,
        "d".repeat(64),
      );
      completedOwner = await first.complete(completedOwner.id, completedOwner.version, {
        artifactObjectKey: completedKey,
        archiveSha256: "d".repeat(64),
      });
      assertEquals(completedOwner.status, "completed");
      assertEquals(
        await first.recordExportArtifactCleanup(
          completedOwner.id,
          completedKey,
          "d".repeat(64),
          crypto.randomUUID(),
        ),
        false,
      );

      const cancelPlan = await first.create({
        kind: "export",
        actorId,
        idempotencyKey: "cancel-running-export-lease",
      });
      const cancelRunning = await first.claimExport(
        cancelPlan.id,
        cancelPlan.version,
        crypto.randomUUID(),
        60,
      );
      const cancelledExport = await first.cancel(cancelRunning.id, cancelRunning.version);
      assertEquals(cancelledExport.status, "cancelled");
      assertEquals(cancelledExport.exportLeaseToken, null);
      assertEquals(cancelledExport.exportLeaseExpiresAt, null);

      const makeRunningRestore = async (key: string) => {
        const operation = await first.create({
          kind: "restore",
          actorId,
          idempotencyKey: key,
          sourceObjectKey: `backup-uploads/${key}.tar`,
          archiveSha256: "a".repeat(64),
        });
        return await first.claim(operation.id, operation.version);
      };
      const ambiguousCommitted = await makeRunningRestore("ambiguous-database-restored");
      await sql`UPDATE backup_operations SET stage='database_restored'
        WHERE id=${ambiguousCommitted.id}`;
      const abandoned = await makeRunningRestore("abandoned-behind-terminal-history");
      assertEquals((await first.listRecoverableRestores(1))[0]?.id, abandoned.id);
      await first.fail(abandoned.id, abandoned.version, "internal_error");
      let restore = await makeRunningRestore("restore-operation-one");
      restore = await first.updateProgress(restore.id, restore.version, {
        stage: "validating",
        objectsProcessed: 0,
        objectsTotal: 0,
        bytesProcessed: 0,
        bytesTotal: 0,
      });
      restore = await first.validateRestore(restore.id, restore.version, {
        archiveSha256: "a".repeat(64),
        manifest: { formatVersion: 1 },
        impact: { users: 1 },
      });
      assertEquals(restore.confirmationFingerprint, "AAAAAAAA");
      await assertRejects(
        () => first.beginRestoreApply(restore.id, restore.version, "BBBBBBBB"),
        BackupOperationError,
      );
      restore = await first.beginRestoreApply(restore.id, restore.version, "AAAAAAAA");
      const competing = await makeRunningRestore("restore-operation-two");
      const attempts = await Promise.allSettled([
        first.beginRestoreMaintenance(restore.id, restore.version),
        second.beginRestoreMaintenance(competing.id, competing.version),
      ]);
      assertEquals(attempts.filter((result) => result.status === "fulfilled").length, 1);
      assertEquals(attempts.filter((result) => result.status === "rejected").length, 1);
      const winner = attempts.find((result) => result.status === "fulfilled");
      if (!winner || winner.status !== "fulfilled") throw new Error("Restore fence had no winner");
      assertEquals(winner.value.installation.maintenanceEnabled, true);
      assertEquals(winner.value.installation.restoreEpoch, 1);
      assertEquals(winner.value.installation.activeRestoreId, winner.value.operation.id);
      const idempotent = await first.beginRestoreMaintenance(
        winner.value.operation.id,
        winner.value.operation.version,
      );
      assertEquals(idempotent.installation.version, winner.value.installation.version);
      const released = await first.endRestoreMaintenance(
        winner.value.operation.id,
        winner.value.installation.version,
      );
      assertEquals(released.maintenanceEnabled, false);
      assertEquals(released.activeRestoreId, null);
      assertEquals(released.restoreEpoch, 1);
      await assertRejects(
        () =>
          first.endRestoreMaintenance(
            winner.value.operation.id,
            winner.value.installation.version,
          ),
        BackupOperationError,
      );
    } finally {
      await first.close();
      await second.close();
      await sql.end();
    }
  },
});
