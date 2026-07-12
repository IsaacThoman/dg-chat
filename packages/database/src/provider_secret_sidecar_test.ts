import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  decodeProviderSecretRecordV1,
  encryptProviderSecretSidecarV1,
  importProviderSecretKek,
  type ProviderSecretRecord,
  type ProviderSecretSidecarBinding,
  type ProviderSecretSidecarLimits,
  restoreProviderSecretSidecarV1,
} from "./provider-secret-sidecar.ts";

const binding: ProviderSecretSidecarBinding = {
  backupId: "123e4567-e89b-42d3-a456-426614174000",
  archiveSha256: "a".repeat(64),
  contentRootSha256: "b".repeat(64),
  sourceInstallationId: "123e4567-e89b-42d3-a456-426614174001",
};
const records: ProviderSecretRecord[] = [
  {
    providerId: "123e4567-e89b-42d3-a456-426614174010",
    credentialVersion: 1,
    secret: new TextEncoder().encode("first-secret"),
  },
  {
    providerId: "123e4567-e89b-42d3-a456-426614174011",
    credentialVersion: 2,
    secret: new TextEncoder().encode("second-secret"),
  },
];
const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
async function bytes(
  customRecords: AsyncIterable<ProviderSecretRecord> | Iterable<ProviderSecretRecord> = records,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (
    const part of encryptProviderSecretSidecarV1({
      binding,
      createdAt: "2026-07-12T12:00:00.000Z",
      kek: { keyId: "env-2026-01", key: await importProviderSecretKek(rawKey) },
      records: customRecords,
    })
  ) parts.push(part);
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
async function* chunks(value: Uint8Array, size = 7): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < value.length; offset += size) {
    yield value.slice(offset, offset + size);
  }
}
async function read(
  value: Uint8Array,
  key = rawKey,
  expected = binding,
): Promise<ProviderSecretRecord[]> {
  const result: ProviderSecretRecord[] = [];
  await restoreProviderSecretSidecarV1({
    source: chunks(value),
    expectedBinding: expected,
    keyring: {
      resolve: async (id) => id === "env-2026-01" ? await importProviderSecretKek(key) : undefined,
    },
    sink: {
      begin() {},
      write(record) {
        result.push({ ...record, secret: record.secret.slice() });
      },
      commit() {},
      abort() {
        result.length = 0;
      },
    },
  });
  return result;
}

Deno.test("provider secret sidecar streams a strict authenticated round trip", async () => {
  const archive = await bytes();
  assertEquals(await read(archive), records);
  assertEquals(new TextDecoder().decode(archive.slice(0, 8)), "DGSECR1\n");
  assertEquals(new TextDecoder().decode(archive).includes("first-secret"), false);
});

Deno.test("provider secret sidecar rejects wrong keys and exact-binding mismatches", async () => {
  const archive = await bytes();
  await assertRejects(
    () => read(archive, new Uint8Array(32).fill(9)),
    TypeError,
    "key authentication",
  );
  await assertRejects(
    () => read(archive, rawKey, { ...binding, archiveSha256: "c".repeat(64) }),
    TypeError,
    "selected base backup",
  );
});

Deno.test("provider secret sidecar rejects tampering, truncation, and trailing bytes", async () => {
  const archive = await bytes();
  const tampered = archive.slice();
  tampered[Math.floor(tampered.length * .7)] ^= 1;
  await assertRejects(() => read(tampered), TypeError);
  const headerTampered = archive.slice();
  const marker = new TextEncoder().encode('"sidecarId":"');
  let markerOffset = -1;
  outer: for (let offset = 0; offset <= headerTampered.length - marker.length; offset++) {
    for (let index = 0; index < marker.length; index++) {
      if (headerTampered[offset + index] !== marker[index]) continue outer;
    }
    markerOffset = offset + marker.length;
    break;
  }
  assertEquals(markerOffset >= 0, true);
  headerTampered[markerOffset] = headerTampered[markerOffset] === 97 ? 98 : 97;
  await assertRejects(() => read(headerTampered), TypeError, "key authentication");
  await assertRejects(() => read(archive.slice(0, -3)), TypeError, "truncated");
  const trailing = new Uint8Array(archive.length + 1);
  trailing.set(archive);
  trailing[archive.length] = 1;
  await assertRejects(() => read(trailing), TypeError, "trailing bytes");
});

