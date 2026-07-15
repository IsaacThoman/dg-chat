import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  BACKUP_DATA_SCHEMA_VERSION,
  BACKUP_DATA_TABLES,
  isSupportedBackupDataSchemaVersion,
} from "./backup-data.ts";

Deno.test("portable backup catalog versions user authority and retains supported history", () => {
  assertEquals(BACKUP_DATA_SCHEMA_VERSION, "0037");
  assertEquals(
    ["0037", "0034", "0033", "0032", "0028", "0036", "0027"].map((version) =>
      isSupportedBackupDataSchemaVersion(version)
    ),
    [true, true, true, true, true, false, false],
  );
  const users = BACKUP_DATA_TABLES.find((table) => table.name === "users");
  assertEquals(users?.columns.includes("version"), true);
  assertEquals(users?.kinds.version, "integer");
});
