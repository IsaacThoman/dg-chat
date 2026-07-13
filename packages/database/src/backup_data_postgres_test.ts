import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import {
  BACKUP_DATA_SCHEMA_VERSION,
  BACKUP_DATA_TABLES,
  BACKUP_EPHEMERAL_TABLES,
  type BackupDataBatch,
  BackupDataError,
  type BackupDataSource,
  type BackupProviderCredential,
  dryRunBackupData,
  restoreBackupData,
  verifyBackupDataCatalog,
  withPrivilegedRepeatableReadBackupSnapshot,
  withRepeatableReadBackupSnapshot,
} from "./backup-data.ts";
import { PostgresBackupStore } from "./backup-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

function replaySource(data: ReadonlyMap<string, readonly BackupDataBatch[]>): BackupDataSource {
  return {
    schemaVersion: BACKUP_DATA_SCHEMA_VERSION,
    rows(name: string) {
      return (async function* () {
        for (const batch of data.get(name) ?? []) yield structuredClone(batch);
      })();
    },
  };
}

async function captureData(databaseUrl: string) {
  const captured = new Map<string, BackupDataBatch[]>();
  await withRepeatableReadBackupSnapshot(
    databaseUrl,
    async (source) => {
      for (const definition of source.tables) {
        const batches: BackupDataBatch[] = [];
        for await (const batch of source.rows(definition.name)) {
          batches.push(structuredClone(batch));
        }
        captured.set(definition.name, batches);
      }
    },
    { diagnosticPolicy: "included", batchSize: 2 },
  );
  return captured;
}

