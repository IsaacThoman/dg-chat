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
import type {
  BackupAdminService,
  BackupExportSummary,
  BackupRestoreCount,
  BackupRestorePreview,
  BackupRestoreResult,
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
  rollback(): Promise<void>;
}
export interface BackupRestoreCommit {
  counts: BackupRestoreCount[];
  restoreOperationVersion: number;
  installationVersion: number;
}
export interface BackupDataPort {
  exportSnapshot(
    input: { includeDiagnostics: boolean; installationId: string },
  ): Promise<BackupExportSnapshot>;
  restoreSession(mode: "preview" | "apply"): Promise<BackupRestoreSession>;
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
  readonly #tasks = new Map<string, Promise<void>>();
  constructor(options: BackupServiceOptions) {
    this.#store = options.store;
    this.#objects = options.objects;
    this.#data = options.data;
    this.#authenticator = options.authenticator;
    this.restoreEnabled = options.restoreEnabled === true;
    this.#maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
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
    if (operation.status === "queued" && !this.#tasks.has(operation.id)) {
      const task = this.processExport(operation.id).then(() => undefined).catch(() => undefined)
        .finally(() => this.#tasks.delete(operation.id));
      this.#tasks.set(operation.id, task);
    }
    return exportSummary(operation);
  }
  async processExport(operationId: string): Promise<BackupExportSummary> {
    let operation = await this.#store.get(operationId);
    if (operation.kind !== "export") {
      throw new BackupServiceError("conflict", "The backup export is invalid");
    }
    if (operation.status !== "queued") return exportSummary(operation);
    operation = await this.#store.claim(operation.id, operation.version);
    let path: string | undefined;
    let snapshot: BackupExportSnapshot | undefined;
    try {
      const installation = await this.#store.installationState();
      snapshot = await this.#data.exportSnapshot({
        includeDiagnostics: operation.options.includeDiagnostics === true,
        installationId: installation.installationId,
      });
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
          hash.update(chunk);
          size += chunk.length;
          let offset = 0;
          while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
        }
      } finally {
        file.close();
      }
      const digest = hash.digest("hex");
      const key = `backups/exports/${operation.id}-${digest}.dgbackup`;
      const body = await fileStream(path);
      await this.#objects.put({
        key,
        body,
        contentLength: size,
        contentType: BACKUP_MIME,
        metadata: { sha256: digest },
      });
      const verified = await this.#objects.get(key);
      if (!verified?.body) throw new Error("Stored backup is unavailable");
      const storedHash = createHash("sha256");
      let storedBytes = 0;
      for await (const chunk of webChunks(verified.body)) {
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
      operation = await this.#store.complete(operation.id, operation.version, {
        archiveSha256: digest,
        artifactObjectKey: key,
        manifest: snapshot.manifest as unknown as Record<string, unknown>,
      });
      return exportSummary(operation);
    } catch {
      await this.#store.fail(operation.id, operation.version, "internal_error").catch(() =>
        undefined
      );
      throw new BackupServiceError("conflict", "The backup export could not be completed");
    } finally {
      if (path) await Deno.remove(path).catch(() => undefined);
      await snapshot?.cleanup?.().catch(() => undefined);
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
    const session = await this.#data.restoreSession("preview");
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
      session = await this.#data.restoreSession("apply");
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
  async recoverPending() {
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
        // `database_restored`; all earlier stages are safe to fail and unfence after a crash.
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
    for (const operation of await this.#store.list(undefined, 100)) {
      if (operation.id === activeRestoreId) continue;
      if (operation.status === "queued" && operation.kind === "export") {
        await this.processExport(operation.id).catch(() => undefined);
      } else if (operation.status === "running" && operation.kind === "export") {
        await this.#store.fail(operation.id, operation.version, "internal_error").catch(() =>
          undefined
        );
      } else if (
        operation.status === "running" && operation.kind === "restore" &&
        operation.stage === "database_restored" && installation.activeRestoreId === operation.id &&
        operation.archiveSha256
      ) {
        await this.#store.finishRestore(
          operation.id,
          operation.version,
          installation.version,
          { archiveSha256: operation.archiveSha256, impact: operation.impact ?? undefined },
        ).catch(() => undefined);
      } else if (
        operation.status === "running" && operation.kind === "restore" &&
        installation.activeRestoreId !== operation.id
      ) {
        await this.#store.fail(operation.id, operation.version, "internal_error").catch(() =>
          undefined
        );
      }
    }
  }
  async close() {
    await Promise.allSettled(this.#tasks.values());
    await this.#store.close();
  }
}
