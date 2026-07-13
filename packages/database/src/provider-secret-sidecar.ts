import { canonicalJson, encodeCanonicalJson, sha256Hex } from "./backup-format.ts";

const MAGIC = new TextEncoder().encode("DGSECR1\n");
const RECORD = 1;
const FOOTER = 2;
const TERMINATOR = 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_INPUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const PROVIDER_SECRET_SIDECAR_LIMITS = Object.freeze({
  maxHeaderBytes: 16 * 1024,
  maxRecordBytes: 40 * 1024,
  maxRecords: 10_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxSourceChunkBytes: 1024 * 1024,
  outputChunkBytes: 64 * 1024,
});
export interface ProviderSecretSidecarLimits {
  readonly maxHeaderBytes: number;
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
  readonly maxTotalBytes: number;
  readonly maxSourceChunkBytes: number;
  readonly outputChunkBytes: number;
}

export interface ProviderSecretSidecarBinding {
  backupId: string;
  archiveSha256: string;
  contentRootSha256: string;
  sourceInstallationId: string;
}
export interface ProviderSecretRecord {
  providerId: string;
  credentialVersion: number;
  secret: Uint8Array;
}
export interface ProviderSecretKek {
  keyId: string;
  key: CryptoKey;
}
export interface ProviderSecretKekResolver {
  resolve(keyId: string): Promise<CryptoKey | undefined>;
}
export interface ProviderSecretSidecarRestoreSummary {
  readonly header: ProviderSecretSidecarHeaderV1;
  readonly recordCount: number;
  readonly recordsSha256: string;
}
/**
 * Transactional staging boundary. `write` must only stage records; durable state may be changed
 * solely by `commit`, which is called after the authenticated footer, terminator, and EOF. A sink
 * must copy secret bytes during `write`; the supplied buffer is erased as soon as `write` settles.
 */
export interface ProviderSecretSidecarSink {
  begin(header: ProviderSecretSidecarHeaderV1): void | Promise<void>;
  write(record: ProviderSecretRecord): void | Promise<void>;
  commit(summary: ProviderSecretSidecarRestoreSummary): void | Promise<void>;
  abort(reason: unknown): void | Promise<void>;
}
export interface ProviderSecretSidecarHeaderV1 {
  format: "dg-chat-provider-secrets";
  version: 1;
  sidecarId: string;
  createdAt: string;
  base: ProviderSecretSidecarBinding;
  encryption: {
    contentAlgorithm: "AES-256-GCM";
    kdf: "HKDF-SHA-256";
    salt: string;
    recordNoncePrefix: string;
    wrapping: { algorithm: "AES-256-GCM"; keyId: string; nonce: string; ciphertext: string };
  };
}

