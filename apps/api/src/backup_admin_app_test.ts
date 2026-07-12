import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp, hasRecentAuthentication } from "./app.ts";
import type {
  BackupAdminService,
  BackupExportSummary,
  BackupRestorePreview,
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
  maintenance = false;
  exportInput: unknown;
  uploadInput: unknown;
  applyCalls = 0;
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
    return Promise.resolve({ enabled: this.maintenance, retryAfterSeconds: 9 });
  }
}

async function fixture(options: { now?: () => number } = {}) {
  const repository = new MemoryRepository();
  const backupAdmin = new FakeBackupAdmin();
  const { app } = createApp({
    repository,
    backupAdmin,
    setupToken: "backup-setup-token",
    now: options.now,
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

Deno.test("restore maintenance fences ordinary writes but leaves restore control available", async () => {
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

  const control = await app.request("/api/admin/backups", { headers });
  assertEquals(control.status, 200);
});
