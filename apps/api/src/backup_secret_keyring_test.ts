import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { privilegedBackupSecretConfig } from "./backup-secret-keyring.ts";

const key = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const env = (primary = "recovery-2026-07"): Record<string, string | undefined> => ({
  ENABLE_PRIVILEGED_SECRET_BACKUPS: "true",
  BACKUP_SECRET_KEYRING: JSON.stringify({ "recovery-2026-01": key(1), "recovery-2026-07": key(2) }),
  BACKUP_SECRET_PRIMARY_KEY_ID: primary,
  ENCRYPTION_KEYRING: JSON.stringify({ provider: key(3) }),
  BACKUP_SIGNING_KEY: key(4),
});

Deno.test("privileged backup config defaults off and fails closed when enabled incomplete", () => {
  assertEquals(privilegedBackupSecretConfig({}), { enabled: false });
  assertThrows(
    () => privilegedBackupSecretConfig({ ENABLE_PRIVILEGED_SECRET_BACKUPS: "true" }),
    Error,
    "are required",
  );
  assertThrows(
    () => privilegedBackupSecretConfig({ ENABLE_PRIVILEGED_SECRET_BACKUPS: "yes" }),
    Error,
    "must be true or false",
  );
  assertThrows(
    () => privilegedBackupSecretConfig({ BACKUP_SECRET_KEYRING: "{}" }),
    Error,
    "configured together",
  );
});

Deno.test("privileged backup keyring strictly validates IDs, material, and primary lookup", () => {
  for (
    const invalid of [
      { ...env(), BACKUP_SECRET_KEYRING: "[]" },
      { ...env(), BACKUP_SECRET_KEYRING: "{}" },
      { ...env(), BACKUP_SECRET_KEYRING: JSON.stringify({ "bad id": key(1) }) },
      { ...env(), BACKUP_SECRET_KEYRING: JSON.stringify({ valid: "not-base64" }) },
      { ...env(), BACKUP_SECRET_PRIMARY_KEY_ID: "missing" },
    ]
  ) assertThrows(() => privilegedBackupSecretConfig(invalid));
});

Deno.test("privileged recovery keys cannot reuse provider or signing key material", () => {
  assertThrows(
    () => privilegedBackupSecretConfig({ ...env(), ENCRYPTION_KEY: key(2) }),
    Error,
    "must be independent",
  );
  assertThrows(
    () => privilegedBackupSecretConfig({ ...env(), BACKUP_SIGNING_KEY: key(1) }),
    Error,
    "must be independent",
  );
  assertThrows(
    () =>
      privilegedBackupSecretConfig({
        ...env(),
        ENCRYPTION_KEYRING: JSON.stringify({ provider: key(2).replace(/=+$/u, "") }),
      }),
    Error,
    "must be independent",
  );
});

Deno.test("privileged backup keyring selects primary and resolves retained rotation keys", async () => {
  const configured = privilegedBackupSecretConfig(env());
  assertEquals(configured.enabled, true);
  assertEquals(configured.keyring!.primaryKeyId, "recovery-2026-07");
  const primary = await configured.keyring!.primary();
  assertEquals(primary.keyId, "recovery-2026-07");
  assertNotEquals(await configured.keyring!.resolve("recovery-2026-01"), undefined);
  assertEquals(await configured.keyring!.resolve("retired"), undefined);
  assertEquals(primary.key.extractable, false);
  assertEquals([...primary.key.usages].sort(), ["decrypt", "encrypt"]);
  assertEquals(Object.getOwnPropertyNames(configured.keyring), ["primaryKeyId"]);
});
