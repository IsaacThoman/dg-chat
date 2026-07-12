import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  parseBackupArchiveStream,
  readBackupArchive,
  writeBackupArchive,
  writeBackupArchiveStream,
} from "./backup-archive.ts";
import {
  backupContentRoot,
  BackupManifestV1,
  canonicalJson,
  createEd25519BackupAuthenticator,
  createHmacBackupAuthenticator,
  DEFAULT_BACKUP_LIMITS,
  encodeCanonicalJson,
  parseBackupManifestV1,
  parseBoundedNdjson,
  sha256Hex,
  signBackupManifest,
  unsignedBackupManifest,
  verifyBackupManifest,
} from "./backup-format.ts";
const encoder = new TextEncoder();
async function fixture() {
  const rows = encoder.encode('{"id":1}\n{"id":2}\n');
  const metadata = encoder.encode('{"name":"example"}');
  const entries: BackupManifestV1["entries"] = [
    {
      name: "database/messages.ndjson",
      kind: "ndjson",
      bytes: rows.length,
      sha256: await sha256Hex(rows),
      records: 2,
    },
    {
      name: "metadata/settings.json",
      kind: "json",
      bytes: metadata.length,
      sha256: await sha256Hex(metadata),
    },
  ];
  const authenticator = await createHmacBackupAuthenticator(
    "backup-key-v1",
    new Uint8Array(32).fill(7),
  );
  const manifest = await signBackupManifest({
    format: "dg-chat-backup",
    version: 1,
    backupId: "backup-test-1",
    createdAt: "2026-07-12T00:00:00.000Z",
    appVersion: "1.0.0",
    schemaVersion: "0027",
    mode: "system",
    secretPolicy: "redacted",
    diagnosticPayloadPolicy: "scrubbed",
    source: { installationId: "test-installation" },
    objects: { count: 0, bytes: 0, indexSha256: await sha256Hex(encoder.encode("")) },
    requiredProviderKeyIds: ["provider-key-v1"],
    contentRootSha256: await backupContentRoot(entries),
    entries,
  }, authenticator);
  return {
    manifest,
    authenticator,
    payloads: new Map([[entries[0].name, rows], [entries[1].name, metadata]]),
  };
}
Deno.test("canonical JSON is stable and rejects non-JSON values", () => {
  assertEquals(
    canonicalJson({ z: 1, a: { d: 2, c: [true, null] } }),
    '{"a":{"c":[true,null],"d":2},"z":1}',
  );
  assertThrows(() => canonicalJson({ bad: undefined }), TypeError);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertThrows(() => canonicalJson(cyclic), TypeError);
});
Deno.test("manifest is strict, versioned, policy-complete, and immutable", async () => {
  const { manifest } = await fixture();
  assertEquals(parseBackupManifestV1(manifest), manifest);
  for (
    const invalid of [
      { ...manifest, version: 2 },
      { ...manifest, surprise: true },
      { ...manifest, secretPolicy: "included" },
      { ...manifest, mode: "user" },
      { ...manifest, requiredProviderKeyIds: ["z", "a"] },
      { ...manifest, objects: { ...manifest.objects, extra: true } },
      { ...manifest, entries: [{ ...manifest.entries[0], name: "../secret" }] },
      { ...manifest, entries: [manifest.entries[0], manifest.entries[0]] },
    ]
  ) assertThrows(() => parseBackupManifestV1(invalid), TypeError);
});
Deno.test("manifest authentication detects roots, signatures, and untrusted keys", async () => {
  const { manifest, authenticator } = await fixture();
  await verifyBackupManifest(manifest, authenticator);
  await assertRejects(
    () => verifyBackupManifest({ ...manifest, contentRootSha256: "0".repeat(64) }, authenticator),
    TypeError,
    "content root",
  );
  const other = await createHmacBackupAuthenticator("other-key", new Uint8Array(32).fill(8));
  await assertRejects(() => verifyBackupManifest(manifest, other), TypeError, "trusted key");
  await assertRejects(
    () => verifyBackupManifest({ ...manifest, appVersion: "1.0.1" }, authenticator),
    TypeError,
    "signature",
  );
});

