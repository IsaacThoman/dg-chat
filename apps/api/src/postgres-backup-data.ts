import { createHash } from "node:crypto";
import type {
  BackupArchiveSink,
  BackupDataBatch,
  BackupDataSource,
  BackupExportSource,
  BackupManifestAuthenticator,
  BackupManifestEntryV1,
  BackupManifestV1,
  BackupRestoreImpact,
  ObjectStore,
  PrivilegedBackupExportSource,
  ProviderCredentialEnvelope,
} from "@dg-chat/database";
import {
  ADMIN_LIFECYCLE_BACKUP_DATA_OMITTED_TABLES,
  BACKUP_DATA_BATCH_SIZE,
  BACKUP_DATA_SCHEMA_VERSION,
  BACKUP_DATA_TABLES,
  backupContentRoot,
  canonicalJson,
  DEFAULT_BACKUP_LIMITS,
  dryRunBackupData,
  isSupportedBackupDataSchemaVersion,
  LEGACY_BACKUP_DATA_OMITTED_TABLES,
  ObjectAlreadyExistsError,
  PRE_AUTOMATIC_RETENTION_BACKUP_DATA_OMITTED_TABLES,
  PRE_IMMUTABLE_SHARING_BACKUP_DATA_OMITTED_TABLES,
  restoreBackupData,
  signBackupManifest,
  verifyBackupDataCatalog,
  withPrivilegedRepeatableReadBackupSnapshot,
  withRepeatableReadBackupSnapshot,
} from "@dg-chat/database";
import type {
  BackupDataPort,
  BackupExportSnapshot,
  BackupRestoreSession,
} from "./backup-service.ts";

const encoder = new TextEncoder();
const MAX_ENTRIES = 10_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_CREDENTIALS = 10_000;
const MAX_PROVIDER_CREDENTIAL_LINE_BYTES = 64 * 1024;
const OBJECT_INDEX = "objects/index.ndjson";
const TABLE_PREFIX = "tables/";
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type DatabaseAdapter = {
  verifyCatalog?(databaseUrl: string): Promise<void>;
  snapshot<T>(
    databaseUrl: string,
    consumer: (source: BackupExportSource) => Promise<T>,
    options: { diagnosticPolicy: "excluded" | "included" },
  ): Promise<T>;
  privilegedSnapshot<T>(
    databaseUrl: string,
    consumer: (source: PrivilegedBackupExportSource) => Promise<T>,
    options: { diagnosticPolicy: "excluded" | "included" },
  ): Promise<T>;
  dryRun(databaseUrl: string, source: BackupDataSource): Promise<BackupRestoreImpact>;
  restore(
    databaseUrl: string,
    source: BackupDataSource,
    options: {
      restoreOperationId: string;
      expectedOperationVersion: number;
      expectedInstallationVersion: number;
      objectKeyMap: ReadonlyMap<string, string>;
    },
  ): Promise<BackupRestoreImpact>;
};

export interface PostgresBackupDataOptions {
  databaseUrl: string;
  objects: ObjectStore;
  authenticator: BackupManifestAuthenticator;
  appVersion?: string;
  /** Dependency seam for deterministic adapter tests. Production uses the database package. */
  database?: DatabaseAdapter;
}

interface ObjectReference {
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
}
interface ObjectIndexRecord extends ObjectReference {
  entry: string;
}
interface TempPayload {
  path: string;
  entry: BackupManifestEntryV1;
}

const defaultDatabase: DatabaseAdapter = {
  verifyCatalog: verifyBackupDataCatalog,
  snapshot: withRepeatableReadBackupSnapshot,
  privilegedSnapshot: withPrivilegedRepeatableReadBackupSnapshot,
  dryRun: dryRunBackupData,
  restore: restoreBackupData,
};

export interface SourceEncryptedProviderCredential {
  readonly providerId: string;
  readonly envelope: ProviderCredentialEnvelope;
}

export interface PrivilegedPostgresBackupExportSnapshot extends BackupExportSnapshot {
  /** Re-readable, sequential access to source-key-encrypted credential envelopes. */
  providerCredentials(): AsyncIterable<SourceEncryptedProviderCredential>;
}

