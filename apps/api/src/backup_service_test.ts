import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import type { BackupOperation, ObjectStore, PutObjectInput, StoredObject } from "@dg-chat/database";
import {
  backupContentRoot,
  BackupOperationError,
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
class DelayedPutObjects extends MemoryObjects {
  readonly started: Promise<void>;
  readonly release: () => void;
  signal: AbortSignal | undefined;
  constructor() {
    super();
    let started!: () => void;
    let release!: () => void;
    this.started = new Promise<void>((resolve) => started = resolve);
    const gate = new Promise<void>((resolve) => release = resolve);
    this.release = release;
    this.put = async (input: PutObjectInput) => {
      this.signal = input.signal;
      started();
      // Deliberately ignore cancellation to model an SDK/remote request that publishes late.
      await gate;
      return await MemoryObjects.prototype.put.call(this, input);
    };
  }
}
class CountingObjects extends MemoryObjects {
  deletes = new Map<string, number>();
  gets = new Map<string, number>();
  override get(key: string) {
    this.gets.set(key, (this.gets.get(key) ?? 0) + 1);
    return super.get(key);
  }
  override delete(key: string) {
    this.deletes.set(key, (this.deletes.get(key) ?? 0) + 1);
    return super.delete(key);
  }
}
class FlakyCleanupObjects extends CountingObjects {
  failures = 1;
  override delete(key: string) {
    if (this.failures-- > 0) return Promise.reject(new Error("S3 unavailable"));
    return super.delete(key);
  }
}
class GatedDeleteObjects extends CountingObjects {
  readonly started: Promise<void>;
  readonly release: () => void;
  constructor() {
    super();
    let started!: () => void;
    let release!: () => void;
    this.started = new Promise((resolve) => started = resolve);
    const gate = new Promise<void>((resolve) => release = resolve);
    this.release = release;
    this.delete = async (key: string) => {
      started();
      await gate;
      return await CountingObjects.prototype.delete.call(this, key);
    };
  }
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
    exportLeaseToken: null,
    exportLeaseExpiresAt: null,
    artifactCleanupCheckedAt: null,
    artifactCleanupLeaseToken: null,
    artifactCleanupLeaseExpiresAt: null,
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
  activeExport: string | null = null;
  failRenewExport = false;
  failCompleteExport = false;
  throwAfterCompleteExport = false;
  claimExport(id: string, version: number, leaseToken: string, leaseSeconds: number) {
    if (this.activeExport && this.activeExport !== id) {
      return Promise.reject(new BackupOperationError("conflict", "another export owns lease"));
    }
    this.activeExport = id;
    return this.mutate(id, version, {
      status: "running",
      stage: "starting",
      startedAt: new Date().toISOString(),
      exportLeaseToken: leaseToken,
      exportLeaseExpiresAt: new Date(Date.now() + leaseSeconds * 1_000).toISOString(),
    });
  }
  async claimNextQueuedExport(leaseToken: string, leaseSeconds: number) {
    await this.expireExportLeases();
    if (this.activeExport) return Promise.resolve(undefined);
    const item = [...this.items.values()].find((candidate) =>
      candidate.kind === "export" && candidate.status === "queued"
    );
    return item
      ? this.claimExport(item.id, item.version, leaseToken, leaseSeconds)
      : Promise.resolve(undefined);
  }
  listRecoverableRestores(limit = 100) {
    return Promise.resolve(
      [...this.items.values()].filter((item) =>
        item.kind === "restore" && item.status === "running" && item.stage !== "database_restored"
      ).slice(0, limit).map((item) => structuredClone(item)),
    );
  }
  renewExportLease(id: string, leaseToken: string, leaseSeconds: number) {
    if (this.failRenewExport) {
      return Promise.reject(new BackupOperationError("conflict", "lease lost"));
    }
    const item = this.items.get(id);
    if (!item || item.exportLeaseToken !== leaseToken || item.status !== "running") {
      return Promise.reject(new BackupOperationError("conflict", "lease lost"));
    }
    item.exportLeaseExpiresAt = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
    return Promise.resolve();
  }
  expireExportLeases() {
    let count = 0;
    for (const item of this.items.values()) {
      if (
        item.kind === "export" && item.status === "running" && item.exportLeaseExpiresAt &&
        Date.parse(item.exportLeaseExpiresAt) <= Date.now()
      ) {
        Object.assign(item, {
          status: "failed",
          stage: "failed",
          error: "The backup operation timed out",
          completedAt: new Date().toISOString(),
          exportLeaseToken: null,
          exportLeaseExpiresAt: null,
          version: item.version + 1,
        });
        if (this.activeExport === item.id) this.activeExport = null;
        count++;
      }
    }
    return Promise.resolve(count);
  }
  planExportArtifact(
    id: string,
    version: number,
    leaseToken: string,
    artifactObjectKey: string,
    archiveSha256: string,
  ) {
    const item = this.items.get(id);
    if (
      !item || item.exportLeaseToken !== leaseToken || item.status !== "running" ||
      item.artifactObjectKey || item.archiveSha256
    ) return Promise.reject(new BackupOperationError("conflict", "artifact plan stale"));
    return this.mutate(id, version, {
      stage: "uploading",
      artifactObjectKey,
      archiveSha256,
    });
  }
  claimRecoverableExportArtifacts(
    leaseToken: string,
    leaseSeconds: number,
    cooldownMs: number,
    _claimTimeoutMs: number,
    limit = 100,
  ) {
    const now = Date.now();
    const claimed = [...this.items.values()].filter((item) =>
      item.kind === "export" && ["failed", "cancelled"].includes(item.status) &&
      item.artifactObjectKey && item.archiveSha256 &&
      (!item.artifactCleanupLeaseToken ||
        Date.parse(item.artifactCleanupLeaseExpiresAt ?? "") <= now) &&
      (!item.artifactCleanupCheckedAt ||
        Date.parse(item.artifactCleanupCheckedAt) <= now - cooldownMs)
    ).sort((left, right) =>
      (left.artifactCleanupCheckedAt ?? "").localeCompare(right.artifactCleanupCheckedAt ?? "") ||
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    ).slice(0, limit);
    for (const item of claimed) {
      item.artifactCleanupLeaseToken = leaseToken;
      item.artifactCleanupLeaseExpiresAt = new Date(now + leaseSeconds * 1_000).toISOString();
      item.version++;
    }
    return Promise.resolve(claimed.map((item) => structuredClone(item)));
  }
  nextRunningExportLeaseExpiry() {
    const expiries = [...this.items.values()].filter((item) =>
      item.kind === "export" && item.status === "running" && item.exportLeaseExpiresAt
    ).map((item) => item.exportLeaseExpiresAt!).sort();
    return Promise.resolve(expiries[0] ?? null);
  }
  recordExportArtifactCleanup(id: string, key: string, digest: string, leaseToken: string) {
    const item = this.items.get(id);
    if (
      !item || !["failed", "cancelled"].includes(item.status) ||
      item.artifactObjectKey !== key || item.archiveSha256 !== digest ||
      item.artifactCleanupLeaseToken !== leaseToken
    ) return Promise.resolve(false);
    Object.assign(item, {
      artifactCleanupCheckedAt: new Date().toISOString(),
      artifactCleanupLeaseToken: null,
      artifactCleanupLeaseExpiresAt: null,
      version: item.version + 1,
      updatedAt: new Date().toISOString(),
    });
    return Promise.resolve(true);
  }
  releaseExportArtifactCleanup(id: string, leaseToken: string) {
    const item = this.items.get(id);
    if (!item || item.artifactCleanupLeaseToken !== leaseToken) return Promise.resolve(false);
    Object.assign(item, {
      artifactCleanupLeaseToken: null,
      artifactCleanupLeaseExpiresAt: null,
      version: item.version + 1,
      updatedAt: new Date().toISOString(),
    });
    return Promise.resolve(true);
  }
  cancel(id: string, version: number) {
    return this.mutate(id, version, {
      status: "cancelled",
      stage: "cancelled",
      completedAt: new Date().toISOString(),
      exportLeaseToken: null,
      exportLeaseExpiresAt: null,
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
    if (this.failCompleteExport && this.items.get(id)?.kind === "export") {
      throw new BackupOperationError("conflict", "finalization lost its lease");
    }
    this.activeExport = null;
    const result = this.mutate(id, version, {
      status: "completed",
      stage: "completed",
      ...input,
      completedAt: new Date().toISOString(),
      exportLeaseToken: null,
      exportLeaseExpiresAt: null,
    });
    if (this.throwAfterCompleteExport && this.items.get(id)?.kind === "export") {
      return result.then(() => {
        throw new Error("complete response lost");
      });
    }
    return result;
  }
  fail(id: string, version: number) {
    this.activeExport = null;
    return this.mutate(id, version, {
      status: "failed",
      stage: "failed",
      error: "The backup operation failed",
      exportLeaseToken: null,
      exportLeaseExpiresAt: null,
    });
  }
  close() {
    return Promise.resolve();
  }
}
async function setup(
  options: {
    failApplySession?: boolean;
    failCleanup?: boolean;
    throwAfterRestoreCommit?: boolean;
    exportSnapshot?: BackupDataPort["exportSnapshot"];
    serviceOptions?: {
      exportLeaseSeconds?: number;
      exportDeadlineMs?: number;
      shutdownGraceMs?: number;
    };
  } = {},
) {
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
  const sessions: { mode: string; operationId: string; rolledBack: boolean; cleaned: boolean }[] =
    [];
  const store = new MemoryStore();
  const data: BackupDataPort = {
    exportSnapshot: options.exportSnapshot ?? (() => Promise.resolve(snapshot)),
    restoreSession(mode, context) {
      if (mode === "apply" && options.failApplySession) {
        throw new Error("restore staging unavailable");
      }
      const state = {
        mode,
        operationId: context.restoreOperationId,
        rolledBack: false,
        cleaned: false,
      };
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
        cleanup: () => {
          if (options.failCleanup) throw new Error("cleanup unavailable");
          state.cleaned = true;
          return Promise.resolve();
        },
        commit: async (_manifest, context) => {
          const fenced = await store.mutate(
            context.restoreOperationId,
            context.expectedOperationVersion,
            { stage: "database_restored" },
          );
          if (options.throwAfterRestoreCommit) {
            throw new Error("database commit response lost");
          }
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
    ...options.serviceOptions,
  });
  return { auth, manifest, payload, snapshot, store, objects, service, sessions, data };
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
  assertEquals((await completed(fx.store, queued.id)).status, "completed");
});

Deno.test("restore status capability is signed, actor-bound at issue, operation-bound, and read-only", async () => {
  const fx = await setup();
  const restore = operation(
    "restore",
    { filename: "safe.dgbackup", bytes: 1 },
    "status-capability",
  );
  Object.assign(restore, {
    status: "validated",
    stage: "preflight",
    archiveSha256: "a".repeat(64),
    validatedAt: new Date().toISOString(),
  });
  fx.store.items.set(restore.id, restore);
  await assertRejects(
    () => fx.service.issueRestoreStatusCapability(crypto.randomUUID(), restore.id),
    BackupServiceError,
  );
  const capability = await fx.service.issueRestoreStatusCapability(ACTOR, restore.id);
  assertEquals((await fx.service.restoreStatus(restore.id, capability.token)).status, "validated");
  assertEquals((await fx.store.get(restore.id)).version, restore.version);
  await assertRejects(
    () => fx.service.restoreStatus(crypto.randomUUID(), capability.token),
    BackupServiceError,
  );
  await assertRejects(
    () => fx.service.restoreStatus(restore.id, `${capability.token.slice(0, -1)}x`),
    BackupServiceError,
  );
  await fx.service.close();
});

Deno.test("export pump continues after one export fails", async () => {
  let snapshots = 0;
  const fx = await setup({
    exportSnapshot: () => {
      snapshots++;
      if (snapshots === 1) throw new Error("first snapshot failed");
      return Promise.resolve(fx.snapshot);
    },
  });
  const first = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "pump-first-failure",
  });
  const second = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "pump-second-success",
  });
  assertEquals((await completed(fx.store, first.id)).status, "failed");
  assertEquals((await completed(fx.store, second.id)).status, "completed");
  await fx.service.close();
});

