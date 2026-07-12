import { Busboy } from "@fastify/busboy";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type {
  BackupArchiveSink,
  BackupManifestAuthenticator,
  BackupManifestV1,
  BackupOperation,
  ObjectStore,
  PostgresBackupStore,
} from "@dg-chat/database";
import { parseBackupArchiveStream, sha256Hex, writeBackupArchiveStream } from "@dg-chat/database";
import { BackupOperationError } from "@dg-chat/database";
import type {
  BackupAdminService,
  BackupExportSummary,
  BackupRestoreCount,
  BackupRestorePreview,
  BackupRestoreResult,
  BackupRestoreStatus,
  BackupRestoreStatusCapability,
  BackupRestoreUploadSummary,
} from "./backup-admin.ts";

const BACKUP_MIME = "application/vnd.dg-chat.backup";
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024;
const encoder = new TextEncoder();

type BackupStorePort = Pick<
  PostgresBackupStore,
  | "installationState"
  | "create"
  | "get"
  | "findByIdempotency"
  | "list"
  | "claim"
  | "claimExport"
  | "claimNextQueuedExport"
  | "listRecoverableRestores"
  | "renewExportLease"
  | "expireExportLeases"
  | "planExportArtifact"
  | "claimRecoverableExportArtifacts"
  | "recordExportArtifactCleanup"
  | "releaseExportArtifactCleanup"
  | "nextRunningExportLeaseExpiry"
  | "updateProgress"
  | "validateRestore"
  | "beginRestoreApply"
  | "beginRestoreMaintenance"
  | "finishRestore"
  | "failRestore"
  | "complete"
  | "fail"
  | "close"
>;

export interface BackupExportSnapshot {
  manifest: BackupManifestV1;
  payloads: ReadonlyMap<string, Uint8Array | AsyncIterable<Uint8Array>>;
  objectsTotal: number;
  bytesTotal: number;
  cleanup?(): Promise<void>;
}
export interface BackupRestoreSession {
  sink: BackupArchiveSink;
  summarize(manifest: BackupManifestV1): Promise<{
    counts: BackupRestoreCount[];
    warnings: string[];
    blockingErrors: string[];
    attachmentsMissing: number;
  }>;
  commit?(
    manifest: BackupManifestV1,
    context: {
      restoreOperationId: string;
      expectedOperationVersion: number;
      expectedInstallationVersion: number;
    },
  ): Promise<BackupRestoreCommit>;
  cleanup?(manifest: BackupManifestV1): Promise<void>;
  rollback(): Promise<void>;
}
export interface BackupRestoreCommit {
  counts: BackupRestoreCount[];
  restoreOperationVersion: number;
  installationVersion: number;
}
export interface BackupDataPort {
  exportSnapshot(
    input: { includeDiagnostics: boolean; installationId: string; signal?: AbortSignal },
  ): Promise<BackupExportSnapshot>;
  restoreSession(
    mode: "preview" | "apply" | "cleanup",
    context: { restoreOperationId: string },
  ): Promise<BackupRestoreSession>;
}
export class BackupServiceError extends Error {
  constructor(
    readonly code: "invalid_upload" | "not_found" | "forbidden" | "conflict" | "restore_disabled",
    message: string,
  ) {
    super(message);
    this.name = "BackupServiceError";
  }
}

export interface BackupServiceOptions {
  store: BackupStorePort;
  objects: ObjectStore;
  data: BackupDataPort;
  authenticator: BackupManifestAuthenticator;
  restoreEnabled?: boolean;
  maxUploadBytes?: number;
  exportLeaseSeconds?: number;
  exportDeadlineMs?: number;
  shutdownGraceMs?: number;
  artifactSweepIntervalMs?: number;
  artifactCleanupLeaseSeconds?: number;
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Backup export was interrupted");
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw aborted(signal);
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(aborted(signal)), { once: true })
    ),
  ]);
}

