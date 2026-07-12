import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import type { BackupOperation, ObjectStore, PutObjectInput, StoredObject } from "@dg-chat/database";
import {
  backupContentRoot,
  createHmacBackupAuthenticator,
  sha256Hex,
  signBackupManifest,
  writeBackupArchive,
} from "@dg-chat/database";
import {
  BackupDataPort,
  BackupExportSnapshot,
  BackupRestoreSession,
  BackupServiceError,
  DefaultBackupAdminService,
} from "./backup-service.ts";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const encoder = new TextEncoder();
async function bytes(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
class MemoryObjects implements ObjectStore {
  values = new Map<string, { bytes: Uint8Array; input: PutObjectInput }>();
  async put(input: PutObjectInput) {
    this.values.set(input.key, { bytes: await bytes(input.body), input });
    return { etag: "test" };
  }
  get(key: string): Promise<StoredObject | undefined> {
    const found = this.values.get(key);
    return Promise.resolve(
      found &&
        {
          key,
          body: new Blob([new Uint8Array(found.bytes).buffer]).stream(),
          contentLength: found.bytes.length,
          contentType: found.input.contentType,
          etag: "test",
          metadata: found.input.metadata ?? {},
        },
    );
  }
  delete(key: string) {
    this.values.delete(key);
    return Promise.resolve();
  }
  readiness() {
    return Promise.resolve(true);
  }
  close() {}
}
function operation(
  kind: "export" | "restore",
  options: Record<string, unknown>,
  key: string,
): BackupOperation {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind,
    status: "queued",
    version: 1,
    actorId: ACTOR,
    actorEmail: "admin@example.test",
    actorName: "Admin",
    idempotencyKey: key,
    stage: "queued",
    sourceObjectKey: null,
    artifactObjectKey: null,
    archiveSha256: null,
    options,
    manifest: null,
    impact: null,
    confirmationFingerprint: null,
    objectsProcessed: 0,
    objectsTotal: 0,
    bytesProcessed: 0,
    bytesTotal: 0,
    error: null,
    createdAt: now,
    startedAt: null,
    validatedAt: null,
    completedAt: null,
    updatedAt: now,
  };
}
class MemoryStore {
  items = new Map<string, BackupOperation>();
  failFinish = false;
  failRestoreCalls = 0;
  throwAfterCreate = false;
  create(
    input: {
      kind: "export" | "restore";
      actorId: string;
      idempotencyKey: string;
      options?: Record<string, unknown>;
      sourceObjectKey?: string | null;
      archiveSha256?: string | null;
    },
  ) {
    const prior = [...this.items.values()].find((item) =>
      item.actorId === input.actorId && item.kind === input.kind &&
      item.idempotencyKey === input.idempotencyKey
    );
    if (prior) {
      if (
        prior.sourceObjectKey !== (input.sourceObjectKey ?? null) ||
        prior.archiveSha256 !== (input.archiveSha256 ?? null) ||
        JSON.stringify(prior.options) !== JSON.stringify(input.options ?? {})
      ) throw new Error("idempotency conflict");
      return Promise.resolve(structuredClone(prior));
    }
    const item = operation(input.kind, input.options ?? {}, input.idempotencyKey);
    item.sourceObjectKey = input.sourceObjectKey ?? null;
    item.archiveSha256 = input.archiveSha256 ?? null;
    this.items.set(item.id, item);
    if (this.throwAfterCreate) throw new Error("create response lost");
    return Promise.resolve(structuredClone(item));
  }
  get(id: string) {
    const item = this.items.get(id);
    if (!item) throw new Error("missing");
    return Promise.resolve(structuredClone(item));
  }
  findByIdempotency(actorId: string, kind: "export" | "restore", key: string) {
    const item = [...this.items.values()].find((candidate) =>
      candidate.actorId === actorId && candidate.kind === kind && candidate.idempotencyKey === key
    );
    return Promise.resolve(item ? structuredClone(item) : undefined);
  }
  list(kind?: "export" | "restore") {
    return Promise.resolve(
      [...this.items.values()].filter((item) => !kind || item.kind === kind).map((item) =>
        structuredClone(item)
      ),
    );
  }
  installationState() {
    return Promise.resolve({
      installationId: "installation-test",
      maintenanceEnabled: this.maintenance,
      version: this.installVersion,
      restoreEpoch: 0,
      activeRestoreId: this.active,
      updatedAt: new Date().toISOString(),
    });
  }
  maintenance = false;
  installVersion = 1;
  active: string | null = null;
  mutate(id: string, expected: number, update: Partial<BackupOperation>) {
    const item = this.items.get(id)!;
    if (item.version !== expected) throw new Error("stale");
    Object.assign(item, update, { version: item.version + 1, updatedAt: new Date().toISOString() });
    return Promise.resolve(structuredClone(item));
  }
  claim(id: string, version: number) {
    return this.mutate(id, version, {
      status: "running",
      stage: "starting",
      startedAt: new Date().toISOString(),
    });
  }
  updateProgress(
    id: string,
    version: number,
    input: {
      stage: string;
      objectsProcessed: number;
      objectsTotal: number;
      bytesProcessed: number;
      bytesTotal: number;
      manifest?: Record<string, unknown> | null;
      impact?: Record<string, unknown> | null;
    },
  ) {
    return this.mutate(id, version, {
      ...input,
      manifest: input.manifest ?? this.items.get(id)!.manifest,
      impact: input.impact ?? this.items.get(id)!.impact,
    });
  }
  validateRestore(
    id: string,
    version: number,
    input: {
      archiveSha256: string;
      manifest: Record<string, unknown>;
      impact: Record<string, unknown>;
    },
  ) {
    return this.mutate(id, version, {
      status: "validated",
      stage: "validated",
      ...input,
      confirmationFingerprint: input.archiveSha256.slice(0, 8).toUpperCase(),
      validatedAt: new Date().toISOString(),
    });
  }
  beginRestoreApply(id: string, version: number) {
    return this.mutate(id, version, { status: "running", stage: "restore_staging" });
  }
  async beginRestoreMaintenance(id: string, _version: number) {
    if (this.active && this.active !== id) throw new Error("another restore owns maintenance");
    this.maintenance = true;
    this.active = id;
    this.installVersion++;
    return { operation: await this.get(id), installation: await this.installationState() };
  }
  async endRestoreMaintenance(_id: string, _version: number) {
    this.maintenance = false;
    this.active = null;
    this.installVersion++;
    return await this.installationState();
  }
  async finishRestore(
    id: string,
    version: number,
    installationVersion: number,
    input: { archiveSha256: string; impact?: Record<string, unknown> },
  ) {
    if (this.failFinish) throw new Error("finish unavailable");
    const installation = await this.endRestoreMaintenance(id, installationVersion);
    const finished = await this.complete(id, version, input);
    return { operation: finished, installation };
  }
  async failRestore(id: string, version: number, installationVersion: number) {
    this.failRestoreCalls++;
    const installation = await this.endRestoreMaintenance(id, installationVersion);
    const failed = await this.fail(id, version);
    return { operation: failed, installation };
  }
  complete(
    id: string,
    version: number,
    input: {
      archiveSha256: string;
      artifactObjectKey?: string | null;
      manifest?: Record<string, unknown>;
      impact?: Record<string, unknown>;
    },
  ) {
    return this.mutate(id, version, {
      status: "completed",
      stage: "completed",
      ...input,
      completedAt: new Date().toISOString(),
    });
  }
  fail(id: string, version: number) {
    return this.mutate(id, version, {
      status: "failed",
      stage: "failed",
      error: "The backup operation failed",
    });
  }
  close() {
    return Promise.resolve();
  }
}
async function setup(options: { failApplySession?: boolean } = {}) {
  const auth = await createHmacBackupAuthenticator("test-key", new Uint8Array(32).fill(4));
  const payload = encoder.encode('{"id":1}\n');
  const entries = [{
    name: "database/users.ndjson",
    kind: "ndjson" as const,
    bytes: payload.length,
    sha256: await sha256Hex(payload),
    records: 1,
  }];
  const manifest = await signBackupManifest({
    format: "dg-chat-backup",
    version: 1,
    backupId: "backup-test",
    createdAt: "2026-07-12T00:00:00.000Z",
    appVersion: "1.0.0",
    schemaVersion: "0028",
    mode: "system",
    secretPolicy: "redacted",
    diagnosticPayloadPolicy: "excluded",
    source: { installationId: "installation-test" },
    objects: { count: 0, bytes: 0, indexSha256: await sha256Hex(new Uint8Array()) },
    requiredProviderKeyIds: [],
    contentRootSha256: await backupContentRoot(entries),
    entries,
  }, auth);
  const snapshot: BackupExportSnapshot = {
    manifest,
    payloads: new Map([[entries[0].name, payload]]),
    objectsTotal: 1,
    bytesTotal: payload.length,
  };
  const sessions: { mode: string; rolledBack: boolean }[] = [];
  const store = new MemoryStore();
  const data: BackupDataPort = {
    exportSnapshot: () => Promise.resolve(snapshot),
    restoreSession(mode) {
      if (mode === "apply" && options.failApplySession) {
        throw new Error("restore staging unavailable");
      }
      const state = { mode, rolledBack: false };
      sessions.push(state);
      const session: BackupRestoreSession = {
        sink: { begin() {}, write() {}, commit() {}, abort() {} },
        summarize: () =>
          Promise.resolve({
            counts: [{ resource: "users", create: 1, update: 0, skip: 0 }],
            warnings: [],
            blockingErrors: [],
            attachmentsMissing: 0,
          }),
        commit: async (_manifest, context) => {
          const fenced = await store.mutate(
            context.restoreOperationId,
            context.expectedOperationVersion,
            { stage: "database_restored" },
          );
          return {
            counts: [{ resource: "users", create: 1, update: 0, skip: 0 }],
            restoreOperationVersion: fenced.version,
            installationVersion: context.expectedInstallationVersion,
          };
        },
        rollback() {
          state.rolledBack = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };
  const objects = new MemoryObjects();
  const service = new DefaultBackupAdminService({
    store,
    objects,
    data,
    authenticator: auth,
    restoreEnabled: true,
    maxUploadBytes: 4 * 1024 * 1024,
  });
  return { auth, manifest, payload, snapshot, store, objects, service, sessions };
}
function uploadRequest(archive: Uint8Array, filename = "installation.dgbackup") {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(archive).buffer], { type: "application/vnd.dg-chat.backup" }),
    filename,
  );
  return new Request("http://local/upload", { method: "POST", body: form });
}
async function completed(store: MemoryStore, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await store.get(id);
    if (current.status === "completed" || current.status === "failed") return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("backup did not complete");
}