Deno.test("recoverable artifact deletion failure does not consume or strand a queued export", async () => {
  const fx = await setup();
  const orphan = operation("export", { includeDiagnostics: false }, "cleanup-before-claim-orphan");
  const digest = "c".repeat(64);
  const key = `backups/exports/${orphan.id}/${crypto.randomUUID()}-${digest}.dgbackup`;
  Object.assign(orphan, {
    status: "failed",
    stage: "failed",
    completedAt: new Date().toISOString(),
    artifactObjectKey: key,
    archiveSha256: digest,
  });
  fx.store.items.set(orphan.id, orphan);
  await fx.objects.put({
    key,
    body: new Blob(["orphan"]).stream(),
    contentLength: 6,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: digest },
  });
  const originalDelete = fx.objects.delete.bind(fx.objects);
  let deleteAttempts = 0;
  fx.objects.delete = (objectKey) => {
    deleteAttempts++;
    if (deleteAttempts === 1) return Promise.reject(new Error("object store unavailable"));
    return originalDelete(objectKey);
  };

  const queued = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "cleanup-failure-queued-export",
  });
  assertEquals((await completed(fx.store, queued.id)).status, "completed");
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fx.store.get(orphan.id)).artifactCleanupCheckedAt !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(deleteAttempts >= 2, true);
  assertEquals((await fx.store.get(orphan.id)).artifactCleanupCheckedAt !== null, true);
  await fx.service.close();
});

