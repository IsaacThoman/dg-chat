import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp, hasRecentAuthentication } from "./app.ts";
import type { BetterAuthService } from "./better-auth.ts";
import type {
  BackupAdminService,
  BackupExportSummary,
  BackupRestorePreview,
  ProviderSecretRestorePreview,
} from "./backup-admin.ts";

const cookie = (response: Response) => {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
};

const now = "2026-07-12T00:00:00.000Z";
const fingerprint = "a".repeat(64);

class FakeBackupAdmin implements BackupAdminService {
  restoreEnabled = true;
  privilegedSecretBackupsEnabled = true;
  providerSecretRestoreEnabled = true;
  maintenance = false;
  maintenanceError = false;
  exportInput: unknown;
  privilegedExportInput: unknown;
  uploadInput: unknown;
  applyCalls = 0;
  providerSecretUploadInput: unknown;
  providerSecretApplyInput: unknown;
  readonly backup: BackupExportSummary = {
    id: "10000000-0000-4000-8000-000000000001",
    status: "completed",
    formatVersion: 1,
    includesDiagnostics: false,
    secretsRedacted: true,
    bytes: 7,
    fingerprint,
    createdAt: now,
    completedAt: now,
    error: null,
  };
  readonly preview: BackupRestorePreview = {
    restoreId: "10000000-0000-4000-8000-000000000002",
    fingerprint,
    formatVersion: 1,
    createdAt: now,
    counts: [{ resource: "users", create: 1, update: 0, skip: 0 }],
    warnings: ["Provider credentials are redacted."],
    blockingErrors: [],
    secretsRedacted: true,
    attachmentsMissing: 0,
  };
  listExports() {
    return Promise.resolve([this.backup]);
  }
  requestExport(input: unknown) {
    this.exportInput = input;
    return Promise.resolve(this.backup);
  }
  exportContent() {
    return Promise.resolve(
      new Response("archive", {
        headers: { "content-type": "application/vnd.dg-chat.backup" },
      }),
    );
  }
  requestPrivilegedExport(input: unknown) {
    this.privilegedExportInput = input;
    return Promise.resolve({
      ...this.backup,
      providerSecrets: {
        status: "completed" as const,
        encrypted: true as const,
        providerCount: 2,
        bytes: 11,
        fingerprint: "b".repeat(64),
        recoveryKeyId: "recovery-2026",
      },
    });
  }
  providerSecretExportContent() {
    return Promise.resolve(
      new Response("encrypted-sidecar", {
        headers: { "content-type": "application/vnd.dg-chat.provider-secrets" },
      }),
    );
  }
  uploadProviderSecretRestore(input: { restoreId: string; idempotencyKey: string }) {
    this.providerSecretUploadInput = {
      restoreId: input.restoreId,
      idempotencyKey: input.idempotencyKey,
    };
    return Promise.resolve({
      id: "10000000-0000-4000-8000-000000000013",
      restoreId: input.restoreId,
      status: "uploaded" as const,
      version: 1,
      filename: "provider-secrets.dgsecrets",
      bytes: 17,
      baseFingerprint: "c".repeat(64),
      sidecarFingerprint: "d".repeat(64),
      recoveryKeyId: "recovery-2026",
      createdAt: now,
    });
  }
  previewProviderSecretRestore(_actorId: string, restoreId: string, sidecarId: string) {
    return Promise.resolve(
      {
        id: sidecarId,
        restoreId,
        status: "validated" as const,
        version: 2,
        baseFingerprint: "c".repeat(64),
        sidecarFingerprint: "d".repeat(64),
        recoveryKeyId: "recovery-2026",
        recordCount: 1,
        providers: [{
          providerId: "10000000-0000-4000-8000-000000000014",
          displayName: "Recovered provider",
          action: "restore" as const,
          reason: null,
        }],
        warnings: ["Provider remains disabled"],
        blockingErrors: [],
        providersRemainDisabled: true as const,
      } satisfies ProviderSecretRestorePreview,
    );
  }
  applyProviderSecretRestore(input: {
    restoreId: string;
    sidecarId: string;
  }) {
    this.providerSecretApplyInput = input;
    return Promise.resolve({
      id: input.sidecarId,
      restoreId: input.restoreId,
      status: "applied" as const,
      providerCount: 1,
      providersRemainDisabled: true as const,
      appliedAt: now,
    });
  }
  uploadRestore(input: { idempotencyKey: string }) {
    this.uploadInput = { idempotencyKey: input.idempotencyKey };
    return Promise.resolve({
      id: this.preview.restoreId,
      filename: "installation.dgbackup",
      bytes: 7,
      fingerprint,
      createdAt: now,
    });
  }
  previewRestore() {
    return Promise.resolve(this.preview);
  }
  issueRestoreStatusCapability() {
    return Promise.resolve({ token: "payload.signature", expiresAt: "2026-07-12T01:00:00.000Z" });
  }
  restoreStatus(restoreId: string, capability: string) {
    if (capability !== "payload.signature") throw new Error("invalid capability");
    return Promise.resolve({
      restoreId,
      status: this.maintenance ? "running" as const : "completed" as const,
      stage: this.maintenance ? "restore_staging" : "completed",
      completedAt: this.maintenance ? null : now,
      error: null,
    });
  }
  applyRestore() {
    this.applyCalls += 1;
    return Promise.resolve({
      restoreId: this.preview.restoreId,
      status: "completed" as const,
      completedAt: now,
      counts: this.preview.counts,
    });
  }
  maintenanceState() {
    if (this.maintenanceError) throw new Error("maintenance database unavailable");
    return Promise.resolve({ enabled: this.maintenance, retryAfterSeconds: 9 });
  }
}