Deno.test("provider secret restore closes its source iterator after failure", async () => {
  const archive = await bytes();
  const tampered = archive.slice();
  tampered[Math.floor(tampered.length / 2)] ^= 1;
  let closed = false;
  async function* hostile(): AsyncGenerator<Uint8Array> {
    try {
      yield tampered;
      await new Promise<void>(() => {});
    } finally {
      closed = true;
    }
  }
  await assertRejects(() =>
    restoreProviderSecretSidecarV1({
      source: hostile(),
      expectedBinding: binding,
      keyring: { resolve: async () => await importProviderSecretKek(rawKey) },
      sink: { begin() {}, write() {}, commit() {}, abort() {} },
    })
  );
  assertEquals(closed, true);
});

Deno.test("provider secret sidecar rejects missing/reordered frames and noncanonical records", async () => {
  await assertRejects(() => bytes([...records].reverse()), TypeError, "ascending UUIDs");
  await assertRejects(() => bytes([records[0], records[0]]), TypeError, "unique");
  await assertRejects(
    () => bytes([{ ...records[0], credentialVersion: 0 }]),
    TypeError,
    "positive integer",
  );
  await assertRejects(
    () => bytes([{ ...records[0], secret: "not-bytes" as unknown as Uint8Array }]),
    TypeError,
    "must be bytes",
  );
  await assertRejects(
    () => bytes([{ ...records[0], secret: new Uint8Array() }]),
    TypeError,
    "must not be empty",
  );
  await assertRejects(
    () => bytes([{ ...records[0], credentialVersion: Number.MAX_SAFE_INTEGER + 1 }]),
    TypeError,
    "positive integer",
  );

  const archive = await bytes();
  const headerLength = new DataView(archive.buffer, archive.byteOffset + 8, 4).getUint32(0);
  const first = 12 + headerLength;
  const firstLength = new DataView(archive.buffer, archive.byteOffset + first + 1, 4).getUint32(0);
  const second = first + 5 + firstLength;
  const secondLength = new DataView(archive.buffer, archive.byteOffset + second + 1, 4).getUint32(
    0,
  );
  const reordered = new Uint8Array(archive.length);
  reordered.set(archive.slice(0, first), 0);
  reordered.set(archive.slice(second, second + 5 + secondLength), first);
  reordered.set(archive.slice(first, second), first + 5 + secondLength);
  reordered.set(
    archive.slice(second + 5 + secondLength),
    first + 5 + secondLength + (second - first),
  );
  await assertRejects(() => read(reordered), TypeError, "out of order");
});

Deno.test("provider secret sidecar snapshots caller bytes and enforces total size", async () => {
  const mutable = new TextEncoder().encode("stable-secret");
  async function* source(): AsyncGenerator<ProviderSecretRecord> {
    yield { providerId: records[0].providerId, credentialVersion: 1, secret: mutable };
    mutable.fill(120);
  }
  const archive = await bytes(source());
  assertEquals(new TextDecoder().decode((await read(archive))[0].secret), "stable-secret");
  await assertRejects(
    async () => {
      for await (
        const _ of encryptProviderSecretSidecarV1({
          binding,
          kek: { keyId: "k", key: await importProviderSecretKek(rawKey) },
          records: records.slice(0, 1),
          limits: {
            maxHeaderBytes: 16 * 1024,
            maxRecordBytes: 40 * 1024,
            maxRecords: 10,
            maxTotalBytes: 32,
            maxSourceChunkBytes: 1024,
            outputChunkBytes: 64,
          },
        })
      ) { /* consume */ }
    },
    RangeError,
    "component limits",
  );
});