Deno.test("transient lease-expiry lookup failure schedules recovery for queued exports", async () => {
  const fx = await setup();
  const running = operation("export", { includeDiagnostics: false }, "expired-owner-retry");
  Object.assign(running, {
    status: "running",
    stage: "starting",
    startedAt: new Date().toISOString(),
    exportLeaseToken: crypto.randomUUID(),
    exportLeaseExpiresAt: new Date(Date.now() + 40).toISOString(),
  });
  fx.store.items.set(running.id, running);
  fx.store.activeExport = running.id;
  const originalExpiry = fx.store.nextRunningExportLeaseExpiry.bind(fx.store);
  let expiryReads = 0;
  fx.store.nextRunningExportLeaseExpiry = () => {
    expiryReads++;
    if (expiryReads === 1) return Promise.reject(new Error("control plane unavailable"));
    return originalExpiry();
  };

  const queued = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "lease-query-retry-queued-export",
  });
  assertEquals((await completed(fx.store, queued.id)).status, "completed");
  assertEquals(expiryReads >= 1, true);
  assertEquals((await fx.store.get(running.id)).status, "failed");
  await fx.service.close();
});

Deno.test("enqueue racing an exiting pump is handed to a new durable drain", async () => {
  const fx = await setup();
  const original = fx.store.claimNextQueuedExport.bind(fx.store);
  let sawEmpty!: () => void;
  let release!: () => void;
  const empty = new Promise<void>((resolve) => sawEmpty = resolve);
  const gate = new Promise<void>((resolve) => release = resolve);
  let gateOnce = true;
  fx.store.claimNextQueuedExport = async (token, seconds) => {
    const claimed = await original(token, seconds);
    if (!claimed && gateOnce) {
      gateOnce = false;
      sawEmpty();
      await gate;
    }
    return claimed;
  };
  const first = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "pump-exit-race-first",
  });
  assertEquals((await completed(fx.store, first.id)).status, "completed");
  await empty;
  const second = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "pump-exit-race-second",
  });
  release();
  assertEquals((await completed(fx.store, second.id)).status, "completed");
  await fx.service.close();
});

