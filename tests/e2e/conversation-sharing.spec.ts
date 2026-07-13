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
  let createBody: Record<string, unknown> | undefined;
  let idempotencyKey = "";
  await page.route(`**/api/conversations/${conversationId}/shares`, async (route) => {
    createBody = route.request().postDataJSON();
    idempotencyKey = await route.request().headerValue("idempotency-key") ?? "";
    storedSummary = ownerSummary;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        share: ownerSummary,
        capability,
        path: `/share/${capability}`,
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
  await expect(dialog).toContainText("Future edits and branches will never change it");
  await expect(dialog.getByRole("radio", { name: "Anonymous" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Redact all" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create snapshot" }).click();
  await expect(dialog.getByRole("heading", { name: "Snapshot ready" })).toBeVisible();
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    `http://localhost:5173/share/${capability}`,
  );
  expect(createBody).toMatchObject({
    identityVisibility: "anonymous",
    attachmentPolicy: "redact",
    selectedAttachmentIds: [],
  });
  expect(String(createBody?.capability)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(idempotencyKey.length).toBeGreaterThanOrEqual(8);

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
              model: null,
              status: "complete",
              attachmentIds: [],
              createdAt,
            },
            {
              id: "public-message-2",
              parentId: "public-message-1",
              role: "assistant",
              content: "Read [the guide](https://example.com).",
              model: "simulator/fast",
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
  const external = page.getByRole("link", { name: "the guide" });
  await expect(external).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
});
