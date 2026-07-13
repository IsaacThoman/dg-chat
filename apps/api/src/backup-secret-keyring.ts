import {
  importProviderSecretKek,
  type ProviderSecretKek,
  type ProviderSecretKekResolver,
} from "@dg-chat/database";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CANONICAL_32_BYTE_BASE64 = /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/u;

/** Narrow CryptoKey-only boundary consumed by the privileged sidecar format. */
export interface PrivilegedBackupSecretKeyring extends ProviderSecretKekResolver {
  readonly primaryKeyId: string;
  primary(): Promise<ProviderSecretKek>;
}

export interface PrivilegedBackupSecretConfig {
  readonly enabled: boolean;
  readonly keyring?: PrivilegedBackupSecretKeyring;
}

function parseBoolean(raw: string | undefined): boolean {
  const value = raw?.trim();
  if (!value) return false;
  if (value !== "true" && value !== "false") {
    throw new Error("ENABLE_PRIVILEGED_SECRET_BACKUPS must be true or false");
  }
  return value === "true";
}

function decodeKey(value: string, variable: string): Uint8Array {
  if (!CANONICAL_32_BYTE_BASE64.test(value)) {
    throw new Error(`${variable} values must be exactly 32 bytes encoded as canonical base64`);
  }
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.byteLength !== 32) throw new Error();
    return bytes;
  } catch {
    throw new Error(`${variable} values must be exactly 32 bytes encoded as canonical base64`);
  }
}

function parseJsonKeyring(serialized: string): Map<string, Uint8Array> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("BACKUP_SECRET_KEYRING must be a JSON object of key IDs to base64 keys");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BACKUP_SECRET_KEYRING must be a JSON object of key IDs to base64 keys");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("BACKUP_SECRET_KEYRING must not be empty");
  const keys = new Map<string, Uint8Array>();
  try {
    for (const [id, value] of entries) {
      if (!KEY_ID.test(id)) throw new Error("BACKUP_SECRET_KEYRING contains an invalid key ID");
      if (typeof value !== "string") {
        throw new Error("BACKUP_SECRET_KEYRING values must be strings");
      }
      keys.set(id, decodeKey(value, "BACKUP_SECRET_KEYRING"));
    }
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    throw error;
  }
  return keys;
}

function decodeProviderKey(value: string): Uint8Array {
  try {
    const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== 32) {
      decoded.fill(0);
      throw new Error();
    }
    return decoded;
  } catch {
    throw new Error("Provider encryption keys must be valid base64 and exactly 32 bytes");
  }
}

function equalKey(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < Math.max(left.byteLength, right.byteLength); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function configuredForeignKeys(env: Record<string, string | undefined>): Uint8Array[] {
  const values: Uint8Array[] = [];
  for (const variable of ["ENCRYPTION_KEYRING"] as const) {
    try {
      const parsed = JSON.parse(env[variable]?.trim() || "null");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed)) {
          if (typeof value === "string") values.push(decodeProviderKey(value));
        }
      }
    } catch {
      // The provider-keyring parser owns reporting malformed provider configuration.
    }
  }
  for (const variable of ["ENCRYPTION_KEY", "BACKUP_SIGNING_KEY"] as const) {
    const value = env[variable]?.trim();
    if (value) {
      try {
        values.push(
          variable === "ENCRYPTION_KEY" ? decodeProviderKey(value) : decodeKey(value, variable),
        );
      } catch {
        // The owning parser reports malformed foreign-domain keys.
      }
    }
  }
  return values;
}

class CryptoKeyring implements PrivilegedBackupSecretKeyring {
  readonly primaryKeyId: string;
  readonly #imported: ReadonlyMap<string, Promise<CryptoKey>>;

  constructor(primaryKeyId: string, raw: ReadonlyMap<string, Uint8Array>) {
    this.primaryKeyId = primaryKeyId;
    const imported = new Map<string, Promise<CryptoKey>>();
    for (const [id, source] of raw) {
      // importProviderSecretKek snapshots its input synchronously before its first await. Keep the
      // hand-off copy scoped to this iteration and erase it immediately after starting import.
      const handoff = source.slice();
      try {
        imported.set(id, importProviderSecretKek(handoff));
      } finally {
        handoff.fill(0);
      }
    }
    this.#imported = imported;
  }

  async primary(): Promise<ProviderSecretKek> {
    return { keyId: this.primaryKeyId, key: (await this.resolve(this.primaryKeyId))! };
  }

  async resolve(keyId: string): Promise<CryptoKey | undefined> {
    return await this.#imported.get(keyId);
  }
}

/** Parse recovery-key configuration without reading process-global environment state. */
export function privilegedBackupSecretConfig(
  env: Record<string, string | undefined>,
): PrivilegedBackupSecretConfig {
  const enabled = parseBoolean(env.ENABLE_PRIVILEGED_SECRET_BACKUPS);
  const serialized = env.BACKUP_SECRET_KEYRING?.trim();
  const primaryKeyId = env.BACKUP_SECRET_PRIMARY_KEY_ID?.trim();
  if (!serialized && !primaryKeyId) {
    if (enabled) {
      throw new Error(
        "BACKUP_SECRET_KEYRING and BACKUP_SECRET_PRIMARY_KEY_ID are required when privileged secret backups are enabled",
      );
    }
    return { enabled: false };
  }
  if (!serialized || !primaryKeyId) {
    throw new Error(
      "BACKUP_SECRET_KEYRING and BACKUP_SECRET_PRIMARY_KEY_ID must be configured together",
    );
  }
  if (!KEY_ID.test(primaryKeyId)) {
    throw new Error("BACKUP_SECRET_PRIMARY_KEY_ID must be a stable identifier");
  }
  const keys = parseJsonKeyring(serialized);
  const foreignKeys = configuredForeignKeys(env);
  try {
    if (!keys.has(primaryKeyId)) {
      throw new Error("BACKUP_SECRET_PRIMARY_KEY_ID is missing from BACKUP_SECRET_KEYRING");
    }
    if ([...keys.values()].some((key) => foreignKeys.some((foreign) => equalKey(key, foreign)))) {
      throw new Error(
        "Privileged backup recovery keys must be independent from provider encryption and backup signing keys",
      );
    }
    return { enabled, keyring: new CryptoKeyring(primaryKeyId, keys) };
  } finally {
    for (const key of keys.values()) key.fill(0);
    for (const key of foreignKeys) key.fill(0);
  }
}