Deno.test("export queue admits one snapshot across replicas and drains durable queued work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const sharedSnapshot: { value?: BackupExportSnapshot } = {};
  const first = await setup({
    exportSnapshot: async () => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      if (calls === 1) await gate;
      active--;
      return sharedSnapshot.value!;
    },
  });
  sharedSnapshot.value = first.snapshot;
  const second = new DefaultBackupAdminService({
    store: first.store,
    objects: first.objects,
    data: {
      exportSnapshot: () => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        active--;
        return Promise.resolve(sharedSnapshot.value!);
      },
      restoreSession: () => Promise.reject(new Error("not used")),
    },
    authenticator: first.auth,
  });
  const a = await first.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "bounded-export-one",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await first.store.get(a.id)).status === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const b = await second.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "bounded-export-two",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals((await first.store.get(b.id)).status, "queued");
  assertEquals(calls, 1);
  release();
  assertEquals((await completed(first.store, a.id)).status, "completed");
  assertEquals((await completed(first.store, b.id)).status, "completed");
  assertEquals(maximum, 1);
  await first.service.close();
  await second.close();
});

Deno.test("graceful close aborts an export and is bounded when snapshot work stalls", async () => {
  const never = new Promise<BackupExportSnapshot>(() => {});
  const fx = await setup({
    exportSnapshot: () => never,
    serviceOptions: { exportDeadlineMs: 60_000, shutdownGraceMs: 25 },
  });
  const queued = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "shutdown-export-one",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fx.store.get(queued.id)).status === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const started = performance.now();
  await fx.service.close();
  assertEquals(performance.now() - started < 500, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fx.store.get(queued.id)).status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals((await fx.store.get(queued.id)).status, "failed");
});

Deno.test("startup recovery returns promptly while durable export readiness is slow", async () => {
  const fx = await setup();
  await fx.service.close();
  fx.store.claimNextQueuedExport = () => new Promise<BackupOperation | undefined>(() => {});
  const service = new DefaultBackupAdminService({
    store: fx.store,
    objects: fx.objects,
    data: fx.data,
    authenticator: fx.auth,
    shutdownGraceMs: 20,
  });
  const started = performance.now();
  await service.recoverPending();
  assertEquals(performance.now() - started < 500, true);
  await service.close();
});

Deno.test("running export cancellation releases its installation lease", async () => {
  const fx = await setup();
  await fx.service.close();
  const queued = operation("export", { includeDiagnostics: false }, "cancel-running-export");
  fx.store.items.set(queued.id, queued);
  const running = await fx.store.claimExport(queued.id, queued.version, crypto.randomUUID(), 60);
  const cancelled = await fx.store.cancel(running.id, running.version);
  assertEquals(cancelled.status, "cancelled");
  assertEquals(cancelled.exportLeaseToken, null);
  assertEquals(cancelled.exportLeaseExpiresAt, null);
});

Deno.test("lease loss cancels and removes an object published by a delayed put", async () => {
  const fx = await setup();
  await fx.service.close();
  const objects = new DelayedPutObjects();
  const service = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
    exportLeaseSeconds: 0.01,
    exportDeadlineMs: 60_000,
    shutdownGraceMs: 20,
  });
  const queued = operation("export", { includeDiagnostics: false }, "late-put-lease-loss");
  fx.store.items.set(queued.id, queued);
  const work = service.processExport(queued.id);
  const settled = work.catch((error) => error);
  await objects.started;
  fx.store.failRenewExport = true;
  for (let attempt = 0; attempt < 150 && !objects.signal?.aborted; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assertEquals(objects.signal?.aborted, true);
  assertEquals((await settled) instanceof BackupServiceError, true);
  assertEquals((await fx.store.get(queued.id)).status, "failed");
  fx.store.get = () => Promise.reject(new Error("control plane is closed"));
  const closing = performance.now();
  await service.close();
  assertEquals(performance.now() - closing < 500, true);
  objects.release();
  for (let attempt = 0; attempt < 100 && objects.values.size; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(objects.values.size, 0);
});