async function fixture(
  options: {
    now?: () => number;
    providerStream?: NonNullable<Parameters<typeof createApp>[0]>["providerStream"];
  } = {},
) {
  const repository = new MemoryRepository();
  const backupAdmin = new FakeBackupAdmin();
  const { app } = createApp({
    repository,
    backupAdmin,
    setupToken: "backup-setup-token",
    now: options.now,
    providerStream: options.providerStream,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "backup-setup-token" },
    body: JSON.stringify({
      email: "backup@example.com",
      password: "correct horse battery",
      name: "Backup Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "backup@example.com", password: "correct horse battery" }),
  });
  return {
    app,
    backupAdmin,
    headers: { cookie: cookie(login), origin: "http://localhost:5173" },
    repository,
  };
}

Deno.test("backup administration is session-only, idempotent, no-store, and fingerprint bound", async () => {
  const { app, backupAdmin, headers, repository } = await fixture();
  assertEquals((await app.request("/api/admin/backups")).status, 401);

  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Backup forbidden token", scopes: ["models:read"] }),
  });
  const token = (await tokenResponse.json() as { token: string }).token;
  assertEquals(
    (await app.request("/api/admin/backups", {
      headers: { authorization: `Bearer ${token}` },
    })).status,
    403,
  );

  const listed = await app.request("/api/admin/backups", { headers });
  assertEquals(listed.status, 200);
  assertEquals(listed.headers.get("cache-control"), "private, no-store");
  assertEquals(listed.headers.get("x-content-type-options"), "nosniff");
  assertEquals(
    (await listed.clone().json() as { privilegedSecretBackupsEnabled: boolean })
      .privilegedSecretBackupsEnabled,
    true,
  );

  const missingKey = await app.request("/api/admin/backups/exports", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ includeDiagnostics: false }),
  });
  assertEquals(missingKey.status, 422);
  assertEquals(
    (await app.request("/api/admin/backups/exports", {
      method: "POST",
      headers: {
        cookie: headers.cookie,
        "content-type": "application/json",
        "idempotency-key": "backup-export-csrf",
      },
      body: JSON.stringify({ includeDiagnostics: false }),
    })).status,
    403,
  );

  const created = await app.request("/api/admin/backups/exports", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": "backup-export-attempt-1",
    },
    body: JSON.stringify({ includeDiagnostics: false }),
  });
  assertEquals(created.status, 202, await created.clone().text());
  assertEquals(
    (backupAdmin.exportInput as { idempotencyKey: string }).idempotencyKey,
    "backup-export-attempt-1",
  );

  const content = await app.request(`/api/admin/backups/${backupAdmin.backup.id}/content`, {
    headers,
  });
  assertEquals(content.status, 200);
  assertEquals(
    content.headers.get("content-disposition"),
    `attachment; filename="dg-chat-backup-${backupAdmin.backup.id}.dgbackup"`,
  );
  assertEquals(await content.text(), "archive");
  assertEquals(
    (await repository.listAudit()).data.some((event) =>
      event.action === "backup.export_downloaded" && event.targetId === backupAdmin.backup.id
    ),
    true,
  );

  const preview = await app.request(
    `/api/admin/backups/restores/${backupAdmin.preview.restoreId}/dry-run`,
    { method: "POST", headers },
  );
  assertEquals(preview.status, 200);
  assertEquals((await preview.json() as { fingerprint: string }).fingerprint, fingerprint);

  const mismatch = await app.request(
    `/api/admin/backups/restores/${backupAdmin.preview.restoreId}/apply`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: "short" }),
    },
  );
  assertEquals(mismatch.status, 422);

  const applied = await app.request(
    `/api/admin/backups/restores/${backupAdmin.preview.restoreId}/apply`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ fingerprint }),
    },
  );
  assertEquals(applied.status, 200, await applied.clone().text());
  assertEquals(backupAdmin.applyCalls, 1);
  assertEquals(applied.headers.get("cache-control"), "private, no-store");
  assertEquals(applied.headers.get("set-cookie")?.includes("Max-Age=0"), true);
});

