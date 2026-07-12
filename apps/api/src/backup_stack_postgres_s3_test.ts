import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import {
  BACKUP_DATA_TABLES,
  BACKUP_EPHEMERAL_TABLES,
  createHmacBackupAuthenticator,
  parseBackupArchiveStream,
  PostgresBackupStore,
  S3ObjectStore,
  sha256Hex,
  verifyBackupDataCatalog,
} from "@dg-chat/database";
import type { BackupArchiveSink } from "@dg-chat/database";
import { DefaultBackupAdminService } from "./backup-service.ts";
import { createPostgresBackupDataPort } from "./postgres-backup-data.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const s3Endpoint = Deno.env.get("TEST_S3_ENDPOINT");
const s3Bucket = Deno.env.get("TEST_S3_BUCKET");
const s3AccessKey = Deno.env.get("TEST_S3_ACCESS_KEY");
const s3SecretKey = Deno.env.get("TEST_S3_SECRET_KEY");
const enabled = Boolean(
  databaseUrl && s3Endpoint && s3Bucket && s3AccessKey && s3SecretKey,
);

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

function body(value: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value.slice());
      controller.close();
    },
  });
}

async function responseBytes(response: Response) {
  return new Uint8Array(await response.arrayBuffer());
}

async function awaitExport(
  service: DefaultBackupAdminService,
  actorId: string,
  id: string,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const item = (await service.listExports(actorId)).find((candidate) => candidate.id === id);
    if (item?.status === "completed") return item;
    if (item?.status === "failed") throw new Error(`Backup export failed: ${item.error}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Backup export did not complete");
}

Deno.test({
  name: "production backup stack roundtrips PostgreSQL data and S3 objects",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 3 });
    const store = await PostgresBackupStore.connect(databaseUrl!);
    const objects = new S3ObjectStore({
      endpoint: s3Endpoint!,
      bucket: s3Bucket!,
      region: Deno.env.get("TEST_S3_REGION") ?? "us-east-1",
      accessKey: s3AccessKey!,
      secretKey: s3SecretKey!,
      forcePathStyle: true,
    });
    const authenticator = await createHmacBackupAuthenticator(
      "backup-stack-integration-v1",
      new Uint8Array(32).fill(73),
    );
    const service = new DefaultBackupAdminService({
      store,
      objects,
      data: createPostgresBackupDataPort({
        databaseUrl: databaseUrl!,
        objects,
        authenticator,
        appVersion: "backup-stack-integration",
      }),
      authenticator,
      restoreEnabled: true,
      maxUploadBytes: 16 * 1024 * 1024,
    });
    const createdObjectKeys: string[] = [];
    try {
      await verifyBackupDataCatalog(databaseUrl!);
      await sql.unsafe(
        `TRUNCATE ${
          [
            ...new Set([
              "backup_operations",
              "installation_state",
              ...BACKUP_DATA_TABLES.map((table) => table.name),
              ...BACKUP_EPHEMERAL_TABLES,
            ]),
          ].join(",")
        } RESTART IDENTITY CASCADE`,
      );
      await sql`INSERT INTO installation_state(singleton_id) VALUES(1)`;

      const userId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const rootMessageId = crypto.randomUUID();
      const editedMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      const attachmentId = crypto.randomUUID();
      const providerId = crypto.randomUUID();
      const originalObjectKey = `integration/source/${crypto.randomUUID()}/branch-notes.txt`;
      const attachment = bytes("immutable attachment from the exported branch\n");
      const attachmentDigest = await sha256Hex(attachment);
      await objects.put({
        key: originalObjectKey,
        body: body(attachment),
        contentLength: attachment.length,
        contentType: "text/plain",
        metadata: { sha256: attachmentDigest },
      });
      createdObjectKeys.push(originalObjectKey);

      await sql`INSERT INTO users(
        id,email,name,password_hash,role,approval_status,state,balance_micros,email_verified_at
      ) VALUES(
        ${userId},'stack-admin@example.invalid','Stack Admin',NULL,
        'admin','approved','active',5000000,now()
      )`;
      await sql`INSERT INTO auth_users(id,name,email,email_verified)
        VALUES(${userId},'Stack Admin','stack-admin@example.invalid',true)`;
      await sql`INSERT INTO auth_accounts(
        id,account_id,provider_id,user_id,password,created_at,updated_at
      ) VALUES(${crypto.randomUUID()},${userId},'credential',${userId},'portable-password-hash',now(),now())`;
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,ingestion_status
      ) VALUES(
        ${attachmentId},${userId},${originalObjectKey},'branch-notes.txt','text/plain',
        ${attachment.length},${attachmentDigest},'ready','not_applicable'
      )`;
      await sql`INSERT INTO conversations(id,owner_id,title,version)
        VALUES(${conversationId},${userId},'Branched portable chat',3)`;
      await sql`INSERT INTO messages(
        id,conversation_id,parent_id,supersedes_id,sibling_index,role,content,status,metadata,
        idempotency_key
      ) VALUES
        (${rootMessageId},${conversationId},NULL,NULL,0,'user','original prompt','complete',
          '{"branch":"root"}'::jsonb,'stack-root'),
        (${editedMessageId},${conversationId},NULL,${rootMessageId},1,'user','edited prompt',
          'complete','{"branch":"edit"}'::jsonb,'stack-edit'),
        (${assistantMessageId},${conversationId},${editedMessageId},NULL,0,'assistant',
          'preserved answer','complete','{"tokens":12}'::jsonb,'stack-answer')`;
      await sql`UPDATE conversations SET active_leaf_id=${assistantMessageId}
        WHERE id=${conversationId}`;
      await sql`INSERT INTO message_attachments(message_id,attachment_id)
        VALUES(${rootMessageId},${attachmentId}),(${editedMessageId},${attachmentId})`;
      await sql`INSERT INTO ledger_entries(
        user_id,usage_run_id,kind,amount_micros,balance_after_micros,metadata
      ) VALUES(${userId},${`grant:${userId}`},'grant',5000000,5000000,'{"source":"approval"}')`;
      await sql`INSERT INTO providers(
        id,slug,display_name,base_url,protocol,enabled,version,
        credential_envelope,credential_updated_at
      ) VALUES(
        ${providerId},'stack-provider','Stack Provider','https://provider.example/v1',
        'chat_completions',true,1,${
        sql.json({
          version: 1,
          algorithm: "AES-256-GCM",
          keyId: "default",
          credentialVersion: 1,
          wrappedKeyNonce: "nonce",
          wrappedKey: "key",
          contentNonce: "nonce",
          ciphertext: "secret-never-exported",
        })
      },now()
      )`;
      await sql`INSERT INTO sessions(user_id,token_hash,limited,expires_at)
        VALUES(${userId},'pre-export-session',false,now()+interval '1 hour')`;
      await sql`INSERT INTO auth_sessions(
        id,expires_at,token,updated_at,user_id,limited
      ) VALUES(${crypto.randomUUID()},now()+interval '1 hour','pre-export-auth-session',now(),
        ${userId},false)`;

      const requested = await service.requestExport({
        actorId: userId,
        includeDiagnostics: false,
        idempotencyKey: `stack-export-${crypto.randomUUID()}`,
      });
      const exported = await awaitExport(service, userId, requested.id);
      assert(exported.fingerprint);
      assert(exported.bytes && exported.bytes > attachment.length);
      const exportResponse = await service.exportContent(userId, exported.id);
      const archive = await responseBytes(exportResponse);
      assertEquals(exportResponse.headers.get("x-backup-sha256"), exported.fingerprint);
      assertEquals(await sha256Hex(archive), exported.fingerprint);
      const observedEntries: string[] = [];
      const verifySink: BackupArchiveSink = {
        begin(entry) {
          observedEntries.push(entry.name);
        },
        write() {},
        commit() {},
        abort() {},
      };
      const manifest = await parseBackupArchiveStream(archive, authenticator, verifySink);
      assertEquals(manifest.secretPolicy, "redacted");
      assertEquals(manifest.objects.count, 1);
      assert(observedEntries.includes(`objects/${attachmentDigest}`));

      const form = new FormData();
      form.set(
        "file",
        new File([archive], "stack-roundtrip.dgbackup", {
          type: "application/vnd.dg-chat.backup",
        }),
      );
      const restore = await service.uploadRestore({
        actorId: userId,
        request: new Request("http://localhost/api/admin/backups/restore-uploads", {
          method: "POST",
          body: form,
        }),
        idempotencyKey: `stack-restore-${crypto.randomUUID()}`,
      });
      assertEquals(restore.fingerprint, exported.fingerprint);
      const preview = await service.previewRestore(userId, restore.id);
      assertEquals(preview.blockingErrors, []);
      assertEquals(preview.attachmentsMissing, 0);
      assert(preview.counts.some((count) => count.resource === "messages" && count.create === 3));
      assert(preview.warnings.some((warning) => warning.includes("providers")));

      // Prove preflight is read-only, then create destination-only mutations and ephemeral state.
      await sql`UPDATE users SET name='DESTINATION MUTATION' WHERE id=${userId}`;
      await sql`UPDATE messages SET content='DESTINATION MUTATION' WHERE id=${assistantMessageId}`;
      await sql`DELETE FROM message_attachments WHERE message_id=${editedMessageId}`;
      await sql`INSERT INTO sessions(user_id,token_hash,limited,expires_at)
        VALUES(${userId},'destination-session',false,now()+interval '1 hour')`;
      await sql`INSERT INTO auth_verifications(identifier,value,expires_at)
        VALUES('destination-reset','secret',now()+interval '1 hour')`;

      const beforeInstallation = await store.installationState();
      const applied = await service.applyRestore({
        actorId: userId,
        restoreId: restore.id,
        fingerprint: restore.fingerprint,
      });
      assertEquals(applied.status, "completed");

      assertEquals((await sql`SELECT name FROM users WHERE id=${userId}`)[0].name, "Stack Admin");
      assertEquals(
        (await sql`SELECT content FROM messages WHERE id=${assistantMessageId}`)[0].content,
        "preserved answer",
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM message_attachments
          WHERE attachment_id=${attachmentId}`)[0].count,
        ),
        2,
      );
      assertEquals(
        Number(
          (await sql`SELECT balance_after_micros FROM ledger_entries
          WHERE usage_run_id=${`grant:${userId}`}`)[0].balance_after_micros,
        ),
        5_000_000,
      );
      const [provider] = await sql<{ enabled: boolean; credential_envelope: unknown }[]>`
        SELECT enabled,credential_envelope FROM providers WHERE id=${providerId}`;
      assertEquals(provider, { enabled: false, credential_envelope: null });
      assertEquals(Number((await sql`SELECT count(*) count FROM sessions`)[0].count), 0);
      assertEquals(Number((await sql`SELECT count(*) count FROM auth_sessions`)[0].count), 0);
      assertEquals(Number((await sql`SELECT count(*) count FROM auth_verifications`)[0].count), 0);

      const [restoredAttachment] = await sql<{ object_key: string }[]>`
        SELECT object_key FROM attachments WHERE id=${attachmentId}`;
      assertMatch(restoredAttachment.object_key, /^restores\/[0-9a-f-]+\/[0-9a-f]{64}$/u);
      createdObjectKeys.push(restoredAttachment.object_key);
      const restoredObject = await objects.get(restoredAttachment.object_key);
      assert(restoredObject);
      assertEquals(await responseBytes(new Response(restoredObject.body)), attachment);
      assertEquals(restoredObject.metadata.sha256, attachmentDigest);

      const completedOperation = await store.get(restore.id);
      assertEquals(completedOperation.status, "completed");
      assertEquals(completedOperation.stage, "completed");
      const installation = await store.installationState();
      assertEquals(installation.maintenanceEnabled, false);
      assertEquals(installation.activeRestoreId, null);
      assertEquals(installation.restoreEpoch, beforeInstallation.restoreEpoch + 1);
      assert(installation.version > beforeInstallation.version);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
          WHERE action='backup.restore.database_committed'`)[0].count,
        ),
        1,
      );
    } finally {
      for (const key of createdObjectKeys) await objects.delete(key).catch(() => undefined);
      // Backup artifacts are namespaced; remove exact keys recorded by the durable control plane.
      const artifacts = await sql<{ key: string }[]>`
        SELECT artifact_object_key AS key FROM backup_operations
        WHERE artifact_object_key IS NOT NULL
        UNION SELECT source_object_key AS key FROM backup_operations
        WHERE source_object_key IS NOT NULL`;
      for (const artifact of artifacts) await objects.delete(artifact.key).catch(() => undefined);
      await service.close();
      objects.close();
      await sql.end();
    }
  },
});