Deno.test("failed export finalization removes only its lease-scoped archive", async () => {
  const fx = await setup();
  fx.store.failCompleteExport = true;
  const queued = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "export-finalize-failure",
  });
  assertEquals((await completed(fx.store, queued.id)).status, "failed");
  await fx.service.close();
  assertEquals(fx.objects.values.size, 0);
});

Deno.test("ambiguous export finalization preserves the durably attached immutable archive", async () => {
  const fx = await setup();
  fx.store.throwAfterCompleteExport = true;
  const queued = await fx.service.requestExport({
    actorId: ACTOR,
    includeDiagnostics: false,
    idempotencyKey: "export-finalize-response-lost",
  });
  const durable = await completed(fx.store, queued.id);
  assertEquals(durable.status, "completed");
  await fx.service.close();
  assertEquals(fx.objects.values.has(durable.artifactObjectKey!), true);
  assertEquals((await fx.service.exportContent(ACTOR, queued.id)).status, 200);
});

Deno.test("startup recovery removes a crash-durable orphan plan but preserves completed owners", async () => {
  const fx = await setup();
  await fx.service.close();
  const orphan = operation("export", { includeDiagnostics: false }, "crashed-export-artifact");
  const orphanKey = `backups/exports/${orphan.id}/${crypto.randomUUID()}-${
    "a".repeat(64)
  }.dgbackup`;
  Object.assign(orphan, {
    status: "failed",
    stage: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: "The backup operation timed out",
    artifactObjectKey: orphanKey,
    archiveSha256: "a".repeat(64),
  });
  fx.store.items.set(orphan.id, orphan);
  await fx.objects.put({
    key: orphanKey,
    body: new Blob(["orphan"]).stream(),
    contentLength: 6,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: "a".repeat(64) },
  });
  const owned = operation("export", { includeDiagnostics: false }, "completed-export-artifact");
  const ownedKey = `backups/exports/${owned.id}/${crypto.randomUUID()}-${"b".repeat(64)}.dgbackup`;
  Object.assign(owned, {
    status: "completed",
    stage: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    artifactObjectKey: ownedKey,
    archiveSha256: "b".repeat(64),
  });
  fx.store.items.set(owned.id, owned);
  await fx.objects.put({
    key: ownedKey,
    body: new Blob(["owned"]).stream(),
    contentLength: 5,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: "b".repeat(64) },
  });
  const service = new DefaultBackupAdminService({
    store: fx.store,
    objects: fx.objects,
    data: fx.data,
    authenticator: fx.auth,
    artifactSweepIntervalMs: 100,
    shutdownGraceMs: 20,
  });
  await service.recoverPending();
  assertEquals(fx.objects.values.has(orphanKey), false);
  assertEquals((await fx.store.get(orphan.id)).artifactObjectKey, orphanKey);
  assertEquals((await fx.store.get(orphan.id)).artifactCleanupCheckedAt !== null, true);
  assertEquals(fx.objects.values.has(ownedKey), true);
  assertEquals((await fx.store.get(owned.id)).artifactObjectKey, ownedKey);
  await service.close();
});

Deno.test("startup before lease expiry preserves a live replica then reaps its crashed artifact", async () => {
  const fx = await setup();
  await fx.service.close();
  const crashed = operation("export", { includeDiagnostics: false }, "future-expiry-crash");
  const lease = crypto.randomUUID();
  const digest = "e".repeat(64);
  const key = `backups/exports/${crashed.id}/${lease}-${digest}.dgbackup`;
  Object.assign(crashed, {
    status: "running",
    stage: "uploading",
    startedAt: new Date().toISOString(),
    exportLeaseToken: lease,
    exportLeaseExpiresAt: new Date(Date.now() + 100).toISOString(),
    artifactObjectKey: key,
    archiveSha256: digest,
  });
  fx.store.items.set(crashed.id, crashed);
  fx.store.activeExport = crashed.id;
  await fx.objects.put({
    key,
    body: new Blob(["crashed"]).stream(),
    contentLength: 7,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: digest },
  });
  const service = new DefaultBackupAdminService({
    store: fx.store,
    objects: fx.objects,
    data: fx.data,
    authenticator: fx.auth,
    artifactSweepIntervalMs: 100,
  });
  await service.recoverPending();
  assertEquals((await fx.store.get(crashed.id)).status, "running");
  assertEquals(fx.objects.values.has(key), true);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fx.store.get(crashed.id)).status === "failed" && !fx.objects.values.has(key)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assertEquals((await fx.store.get(crashed.id)).status, "failed");
  assertEquals((await fx.store.get(crashed.id)).artifactObjectKey, key);
  assertEquals(fx.objects.values.has(key), false);
  await service.close();
});

