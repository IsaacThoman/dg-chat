import type { AttachmentStorageQuota } from "@dg-chat/database";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MAX_QUOTA_BYTES = 1024 * 1024 * GIB;
const MAX_QUOTA_OBJECTS = 1_000_000_000;

export const DEFAULT_ATTACHMENT_STORAGE_QUOTA: AttachmentStorageQuota = {
  perUserBytes: 5 * GIB,
  perUserObjects: 10_000,
  installationBytes: 100 * GIB,
  installationObjects: 1_000_000,
};

export function attachmentExternalInspectionRequiredFromEnv(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env.ATTACHMENT_SCANNER_ENABLED?.trim();
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error("ATTACHMENT_SCANNER_ENABLED must be true or false");
}

function quotaBytes(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a whole number of bytes`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < MIB || parsed > MAX_QUOTA_BYTES) {
    throw new Error(`${name} must be between 1048576 and ${MAX_QUOTA_BYTES} bytes`);
  }
  return parsed;
}

function quotaObjects(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive whole number`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_QUOTA_OBJECTS) {
    throw new Error(`${name} must be between 1 and ${MAX_QUOTA_OBJECTS}`);
  }
  return parsed;
}

export function attachmentStorageQuotaFromEnv(
  env: Record<string, string | undefined>,
): AttachmentStorageQuota {
  const quota = {
    perUserBytes: quotaBytes(
      env.ATTACHMENT_STORAGE_PER_USER_BYTES,
      "ATTACHMENT_STORAGE_PER_USER_BYTES",
      DEFAULT_ATTACHMENT_STORAGE_QUOTA.perUserBytes,
    ),
    perUserObjects: quotaObjects(
      env.ATTACHMENT_STORAGE_PER_USER_OBJECTS,
      "ATTACHMENT_STORAGE_PER_USER_OBJECTS",
      DEFAULT_ATTACHMENT_STORAGE_QUOTA.perUserObjects,
    ),
    installationBytes: quotaBytes(
      env.ATTACHMENT_STORAGE_INSTALLATION_BYTES,
      "ATTACHMENT_STORAGE_INSTALLATION_BYTES",
      DEFAULT_ATTACHMENT_STORAGE_QUOTA.installationBytes,
    ),
    installationObjects: quotaObjects(
      env.ATTACHMENT_STORAGE_INSTALLATION_OBJECTS,
      "ATTACHMENT_STORAGE_INSTALLATION_OBJECTS",
      DEFAULT_ATTACHMENT_STORAGE_QUOTA.installationObjects,
    ),
  };
  if (quota.installationBytes < quota.perUserBytes) {
    throw new Error(
      "ATTACHMENT_STORAGE_INSTALLATION_BYTES must be at least ATTACHMENT_STORAGE_PER_USER_BYTES",
    );
  }
  if (quota.installationObjects < quota.perUserObjects) {
    throw new Error(
      "ATTACHMENT_STORAGE_INSTALLATION_OBJECTS must be at least ATTACHMENT_STORAGE_PER_USER_OBJECTS",
    );
  }
  return quota;
}
