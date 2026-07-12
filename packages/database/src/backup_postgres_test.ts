import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { BackupOperationError, PostgresBackupStore } from "./backup-postgres.ts";

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
      await sql`TRUNCATE backup_operations,installation_state,users RESTART IDENTITY CASCADE`;
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
        first.claim(exported.id, exported.version),
        second.claim(exported.id, exported.version),
      ]);
      assertEquals(claims.filter((result) => result.status === "fulfilled").length, 1);
      assertEquals(claims.filter((result) => result.status === "rejected").length, 1);

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
