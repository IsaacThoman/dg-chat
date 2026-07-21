import { assertEmailVerificationAdminReadiness, createApp } from "./app.ts";
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
import { conversationSearchConcurrencyLeaseMs } from "./conversation-search-config.ts";
import { createBetterAuthService } from "./better-auth.ts";
import { smtpIdentityMailer } from "./mail.ts";
import { backupRuntimeConfig } from "./backup-config.ts";
import { privilegedBackupSecretConfig } from "./backup-secret-keyring.ts";
import { DefaultBackupAdminService } from "./backup-service.ts";
import { createPostgresBackupDataPort } from "./postgres-backup-data.ts";
import { shutdownApi, shutdownLogLevel } from "./shutdown.ts";
import { IDENTITY_SHUTDOWN_ABORT_MS } from "./identity-delivery.ts";
import { closeIdentityAwareResources } from "./resource-shutdown.ts";
import { logOperationalFailure } from "@dg-chat/contracts";
import {
  assertRuntimeDependencies,
  PRODUCTION_READINESS_REQUIREMENTS,
} from "./runtime-dependencies.ts";
import { StartupResourceOwner } from "./startup-resources.ts";
import {
  createApiMetrics,
  metricsListenerConfig,
  startMetricsServer,
  startTelemetry,
  telemetryConfig,
} from "@dg-chat/observability";
import { validateAppSecret } from "./auth-config.ts";
import {
  attachmentExternalInspectionRequiredFromEnv,
  attachmentStorageQuotaFromEnv,
} from "./attachment-storage-config.ts";

