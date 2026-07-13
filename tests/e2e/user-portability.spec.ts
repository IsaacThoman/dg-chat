import { expect, test } from "@playwright/test";
import { bootstrap, login } from "./helpers.ts";

const preview = {
  dryRun: true,
  replayed: false,
  conversations: 2,
  messages: 7,
  attachments: 1,
  folders: 1,
  tags: 3,
  idMap: {},
};

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
});

async function openSettings(page: import("@playwright/test").Page) {
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Data & privacy", exact: true }).click();
}

test("previews and explicitly confirms a portable import", async ({ page }) => {
  let appliedKey = "";
  await page.route("**/api/portability/import/dry-run", async (route) => {
    expect(route.request().postData()).toContain("dgchat.owner-export");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(preview),
    });
  });
  await page.route("**/api/portability/import", async (route) => {
    appliedKey = await route.request().headerValue("idempotency-key") ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...preview, dryRun: false }),
    });
  });

  await openSettings(page);
  await expect(page.getByLabel("Include temporary conversations")).not.toBeChecked();
  await page.getByRole("button", { name: "Choose archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Import chat data" });
  const fileInput = dialog.locator('input[type="file"]');
  await expect(fileInput).toBeHidden();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await fileInput.setInputFiles({
    name: `${"a".repeat(247)}.dgchat`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "dgchat.owner-export", version: 1 })),
  });
  await expect(dialog.getByText("Ready to import")).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByLabel("Import summary")).toContainText("7");
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByRole("dialog", { name: "Import complete" })).toContainText(
    "Your archive was imported",
  );
  expect(appliedKey.length).toBeGreaterThanOrEqual(8);
});

test("rejects invalid local files without contacting the server", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/portability/import/**", async (route) => {
    requests++;
    await route.abort();
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Choose archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Import chat data" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(dialog.getByRole("alert")).toContainText(".dgchat");
  expect(requests).toBe(0);
});
