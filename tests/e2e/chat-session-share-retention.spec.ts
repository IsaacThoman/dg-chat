/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import { activeChatSession, bootstrap, createChat, login, openSidebar } from "./helpers.ts";

async function activeConversationId(page: import("@playwright/test").Page): Promise<string> {
  const value = await page.locator(".conversation-row.active [data-conversation-actions]")
    .getAttribute("data-conversation-actions");
  expect(value).toBeTruthy();
  return value!;
}

async function openConversation(
  page: import("@playwright/test").Page,
  conversationId: string,
): Promise<void> {
  const sidebar = await openSidebar(page);
  await sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) button.conversation-open`,
  ).click();
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", conversationId);
}

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
});

test("a one-time share URL survives inactive-session LRU pressure", async ({ page }) => {
  test.setTimeout(90_000);
  await createChat(page);
  const sourceId = await activeConversationId(page);
  const prompt = `retain one-time share ${crypto.randomUUID()}`;
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(activeChatSession(page).locator(".assistant-message")).toContainText(prompt, {
    timeout: 25_000,
  });
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({
    timeout: 25_000,
  });
  const keepChatButton = page.getByRole("button", { name: "Keep chat", exact: true });
  if (await keepChatButton.isVisible()) {
    await keepChatButton.click();
    await expect(keepChatButton).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Share an immutable snapshot" })).toBeEnabled();

  const cleanIds: string[] = [];
  for (let index = 0; index < 5; index++) {
    await createChat(page);
    cleanIds.push(await activeConversationId(page));
  }
  await openConversation(page, sourceId);

  let storedShare: Record<string, unknown> | undefined;
  await page.route("**/api/shares", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { data: storedShare ? [storedShare] : [] },
    }));
  await page.route(`**/api/conversations/${sourceId}/shares`, async (route) => {
    const body = route.request().postDataJSON() as { capability: string };
    storedShare = {
      id: crypto.randomUUID(),
      conversationId: sourceId,
      leafId: crypto.randomUUID(),
      conversationVersion: 2,
      title: "Retained snapshot",
      identityVisibility: "anonymous",
      attachmentPolicy: "redact",
      attachmentCount: 0,
      messageCount: 2,
      version: 1,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revokedAt: null,
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      json: {
        share: storedShare,
        capability: body.capability,
        path: `/share/${body.capability}`,
        replayed: false,
      },
    });
  });

  await page.getByRole("button", { name: "Share an immutable snapshot" }).click();
  const dialog = page.getByRole("dialog", { name: "Share conversation" });
  await dialog.getByRole("button", { name: "Create snapshot" }).click();
  const oneTimeUrl = await dialog.getByLabel("Share link").inputValue();
  expect(oneTimeUrl).toContain("/share/");

  // The modal intentionally prevents ordinary pointer navigation. Invoke the underlying control
  // as assistive technology or an application-level navigation action can, then apply LRU pressure.
  await page.evaluate((conversationId) => {
    const action = document.querySelector(`[data-conversation-actions="${conversationId}"]`);
    const row = action?.closest(".conversation-row");
    (row?.querySelector("button.conversation-open") as HTMLButtonElement | null)?.click();
  }, cleanIds.at(-1)!);
  await expect(page.locator(`[data-chat-session="${sourceId}"]`)).toHaveAttribute("hidden", "");
  await expect(dialog).toHaveCount(0);
  const retainedOverlay = page.locator(".modal-overlay").filter({ hasText: "Snapshot ready" });
  // Native Base UI dialogs unmount their portal while closed. The owning retained chat keeps the
  // dialog state, while the inactive session exposes no overlay or focusable content at all.
  await expect(retainedOverlay).toHaveCount(0);

  for (let index = 0; index < 7; index++) await createChat(page);
  await expect(page.locator(`[data-chat-session="${sourceId}"]`)).toHaveCount(1);
  await expect(page.locator("[data-chat-session]")).toHaveCount(6);

  await openConversation(page, sourceId);
  const restoredDialog = page.getByRole("dialog", { name: "Share conversation" });
  await expect(restoredDialog).toBeVisible();
  await expect(retainedOverlay).toHaveCount(1);
  await expect(retainedOverlay).toHaveCSS("display", "grid");
  await expect(restoredDialog.getByRole("heading", { name: "Snapshot ready" })).toBeVisible();
  await expect(restoredDialog.getByLabel("Share link")).toHaveValue(oneTimeUrl);
});