export interface PostgresBackupDataPort extends BackupDataPort {
  exportPrivilegedSnapshot(
    input: { includeDiagnostics: boolean; installationId: string; signal?: AbortSignal },
  ): Promise<PrivilegedPostgresBackupExportSnapshot>;
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}

async function* filePayload(path: string): AsyncIterable<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const count = await file.read(buffer);
      if (count === null) return;
      if (count) yield buffer.slice(0, count);
    }
  } finally {
    file.close();
  }
}

class HashedFileWriter {
  readonly #hash = createHash("sha256");
  readonly #file: Deno.FsFile;
  bytes = 0;
  records = 0;
  constructor(readonly path: string) {
    this.#file = Deno.openSync(path, { create: true, write: true, truncate: true });
  }
  async line(value: unknown, maxBytes = MAX_LINE_BYTES) {
    const bytes = encoder.encode(`${canonicalJson(value)}\n`);
    if (bytes.length - 1 > maxBytes) throw new TypeError("NDJSON line is too large");
    this.#hash.update(bytes);
    this.bytes += bytes.length;
    this.records += 1;
    await writeAll(this.#file, bytes);
  }
  async chunk(value: Uint8Array) {
    this.#hash.update(value);
    this.bytes += value.length;
    await writeAll(this.#file, value);
  }
  finish() {
    this.#file.close();
    return this.#hash.digest("hex");
  }
  close() {
    try {
      this.#file.close();
    } catch { /* already closed */ }
  }
}

function exactProviderCredential(value: unknown): SourceEncryptedProviderCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Provider credential spool record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join() !== "envelope,providerId" ||
    typeof record.providerId !== "string" || !UUID.test(record.providerId) ||
    !record.envelope || typeof record.envelope !== "object" || Array.isArray(record.envelope)
  ) throw new TypeError("Provider credential spool record is invalid");
  const envelope = record.envelope as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join() !==
      "algorithm,ciphertext,contentNonce,credentialVersion,keyId,version,wrappedKey,wrappedKeyNonce" ||
    envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM" ||
    typeof envelope.keyId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(envelope.keyId) ||
    !Number.isSafeInteger(envelope.credentialVersion) || Number(envelope.credentialVersion) < 1 ||
    ["wrappedKeyNonce", "wrappedKey", "contentNonce", "ciphertext"].some((field) => {
      const fieldValue = envelope[field];
      return typeof fieldValue !== "string" || fieldValue.length < 1 || fieldValue.length > 48_000;
    })
  ) throw new TypeError("Provider credential spool record is invalid");
  return Object.freeze({
    providerId: record.providerId,
    envelope: Object.freeze(structuredClone(envelope)) as unknown as ProviderCredentialEnvelope,
  });
}

function exactObjectReference(value: unknown): ObjectReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Backup object reference is invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !== "bytes,contentType,objectKey,sha256" ||
    typeof row.objectKey !== "string" || !row.objectKey || row.objectKey.length > 1024 ||
    typeof row.sha256 !== "string" || !SHA256.test(row.sha256) ||
    !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 ||
    typeof row.contentType !== "string" || !row.contentType || row.contentType.length > 255
  ) throw new TypeError("Backup object reference is invalid");
  return row as unknown as ObjectReference;
}

function attachmentReference(row: Readonly<Record<string, unknown>>): ObjectReference | undefined {
  if (row.state !== "ready" || row.deleted_at !== null) return undefined;
  return exactObjectReference({
    objectKey: row.object_key,
    sha256: row.sha256,
    bytes: Number(row.size_bytes),
    contentType: row.mime_type,
  });
}

