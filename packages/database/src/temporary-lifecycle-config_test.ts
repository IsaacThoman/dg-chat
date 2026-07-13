import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { parseTemporaryLifecycleConfig } from "./temporary-lifecycle-config.ts";

Deno.test("temporary lifecycle configuration defaults and validates bounded values", () => {
  assertEquals(parseTemporaryLifecycleConfig(), {
    retentionDays: 30,
    purgeIntervalMs: 300_000,
    purgeBatchSize: 100,
  });
  assertEquals(
    parseTemporaryLifecycleConfig({
      TEMPORARY_CHAT_RETENTION_DAYS: "7",
      TEMPORARY_CHAT_PURGE_INTERVAL_SECONDS: "10",
      TEMPORARY_CHAT_PURGE_BATCH_SIZE: "1",
    }),
    { retentionDays: 7, purgeIntervalMs: 10_000, purgeBatchSize: 1 },
  );
  for (
    const environment of [
      { TEMPORARY_CHAT_RETENTION_DAYS: "0" },
      { TEMPORARY_CHAT_RETENTION_DAYS: "1.5" },
      { TEMPORARY_CHAT_PURGE_INTERVAL_SECONDS: "9" },
      { TEMPORARY_CHAT_PURGE_BATCH_SIZE: "1001" },
    ]
  ) assertThrows(() => parseTemporaryLifecycleConfig(environment), TypeError);
});