type Bytes = Uint8Array;
const td = new TextDecoder("utf-8", { fatal: true });
function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}
function exact(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join() !== [...keys].sort().join()) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
  return result;
}
function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
function decode64(value: unknown, bytes: number, label: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !B64.test(value)) {
    throw new TypeError(`${label} is not canonical base64`);
  }
  let decoded: Bytes;
  try {
    decoded = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw new TypeError(`${label} is not canonical base64`);
  }
  if (decoded.byteLength !== bytes || b64(decoded) !== value) {
    throw new TypeError(`${label} has an invalid length or encoding`);
  }
  return owned(decoded);
}
function decode64Variable(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !B64.test(value)) {
    throw new TypeError(`${label} is not canonical base64`);
  }
  let decoded: Bytes;
  try {
    decoded = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw new TypeError(`${label} is not canonical base64`);
  }
  if (decoded.byteLength < minimum || decoded.byteLength > maximum || b64(decoded) !== value) {
    throw new TypeError(`${label} has an invalid length or encoding`);
  }
  return owned(decoded);
}
function b64(value: Bytes): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function random(bytes: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(bytes));
}
function u32(value: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value);
  return result;
}
function concat(...values: Bytes[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(values.reduce((n, v) => n + v.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    out.set(value, offset);
    offset += value.byteLength;
  }
  return out;
}
function nonce(prefix: Bytes, ordinal: number): Uint8Array<ArrayBuffer> {
  return concat(prefix, u32(ordinal));
}
function uuidBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!UUID_INPUT.test(value)) throw new TypeError("Provider UUID is invalid");
  const hex = value.toLowerCase().replaceAll("-", "");
  return Uint8Array.from(
    { length: 16 },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}
function bytesUuid(value: Uint8Array): string {
  const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}
/** Encodes AEAD plaintext. The caller owns and must zero the returned mutable buffer. */
export function encodeProviderSecretRecordV1(
  providerId: string,
  credentialVersion: number,
  secret: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
    throw new TypeError("Provider credential version must be a positive safe integer");
  }
  if (!(secret instanceof Uint8Array) || secret.byteLength < 1 || secret.byteLength > 0xffffffff) {
    throw new TypeError("Provider secret byte length is invalid");
  }
  const result = new Uint8Array(29 + secret.byteLength);
  result[0] = 1;
  result.set(uuidBytes(providerId), 1);
  const view = new DataView(result.buffer);
  view.setBigUint64(17, BigInt(credentialVersion));
  view.setUint32(25, secret.byteLength);
  result.set(secret, 29);
  return result;
}
/** Decodes AEAD plaintext and returns an owned secret-byte snapshot. */
export function decodeProviderSecretRecordV1(
  plaintext: Uint8Array,
  expectedProviderId: string,
): ProviderSecretRecord {
  if (!UUID_INPUT.test(expectedProviderId)) throw new TypeError("Provider UUID is invalid");
  expectedProviderId = expectedProviderId.toLowerCase();
  if (plaintext.byteLength < 30 || plaintext[0] !== 1) {
    throw new TypeError("Provider secret binary record is invalid");
  }
  const providerId = bytesUuid(plaintext.subarray(1, 17));
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const credentialVersion = view.getBigUint64(17);
  const secretLength = view.getUint32(25);
  if (credentialVersion < 1n || credentialVersion > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("Provider credential version must be a positive safe integer");
  }
  if (
    providerId !== expectedProviderId || secretLength < 1 ||
    plaintext.byteLength !== 29 + secretLength
  ) throw new TypeError("Provider secret binary record length or identity is invalid");
  return {
    providerId,
    credentialVersion: Number(credentialVersion),
    secret: Uint8Array.from(plaintext.subarray(29)),
  };
}
async function aesKey(raw: Bytes): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", owned(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function importProviderSecretKek(raw: Bytes): Promise<CryptoKey> {
  if (raw.byteLength !== 32) {
    throw new TypeError("Provider-secret KEK must contain exactly 32 bytes");
  }
  return await aesKey(raw);
}
function assertBinding(raw: unknown, requireCanonical = false): ProviderSecretSidecarBinding {
  const value = exact(raw, [
    "archiveSha256",
    "backupId",
    "contentRootSha256",
    "sourceInstallationId",
  ], "Sidecar base binding");
  const backupId = String(value.backupId);
  const sourceInstallationId = String(value.sourceInstallationId);
  const uuidPattern = requireCanonical ? UUID : UUID_INPUT;
  if (!uuidPattern.test(backupId) || !uuidPattern.test(sourceInstallationId)) {
    throw new TypeError("Sidecar binding UUID is invalid");
  }
  if (!HEX.test(String(value.archiveSha256)) || !HEX.test(String(value.contentRootSha256))) {
    throw new TypeError("Sidecar binding hash is invalid");
  }
  return Object.freeze({
    backupId: backupId.toLowerCase(),
    archiveSha256: String(value.archiveSha256),
    contentRootSha256: String(value.contentRootSha256),
    sourceInstallationId: sourceInstallationId.toLowerCase(),
  });
}

