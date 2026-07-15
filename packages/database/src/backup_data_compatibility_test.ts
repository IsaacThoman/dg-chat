import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  BACKUP_DATA_SCHEMA_VERSION,
  BACKUP_DATA_TABLES,
  isSupportedBackupDataSchemaVersion,
} from "./backup-data.ts";

Deno.test("portable backup catalog versions user authority and retains supported history", () => {
  assertEquals(BACKUP_DATA_SCHEMA_VERSION, "0039");
  assertEquals(
    ["0039", "0038", "0037", "0034", "0033", "0032", "0028", "0036", "0027"].map(
      (version) => isSupportedBackupDataSchemaVersion(version),
    ),
    [true, true, true, true, true, true, true, false, false],
  );
  const users = BACKUP_DATA_TABLES.find((table) => table.name === "users");
  assertEquals(users?.columns.includes("version"), true);
  assertEquals(users?.kinds.version, "integer");
  const adjustments = BACKUP_DATA_TABLES.find((table) =>
    table.name === "admin_balance_adjustments"
  );
  assertEquals(adjustments?.kinds.amount_micros, "bigint");
  assertEquals(adjustments?.columns.includes("idempotency_key_hash"), true);
  const ledger = BACKUP_DATA_TABLES.find((table) => table.name === "ledger_entries");
  assertEquals(ledger?.kinds.sequence, "bigint");
});