Deno.test("Ed25519 manifest authentication supports public-only restore verification", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const signer = createEd25519BackupAuthenticator("ed25519-key", keys.publicKey, keys.privateKey);
  const verifier = createEd25519BackupAuthenticator("ed25519-key", keys.publicKey);
  const { manifest } = await fixture();
  const signed = await signBackupManifest(unsignedBackupManifest(manifest), signer);
  await verifyBackupManifest(signed, verifier);
  await assertRejects(() => verifier.sign(new Uint8Array()), TypeError, "private");
});
Deno.test("NDJSON parser enforces UTF-8, newline, line, and record bounds", () => {
  assertEquals(parseBoundedNdjson(encoder.encode('{"id":1}\n'), 1), [{ id: 1 }]);
  for (
    const [data, records] of [[encoder.encode('{"id":1}'), 1], [encoder.encode("\n"), 1], [
      encoder.encode("bad\n"),
      1,
    ], [encoder.encode("{}\n"), 2]] as const
  ) assertThrows(() => parseBoundedNdjson(data, records), TypeError);
  assertThrows(() => parseBoundedNdjson(new Uint8Array([0xff, 10]), 1), TypeError);
  assertThrows(
    () =>
      parseBoundedNdjson(encoder.encode("{}\n"), 1, {
        ...DEFAULT_BACKUP_LIMITS,
        maxNdjsonLineBytes: 1,
      }),
    TypeError,
  );
});
function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
function join(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
async function frame(name: string, data: Uint8Array) {
  const header = encodeCanonicalJson({ name, size: data.length, sha256: await sha256Hex(data) });
  return join(u32(header.length), header, data);
}
Deno.test("archive round trips arbitrarily split streams and requires authentication", async () => {
  const { manifest, payloads, authenticator } = await fixture();
  const archive = await writeBackupArchive(manifest, payloads, authenticator);
  async function* bytes() {
    for (const byte of archive) yield new Uint8Array([byte]);
  }
  const restored = await readBackupArchive(bytes(), authenticator);
  assertEquals(restored.manifest, manifest);
  assertEquals([...restored.entries], [...payloads]);
});
Deno.test("archive rejects truncation, trailing bytes, corruption, magic, and bounds", async () => {
  const { manifest, payloads, authenticator } = await fixture();
  const archive = await writeBackupArchive(manifest, payloads, authenticator);
  await assertRejects(
    () => readBackupArchive(archive.slice(0, -1), authenticator),
    TypeError,
    "truncated",
  );
  await assertRejects(
    () => readBackupArchive(join(archive, new Uint8Array([1])), authenticator),
    TypeError,
    "trailing",
  );
  const corrupt = archive.slice();
  corrupt[corrupt.length - 6] ^= 1;
  await assertRejects(() => readBackupArchive(corrupt, authenticator), TypeError);
  const magic = archive.slice();
  magic[0] ^= 1;
  await assertRejects(() => readBackupArchive(magic, authenticator), TypeError, "magic");
  await assertRejects(
    () =>
      readBackupArchive(archive, authenticator, {
        ...DEFAULT_BACKUP_LIMITS,
        maxArchiveBytes: archive.length - 1,
      }),
    TypeError,
    "too large",
  );
});
Deno.test("archive rejects unsafe, duplicate, unknown, missing, and out-of-order entries", async () => {
  const { manifest, payloads, authenticator } = await fixture();
  const magic = encoder.encode("DGCBKP1\n");
  const end = u32(0);
  const mf = await frame("manifest.json", encodeCanonicalJson(manifest));
  const pf = await frame(manifest.entries[0].name, payloads.get(manifest.entries[0].name)!);
  const unsafe = await frame("../escape", new Uint8Array());
  await assertRejects(
    () => readBackupArchive(join(magic, pf, end), authenticator),
    TypeError,
    "Manifest",
  );
  await assertRejects(
    () => readBackupArchive(join(magic, mf, pf, pf, end), authenticator),
    TypeError,
    "duplicate",
  );
  await assertRejects(
    () => readBackupArchive(join(magic, mf, frameSyncUnknown(), end), authenticator),
    TypeError,
    "unknown",
  );
  await assertRejects(
    () => readBackupArchive(join(magic, mf, end), authenticator),
    TypeError,
    "missing",
  );
  await assertRejects(
    () => readBackupArchive(join(magic, mf, unsafe, end), authenticator),
    TypeError,
    "unsafe",
  );
});
function frameSyncUnknown() {
  const data = encoder.encode("{}");
  const header = encodeCanonicalJson({
    name: "unknown.json",
    size: 2,
    sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  });
  return join(u32(header.length), header, data);
}
Deno.test("writer rejects absent, extra, modified, oversized, and untrusted payloads", async () => {
  const { manifest, payloads, authenticator } = await fixture();
  await assertRejects(() => writeBackupArchive(manifest, new Map(), authenticator), TypeError);
  await assertRejects(
    () =>
      writeBackupArchive(
        manifest,
        new Map([...payloads, ["extra", new Uint8Array()]]),
        authenticator,
      ),
    TypeError,
  );
  const modified = new Map(payloads);
  modified.set(manifest.entries[0].name, encoder.encode("different"));
  await assertRejects(() => writeBackupArchive(manifest, modified, authenticator), TypeError);
  await assertRejects(
    () =>
      writeBackupArchive(manifest, payloads, authenticator, {
        ...DEFAULT_BACKUP_LIMITS,
        maxArchiveBytes: 1,
      }),
    TypeError,
  );
});

Deno.test("streaming archive applies bounded chunks, backpressure, and transactional abort", async () => {
  const data = new Uint8Array(2 * 1024 * 1024).fill(91);
  const entry: BackupManifestV1["entries"][number] = {
    name: "objects/large.bin",
    kind: "blob",
    bytes: data.length,
    sha256: await sha256Hex(data),
  };
  const authenticator = await createHmacBackupAuthenticator(
    "stream-key",
    new Uint8Array(32).fill(3),
  );
  const manifest = await signBackupManifest({
    format: "dg-chat-backup",
    version: 1,
    backupId: "stream-test",
    createdAt: "2026-07-12T00:00:00.000Z",
    appVersion: "1.0.0",
    schemaVersion: "0027",
    mode: "system",
    secretPolicy: "redacted",
    diagnosticPayloadPolicy: "excluded",
    source: { installationId: "test" },
    objects: { count: 1, bytes: data.length, indexSha256: entry.sha256 },
    requiredProviderKeyIds: [],
    contentRootSha256: await backupContentRoot([entry]),
    entries: [entry],
  }, authenticator);
  const limits = {
    ...DEFAULT_BACKUP_LIMITS,
    streamChunkBytes: 4096,
    maxInMemoryArchiveBytes: 1024,
  };
  const archiveChunks: Uint8Array[] = [];
  for await (
    const chunk of writeBackupArchiveStream(
      manifest,
      new Map([[entry.name, data]]),
      authenticator,
      limits,
    )
  ) {
    assertEquals(chunk.length <= limits.streamChunkBytes, true);
    archiveChunks.push(chunk);
  }
  let largestSinkChunk = 0;
  let written = 0;
  await parseBackupArchiveStream(
    (async function* () {
      yield* archiveChunks;
    })(),
    authenticator,
    {
      begin() {},
      write(_entry, chunk) {
        largestSinkChunk = Math.max(largestSinkChunk, chunk.length);
        written += chunk.length;
      },
      commit() {},
      abort() {},
    },
    limits,
  );
  assertEquals(written, data.length);
  assertEquals(largestSinkChunk <= limits.streamChunkBytes, true);
  await assertRejects(
    () => writeBackupArchive(manifest, new Map([[entry.name, data]]), authenticator, limits),
    TypeError,
    "in-memory",
  );
  let aborted = false;
  await assertRejects(
    () =>
      parseBackupArchiveStream(
        (async function* () {
          yield* archiveChunks;
        })(),
        authenticator,
        {
          begin() {},
          write() {
            throw new Error("sink failure");
          },
          commit() {},
          abort() {
            aborted = true;
          },
        },
        limits,
      ),
    Error,
    "sink failure",
  );
  assertEquals(aborted, true);
});

Deno.test("streaming archive rejects hostile oversized async producer chunks", async () => {
  const { manifest, payloads, authenticator } = await fixture();
  const oversized = new Uint8Array(DEFAULT_BACKUP_LIMITS.maxSourceChunkBytes + 1);
  await assertRejects(
    () =>
      parseBackupArchiveStream(
        (async function* () {
          yield oversized;
        })(),
        authenticator,
        { begin() {}, write() {}, commit() {}, abort() {} },
      ),
    TypeError,
    "source chunk is too large",
  );
  const first = manifest.entries[0];
  const maliciousPayloads = new Map<string, Uint8Array | AsyncIterable<Uint8Array>>(payloads);
  maliciousPayloads.set(
    first.name,
    (async function* () {
      yield oversized;
    })(),
  );
  await assertRejects(
    async () => {
      for await (
        const _ of writeBackupArchiveStream(manifest, maliciousPayloads, authenticator)
      ) { /* consume */ }
    },
    TypeError,
    "source chunk is too large",
  );
});
