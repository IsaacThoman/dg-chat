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
        const [state] = await sql<{ restore_epoch: string }[]>`
          UPDATE installation_state SET restore_epoch=restore_epoch+1,version=version+1,
            updated_at=now() WHERE singleton_id=1 RETURNING restore_epoch`;
        await sql`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
          VALUES(${actor},'backup.restore.database_committed','backup_operation',${row.id},
            ${sql.json({ restoreEpoch: Number(state.restore_epoch) })})`;
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
      const concurrent = await Promise.all([store.create(create), store.create(create)]);
      let uploaded = concurrent[0];
      assertEquals(concurrent[1].id, uploaded.id);
      assertEquals(uploaded.status, "staging");
      uploaded = await store.markUploaded(uploaded.id, uploaded.version);
      assertEquals(uploaded.status, "uploaded");
      assertEquals((await store.markUploaded(uploaded.id, uploaded.version)).id, uploaded.id);
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
      assertEquals(await store.previewProviders(uploaded.id, uploaded.version, [providerId]), [{
        providerId,
        displayName: "Restored",
        version: 4,
        enabled: false,
        credentialPresent: false,
      }]);
      const validated = await store.validate(uploaded.id, uploaded.version, {
        recordCount: 1,
        recordsSha256: digest("d"),
        providerPlan: [{ providerId, expectedVersion: 4 }],
        impact: { ready: 1, blocked: 0 },
      });
      const applied = await store.apply(
        validated.id,
        validated.version,
        actor,
        validated.providerStateSha256!,
        (async function* () {
          yield { providerId, expectedVersion: 4, envelope: envelope(5) };
        })(),
      );
      assertEquals(applied.status, "applied");
      assertEquals(
        (await store.getAppliedResult(
          applied.id,
          restoreId,
          create.baseArchiveSha256,
          create.archiveSha256,
        ))?.id,
        applied.id,
      );
      assertEquals(
        await store.getAppliedResult(applied.id, restoreId, create.baseArchiveSha256, digest("9")),
        undefined,
      );
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
      let rollbackUpload = await store.create({
        ...create,
        restoreOperationId: rollbackRestoreId,
        idempotencyKey: "sidecar-store-upload-two",
        sourceObjectKey: `backups/restores/${rollbackRestoreId}/provider-secrets.dgsecrets`,
        sidecarId: crypto.randomUUID(),
      });
      rollbackUpload = await store.markUploaded(rollbackUpload.id, rollbackUpload.version);
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
        providerPlan: [
          { providerId: first, expectedVersion: 2 },
          { providerId: second, expectedVersion: 3 },
        ].sort((a, b) => a.providerId.localeCompare(b.providerId)),
        impact: { ready: 2 },
      });
      const substitute = crypto.randomUUID();
      await sql`INSERT INTO providers(
          id,slug,display_name,base_url,protocol,enabled,version,health_status
        ) VALUES(${substitute},'substitute','Substitute','https://substitute.example/v1',
          'chat_completions',false,3,'disabled')`;
      await assertRejects(
        () =>
          store.apply(
            rollbackValidated.id,
            rollbackValidated.version,
            actor,
            rollbackValidated.providerStateSha256!,
            [
              { providerId: first, expectedVersion: 2, envelope: envelope(3) },
              { providerId: substitute, expectedVersion: 3, envelope: envelope(4) },
            ],
          ),
        RestoreProviderSecretsStoreError,
      );
      assertEquals(
        (await sql<{ credential_envelope: unknown }[]>`
          SELECT credential_envelope FROM providers WHERE id=${first}`)[0].credential_envelope,
        null,
      );
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

      const staleUploadRestoreId = await makeRestore("sidecar-store-stale-upload-epoch");
      const staleUpload = await store.create({
        ...create,
        restoreOperationId: staleUploadRestoreId,
        idempotencyKey: "sidecar-store-stale-upload-epoch",
        sourceObjectKey:
          `backups/restores/${staleUploadRestoreId}/stale-provider-secrets.dgsecrets`,
        sidecarId: crypto.randomUUID(),
      });
      await sql`UPDATE installation_state SET restore_epoch=restore_epoch+1,version=version+1
        WHERE singleton_id=1`;
      await assertRejects(
        () => store.markUploaded(staleUpload.id, staleUpload.version),
        RestoreProviderSecretsStoreError,
      );
      assertEquals((await store.get(staleUpload.id)).status, "staging");

      const epochRestoreId = await makeRestore("sidecar-store-restore-epoch");
      let epochUpload = await store.create({
        ...create,
        restoreOperationId: epochRestoreId,
        idempotencyKey: "sidecar-store-upload-epoch",
        sourceObjectKey: `backups/restores/${epochRestoreId}/provider-secrets.dgsecrets`,
        sidecarId: crypto.randomUUID(),
      });
      epochUpload = await store.markUploaded(epochUpload.id, epochUpload.version);
      const epochProvider = crypto.randomUUID();
      await sql`INSERT INTO providers(
          id,slug,display_name,base_url,protocol,enabled,version,health_status
        ) VALUES(${epochProvider},'epoch','Epoch','https://epoch.example/v1','chat_completions',
          false,6,'disabled')`;
      const epochValidated = await store.validate(epochUpload.id, epochUpload.version, {
        recordCount: 1,
        recordsSha256: digest("2"),
        providerPlan: [{ providerId: epochProvider, expectedVersion: 6 }],
        impact: { ready: 1 },
      });
      await sql`UPDATE installation_state SET restore_epoch=restore_epoch+1,version=version+1
        WHERE singleton_id=1`;
      await assertRejects(
        () =>
          store.apply(
            epochValidated.id,
            epochValidated.version,
            actor,
            epochValidated.providerStateSha256!,
            [{ providerId: epochProvider, expectedVersion: 6, envelope: envelope(7) }],
          ),
        RestoreProviderSecretsStoreError,
      );
      assertEquals(
        (await sql<{ credential_envelope: unknown }[]>`
          SELECT credential_envelope FROM providers WHERE id=${epochProvider}`)[0]
          .credential_envelope,
        null,
      );
      const invalidated = await store.invalidateStaleEpochAttachments();
      assertEquals(invalidated.some((item) => item.id === epochValidated.id), true);
      assertEquals((await store.get(epochValidated.id)).status, "failed");

      const expiryRestoreId = await makeRestore("sidecar-store-restore-expiry");
      const expiryUpload = await store.create({
        ...create,
        restoreOperationId: expiryRestoreId,
        idempotencyKey: "sidecar-store-upload-expiry",
        sourceObjectKey: `backups/restores/${expiryRestoreId}/provider-secrets.dgsecrets`,
        sidecarId: crypto.randomUUID(),
      });
      await sql`UPDATE backup_restore_secret_sidecars SET created_at=now()-interval '2 hours',
        updated_at=now()-interval '2 hours'
        WHERE id=${expiryUpload.id}`;
      assertEquals(
        (await store.expireAbandonedStaging(60 * 60_000)).some((item) =>
          item.id === expiryUpload.id && item.status === "cancelled"
        ),
        true,
      );
      await assertRejects(
        () =>
          store.create({
            ...create,
            restoreOperationId: expiryRestoreId,
            idempotencyKey: "sidecar-store-upload-expiry",
            sourceObjectKey: `backups/restores/${expiryRestoreId}/provider-secrets.dgsecrets`,
            sidecarId: expiryUpload.sidecarId,
          }),
        RestoreProviderSecretsStoreError,
      );
      const replacement = await store.create({
        ...create,
        restoreOperationId: expiryRestoreId,
        idempotencyKey: "sidecar-store-upload-replacement",
        sourceObjectKey: `backups/restores/${expiryRestoreId}/replacement.dgsecrets`,
        sidecarId: crypto.randomUUID(),
      });
      assertEquals(replacement.status, "staging");
      assertEquals(replacement.id === expiryUpload.id, false);
      const replacementUploaded = await store.markUploaded(replacement.id, replacement.version);
      await sql`UPDATE backup_restore_secret_sidecars SET created_at=now()-interval '8 days',
        updated_at=now()-interval '8 days' WHERE id=${replacementUploaded.id}`;
      assertEquals(
        (await store.expireAbandonedAttachments(7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000))
          .some((item) => item.id === replacementUploaded.id && item.status === "cancelled"),
        true,
      );
      let validatedExpiry = await store.create({
        ...create,
        restoreOperationId: expiryRestoreId,
        idempotencyKey: "sidecar-store-upload-validated-expiry",
        sourceObjectKey: `backups/restores/${expiryRestoreId}/validated-expiry.dgsecrets`,
        sidecarId: crypto.randomUUID(),
      });
      validatedExpiry = await store.markUploaded(validatedExpiry.id, validatedExpiry.version);
      validatedExpiry = await store.validate(validatedExpiry.id, validatedExpiry.version, {
        recordCount: 1,
        recordsSha256: digest("4"),
        providerPlan: [{ providerId: epochProvider, expectedVersion: 6 }],
        impact: { ready: 1 },
      });
      await sql`UPDATE backup_restore_secret_sidecars SET created_at=now()-interval '31 days',
        validated_at=now()-interval '31 days',updated_at=now()-interval '31 days'
        WHERE id=${validatedExpiry.id}`;
      assertEquals(
        (await store.expireAbandonedAttachments(7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000))
          .some((item) => item.id === validatedExpiry.id && item.status === "cancelled"),
        true,
      );
    } finally {
      await store.close();
      await sql.end();
    }
  },
});
