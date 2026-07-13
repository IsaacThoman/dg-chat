import { createApp } from "./app.ts";
import {
  backfillLegacyRuntimeSnapshot,
  MemoryRepository,
  objectStoreFromEnv,
  PostgresBackupStore,
  PostgresRepository,
  PostgresRestoreProviderSecretsStore,
  PostgresToolExecutionStore,
  reconcileBetterAuthIdentities,
  verifyBackupDataCatalog,
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
import { backupRuntimeConfig } from "./backup-config.ts";
import { privilegedBackupSecretConfig } from "./backup-secret-keyring.ts";
import { DefaultBackupAdminService } from "./backup-service.ts";
import { createPostgresBackupDataPort } from "./postgres-backup-data.ts";
import { shutdownApi } from "./shutdown.ts";
import { IDENTITY_SHUTDOWN_ABORT_MS } from "./identity-delivery.ts";
import { closeIdentityAwareResources } from "./resource-shutdown.ts";

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
// Parse before constructing services: an explicit opt-in must never start with an incomplete,
// reused, or malformed recovery key domain.
const privilegedBackupSecrets = privilegedBackupSecretConfig(Deno.env.toObject());
const objectStore = objectStoreFromEnv();
const backupConfig = await backupRuntimeConfig(Deno.env.toObject(), {
  dependenciesAvailable: Boolean(databaseUrl && objectStore),
  production,
});
if (backupConfig.enabled && databaseUrl) await verifyBackupDataCatalog(databaseUrl);
const backupAdmin = backupConfig.enabled && databaseUrl && objectStore && backupConfig.authenticator
  ? new DefaultBackupAdminService({
    store: await PostgresBackupStore.connect(databaseUrl),
    objects: objectStore,
    data: createPostgresBackupDataPort({
      databaseUrl,
      objects: objectStore,
      authenticator: backupConfig.authenticator,
      appVersion: "0.1.0",
    }),
    authenticator: backupConfig.authenticator,
    restoreEnabled: backupConfig.restoreEnabled,
    maxUploadBytes: backupConfig.maxUploadBytes,
    privilegedProviderSecrets: privilegedBackupSecrets.enabled && privilegedBackupSecrets.keyring &&
        providerKeyring
      ? {
        recoveryKeyring: privilegedBackupSecrets.keyring,
        providerKeyring,
      }
      : undefined,
    providerSecretRestoreStore: privilegedBackupSecrets.enabled && backupConfig.restoreEnabled
      ? await PostgresRestoreProviderSecretsStore.connect(databaseUrl)
      : undefined,
  })
  : undefined;
if (backupAdmin) {
  try {
    // This must precede identity reconciliation, stale-run reaping, tool recovery, and request
    // acceptance. Separately deployed worker mutations are fenced by PostgreSQL during restore.
    await backupAdmin.recoverPending();
  } catch (error) {
    await backupAdmin.close();
    await objectStore?.close();
    throw new Error("Backup recovery failed during startup", { cause: error });
  }
}
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
const oidcValues = {
  discoveryUrl: Deno.env.get("OIDC_DISCOVERY_URL")?.trim(),
  expectedIssuer: Deno.env.get("OIDC_ISSUER")?.trim(),
  clientId: Deno.env.get("OIDC_CLIENT_ID")?.trim(),
  clientSecret: Deno.env.get("OIDC_CLIENT_SECRET")?.trim(),
};
const oidcConfiguredCount = Object.values(oidcValues).filter(Boolean).length;
if (oidcConfiguredCount !== 0 && oidcConfiguredCount !== Object.keys(oidcValues).length) {
  throw new Error(
    "OIDC_DISCOVERY_URL, OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must be configured together",
  );
}
const oidc = oidcConfiguredCount === Object.keys(oidcValues).length
  ? {
    providerId: Deno.env.get("OIDC_PROVIDER_ID")?.trim() || "organization",
    discoveryUrl: oidcValues.discoveryUrl!,
    expectedIssuer: oidcValues.expectedIssuer!,
    clientId: oidcValues.clientId!,
    clientSecret: oidcValues.clientSecret!,
    allowedAlgorithms: (Deno.env.get("OIDC_ALLOWED_ALGORITHMS") ?? "RS256").split(",")
      .map((value) => value.trim()).filter(Boolean),
    allowInsecureHttp: Deno.env.get("OIDC_ALLOW_INSECURE_HTTP") === "true",
    allowPrivateNetwork: Deno.env.get("OIDC_ALLOW_PRIVATE_NETWORK") === "true",
    allowedEndpointOrigins: (Deno.env.get("OIDC_ALLOWED_ENDPOINT_ORIGINS") ?? "").split(",")
      .map((value) => value.trim()).filter(Boolean),
  }
  : undefined;
const browserAuth = databaseUrl
  ? createBetterAuthService({
    databaseUrl,
    repository,
    secret: appSecret!,
    appUrl,
    webOrigin,
    oidc,
    requireEmailVerification,
    sendVerificationEmail: mailer
      ? ({ email, token }, signal) =>
        mailer.send({
          to: email,
          kind: "email_verification",
          url: `${webOrigin}/verify-email#token=${encodeURIComponent(token)}`,
          token,
        }, signal)
      : undefined,
    sendPasswordResetEmail: mailer
      ? ({ email, token }, signal) =>
        mailer.send({
          to: email,
          kind: "password_reset",
          url: `${webOrigin}/reset-password#token=${encodeURIComponent(token)}`,
          token,
        }, signal)
      : undefined,
  })
  : undefined;
const { app, toolExecutionService, drainIdentityDeliveries } = createApp({
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
  backupAdmin,
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
const serverAbort = new AbortController();
const server = Deno.serve({ port, onListen: () => {}, signal: serverAbort.signal }, app.fetch);
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  clearInterval(replayMaintenance);
  console.log(JSON.stringify({ level: "info", message: "API shutting down", signal }));
  await shutdownApi({
    // close() synchronously flips the coordinator to closing and aborts every export controller
    // before its first await. Start it before the graceful HTTP drain so backup streams cannot
    // deadlock server.shutdown().
    cancelBackup: () => backupAdmin?.close(),
    drainServer: () => server.shutdown(),
    forceServer: () => serverAbort.abort(new Error("API shutdown deadline exceeded")),
    closeResources: async () => {
      await closeIdentityAwareResources({
        abortDeliveriesAfterMs: IDENTITY_SHUTDOWN_ABORT_MS,
        closeMailer: mailer?.close ? () => mailer.close!() : undefined,
        drainLegacyDeliveries: drainIdentityDeliveries,
        drainBrowserDeliveries: browserAuth?.drainIdentityDeliveries,
        closeResources: [
          () => repository.close(),
          () => toolExecutionStore?.close(),
          () => rateLimiter.close(),
          () => circuitBreaker.close(),
          () => ocrCache?.close(),
          () => audioConcurrencyLimiter.close(),
          () => objectStore?.close(),
          () => browserAuth?.close(),
        ],
      });
    },
    drainGraceMs: 10_000,
    resourceGraceMs: 5_000,
  });
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => void shutdown(signal));
}
