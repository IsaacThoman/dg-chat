import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login, openSidebar } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
});

async function selectDeterministicChatModel(page: import("@playwright/test").Page) {
  await page.locator('button.model-trigger[aria-haspopup="listbox"]').click();
  await page.getByRole("listbox", { name: "Chat model" })
    .getByRole("option", { name: /DG Chat Simulated/ }).click();
  await expect(page.getByRole("button", { name: /DG Chat Simulated/ })).toBeVisible();
}

test("conversation rename, archive, trash, and restore remain recoverable", async ({ page }) => {
  const title = `Lifecycle ${Date.now()}`;
  await createChat(page);
  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();
  const actions = page.locator(`[data-conversation-actions="${conversationId}"]`);

  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation title", exact: true }).fill(title);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();

  await openSidebar(page);
  await actions.click();
  const archive = page.getByRole("menuitem", { name: "Archive", exact: true });
  await archive.click();
  await expect(archive).toBeHidden();
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(actions).toBeVisible();
  await expect(page.getByText(
    "Restore this conversation to Chats before editing or continuing it.",
    { exact: true },
  )).toBeVisible();

  await openSidebar(page);
  await actions.click();
  await page.getByRole("menuitem", { name: "Restore to chats", exact: true }).click();
  await expect(actions).toBeHidden();

  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await openSidebar(page);
  await actions.click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(actions).toBeVisible();

  await openSidebar(page);
  await actions.click();
  const restore = page.getByRole("menuitem", { name: "Restore to Chats", exact: true });
  await restore.click();
  await expect(restore).toBeHidden();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(actions).toBeHidden();
  await openSidebar(page);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(actions).toBeVisible();
});

test("pinning, menu keyboard behavior, and modal focus are accessible", async ({ page }) => {
  await createChat(page);
  await openSidebar(page);
  const activeActions = page.locator(".conversation-row.active [data-conversation-actions]");
  const conversationId = await activeActions.getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();
  const actions = page.locator(
    `[data-conversation-actions="${conversationId}"]`,
  );
  await actions.focus();
  await actions.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await page.getByRole("menuitem", { name: "Rename" }).press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Organize" })).toBeFocused();
  await page.getByRole("menuitem", { name: "Organize" }).press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Pin" })).toBeFocused();
  await page.getByRole("menuitem", { name: "Pin" }).press("Escape");
  await expect(actions).toBeFocused();

  await actions.press("Enter");
  const pin = page.getByRole("menuitem", { name: "Pin" });
  await pin.press("Enter");
  await expect(pin).toBeHidden();
  await expect(actions).toBeFocused();
  await expect(page.getByText("PINNED", { exact: true })).toBeVisible();
  await actions.press("Enter");
  const openUnpin = page.getByRole("menuitem", { name: "Unpin" });
  await expect(openUnpin).toBeVisible();
  await openUnpin.press("Escape");
  await expect(openUnpin).toBeHidden();
  await expect(actions).toBeFocused();
  await actions.press("Enter");

  await page.getByRole("menuitem", { name: "Rename" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Rename conversation" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(actions).toBeFocused();
  await actions.press("Enter");
  const unpin = page.getByRole("menuitem", { name: "Unpin" });
  await unpin.press("Enter");
  await expect(unpin).toBeHidden();
});

test("lifecycle query failures show a retry state instead of an empty list", async ({ page }) => {
  await page.route(
    "**/api/conversations",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "offline" } }),
      }),
  );
  await page.reload();
  await expect(page.locator("main[role=alert]")).toContainText(
    /conversations are unavailable|couldn’t load conversations/i,
  );
  await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
});

test("lifecycle lists show loading before empty state", async ({ page }) => {
  let signalRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => signalRequestStarted = resolve);
  let releaseResponse!: () => void;
  const responseReleased = new Promise<void>((resolve) => releaseResponse = resolve);
  await page.route("**/api/conversations", async (route) => {
    signalRequestStarted();
    await responseReleased;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
  // Durable test data may select a real conversation before this reload. Clear it before the new
  // app executes; changing storage in the current app can race with its selection-persistence
  // effect and put the id back before navigation commits.
  await page.addInitScript(() => sessionStorage.removeItem("dg-chat.active-conversation"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await requestStarted;
  try {
    await expect(page.getByRole("status").filter({ hasText: "Loading conversations" }).first())
      .toBeVisible();
    await expect(page.getByRole("heading", { name: "Start a new conversation" })).toBeHidden();
  } finally {
    releaseResponse();
  }
  await expect(page.getByRole("heading", { name: "Start a new conversation" })).toBeVisible();
});

test("archived chats keep immutable branches navigable without becoming editable", async ({ page }) => {
  await createChat(page);
  await selectDeterministicChatModel(page);
  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();
  const actions = page.locator(`[data-conversation-actions="${conversationId}"]`);
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill("Original lifecycle branch");
  await composer.press("Enter");
  const prompt = page.getByText("Original lifecycle branch", { exact: true });
  await prompt.locator("xpath=ancestor::article[1]").getByRole("button", { name: /edit/i }).click();
  await composer.fill("Edited lifecycle branch");
  await composer.press("Enter");
  await expect(page.getByText(
    "This is a simulated response to: Edited lifecycle branch",
    { exact: true },
  )).toBeVisible();
  // Visible streamed text can precede the terminal graph event. Prove that the immutable branch
  // has been reconciled and that lifecycle mutations are unlocked before archiving it.
  await expect(page.getByRole("button", { name: "Previous branch" }).first()).toBeEnabled();
  await openSidebar(page);
  await expect(actions).toBeEnabled();
  await actions.click();
  const archive = page.getByRole("menuitem", { name: "Archive" });
  await archive.click();
  await expect(archive).toBeHidden();
  await page.getByRole("button", { name: "Archived" }).click();
  await openSidebar(page);
  await page.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) > button`,
  )
    .first().click();
  await expect(page.getByText(
    "This is a simulated response to: Edited lifecycle branch",
    { exact: true },
  )).toBeVisible();
  const previousBranch = page.getByRole("button", { name: "Previous branch" }).first();
  await expect(previousBranch).toBeEnabled();
  await previousBranch.click();
  await expect(page.getByText(
    "This is a simulated response to: Original lifecycle branch",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole("textbox", { name: /message/i })).toBeHidden();
  const treeTrigger = page.getByRole("button", { name: "View conversation tree" }).first();
  await treeTrigger.press("Enter");
  const treeDialog = page.getByRole("dialog", { name: "Conversation tree" });
  await expect(treeDialog).toBeVisible();
  await expect(treeDialog.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.getByRole("treeitem").first()).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(treeDialog).toBeHidden();
  await expect(treeTrigger).toBeFocused();

  await openSidebar(page);
  await actions.click();
  await page.getByRole("menuitem", { name: "Restore to chats" }).click();
});