Deno.test("provider secret sidecar enforces record, count, and source-chunk bounds", async () => {
  await assertRejects(
    async () => {
      for await (
        const _ of encryptProviderSecretSidecarV1({
          binding,
          kek: { keyId: "k", key: await importProviderSecretKek(rawKey) },
          records: records.slice(0, 1),
          limits: {
            maxHeaderBytes: 65536,
            maxRecordBytes: 8,
            maxRecords: 10,
            maxTotalBytes: 1024 * 1024,
            maxSourceChunkBytes: 1024,
            outputChunkBytes: 64,
          },
        })
      ) { /* consume */ }
    },
    RangeError,
    "maxRecordBytes",
  );
  const archive = await bytes();
  await assertRejects(
    async () => {
      const sink = {
        begin() {},
        write() {},
        commit() {},
        abort() {},
      };
      await restoreProviderSecretSidecarV1({
        source: chunks(archive, archive.length),
        expectedBinding: binding,
        keyring: { resolve: async () => await importProviderSecretKek(rawKey) },
        sink,
        limits: {
          maxHeaderBytes: 65536,
          maxRecordBytes: 1024 * 1024,
          maxRecords: 10,
          maxTotalBytes: 1024 * 1024,
          maxSourceChunkBytes: 8,
          outputChunkBytes: 64,
        },
      });
    },
    RangeError,
    "source chunk",
  );
});

Deno.test("provider secret restore commits only after authenticated EOF and aborts staged state", async () => {
  const archive = await bytes();
  for (const invalid of [archive.slice(0, -1), archive.slice(0, -8)]) {
    const events: string[] = [];
    const durable: string[] = [];
    const staged: string[] = [];
    await assertRejects(() =>
      restoreProviderSecretSidecarV1({
        source: chunks(invalid),
        expectedBinding: binding,
        keyring: { resolve: async () => await importProviderSecretKek(rawKey) },
        sink: {
          begin() {
            events.push("begin");
          },
          write(record) {
            events.push("write");
            staged.push(record.providerId);
          },
          commit() {
            events.push("commit");
            durable.push(...staged);
          },
          abort() {
            events.push("abort");
            staged.length = 0;
          },
        },
      })
    );
    assertEquals(events.at(-1), "abort");
    assertEquals(events.includes("commit"), false);
    assertEquals(durable, []);
  }

  const events: string[] = [];
  const summary = await restoreProviderSecretSidecarV1({
    source: chunks(archive),
    expectedBinding: binding,
    keyring: { resolve: async () => await importProviderSecretKek(rawKey) },
    sink: {
      begin() {
        events.push("begin");
      },
      write() {
        events.push("write");
      },
      commit() {
        events.push("commit");
      },
      abort() {
        events.push("abort");
      },
    },
  });
  assertEquals(summary.recordCount, 2);
  assertEquals(events, ["begin", "write", "write", "commit"]);
});

Deno.test("provider secret sidecar validates all limits and supports maximum records", async () => {
  const valid: ProviderSecretSidecarLimits = {
    maxHeaderBytes: 16_384,
    maxRecordBytes: 40_000,
    maxRecords: 0xffffffff,
    maxTotalBytes: 1_000_000,
    maxSourceChunkBytes: 1_000_000,
    outputChunkBytes: 1,
  };
  for (const field of Object.keys(valid) as (keyof ProviderSecretSidecarLimits)[]) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assertRejects(async () => {
        for await (
          const _ of encryptProviderSecretSidecarV1({
            binding,
            kek: { keyId: "k", key: await importProviderSecretKek(rawKey) },
            records: [],
            limits: { ...valid, [field]: value },
          })
        ) { /* consume */ }
      }, RangeError);
    }
  }
  const missing = { ...valid } as Record<string, number>;
  delete missing.outputChunkBytes;
  await assertRejects(
    async () => {
      for await (
        const _ of encryptProviderSecretSidecarV1({
          binding,
          kek: { keyId: "k", key: await importProviderSecretKek(rawKey) },
          records: [],
          limits: missing as unknown as ProviderSecretSidecarLimits,
        })
      ) { /* consume */ }
    },
    TypeError,
    "missing or unknown fields",
  );
  await assertRejects(
    async () => {
      for await (
        const _ of encryptProviderSecretSidecarV1({
          binding,
          kek: { keyId: "k", key: await importProviderSecretKek(rawKey) },
          records: [],
          limits: { ...valid, maxRecords: 0x100000000 },
        })
      ) { /* consume */ }
    },
    RangeError,
    "nonce ordinal",
  );

  const maxSecret = new Uint8Array(valid.maxRecordBytes - 29).fill(42);
  const maxArchive = await bytes([{
    providerId: "018f6f5e-7b3c-7abc-8def-123456789abc",
    credentialVersion: 1,
    secret: maxSecret,
  }]);
  assertEquals((await read(maxArchive))[0].secret, maxSecret);
});

