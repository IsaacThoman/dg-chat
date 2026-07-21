import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  attachmentExternalInspectionRequiredFromEnv,
  attachmentStorageQuotaFromEnv,
  DEFAULT_ATTACHMENT_STORAGE_QUOTA,
} from "./attachment-storage-config.ts";

Deno.test("attachment scanner enablement is strict and shared with upload policy", () => {
  assertEquals(attachmentExternalInspectionRequiredFromEnv({}), false);
  assertEquals(
    attachmentExternalInspectionRequiredFromEnv({ ATTACHMENT_SCANNER_ENABLED: " false " }),
    false,
  );
  assertEquals(
    attachmentExternalInspectionRequiredFromEnv({ ATTACHMENT_SCANNER_ENABLED: "true" }),
    true,
  );
  for (const value of ["1", "yes", "enabled", "tru", "falsey", "TRUE", "False"]) {
    assertThrows(() =>
      attachmentExternalInspectionRequiredFromEnv({ ATTACHMENT_SCANNER_ENABLED: value })
    );
  }
});

Deno.test("attachment storage quota uses bounded deployment defaults", () => {
  assertEquals(attachmentStorageQuotaFromEnv({}), DEFAULT_ATTACHMENT_STORAGE_QUOTA);
  assertEquals(
    attachmentStorageQuotaFromEnv({
      ATTACHMENT_STORAGE_PER_USER_BYTES: "1048576",
      ATTACHMENT_STORAGE_PER_USER_OBJECTS: "12",
      ATTACHMENT_STORAGE_INSTALLATION_BYTES: "2097152",
      ATTACHMENT_STORAGE_INSTALLATION_OBJECTS: "24",
    }),
    {
      perUserBytes: 1_048_576,
      perUserObjects: 12,
      installationBytes: 2_097_152,
      installationObjects: 24,
    },
  );
});

Deno.test("attachment storage quota rejects ambiguous or unsafe values", () => {
  for (
    const env of [
      { ATTACHMENT_STORAGE_PER_USER_BYTES: "0" },
      { ATTACHMENT_STORAGE_PER_USER_BYTES: "1.5" },
      { ATTACHMENT_STORAGE_PER_USER_BYTES: " 1024 " },
      { ATTACHMENT_STORAGE_PER_USER_OBJECTS: "0" },
      { ATTACHMENT_STORAGE_PER_USER_OBJECTS: "1.5" },
      { ATTACHMENT_STORAGE_INSTALLATION_BYTES: "9007199254740992" },
      {
        ATTACHMENT_STORAGE_PER_USER_BYTES: "2097152",
        ATTACHMENT_STORAGE_INSTALLATION_BYTES: "1048576",
      },
      {
        ATTACHMENT_STORAGE_PER_USER_OBJECTS: "20",
        ATTACHMENT_STORAGE_INSTALLATION_OBJECTS: "10",
      },
    ]
  ) {
    assertThrows(() => attachmentStorageQuotaFromEnv(env));
  }
});
