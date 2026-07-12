import { createHash } from "node:crypto";
import {
  assertSafeBackupEntryName,
  BackupLimits,
  BackupManifestAuthenticator,
  BackupManifestEntryV1,
  BackupManifestV1,
  canonicalJson,
  DEFAULT_BACKUP_LIMITS,
  encodeCanonicalJson,
  parseBackupManifestV1,
  sha256Hex,
  verifyBackupManifest,
} from "./backup-format.ts";
const MAGIC = new TextEncoder().encode("DGCBKP1\n");
const MANIFEST_NAME = "manifest.json";
type ByteSource = Uint8Array | AsyncIterable<Uint8Array>;
function uint32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
function concat(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
async function* sourceChunks(source: ByteSource, limits: BackupLimits) {
  if (source instanceof Uint8Array) {
    for (let offset = 0; offset < source.length; offset += limits.streamChunkBytes) {
      // The byte array is already owned by the caller. Bounded views avoid a second large copy.
      yield source.subarray(offset, Math.min(offset + limits.streamChunkBytes, source.length));
    }
    return;
  }
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) continue;
    if (chunk.length > limits.maxSourceChunkBytes) {
      throw new TypeError("Backup source chunk is too large");
    }
    // Do not retain a producer-owned oversized backing buffer through the parser/sink lifecycle.
    yield chunk.slice();
  }
}
async function* boundedChunks(source: ByteSource, size: number, limits: BackupLimits) {
  for await (const chunk of sourceChunks(source, limits)) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) continue;
    for (let offset = 0; offset < chunk.length; offset += size) {
      yield chunk.subarray(offset, Math.min(offset + size, chunk.length));
    }
  }
}
function frameHeader(name: string, size: number, sha256: string) {
  const header = encodeCanonicalJson({ name, size, sha256 });
  return [uint32(header.length), header];
}

/** Backpressured writer: retains only a frame header and one bounded payload chunk. */
export async function* writeBackupArchiveStream(
  manifest: BackupManifestV1,
  payloads: ReadonlyMap<string, ByteSource>,
  authenticator: BackupManifestAuthenticator,
  limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
): AsyncGenerator<Uint8Array> {
  const valid = parseBackupManifestV1(manifest, limits);
  await verifyBackupManifest(valid, authenticator);
  if (payloads.size !== valid.entries.length) {
    throw new TypeError("Payload set does not match manifest");
  }
  let total = MAGIC.length;
  yield MAGIC;
  const emitHeader = function* (name: string, size: number, hash: string) {
    const parts = frameHeader(name, size, hash);
    if (parts[1].length > limits.maxFrameHeaderBytes) {
      throw new TypeError("Frame header is too large");
    }
    for (const part of parts) {
      total += part.length;
      if (total > limits.maxArchiveBytes) throw new TypeError("Backup archive is too large");
      yield part;
    }
  };
  const manifestBytes = encodeCanonicalJson(valid);
  if (manifestBytes.length > limits.maxManifestBytes) throw new TypeError("Manifest is too large");
  yield* emitHeader(MANIFEST_NAME, manifestBytes.length, await sha256Hex(manifestBytes));
  total += manifestBytes.length;
  if (total > limits.maxArchiveBytes) throw new TypeError("Backup archive is too large");
  yield manifestBytes;
  for (const entry of valid.entries) {
    const source = payloads.get(entry.name);
    if (!source) throw new TypeError(`Missing payload: ${entry.name}`);
    yield* emitHeader(entry.name, entry.bytes, entry.sha256);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of boundedChunks(source, limits.streamChunkBytes, limits)) {
      bytes += chunk.length;
      total += chunk.length;
      if (bytes > entry.bytes || total > limits.maxArchiveBytes) {
        throw new TypeError(`Payload exceeds declared size: ${entry.name}`);
      }
      digest.update(chunk);
      yield chunk;
    }
    if (bytes !== entry.bytes || digest.digest("hex") !== entry.sha256) {
      throw new TypeError(`Payload does not match manifest: ${entry.name}`);
    }
  }
  total += 4;
  if (total > limits.maxArchiveBytes) throw new TypeError("Backup archive is too large");
  yield uint32(0);
}