function assertLimits(raw: ProviderSecretSidecarLimits): ProviderSecretSidecarLimits {
  exact(raw, [
    "maxHeaderBytes",
    "maxRecordBytes",
    "maxRecords",
    "maxSourceChunkBytes",
    "maxTotalBytes",
    "outputChunkBytes",
  ], "Sidecar limits");
  for (const [name, value] of Object.entries(raw)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Sidecar limit ${name} must be a positive safe integer`);
    }
  }
  if (raw.maxRecords > 0xffffffff) {
    throw new RangeError("Sidecar maxRecords exceeds the nonce ordinal space");
  }
  if (raw.maxRecordBytes < 30) {
    throw new RangeError("Sidecar maxRecordBytes cannot hold a valid record");
  }
  if (raw.maxHeaderBytes > raw.maxTotalBytes || raw.maxRecordBytes > raw.maxTotalBytes) {
    throw new RangeError("Sidecar component limits exceed maxTotalBytes");
  }
  return Object.freeze({ ...raw });
}

function assertKek(key: CryptoKey, usage: "encrypt" | "decrypt"): void {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  if (
    key.type !== "secret" || key.extractable || algorithm.name !== "AES-GCM" ||
    algorithm.length !== 256 || !key.usages.includes(usage)
  ) {
    throw new TypeError(
      `Provider-secret KEK must be nonextractable AES-256-GCM with ${usage} usage`,
    );
  }
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}
function maximumRecordPayloadBytes(maxPlaintextBytes: number): number {
  return new TextEncoder().encode(
    '{"ciphertext":"","ordinal":4294967294,"providerId":"00000000-0000-1000-8000-000000000000"}',
  ).byteLength +
    base64Length(maxPlaintextBytes + 16);
}
const MAX_FOOTER_PAYLOAD_BYTES = 256;
export function parseProviderSecretSidecarHeaderV1(raw: unknown): ProviderSecretSidecarHeaderV1 {
  const value = exact(
    raw,
    ["base", "createdAt", "encryption", "format", "sidecarId", "version"],
    "Sidecar header",
  );
  if (
    value.format !== "dg-chat-provider-secrets" || value.version !== 1 ||
    !canonicalIso(value.createdAt)
  ) throw new TypeError("Unsupported or invalid sidecar header");
  if (typeof value.sidecarId !== "string" || !UUID.test(value.sidecarId)) {
    throw new TypeError("Sidecar ID must be a canonical UUID");
  }
  const encryption = exact(value.encryption, [
    "contentAlgorithm",
    "kdf",
    "recordNoncePrefix",
    "salt",
    "wrapping",
  ], "Sidecar encryption");
  if (encryption.contentAlgorithm !== "AES-256-GCM" || encryption.kdf !== "HKDF-SHA-256") {
    throw new TypeError("Unsupported sidecar encryption");
  }
  decode64(encryption.salt, 32, "Sidecar salt");
  decode64(encryption.recordNoncePrefix, 8, "Sidecar nonce prefix");
  const wrapping = exact(
    encryption.wrapping,
    ["algorithm", "ciphertext", "keyId", "nonce"],
    "Sidecar key wrapping",
  );
  if (
    wrapping.algorithm !== "AES-256-GCM" || typeof wrapping.keyId !== "string" ||
    !ID.test(wrapping.keyId)
  ) throw new TypeError("Invalid sidecar key wrapping");
  decode64(wrapping.nonce, 12, "Sidecar wrapping nonce");
  decode64(wrapping.ciphertext, 48, "Sidecar wrapped key");
  return Object.freeze({
    ...value,
    base: Object.freeze(assertBinding(value.base, true)),
    encryption: Object.freeze({ ...encryption, wrapping: Object.freeze({ ...wrapping }) }),
  }) as unknown as ProviderSecretSidecarHeaderV1;
}
function wrappingAad(
  base: ProviderSecretSidecarBinding,
  createdAt: string,
  sidecarId: string,
  keyId: string,
  salt: string,
  prefix: string,
): Uint8Array<ArrayBuffer> {
  return owned(encodeCanonicalJson({
    base,
    createdAt,
    format: "dg-chat-provider-secrets",
    sidecarId,
    keyId,
    recordNoncePrefix: prefix,
    salt,
    version: 1,
  }));
}
async function deriveRecordKey(
  dek: Bytes,
  salt: Bytes,
  binding: ProviderSecretSidecarBinding,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", owned(dek), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: owned(salt),
      info: owned(
        encodeCanonicalJson({ purpose: "dg-chat/provider-secret-record/v1", base: binding }),
      ),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
function frame(tag: number, payload: Bytes): Bytes {
  return concat(Uint8Array.of(tag), u32(payload.byteLength), payload);
}
async function* chunked(value: Bytes, size: number): AsyncGenerator<Bytes> {
  for (let i = 0; i < value.length; i += size) yield value.slice(i, i + size);
}

export async function* encryptProviderSecretSidecarV1(options: {
  binding: ProviderSecretSidecarBinding;
  createdAt?: string;
  kek: ProviderSecretKek;
  records: AsyncIterable<ProviderSecretRecord> | Iterable<ProviderSecretRecord>;
  limits?: ProviderSecretSidecarLimits;
}): AsyncGenerator<Bytes> {
  const limits = assertLimits(options.limits ?? PROVIDER_SECRET_SIDECAR_LIMITS);
  const base = assertBinding(options.binding);
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!canonicalIso(createdAt) || !ID.test(options.kek.keyId)) {
    throw new TypeError("Invalid sidecar creation metadata");
  }
  assertKek(options.kek.key, "encrypt");
  let dek: Uint8Array<ArrayBuffer> | undefined = random(32);
  const salt = random(32), prefix = random(8), wrapNonce = random(12);
  try {
    const sidecarId = crypto.randomUUID();
    const salt64 = b64(salt), prefix64 = b64(prefix);
    const wrapped = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: wrapNonce,
          additionalData: wrappingAad(
            base,
            createdAt,
            sidecarId,
            options.kek.keyId,
            salt64,
            prefix64,
          ),
        },
        options.kek.key,
        dek,
      ),
    );
    const header = parseProviderSecretSidecarHeaderV1({
      format: "dg-chat-provider-secrets",
      version: 1,
      sidecarId,
      createdAt,
      base,
      encryption: {
        contentAlgorithm: "AES-256-GCM",
        kdf: "HKDF-SHA-256",
        salt: salt64,
        recordNoncePrefix: prefix64,
        wrapping: {
          algorithm: "AES-256-GCM",
          keyId: options.kek.keyId,
          nonce: b64(wrapNonce),
          ciphertext: b64(wrapped),
        },
      },
    });
    const headerBytes = encodeCanonicalJson(header);
    if (headerBytes.byteLength > limits.maxHeaderBytes) {
      throw new RangeError("Sidecar header exceeds limit");
    }
    const prefixFrame = concat(MAGIC, u32(headerBytes.byteLength), headerBytes);
    let totalBytes = prefixFrame.byteLength;
    if (totalBytes > limits.maxTotalBytes) throw new RangeError("Sidecar exceeds total size limit");
    const recordKey = await deriveRecordKey(dek, salt, base);
    dek.fill(0);
    dek = undefined;
    yield* chunked(prefixFrame, limits.outputChunkBytes);
    const headerSha256 = await sha256Hex(headerBytes);
    const hashes: string[] = [];
    let ordinal = 0;
    let previous = "";
    for await (const raw of options.records) {
      if (ordinal >= limits.maxRecords) throw new RangeError("Sidecar contains too many records");
      const record = exact(
        raw,
        ["credentialVersion", "providerId", "secret"],
        "Provider secret record",
      );
      const rawProviderId = String(record.providerId);
      if (!UUID_INPUT.test(rawProviderId)) {
        throw new TypeError("Provider records must contain valid UUIDs");
      }
      const providerId = rawProviderId.toLowerCase();
      if (providerId <= previous) {
        throw new TypeError("Provider records must have unique, ascending UUIDs");
      }
      if (
        !Number.isSafeInteger(record.credentialVersion) || Number(record.credentialVersion) <= 0
      ) {
        throw new TypeError("Provider credential version must be a positive integer");
      }
      if (!(record.secret instanceof Uint8Array)) {
        throw new TypeError("Provider secret must be bytes");
      }
      if (record.secret.byteLength === 0) throw new TypeError("Provider secret must not be empty");
      previous = providerId;
      const secret = Uint8Array.from(record.secret);
      let plaintext: Uint8Array;
      try {
        plaintext = encodeProviderSecretRecordV1(
          providerId,
          Number(record.credentialVersion),
          secret,
        );
      } finally {
        secret.fill(0);
      }
      if (plaintext.byteLength > limits.maxRecordBytes) {
        throw new RangeError("Provider secret record exceeds limit");
      }
      const aad = owned(encodeCanonicalJson({
        headerSha256,
        ordinal,
        providerId,
        type: "record",
      }));
      let plaintextHash: string;
      let ciphertext: Uint8Array;
      try {
        plaintextHash = await sha256Hex(plaintext);
        ciphertext = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce(prefix, ordinal), additionalData: aad },
            recordKey,
            owned(plaintext),
          ),
        );
      } finally {
        plaintext.fill(0);
      }
      hashes.push(plaintextHash);
      const payload = encodeCanonicalJson({ ciphertext: b64(ciphertext), ordinal, providerId });
      if (payload.byteLength > maximumRecordPayloadBytes(limits.maxRecordBytes)) {
        throw new RangeError("Sidecar record frame exceeds limit");
      }
      const recordFrame = frame(RECORD, payload);
      totalBytes += recordFrame.byteLength;
      if (totalBytes > limits.maxTotalBytes) {
        throw new RangeError("Sidecar exceeds total size limit");
      }
      yield* chunked(recordFrame, limits.outputChunkBytes);
      ordinal++;
    }
    const footerPlain = encodeCanonicalJson({
      count: ordinal,
      recordsSha256: await sha256Hex(encodeCanonicalJson(hashes)),
    });
    const footerAad = owned(encodeCanonicalJson({
      headerSha256,
      type: "footer",
    }));
    let footerCipher: Uint8Array;
    try {
      footerCipher = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce(prefix, 0xffffffff), additionalData: footerAad },
          recordKey,
          owned(footerPlain),
        ),
      );
    } finally {
      footerPlain.fill(0);
    }
    const footerFrame = frame(FOOTER, encodeCanonicalJson({ ciphertext: b64(footerCipher) }));
    totalBytes += footerFrame.byteLength + 1;
    if (totalBytes > limits.maxTotalBytes) throw new RangeError("Sidecar exceeds total size limit");
    yield* chunked(footerFrame, limits.outputChunkBytes);
    yield Uint8Array.of(TERMINATOR);
  } finally {
    dek?.fill(0);
  }
}

class Reader {
  #iterator: AsyncIterator<Bytes>;
  #buffer = new Uint8Array();
  #done = false;
  #maxChunk: number;
  #maxTotal: number;
  #consumed = 0;
  constructor(source: AsyncIterable<Bytes>, maxChunk: number, maxTotal: number) {
    this.#iterator = source[Symbol.asyncIterator]();
    this.#maxChunk = maxChunk;
    this.#maxTotal = maxTotal;
  }
  async take(size: number): Promise<Bytes> {
    while (this.#buffer.byteLength < size && !this.#done) {
      const next = await this.#iterator.next();
      this.#done = Boolean(next.done);
      if (!next.done) {
        if (!(next.value instanceof Uint8Array) || next.value.byteLength > this.#maxChunk) {
          throw new RangeError("Invalid or oversized sidecar source chunk");
        }
        this.#buffer = concat(this.#buffer, Uint8Array.from(next.value));
      }
    }
    if (this.#buffer.byteLength < size) throw new TypeError("Sidecar is truncated");
    const result = this.#buffer.slice(0, size);
    this.#buffer = this.#buffer.slice(size);
    this.#consumed += size;
    if (this.#consumed > this.#maxTotal) throw new RangeError("Sidecar exceeds total size limit");
    return result;
  }
  async eof(): Promise<boolean> {
    if (this.#buffer.length) return false;
    if (this.#done) return true;
    const next = await this.#iterator.next();
    this.#done = Boolean(next.done);
    if (!next.done) {
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > this.#maxChunk) {
        throw new RangeError("Invalid or oversized sidecar source chunk");
      }
      this.#consumed += next.value.byteLength;
      if (this.#consumed > this.#maxTotal) throw new RangeError("Sidecar exceeds total size limit");
      this.#buffer = Uint8Array.from(next.value);
    }
    return this.#done;
  }

  async close(): Promise<void> {
    this.#buffer.fill(0);
    this.#buffer = new Uint8Array();
    if (this.#done) return;
    this.#done = true;
    await this.#iterator.return?.();
  }
}
function json(bytes: Bytes, label: string): unknown {
  let text: string;
  try {
    text = td.decode(bytes);
  } catch {
    throw new TypeError(`${label} is not UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError(`${label} is not JSON`);
  }
  if (canonicalJson(value) !== text) throw new TypeError(`${label} is not canonical JSON`);
  return value;
}
export async function restoreProviderSecretSidecarV1(options: {
  source: AsyncIterable<Bytes>;
  keyring: ProviderSecretKekResolver;
  expectedBinding: ProviderSecretSidecarBinding;
  sink: ProviderSecretSidecarSink;
  limits?: ProviderSecretSidecarLimits;
}): Promise<ProviderSecretSidecarRestoreSummary> {
  const limits = assertLimits(options.limits ?? PROVIDER_SECRET_SIDECAR_LIMITS);
  const expectedBinding = assertBinding(options.expectedBinding);
  const reader = new Reader(options.source, limits.maxSourceChunkBytes, limits.maxTotalBytes);
  let begun = false;
  let committed = false;
  let pendingSecret: Uint8Array | undefined;
  let dek: Bytes | undefined;
  try {
    const magic = await reader.take(MAGIC.length);
    if (!magic.every((b, i) => b === MAGIC[i])) {
      throw new TypeError("Invalid provider-secret sidecar magic");
    }
    const headerLength = new DataView((await reader.take(4)).buffer).getUint32(0);
    if (headerLength > limits.maxHeaderBytes) throw new RangeError("Sidecar header exceeds limit");
    const headerBytes = await reader.take(headerLength);
    const header = parseProviderSecretSidecarHeaderV1(await json(headerBytes, "Sidecar header"));
    if (
      canonicalJson(header) !== td.decode(headerBytes) ||
      canonicalJson(header.base) !== canonicalJson(expectedBinding)
    ) throw new TypeError("Sidecar does not match the selected base backup");
    const kek = await options.keyring.resolve(header.encryption.wrapping.keyId);
    if (!kek) throw new TypeError("Sidecar wrapping key is unavailable");
    assertKek(kek, "decrypt");
    begun = true;
    await options.sink.begin(header);
    const salt = decode64(header.encryption.salt, 32, "Sidecar salt"),
      prefix = decode64(header.encryption.recordNoncePrefix, 8, "Sidecar nonce prefix");
    try {
      dek = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: decode64(header.encryption.wrapping.nonce, 12, "Wrapping nonce"),
            additionalData: wrappingAad(
              header.base,
              header.createdAt,
              header.sidecarId,
              header.encryption.wrapping.keyId,
              header.encryption.salt,
              header.encryption.recordNoncePrefix,
            ),
          },
          kek,
          decode64(header.encryption.wrapping.ciphertext, 48, "Wrapped key"),
        ),
      );
    } catch {
      throw new TypeError("Sidecar key authentication failed");
    }
    const recordKey = await deriveRecordKey(dek, salt, header.base);
    dek.fill(0);
    dek = undefined;
    const headerSha256 = await sha256Hex(headerBytes);
    const hashes: string[] = [];
    let expected = 0;
    let previous = "";
    while (true) {
      const tag = (await reader.take(1))[0];
      if (tag === TERMINATOR) throw new TypeError("Sidecar footer is missing");
      if (tag !== RECORD && tag !== FOOTER) throw new TypeError("Unknown sidecar frame type");
      const length = new DataView((await reader.take(4)).buffer).getUint32(0);
      const maximumFrame = tag === RECORD
        ? maximumRecordPayloadBytes(limits.maxRecordBytes)
        : MAX_FOOTER_PAYLOAD_BYTES;
      if (length > maximumFrame) throw new RangeError("Sidecar frame exceeds limit");
      const payload = exact(
        await json(await reader.take(length), "Sidecar frame"),
        tag === RECORD ? ["ciphertext", "ordinal", "providerId"] : ["ciphertext"],
        "Sidecar frame",
      );
      if (tag === FOOTER) {
        const ciphertext = decode64Variable(payload.ciphertext, 17, 1024, "Footer ciphertext");
        let plain: Bytes;
        try {
          plain = new Uint8Array(
            await crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: nonce(prefix, 0xffffffff),
                additionalData: owned(encodeCanonicalJson({ headerSha256, type: "footer" })),
              },
              recordKey,
              ciphertext,
            ),
          );
        } catch {
          throw new TypeError("Sidecar footer authentication failed");
        }
        let footer: Record<string, unknown>;
        try {
          footer = exact(
            await json(plain, "Sidecar footer"),
            ["count", "recordsSha256"],
            "Sidecar footer",
          );
          if (
            footer.count !== expected ||
            footer.recordsSha256 !== await sha256Hex(encodeCanonicalJson(hashes))
          ) throw new TypeError("Sidecar footer does not match its records");
        } finally {
          plain.fill(0);
        }
        if ((await reader.take(1))[0] !== TERMINATOR || !(await reader.eof())) {
          throw new TypeError("Sidecar has invalid terminator or trailing bytes");
        }
        const summary = Object.freeze({
          header,
          recordCount: expected,
          recordsSha256: String(footer.recordsSha256),
        });
        await options.sink.commit(summary);
        committed = true;
        return summary;
      }
      if (
        !Number.isSafeInteger(payload.ordinal) || payload.ordinal !== expected ||
        typeof payload.providerId !== "string" || !UUID.test(payload.providerId) ||
        payload.providerId <= previous || expected >= limits.maxRecords
      ) throw new TypeError("Sidecar records are missing, duplicated, or out of order");
      const ciphertext = decode64Variable(
        payload.ciphertext,
        17,
        limits.maxRecordBytes + 16,
        "Record ciphertext",
      );
      let plain: Bytes;
      try {
        plain = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: nonce(prefix, expected),
              additionalData: owned(encodeCanonicalJson({
                headerSha256,
                ordinal: expected,
                providerId: payload.providerId,
                type: "record",
              })),
            },
            recordKey,
            ciphertext,
          ),
        );
      } catch {
        throw new TypeError("Sidecar record authentication failed");
      }
      let plainHash: string;
      let record: ProviderSecretRecord;
      try {
        if (plain.byteLength > limits.maxRecordBytes) {
          throw new RangeError("Provider secret record exceeds limit");
        }
        plainHash = await sha256Hex(plain);
        record = decodeProviderSecretRecordV1(plain, payload.providerId);
      } finally {
        plain.fill(0);
      }
      hashes.push(plainHash);
      previous = payload.providerId;
      expected++;
      pendingSecret = record.secret;
      try {
        await options.sink.write(record);
      } finally {
        pendingSecret.fill(0);
        pendingSecret = undefined;
      }
    }
  } catch (error) {
    if (begun && !committed) {
      try {
        await options.sink.abort(error);
      } catch {
        // Preserve the authentication/validation/staging failure that caused the abort.
      }
    }
    throw error;
  } finally {
    pendingSecret?.fill(0);
    dek?.fill(0);
    await reader.close().catch(() => undefined);
  }
}
