import { expect, test } from "@playwright/test";
import { bootstrap, login } from "./helpers.ts";

test("admin creates and downloads a separately encrypted provider-secret backup", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  const id = "00000000-0000-4000-8000-0000000000b1";
  const createdAt = "2026-07-12T18:00:00.000Z";
  const paired = {
    id,
    status: "completed",
    formatVersion: 1,
    includesDiagnostics: false,
    secretsRedacted: true,
    bytes: 4096,
    fingerprint: "a".repeat(64),
    createdAt,
    completedAt: "2026-07-12T18:00:01.000Z",
    error: null,
    providerSecrets: {
      status: "completed",
      encrypted: true,
      providerCount: 2,
      bytes: 512,
      fingerprint: "b".repeat(64),
      recoveryKeyId: "recovery-2026",
    },
  };
  let items: typeof paired[] = [];
  await page.route("**/api/admin/backups**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/admin/backups" && method === "GET") {
      return await route.fulfill({
        json: { items, restoreEnabled: false, privilegedSecretBackupsEnabled: true },
      });
    }
    if (url.pathname.endsWith("/privileged-exports") && method === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        includeDiagnostics: false,
        confirmation: "EXPORT PROVIDER SECRETS",
      });
      expect(route.request().headers()["idempotency-key"]).toHaveLength(36);
      items = [paired];
      return await route.fulfill({ json: paired, status: 202 });
    }
    if (url.pathname.endsWith(`/${id}/provider-secrets/content`)) {
      return await route.fulfill({
        status: 200,
        contentType: "application/vnd.dg-chat.provider-secrets",
        body: Buffer.from("encrypted-sidecar"),
      });
    }
    return await route.fallback();
  });

  await page.goto("/admin/storage");
  await expect(page).toHaveTitle("Storage & backups · DG Chat Admin");
  const create = page.getByRole("button", { name: "Create paired export" });
  await expect(create).toBeDisabled();
  await page.getByLabel("Type EXPORT PROVIDER SECRETS to continue").fill(
    "EXPORT PROVIDER SECRETS",
  );
  await expect(create).toBeEnabled();
  await create.click();

  await expect(page.getByText("2 providers", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: ".dgbackup" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: ".dgsecrets" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`dg-chat-provider-secrets-${id}.dgsecrets`);
  await expect(page.getByText("Encrypted provider-secret sidecar downloaded.")).toBeVisible();
});

test("admin dry-runs and exactly confirms provider-secret recovery", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  const restoreId = "10000000-0000-4000-8000-000000000012";
  const sidecarId = "10000000-0000-4000-8000-000000000013";
  const preview = {
    id: sidecarId,
    restoreId,
    status: "validated",
    version: 2,
    baseFingerprint: "a".repeat(64),
    sidecarFingerprint: "b".repeat(64),
    recoveryKeyId: "recovery-2026",
    recordCount: 1,
    providers: [{
      providerId: "10000000-0000-4000-8000-000000000014",
      displayName: "Recovery provider",
      action: "restore",
      reason: null,
    }],
    warnings: ["Review this provider before enabling it."],
    blockingErrors: [],
    providersRemainDisabled: true,
  };
  await page.route("**/api/admin/backups**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/admin/backups") {
      return await route.fulfill({
        json: {
          items: [],
          restoreEnabled: true,
          privilegedSecretBackupsEnabled: true,
          providerSecretRestoreEnabled: true,
        },
      });
    }
    if (url.pathname.endsWith("/provider-secrets/uploads")) {
      return await route.fulfill({
        status: 201,
        json: {
          id: sidecarId,
          restoreId,
          status: "uploaded",
          version: 1,
          filename: "recovery.dgsecrets",
          bytes: 128,
          baseFingerprint: preview.baseFingerprint,
          sidecarFingerprint: preview.sidecarFingerprint,
          recoveryKeyId: preview.recoveryKeyId,
          createdAt: "2026-07-12T18:00:00.000Z",
        },
      });
    }
    if (url.pathname.endsWith("/dry-run")) return await route.fulfill({ json: preview });
    if (url.pathname.endsWith("/apply")) {
      expect(route.request().postDataJSON()).toEqual({
        confirmation: "RESTORE PROVIDER SECRETS",
        expectedVersion: 2,
        baseFingerprint: preview.baseFingerprint,
        sidecarFingerprint: preview.sidecarFingerprint,
      });
      return await route.fulfill({
        json: {
          id: sidecarId,
          restoreId,
          status: "applied",
          providerCount: 1,
          providersRemainDisabled: true,
          appliedAt: "2026-07-12T18:01:00.000Z",
        },
      });
    }
    return await route.fallback();
  });

  await page.goto("/admin/storage");
  await page.getByLabel("Completed base restore ID").fill(restoreId);
  await page.locator('input[type="file"][accept*=".dgsecrets"]').setInputFiles({
    name: "recovery.dgsecrets",
    mimeType: "application/vnd.dg-chat.provider-secrets",
    buffer: Buffer.from("encrypted-sidecar"),
  });
  await expect(page.getByText("recovery.dgsecrets", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run dry check", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Provider impact" })).toBeVisible();
  await expect(page.getByText("Recovery provider", { exact: true })).toBeVisible();
  const apply = page.getByRole("button", { name: "Restore provider secrets", exact: true });
  await expect(apply).toBeDisabled();
  await page.getByLabel("Type RESTORE PROVIDER SECRETS to apply").fill(
    "RESTORE PROVIDER SECRETS",
  );
  await apply.click();
  await expect(page.getByText(/All affected providers remain disabled/)).toBeVisible();
});