Deno.test("backup service exports durably, streams object content, and recovers queued work", async () => {
  const fx = await setup();
  const result = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "export-test-1",
  });
  assertEquals(result.status, "queued");
  const finished = await completed(fx.store, result.id);
  assertEquals(finished.status, "completed");
  assertEquals(fx.objects.values.size, 1);
  assertEquals(
    (await fx.service.exportContent(ACTOR, result.id)).headers.get("x-backup-sha256"),
    finished.archiveSha256,
  );
  assertEquals(
    (await fx.service.exportContent("22222222-2222-4222-8222-222222222222", result.id)).status,
    200,
  );
  const queued = operation("export", { includeDiagnostics: false }, "export-recovery-1");
  fx.store.items.set(queued.id, queued);
  await fx.service.recoverPending();
  assertEquals((await fx.store.get(queued.id)).status, "completed");
});

Deno.test("restore upload is bounded, preflighted, digest-bound, and applied", async () => {
  const fx = await setup();
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-test-1",
  });
  assertEquals(uploaded.bytes, archive.length);
  const replayed = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-test-1",
  });
  assertEquals(replayed.id, uploaded.id);
  assertEquals(fx.objects.values.size, 1);
  const preview = await fx.service.previewRestore(ACTOR, uploaded.id);
  assertEquals(preview.counts[0].create, 1);
  const applied = await fx.service.applyRestore({
    actorId: ACTOR,
    restoreId: uploaded.id,
    fingerprint: uploaded.fingerprint,
  });
  assertEquals(applied.status, "completed");
  assertEquals(fx.store.maintenance, false);
});

