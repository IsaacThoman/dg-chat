import { createApp } from "./app.ts";
import {
  backfillLegacyRuntimeSnapshot,
  MemoryRepository,
  objectStoreFromEnv,
  PostgresRepository,
  PostgresToolExecutionStore,
  reconcileBetterAuthIdentities,
} from "@dg-chat/database";
import { MemoryRateLimiter, RedisRateLimiter } from "./rate-limit.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";
import { MemoryCircuitBreaker, RedisCircuitBreaker } from "./provider-circuit.ts";
import { ocrCacheFailureModeFromEnv, RedisOcrCache } from "./ocr-cache.ts";
import {
  MemoryAudioConcurrencyLimiter,
  RedisAudioConcurrencyLimiter,
} from "./audio-concurrency.ts";
import { createBetterAuthService } from "./better-auth.ts";
import { smtpIdentityMailer } from "./mail.ts";

const port = Number(Deno.env.get("PORT") ?? 8000);
const providerKeyring = ProviderSecretKeyring.fromEnv();
if (Deno.env.get("DENO_ENV") === "production" && !providerKeyring) {
  throw new Error(
    "Production requires ENCRYPTION_KEY or ENCRYPTION_KEYRING with ENCRYPTION_PRIMARY_KEY_ID",
  );
}
const databaseUrl = Deno.env.get("DATABASE_URL");
const production = Deno.env.get("DENO_ENV") === "production";
if (production && !databaseUrl) throw new Error("Production requires DATABASE_URL");
if (databaseUrl) {
  const backfill = await backfillLegacyRuntimeSnapshot(databaseUrl);
  if (backfill.status === "imported") {
    console.log(
      JSON.stringify({ level: "info", message: "Legacy repository imported", ...backfill }),
    );
  }
  const reconciliation = await reconcileBetterAuthIdentities(databaseUrl);
  if (
    reconciliation.usersInserted || reconciliation.credentialsInserted
  ) {
    console.log(JSON.stringify({
      level: "info",
      message: "Better Auth identities reconciled",
      ...reconciliation,
    }));
  }
}
const repository = databaseUrl
  ? await PostgresRepository.connect(databaseUrl)
  : new MemoryRepository();
const toolExecutionStore = databaseUrl
  ? PostgresToolExecutionStore.connect(databaseUrl)
  : undefined;
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
const audioConcurrencyLeaseMs = Number(
  Deno.env.get("AUDIO_CONCURRENCY_LEASE_SECONDS") ?? 120,
) * 1_000;
const audioConcurrencyLimiter = Deno.env.get("REDIS_URL")
  ? new RedisAudioConcurrencyLimiter(Deno.env.get("REDIS_URL")!, {
    leaseMs: audioConcurrencyLeaseMs,
  })
  : new MemoryAudioConcurrencyLimiter({ leaseMs: audioConcurrencyLeaseMs });
const objectStore = objectStoreFromEnv();
const requireEmailVerification = Deno.env.get("REQUIRE_EMAIL_VERIFICATION") === "true";
const mailer = Deno.env.get("SMTP_URL")
  ? smtpIdentityMailer(
    Deno.env.get("SMTP_URL")!,
    Deno.env.get("SMTP_FROM") ?? "DG Chat <no-reply@localhost>",
  )
  : undefined;
const appSecret = Deno.env.get("APP_SECRET");
if (databaseUrl && (!appSecret || new TextEncoder().encode(appSecret).byteLength < 32)) {
  throw new Error("PostgreSQL authentication requires APP_SECRET with at least 32 bytes");
}
const webOrigin = new URL(
  Deno.env.get("WEB_ORIGIN") ?? Deno.env.get("WEB_URL") ??
    "http://localhost:5173",
).origin;
const appUrl = new URL(
  Deno.env.get("PUBLIC_API_ORIGIN") ?? Deno.env.get("APP_URL") ??
    "http://localhost:8000",
).origin;
const browserAuth = databaseUrl
  ? createBetterAuthService({
    databaseUrl,
    repository,
    secret: appSecret!,
    appUrl,
    webOrigin,
    requireEmailVerification,
    sendVerificationEmail: mailer
      ? ({ email, url, token }) =>
        mailer.send({ to: email, kind: "email_verification", url, token })
      : undefined,
    sendPasswordResetEmail: mailer
      ? ({ email, url, token }) => mailer.send({ to: email, kind: "password_reset", url, token })
      : undefined,
  })
  : undefined;
const { app, toolExecutionService } = createApp({
  repository,
  rateLimiter,
  objectStore,
  providerKeyring,
  circuitBreaker,
  ocrCache,
  toolExecutionStore,
  audioConcurrencyLimiter,
  imageConcurrencyLimiter: audioConcurrencyLimiter,
  browserAuth,
  mailer,
  requireEmailVerification,
});
await toolExecutionService.recover();
const replayMaintenance = setInterval(async () => {
  try {
    const reaped = await repository.reapStaleApiRequests(100);
    const reapedGenerations = await repository.reapStaleGenerations(100);
    const reapedProviderRuns = await repository.reapStaleProviderExecutionLeases(100);
    const pruned = await repository.pruneExpiredApiRequests(100);
    const recoveredTools = await toolExecutionService.recover();
    if (reaped || reapedGenerations || reapedProviderRuns || pruned || recoveredTools) {
      console.log(JSON.stringify({
        level: "info",
        message: "Replay maintenance",
        reaped,
        reapedGenerations,
        reapedProviderRuns,
        pruned,
        recoveredTools,
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
    toolExecutionStore?.close(),
    rateLimiter.close(),
    circuitBreaker.close(),
    ocrCache?.close(),
    audioConcurrencyLimiter.close(),
    objectStore?.close(),
    browserAuth?.close(),
  ]);
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => void shutdown(signal));
}