Deno.test("privileged backup routes require capability, fresh auth, exact confirmation, and audit safely", async () => {
  const { app, backupAdmin, headers, repository } = await fixture();
  const endpoint = "/api/admin/backups/privileged-exports";
  const request = (body: unknown, extraHeaders: Record<string, string> = {}) =>
    app.request(endpoint, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "privileged-export-attempt-1",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

  for (
    const body of [
      { includeDiagnostics: false },
      { includeDiagnostics: false, confirmation: "export provider secrets" },
      { includeDiagnostics: false, confirmation: "EXPORT PROVIDER SECRETS", extra: true },
    ]
  ) assertEquals((await request(body)).status, 422);
  assertEquals(backupAdmin.privilegedExportInput, undefined);

  const created = await request({
    includeDiagnostics: false,
    confirmation: "EXPORT PROVIDER SECRETS",
  });
  assertEquals(created.status, 202, await created.clone().text());
  assertEquals(created.headers.get("cache-control"), "private, no-store");
  assertEquals(
    (backupAdmin.privilegedExportInput as { idempotencyKey: string }).idempotencyKey,
    "privileged-export-attempt-1",
  );
  const payload = await created.json() as {
    secretsRedacted: boolean;
    providerSecrets: {
      status: string;
      encrypted: boolean;
      providerCount: number;
      bytes: number;
      fingerprint: string;
      recoveryKeyId: string;
    };
  };
  assertEquals(payload.secretsRedacted, true);
  assertEquals(payload.providerSecrets, {
    status: "completed",
    encrypted: true,
    providerCount: 2,
    bytes: 11,
    fingerprint: "b".repeat(64),
    recoveryKeyId: "recovery-2026",
  });

  const sidecar = await app.request(
    `/api/admin/backups/${backupAdmin.backup.id}/provider-secrets/content`,
    { headers },
  );
  assertEquals(sidecar.status, 200);
  assertEquals(sidecar.headers.get("cache-control"), "private, no-store");
  assertEquals(sidecar.headers.get("referrer-policy"), "no-referrer");
  assertEquals(sidecar.headers.get("x-content-type-options"), "nosniff");
  assertEquals(
    sidecar.headers.get("content-disposition"),
    `attachment; filename="dg-chat-provider-secrets-${backupAdmin.backup.id}.dgsecrets"`,
  );
  assertEquals(sidecar.headers.get("content-type"), "application/vnd.dg-chat.provider-secrets");
  assertEquals(await sidecar.text(), "encrypted-sidecar");

  const audits = (await repository.listAudit()).data.filter((event) =>
    event.action.startsWith("backup.provider_secrets_")
  );
  assertEquals(audits.map((event) => event.action), [
    "backup.provider_secrets_download_requested",
    "backup.provider_secrets_export_requested",
  ]);
  const auditText = JSON.stringify(audits);
  assertEquals(auditText.includes("EXPORT PROVIDER SECRETS"), false);
  assertEquals(auditText.includes("encrypted-sidecar"), false);

  backupAdmin.privilegedSecretBackupsEnabled = false;
  assertEquals(
    (await request({
      includeDiagnostics: false,
      confirmation: "EXPORT PROVIDER SECRETS",
    })).status,
    503,
  );
  assertEquals(
    (await app.request(
      `/api/admin/backups/${backupAdmin.backup.id}/provider-secrets/content`,
      { headers },
    )).status,
    503,
  );
});

Deno.test("privileged backup export and download reject stale authentication before service access", async () => {
  const { app, backupAdmin, headers } = await fixture({
    now: () => Date.now() + 11 * 60 * 1_000,
  });
  const created = await app.request("/api/admin/backups/privileged-exports", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": "privileged-export-stale",
    },
    body: JSON.stringify({
      includeDiagnostics: false,
      confirmation: "EXPORT PROVIDER SECRETS",
    }),
  });
  assertEquals(created.status, 403);
  assertEquals(
    (await created.json() as { error: { code: string } }).error.code,
    "recent_authentication_required",
  );
  assertEquals(backupAdmin.privilegedExportInput, undefined);
  const content = await app.request(
    `/api/admin/backups/${backupAdmin.backup.id}/provider-secrets/content`,
    { headers },
  );
  assertEquals(content.status, 403);
});