Deno.test("conflicting restore upload removes only its newly orphaned object", async () => {
  const fx = await setup();
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-orphan-cleanup",
  });
  const changed = archive.slice();
  changed[changed.length - 1] ^= 1;
  await assertRejects(
    () =>
      fx.service.uploadRestore({
        actorId: ACTOR,
        request: uploadRequest(changed),
        idempotencyKey: "restore-orphan-cleanup",
      }),
    Error,
    "idempotency conflict",
  );
  assertEquals(fx.objects.values.size, 1);
});

Deno.test("restore upload preserves a newly stored object after an ambiguous durable create", async () => {
  const fx = await setup();
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  fx.store.throwAfterCreate = true;
  await assertRejects(
    () =>
      fx.service.uploadRestore({
        actorId: ACTOR,
        request: uploadRequest(archive),
        idempotencyKey: "restore-ambiguous-create",
      }),
    Error,
    "response lost",
  );
  assertEquals(fx.objects.values.size, 1);
  assertEquals(
    (await fx.store.findByIdempotency(ACTOR, "restore", "restore-ambiguous-create"))
      ?.sourceObjectKey,
    [...fx.objects.values.keys()][0],
  );
});

Deno.test("restore detects staged-object tampering and cleans invalid uploads", async () => {
  const fx = await setup();
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-tamper-1",
  });
  const op = await fx.store.get(uploaded.id);
  fx.objects.values.get(op.sourceObjectKey!)!.bytes[0] ^= 1;
  await assertRejects(
    () => fx.service.previewRestore(ACTOR, uploaded.id),
    BackupServiceError,
    "invalid",
  );
  await assertRejects(
    () =>
      fx.service.uploadRestore({
        actorId: ACTOR,
        request: uploadRequest(archive, "unsafe.txt"),
        idempotencyKey: "restore-bad-1",
      }),
    BackupServiceError,
    "invalid",
  );
});