class Reader {
  #queue: Uint8Array[] = [];
  #offset = 0;
  #ended = false;
  #total = 0;
  constructor(private iterator: AsyncIterator<Uint8Array>, private limits: BackupLimits) {}
  async #fill() {
    while (this.#queue.length === 0 && !this.#ended) {
      const next = await this.iterator.next();
      if (next.done) this.#ended = true;
      else if (next.value.length) {
        this.#total += next.value.length;
        if (this.#total > this.limits.maxArchiveBytes) {
          throw new TypeError("Backup archive is too large");
        }
        this.#queue.push(next.value);
      }
    }
  }
  async exact(size: number) {
    const result = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      await this.#fill();
      if (!this.#queue.length) throw new TypeError("Backup archive is truncated");
      const first = this.#queue[0];
      const count = Math.min(size - written, first.length - this.#offset);
      result.set(first.subarray(this.#offset, this.#offset + count), written);
      written += count;
      this.#offset += count;
      if (this.#offset === first.length) {
        this.#queue.shift();
        this.#offset = 0;
      }
    }
    return result;
  }
  async *take(size: number) {
    let remaining = size;
    while (remaining) {
      await this.#fill();
      if (!this.#queue.length) throw new TypeError("Backup archive is truncated");
      const first = this.#queue[0];
      const count = Math.min(remaining, first.length - this.#offset, this.limits.streamChunkBytes);
      const chunk = first.slice(this.#offset, this.#offset + count);
      this.#offset += count;
      remaining -= count;
      if (this.#offset === first.length) {
        this.#queue.shift();
        this.#offset = 0;
      }
      yield chunk;
    }
  }
  async assertEnd() {
    await this.#fill();
    if (this.#queue.length || !this.#ended) throw new TypeError("Backup archive has trailing data");
  }
}
export interface BackupArchiveSink {
  begin(entry: BackupManifestEntryV1): void | Promise<void>;
  write(entry: BackupManifestEntryV1, chunk: Uint8Array): void | Promise<void>;
  commit(entry: BackupManifestEntryV1): void | Promise<void>;
  abort(entry: BackupManifestEntryV1, error: Error): void | Promise<void>;
}
/** Streaming parser. A sink must make `commit` atomic and discard staged bytes on `abort`. */
export async function parseBackupArchiveStream(
  source: ByteSource,
  authenticator: BackupManifestAuthenticator,
  sink: BackupArchiveSink,
  limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
): Promise<BackupManifestV1> {
  const reader = new Reader(sourceChunks(source, limits)[Symbol.asyncIterator](), limits);
  const magic = await reader.exact(MAGIC.length);
  if (!magic.every((byte, i) => byte === MAGIC[i])) throw new TypeError("Invalid backup magic");
  let manifest: BackupManifestV1 | undefined;
  const seen = new Set<string>();
  const completed = new Set<string>();
  while (true) {
    const headerLength = new DataView((await reader.exact(4)).buffer).getUint32(0);
    if (!headerLength) break;
    if (headerLength > limits.maxFrameHeaderBytes) throw new TypeError("Frame header is too large");
    const headerText = new TextDecoder("utf-8", { fatal: true }).decode(
      await reader.exact(headerLength),
    );
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(headerText);
    } catch {
      throw new TypeError("Frame header is invalid");
    }
    if (
      canonicalJson(header) !== headerText ||
      Object.keys(header).sort().join() !== "name,sha256,size" || typeof header.name !== "string" ||
      typeof header.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(header.sha256) ||
      !Number.isSafeInteger(header.size) || (header.size as number) < 0 ||
      (header.size as number) > limits.maxEntryBytes
    ) throw new TypeError("Frame header is invalid");
    assertSafeBackupEntryName(header.name);
    if (seen.has(header.name)) throw new TypeError("Backup contains duplicate entries");
    seen.add(header.name);
    if (!manifest && header.name !== MANIFEST_NAME) {
      throw new TypeError("Manifest must be the first entry");
    }
    if (header.name === MANIFEST_NAME) {
      if ((header.size as number) > limits.maxManifestBytes) {
        throw new TypeError("Manifest is too large");
      }
      const parts: Uint8Array[] = [];
      for await (const part of reader.take(header.size as number)) parts.push(part);
      const data = concat(parts);
      if (await sha256Hex(data) !== header.sha256) {
        throw new TypeError("Backup entry hash does not match");
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
        const json = JSON.parse(text);
        if (canonicalJson(json) !== text) throw new TypeError("Manifest JSON is not canonical");
        manifest = parseBackupManifestV1(json, limits);
        await verifyBackupManifest(manifest, authenticator);
      } catch (error) {
        throw new TypeError(
          `Invalid backup manifest: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      continue;
    }
    const expected = manifest!.entries.find((entry) => entry.name === header.name);
    if (!expected) throw new TypeError("Backup contains an unknown entry");
    if (expected.bytes !== header.size || expected.sha256 !== header.sha256) {
      throw new TypeError("Backup entry does not match manifest");
    }
    const digest = createHash("sha256");
    await sink.begin(expected);
    try {
      for await (const chunk of reader.take(expected.bytes)) {
        digest.update(chunk);
        await sink.write(expected, chunk);
      }
      if (digest.digest("hex") !== expected.sha256) {
        throw new TypeError("Backup entry hash does not match");
      }
      await sink.commit(expected);
      completed.add(expected.name);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error("Backup sink failed");
      await sink.abort(expected, cause);
      throw cause;
    }
  }
  await reader.assertEnd();
  if (!manifest) throw new TypeError("Backup has no manifest");
  if (
    completed.size !== manifest.entries.length ||
    manifest.entries.some((entry) => !completed.has(entry.name))
  ) throw new TypeError("Backup is missing an entry");
  return manifest;
}

/** Small-archive convenience writer. Large backups must consume writeBackupArchiveStream directly. */
export async function writeBackupArchive(
  manifest: BackupManifestV1,
  payloads: ReadonlyMap<string, ByteSource>,
  authenticator: BackupManifestAuthenticator,
  limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of writeBackupArchiveStream(manifest, payloads, authenticator, limits)) {
    size += chunk.length;
    if (size > limits.maxInMemoryArchiveBytes) {
      throw new TypeError("Backup exceeds the in-memory archive limit");
    }
    chunks.push(chunk);
  }
  return concat(chunks);
}
/** Small-archive convenience reader. Large restores must provide a transactional streaming sink. */
export async function readBackupArchive(
  source: ByteSource,
  authenticator: BackupManifestAuthenticator,
  limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
): Promise<{ manifest: BackupManifestV1; entries: ReadonlyMap<string, Uint8Array> }> {
  const entries = new Map<string, Uint8Array>();
  const staged = new Map<string, Uint8Array[]>();
  let total = 0;
  const manifest = await parseBackupArchiveStream(source, authenticator, {
    begin(entry) {
      staged.set(entry.name, []);
    },
    write(entry, chunk) {
      total += chunk.length;
      if (total > limits.maxInMemoryArchiveBytes) {
        throw new TypeError("Backup exceeds the in-memory archive limit");
      }
      staged.get(entry.name)!.push(chunk);
    },
    commit(entry) {
      entries.set(entry.name, concat(staged.get(entry.name)!));
      staged.delete(entry.name);
    },
    abort(entry) {
      staged.delete(entry.name);
    },
  }, limits);
  return { manifest, entries };
}
