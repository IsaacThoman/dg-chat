import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { backupRuntimeConfig } from "./backup-config.ts";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

Deno.test("backup config is disabled without dependencies and rejects unsafe restore opt-in", async () => {
  assertEquals(
    await backupRuntimeConfig({}, {
      dependenciesAvailable: false,
      production: false,
    }),
    {
      enabled: false,
      restoreEnabled: false,
      maxUploadBytes: 1_073_741_824,
    },
  );
  await assertRejects(
    () =>
      backupRuntimeConfig({ ALLOW_IN_APP_RESTORE: "true" }, {
        dependenciesAvailable: false,
        production: false,
      }),
    Error,
    "requires PostgreSQL",
  );
});

Deno.test("backup config strictly validates signing and bounded upload settings", async () => {
  const configured = await backupRuntimeConfig({
    BACKUP_SIGNING_KEY: key,
    BACKUP_SIGNING_KEY_ID: "installation-2026-07",
    BACKUP_MAX_UPLOAD_BYTES: "67108864",
    ALLOW_IN_APP_RESTORE: "true",
  }, { dependenciesAvailable: true, production: true });
  assertEquals(configured.enabled, true);
  assertEquals(configured.restoreEnabled, true);
  assertEquals(configured.maxUploadBytes, 67_108_864);
  assertEquals(configured.authenticator?.keyId, "installation-2026-07");

  for (
    const env of [
      { BACKUP_SIGNING_KEY: "not-base64" },
      { BACKUP_SIGNING_KEY: key, BACKUP_SIGNING_KEY_ID: "spaces are unsafe" },
      { BACKUP_SIGNING_KEY: key, ALLOW_IN_APP_RESTORE: "yes" },
      { BACKUP_SIGNING_KEY: key, BACKUP_MAX_UPLOAD_BYTES: "0" },
      { BACKUP_SIGNING_KEY: key, BACKUP_MAX_UPLOAD_BYTES: "17179869185" },
    ]
  ) {
    await assertRejects(() =>
      backupRuntimeConfig(env, { dependenciesAvailable: true, production: true })
    );
  }
});

Deno.test("production dependencies require an explicit backup signing key", async () => {
  await assertRejects(
    () => backupRuntimeConfig({}, { dependenciesAvailable: true, production: true }),
    Error,
    "BACKUP_SIGNING_KEY is required",
  );
});