async function spoolObject(
  root: string,
  objects: ObjectStore,
  reference: ObjectReference,
  signal?: AbortSignal,
): Promise<{ payload: TempPayload; created: boolean }> {
  signal?.throwIfAborted();
  const entryName = `objects/${reference.sha256}`;
  const path = `${root}/object-${reference.sha256}`;
  try {
    const stat = await Deno.stat(path);
    if (stat.size !== reference.bytes) throw new TypeError("Duplicate backup object size differs");
    return {
      created: false,
      payload: {
        path,
        entry: { name: entryName, kind: "blob", bytes: stat.size, sha256: reference.sha256 },
      },
    };
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  signal?.throwIfAborted();
  const stored = await objects.get(reference.objectKey);
  if (!stored) throw new TypeError("A referenced attachment object is missing");
  if (signal?.aborted) {
    await stored.body.cancel(signal.reason).catch(() => undefined);
    signal.throwIfAborted();
  }
  if (stored.contentLength !== null && stored.contentLength !== reference.bytes) {
    await stored.body.cancel().catch(() => undefined);
    throw new TypeError("A referenced attachment object has the wrong size");
  }
  const writer = new HashedFileWriter(path);
  try {
    const reader = stored.body.getReader();
    const cancelOnAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
    signal?.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        const next = await reader.read();
        signal?.throwIfAborted();
        if (next.done) break;
        if (writer.bytes + next.value.length > reference.bytes) {
          throw new TypeError("A referenced attachment object exceeds its declared size");
        }
        await writer.chunk(next.value);
      }
    } finally {
      signal?.removeEventListener("abort", cancelOnAbort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const digest = writer.finish();
    if (writer.bytes !== reference.bytes || digest !== reference.sha256) {
      throw new TypeError("A referenced attachment object failed integrity validation");
    }
    return {
      created: true,
      payload: {
        path,
        entry: { name: entryName, kind: "blob", bytes: writer.bytes, sha256: digest },
      },
    };
  } catch (error) {
    writer.close();
    await Deno.remove(path).catch(() => undefined);
    throw error;
  }
}

async function* ndjson(path: string): AsyncIterable<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = new Uint8Array();
  for await (const chunk of filePayload(path)) {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    let start = 0;
    for (let index = 0; index < joined.length; index++) {
      if (joined[index] !== 10) continue;
      const line = joined.subarray(start, index);
      if (!line.length || line.length > MAX_LINE_BYTES) {
        throw new TypeError("NDJSON line is invalid");
      }
      let parsed;
      try {
        const text = decoder.decode(line);
        parsed = JSON.parse(text);
        if (canonicalJson(parsed) !== text) throw new Error();
      } catch {
        throw new TypeError("NDJSON line is not canonical JSON");
      }
      yield parsed;
      start = index + 1;
    }
    pending = joined.slice(start);
    if (pending.length > MAX_LINE_BYTES) throw new TypeError("NDJSON line is too large");
  }
  if (pending.length) throw new TypeError("NDJSON entry must end with a newline");
}