function exportSummary(operation: BackupOperation): BackupExportSummary {
  return {
    id: operation.id,
    status: operation.status === "validated" || operation.status === "cancelled"
      ? "failed"
      : operation.status,
    formatVersion: Number(operation.manifest?.version ?? 1),
    includesDiagnostics: operation.options.includeDiagnostics === true,
    secretsRedacted: true,
    bytes: operation.status === "completed" ? operation.bytesTotal : null,
    fingerprint: operation.archiveSha256,
    createdAt: operation.createdAt,
    completedAt: operation.completedAt,
    error: operation.error,
  };
}
function safeFilename(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) &&
    value.toLowerCase().endsWith(".dgbackup");
}
const statusCapabilityEncoder = new TextEncoder();
const statusCapabilityId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statusCapabilityPart = /^[A-Za-z0-9_-]{1,2048}$/;
const encodeCapabilityPart = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const decodeCapabilityPart = (value: string) => {
  if (!statusCapabilityPart.test(value)) {
    throw new BackupServiceError("not_found", "Restore status is unavailable");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (encodeCapabilityPart(bytes) !== value) {
    throw new BackupServiceError("not_found", "Restore status is unavailable");
  }
  return bytes;
};
async function* webChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function fileStream(path: string) {
  const file = await Deno.open(path, { read: true });
  return file.readable;
}

async function stageMultipart(request: Request, maxBytes: number) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new BackupServiceError("invalid_upload", "A backup file upload is required");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes + 128 * 1024) {
    throw new BackupServiceError("invalid_upload", "The backup upload exceeds the size limit");
  }
  if (!request.body) {
    throw new BackupServiceError("invalid_upload", "A backup file upload is required");
  }
  let result:
    | Promise<{ path: string; filename: string; bytes: number; digest: string }>
    | undefined;
  let failure: unknown;
  let busboy;
  try {
    busboy = Busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 1,
        fields: 0,
        parts: 1,
        fileSize: maxBytes,
        headerPairs: 12,
        headerSize: 4096,
      },
    });
  } catch {
    throw new BackupServiceError("invalid_upload", "The backup upload is malformed");
  }
  busboy.on("file", (field, input, filename, _encoding, mime) => {
    if (
      result || field !== "file" || !safeFilename(filename) ||
      ![BACKUP_MIME, "application/octet-stream"].includes(mime.toLowerCase())
    ) {
      failure ??= new BackupServiceError("invalid_upload", "The backup file is invalid");
      input.resume();
      return;
    }
    result = (async () => {
      const path = await Deno.makeTempFile({ prefix: "dg-restore-", suffix: ".dgbackup" });
      const digest = createHash("sha256");
      let bytes = 0;
      const output = await Deno.open(path, { write: true, truncate: true });
      try {
        for await (const chunk of input as Readable) {
          const data = new Uint8Array(chunk);
          bytes += data.length;
          if (bytes > maxBytes) {
            throw new BackupServiceError(
              "invalid_upload",
              "The backup upload exceeds the size limit",
            );
          }
          digest.update(data);
          let offset = 0;
          while (offset < data.length) offset += await output.write(data.subarray(offset));
        }
        if (input.truncated || bytes === 0) {
          throw new BackupServiceError("invalid_upload", "The backup upload is incomplete");
        }
        return { path, filename, bytes, digest: digest.digest("hex") };
      } catch (error) {
        await Deno.remove(path).catch(() => undefined);
        throw error;
      } finally {
        output.close();
      }
    })();
    void result.catch((error) => failure ??= error);
  });
  busboy.on(
    "field",
    () => failure ??= new BackupServiceError("invalid_upload", "Unexpected backup form field"),
  );
  for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const) {
    busboy.on(
      event,
      () => failure ??= new BackupServiceError("invalid_upload", "The backup upload is malformed"),
    );
  }
  const finished = new Promise<void>((resolve, reject) => {
    busboy.once("finish", resolve);
    busboy.on("error", reject);
  });
  const reader = request.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!busboy.write(next.value)) {
        await new Promise<void>((resolve) => busboy.once("drain", resolve));
      }
    }
    busboy.end();
    await finished;
  } catch {
    try {
      busboy.destroy();
    } catch { /* sanitized below */ }
    failure ??= new BackupServiceError("invalid_upload", "The backup upload is malformed");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let staged;
  try {
    staged = result && await result;
  } catch (error) {
    failure ??= error;
  }
  if (failure || !staged) {
    if (staged) await Deno.remove(staged.path).catch(() => undefined);
    throw failure instanceof BackupServiceError
      ? failure
      : new BackupServiceError("invalid_upload", "The backup upload is malformed");
  }
  return staged;
}

