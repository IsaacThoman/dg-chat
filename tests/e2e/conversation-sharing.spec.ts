import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

const capability = "a".repeat(43);
const createdAt = "2026-07-13T04:00:00.000Z";
const summary = {
  id: "share-1",
  conversationId: "",
  leafId: "leaf-1",
  conversationVersion: 2,
  title: "Shared conversation",
  identityVisibility: "anonymous",
  attachmentPolicy: "redact",
  attachmentCount: 0,
  messageCount: 2,
  version: 1,
  createdAt,
  expiresAt: null,
  revokedAt: null,
};

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
});

async function openSidebar(page: import("@playwright/test").Page) {
  if ((page.viewportSize()?.width ?? 1280) > 800) return;
  const sidebar = page.getByRole("dialog", { name: "Workspace navigation" });
  if (await sidebar.isVisible()) return;
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await expect(sidebar).toBeVisible();
}

test("creates and revokes an immutable snapshot with conservative defaults", async ({ page }) => {
  await createChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("A snapshot-safe prompt");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".assistant-message")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({
    timeout: 20_000,
  });
  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();
  const ownerSummary = { ...summary, conversationId };
  let storedSummary: typeof ownerSummary | undefined;
  await page.route(
    "**/api/shares",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: storedSummary ? [storedSummary] : [] }),
      }),
  );
  const createBodies: Record<string, unknown>[] = [];
  const idempotencyKeys: string[] = [];
  await page.route(`**/api/conversations/${conversationId}/shares`, async (route) => {
    createBodies.push(route.request().postDataJSON());
    idempotencyKeys.push(await route.request().headerValue("idempotency-key") ?? "");
    if (createBodies.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "service_unavailable", message: "Try again" } }),
      });
      return;
    }
    storedSummary = ownerSummary;
    const createdCapability = String(createBodies.at(-1)?.capability);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        share: ownerSummary,
        capability: createdCapability,
        path: `/share/${createdCapability}`,
        replayed: false,
      }),
    });
  });
  await page.route("**/api/shares/share-1/revoke", (route) => {
    storedSummary = {
      ...ownerSummary,
      version: 2,
      revokedAt: "2026-07-13T05:00:00.000Z",
    };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ share: storedSummary }),
    });
  });

  await page.getByRole("button", { name: "Share an immutable snapshot" }).click();
  const dialog = page.getByRole("dialog", { name: "Share conversation" });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog).toContainText("Future edits and branches will never change it");
  await expect(dialog.getByRole("radio", { name: "Anonymous" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Redact all" })).toBeChecked();
  await dialog.getByLabel("Link expiry").selectOption("week");
  await dialog.getByRole("button", { name: "Create snapshot" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Try again");
  await dialog.getByRole("button", { name: "Create snapshot" }).click();
  await expect(dialog.getByRole("heading", { name: "Snapshot ready" })).toBeVisible();
  const createdCapability = String(createBodies[1]?.capability);
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    `http://localhost:5173/share/${createdCapability}`,
  );
  expect(createBodies[1]).toMatchObject({
    identityVisibility: "anonymous",
    attachmentPolicy: "redact",
    selectedAttachmentIds: [],
  });
  expect(String(createBodies[1]?.capability)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(createBodies[1]?.capability).toBe(createBodies[0]?.capability);
  expect(createBodies[1]?.expiresAt).toBe(createBodies[0]?.expiresAt);
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  expect(idempotencyKeys[1].length).toBeGreaterThanOrEqual(8);

  page.once("dialog", (prompt) => prompt.accept());
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect(dialog.getByText("revoked", { exact: true })).toBeVisible();
});

test("renders a redacted public snapshot safely without workspace chrome", async ({ page }) => {
  await page.route(`**/api/public/shares/${capability}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        share: {
          id: "public-share-1",
          title: "A safe public snapshot",
          conversationVersion: 2,
          identity: { visibility: "anonymous", displayName: null },
          attachmentPolicy: "redact",
          messages: [
            {
              id: "public-message-1",
              parentId: null,
              role: "user",
              content: "Hello <img src=x onerror=alert(1)>",
              status: "complete",
              attachmentIds: [],
              createdAt,
            },
            {
              id: "public-message-2",
              parentId: "public-message-1",
              role: "assistant",
              content:
                "Read [the guide](https://example.com). ![tracking pixel](https://tracker.invalid/pixel.png)",
              status: "complete",
              attachmentIds: [],
              createdAt,
            },
          ],
          attachments: [],
          createdAt,
          expiresAt: null,
        },
      }),
    }));
  await page.goto(`/share/${capability}`);
  await expect(page.getByRole("heading", { name: "A safe public snapshot" })).toBeVisible();
  await expect(page.getByText("Shared anonymously")).toBeVisible();
  await expect(page.getByText("Read-only snapshot")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toHaveCount(0);
  await expect(page.locator(".public-share-message img")).toHaveCount(0);
  await expect(page.getByText("Remote image blocked: tracking pixel")).toBeVisible();
  const external = page.getByRole("link", { name: "the guide" });
  await expect(external).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
});

test("real stack pins a snapshot and revocation invalidates its public link", async ({ page }) => {
  await createChat(page);
  const prompt = `real immutable share ${crypto.randomUUID()}`;
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".assistant-message")).toContainText(prompt);
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({
    timeout: 20_000,
  });
  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();

  await page.getByRole("button", { name: "Share an immutable snapshot" }).click();
  const dialog = page.getByRole("dialog", { name: "Share conversation" });
  await dialog.getByRole("button", { name: "Create snapshot" }).click();
  const link = dialog.getByLabel("Share link");
  await expect(link).toBeVisible();
  const publicUrl = await link.inputValue();
  expect(publicUrl).toMatch(/\/share\/[A-Za-z0-9_-]{43}$/);
  const publicCapability = new URL(publicUrl).pathname.split("/").at(-1)!;
  const publicApiPath = `/api/public/shares/${publicCapability}`;

  const listed = await page.request.get("/api/shares");
  expect(listed.ok()).toBeTruthy();
  const shares = await listed.json() as {
    data: Array<{ id: string; conversationId: string; version: number }>;
  };
  const share = shares.data.find((item) => item.conversationId === conversationId);
  expect(share).toBeTruthy();

  page.once("dialog", (prompt) => prompt.accept());
  await dialog.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
  await openSidebar(page);
  const actions = page.locator(`[data-conversation-actions="${conversationId}"]`);
  await actions.click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();
  await openSidebar(page);
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeHidden();
    await openSidebar(page);
  }
  await expect(actions).toBeVisible();
  await actions.locator("..").locator(".conversation-open").click();
  await expect(
    page.locator(`.conversation-row.active [data-conversation-actions="${conversationId}"]`),
  ).toHaveCount(1);

  const stillPublic = await page.request.get(publicApiPath);
  expect(stillPublic.ok()).toBeTruthy();
  await page.getByRole("button", { name: "Manage shared snapshots" }).click();
  const manageDialog = page.getByRole("dialog", { name: "Share conversation" });
  await expect(manageDialog).toContainText("existing links remain available until you revoke");
  page.once("dialog", (prompt) => prompt.accept());
  await manageDialog.getByRole("button", { name: "Revoke" }).click();
  await expect(manageDialog.getByText("revoked", { exact: true })).toBeVisible();
  expect((await page.request.get(publicApiPath)).status()).toBe(404);
  await page.goto(publicUrl);
  await expect(page.getByRole("heading", { name: "Snapshot unavailable" })).toBeVisible();
});
