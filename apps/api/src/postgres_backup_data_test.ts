import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  BACKUP_DATA_TABLES,
  backupContentRoot,
  createHmacBackupAuthenticator,
  ObjectAlreadyExistsError,
  parseBackupArchiveStream,
  sha256Hex,
  signBackupManifest,
  writeBackupArchiveStream,
} from "@dg-chat/database";
import type {
  BackupDataBatch,
  BackupDataSource,
  BackupExportSource,
  BackupRestoreImpact,
  ObjectStore,
  PutObjectInput,
  StoredObject,
} from "@dg-chat/database";
import { createPostgresBackupDataPort } from "./postgres-backup-data.ts";

function stream(value: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value.slice());
      controller.close();
    },
  });
}

async function payloadBytes(source: Uint8Array | AsyncIterable<Uint8Array>) {
  if (source instanceof Uint8Array) return source.slice();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
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

class FakeObjects implements ObjectStore {
  readonly values = new Map<
    string,
    { value: Uint8Array; type: string; metadata: Record<string, string> }
  >();
  readonly putChunkSizes: number[] = [];
  async put(input: PutObjectInput) {
    if (this.values.has(input.key)) throw new ObjectAlreadyExistsError(input.key);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = input.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.length;
      this.putChunkSizes.push(next.value.length);
    }
    const value = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      value.set(chunk, offset);
      offset += chunk.length;
    }
    if (value.length !== input.contentLength) throw new Error("length mismatch");
    this.values.set(input.key, {
      value,
      type: input.contentType,
      metadata: { ...(input.metadata ?? {}) },
    });
    return { etag: null };
  }
  get(key: string): Promise<StoredObject | undefined> {
    const stored = this.values.get(key);
    return Promise.resolve(
      stored
        ? {
          key,
          body: stream(stored.value),
          contentLength: stored.value.length,
          contentType: stored.type,
          etag: null,
          metadata: { ...stored.metadata },
        }
        : undefined,
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

const attachmentId = "10000000-0000-4000-8000-000000000001";
const ownerId = "10000000-0000-4000-8000-000000000002";

async function fixture(
  options: {
    missing?: boolean;
    tampered?: boolean;
    duplicate?: boolean;
    oversized?: boolean;
    large?: boolean;
    catalogFailure?: boolean;
  } = {},
) {
  const objects = new FakeObjects();
  const body = options.large
    ? new Uint8Array(64 * 1024 * 3 + 17).fill(7)
    : new TextEncoder().encode("bounded attachment body");
  const digest = await sha256Hex(body);
  if (!options.missing) {
    objects.values.set("attachments/original", {
      value: options.tampered ? new TextEncoder().encode("x".repeat(body.length)) : body,
      type: "text/plain",
      metadata: { sha256: digest },
    });
    if (options.duplicate) {
      objects.values.set("attachments/duplicate", {
        value: body,
        type: "text/plain",
        metadata: { sha256: digest },
      });
    }
  }
  const row = {
    id: attachmentId,
    owner_id: ownerId,
    object_key: "attachments/original",
    filename: options.oversized ? "x".repeat(8 * 1024 * 1024 + 1) : "notes.txt",
    mime_type: "text/plain",
    size_bytes: String(body.length),
    sha256: digest,
    state: "ready",
    created_at: "2026-07-12T00:00:00.000Z",
    inspection_error: null,
    updated_at: "2026-07-12T00:00:00.000Z",
    deleted_at: null,
    ingestion_status: "not_applicable",
    ingestion_error: null,
    ingested_at: null,
  };
  let restoredMap: ReadonlyMap<string, string> | undefined;
  const impact = (count: number): BackupRestoreImpact => ({
    rowsByTable: { attachments: count },
    totalRows: count,
    users: 0,
    conversations: 0,
    attachments: count,
    providersDisabledForRedactedCredentials: 0,
    restoreOperationVersion: null,
    installationVersion: null,
  });
  const countRows = async (source: BackupDataSource) => {
    let count = 0;
    for await (const batch of source.rows("attachments")) count += batch.length;
    return count;
  };
  const duplicateObjectKey = ["attachments", "duplicate"].join("/");
  const rows = options.duplicate
    ? [{ ...row }, {
      ...row,
      id: "10000000-0000-4000-8000-000000000003",
      object_key: duplicateObjectKey,
      filename: "duplicate.txt",
    }]
    : [row];
  const lifecycle: string[] = [];
  let catalogChecks = 0;
  let catalogFailure = options.catalogFailure === true;
  const database = {
    verifyCatalog() {
      catalogChecks += 1;
      if (catalogFailure) throw new Error("Database table future_table has no backup policy");
      return Promise.resolve();
    },
    snapshot<T>(
      _url: string,
      consumer: (source: BackupExportSource) => Promise<T>,
    ) {
      const result = consumer({
        schemaVersion: "0028",
        installationId: "installation-test",
        tables: BACKUP_DATA_TABLES.filter((table) => table.name !== "provider_payload_captures"),
        rows(tableName: string): AsyncIterable<BackupDataBatch> {
          return tableName === "attachments"
            ? (async function* () {
              yield rows;
            })()
            : (async function* () {})();
        },
      });
      return result.finally(() => lifecycle.push("snapshot-closed"));
    },
    async dryRun(_url: string, source: BackupDataSource) {
      return impact(await countRows(source));
    },
    async restore(
      _url: string,
      source: BackupDataSource,
      restoreOptions: { objectKeyMap: ReadonlyMap<string, string> },
    ) {
      restoredMap = restoreOptions.objectKeyMap;
      const result = impact(await countRows(source));
      return { ...result, restoreOperationVersion: 3, installationVersion: 4 };
    },
  };
  const authenticator = await createHmacBackupAuthenticator(
    "adapter-test-key",
    new Uint8Array(32).fill(9),
  );
  const adapter = createPostgresBackupDataPort({
    databaseUrl: "postgres://unused",
    objects,
    authenticator,
    appVersion: "1.0.0",
    database,
  });
  return {
    adapter,
    authenticator,
    body,
    digest,
    objects,
    lifecycle,
    catalogChecks: () => catalogChecks,
    setCatalogFailure: (value: boolean) => catalogFailure = value,
    restoredMap: () => restoredMap,
  };
}

Deno.test("postgres backup data streams a bounded object roundtrip and retains committed staging", async () => {
  const fx = await fixture();
  const snapshot = await fx.adapter.exportSnapshot({
    includeDiagnostics: false,
    installationId: "installation-test",
  });
  try {
    assertEquals(snapshot.manifest.objects, {
      count: 1,
      bytes: fx.body.length,
      indexSha256: snapshot.manifest.objects.indexSha256,
    });
    const session = await fx.adapter.restoreSession("apply");
    const archive = writeBackupArchiveStream(
      snapshot.manifest,
      snapshot.payloads,
      fx.authenticator,
    );
    const manifest = await parseBackupArchiveStream(archive, fx.authenticator, session.sink);
    const committed = await session.commit!(manifest, {
      restoreOperationId: "20000000-0000-4000-8000-000000000001",
      expectedOperationVersion: 2,
      expectedInstallationVersion: 3,
    });
    if (Array.isArray(committed)) throw new Error("versioned commit result expected");
    assertEquals(committed.counts.find((row) => row.resource === "attachments")?.create, 1);
    assertEquals(committed.restoreOperationVersion, 3);
    assertEquals(committed.installationVersion, 4);
    const target = fx.restoredMap()?.get("attachments/original");
    assertEquals(target?.startsWith("restores/"), true);
    assertEquals(fx.objects.values.get(target!)?.value, fx.body);
    assertEquals(fx.catalogChecks(), 2);
  } finally {
    await snapshot.cleanup?.();
  }
});

Deno.test("postgres backup data releases the snapshot before object storage and deduplicates content", async () => {
  const fx = await fixture({ duplicate: true });
  const originalGet = fx.objects.get.bind(fx.objects);
  fx.objects.get = (key) => {
    fx.lifecycle.push(`object-get:${key}`);
    return originalGet(key);
  };
  const snapshot = await fx.adapter.exportSnapshot({
    includeDiagnostics: false,
    installationId: "installation-test",
  });
  try {
    assertEquals(fx.lifecycle[0], "snapshot-closed");
    assertEquals(fx.lifecycle[1]?.startsWith("object-get:"), true);
    assertEquals(snapshot.manifest.objects.count, 1);
    assertEquals(snapshot.manifest.objects.bytes, fx.body.length);
    assertEquals(
      snapshot.manifest.entries.find((entry) => entry.name === "objects/index.ndjson")?.records,
      2,
    );
    const session = await fx.adapter.restoreSession("preview");
    const putChunksBeforePreview = fx.objects.putChunkSizes.length;
    const manifest = await parseBackupArchiveStream(
      writeBackupArchiveStream(snapshot.manifest, snapshot.payloads, fx.authenticator),
      fx.authenticator,
      session.sink,
    );
    const preview = await session.summarize(manifest);
    assertEquals(preview.counts.find((row) => row.resource === "attachments")?.create, 2);
    assertEquals(fx.objects.putChunkSizes.length, putChunksBeforePreview);
  } finally {
    await snapshot.cleanup?.();
  }
});

Deno.test("postgres backup data feeds staged blobs through bounded backpressured chunks", async () => {
  const fx = await fixture({ large: true });
  const snapshot = await fx.adapter.exportSnapshot({
    includeDiagnostics: false,
    installationId: "installation-test",
  });
  try {
    const session = await fx.adapter.restoreSession("apply");
    const manifest = await parseBackupArchiveStream(
      writeBackupArchiveStream(snapshot.manifest, snapshot.payloads, fx.authenticator),
      fx.authenticator,
      session.sink,
    );
    await session.commit!(manifest, {
      restoreOperationId: "20000000-0000-4000-8000-000000000001",
      expectedOperationVersion: 2,
      expectedInstallationVersion: 3,
    });
    assertEquals(fx.objects.putChunkSizes.length > 1, true);
    assertEquals(Math.max(...fx.objects.putChunkSizes) <= 64 * 1024, true);
  } finally {
    await snapshot.cleanup?.();
  }
});

Deno.test("postgres backup data rejects a signed archive with a missing semantic table", async () => {
  const fx = await fixture();
  const snapshot = await fx.adapter.exportSnapshot({
    includeDiagnostics: false,
    installationId: "installation-test",
  });
  try {
    const entries = snapshot.manifest.entries.filter((entry) =>
      entry.name !== "tables/users.ndjson"
    );
    const { signature: _signature, ...unsigned } = snapshot.manifest;
    const manifest = await signBackupManifest({
      ...unsigned,
      entries,
      contentRootSha256: await backupContentRoot(entries),
    }, fx.authenticator);
    const payloads = new Map(snapshot.payloads);
    payloads.delete("tables/users.ndjson");
    const session = await fx.adapter.restoreSession("preview");
    const parsed = await parseBackupArchiveStream(
      writeBackupArchiveStream(manifest, payloads, fx.authenticator),
      fx.authenticator,
      session.sink,
    );
    await assertRejects(() => session.summarize(parsed), TypeError, "table entry set");
    await session.rollback();
  } finally {
    await snapshot.cleanup?.();
  }
});

Deno.test("postgres backup data binds the object index exactly to ready attachment rows", async () => {
  const fx = await fixture();
  const snapshot = await fx.adapter.exportSnapshot({
    includeDiagnostics: false,
    installationId: "installation-test",
  });
  try {
    const basePayloads = new Map<string, Uint8Array>();
    for (const [name, payload] of snapshot.payloads) {
      basePayloads.set(name, await payloadBytes(payload));
    }
    const empty = new Uint8Array();
    const emptyDigest = await sha256Hex(empty);
    const missingEntries = snapshot.manifest.entries
      .filter((entry) => entry.kind !== "blob")
      .map((entry) =>
        entry.name === "objects/index.ndjson"
          ? { ...entry, bytes: 0, sha256: emptyDigest, records: 0 }
          : entry
      );
    const { signature: _signature, ...unsigned } = snapshot.manifest;
    const missingManifest = await signBackupManifest({
      ...unsigned,
      objects: { count: 0, bytes: 0, indexSha256: emptyDigest },
      entries: missingEntries,
      contentRootSha256: await backupContentRoot(missingEntries),
    }, fx.authenticator);
    const missingPayloads = new Map(basePayloads);
    for (const entry of snapshot.manifest.entries) {
      if (entry.kind === "blob") missingPayloads.delete(entry.name);
    }
    missingPayloads.set("objects/index.ndjson", empty);
    const missingSession = await fx.adapter.restoreSession("preview");
    const missingParsed = await parseBackupArchiveStream(
      writeBackupArchiveStream(missingManifest, missingPayloads, fx.authenticator),
      fx.authenticator,
      missingSession.sink,
    );
    await assertRejects(
      () => missingSession.summarize(missingParsed),
      TypeError,
      "object count",
    );
    await missingSession.rollback();

    const extraEntries = snapshot.manifest.entries.map((entry) =>
      entry.name === "tables/attachments.ndjson"
        ? { ...entry, bytes: 0, sha256: emptyDigest, records: 0 }
        : entry
    );
    const extraManifest = await signBackupManifest({
      ...unsigned,
      entries: extraEntries,
      contentRootSha256: await backupContentRoot(extraEntries),
    }, fx.authenticator);
    const extraPayloads = new Map(basePayloads);
    extraPayloads.set("tables/attachments.ndjson", empty);
    const extraSession = await fx.adapter.restoreSession("preview");
    const extraParsed = await parseBackupArchiveStream(
      writeBackupArchiveStream(extraManifest, extraPayloads, fx.authenticator),
      fx.authenticator,
      extraSession.sink,
    );
    await assertRejects(
      () => extraSession.summarize(extraParsed),
      TypeError,
      "extra attachment reference",
    );
    await extraSession.rollback();

    const originalIndex = basePayloads.get("objects/index.ndjson")!;
    const inconsistentIndex = new TextEncoder().encode(
      new TextDecoder().decode(originalIndex).replace(
        '"contentType":"text/plain"',
        '"contentType":"application/json"',
      ),
    );
    const inconsistentDigest = await sha256Hex(inconsistentIndex);
    const inconsistentEntries = snapshot.manifest.entries.map((entry) =>
      entry.name === "objects/index.ndjson"
        ? { ...entry, bytes: inconsistentIndex.length, sha256: inconsistentDigest }
        : entry
    );
    const inconsistentManifest = await signBackupManifest({
      ...unsigned,
      objects: { ...unsigned.objects, indexSha256: inconsistentDigest },
      entries: inconsistentEntries,
      contentRootSha256: await backupContentRoot(inconsistentEntries),
    }, fx.authenticator);
    const inconsistentPayloads = new Map(basePayloads);
    inconsistentPayloads.set("objects/index.ndjson", inconsistentIndex);
    const inconsistentSession = await fx.adapter.restoreSession("preview");
    const inconsistentParsed = await parseBackupArchiveStream(
      writeBackupArchiveStream(
        inconsistentManifest,
        inconsistentPayloads,
        fx.authenticator,
      ),
      fx.authenticator,
      inconsistentSession.sink,
    );
    await assertRejects(
      () => inconsistentSession.summarize(inconsistentParsed),
      TypeError,
      "extra attachment reference",
    );
    await inconsistentSession.rollback();
  } finally {
    await snapshot.cleanup?.();
  }
});

Deno.test("postgres backup data bounds canonical NDJSON lines before writing", async () => {
  const fx = await fixture({ oversized: true });
  await assertRejects(
    () =>
      fx.adapter.exportSnapshot({ includeDiagnostics: false, installationId: "installation-test" }),
    TypeError,
    "line is too large",
  );
});

Deno.test("postgres backup data refuses missing attachment objects", async () => {
  const fx = await fixture({ missing: true });
  await assertRejects(
    () =>
      fx.adapter.exportSnapshot({
        includeDiagnostics: false,
        installationId: "installation-test",
      }),
    TypeError,
    "missing",
  );
});

Deno.test("postgres backup data refuses attachment body tampering", async () => {
  const fx = await fixture({ tampered: true });
  await assertRejects(
    () =>
      fx.adapter.exportSnapshot({
        includeDiagnostics: false,
        installationId: "installation-test",
      }),
    TypeError,
    "integrity",
  );
});

Deno.test("postgres backup data fails closed when the production catalog verifier rejects", async () => {
  const exportFailure = await fixture({ catalogFailure: true });
  await assertRejects(
    () =>
      exportFailure.adapter.exportSnapshot({
        includeDiagnostics: false,
        installationId: "installation-test",
      }),
    Error,
    "future_table",
  );
  assertEquals(exportFailure.catalogChecks(), 1);

  const restoreFailure = await fixture();
  restoreFailure.setCatalogFailure(true);
  await assertRejects(
    () => restoreFailure.adapter.restoreSession("apply"),
    Error,
    "future_table",
  );
  assertEquals(restoreFailure.catalogChecks(), 1);
});