export class DefaultBackupAdminService implements BackupAdminService {
  readonly restoreEnabled: boolean;
  readonly #store;
  readonly #objects;
  readonly #data;
  readonly #authenticator;
  readonly #maxUploadBytes;
  readonly #exportLeaseSeconds;
  readonly #exportDeadlineMs;
  readonly #shutdownGraceMs;
  readonly #artifactSweepIntervalMs;
  readonly #artifactCleanupLeaseSeconds;
  readonly #artifactClaimTimeoutMs;
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #artifactCleanups = new Set<Promise<void>>();
  readonly #exportControllers = new Map<string, AbortController>();
  #exportPump: Promise<void> | undefined;
  #exportWake: ReturnType<typeof setTimeout> | undefined;
  #artifactSweep: ReturnType<typeof setTimeout> | undefined;
  #artifactSweepWork: Promise<void> | undefined;
  #artifactSweepController: AbortController | undefined;
  #exportGeneration = 0;
  #closing = false;
  constructor(options: BackupServiceOptions) {
    this.#store = options.store;
    this.#objects = options.objects;
    this.#data = options.data;
    this.#authenticator = options.authenticator;
    this.restoreEnabled = options.restoreEnabled === true;
    this.#maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
    this.#exportLeaseSeconds = options.exportLeaseSeconds ?? 60;
    this.#exportDeadlineMs = options.exportDeadlineMs ?? 30 * 60_000;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    this.#artifactClaimTimeoutMs = Math.max(1, Math.min(4_000, this.#shutdownGraceMs - 1));
    // Cleanup is intentionally recurring because a cancellation-ignoring PUT may publish after an
    // earlier absence check. Clamp caller configuration so tests can run promptly without allowing
    // production misconfiguration to cause a hot loop or effectively disable recovery.
    const configuredSweepInterval = options.artifactSweepIntervalMs ?? 60_000;
    this.#artifactSweepIntervalMs = Number.isFinite(configuredSweepInterval)
      ? Math.max(100, Math.min(60 * 60_000, Math.trunc(configuredSweepInterval)))
      : 60_000;
    const configuredCleanupLease = options.artifactCleanupLeaseSeconds ?? 300;
    this.#artifactCleanupLeaseSeconds = Number.isFinite(configuredCleanupLease)
      ? Math.max(1, Math.min(3_600, Math.trunc(configuredCleanupLease)))
      : 300;
  }
  async listExports(_actorId: string) {
    return (await this.#store.list("export", 100)).map(exportSummary);
  }
  async requestExport(
    input: { actorId: string; includeDiagnostics: boolean; idempotencyKey: string },
  ) {
    const operation = await this.#store.create({
      kind: "export",
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      options: { includeDiagnostics: input.includeDiagnostics },
    });
    if (operation.status === "queued") {
      this.#exportGeneration++;
      this.#scheduleExportPump();
    }
    return exportSummary(operation);
  }
  #scheduleExportPump() {
    if (this.#closing || this.#exportPump) return;
    const generation = this.#exportGeneration;
    const task = this.#drainExports().catch(() => undefined).finally(() => {
      this.#tasks.delete("export-pump");
      this.#exportPump = undefined;
      // An enqueue that observed the old pump while it was exiting must hand off to a new pump.
      if (!this.#closing && this.#exportGeneration !== generation) this.#scheduleExportPump();
    });
    this.#exportPump = task;
    this.#tasks.set("export-pump", task);
  }
  async #drainExports() {
    while (!this.#closing) {
      let cleanupFailed = false;
      try {
        // Cleanup is attempted before a new lease is acquired so an object-store outage cannot
        // turn a freshly claimed operation into an owner that never executes. Cleanup remains
        // isolated from queue admission: abandoned artifacts are retryable housekeeping and must
        // not prevent otherwise healthy exports from making progress.
        await this.#cleanupRecoverableExportArtifacts();
      } catch {
        cleanupFailed = true;
      }
      const leaseToken = crypto.randomUUID();
      let claimed: BackupOperation | undefined;
      try {
        claimed = await this.#store.claimNextQueuedExport(
          leaseToken,
          this.#exportLeaseSeconds,
        );
      } catch {
        // Storage/control-plane outages must not strand later durable work or create a tight loop.
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      // No row means either no work or another replica owns the installation lease. That owner
      // drains again after completion; avoid local polling and duplicate snapshot work.
      if (!claimed) {
        if (cleanupFailed) this.#scheduleExportWakeIn(100);
        else await this.#scheduleExportLeaseWake();
        return;
      }
      try {
        await this.#runClaimedExport(claimed, leaseToken);
      } catch {
        // The operation terminalizes itself. Continue so one bad export cannot strand the queue.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  #scheduleExportWakeIn(delayMs: number) {
    if (this.#closing || this.#exportWake !== undefined) return;
    const delay = Math.max(10, Math.min(30_000, delayMs));
    this.#exportWake = setTimeout(() => {
      this.#exportWake = undefined;
      this.#scheduleExportPump();
    }, delay);
  }
  async #scheduleExportLeaseWake() {
    if (this.#closing || this.#exportWake !== undefined) return;
    let expiry: string | null;
    try {
      expiry = await this.#store.nextRunningExportLeaseExpiry();
    } catch {
      // A transient control-plane read must not strand queued work behind another replica's
      // running lease. Retry at a bounded cadence; the next claim atomically reaps expiry.
      this.#scheduleExportWakeIn(100);
      return;
    }
    if (!expiry) return;
    const delay = Math.max(10, Math.min(2_147_483_647, Date.parse(expiry) - Date.now() + 25));
    this.#scheduleExportWakeIn(delay);
  }
  async processExport(operationId: string): Promise<BackupExportSummary> {
    let operation = await this.#store.get(operationId);
    if (operation.kind !== "export") {
      throw new BackupServiceError("conflict", "The backup export is invalid");
    }
    if (operation.status !== "queued") return exportSummary(operation);
    const leaseToken = crypto.randomUUID();
    try {
      operation = await this.#store.claimExport(
        operation.id,
        operation.version,
        leaseToken,
        this.#exportLeaseSeconds,
      );
    } catch (error) {
      if (error instanceof BackupOperationError && error.code === "conflict") {
        return exportSummary(await this.#store.get(operation.id));
      }
      throw error;
    }
    return await this.#runClaimedExport(operation, leaseToken);
  }
  async #runClaimedExport(
    initialOperation: BackupOperation,
    leaseToken: string,
  ): Promise<BackupExportSummary> {
    let operation = initialOperation;
    const controller = new AbortController();
    this.#exportControllers.set(operation.id, controller);
    if (this.#closing) controller.abort(new Error("Backup service is shutting down"));
    const deadline = setTimeout(
      () => controller.abort(new Error("Backup export exceeded its execution deadline")),
      this.#exportDeadlineMs,
    );
    const heartbeat = setInterval(() => {
      void this.#store.renewExportLease(
        operation.id,
        leaseToken,
        this.#exportLeaseSeconds,
      ).catch((error) => controller.abort(error));
    }, Math.max(1_000, Math.floor(this.#exportLeaseSeconds * 1_000 / 3)));
    let path: string | undefined;
    let snapshot: BackupExportSnapshot | undefined;
    let artifactKey: string | undefined;
    let artifactDigest: string | undefined;
    let putWork: Promise<unknown> | undefined;
    let artifactAttached = false;
    let completionAttempted = false;
    try {
      const installation = await this.#store.installationState();
      const snapshotWork = this.#data.exportSnapshot({
        includeDiagnostics: operation.options.includeDiagnostics === true,
        installationId: installation.installationId,
        signal: controller.signal,
      });
      // A production adapter should stop cooperatively on `signal`, but cleanup must still happen
      // if a legacy or temporarily stuck adapter resolves after the deadline has won the race.
      void snapshotWork.then((late) => {
        if (controller.signal.aborted) return late.cleanup?.().catch(() => undefined);
      }).catch(() => undefined);
      snapshot = await abortable(snapshotWork, controller.signal);
      if (controller.signal.aborted) throw aborted(controller.signal);
      operation = await this.#store.updateProgress(operation.id, operation.version, {
        stage: "exporting",
        objectsProcessed: 0,
        objectsTotal: snapshot.objectsTotal,
        bytesProcessed: 0,
        bytesTotal: snapshot.bytesTotal,
        manifest: snapshot.manifest as unknown as Record<string, unknown>,
      });
      path = await Deno.makeTempFile({ prefix: "dg-export-", suffix: ".dgbackup" });
      const file = await Deno.open(path, { write: true, truncate: true });
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (
          const chunk of writeBackupArchiveStream(
            snapshot.manifest,
            snapshot.payloads,
            this.#authenticator,
          )
        ) {
          if (controller.signal.aborted) throw aborted(controller.signal);
          hash.update(chunk);
          size += chunk.length;
          let offset = 0;
          while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
        }
      } finally {
        file.close();
      }
      const digest = hash.digest("hex");
      // A lease-scoped key makes ownership exact. A worker whose lease expires can safely remove
      // its own late upload without racing a replacement worker exporting the same operation.
      const key = `backups/exports/${operation.id}/${leaseToken}-${digest}.dgbackup`;
      artifactKey = key;
      artifactDigest = digest;
      operation = await this.#store.planExportArtifact(
        operation.id,
        operation.version,
        leaseToken,
        key,
        digest,
      );
      const body = await fileStream(path);
      putWork = this.#objects.put({
        key,
        body,
        contentLength: size,
        contentType: BACKUP_MIME,
        metadata: { sha256: digest },
        signal: controller.signal,
      });
      await abortable(
        putWork,
        controller.signal,
      );
      const verified = await this.#objects.get(key);
      if (!verified?.body) throw new Error("Stored backup is unavailable");
      const storedHash = createHash("sha256");
      let storedBytes = 0;
      for await (const chunk of webChunks(verified.body)) {
        if (controller.signal.aborted) throw aborted(controller.signal);
        storedHash.update(chunk);
        storedBytes += chunk.length;
      }
      if (storedBytes !== size || storedHash.digest("hex") !== digest) {
        await this.#objects.delete(key).catch(() => undefined);
        throw new Error("Stored backup failed integrity verification");
      }
      operation = await this.#store.updateProgress(operation.id, operation.version, {
        stage: "stored",
        objectsProcessed: snapshot.objectsTotal,
        objectsTotal: snapshot.objectsTotal,
        bytesProcessed: snapshot.bytesTotal,
        bytesTotal: snapshot.bytesTotal,
      });
      completionAttempted = true;
      operation = await this.#store.complete(operation.id, operation.version, {
        archiveSha256: digest,
        artifactObjectKey: key,
        manifest: snapshot.manifest as unknown as Record<string, unknown>,
      });
      artifactAttached = true;
      return exportSummary(operation);
    } catch {
      await this.#store.fail(operation.id, operation.version, "internal_error").catch(() =>
        undefined
      );
      throw new BackupServiceError("conflict", "The backup export could not be completed");
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      this.#exportControllers.delete(operation.id);
      if (path) await Deno.remove(path).catch(() => undefined);
      await snapshot?.cleanup?.().catch(() => undefined);
      if (artifactKey && artifactDigest && !artifactAttached) {
        const cleanupKey = artifactKey;
        const cleanupDigest = artifactDigest;
        const cleanup = async () => {
          // Wait for a put implementation that ignored cancellation. Deleting before it resolves
          // is insufficient because it can subsequently publish the orphan.
          await putWork?.catch(() => undefined);
          // Before finalization begins, this lease-scoped key cannot possibly be durably owned.
          // This path remains safe even after shutdown has closed the control-plane connection.
          if (!completionAttempted) {
            await this.#objects.delete(cleanupKey).catch(() => undefined);
            return;
          }
          let durable: BackupOperation;
          try {
            durable = await this.#store.get(operation.id);
          } catch {
            // Ambiguous control-plane state must fail safe: a later recovery/admin pass can remove
            // an orphan, while deleting here could destroy a successfully finalized backup.
            return;
          }
          if (
            durable.status === "completed" && durable.artifactObjectKey === cleanupKey &&
            durable.archiveSha256 === cleanupDigest
          ) return;
          await this.#objects.delete(cleanupKey).catch(() => undefined);
        };
        const tracked = cleanup().finally(() => this.#artifactCleanups.delete(tracked));
        this.#artifactCleanups.add(tracked);
      }
    }
  }
  async exportContent(_actorId: string, exportId: string) {
    const operation = await this.#store.get(exportId);
    if (
      operation.status !== "completed" || !operation.artifactObjectKey || !operation.archiveSha256
    ) throw new BackupServiceError("conflict", "The backup export is not ready");
    const stored = await this.#objects.get(operation.artifactObjectKey);
    if (!stored || stored.metadata.sha256 !== operation.archiveSha256) {
      throw new BackupServiceError("not_found", "The backup export is unavailable");
    }
    const headers = new Headers({
      "content-type": BACKUP_MIME,
      "x-backup-sha256": operation.archiveSha256,
    });
    if (stored.contentLength != null) headers.set("content-length", String(stored.contentLength));
    return new Response(stored.body, { headers });
  }
  async uploadRestore(
    input: { actorId: string; request: Request; idempotencyKey: string },
  ): Promise<BackupRestoreUploadSummary> {
    const staged = await stageMultipart(input.request, this.#maxUploadBytes);
    const identity = await sha256Hex(
      encoder.encode(`${input.actorId}\n${input.idempotencyKey}\n${staged.digest}`),
    );
    const objectKey = `backups/restores/${identity}-${staged.digest}.dgbackup`;
    let createdObject = false;
    try {
      const existing = await this.#objects.get(objectKey);
      if (existing) {
        if (existing.metadata.sha256 !== staged.digest || existing.contentLength !== staged.bytes) {
          throw new BackupServiceError(
            "conflict",
            "The restore upload conflicts with an existing upload",
          );
        }
        await existing.body.cancel().catch(() => undefined);
      } else {
        try {
          await this.#objects.put({
            key: objectKey,
            body: await fileStream(staged.path),
            contentLength: staged.bytes,
            contentType: BACKUP_MIME,
            metadata: { sha256: staged.digest },
          });
          createdObject = true;
        } catch {
          const raced = await this.#objects.get(objectKey);
          if (
            !raced || raced.metadata.sha256 !== staged.digest ||
            raced.contentLength !== staged.bytes
          ) {
            throw new BackupServiceError("conflict", "The restore upload could not be stored");
          }
          await raced.body.cancel().catch(() => undefined);
        }
      }
      let operation: BackupOperation;
      try {
        operation = await this.#store.create({
          kind: "restore",
          actorId: input.actorId,
          idempotencyKey: input.idempotencyKey,
          sourceObjectKey: objectKey,
          archiveSha256: staged.digest,
          options: { filename: staged.filename, bytes: staged.bytes },
        });
      } catch (error) {
        if (createdObject) {
          // A create can lose its response after another request durably wins. Delete only after a
          // successful control-plane read proves no operation owns this exact staged object.
          try {
            const durable = await this.#store.findByIdempotency(
              input.actorId,
              "restore",
              input.idempotencyKey,
            );
            if (!durable || durable.sourceObjectKey !== objectKey) {
              await this.#objects.delete(objectKey).catch(() => undefined);
            }
          } catch { /* Ambiguous ownership: preserve bytes for recovery rather than deleting. */ }
        }
        throw error;
      }
      return {
        id: operation.id,
        filename: String(operation.options.filename),
        bytes: Number(operation.options.bytes),
        fingerprint: operation.archiveSha256!,
        createdAt: operation.createdAt,
      };
    } finally {
      await Deno.remove(staged.path).catch(() => undefined);
    }
  }
  async #verifiedSource(operation: BackupOperation) {
    if (!operation.sourceObjectKey || !operation.archiveSha256) {
      throw new BackupServiceError("conflict", "The restore upload is incomplete");
    }
    const stored = await this.#objects.get(operation.sourceObjectKey);
    if (!stored?.body) {
      throw new BackupServiceError("not_found", "The restore upload is unavailable");
    }
    const digest = createHash("sha256");
    async function* stream() {
      for await (const chunk of webChunks(stored!.body)) {
        digest.update(chunk);
        yield chunk;
      }
    }
    return {
      stream: stream(),
      verify: () => {
        if (digest.digest("hex") !== operation.archiveSha256) {
          throw new BackupServiceError(
            "conflict",
            "The restore upload failed integrity validation",
          );
        }
      },
    };
  }
  async previewRestore(_actorId: string, restoreId: string): Promise<BackupRestorePreview> {
    let operation = await this.#store.get(restoreId);
    if (operation.status === "validated" && operation.impact) return this.#preview(operation);
    if (operation.status === "queued") {
      operation = await this.#store.claim(operation.id, operation.version);
    }
    if (operation.status !== "running") {
      throw new BackupServiceError("conflict", "The restore cannot be previewed");
    }
    const session = await this.#data.restoreSession("preview", {
      restoreOperationId: operation.id,
    });
    try {
      const source = await this.#verifiedSource(operation);
      const manifest = await parseBackupArchiveStream(
        source.stream,
        this.#authenticator,
        session.sink,
      );
      source.verify();
      const impact = await session.summarize(manifest);
      operation = await this.#store.updateProgress(operation.id, operation.version, {
        stage: "preflight",
        objectsProcessed: manifest.entries.length,
        objectsTotal: manifest.entries.length,
        bytesProcessed: Number(operation.options.bytes),
        bytesTotal: Number(operation.options.bytes),
        manifest: manifest as unknown as Record<string, unknown>,
        impact: impact as unknown as Record<string, unknown>,
      });
      operation = await this.#store.validateRestore(operation.id, operation.version, {
        archiveSha256: operation.archiveSha256!,
        manifest: manifest as unknown as Record<string, unknown>,
        impact: impact as unknown as Record<string, unknown>,
      });
      return this.#preview(operation);
    } catch {
      await session.rollback().catch(() => undefined);
      await this.#store.fail(operation.id, operation.version, "archive_invalid").catch(() =>
        undefined
      );
      throw new BackupServiceError("conflict", "The backup archive is invalid");
    }
  }
  async issueRestoreStatusCapability(
    actorId: string,
    restoreId: string,
  ): Promise<BackupRestoreStatusCapability> {
    const operation = await this.#store.get(restoreId);
    if (
      operation.kind !== "restore" || operation.actorId !== actorId ||
      operation.status !== "validated"
    ) {
      throw new BackupServiceError("conflict", "The restore is not ready to run");
    }
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    // Field order is deliberately fixed: this is a tiny signed protocol, not arbitrary JSON.
    const payload = statusCapabilityEncoder.encode(JSON.stringify({
      version: 1,
      purpose: "restore-status",
      restoreId,
      expiresAt,
      nonce: crypto.randomUUID(),
    }));
    const signature = await this.#authenticator.sign(payload);
    return {
      token: `${encodeCapabilityPart(payload)}.${encodeCapabilityPart(signature)}`,
      expiresAt,
    };
  }
  async restoreStatus(restoreId: string, capability: string): Promise<BackupRestoreStatus> {
    if (!statusCapabilityId.test(restoreId) || capability.length > 4096) {
      throw new BackupServiceError("not_found", "Restore status is unavailable");
    }
    const parts = capability.split(".");
    if (parts.length !== 2) {
      throw new BackupServiceError("not_found", "Restore status is unavailable");
    }
    const payloadBytes = decodeCapabilityPart(parts[0]);
    const signature = decodeCapabilityPart(parts[1]);
    if (!await this.#authenticator.verify(payloadBytes, signature)) {
      throw new BackupServiceError("not_found", "Restore status is unavailable");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      throw new BackupServiceError("not_found", "Restore status is unavailable");
    }
    if (
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).join(",") !== "version,purpose,restoreId,expiresAt,nonce" ||
      (payload as { version?: unknown }).version !== 1 ||
      (payload as { purpose?: unknown }).purpose !== "restore-status" ||
      (payload as { restoreId?: unknown }).restoreId !== restoreId ||
      typeof (payload as { expiresAt?: unknown }).expiresAt !== "string" ||
      !Number.isFinite(Date.parse((payload as { expiresAt: string }).expiresAt)) ||
      Date.parse((payload as { expiresAt: string }).expiresAt) <= Date.now() ||
      Date.parse((payload as { expiresAt: string }).expiresAt) >
        Date.now() + 60 * 60_000 + 60_000 ||
      typeof (payload as { nonce?: unknown }).nonce !== "string" ||
      !statusCapabilityId.test((payload as { nonce: string }).nonce)
    ) throw new BackupServiceError("not_found", "Restore status is unavailable");
    const operation = await this.#store.get(restoreId);
    if (operation.kind !== "restore") {
      throw new BackupServiceError("not_found", "Restore status is unavailable");
    }
    return {
      restoreId,
      status: operation.status === "cancelled" || operation.status === "queued"
        ? "failed"
        : operation.status,
      stage: operation.stage,
      completedAt: operation.completedAt,
      error: operation.error,
    };
  }
  #preview(operation: BackupOperation): BackupRestorePreview {
    const impact = operation.impact as unknown as {
      counts: BackupRestoreCount[];
      warnings: string[];
      blockingErrors: string[];
      attachmentsMissing: number;
    };
    return {
      restoreId: operation.id,
      fingerprint: operation.archiveSha256!,
      formatVersion: Number(operation.manifest?.version ?? 1),
      createdAt: operation.createdAt,
      counts: impact.counts ?? [],
      warnings: impact.warnings ?? [],
      blockingErrors: impact.blockingErrors ?? [],
      secretsRedacted: operation.manifest?.secretPolicy === "redacted",
      attachmentsMissing: impact.attachmentsMissing ?? 0,
    };
  }
  async applyRestore(
    input: { actorId: string; restoreId: string; fingerprint: string },
  ): Promise<BackupRestoreResult> {
    if (!this.restoreEnabled) {
      throw new BackupServiceError("restore_disabled", "In-application restore is disabled");
    }
    let operation = await this.#store.get(input.restoreId);
    if (operation.archiveSha256 !== input.fingerprint) {
      throw new BackupServiceError("conflict", "The restore fingerprint does not match");
    }
    operation = await this.#store.beginRestoreApply(
      operation.id,
      operation.version,
      input.fingerprint.slice(0, 8).toUpperCase(),
    );
    try {
      const check = await this.#verifiedSource(operation);
      for await (const _ of check.stream) { /* digest-only pass */ }
      check.verify();
    } catch {
      // The operation has already left `validated`; terminalize it while no maintenance fence is
      // held so a missing or tampered upload cannot strand an un-retryable running operation.
      await this.#store.fail(operation.id, operation.version, "archive_invalid").catch(() =>
        undefined
      );
      throw new BackupServiceError("conflict", "The restore upload failed integrity validation");
    }
    let maintenance: Awaited<ReturnType<BackupStorePort["beginRestoreMaintenance"]>>;
    try {
      maintenance = await this.#store.beginRestoreMaintenance(operation.id, operation.version);
    } catch {
      // If another restore owns the singleton, this operation never acquired a fence and can be
      // terminalized normally. If our ID owns it, the transaction may have committed while its
      // response was lost; preserve that fence for deterministic startup recovery.
      try {
        const [durable, installation] = await Promise.all([
          this.#store.get(operation.id),
          this.#store.installationState(),
        ]);
        if (
          durable.status === "running" && durable.stage === "restore_staging" &&
          installation.activeRestoreId !== durable.id
        ) await this.#store.fail(durable.id, durable.version, "internal_error");
      } catch { /* A later recovery pass disambiguates unavailable control-plane state. */ }
      throw new BackupServiceError("conflict", "The restore could not enter maintenance mode");
    }
    let session: BackupRestoreSession | undefined;
    let databaseCommitted = false;
    let commitAttempted = false;
    let terminalOperationVersion = operation.version;
    let terminalInstallationVersion = maintenance.installation.version;
    try {
      session = await this.#data.restoreSession("apply", {
        restoreOperationId: operation.id,
      });
      const source = await this.#verifiedSource(operation);
      const manifest = await parseBackupArchiveStream(
        source.stream,
        this.#authenticator,
        session.sink,
      );
      source.verify();
      let counts: BackupRestoreCount[];
      if (session.commit) {
        commitAttempted = true;
        const committed = await session.commit(manifest, {
          restoreOperationId: operation.id,
          expectedOperationVersion: operation.version,
          expectedInstallationVersion: maintenance.installation.version,
        });
        databaseCommitted = true;
        counts = committed.counts;
        terminalOperationVersion = committed.restoreOperationVersion;
        terminalInstallationVersion = committed.installationVersion;
      } else {
        counts = (await session.summarize(manifest)).counts;
      }
      operation = (await this.#store.finishRestore(
        operation.id,
        terminalOperationVersion,
        terminalInstallationVersion,
        { archiveSha256: input.fingerprint, impact: { counts } },
      )).operation;
      return {
        restoreId: operation.id,
        status: "completed",
        completedAt: operation.completedAt!,
        counts,
      };
    } catch {
      if (commitAttempted && !databaseCommitted) {
        // A transaction can commit even when its client observes a disconnect. Only the durable
        // operation stage can disambiguate that outcome; if it cannot be read, preserve the fence.
        try {
          const durable = await this.#store.get(operation.id);
          if (durable.stage === "database_restored") {
            databaseCommitted = true;
            terminalOperationVersion = durable.version;
            terminalInstallationVersion = (await this.#store.installationState()).version;
          }
        } catch {
          databaseCommitted = true;
        }
      }
      if (!databaseCommitted) {
        await session?.rollback().catch(() => undefined);
        await this.#store.failRestore(
          operation.id,
          terminalOperationVersion,
          terminalInstallationVersion,
          "internal_error",
        ).catch(() => undefined);
      }
      throw new BackupServiceError("conflict", "The restore could not be completed");
    }
  }
  async maintenanceState() {
    const state = await this.#store.installationState();
    return { enabled: state.maintenanceEnabled, retryAfterSeconds: 10 };
  }
  async #cleanupPrecommitRestore(operation: BackupOperation) {
    const session = await this.#data.restoreSession("cleanup", {
      restoreOperationId: operation.id,
    });
    try {
      const source = await this.#verifiedSource(operation);
      const manifest = await parseBackupArchiveStream(
        source.stream,
        this.#authenticator,
        session.sink,
      );
      source.verify();
      if (!session.cleanup) throw new Error("Restore staging cleanup is unavailable");
      await session.cleanup(manifest);
    } finally {
      await session.rollback().catch(() => undefined);
    }
  }
  async #cleanupRecoverableExportArtifacts(signal?: AbortSignal) {
    // One rotating durable page per pass avoids an infinite loop now that tombstones are retained.
    // Repeated passes are essential: DELETE followed by a missing HEAD cannot prove that an old,
    // cancellation-ignoring PUT will not publish later.
    const leaseToken = crypto.randomUUID();
    const claim = this.#store.claimRecoverableExportArtifacts(
      leaseToken,
      this.#artifactCleanupLeaseSeconds,
      this.#artifactSweepIntervalMs,
      this.#artifactClaimTimeoutMs,
      100,
    );
    // Do not abandon a durable claim before ownership is known. The store bounds this transaction
    // below shutdown grace; once rows return, an abort releases every lease before object I/O.
    const abandoned = await claim;
    if (signal?.aborted || this.#closing) {
      await Promise.allSettled(
        abandoned.map((operation) =>
          this.#store.releaseExportArtifactCleanup(operation.id, leaseToken)
        ),
      );
      throw aborted(signal ?? AbortSignal.abort());
    }
    let nextIndex = 0;
    try {
      for (; nextIndex < abandoned.length; nextIndex++) {
        if (signal?.aborted || this.#closing) throw aborted(signal ?? AbortSignal.abort());
        const operation = abandoned[nextIndex];
        const key = operation.artifactObjectKey!;
        const digest = operation.archiveSha256!;
        const deletion = this.#objects.delete(key);
        if (signal) await abortable(deletion, signal);
        else await deletion;
        if (signal?.aborted || this.#closing) throw aborted(signal ?? AbortSignal.abort());
        const lookup = this.#objects.get(key);
        const remaining = signal ? await abortable(lookup, signal) : await lookup;
        if (remaining) {
          await remaining.body.cancel().catch(() => undefined);
          throw new Error("Export artifact remained after cleanup");
        }
        if (signal?.aborted || this.#closing) throw aborted(signal ?? AbortSignal.abort());
        const completion = this.#store.recordExportArtifactCleanup(
          operation.id,
          key,
          digest,
          leaseToken,
        );
        if (signal) await abortable(completion, signal);
        else await completion;
      }
    } catch (error) {
      // A page is one ownership batch. Release the current and every unprocessed row immediately;
      // otherwise one S3 failure strands unrelated tombstones until the lease timeout.
      await Promise.allSettled(
        abandoned.map((operation) =>
          this.#store.releaseExportArtifactCleanup(operation.id, leaseToken)
        ),
      );
      throw error;
    }
  }
  #scheduleArtifactSweep(delayMs = this.#artifactSweepIntervalMs) {
    if (this.#closing || this.#artifactSweep !== undefined) return;
    this.#artifactSweep = setTimeout(() => {
      this.#artifactSweep = undefined;
      if (this.#closing) return;
      const controller = new AbortController();
      this.#artifactSweepController = controller;
      const work = this.#cleanupRecoverableExportArtifacts(controller.signal).catch(() => undefined)
        .finally(() => {
          if (this.#artifactSweepWork === work) this.#artifactSweepWork = undefined;
          if (this.#artifactSweepController === controller) {
            this.#artifactSweepController = undefined;
          }
          if (!this.#closing) this.#scheduleArtifactSweep();
        });
      this.#artifactSweepWork = work;
    }, delayMs);
  }
  async recoverPending() {
    await this.#store.expireExportLeases();
    // Export tombstones are retryable object-store housekeeping. They must not prevent startup or
    // bypass the stricter restore recovery below, whose cleanup failures intentionally stay fatal.
    await this.#cleanupRecoverableExportArtifacts().catch(() => undefined);
    this.#scheduleArtifactSweep();
    let installation = await this.#store.installationState();
    const activeRestoreId = installation.activeRestoreId;
    // The durable singleton is authoritative. Recover it directly before bounded job-history
    // scanning so a busy installation cannot hide its active restore behind 100 newer operations.
    if (activeRestoreId) {
      const active = await this.#store.get(activeRestoreId);
      if (
        active.status === "running" && active.kind === "restore" &&
        active.stage === "database_restored" && active.archiveSha256
      ) {
        await this.#store.finishRestore(
          active.id,
          active.version,
          installation.version,
          { archiveSha256: active.archiveSha256, impact: active.impact ?? undefined },
        );
      } else if (active.status === "running" && active.kind === "restore") {
        // No replacement transaction can have committed unless it atomically advanced the stage to
        // `database_restored`. Replay the signed archive to derive and remove only this operation's
        // deterministic staged keys before releasing its maintenance fence.
        if (active.stage === "restore_staging") await this.#cleanupPrecommitRestore(active);
        await this.#store.failRestore(
          active.id,
          active.version,
          installation.version,
          "internal_error",
        );
      } else {
        throw new BackupServiceError("conflict", "Active restore state is inconsistent");
      }
      installation = await this.#store.installationState();
    }
    // Drain bounded batches until every abandoned running restore is terminal. This selector is
    // independent of mixed terminal history, so newer rows cannot starve crash recovery.
    while (true) {
      const recoverable = (await this.#store.listRecoverableRestores(100))
        .filter((operation) => operation.id !== activeRestoreId);
      if (!recoverable.length) break;
      for (const operation of recoverable) {
        if (operation.stage === "restore_staging") {
          await this.#cleanupPrecommitRestore(operation);
        }
        await this.#store.fail(operation.id, operation.version, "internal_error");
      }
    }
    this.#scheduleExportPump();
  }
  async close() {
    this.#closing = true;
    if (this.#exportWake !== undefined) clearTimeout(this.#exportWake);
    if (this.#artifactSweep !== undefined) clearTimeout(this.#artifactSweep);
    this.#artifactSweepController?.abort(new Error("Backup service is shutting down"));
    for (const controller of this.#exportControllers.values()) {
      controller.abort(new Error("Backup service is shutting down"));
    }
    const work = Promise.allSettled([
      ...this.#tasks.values(),
      ...this.#artifactCleanups,
      ...(this.#artifactSweepWork ? [this.#artifactSweepWork] : []),
    ]);
    await Promise.race([
      work,
      new Promise<void>((resolve) => setTimeout(resolve, this.#shutdownGraceMs)),
    ]);
    await this.#store.close();
  }
}