Deno.test("durable export tombstone reaps a late PUT after the stale worker crashes", async () => {
  const fx = await setup();
  await fx.service.close();
  const objects = new DelayedPutObjects();
  const abandoned = operation("export", { includeDiagnostics: false }, "late-put-old-crash");
  const digest = "9".repeat(64);
  const lease = crypto.randomUUID();
  const key = `backups/exports/${abandoned.id}/${lease}-${digest}.dgbackup`;
  Object.assign(abandoned, {
    status: "failed",
    stage: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: "The backup operation timed out",
    artifactObjectKey: key,
    archiveSha256: digest,
  });
  fx.store.items.set(abandoned.id, abandoned);

  // Model an old replica whose SDK ignores cancellation: its request is already in flight while a
  // replacement replica sees no object, performs cleanup, and then exits.
  const stalePut = objects.put({
    key,
    body: new Blob(["published too late"]).stream(),
    contentLength: 18,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: digest },
  });
  await objects.started;
  const firstRecovery = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
    artifactSweepIntervalMs: 100,
  });
  await firstRecovery.recoverPending();
  const tombstone = await fx.store.get(abandoned.id);
  assertEquals(tombstone.artifactObjectKey, key);
  assertEquals(tombstone.archiveSha256, digest);
  assertEquals(tombstone.artifactCleanupCheckedAt !== null, true);

  // The stale worker publishes after cleanup and then crashes before doing any local finally work.
  objects.release();
  await stalePut;
  assertEquals(objects.values.has(key), true);

  // The replacement replica's bounded recurring sweep catches publication without a hot loop.
  for (let attempt = 0; attempt < 30 && objects.values.has(key); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assertEquals(objects.values.has(key), false);
  await firstRecovery.close();

  // Even after that replica exits, a later publication remains recoverable after another restart.
  await MemoryObjects.prototype.put.call(objects, {
    key,
    body: new Blob(["published after shutdown"]).stream(),
    contentLength: 24,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: digest },
  });
  abandoned.artifactCleanupCheckedAt = new Date(Date.now() - 60_000).toISOString();
  const secondRecovery = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
  });
  await secondRecovery.recoverPending();
  assertEquals(objects.values.has(key), false);
  assertEquals((await fx.store.get(abandoned.id)).artifactObjectKey, key);
  await secondRecovery.close();
});

Deno.test("artifact cleanup leases exclude replicas and expired crash claims are reclaimed", async () => {
  const fx = await setup();
  await fx.service.close();
  const objects = new CountingObjects();
  const abandoned = operation("export", { includeDiagnostics: false }, "cleanup-lease-race");
  const digest = "8".repeat(64);
  const key = `backups/exports/${abandoned.id}/${crypto.randomUUID()}-${digest}.dgbackup`;
  Object.assign(abandoned, {
    status: "failed",
    stage: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: "The backup operation timed out",
    artifactObjectKey: key,
    archiveSha256: digest,
  });
  fx.store.items.set(abandoned.id, abandoned);
  await objects.put({
    key,
    body: new Blob(["orphan"]).stream(),
    contentLength: 6,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: digest },
  });
  const replicaA = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
  });
  const replicaB = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
  });
  await Promise.all([replicaA.recoverPending(), replicaB.recoverPending()]);
  assertEquals(objects.deletes.get(key), 1);
  assertEquals(objects.gets.get(key), 1);

  // Model a claimant crashing before object I/O. A live lease excludes both replicas; after its
  // durable expiry exactly one replacement can claim and clean the republished orphan.
  await objects.put({
    key,
    body: new Blob(["late orphan"]).stream(),
    contentLength: 11,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: digest },
  });
  abandoned.artifactCleanupLeaseToken = crypto.randomUUID();
  abandoned.artifactCleanupLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  await Promise.all([replicaA.recoverPending(), replicaB.recoverPending()]);
  assertEquals(objects.values.has(key), true);
  abandoned.artifactCleanupLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  abandoned.artifactCleanupCheckedAt = new Date(Date.now() - 60_000).toISOString();
  await Promise.all([replicaA.recoverPending(), replicaB.recoverPending()]);
  assertEquals(objects.values.has(key), false);
  assertEquals(objects.deletes.get(key), 2);
  assertEquals(objects.gets.get(key), 2);
  await Promise.all([replicaA.close(), replicaB.close()]);
});

Deno.test("cleanup page failure releases current and unprocessed row leases immediately", async () => {
  const fx = await setup();
  await fx.service.close();
  fx.store.claimNextQueuedExport = () => new Promise<BackupOperation | undefined>(() => {});
  const releases: string[] = [];
  const releaseCleanup = fx.store.releaseExportArtifactCleanup.bind(fx.store);
  fx.store.releaseExportArtifactCleanup = (id, token) => {
    releases.push(id);
    return releaseCleanup(id, token);
  };
  const objects = new FlakyCleanupObjects();
  const rows = ["6", "7"].map((digit, index) => {
    const item = operation("export", { includeDiagnostics: false }, `cleanup-page-${index}`);
    const digest = digit.repeat(64);
    Object.assign(item, {
      status: "failed",
      stage: "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: "The backup operation timed out",
      artifactObjectKey: `backups/exports/${item.id}/${crypto.randomUUID()}-${digest}.dgbackup`,
      archiveSha256: digest,
    });
    fx.store.items.set(item.id, item);
    return item;
  });
  const service = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
    artifactSweepIntervalMs: 100,
    shutdownGraceMs: 20,
  });
  await service.recoverPending();
  assertEquals([...new Set(releases)].sort(), rows.map((row) => row.id).sort());
  await service.recoverPending();
  assertEquals(
    await Promise.all(
      rows.map(async (row) => (await fx.store.get(row.id)).artifactCleanupCheckedAt !== null),
    ),
    [true, true],
  );
  await service.close();
});

