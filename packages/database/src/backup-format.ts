/** Portable, versioned backup metadata. This module deliberately has no database dependencies. */
export const BACKUP_FORMAT = "dg-chat-backup" as const;
export const BACKUP_FORMAT_VERSION = 1 as const;
export const DEFAULT_BACKUP_LIMITS = Object.freeze({
  maxArchiveBytes: 16 * 1024 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 4 * 1024 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxFrameHeaderBytes: 16 * 1024,
  maxNdjsonLineBytes: 8 * 1024 * 1024,
  maxNdjsonRecords: 10_000_000,
  maxInMemoryArchiveBytes: 64 * 1024 * 1024,
  streamChunkBytes: 64 * 1024,
  // Async producers are untrusted. Refuse a single allocation large enough to defeat the
  // streaming memory bound; direct Uint8Array convenience inputs are sliced by the consumer.
  maxSourceChunkBytes: 1024 * 1024,
});
export type BackupLimits = Readonly<typeof DEFAULT_BACKUP_LIMITS>;
export type BackupEntryKind = "json" | "ndjson" | "blob";
export interface BackupManifestEntryV1 {
  name: string;
  kind: BackupEntryKind;
  bytes: number;
  sha256: string;
  records?: number;
}
export interface BackupManifestSignature {
  algorithm: "hmac-sha256" | "ed25519";
  keyId: string;
  value: string;
}
export interface BackupManifestV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_FORMAT_VERSION;
  backupId: string;
  createdAt: string;
  appVersion: string;
  schemaVersion: string;
  mode: "system";
  secretPolicy: "redacted";
  diagnosticPayloadPolicy: "excluded" | "scrubbed" | "included";
  source: { installationId: string };
  objects: { count: number; bytes: number; indexSha256: string };
  requiredProviderKeyIds: string[];
  contentRootSha256: string;
  entries: BackupManifestEntryV1[];
  signature: BackupManifestSignature;
}
export interface BackupManifestAuthenticator {
  readonly algorithm: BackupManifestSignature["algorithm"];
  readonly keyId: string;
  sign(payload: Uint8Array): Promise<Uint8Array>;
  verify(payload: Uint8Array, signature: Uint8Array): Promise<boolean>;
}
const HEX_256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))
  ) throw new TypeError("Backup metadata has missing or unknown fields");
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
export function assertSafeBackupEntryName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" || !SAFE_NAME.test(name) || name.startsWith("/") ||
    name.split("/").some((part) => part === "" || part === "." || part === "..") ||
    name.includes("\\")
  ) throw new TypeError("Backup entry name is unsafe");
}
function safeInteger(value: unknown, maximum: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${label} is outside the supported range`);
  }
}
export function parseBackupManifestV1(
  input: unknown,
  limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
): BackupManifestV1 {
  const manifest = object(input, "Backup manifest");
  exactKeys(manifest, [
    "format",
    "version",
    "backupId",
    "createdAt",
    "appVersion",
    "schemaVersion",
    "mode",
    "secretPolicy",
    "diagnosticPayloadPolicy",
    "source",
    "objects",
    "requiredProviderKeyIds",
    "contentRootSha256",
    "entries",
    "signature",
  ]);
  if (manifest.format !== BACKUP_FORMAT) throw new TypeError("Unsupported backup format");
  if (manifest.version !== BACKUP_FORMAT_VERSION) {
    throw new TypeError("Unsupported backup format version");
  }
  if (typeof manifest.backupId !== "string" || !IDENTIFIER.test(manifest.backupId)) {
    throw new TypeError("Backup ID is invalid");
  }
  if (
    typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    new Date(manifest.createdAt).toISOString() !== manifest.createdAt
  ) throw new TypeError("Backup creation time must be a canonical ISO timestamp");
  if (
    typeof manifest.appVersion !== "string" || !IDENTIFIER.test(manifest.appVersion) ||
    typeof manifest.schemaVersion !== "string" || !IDENTIFIER.test(manifest.schemaVersion)
  ) throw new TypeError("Backup application or schema version is invalid");
  if (manifest.mode !== "system" || manifest.secretPolicy !== "redacted") {
    throw new TypeError("Backup mode or secret policy is unsupported");
  }
  if (
    manifest.diagnosticPayloadPolicy !== "excluded" &&
    manifest.diagnosticPayloadPolicy !== "scrubbed" &&
    manifest.diagnosticPayloadPolicy !== "included"
  ) throw new TypeError("Diagnostic payload policy is invalid");
  const source = object(manifest.source, "Backup source");
  exactKeys(source, ["installationId"]);
  if (
    typeof source.installationId !== "string" || source.installationId.length < 1 ||
    source.installationId.length > 256
  ) throw new TypeError("Backup source is invalid");
  const objects = object(manifest.objects, "Backup object summary");
  exactKeys(objects, ["count", "bytes", "indexSha256"]);
  safeInteger(objects.count, limits.maxEntries, "Backup object count");
  safeInteger(objects.bytes, limits.maxArchiveBytes, "Backup object bytes");
  if (typeof objects.indexSha256 !== "string" || !HEX_256.test(objects.indexSha256)) {
    throw new TypeError("Backup object index hash is invalid");
  }
  if (
    !Array.isArray(manifest.requiredProviderKeyIds) ||
    manifest.requiredProviderKeyIds.some((id) => typeof id !== "string" || !IDENTIFIER.test(id)) ||
    new Set(manifest.requiredProviderKeyIds).size !== manifest.requiredProviderKeyIds.length ||
    manifest.requiredProviderKeyIds.join() !== [...manifest.requiredProviderKeyIds].sort().join()
  ) throw new TypeError("Required provider key IDs must be unique and sorted");
  if (typeof manifest.contentRootSha256 !== "string" || !HEX_256.test(manifest.contentRootSha256)) {
    throw new TypeError("Backup content root is invalid");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length > limits.maxEntries) {
    throw new TypeError("Backup contains too many entries");
  }
  const names = new Set<string>();
  const entries = manifest.entries.map((raw): BackupManifestEntryV1 => {
    const entry = object(raw, "Backup entry");
    exactKeys(entry, ["name", "kind", "bytes", "sha256"], ["records"]);
    assertSafeBackupEntryName(entry.name);
    if (entry.name === "manifest.json" || names.has(entry.name)) {
      throw new TypeError("Backup entry names must be unique and cannot name the manifest");
    }
    names.add(entry.name);
    if (entry.kind !== "json" && entry.kind !== "ndjson" && entry.kind !== "blob") {
      throw new TypeError("Backup entry kind is invalid");
    }
    safeInteger(entry.bytes, limits.maxEntryBytes, "Backup entry size");
    if (typeof entry.sha256 !== "string" || !HEX_256.test(entry.sha256)) {
      throw new TypeError("Backup entry hash is invalid");
    }
    if (entry.kind === "ndjson") {
      safeInteger(entry.records, limits.maxNdjsonRecords, "Backup record count");
    } else if ("records" in entry) throw new TypeError("Only NDJSON entries have record counts");
    return entry as unknown as BackupManifestEntryV1;
  });
  const signature = object(manifest.signature, "Backup signature");
  exactKeys(signature, ["algorithm", "keyId", "value"]);
  if (
    (signature.algorithm !== "hmac-sha256" && signature.algorithm !== "ed25519") ||
    typeof signature.keyId !== "string" || !IDENTIFIER.test(signature.keyId) ||
    typeof signature.value !== "string" || !BASE64URL.test(signature.value)
  ) throw new TypeError("Backup signature is invalid");
  return Object.freeze({
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    schemaVersion: manifest.schemaVersion,
    mode: "system",
    secretPolicy: "redacted",
    diagnosticPayloadPolicy: manifest.diagnosticPayloadPolicy,
    source: Object.freeze({ ...source }) as BackupManifestV1["source"],
    objects: Object.freeze({ ...objects }) as BackupManifestV1["objects"],
    requiredProviderKeyIds: Object.freeze([...manifest.requiredProviderKeyIds]) as string[],
    contentRootSha256: manifest.contentRootSha256,
    entries: Object.freeze(
      entries.map((entry) => Object.freeze({ ...entry })),
    ) as unknown as BackupManifestEntryV1[],
    signature: Object.freeze({ ...signature }) as unknown as BackupManifestSignature,
  });
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function canonical(value: unknown, ancestors: Set<object>): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === undefined) throw new TypeError("Value is not JSON");
  if (ancestors.has(value)) throw new TypeError("Cyclic values are not JSON");
  ancestors.add(value);
  const result: Json = Array.isArray(value)
    ? value.map((item) => canonical(item, ancestors))
    : Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((
        key,
      ) => [key, canonical((value as Record<string, unknown>)[key], ancestors)]),
    );
  ancestors.delete(value);
  return result;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value, new Set()));
}
export function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
export async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeBase64Url(value: string): Uint8Array {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    return Uint8Array.from(
      atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw new TypeError("Backup signature encoding is invalid");
  }
}
export function unsignedBackupManifest(
  manifest: BackupManifestV1,
): Omit<BackupManifestV1, "signature"> {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}
export async function backupContentRoot(entries: BackupManifestEntryV1[]): Promise<string> {
  return await sha256Hex(encodeCanonicalJson(entries));
}
export async function signBackupManifest(
  manifest: Omit<BackupManifestV1, "signature">,
  authenticator: BackupManifestAuthenticator,
): Promise<BackupManifestV1> {
  return parseBackupManifestV1({
    ...manifest,
    signature: {
      algorithm: authenticator.algorithm,
      keyId: authenticator.keyId,
      value: base64Url(await authenticator.sign(encodeCanonicalJson(manifest))),
    },
  });
}
export async function verifyBackupManifest(
  manifest: BackupManifestV1,
  authenticator: BackupManifestAuthenticator,
): Promise<void> {
  const valid = parseBackupManifestV1(manifest);
  if (
    valid.signature.algorithm !== authenticator.algorithm ||
    valid.signature.keyId !== authenticator.keyId
  ) throw new TypeError("No trusted key is available for the backup signature");
  if (await backupContentRoot(valid.entries) !== valid.contentRootSha256) {
    throw new TypeError("Backup content root does not match");
  }
  if (
    !await authenticator.verify(
      encodeCanonicalJson(unsignedBackupManifest(valid)),
      decodeBase64Url(valid.signature.value),
    )
  ) throw new TypeError("Backup manifest signature does not match");
}
export async function createHmacBackupAuthenticator(
  keyId: string,
  secret: Uint8Array,
): Promise<BackupManifestAuthenticator> {
  if (!IDENTIFIER.test(keyId) || secret.byteLength < 32) {
    throw new TypeError("Backup signing key is invalid");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return {
    algorithm: "hmac-sha256",
    keyId,
    async sign(payload) {
      return new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(payload).buffer));
    },
    async verify(payload, signature) {
      return await crypto.subtle.verify(
        "HMAC",
        key,
        new Uint8Array(signature).buffer,
        new Uint8Array(payload).buffer,
      );
    },
  };
}

/** Ed25519 authenticator. A public-only instance can verify restores but cannot create exports. */
export function createEd25519BackupAuthenticator(
  keyId: string,
  publicKey: CryptoKey,
  privateKey?: CryptoKey,
): BackupManifestAuthenticator {
  if (
    !IDENTIFIER.test(keyId) || publicKey.algorithm.name !== "Ed25519" ||
    !publicKey.usages.includes("verify") ||
    (privateKey &&
      (privateKey.algorithm.name !== "Ed25519" || !privateKey.usages.includes("sign")))
  ) throw new TypeError("Ed25519 backup signing key is invalid");
  return {
    algorithm: "ed25519",
    keyId,
    async sign(payload) {
      if (!privateKey) throw new TypeError("The private backup signing key is unavailable");
      return new Uint8Array(
        await crypto.subtle.sign("Ed25519", privateKey, new Uint8Array(payload).buffer),
      );
    },
    async verify(payload, signature) {
      return await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        new Uint8Array(signature).buffer,
        new Uint8Array(payload).buffer,
      );
    },
  };
}
export function parseBoundedNdjson(
  bytes: Uint8Array,
  expectedRecords: number,
  limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
): unknown[] {
  if (bytes.byteLength > limits.maxEntryBytes) throw new TypeError("NDJSON entry is too large");
  safeInteger(expectedRecords, limits.maxNdjsonRecords, "Expected NDJSON record count");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("NDJSON must be valid UTF-8");
  }
  if (text.length > 0 && !text.endsWith("\n")) throw new TypeError("NDJSON is truncated");
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  if (lines.length !== expectedRecords) throw new TypeError("NDJSON record count does not match");
  return lines.map((line) => {
    if (new TextEncoder().encode(line).byteLength > limits.maxNdjsonLineBytes) {
      throw new TypeError("NDJSON line is too large");
    }
    if (line.trim() === "") throw new TypeError("NDJSON contains an empty record");
    try {
      return JSON.parse(line);
    } catch {
      throw new TypeError("NDJSON contains invalid JSON");
    }
  });
}