Deno.test("provider-secret restore is recently authenticated, paired, previewed, and exactly confirmed", async () => {
  const { app, backupAdmin, headers, repository } = await fixture();
  const restoreId = "10000000-0000-4000-8000-000000000012";
  const sidecarId = "10000000-0000-4000-8000-000000000013";
  const upload = await app.request(
    `/api/admin/backups/restores/${restoreId}/provider-secrets/uploads`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "idempotency-key": "provider-secret-upload-one",
      },
      body: "encrypted-sidecar",
    },
  );
  assertEquals(upload.status, 201, await upload.clone().text());
  assertEquals(backupAdmin.providerSecretUploadInput, {
    restoreId,
    idempotencyKey: "provider-secret-upload-one",
  });

  const preview = await app.request(
    `/api/admin/backups/restores/${restoreId}/provider-secrets/${sidecarId}/dry-run`,
    { method: "POST", headers },
  );
  assertEquals(preview.status, 200, await preview.clone().text());
  const summary = await preview.json() as ProviderSecretRestorePreview;
  assertEquals(summary.providersRemainDisabled, true);
  assertEquals(summary.providers[0].action, "restore");

  const applyUrl = `/api/admin/backups/restores/${restoreId}/provider-secrets/${sidecarId}/apply`;
  assertEquals(
    (await app.request(applyUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        confirmation: "restore provider secrets",
        expectedVersion: summary.version,
        baseFingerprint: summary.baseFingerprint,
        sidecarFingerprint: summary.sidecarFingerprint,
      }),
    })).status,
    422,
  );
  const applied = await app.request(applyUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      confirmation: "RESTORE PROVIDER SECRETS",
      expectedVersion: summary.version,
      baseFingerprint: summary.baseFingerprint,
      sidecarFingerprint: summary.sidecarFingerprint,
    }),
  });
  assertEquals(applied.status, 200, await applied.clone().text());
  assertEquals(
    (backupAdmin.providerSecretApplyInput as { baseFingerprint: string }).baseFingerprint,
    summary.baseFingerprint,
  );
  assertEquals(
    (backupAdmin.providerSecretApplyInput as { sidecarFingerprint: string }).sidecarFingerprint,
    summary.sidecarFingerprint,
  );
  const actions = (await repository.listAudit()).data.map((event) => event.action);
  assertEquals(actions.includes("backup.provider_secrets_restore_uploaded"), true);
  assertEquals(actions.includes("backup.provider_secrets_restore_previewed"), true);
});

