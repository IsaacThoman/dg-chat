import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0030 strictly separates restore-side provider-secret lifecycle state",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `restore_provider_secrets_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`CREATE TABLE users(id uuid PRIMARY KEY,email text,name text)`);
      for (
        const name of [
          "0028_backup_restore.sql",
          "0029_provider_secret_sidecars.sql",
          "0030_restore_provider_secret_sidecars.sql",
        ]
      ) {
        await sql.unsafe(
          await Deno.readTextFile(new URL(`../migrations/${name}`, import.meta.url)),
        );
      }
      const actor = crypto.randomUUID();
      await sql`INSERT INTO users(id,email,name) VALUES(${actor},'admin@example.com','Admin')`;
      const [restore] = await sql<{ id: string }[]>`INSERT INTO backup_operations(
          kind,status,actor_id,actor_email,actor_name,idempotency_key,stage,started_at,completed_at,
          archive_sha256,manifest
        ) VALUES('restore','completed',${actor},'admin@example.com','Admin','restore-sidecar-base',
          'completed',now(),now(),${"a".repeat(64)},${sql.json({ version: 1 })}) RETURNING id`;
      const values = {
        restoreId: restore.id,
        objectKey: `backups/restores/${restore.id}/secret.dgsecrets`,
        sidecarId: crypto.randomUUID(),
        backupId: crypto.randomUUID(),
        installationId: crypto.randomUUID(),
      };
      const [sidecar] = await sql<{ id: string }[]>`INSERT INTO backup_restore_secret_sidecars(
          restore_operation_id,idempotency_key,requested_by,source_object_key,archive_sha256,
          archive_bytes,sidecar_id,recovery_key_id,base_backup_id,base_archive_sha256,
          base_content_root_sha256,source_installation_id
        ) VALUES(${values.restoreId},'sidecar-upload-key',${actor},${values.objectKey},
          ${"b".repeat(64)},128,${values.sidecarId},'recovery-v1',${values.backupId},
          ${"a".repeat(64)},${"c".repeat(64)},${values.installationId}) RETURNING id`;
      await assertRejects(() =>
        sql`UPDATE backup_restore_secret_sidecars SET status='validated' WHERE id=${sidecar.id}`
      );
      await sql`UPDATE backup_restore_secret_sidecars SET status='validated',record_count=0,
        records_sha256=${"d".repeat(64)},provider_state_sha256=${"e".repeat(64)},impact='{}',
        validated_at=now() WHERE id=${sidecar.id}`;
      await assertRejects(() =>
        sql`UPDATE backup_restore_secret_sidecars SET status='applied',applied_at=now(),
          completed_at=now() WHERE id=${sidecar.id}`
      );
      await sql`UPDATE backup_restore_secret_sidecars SET status='applied',applied_by=${actor},
        applied_at=now(),completed_at=now() WHERE id=${sidecar.id}`;
      const lease = crypto.randomUUID();
      await sql`UPDATE backup_restore_secret_sidecars SET cleanup_lease_token=${lease},
        cleanup_lease_expires_at=now()+interval '1 minute' WHERE id=${sidecar.id}`;
      assertEquals(
        (await sql`SELECT status,record_count FROM backup_restore_secret_sidecars
          WHERE id=${sidecar.id}`)[0],
        { status: "applied", record_count: 0 },
      );
      await sql`TRUNCATE users CASCADE`;
      assertEquals(
        Number(
          (await sql`SELECT count(*)::int count FROM backup_restore_secret_sidecars
            WHERE id=${sidecar.id}`)[0].count,
        ),
        1,
      );
      await assertRejects(() =>
        sql`INSERT INTO backup_restore_secret_sidecars(
          restore_operation_id,idempotency_key,source_object_key,archive_sha256,archive_bytes,
          sidecar_id,recovery_key_id,base_backup_id,base_archive_sha256,
          base_content_root_sha256,source_installation_id
        ) VALUES(${values.restoreId},'other-sidecar-key','/absolute',${"b".repeat(64)},1,
          ${crypto.randomUUID()},'key',${crypto.randomUUID()},${"a".repeat(64)},
          ${"c".repeat(64)},${crypto.randomUUID()})`
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await sql.end();
    }
  },
});