function fileReadable(path: string): ReadableStream<Uint8Array> {
  const iterator = filePayload(path)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function impactCounts(impact: BackupRestoreImpact) {
  return Object.entries(impact.rowsByTable).map(([resource, count]) => ({
    resource,
    create: count,
    update: 0,
    skip: 0,
  }));
}

export function createPostgresBackupDataPort(
  options: PostgresBackupDataOptions,
): PostgresBackupDataPort {
  if (!options.databaseUrl) throw new TypeError("Backup database URL is required");
  const database = options.database ?? defaultDatabase;
  const appVersion = options.appVersion ?? "0.1.0";
  const exportSnapshot = async (
    input: { includeDiagnostics: boolean; installationId: string; signal?: AbortSignal },
    privileged: boolean,
  ): Promise<PrivilegedPostgresBackupExportSnapshot> => {
    input.signal?.throwIfAborted();
    await database.verifyCatalog?.(options.databaseUrl);
    input.signal?.throwIfAborted();
    const root = await Deno.makeTempDir({ prefix: "dg-backup-data-" });
    try {
      input.signal?.throwIfAborted();
      const takeSnapshot = privileged ? database.privilegedSnapshot : database.snapshot;
      const relational = await takeSnapshot(options.databaseUrl, async (source) => {
        input.signal?.throwIfAborted();
        if (source.installationId !== input.installationId) {
          throw new TypeError("Backup installation changed during export");
        }
        const expectedTables = BACKUP_DATA_TABLES.filter((table) =>
          input.includeDiagnostics || table.name !== "provider_payload_captures"
        ).map((table) => table.name);
        if (source.tables.map((table) => table.name).join() !== expectedTables.join()) {
          throw new TypeError("Backup database table catalog is incomplete");
        }
        const payloads = new Map<string, Uint8Array | AsyncIterable<Uint8Array>>();
        const entries: BackupManifestEntryV1[] = [];
        const referencesPath = `${root}/object-references.ndjson`;
        const references = new HashedFileWriter(referencesPath);
        try {
          for (const table of source.tables) {
            input.signal?.throwIfAborted();
            const name = `${TABLE_PREFIX}${table.name}.ndjson`;
            const path = `${root}/table-${table.name}.ndjson`;
            const writer = new HashedFileWriter(path);
            try {
              for await (const batch of source.rows(table.name)) {
                input.signal?.throwIfAborted();
                for (const row of batch) {
                  input.signal?.throwIfAborted();
                  await writer.line(row);
                  if (table.name === "attachments") {
                    const reference = attachmentReference(row);
                    if (reference) await references.line(reference);
                  }
                }
              }
              const digest = writer.finish();
              entries.push({
                name,
                kind: "ndjson",
                bytes: writer.bytes,
                sha256: digest,
                records: writer.records,
              });
              payloads.set(name, filePayload(path));
            } catch (error) {
              writer.close();
              throw error;
            }
          }
        } finally {
          references.finish();
        }
        input.signal?.throwIfAborted();
        let providerCredentialsPath: string | undefined;
        if (privileged) {
          if (!("providerCredentials" in source)) {
            throw new TypeError("Privileged backup credential source is unavailable");
          }
          const privilegedSource = source as PrivilegedBackupExportSource;
          providerCredentialsPath = `${root}/provider-credentials.ndjson`;
          const credentialWriter = new HashedFileWriter(providerCredentialsPath);
          try {
            for await (const batch of privilegedSource.providerCredentials()) {
              for (const credential of batch) {
                input.signal?.throwIfAborted();
                if (credentialWriter.records >= MAX_PROVIDER_CREDENTIALS) {
                  throw new TypeError("Backup has too many provider credentials");
                }
                await credentialWriter.line(
                  exactProviderCredential(credential),
                  MAX_PROVIDER_CREDENTIAL_LINE_BYTES,
                );
              }
            }
            credentialWriter.finish();
          } catch (error) {
            credentialWriter.close();
            throw error;
          }
        }
        return {
          payloads,
          entries,
          referencesPath,
          providerCredentialsPath,
          schemaVersion: source.schemaVersion,
          installationId: source.installationId,
        };
      }, { diagnosticPolicy: input.includeDiagnostics ? "included" : "excluded" });
      input.signal?.throwIfAborted();

      // Attachment objects are immutable. Fetch them only after releasing the repeatable-read
      // database snapshot so slow multi-gigabyte object storage cannot hold back PostgreSQL VACUUM.
      const objectIndexPath = `${root}/objects-index.ndjson`;
      const objectIndex = new HashedFileWriter(objectIndexPath);
      let objectCount = 0;
      let objectBytes = 0;
      try {
        for await (const raw of ndjson(relational.referencesPath)) {
          input.signal?.throwIfAborted();
          const reference = exactObjectReference(raw);
          const { payload, created } = await spoolObject(
            root,
            options.objects,
            reference,
            input.signal,
          );
          input.signal?.throwIfAborted();
          if (created) {
            if (relational.entries.length >= MAX_ENTRIES - 1) {
              throw new TypeError("Backup has too many entries");
            }
            relational.entries.push(payload.entry);
            relational.payloads.set(payload.entry.name, filePayload(payload.path));
            objectCount += 1;
            objectBytes += payload.entry.bytes;
          }
          await objectIndex.line(
            { ...reference, entry: payload.entry.name } satisfies ObjectIndexRecord,
          );
        }
        input.signal?.throwIfAborted();
        const indexDigest = objectIndex.finish();
        const indexEntry: BackupManifestEntryV1 = {
          name: OBJECT_INDEX,
          kind: "ndjson",
          bytes: objectIndex.bytes,
          sha256: indexDigest,
          records: objectIndex.records,
        };
        relational.entries.push(indexEntry);
        relational.payloads.set(OBJECT_INDEX, filePayload(objectIndexPath));
        input.signal?.throwIfAborted();
        const manifest = await signBackupManifest({
          format: "dg-chat-backup",
          version: 1,
          backupId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          appVersion,
          schemaVersion: relational.schemaVersion,
          mode: "system",
          secretPolicy: "redacted",
          diagnosticPayloadPolicy: input.includeDiagnostics ? "included" : "excluded",
          source: { installationId: relational.installationId },
          objects: { count: objectCount, bytes: objectBytes, indexSha256: indexDigest },
          requiredProviderKeyIds: [],
          contentRootSha256: await backupContentRoot(relational.entries),
          entries: relational.entries,
        }, options.authenticator);
        input.signal?.throwIfAborted();
        let credentialsActive = false;
        let cleaned = false;
        const result: BackupExportSnapshot = {
          manifest,
          payloads: relational.payloads,
          objectsTotal: objectCount,
          bytesTotal: relational.entries.reduce((sum, entry) => sum + entry.bytes, 0),
          cleanup: async () => {
            cleaned = true;
            await Deno.remove(root, { recursive: true }).catch(() => undefined);
          },
        };
        if (!privileged) return result as PrivilegedPostgresBackupExportSnapshot;
        return Object.assign(result, {
          providerCredentials(): AsyncIterable<SourceEncryptedProviderCredential> {
            if (!relational.providerCredentialsPath) {
              throw new TypeError("Provider credentials were not captured for this backup");
            }
            return (async function* () {
              if (cleaned) throw new TypeError("Provider credential spool has been cleaned up");
              if (credentialsActive) {
                throw new TypeError("Provider credentials are already being read");
              }
              credentialsActive = true;
              let records = 0;
              try {
                for await (const raw of ndjson(relational.providerCredentialsPath!)) {
                  input.signal?.throwIfAborted();
                  records += 1;
                  if (records > MAX_PROVIDER_CREDENTIALS) {
                    throw new TypeError("Backup has too many provider credentials");
                  }
                  yield exactProviderCredential(raw);
                }
              } finally {
                credentialsActive = false;
              }
            })();
          },
        });
      } catch (error) {
        objectIndex.close();
        throw error;
      }
    } catch (error) {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    exportSnapshot(input) {
      return exportSnapshot(input, false);
    },
    exportPrivilegedSnapshot(input) {
      return exportSnapshot(input, true);
    },

    async restoreSession(mode, sessionContext): Promise<BackupRestoreSession> {
      if (!UUID.test(sessionContext.restoreOperationId)) {
        throw new TypeError("Restore operation ID is invalid");
      }
      await database.verifyCatalog?.(options.databaseUrl);
      const root = await Deno.makeTempDir({ prefix: "dg-restore-data-" });
      const paths = new Map<string, string>();
      const entryMetadata = new Map<string, BackupManifestEntryV1>();
      const active = new Map<string, Deno.FsFile>();
      const stagedKeys: string[] = [];
      const stagedKeySet = new Set<string>();
      // The durable operation UUID is a collision-resistant namespace and lets crash recovery
      // derive exact keys from the signed archive without requiring unsafe object-store listing.
      const restoreNamespace = sessionContext.restoreOperationId.toLowerCase();
      let retained = false;
      let closed = false;
      let diagnosticsExcluded = false;
      const cleanup = async (removeObjects: boolean) => {
        if (closed && !removeObjects) return;
        for (const file of active.values()) {
          try {
            file.close();
          } catch { /* already closed */ }
        }
        active.clear();
        if (removeObjects && !retained) {
          for (const key of stagedKeys) await options.objects.delete(key).catch(() => undefined);
          stagedKeys.length = 0;
          stagedKeySet.clear();
        }
        await Deno.remove(root, { recursive: true }).catch(() => undefined);
        closed = true;
      };
      const sink: BackupArchiveSink = {
        async begin(entry) {
          if (active.size) throw new TypeError("Backup entries must be written sequentially");
          const path = `${root}/entry-${entry.sha256}-${paths.size}`;
          const file = await Deno.open(path, { create: true, write: true, truncate: true });
          paths.set(entry.name, path);
          entryMetadata.set(entry.name, entry);
          active.set(entry.name, file);
        },
        async write(entry, chunk) {
          const file = active.get(entry.name);
          if (!file) throw new TypeError("Backup entry was not opened");
          await writeAll(file, chunk);
        },
        commit(entry) {
          const file = active.get(entry.name);
          if (!file) throw new TypeError("Backup entry was not opened");
          file.close();
          active.delete(entry.name);
        },
        async abort(entry) {
          const file = active.get(entry.name);
          try {
            file?.close();
          } catch { /* already closed */ }
          active.delete(entry.name);
          const path = paths.get(entry.name);
          if (path) await Deno.remove(path).catch(() => undefined);
          paths.delete(entry.name);
          entryMetadata.delete(entry.name);
        },
      };

      let stagedSchemaVersion: string = BACKUP_DATA_SCHEMA_VERSION;
      const source = (): BackupDataSource => ({
        schemaVersion: stagedSchemaVersion,
        rows(tableName: string): AsyncIterable<BackupDataBatch> {
          const path = paths.get(`${TABLE_PREFIX}${tableName}.ndjson`);
          if (!path) {
            if (
              (stagedSchemaVersion !== BACKUP_DATA_SCHEMA_VERSION &&
                PRE_AUTOMATIC_RETENTION_BACKUP_DATA_OMITTED_TABLES.has(tableName)) ||
              (stagedSchemaVersion === "0028" &&
                LEGACY_BACKUP_DATA_OMITTED_TABLES.has(tableName)) ||
              (["0037", "0034"].includes(stagedSchemaVersion) &&
                ADMIN_LIFECYCLE_BACKUP_DATA_OMITTED_TABLES.has(tableName)) ||
              (["0033", "0032"].includes(stagedSchemaVersion) &&
                PRE_IMMUTABLE_SHARING_BACKUP_DATA_OMITTED_TABLES.has(tableName))
            ) return (async function* () {})();
            if (diagnosticsExcluded && tableName === "provider_payload_captures") {
              return (async function* () {})();
            }
            throw new TypeError(`Backup table entry is missing: ${tableName}`);
          }
          return (async function* () {
            let batch: Record<string, unknown>[] = [];
            let records = 0;
            for await (const row of ndjson(path)) {
              if (!row || typeof row !== "object" || Array.isArray(row)) {
                throw new TypeError("Backup table row is invalid");
              }
              batch.push(row as Record<string, unknown>);
              records += 1;
              if (batch.length === BACKUP_DATA_BATCH_SIZE) {
                yield batch;
                batch = [];
              }
            }
            if (batch.length) yield batch;
            const entry = entryMetadata.get(`${TABLE_PREFIX}${tableName}.ndjson`);
            if (!entry || entry.records !== records) {
              throw new TypeError(`Backup table record count does not match: ${tableName}`);
            }
          })();
        },
      });

      const stageObjects = async (manifest: BackupManifestV1) => {
        if (!isSupportedBackupDataSchemaVersion(manifest.schemaVersion)) {
          throw new TypeError("Backup database schema is unsupported");
        }
        stagedSchemaVersion = manifest.schemaVersion;
        const currentExpectedTables = BACKUP_DATA_TABLES.filter((table) =>
          manifest.diagnosticPayloadPolicy !== "excluded" ||
          table.name !== "provider_payload_captures"
        ).map((table) => `${TABLE_PREFIX}${table.name}.ndjson`);
        const preAutomaticRetentionExpectedTables = currentExpectedTables.filter((name) =>
          !PRE_AUTOMATIC_RETENTION_BACKUP_DATA_OMITTED_TABLES.has(
            name.slice(TABLE_PREFIX.length, -".ndjson".length),
          )
        );
        const legacyExpectedTables = preAutomaticRetentionExpectedTables.filter((name) =>
          !LEGACY_BACKUP_DATA_OMITTED_TABLES.has(
            name.slice(TABLE_PREFIX.length, -".ndjson".length),
          )
        );
        const adminLifecycleExpectedTables = preAutomaticRetentionExpectedTables.filter((name) =>
          !ADMIN_LIFECYCLE_BACKUP_DATA_OMITTED_TABLES.has(
            name.slice(TABLE_PREFIX.length, -".ndjson".length),
          )
        );
        const preImmutableSharingExpectedTables = preAutomaticRetentionExpectedTables.filter((
          name,
        ) =>
          !PRE_IMMUTABLE_SHARING_BACKUP_DATA_OMITTED_TABLES.has(
            name.slice(TABLE_PREFIX.length, -".ndjson".length),
          )
        );
        diagnosticsExcluded = manifest.diagnosticPayloadPolicy === "excluded";
        const actualTables = manifest.entries.filter((entry) =>
          entry.name.startsWith(TABLE_PREFIX)
        );
        const matches = (expected: readonly string[]) =>
          actualTables.length === expected.length &&
          actualTables.every((entry, index) =>
            entry.name === expected[index] && entry.kind === "ndjson"
          );
        const expectedTables = matches(currentExpectedTables)
          ? currentExpectedTables
          : manifest.schemaVersion !== BACKUP_DATA_SCHEMA_VERSION &&
              matches(preAutomaticRetentionExpectedTables)
          ? preAutomaticRetentionExpectedTables
          : ["0037", "0034"].includes(manifest.schemaVersion) &&
              matches(adminLifecycleExpectedTables)
          ? adminLifecycleExpectedTables
          : ["0033", "0032"].includes(manifest.schemaVersion) &&
              matches(preImmutableSharingExpectedTables)
          ? preImmutableSharingExpectedTables
          : manifest.schemaVersion === "0028" && matches(legacyExpectedTables)
          ? legacyExpectedTables
          : null;
        if (!expectedTables) {
          throw new TypeError("Backup table entry set is incomplete or unexpected");
        }
        const entryByName = new Map(manifest.entries.map((entry) => [entry.name, entry]));
        if (
          manifest.entries.some((entry) =>
            !expectedTables.includes(entry.name) && entry.name !== OBJECT_INDEX &&
            !(entry.kind === "blob" && /^objects\/[0-9a-f]{64}$/u.test(entry.name))
          )
        ) throw new TypeError("Backup contains an unexpected semantic entry");
        const indexPath = paths.get(OBJECT_INDEX);
        if (!indexPath) throw new TypeError("Backup object index is missing");
        const indexEntry = manifest.entries.find((entry) => entry.name === OBJECT_INDEX);
        if (!indexEntry || indexEntry.sha256 !== manifest.objects.indexSha256) {
          throw new TypeError("Backup object index does not match the manifest");
        }
        const map = new Map<string, string>();
        const expectedReferences = new Map<string, number>();
        const attachmentsPath = paths.get(`${TABLE_PREFIX}attachments.ndjson`);
        if (!attachmentsPath) throw new TypeError("Backup attachment table is missing");
        for await (const raw of ndjson(attachmentsPath)) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new TypeError("Backup attachment row is invalid");
          }
          const reference = attachmentReference(raw as Record<string, unknown>);
          if (!reference) continue;
          const identity = canonicalJson(reference);
          expectedReferences.set(identity, (expectedReferences.get(identity) ?? 0) + 1);
        }
        const uniqueObjects = new Map<string, number>();
        const referencedEntries = new Set<string>();
        const cleanedEntries = new Set<string>();
        let records = 0;
        for await (const raw of ndjson(indexPath)) {
          records += 1;
          if (records > DEFAULT_BACKUP_LIMITS.maxNdjsonRecords) {
            throw new TypeError("Backup object index is too large");
          }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new TypeError("Backup object index is invalid");
          }
          const row = raw as Record<string, unknown>;
          if (Object.keys(row).sort().join() !== "bytes,contentType,entry,objectKey,sha256") {
            throw new TypeError("Backup object index is invalid");
          }
          const reference = exactObjectReference({
            objectKey: row.objectKey,
            sha256: row.sha256,
            bytes: row.bytes,
            contentType: row.contentType,
          });
          const referenceIdentity = canonicalJson(reference);
          const remaining = expectedReferences.get(referenceIdentity) ?? 0;
          if (remaining < 1) {
            throw new TypeError("Backup object index contains an extra attachment reference");
          }
          if (remaining === 1) expectedReferences.delete(referenceIdentity);
          else expectedReferences.set(referenceIdentity, remaining - 1);
          if (typeof row.entry !== "string" || row.entry !== `objects/${reference.sha256}`) {
            throw new TypeError("Backup object entry is invalid");
          }
          const blobPath = paths.get(row.entry);
          const blobEntry = entryByName.get(row.entry);
          if (
            !blobPath || !blobEntry || blobEntry.kind !== "blob" ||
            blobEntry.bytes !== reference.bytes || blobEntry.sha256 !== reference.sha256
          ) throw new TypeError("Backup object payload is missing or invalid");
          const knownBytes = uniqueObjects.get(reference.sha256);
          if (knownBytes !== undefined && knownBytes !== reference.bytes) {
            throw new TypeError("Duplicate backup object metadata is inconsistent");
          }
          uniqueObjects.set(reference.sha256, reference.bytes);
          referencedEntries.add(row.entry);
          const key = `restores/${restoreNamespace}/${reference.sha256}`;
          if (mode === "apply") {
            try {
              await options.objects.put({
                key,
                body: fileReadable(blobPath),
                contentLength: reference.bytes,
                contentType: reference.contentType,
                metadata: { sha256: reference.sha256 },
              });
            } catch (error) {
              if (!(error instanceof ObjectAlreadyExistsError)) throw error;
              const existing = await options.objects.get(key);
              if (
                !existing || existing.contentLength !== reference.bytes ||
                existing.metadata.sha256 !== reference.sha256
              ) throw new TypeError("Staged backup object conflicts with existing content");
              await existing.body.cancel().catch(() => undefined);
            }
            // Track both newly written and previously staged objects. A retry after a pre-commit
            // crash still owns this deterministic namespace and must be able to remove it exactly.
            // Conversely, commit ambiguity is resolved by the service before it calls rollback.
            if (!stagedKeySet.has(key)) {
              stagedKeySet.add(key);
              stagedKeys.push(key);
            }
          } else if (mode === "cleanup" && !cleanedEntries.has(reference.sha256)) {
            const existing = await options.objects.get(key);
            if (existing) {
              if (
                existing.contentLength !== reference.bytes ||
                existing.metadata.sha256 !== reference.sha256
              ) {
                await existing.body.cancel().catch(() => undefined);
                throw new TypeError("Staged backup object conflicts with signed archive metadata");
              }
              await existing.body.cancel().catch(() => undefined);
              await options.objects.delete(key);
            }
            cleanedEntries.add(reference.sha256);
          }
          const previous = map.get(reference.objectKey);
          if (previous && previous !== key) throw new TypeError("Backup object key is duplicated");
          map.set(reference.objectKey, key);
        }
        const uniqueBytes = [...uniqueObjects.values()].reduce((sum, count) => sum + count, 0);
        const blobEntries = manifest.entries.filter((entry) => entry.kind === "blob");
        if (
          expectedReferences.size !== 0 || records !== indexEntry.records ||
          uniqueObjects.size !== manifest.objects.count ||
          uniqueBytes !== manifest.objects.bytes || blobEntries.length !== referencedEntries.size ||
          blobEntries.some((entry) => !referencedEntries.has(entry.name))
        ) {
          throw new TypeError("Backup object count does not match");
        }
        return map;
      };

      const summarize = async (manifest: BackupManifestV1) => {
        try {
          await stageObjects(manifest);
          const impact = await database.dryRun(options.databaseUrl, source());
          return {
            counts: impactCounts(impact),
            warnings: impact.providersDisabledForRedactedCredentials
              ? [
                `${impact.providersDisabledForRedactedCredentials} providers will remain disabled until credentials are replaced.`,
              ]
              : [],
            blockingErrors: [],
            attachmentsMissing: 0,
          };
        } finally {
          if (mode === "preview") await cleanup(true);
        }
      };
      return {
        sink,
        summarize,
        async cleanup(manifest) {
          if (mode !== "cleanup") throw new TypeError("Restore session is not a cleanup session");
          try {
            await stageObjects(manifest);
          } finally {
            await cleanup(false);
          }
        },
        async commit(manifest, context) {
          if (context.restoreOperationId.toLowerCase() !== restoreNamespace) {
            throw new TypeError("Restore operation ID changed during staging");
          }
          try {
            const objectKeyMap = await stageObjects(manifest);
            const impact = await database.restore(options.databaseUrl, source(), {
              ...context,
              objectKeyMap,
            });
            if (
              impact.restoreOperationVersion === null || impact.installationVersion === null
            ) throw new TypeError("Database restore did not return maintenance fence versions");
            retained = true;
            return {
              counts: impactCounts(impact),
              restoreOperationVersion: impact.restoreOperationVersion,
              installationVersion: impact.installationVersion,
            };
          } finally {
            // Once the database transaction has been attempted, a thrown driver response does not
            // prove rollback: PostgreSQL may have committed and advanced the durable operation to
            // `database_restored`. Remove only local temp files here. The service owns outcome
            // disambiguation and calls rollback only after it has durably confirmed pre-commit
            // failure; otherwise staged attachment objects remain available for recovery.
            await cleanup(false);
          }
        },
        rollback: () => cleanup(true),
      };
    },
  };
}