Deno.test("provider-secret restore fails closed and rejects stale authentication before upload", async () => {
  const stale = await fixture({ now: () => Date.now() + 11 * 60 * 1_000 });
  const restoreId = "10000000-0000-4000-8000-000000000012";
  const response = await stale.app.request(
    `/api/admin/backups/restores/${restoreId}/provider-secrets/uploads`,
    {
      method: "POST",
      headers: {
        ...stale.headers,
        "content-type": "application/octet-stream",
        "idempotency-key": "provider-secret-upload-stale",
      },
      body: "encrypted-sidecar",
    },
  );
  assertEquals(response.status, 403);
  assertEquals(stale.backupAdmin.providerSecretUploadInput, undefined);

  const disabled = await fixture();
  disabled.backupAdmin.providerSecretRestoreEnabled = false;
  const unavailable = await disabled.app.request(
    `/api/admin/backups/restores/${restoreId}/provider-secrets/uploads`,
    {
      method: "POST",
      headers: {
        ...disabled.headers,
        "content-type": "application/octet-stream",
        "idempotency-key": "provider-secret-upload-disabled",
      },
      body: "encrypted-sidecar",
    },
  );
  assertEquals(unavailable.status, 503);
});

Deno.test("provider-secret multipart body-limit bypass is restricted to the canonical upload route", async () => {
  const { app, headers } = await fixture();
  const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
  const canonical = await app.request(
    "/api/admin/backups/restores/10000000-0000-4000-8000-000000000012/provider-secrets/uploads",
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "idempotency-key": "provider-secret-large-canonical",
      },
      body: oversized,
    },
  );
  assertEquals(canonical.status, 201, await canonical.clone().text());
  const malformed = await app.request(
    "/api/admin/backups/restores/00000000-0000-0000-0000-000000000000/provider-secrets/uploads",
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "idempotency-key": "provider-secret-large-malformed",
      },
      body: oversized,
    },
  );
  assertEquals(malformed.status, 413);
});

Deno.test("restore apply fails closed when browser authentication is older than ten minutes", async () => {
  const { app, backupAdmin, headers } = await fixture({
    now: () => Date.now() + 11 * 60 * 1_000,
  });
  const response = await app.request(
    `/api/admin/backups/restores/${backupAdmin.preview.restoreId}/apply`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ fingerprint }),
    },
  );
  assertEquals(response.status, 403);
  assertEquals(
    (await response.json() as { error: { code: string } }).error.code,
    "recent_authentication_required",
  );
  assertEquals(backupAdmin.applyCalls, 0);
});

Deno.test("recent authentication validation rejects missing, malformed, old, and future times", () => {
  const nowMs = Date.parse("2026-07-12T12:00:00.000Z");
  assertEquals(hasRecentAuthentication(undefined, nowMs), false);
  assertEquals(hasRecentAuthentication("not-a-date", nowMs), false);
  assertEquals(hasRecentAuthentication("2026-07-12T11:50:00.000Z", nowMs), true);
  assertEquals(hasRecentAuthentication("2026-07-12T11:49:59.999Z", nowMs), false);
  assertEquals(hasRecentAuthentication("2026-07-12T12:01:00.000Z", nowMs), true);
  assertEquals(hasRecentAuthentication("2026-07-12T12:01:00.001Z", nowMs), false);
});

Deno.test("restore maintenance fences product routes except the explicit setup-status read", async () => {
  const { app, backupAdmin, headers } = await fixture();
  backupAdmin.maintenance = true;
  const blocked = await app.request("/api/conversations", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: "must not write" }),
  });
  assertEquals(blocked.status, 503);
  assertEquals(blocked.headers.get("retry-after"), "9");
  assertEquals(
    (await blocked.json() as { error: { code: string } }).error.code,
    "installation_maintenance",
  );

  // Authenticated GETs are not intrinsically read-only: authentication itself can refresh or
  // provision a session. Backup administration resumes after the restore fence is released.
  const control = await app.request("/api/admin/backups", { headers });
  assertEquals(control.status, 503);
  assertEquals(control.headers.get("retry-after"), "9");

  const status = await app.request(
    `/api/backup-restore-status/${backupAdmin.preview.restoreId}`,
    { headers: { authorization: "Bearer payload.signature" } },
  );
  assertEquals(status.status, 200);
  assertEquals(status.headers.get("cache-control"), "private, no-store");
  assertEquals(status.headers.get("referrer-policy"), "no-referrer");
  assertEquals((await status.json() as { status: string }).status, "running");
  assertEquals(
    (await app.request(`/api/backup-restore-status/${backupAdmin.preview.restoreId}`)).status,
    404,
  );

  const setupStatus = await app.request("/api/setup/status");
  assertEquals(setupStatus.status, 200);
});

