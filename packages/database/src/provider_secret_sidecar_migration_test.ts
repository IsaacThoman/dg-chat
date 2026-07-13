import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0029 adds strict paired provider-secret artifact lifecycle metadata",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `provider_secret_sidecar_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`CREATE TABLE users(id uuid PRIMARY KEY,email text,name text)`);
      for (const name of ["0028_backup_restore.sql", "0029_provider_secret_sidecars.sql"]) {
        const migration = await Deno.readTextFile(
          new URL(`../migrations/${name}`, import.meta.url),
        );
        await sql.unsafe(migration);
      }
      const actorId = crypto.randomUUID();
      const [queued] = await sql<{ id: string }[]>`INSERT INTO backup_operations(
          kind,actor_id,actor_email,actor_name,idempotency_key,provider_secrets_requested
        ) VALUES(
          'export',${actorId},'admin@example.com','Admin','privileged-migration-export',true
        ) RETURNING id`;
      await assertRejects(() =>
        sql`UPDATE backup_operations SET status='completed',stage='completed',started_at=now(),
          completed_at=now(),archive_sha256=${"a".repeat(64)} WHERE id=${queued.id}`
      );
      await assertRejects(() =>
        sql`UPDATE backup_operations SET secret_artifact_object_key='secrets/only.dgsecrets'
          WHERE id=${queued.id}`
      );
      await sql`UPDATE backup_operations SET status='running',stage='uploading',started_at=now(),
        export_lease_token=${crypto.randomUUID()},export_lease_expires_at=now()+interval '1 minute',
        artifact_object_key='backups/base.dgbackup',archive_sha256=${"a".repeat(64)},
        secret_artifact_object_key='backups/secret.dgsecrets',
        secret_archive_sha256=${"b".repeat(64)},secret_archive_bytes=512,
        secret_provider_count=0,secret_recovery_key_id='recovery-v1' WHERE id=${queued.id}`;
      await sql`UPDATE backup_operations SET status='completed',stage='completed',
        completed_at=now(),export_lease_token=NULL,export_lease_expires_at=NULL
        WHERE id=${queued.id}`;
      const [completed] = await sql<{
        provider_secrets_requested: boolean;
        secret_archive_bytes: string;
        secret_provider_count: number;
      }[]>`SELECT provider_secrets_requested,secret_archive_bytes,secret_provider_count
        FROM backup_operations WHERE id=${queued.id}`;
      assertEquals(completed, {
        provider_secrets_requested: true,
        secret_archive_bytes: "512",
        secret_provider_count: 0,
      });
      await assertRejects(() =>
        sql`INSERT INTO backup_operations(
          kind,actor_email,actor_name,idempotency_key,provider_secrets_requested
        ) VALUES('restore','admin@example.com','Admin','invalid-secret-restore',true)`
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await sql.end();
    }
  },
});