Deno.test("provider secret sidecar rejects unsuitable KEKs and snapshots mutable bindings", async () => {
  const invalidKeys = [
    await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"]),
    await crypto.subtle.importKey("raw", rawKey, "AES-GCM", true, ["encrypt"]),
    await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]),
  ];
  for (const key of invalidKeys) {
    await assertRejects(
      async () => {
        for await (
          const _ of encryptProviderSecretSidecarV1({
            binding,
            kek: { keyId: "k", key },
            records: [],
          })
        ) { /* consume */ }
      },
      TypeError,
      "nonextractable AES-256-GCM",
    );
  }

  const archive = await bytes();
  const decryptWrongUsage = await crypto.subtle.importKey(
    "raw",
    rawKey,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  await assertRejects(
    () =>
      restoreProviderSecretSidecarV1({
        source: chunks(archive),
        expectedBinding: binding,
        keyring: { resolve: () => Promise.resolve(decryptWrongUsage) },
        sink: { begin() {}, write() {}, commit() {}, abort() {} },
      }),
    TypeError,
    "decrypt usage",
  );

  const mutable = { ...binding };
  const iterator = encryptProviderSecretSidecarV1({
    binding: mutable,
    kek: { keyId: "env-2026-01", key: await importProviderSecretKek(rawKey) },
    records,
  })[Symbol.asyncIterator]();
  const first = iterator.next();
  mutable.archiveSha256 = "c".repeat(64);
  const parts = [(await first).value!];
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    parts.push(next.value);
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  assertEquals((await read(joined)).length, 2);
});

Deno.test("provider secret reader bounds the final EOF-probe chunk", async () => {
  const archive = await bytes();
  async function* trailingOversized(): AsyncGenerator<Uint8Array> {
    yield* chunks(archive, 7);
    yield new Uint8Array(9);
  }
  await assertRejects(
    () =>
      restoreProviderSecretSidecarV1({
        source: trailingOversized(),
        expectedBinding: binding,
        keyring: { resolve: () => importProviderSecretKek(rawKey) },
        sink: { begin() {}, write() {}, commit() {}, abort() {} },
        limits: {
          maxHeaderBytes: 16_384,
          maxRecordBytes: 40 * 1024,
          maxRecords: 10,
          maxTotalBytes: 1024 * 1024,
          maxSourceChunkBytes: 8,
          outputChunkBytes: 64,
        },
      }),
    RangeError,
    "source chunk",
  );
});

Deno.test("provider secret binary record rejects malformed version, identity, and length", () => {
  const valid = new Uint8Array(30);
  valid[0] = 1;
  valid.set(
    Uint8Array.from(
      records[0].providerId.replaceAll("-", "").match(/../g)!.map((hex) =>
        Number.parseInt(hex, 16)
      ),
    ),
    1,
  );
  const view = new DataView(valid.buffer);
  view.setBigUint64(17, 1n);
  view.setUint32(25, 1);
  valid[29] = 42;
  const wrongVersion = valid.slice();
  wrongVersion[0] = 2;
  const wrongIdentity = valid.slice();
  wrongIdentity[1] ^= 1;
  const wrongLength = valid.slice();
  new DataView(wrongLength.buffer).setUint32(25, 2);
  for (const malformed of [wrongVersion, wrongIdentity, wrongLength, valid.slice(0, 29)]) {
    try {
      decodeProviderSecretRecordV1(malformed, records[0].providerId);
      throw new Error("expected malformed record rejection");
    } catch (error) {
      assertEquals(error instanceof TypeError, true);
    }
  }
});