Deno.test("restore maintenance blocks mutation-capable Better Auth GET routes before auth", async () => {
  const repository = new MemoryRepository();
  const backupAdmin = new FakeBackupAdmin();
  backupAdmin.maintenance = true;
  let handlerCalls = 0;
  let sessionCalls = 0;
  const browserAuth = {
    oidcEnabled: true,
    presentedSessionToken: () => undefined,
    getSession: () => {
      sessionCalls += 1;
      return Promise.resolve(null);
    },
    handler: () => {
      handlerCalls += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  } as unknown as BetterAuthService;
  const { app } = createApp({ repository, backupAdmin, browserAuth });

  for (
    const path of [
      "/api/auth/oidc/callback?state=restore-must-win",
      "/api/auth/get-session",
    ]
  ) {
    const response = await app.request(path);
    assertEquals(response.status, 503);
    assertEquals(response.headers.get("retry-after"), "9");
    assertEquals(
      (await response.json() as { error: { code: string } }).error.code,
      "installation_maintenance",
    );
  }
  assertEquals(handlerCalls, 0);
  assertEquals(sessionCalls, 0);

  backupAdmin.maintenance = false;
  backupAdmin.maintenanceError = true;
  const unavailable = await app.request("/api/auth/get-session");
  assertEquals(unavailable.status, 503);
  assertEquals(unavailable.headers.get("retry-after"), "5");
  assertEquals(handlerCalls, 0);
  assertEquals(sessionCalls, 0);
});

Deno.test("restore maintenance fences OpenAI traffic before token and provider side effects", async () => {
  let providerCalls = 0;
  const providerStream = async function* () {
    providerCalls += 1;
    yield 'data: {"choices":[{"delta":{"content":"must not run"}}]}\n\n';
  };
  const { app, backupAdmin, headers, repository } = await fixture({ providerStream });
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Maintenance token", scopes: ["models:read", "chat:write"] }),
  });
  const token = (await tokenResponse.json() as { token: string }).token;
  const user = await repository.findUserByEmail("backup@example.com");
  assertExists(user);
  assertEquals((await repository.listApiTokens(user.id))[0].lastUsedAt, null);

  backupAdmin.maintenance = true;
  const models = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals(models.status, 503);
  assertEquals(models.headers.get("retry-after"), "9");
  const modelError = await models.json() as {
    error: { code: string; type: string; message: string };
  };
  assertEquals(modelError.error.code, "installation_maintenance");
  assertEquals(modelError.error.type, "invalid_request_error");
  assertEquals((await repository.listApiTokens(user.id))[0].lastUsedAt, null);

  const chat = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "maintenance-provider-not-called",
    },
    body: JSON.stringify({
      model: "openai/default",
      messages: [{ role: "user", content: "do not invoke provider" }],
      stream: true,
    }),
  });
  assertEquals(chat.status, 503);
  assertEquals(providerCalls, 0);
  assertEquals((await repository.listApiTokens(user.id))[0].lastUsedAt, null);
});

Deno.test("restore maintenance blocks authentication mutations and fails closed", async () => {
  const { app, backupAdmin } = await fixture();
  backupAdmin.maintenance = true;
  for (
    const [path, body] of [
      [
        "/api/auth/sign-up/email",
        { name: "Blocked Signup", email: "blocked@example.com", password: "correct horse battery" },
      ],
      [
        "/api/auth/sign-in/email",
        { email: "backup@example.com", password: "correct horse battery" },
      ],
    ] as const
  ) {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify(body),
    });
    assertEquals(response.status, 503);
    assertEquals(
      (await response.json() as { error: { code: string } }).error.code,
      "installation_maintenance",
    );
  }

  backupAdmin.maintenance = false;
  backupAdmin.maintenanceError = true;
  const unavailable = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ email: "backup@example.com", password: "correct horse battery" }),
  });
  assertEquals(unavailable.status, 503);
  assertEquals(unavailable.headers.get("retry-after"), "5");
  assertEquals(
    (await unavailable.json() as { error: { code: string } }).error.code,
    "maintenance_state_unavailable",
  );
});