Deno.test("startup isolates S3 tombstone failure and schedules a retry", async () => {
  const fx = await setup();
  await fx.service.close();
  const objects = new FlakyCleanupObjects();
  const item = operation("export", { includeDiagnostics: false }, "startup-s3-retry");
  const digest = "5".repeat(64);
  const key = `backups/exports/${item.id}/${crypto.randomUUID()}-${digest}.dgbackup`;
  Object.assign(item, {
    status: "failed",
    stage: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: "The backup operation timed out",
    artifactObjectKey: key,
    archiveSha256: digest,
  });
  fx.store.items.set(item.id, item);
  await objects.put({
    key,
    body: new Blob(["orphan"]).stream(),
    contentLength: 6,
    contentType: "application/vnd.dg-chat.backup",
    metadata: { sha256: digest },
  });
  const service = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
    artifactSweepIntervalMs: 100,
  });
  await service.recoverPending();
  for (let attempt = 0; attempt < 30 && objects.values.has(key); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assertEquals(objects.values.has(key), false);
  await service.close();
});

Deno.test("close aborts and releases a timer-fired cleanup without post-close lookups", async () => {
  const fx = await setup();
  await fx.service.close();
  const objects = new GatedDeleteObjects();
  const service = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
    artifactSweepIntervalMs: 100,
    shutdownGraceMs: 100,
  });
  await service.recoverPending();
  const item = operation("export", { includeDiagnostics: false }, "close-cleanup-race");
  const digest = "4".repeat(64);
  Object.assign(item, {
    status: "failed",
    stage: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: "The backup operation timed out",
    artifactObjectKey: `backups/exports/${item.id}/${crypto.randomUUID()}-${digest}.dgbackup`,
    archiveSha256: digest,
  });
  fx.store.items.set(item.id, item);
  await objects.started;
  const started = performance.now();
  await service.close();
  assertEquals(performance.now() - started < 500, true);
  assertEquals(item.artifactCleanupLeaseToken, null);
  objects.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(objects.gets.get(item.artifactObjectKey!), undefined);
});

Deno.test("close awaits a late durable claim and releases ownership before object I/O", async () => {
  const fx = await setup();
  await fx.service.close();
  const objects = new CountingObjects();
  const service = new DefaultBackupAdminService({
    store: fx.store,
    objects,
    data: fx.data,
    authenticator: fx.auth,
    artifactSweepIntervalMs: 100,
    shutdownGraceMs: 100,
  });
  await service.recoverPending();
  const item = operation("export", { includeDiagnostics: false }, "late-cleanup-claim-close");
  const digest = "3".repeat(64);
  Object.assign(item, {
    status: "failed",
    stage: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: "The backup operation timed out",
    artifactObjectKey: `backups/exports/${item.id}/${crypto.randomUUID()}-${digest}.dgbackup`,
    archiveSha256: digest,
  });
  fx.store.items.set(item.id, item);
  const originalClaim = fx.store.claimRecoverableExportArtifacts.bind(fx.store);
  let claimStarted!: () => void;
  let releaseClaim!: () => void;
  const started = new Promise<void>((resolve) => claimStarted = resolve);
  const gate = new Promise<void>((resolve) => releaseClaim = resolve);
  fx.store.claimRecoverableExportArtifacts = async (...args) => {
    claimStarted();
    await gate;
    return await originalClaim(...args);
  };
  await started;
  const closing = service.close();
  setTimeout(releaseClaim, 10);
  await closing;
  const durable = await fx.store.get(item.id);
  assertEquals(durable.artifactCleanupLeaseToken, null);
  assertEquals(objects.deletes.get(item.artifactObjectKey!), undefined);
  assertEquals(objects.gets.get(item.artifactObjectKey!), undefined);
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
  assertEquals(fx.sessions.some((session) => session.mode === "cleanup"), false);
});