const startupResources = new StartupResourceOwner();
try {
  const port = Number(Deno.env.get("PORT") ?? 8000);
  const production = Deno.env.get("DENO_ENV") === "production";
  const telemetry = startTelemetry(telemetryConfig(Deno.env.toObject(), "dg-chat-api"));
  startupResources.defer(() => telemetry.shutdown());
  const providerKeyring = ProviderSecretKeyring.fromEnv();
  if (production && !providerKeyring) {
    throw new Error(
      "Production requires ENCRYPTION_KEY or ENCRYPTION_KEYRING with ENCRYPTION_PRIMARY_KEY_ID",
    );
  }
  const databaseUrl = Deno.env.get("DATABASE_URL")?.trim() || undefined;
  const redisUrl = Deno.env.get("REDIS_URL")?.trim() || undefined;
  // Parse before constructing services: an explicit opt-in must never start with an incomplete,
  // reused, or malformed recovery key domain.
  const privilegedBackupSecrets = privilegedBackupSecretConfig(Deno.env.toObject());
  const objectStore = objectStoreFromEnv();
  if (objectStore) startupResources.defer(() => objectStore.close());
  assertRuntimeDependencies({
    production,
    databaseUrl,
    redisUrl,
    objectStoreConfigured: Boolean(objectStore),
  });
  const backupConfig = await backupRuntimeConfig(Deno.env.toObject(), {
    dependenciesAvailable: Boolean(databaseUrl && objectStore),
    production,
  });
  if (backupConfig.enabled && databaseUrl) await verifyBackupDataCatalog(databaseUrl);
  let backupAdmin: DefaultBackupAdminService | undefined;
  if (backupConfig.enabled && databaseUrl && objectStore && backupConfig.authenticator) {
    const backupStore = await PostgresBackupStore.connect(databaseUrl);
    const forgetBackupStore = startupResources.defer(() => backupStore.close());
    const providerSecretRestoreStore = privilegedBackupSecrets.enabled &&
        backupConfig.restoreEnabled
      ? await PostgresRestoreProviderSecretsStore.connect(databaseUrl)
      : undefined;
    const forgetProviderSecretStore = providerSecretRestoreStore
      ? startupResources.defer(() => providerSecretRestoreStore.close())
      : undefined;
    backupAdmin = new DefaultBackupAdminService({
      store: backupStore,
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
      privilegedProviderSecrets:
        privilegedBackupSecrets.enabled && privilegedBackupSecrets.keyring &&
          providerKeyring
          ? {
            recoveryKeyring: privilegedBackupSecrets.keyring,
            providerKeyring,
          }
          : undefined,
      providerSecretRestoreStore,
    });
    // The composite service now owns both PostgreSQL stores. Replace their partial-acquisition
    // closers only after its constructor has succeeded.
    forgetBackupStore();
    forgetProviderSecretStore?.();
    startupResources.defer(() => backupAdmin!.close());
  }
  if (backupAdmin) {
    // This must precede identity reconciliation, stale-run reaping, tool recovery, and request
    // acceptance. Separately deployed worker mutations are fenced by PostgreSQL during restore.
    await backupAdmin.recoverPending().catch((error) => {
      throw new Error("Backup recovery failed during startup", { cause: error });
    });
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
  startupResources.defer(() => repository.close());
  const toolExecutionStore = databaseUrl
    ? PostgresToolExecutionStore.connect(databaseUrl)
    : undefined;
  if (toolExecutionStore) startupResources.defer(() => toolExecutionStore.close());
  const rateLimiter = redisUrl ? new RedisRateLimiter(redisUrl) : new MemoryRateLimiter();
  startupResources.defer(() => rateLimiter.close());
  const circuitBreaker = redisUrl ? new RedisCircuitBreaker(redisUrl) : new MemoryCircuitBreaker();
  startupResources.defer(() => circuitBreaker.close());
  const ocrCache = redisUrl
    ? new RedisOcrCache(redisUrl, {
      failureMode: ocrCacheFailureModeFromEnv(Deno.env.get("OCR_CACHE_FAILURE_MODE")),
    })
    : undefined;
  if (ocrCache) startupResources.defer(() => ocrCache.close());
  const audioConcurrencyLeaseMs = Number(
    Deno.env.get("AUDIO_CONCURRENCY_LEASE_SECONDS") ?? 120,
  ) * 1_000;
  const audioConcurrencyLimiter = redisUrl
    ? new RedisAudioConcurrencyLimiter(redisUrl, {
      leaseMs: audioConcurrencyLeaseMs,
    })
    : new MemoryAudioConcurrencyLimiter({ leaseMs: audioConcurrencyLeaseMs });
  startupResources.defer(() => audioConcurrencyLimiter.close());
  const searchConcurrencyLeaseMs = conversationSearchConcurrencyLeaseMs(
    Deno.env.get("CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS"),
  );
  const conversationSearchConcurrencyLimiter = redisUrl
    ? new RedisAudioConcurrencyLimiter(redisUrl, {
      leaseMs: searchConcurrencyLeaseMs,
    })
    : new MemoryAudioConcurrencyLimiter({ leaseMs: searchConcurrencyLeaseMs });
  startupResources.defer(() => conversationSearchConcurrencyLimiter.close());
  const requireEmailVerification = Deno.env.get("REQUIRE_EMAIL_VERIFICATION") === "true";
  assertEmailVerificationAdminReadiness(
    await repository.listUsers(),
    requireEmailVerification,
  );
  const mailer = Deno.env.get("SMTP_URL")
    ? smtpIdentityMailer(
      Deno.env.get("SMTP_URL")!,
      Deno.env.get("SMTP_FROM") ?? "DG Chat <no-reply@localhost>",
    )
    : undefined;
  if (mailer?.close) startupResources.defer(() => mailer.close!());
  const appSecret = validateAppSecret(Deno.env.get("APP_SECRET"), Boolean(databaseUrl));
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
  if (browserAuth) startupResources.defer(() => browserAuth.close());
  const {
    app,
    toolExecutionService,
    drainIdentityDeliveries,
    drainRealtimeSessions,
    replayQuota,
    recoverFileUploads,
  } = createApp({
    repository,
    rateLimiter,
    objectStore,
    attachmentUploadPutTimeoutMs: Number(
      Deno.env.get("ATTACHMENT_UPLOAD_PUT_TIMEOUT_MS") ?? 300_000,
    ),
    attachmentUploadLeaseSeconds: Number(
      Deno.env.get("ATTACHMENT_UPLOAD_LEASE_SECONDS") ?? 900,
    ),
    attachmentStorageQuota: attachmentStorageQuotaFromEnv(Deno.env.toObject()),
    attachmentExternalInspectionRequired: attachmentExternalInspectionRequiredFromEnv(
      Deno.env.toObject(),
    ),
    providerKeyring,
    circuitBreaker,
    ocrCache,
    toolExecutionStore,
    audioConcurrencyLimiter,
    imageConcurrencyLimiter: audioConcurrencyLimiter,
    conversationSearchConcurrencyLimiter,
    browserAuth,
    communityCursorSecret: appSecret!,
    mailer,
    requireEmailVerification,
    backupAdmin,
    readinessRequirements: production ? PRODUCTION_READINESS_REQUIREMENTS : undefined,
  });
  await toolExecutionService.recover();
  const apiMetrics = createApiMetrics();
  const metricsServer = startMetricsServer(
    apiMetrics.registry,
    metricsListenerConfig(Deno.env.toObject(), { port: 9090, enabled: production }),
  );
  if (metricsServer) startupResources.defer(() => metricsServer.close());
  const replayMaintenance = setInterval(async () => {
    try {
      const recoveredFiles = await recoverFileUploads(100);
      const reaped = await repository.reapStaleApiRequests(100, replayQuota);
      const reapedGenerations = await repository.reapStaleGenerations(100);
      const reapedProviderRuns = await repository.reapStaleProviderExecutionLeases(100);
      const pruned = await repository.pruneExpiredApiRequests(100);
      const recoveredTools = await toolExecutionService.recover();
      if (
        recoveredFiles || reaped || reapedGenerations || reapedProviderRuns || pruned ||
        recoveredTools
      ) {
        console.log(JSON.stringify({
          level: "info",
          message: "Replay maintenance",
          recoveredFiles,
          reaped,
          reapedGenerations,
          reapedProviderRuns,
          pruned,
          recoveredTools,
        }));
      }
    } catch {
      logOperationalFailure("api_replay_maintenance");
    }
  }, 60_000);
  startupResources.defer(() => clearInterval(replayMaintenance));
  console.log(JSON.stringify({ level: "info", message: "API listening", port }));
  const serverAbort = new AbortController();
  const server = Deno.serve(
    { port, onListen: () => {}, signal: serverAbort.signal },
    apiMetrics.instrument(app.fetch),
  );
  startupResources.defer(() => server.shutdown());
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(replayMaintenance);
    console.log(JSON.stringify({ level: "info", message: "API shutting down", signal }));
    const outcome = await shutdownApi({
      // close() synchronously flips the coordinator to closing and aborts every export controller
      // before its first await. Start it before the graceful HTTP drain so backup streams cannot
      // deadlock server.shutdown().
      cancelBackup: () => backupAdmin?.close(),
      drainServer: async () => {
        await drainRealtimeSessions();
        await server.shutdown();
      },
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
            () => conversationSearchConcurrencyLimiter.close(),
            () => objectStore?.close(),
            () => browserAuth?.close(),
            () => metricsServer?.close(),
            () => telemetry.shutdown(),
          ],
        });
      },
      drainGraceMs: 10_000,
      forceGraceMs: 2_000,
      resourceGraceMs: 5_000,
    });
    const shutdownLevel = shutdownLogLevel(outcome);
    const shutdownLog = JSON.stringify({
      level: shutdownLevel,
      message: shutdownLevel === "info" ? "API shutdown complete" : "API shutdown degraded",
      signal,
      ...outcome,
    });
    if (shutdownLevel === "error") console.error(shutdownLog);
    else if (shutdownLevel === "warn") console.warn(shutdownLog);
    else console.log(shutdownLog);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => void shutdown(signal);
    Deno.addSignalListener(signal, handler);
    startupResources.defer(() => Deno.removeSignalListener(signal, handler));
  }
  // Signal handlers are the final ownership handoff. From here normal shutdown owns the server,
  // interval, and dependency resources instead of the startup rollback stack.
  startupResources.release();
} catch (error) {
  const cleanupErrors = await startupResources.close();
  if (cleanupErrors.length > 0) {
    console.error(JSON.stringify({
      level: "error",
      message: "API startup cleanup degraded",
      failures: cleanupErrors.length,
    }));
  }
  throw error;
}