Deno.test("post-commit finalization failure preserves maintenance for deterministic recovery", async () => {
  const fx = await setup();
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-finalize-recovery",
  });
  await fx.service.previewRestore(ACTOR, uploaded.id);
  fx.store.failFinish = true;
  await assertRejects(
    () =>
      fx.service.applyRestore({
        actorId: ACTOR,
        restoreId: uploaded.id,
        fingerprint: uploaded.fingerprint,
      }),
    BackupServiceError,
  );
  assertEquals(fx.store.maintenance, true);
  assertEquals(fx.store.failRestoreCalls, 0);
  assertEquals(fx.sessions.at(-1)?.rolledBack, false);
  fx.store.failFinish = false;
  await fx.service.recoverPending();
  assertEquals((await fx.store.get(uploaded.id)).status, "completed");
  assertEquals(fx.store.maintenance, false);
});

Deno.test("apply terminalizes a source that changes after preview before taking maintenance", async () => {
  const fx = await setup();
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-apply-tamper",
  });
  await fx.service.previewRestore(ACTOR, uploaded.id);
  const operation = await fx.store.get(uploaded.id);
  fx.objects.values.get(operation.sourceObjectKey!)!.bytes[0] ^= 1;
  await assertRejects(
    () =>
      fx.service.applyRestore({
        actorId: ACTOR,
        restoreId: uploaded.id,
        fingerprint: uploaded.fingerprint,
      }),
    BackupServiceError,
    "integrity",
  );
  assertEquals((await fx.store.get(uploaded.id)).status, "failed");
  assertEquals(fx.store.maintenance, false);
});

Deno.test("apply releases maintenance when restore-session staging cannot start", async () => {
  const fx = await setup({ failApplySession: true });
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-session-failure",
  });
  await fx.service.previewRestore(ACTOR, uploaded.id);
  await assertRejects(
    () =>
      fx.service.applyRestore({
        actorId: ACTOR,
        restoreId: uploaded.id,
        fingerprint: uploaded.fingerprint,
      }),
    BackupServiceError,
  );
  assertEquals((await fx.store.get(uploaded.id)).status, "failed");
  assertEquals(fx.store.maintenance, false);
  assertEquals(fx.store.failRestoreCalls, 1);
});

Deno.test("concurrent restore failure terminalizes only the unfenced contender", async () => {
  const fx = await setup();
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-maintenance-contender",
  });
  await fx.service.previewRestore(ACTOR, uploaded.id);
  const other = crypto.randomUUID();
  fx.store.maintenance = true;
  fx.store.active = other;
  fx.store.installVersion = 9;
  await assertRejects(
    () =>
      fx.service.applyRestore({
        actorId: ACTOR,
        restoreId: uploaded.id,
        fingerprint: uploaded.fingerprint,
      }),
    BackupServiceError,
    "maintenance",
  );
  assertEquals((await fx.store.get(uploaded.id)).status, "failed");
  assertEquals(fx.store.active, other);
  assertEquals(fx.store.maintenance, true);
  assertEquals(fx.store.failRestoreCalls, 0);
});

Deno.test("recovery directly unfences an active precommit restore hidden from bounded history", async () => {
  const fx = await setup();
  const active = operation("restore", { filename: "backup.dgbackup", bytes: 1 }, "active-restore");
  Object.assign(active, {
    status: "running",
    stage: "restore_staging",
    startedAt: new Date().toISOString(),
  });
  fx.store.items.set(active.id, active);
  fx.store.maintenance = true;
  fx.store.active = active.id;
  fx.store.installVersion = 7;
  fx.store.list = () => Promise.resolve([]);
  await fx.service.recoverPending();
  assertEquals((await fx.store.get(active.id)).status, "failed");
  assertEquals(fx.store.maintenance, false);
  assertEquals(fx.store.failRestoreCalls, 1);
});