Deno.test("lost database commit response preserves the fence and recovery finalizes durable state", async () => {
  const fx = await setup({ throwAfterRestoreCommit: true });
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "restore-commit-response-lost",
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
  assertEquals((await fx.store.get(uploaded.id)).stage, "database_restored");
  assertEquals(fx.store.maintenance, true);
  assertEquals(fx.store.failRestoreCalls, 0);
  assertEquals(fx.sessions.at(-1)?.rolledBack, false);

  fx.store.failFinish = false;
  await fx.service.recoverPending();
  assertEquals((await fx.store.get(uploaded.id)).status, "completed");
  assertEquals(fx.store.maintenance, false);
  assertEquals(fx.sessions.some((session) => session.mode === "cleanup"), false);
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
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "active-restore",
  });
  await fx.service.previewRestore(ACTOR, uploaded.id);
  const active = fx.store.items.get(uploaded.id)!;
  Object.assign(active, {
    status: "running",
    stage: "restore_staging",
    startedAt: new Date().toISOString(),
  });
  fx.store.maintenance = true;
  fx.store.active = active.id;
  fx.store.installVersion = 7;
  for (let index = 0; index < 150; index++) {
    const terminal = operation("export", {}, `newer-terminal-${index}`);
    Object.assign(terminal, {
      status: "completed",
      stage: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      archiveSha256: "f".repeat(64),
    });
    fx.store.items.set(terminal.id, terminal);
  }
  await fx.service.recoverPending();
  assertEquals((await fx.store.get(active.id)).status, "failed");
  assertEquals(fx.store.maintenance, false);
  assertEquals(fx.store.failRestoreCalls, 1);
  assertEquals(fx.sessions.at(-1), {
    mode: "cleanup",
    operationId: active.id,
    rolledBack: true,
    cleaned: true,
  });
});

Deno.test("export recovery claims durable queued work hidden behind terminal history", async () => {
  const fx = await setup();
  const queued = operation("export", { includeDiagnostics: false }, "old-queued-export");
  fx.store.items.set(queued.id, queued);
  for (let index = 0; index < 150; index++) {
    const terminal = operation("export", {}, `newer-export-${index}`);
    Object.assign(terminal, {
      status: "completed",
      stage: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      archiveSha256: "e".repeat(64),
    });
    fx.store.items.set(terminal.id, terminal);
  }
  await fx.service.recoverPending();
  assertEquals((await completed(fx.store, queued.id)).status, "completed");
});

Deno.test("recovery terminalizes every abandoned restore beyond one bounded batch", async () => {
  const fx = await setup();
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  for (let index = 0; index < 105; index++) {
    const uploaded = await fx.service.uploadRestore({
      actorId: ACTOR,
      request: uploadRequest(archive),
      idempotencyKey: `abandoned-restore-${index}`,
    });
    const restore = fx.store.items.get(uploaded.id)!;
    Object.assign(restore, {
      status: "running",
      stage: "restore_staging",
      startedAt: new Date().toISOString(),
    });
  }
  await fx.service.recoverPending();
  assertEquals(
    [...fx.store.items.values()].filter((item) =>
      item.kind === "restore" && item.status === "running"
    ).length,
    0,
  );
});

Deno.test("recovery preserves a non-authoritative database-restored operation for operators", async () => {
  const fx = await setup();
  const committed = operation("restore", {}, "ambiguous-database-restored");
  Object.assign(committed, {
    status: "running",
    stage: "database_restored",
    startedAt: new Date().toISOString(),
    sourceObjectKey: "backups/restores/ambiguous.dgbackup",
    archiveSha256: "c".repeat(64),
  });
  fx.store.items.set(committed.id, committed);
  await fx.service.recoverPending();
  assertEquals((await fx.store.get(committed.id)).status, "running");
  assertEquals(fx.sessions.length, 0);
});

Deno.test("startup terminalizes preflight restore with a missing source without replay cleanup", async () => {
  const fx = await setup();
  const restore = operation(
    "restore",
    { filename: "missing.dgbackup", bytes: 10 },
    "missing-source-preflight",
  );
  Object.assign(restore, {
    status: "running",
    stage: "preflight",
    startedAt: new Date().toISOString(),
    sourceObjectKey: "backups/restores/missing.dgbackup",
    archiveSha256: "f".repeat(64),
  });
  fx.store.items.set(restore.id, restore);
  await fx.service.recoverPending();
  assertEquals((await fx.store.get(restore.id)).status, "failed");
  assertEquals(fx.sessions.some((session) => session.operationId === restore.id), false);
  await fx.service.close();
});

Deno.test("recovery preserves the maintenance fence when exact staged cleanup fails", async () => {
  const fx = await setup({ failCleanup: true });
  const archive = await writeBackupArchive(fx.manifest, fx.snapshot.payloads, fx.auth);
  const uploaded = await fx.service.uploadRestore({
    actorId: ACTOR,
    request: uploadRequest(archive),
    idempotencyKey: "active-cleanup-failure",
  });
  await fx.service.previewRestore(ACTOR, uploaded.id);
  const active = fx.store.items.get(uploaded.id)!;
  Object.assign(active, {
    status: "running",
    stage: "restore_staging",
    startedAt: new Date().toISOString(),
  });
  fx.store.maintenance = true;
  fx.store.active = active.id;
  fx.store.installVersion = 7;
  await assertRejects(() => fx.service.recoverPending(), Error, "cleanup unavailable");
  assertEquals((await fx.store.get(active.id)).status, "running");
  assertEquals(fx.store.maintenance, true);
  assertEquals(fx.store.active, active.id);
  assertEquals(fx.store.failRestoreCalls, 0);
});
