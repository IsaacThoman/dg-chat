import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  BACKUP_DATA_SCHEMA_VERSION,
  BACKUP_DATA_TABLES,
  BACKUP_EPHEMERAL_TABLES,
  isCanonicalManifestOnlyAttachmentMetadata,
  isSupportedBackupDataSchemaVersion,
} from "./backup-data.ts";

Deno.test("portable backup catalog versions user authority and retains supported history", () => {
  assertEquals(BACKUP_DATA_SCHEMA_VERSION, "0050");
  assertEquals(
    [
      "0050",
      "0049",
      "0045",
      "0043",
      "0039",
      "0038",
      "0037",
      "0034",
      "0033",
      "0032",
      "0028",
      "0036",
      "0027",
    ]
      .map(
        (version) => isSupportedBackupDataSchemaVersion(version),
      ),
    [true, true, true, true, true, true, true, true, true, true, true, false, false],
  );
  const users = BACKUP_DATA_TABLES.find((table) => table.name === "users");
  assertEquals(users?.columns.includes("version"), true);
  assertEquals(users?.kinds.version, "integer");
  assertEquals(users?.kinds.authority_epoch, "bigint");
  const tokens = BACKUP_DATA_TABLES.find((table) => table.name === "api_tokens");
  assertEquals(tokens?.kinds.authority_epoch, "bigint");
  const adjustments = BACKUP_DATA_TABLES.find((table) =>
    table.name === "admin_balance_adjustments"
  );
  assertEquals(adjustments?.kinds.amount_micros, "bigint");
  assertEquals(adjustments?.columns.includes("idempotency_key_hash"), true);
  const ledger = BACKUP_DATA_TABLES.find((table) => table.name === "ledger_entries");
  assertEquals(ledger?.kinds.sequence, "bigint");
  const usage = BACKUP_DATA_TABLES.find((table) => table.name === "usage_runs");
  assertEquals(usage?.columns.includes("recovery_owner"), true);
  const retentionSchedule = BACKUP_DATA_TABLES.find((table) =>
    table.name === "retention_schedule_state"
  );
  assertEquals(retentionSchedule?.kinds.interval_seconds, "integer");
  assertEquals(retentionSchedule?.kinds.last_run_id, "uuid");
  const attachments = BACKUP_DATA_TABLES.find((table) => table.name === "attachments");
  assertEquals(attachments?.kinds.inspection_epoch, "integer");
  assertEquals(attachments?.kinds.version, "integer");
  const storageInstallation = BACKUP_DATA_TABLES.find((table) =>
    table.name === "attachment_storage_installation"
  );
  assertEquals(storageInstallation?.kinds.physical_bytes, "bigint");
  const storageBlobs = BACKUP_DATA_TABLES.find((table) =>
    table.name === "attachment_storage_blobs"
  );
  assertEquals(storageBlobs?.kinds.size_bytes, "bigint");
  assertEquals(
    ["generated_object_staging", "file_upload_staging", "attachment_upload_staging"].every(
      (name) => BACKUP_EPHEMERAL_TABLES.includes(name as never),
    ),
    true,
  );
});

Deno.test("manifest-only compatibility requires the exact server-authored metadata shape", () => {
  const ownerId = "10000000-0000-4000-8000-000000000001";
  const attachmentId = "20000000-0000-4000-8000-000000000001";
  const canonical = {
    id: attachmentId,
    owner_id: ownerId,
    object_key: `imports/${ownerId}/${attachmentId}/manifest-only`,
    state: "failed",
    deleted_at: "2026-07-17T00:00:00.000Z",
    inspection_error: "Attachment bytes were not included in the .dgchat manifest",
    ingestion_status: "failed",
    ingestion_error: "Attachment bytes require a separate restore",
    ingested_at: null,
  };
  assertEquals(isCanonicalManifestOnlyAttachmentMetadata(canonical), true);
  for (
    const mutation of [
      { object_key: `imports/${ownerId}/${attachmentId}/not-canonical` },
      { state: "deleted" },
      { deleted_at: null },
      { inspection_error: null },
      { ingestion_status: "not_applicable" },
      { ingestion_error: null },
      { ingested_at: "2026-07-17T00:00:00.000Z" },
    ]
  ) {
    assertEquals(isCanonicalManifestOnlyAttachmentMetadata({ ...canonical, ...mutation }), false);
  }
});
