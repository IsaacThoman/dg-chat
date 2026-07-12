import { type BackupManifestAuthenticator, createHmacBackupAuthenticator } from "@dg-chat/database";

const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface BackupRuntimeConfig {
  enabled: boolean;
  restoreEnabled: boolean;
  maxUploadBytes: number;
  authenticator?: BackupManifestAuthenticator;
}

function booleanValue(env: Record<string, string | undefined>, name: string, fallback = false) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (raw !== "true" && raw !== "false") throw new Error(`${name} must be true or false`);
  return raw === "true";
}

function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  maximum: number,
) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return value;
}

function decodeSigningKey(raw: string): Uint8Array {
  // Require canonical, padded standard base64. This catches accidentally pasted text and
  // prevents two textual configurations from ambiguously naming the same key material.
  if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/u.test(raw)) {
    throw new Error("BACKUP_SIGNING_KEY must be exactly 32 bytes encoded as canonical base64");
  }
  let binary: string;
  try {
    binary = atob(raw);
  } catch {
    throw new Error("BACKUP_SIGNING_KEY must be exactly 32 bytes encoded as canonical base64");
  }
  const bytes = Uint8Array.from(binary, (part) => part.charCodeAt(0));
  if (bytes.byteLength !== 32) {
    throw new Error("BACKUP_SIGNING_KEY must be exactly 32 bytes encoded as canonical base64");
  }
  return bytes;
}

/** Parse fail-closed backup configuration without reading global process state. */
export async function backupRuntimeConfig(
  env: Record<string, string | undefined>,
  options: { dependenciesAvailable: boolean; production: boolean },
): Promise<BackupRuntimeConfig> {
  const restoreEnabled = booleanValue(env, "ALLOW_IN_APP_RESTORE");
  const maxUploadBytes = positiveInteger(
    env,
    "BACKUP_MAX_UPLOAD_BYTES",
    DEFAULT_MAX_UPLOAD_BYTES,
    MAX_MAX_UPLOAD_BYTES,
  );
  const keyValue = env.BACKUP_SIGNING_KEY?.trim();
  const keyId = env.BACKUP_SIGNING_KEY_ID?.trim() || "installation-v1";

  if (!options.dependenciesAvailable) {
    if (restoreEnabled) {
      throw new Error("ALLOW_IN_APP_RESTORE requires PostgreSQL and S3-compatible object storage");
    }
    return { enabled: false, restoreEnabled: false, maxUploadBytes };
  }
  if (!keyValue) {
    if (options.production || restoreEnabled) {
      throw new Error("BACKUP_SIGNING_KEY is required when application backups are enabled");
    }
    return { enabled: false, restoreEnabled: false, maxUploadBytes };
  }
  if (!KEY_ID.test(keyId)) {
    throw new Error("BACKUP_SIGNING_KEY_ID must be a stable identifier");
  }
  const authenticator = await createHmacBackupAuthenticator(keyId, decodeSigningKey(keyValue));
  return { enabled: true, restoreEnabled, maxUploadBytes, authenticator };
}