Deno.test({
  name: "backup data streams a repeatable snapshot and transactionally restores redacted state",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const store = await PostgresBackupStore.connect(databaseUrl!);
    try {
      await verifyBackupDataCatalog(databaseUrl!);
      const resetTables = [
        "backup_operations",
        "installation_state",
        ...BACKUP_DATA_TABLES.map((table) => table.name),
        ...BACKUP_EPHEMERAL_TABLES,
      ];
      await sql.unsafe(
        `TRUNCATE ${[...new Set(resetTables)].join(",")} RESTART IDENTITY CASCADE`,
      );
      await sql`INSERT INTO installation_state(singleton_id) VALUES(1)`;
      const userId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const attachmentId = crypto.randomUUID();
      const providerId = crypto.randomUUID();
      const folderId = crypto.randomUUID();
      const tagId = crypto.randomUUID();
      await sql`INSERT INTO users(
        id,email,name,password_hash,role,approval_status,state,balance_micros,email_verified_at
      ) VALUES(
        ${userId},'portable-admin@example.com','Portable Admin',NULL,
        'admin','approved','active',100,now()
      )`;
      await sql`INSERT INTO auth_users(id,name,email,email_verified)
        VALUES(${userId},'Portable Admin','portable-admin@example.com',true)`;
      await sql`INSERT INTO auth_accounts(
        id,account_id,provider_id,user_id,password,created_at,updated_at
      ) VALUES(${crypto.randomUUID()},${userId},'credential',${userId},'password-hash',now(),now())`;
      await sql`INSERT INTO ledger_entries(
        user_id,usage_run_id,kind,amount_micros,balance_after_micros
      ) VALUES(${userId},${`grant:${userId}`},'grant',100,100)`;
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,ingestion_status
      ) VALUES(
        ${attachmentId},${userId},${`users/${userId}/portable.txt`},'portable.txt',
        'text/plain',4,${"a".repeat(64)},'ready','not_applicable'
      )`;
      await sql`INSERT INTO conversations(id,owner_id,title)
        VALUES(${conversationId},${userId},'Portable conversation')`;
      await sql`INSERT INTO user_preferences(
        user_id,theme,compact_conversations,reduce_motion,custom_instructions,
        use_memory,save_history,preferred_model_id
      ) VALUES(
        ${userId},'dark',true,true,'Keep portable instructions',true,false,'portable/model'
      )`;
      await sql`INSERT INTO conversation_folders(
        id,owner_id,name,normalized_name,position,membership_version
      ) VALUES(${folderId},${userId},'İstanbul Project','İstanbul project',0,1)`;
      await sql`INSERT INTO conversation_folder_memberships(
        folder_id,conversation_id,owner_id,position
      ) VALUES(${folderId},${conversationId},${userId},0)`;
      await sql`INSERT INTO conversation_tags(id,owner_id,name,normalized_name,color)
        VALUES(${tagId},${userId},'Portable tag','portable tag','#123ABC')`;
      await sql`INSERT INTO conversation_tag_sets(conversation_id,owner_id,version)
        VALUES(${conversationId},${userId},1)`;
      await sql`INSERT INTO conversation_tag_bindings(conversation_id,tag_id,owner_id)
        VALUES(${conversationId},${tagId},${userId})`;
      await sql`INSERT INTO messages(
        id,conversation_id,sibling_index,role,content,status,metadata,idempotency_key
      ) VALUES(
        ${messageId},${conversationId},0,'user','hello','complete','{}'::jsonb,'portable-message'
      )`;
      await sql`UPDATE conversations SET active_leaf_id=${messageId} WHERE id=${conversationId}`;
      await sql`INSERT INTO message_attachments(message_id,attachment_id)
        VALUES(${messageId},${attachmentId})`;
      await sql`INSERT INTO providers(
        id,slug,display_name,base_url,protocol,enabled,version,
        credential_envelope,credential_updated_at
      ) VALUES(
        ${providerId},'portable','Portable','https://provider.example/v1',
        'chat_completions',true,1,${
        sql.json({
          version: 1,
          algorithm: "AES-256-GCM",
          keyId: "default",
          credentialVersion: 1,
          wrappedKeyNonce: "nonce",
          wrappedKey: "key",
          contentNonce: "nonce",
          ciphertext: "secret",
        })
      },now()
      )`;
      await sql`INSERT INTO retention_policy_versions(
        version,capture_enabled,request_body_days,response_body_days,updated_by
      ) VALUES(1,false,30,30,${userId})`;
      await sql`INSERT INTO retention_policy_state(singleton_id,current_version) VALUES(1,1)`;
      await sql`INSERT INTO sessions(user_id,token_hash,limited,expires_at)
        VALUES(${userId},'legacy-session',false,now()+interval '1 hour')`;
      await sql`INSERT INTO auth_sessions(
        id,expires_at,token,updated_at,user_id,limited
      ) VALUES(${crypto.randomUUID()},now()+interval '1 hour','browser-session',now(),${userId},false)`;
      await sql`INSERT INTO auth_verifications(identifier,value,expires_at)
        VALUES('reset','secret-reset-token',now()+interval '1 hour')`;
      await sql`INSERT INTO jobs(type,payload,status) VALUES('stale.job','{}'::jsonb,'queued')`;

      const captured = new Map<string, BackupDataBatch[]>();
      const concurrentConversationId = crypto.randomUUID();
      await withRepeatableReadBackupSnapshot(
        databaseUrl!,
        async (source) => {
          assertEquals("providerCredentials" in source, false);
          assertEquals(source.tables.length, BACKUP_DATA_TABLES.length);
          for (const definition of source.tables) {
            if (definition.name === "conversations") {
              await sql`INSERT INTO conversations(id,owner_id,title)
                VALUES(${concurrentConversationId},${userId},'After snapshot')`;
            }
            const batches: BackupDataBatch[] = [];
            for await (const batch of source.rows(definition.name)) {
              batches.push(structuredClone(batch));
            }
            captured.set(definition.name, batches);
          }
        },
        { diagnosticPolicy: "included", batchSize: 2 },
      );
      const capturedConversations = captured.get("conversations")!.flat();
      assertEquals(capturedConversations.some((row) => row.id === concurrentConversationId), false);
      const capturedProvider = captured.get("providers")!.flat()[0];
      assertEquals(capturedProvider.credential_redacted, true);
      assertEquals("credential_envelope" in capturedProvider, false);
      const capturedAccount = captured.get("auth_accounts")!.flat()[0];
      assertEquals("access_token" in capturedAccount, false);

      const concurrentProviderId = crypto.randomUUID();
      const privilegedCredentials: BackupProviderCredential[] = [];
      await withPrivilegedRepeatableReadBackupSnapshot(
        databaseUrl!,
        async (source) => {
          // The installation-state read has established this transaction's snapshot. This insert
          // must be absent from both the portable provider rows and credential envelope stream.
          await sql`INSERT INTO providers(
            id,slug,display_name,base_url,protocol,enabled,version,
            credential_envelope,credential_updated_at
          ) VALUES(
            ${concurrentProviderId},'after-snapshot','After snapshot',
            'https://after-snapshot.example/v1','chat_completions',true,1,
            ${
            sql.json({
              version: 1,
              algorithm: "AES-256-GCM",
              keyId: "default",
              credentialVersion: 2,
              wrappedKeyNonce: "later-nonce",
              wrappedKey: "later-key",
              contentNonce: "later-nonce",
              ciphertext: "later-secret",
            })
          },now()
          )`;
          const providerRows = [];
          for await (const batch of source.rows("providers")) providerRows.push(...batch);
          assertEquals(providerRows.some((row) => row.id === concurrentProviderId), false);
          for await (const batch of source.providerCredentials()) {
            privilegedCredentials.push(...structuredClone(batch));
          }
        },
        { batchSize: 1 },
      );
      assertEquals(privilegedCredentials.length, 1);
      assertEquals(privilegedCredentials[0].providerId, providerId);
      assertEquals(privilegedCredentials[0].envelope.credentialVersion, 1);

      const source = replaySource(captured);
      const preview = await dryRunBackupData(databaseUrl!, source);
      assertEquals(preview.users, 1);
      assertEquals(preview.providersDisabledForRedactedCredentials, 1);
      assertEquals(Number((await sql`SELECT count(*) count FROM conversations`)[0].count), 2);
      assertEquals(Number((await sql`SELECT count(*) count FROM sessions`)[0].count), 1);

      let operation = await store.create({
        kind: "restore",
        actorId: userId,
        idempotencyKey: "portable-restore-operation",
        sourceObjectKey: "backup-uploads/portable.dgcb",
        archiveSha256: "b".repeat(64),
      });
      operation = await store.claim(operation.id, operation.version);
      operation = await store.updateProgress(operation.id, operation.version, {
        stage: "validating",
        objectsProcessed: 0,
        objectsTotal: 0,
        bytesProcessed: 0,
        bytesTotal: 0,
      });
      operation = await store.validateRestore(operation.id, operation.version, {
        archiveSha256: "b".repeat(64),
        manifest: { schemaVersion: BACKUP_DATA_SCHEMA_VERSION },
        impact: preview as unknown as Record<string, unknown>,
      });
      operation = await store.beginRestoreApply(
        operation.id,
        operation.version,
        operation.confirmationFingerprint!,
      );
      const maintenance = await store.beginRestoreMaintenance(operation.id, operation.version);
      const restored = await restoreBackupData(databaseUrl!, replaySource(captured), {
        restoreOperationId: operation.id,
        expectedOperationVersion: operation.version,
        expectedInstallationVersion: maintenance.installation.version,
        objectKeyMap: new Map([[
          `users/${userId}/portable.txt`,
          `restores/${operation.id}/portable.txt`,
        ]]),
      });
      assertEquals(restored.restoreOperationVersion, operation.version + 1);
      await store.finishRestore(
        operation.id,
        restored.restoreOperationVersion!,
        maintenance.installation.version,
        { archiveSha256: "b".repeat(64), impact: restored as unknown as Record<string, unknown> },
      );

      assertEquals(Number((await sql`SELECT count(*) count FROM conversations`)[0].count), 1);
      assertEquals(
        [
          ...await sql`SELECT theme,compact_conversations,reduce_motion,custom_instructions,
          use_memory,save_history,preferred_model_id FROM user_preferences
          WHERE user_id=${userId}`,
        ],
        [{
          theme: "dark",
          compact_conversations: true,
          reduce_motion: true,
          custom_instructions: "Keep portable instructions",
          use_memory: true,
          save_history: false,
          preferred_model_id: "portable/model",
        }],
      );
      assertEquals(
        [
          ...await sql`SELECT f.name,f.membership_version,m.position
          FROM conversation_folders f JOIN conversation_folder_memberships m
            ON m.folder_id=f.id AND m.owner_id=f.owner_id
          WHERE f.id=${folderId} AND m.conversation_id=${conversationId}`,
        ],
        [{ name: "İstanbul Project", membership_version: 1, position: 0 }],
      );
      assertEquals(
        [
          ...await sql`SELECT t.name,t.color,s.version
          FROM conversation_tags t JOIN conversation_tag_bindings b
            ON b.tag_id=t.id AND b.owner_id=t.owner_id
          JOIN conversation_tag_sets s
            ON s.conversation_id=b.conversation_id AND s.owner_id=b.owner_id
          WHERE t.id=${tagId} AND b.conversation_id=${conversationId}`,
        ],
        [{ name: "Portable tag", color: "#123ABC", version: 1 }],
      );
      assertEquals(
        (await sql`SELECT object_key FROM attachments WHERE id=${attachmentId}`)[0].object_key,
        `restores/${operation.id}/portable.txt`,
      );
      const [provider] = await sql<{ enabled: boolean; credential_envelope: unknown }[]>`
        SELECT enabled,credential_envelope FROM providers WHERE id=${providerId}`;
      assertEquals(provider, { enabled: false, credential_envelope: null });
      assertEquals(Number((await sql`SELECT count(*) count FROM sessions`)[0].count), 0);
      assertEquals(Number((await sql`SELECT count(*) count FROM auth_sessions`)[0].count), 0);
      assertEquals(Number((await sql`SELECT count(*) count FROM auth_verifications`)[0].count), 0);
      assertEquals(Number((await sql`SELECT count(*) count FROM jobs`)[0].count), 0);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
        WHERE action='backup.restore.database_committed'`)[0].count,
        ),
        1,
      );
    } finally {
      await store.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "backup restore rolls back injected faults and serializes duplicate apply attempts",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const store = await PostgresBackupStore.connect(databaseUrl!);
    try {
      const [admin] = await sql<{ id: string; name: string }[]>`
        SELECT id,name FROM users WHERE role='admin' AND approval_status='approved' LIMIT 1
      `;
      const captured = await captureData(databaseUrl!);
      const preview = await dryRunBackupData(databaseUrl!, replaySource(captured));
      const prepare = async (key: string, digest: string) => {
        let operation = await store.create({
          kind: "restore",
          actorId: admin.id,
          idempotencyKey: key,
          sourceObjectKey: `backup-uploads/${key}.dgcb`,
          archiveSha256: digest,
        });
        operation = await store.claim(operation.id, operation.version);
        operation = await store.updateProgress(operation.id, operation.version, {
          stage: "validating",
          objectsProcessed: 0,
          objectsTotal: 0,
          bytesProcessed: 0,
          bytesTotal: 0,
        });
        operation = await store.validateRestore(operation.id, operation.version, {
          archiveSha256: digest,
          manifest: { schemaVersion: BACKUP_DATA_SCHEMA_VERSION },
          impact: preview as unknown as Record<string, unknown>,
        });
        return await store.beginRestoreApply(
          operation.id,
          operation.version,
          operation.confirmationFingerprint!,
        );
      };

      await sql`UPDATE users SET name='Destination survives rollback' WHERE id=${admin.id}`;
      await sql`INSERT INTO sessions(user_id,token_hash,limited,expires_at)
        VALUES(${admin.id},'rollback-session',false,now()+interval '1 hour')`;
      const failedOperation = await prepare("fault-rollback-restore", "c".repeat(64));
      const failedMaintenance = await store.beginRestoreMaintenance(
        failedOperation.id,
        failedOperation.version,
      );
      await assertRejects(() =>
        restoreBackupData(databaseUrl!, replaySource(captured), {
          restoreOperationId: failedOperation.id,
          expectedOperationVersion: failedOperation.version,
          expectedInstallationVersion: failedMaintenance.installation.version,
          beforeCommit() {
            throw new Error("injected pre-commit failure");
          },
        })
      );
      assertEquals(
        (await sql`SELECT name FROM users WHERE id=${admin.id}`)[0].name,
        "Destination survives rollback",
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM sessions
        WHERE token_hash='rollback-session'`)[0].count,
        ),
        1,
      );
      assertEquals((await store.get(failedOperation.id)).stage, "restore_staging");
      await store.failRestore(
        failedOperation.id,
        failedOperation.version,
        failedMaintenance.installation.version,
        "internal_error",
      );

      const operation = await prepare("concurrent-restore-apply", "d".repeat(64));
      const maintenance = await store.beginRestoreMaintenance(operation.id, operation.version);
      const attempts = await Promise.allSettled([
        restoreBackupData(databaseUrl!, replaySource(captured), {
          restoreOperationId: operation.id,
          expectedOperationVersion: operation.version,
          expectedInstallationVersion: maintenance.installation.version,
        }),
        restoreBackupData(databaseUrl!, replaySource(captured), {
          restoreOperationId: operation.id,
          expectedOperationVersion: operation.version,
          expectedInstallationVersion: maintenance.installation.version,
        }),
      ]);
      assertEquals(attempts.filter((result) => result.status === "fulfilled").length, 1);
      assertEquals(attempts.filter((result) => result.status === "rejected").length, 1);
      const winner = attempts.find((result) => result.status === "fulfilled");
      if (!winner || winner.status !== "fulfilled") {
        throw new Error("Concurrent restore had no winner");
      }
      await store.finishRestore(
        operation.id,
        winner.value.restoreOperationVersion!,
        maintenance.installation.version,
        {
          archiveSha256: "d".repeat(64),
          impact: winner.value as unknown as Record<string, unknown>,
        },
      );
    } finally {
      await store.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "backup restore rejects malformed rows before touching live data",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      const before = Number((await sql`SELECT count(*) count FROM users`)[0].count);
      const source: BackupDataSource = {
        schemaVersion: BACKUP_DATA_SCHEMA_VERSION,
        rows(name) {
          return (async function* () {
            if (name === "users") yield [{ unknown: true }];
          })();
        },
      };
      await assertRejects(() => dryRunBackupData(databaseUrl!, source), BackupDataError);
      assertEquals(Number((await sql`SELECT count(*) count FROM users`)[0].count), before);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "backup dry-run rejects conversation cycles and nonterminal durable state in staging",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      const captured = await captureData(databaseUrl!);
      const messageBatches = structuredClone(captured.get("messages")!);
      const message = messageBatches.flat()[0] as Record<string, unknown>;
      message.parent_id = message.id;
      const cycle = new Map(captured);
      cycle.set("messages", messageBatches);
      const before = Number((await sql`SELECT count(*) count FROM messages`)[0].count);
      await assertRejects(
        () => dryRunBackupData(databaseUrl!, replaySource(cycle)),
        BackupDataError,
      );
      assertEquals(Number((await sql`SELECT count(*) count FROM messages`)[0].count), before);

      const streamingBatches = structuredClone(captured.get("messages")!);
      (streamingBatches.flat()[0] as Record<string, unknown>).status = "streaming";
      const streaming = new Map(captured);
      streaming.set("messages", streamingBatches);
      await assertRejects(
        () => dryRunBackupData(databaseUrl!, replaySource(streaming)),
        BackupDataError,
      );
      assertEquals(Number((await sql`SELECT count(*) count FROM messages`)[0].count), before);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "backup catalog fails closed for an unclassified migration table",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await sql`CREATE TABLE backup_unclassified_probe(id uuid PRIMARY KEY)`;
      await assertRejects(() => verifyBackupDataCatalog(databaseUrl!), BackupDataError);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM pg_trigger t
          JOIN pg_class c ON c.oid=t.tgrelid
          WHERE c.relname='backup_unclassified_probe'
            AND t.tgname='dg_chat_restore_maintenance_fence'`)[0].count,
        ),
        0,
      );
      await sql`CREATE TRIGGER dg_chat_restore_maintenance_fence
        BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON backup_unclassified_probe
        FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance()`;
      // A trigger alone is not a reviewed portability policy. Future migrations must add both.
      await assertRejects(() => verifyBackupDataCatalog(databaseUrl!), BackupDataError);
    } finally {
      await sql`DROP TABLE IF EXISTS backup_unclassified_probe`;
      await sql.end();
    }
  },
});
