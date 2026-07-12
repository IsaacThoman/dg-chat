import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import type { ProviderCredentialEnvelope } from "./repository.ts";
import {
  PostgresRestoreProviderSecretsStore,
  RestoreProviderSecretsStoreError,
} from "./restore-provider-secrets-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const digest = (value: string) => value.repeat(64);
const envelope = (credentialVersion: number): ProviderCredentialEnvelope => ({
  version: 1,
  algorithm: "AES-256-GCM",
  keyId: "destination-v1",
  credentialVersion,
  wrappedKeyNonce: "AA==",
  wrappedKey: "AA==",
  contentNonce: "AA==",
  ciphertext: "AA==",
});

Deno.test({
  name: "restore provider-secret store pairs exactly, applies atomically, and tombstones cleanup",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const store = await PostgresRestoreProviderSecretsStore.connect(databaseUrl!);
    try {
      await sql`TRUNCATE backup_restore_secret_sidecars,backup_operations,installation_state,
        providers,users RESTART IDENTITY CASCADE`;
      await sql`INSERT INTO installation_state(singleton_id) VALUES(1) ON CONFLICT DO NOTHING`;
      const actor = crypto.randomUUID();
      await sql`INSERT INTO users(
          id,email,name,password_hash,role,approval_status,state,balance_micros,email_verified_at
        ) VALUES(${actor},'restored-admin@example.com','Restored Admin',NULL,'admin','approved',
          'active',0,now())`;
      const base = {
        backupId: crypto.randomUUID(),
        contentRootSha256: digest("c"),
        sourceInstallationId: crypto.randomUUID(),
        archiveSha256: digest("a"),
      };
      const makeRestore = async (key: string) => {
        const [row] = await sql<{ id: string }[]>`INSERT INTO backup_operations(
            kind,status,actor_id,actor_email,actor_name,idempotency_key,stage,started_at,
            completed_at,archive_sha256,manifest
          ) VALUES('restore','completed',${actor},'restored-admin@example.com','Restored Admin',
            ${key},'completed',now(),now(),${base.archiveSha256},${
          sql.json({
            backupId: base.backupId,
            contentRootSha256: base.contentRootSha256,
            source: { installationId: base.sourceInstallationId },
            version: 1,
          })
        }) RETURNING id`;
        return row.id;
      };
      const restoreId = await makeRestore("sidecar-store-restore-one");
      const create = {
        restoreOperationId: restoreId,
        requestedBy: actor,
        idempotencyKey: "sidecar-store-upload-one",
        sourceObjectKey: `backups/restores/${restoreId}/provider-secrets.dgsecrets`,
        archiveSha256: digest("b"),
        archiveBytes: 512,
        sidecarId: crypto.randomUUID(),
        recoveryKeyId: "recovery-v1",
        baseBackupId: base.backupId,
        baseArchiveSha256: base.archiveSha256,
        baseContentRootSha256: base.contentRootSha256,
        sourceInstallationId: base.sourceInstallationId,
      };
      const uploaded = await store.create(create);
      assertEquals((await store.create(create)).id, uploaded.id);
      await assertRejects(
        () => store.create({ ...create, idempotencyKey: "different-upload-key" }),
        RestoreProviderSecretsStoreError,
      );
      await assertRejects(
        () => store.create({ ...create, restoreOperationId: crypto.randomUUID() }),
        RestoreProviderSecretsStoreError,
      );
      const providerId = crypto.randomUUID();
      await sql`INSERT INTO providers(
          id,slug,display_name,base_url,protocol,enabled,version,health_status
        ) VALUES(${providerId},'restored','Restored','https://example.com/v1','chat_completions',
          false,4,'disabled')`;
      const validated = await store.validate(uploaded.id, uploaded.version, {
        recordCount: 1,
        recordsSha256: digest("d"),
        providerStateSha256: digest("e"),
        impact: { ready: 1, blocked: 0 },
      });
      const applied = await store.apply(
        validated.id,
        validated.version,
        actor,
        validated.providerStateSha256!,
        [{ providerId, expectedVersion: 4, envelope: envelope(5) }],
      );
      assertEquals(applied.status, "applied");
      const [provider] = await sql<{
        enabled: boolean;
        version: number;
        health_status: string;
        credential_envelope: ProviderCredentialEnvelope;
      }[]>`SELECT enabled,version,health_status,credential_envelope FROM providers
        WHERE id=${providerId}`;
      assertEquals(provider.enabled, false);
      assertEquals(provider.version, 5);
      assertEquals(provider.health_status, "disabled");
      assertEquals(provider.credential_envelope.credentialVersion, 5);

      const cleanupLease = crypto.randomUUID();
      const cleanup = await store.claimCleanup(cleanupLease, 60, 60_000);
      assertEquals(cleanup.some((item) => item.id === applied.id), true);
      assertEquals(
        await store.recordCleanup(
          applied.id,
          applied.sourceObjectKey,
          applied.archiveSha256,
          cleanupLease,
        ),
        true,
      );
      assertEquals((await store.get(applied.id)).cleanupCheckedAt !== null, true);

      const rollbackRestoreId = await makeRestore("sidecar-store-restore-two");
      const rollbackUpload = await store.create({
        ...create,
        restoreOperationId: rollbackRestoreId,
        idempotencyKey: "sidecar-store-upload-two",
        sourceObjectKey: `backups/restores/${rollbackRestoreId}/provider-secrets.dgsecrets`,
        sidecarId: crypto.randomUUID(),
      });
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      await sql`INSERT INTO providers(
          id,slug,display_name,base_url,protocol,enabled,version,health_status
        ) VALUES
          (${first},'first','First','https://first.example/v1','chat_completions',false,2,'disabled'),
          (${second},'second','Second','https://second.example/v1','chat_completions',false,3,'disabled')`;
      const rollbackValidated = await store.validate(rollbackUpload.id, rollbackUpload.version, {
        recordCount: 2,
        recordsSha256: digest("f"),
        providerStateSha256: digest("1"),
        impact: { ready: 2 },
      });
      await sql`UPDATE providers SET version=4 WHERE id=${second}`;
      await assertRejects(
        () =>
          store.apply(
            rollbackValidated.id,
            rollbackValidated.version,
            actor,
            rollbackValidated.providerStateSha256!,
            [
              { providerId: first, expectedVersion: 2, envelope: envelope(3) },
              { providerId: second, expectedVersion: 3, envelope: envelope(4) },
            ],
          ),
        RestoreProviderSecretsStoreError,
      );
      const [rolledBack] = await sql<{ credential_envelope: unknown; version: number }[]>`
        SELECT credential_envelope,version FROM providers WHERE id=${first}`;
      assertEquals(rolledBack, { credential_envelope: null, version: 2 });
      assertEquals((await store.get(rollbackValidated.id)).status, "validated");
    } finally {
      await store.close();
      await sql.end();
    }
  },
});
