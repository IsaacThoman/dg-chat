import { createApp } from "./app.ts";
import {
  backfillLegacyRuntimeSnapshot,
  MemoryRepository,
  objectStoreFromEnv,
  PostgresRepository,
} from "@dg-chat/database";
import { MemoryRateLimiter, RedisRateLimiter } from "./rate-limit.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";
import { MemoryCircuitBreaker, RedisCircuitBreaker } from "./provider-circuit.ts";
import { ocrCacheFailureModeFromEnv, RedisOcrCache } from "./ocr-cache.ts";

const port = Number(Deno.env.get("PORT") ?? 8000);
const providerKeyring = ProviderSecretKeyring.fromEnv();
if (Deno.env.get("DENO_ENV") === "production" && !providerKeyring) {
  throw new Error(
    "Production requires ENCRYPTION_KEY or ENCRYPTION_KEYRING with ENCRYPTION_PRIMARY_KEY_ID",
  );
}
const databaseUrl = Deno.env.get("DATABASE_URL");
if (databaseUrl) {
  const backfill = await backfillLegacyRuntimeSnapshot(databaseUrl);
  if (backfill.status === "imported") {
    console.log(
      JSON.stringify({ level: "info", message: "Legacy repository imported", ...backfill }),
    );
  }
}
const repository = databaseUrl
  ? await PostgresRepository.connect(databaseUrl)
  : new MemoryRepository();
const rateLimiter = Deno.env.get("REDIS_URL")
  ? new RedisRateLimiter(Deno.env.get("REDIS_URL")!)
  : new MemoryRateLimiter();
const circuitBreaker = Deno.env.get("REDIS_URL")
  ? new RedisCircuitBreaker(Deno.env.get("REDIS_URL")!)
  : new MemoryCircuitBreaker();
const ocrCache = Deno.env.get("REDIS_URL")
  ? new RedisOcrCache(Deno.env.get("REDIS_URL")!, {
    failureMode: ocrCacheFailureModeFromEnv(Deno.env.get("OCR_CACHE_FAILURE_MODE")),
  })
  : undefined;
const objectStore = objectStoreFromEnv();
const { app } = createApp({
  repository,
  rateLimiter,
  objectStore,
  providerKeyring,
  circuitBreaker,
  ocrCache,
});
const replayMaintenance = setInterval(async () => {
  try {
    const reaped = await repository.reapStaleApiRequests(100);
    const reapedGenerations = await repository.reapStaleGenerations(100);
    const reapedProviderRuns = await repository.reapStaleProviderExecutionLeases(100);
    const pruned = await repository.pruneExpiredApiRequests(100);
    if (reaped || reapedGenerations || reapedProviderRuns || pruned) {
      console.log(JSON.stringify({
        level: "info",
        message: "Replay maintenance",
        reaped,
        reapedGenerations,
        reapedProviderRuns,
        pruned,
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "Replay maintenance failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}, 60_000);
console.log(JSON.stringify({ level: "info", message: "API listening", port }));
const server = Deno.serve({ port, onListen: () => {} }, app.fetch);
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  clearInterval(replayMaintenance);
  console.log(JSON.stringify({ level: "info", message: "API shutting down", signal }));
  await server.shutdown();
  await Promise.all([
    repository.close(),
    rateLimiter.close(),
    circuitBreaker.close(),
    ocrCache?.close(),
    objectStore?.close(),
  ]);
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => void shutdown(signal));
}
