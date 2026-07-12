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
