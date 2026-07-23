import { expect, test } from "@playwright/test";
import { activeChatSession, bootstrap, createChat, login, openSidebar } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
});

async function selectDeterministicChatModel(page: import("@playwright/test").Page) {
  await activeChatSession(page).locator('button.model-trigger[aria-haspopup="listbox"]').click();
  await page.getByRole("listbox", { name: "Chat model" })
    .getByRole("option", { name: /DG Chat Simulated/ }).click();
  await expect(page.getByRole("combobox", { name: "Chat model" }))
    .toContainText("DG Chat Simulated");
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
  const composer = activeChatSession(page).getByRole("textbox", { name: /message/i });
  await composer.fill("Original lifecycle branch");
  await composer.press("Enter");
  const prompt = activeChatSession(page).getByText("Original lifecycle branch", { exact: true });
  await prompt.locator("xpath=ancestor::article[1]").getByRole("button", { name: /edit/i }).click();
  await composer.fill("Edited lifecycle branch");
  await composer.press("Enter");
  await expect(
    activeChatSession(page).getByText(
      "This is a simulated response to: Edited lifecycle branch",
      { exact: true },
    ),
  ).toBeVisible();
  // Visible streamed text can precede the terminal graph event. Prove that the immutable branch
  // has been reconciled and that lifecycle mutations are unlocked before archiving it.
  await expect(
    activeChatSession(page).getByRole("button", { name: /^Previous branch for / }).first(),
  ).toBeEnabled();
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
  await expect(
    activeChatSession(page).getByText(
      "This is a simulated response to: Edited lifecycle branch",
      { exact: true },
    ),
  ).toBeVisible();
  const previousBranch = activeChatSession(page).getByRole("button", {
    name: /^Previous branch for /,
  }).first();
  await expect(previousBranch).toBeEnabled();
  await previousBranch.click();
  await expect(
    activeChatSession(page).getByText(
      "This is a simulated response to: Original lifecycle branch",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(activeChatSession(page).getByRole("textbox", { name: /message/i })).toBeHidden();
  const previewRow = (await openSidebar(page)).locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"])`,
  );
  await expect(previewRow.locator("[data-protected-work]"))
    .toHaveCount(0);

  // Creating an unrelated chat refreshes the conversation list with new object instances. The
  // archived source remains inside the normal LRU capacity, and its read-only preview must not be
  // mistaken for either a conversation identity change or unfinished work that blocks eviction.
  await createChat(page);
  await expect(page.locator(`[data-chat-session="${conversationId}"]`)).toHaveAttribute(
    "hidden",
    "",
  );
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: "Archived", exact: true }).click();
  const archivedSidebar = await openSidebar(page);
  await archivedSidebar.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) button.conversation-open`,
  ).click();
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", conversationId!);
  await expect(
    activeChatSession(page).getByText(
      "This is a simulated response to: Original lifecycle branch",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    activeChatSession(page).getByText(
      "This is a simulated response to: Edited lifecycle branch",
      { exact: true },
    ),
  ).toBeHidden();

  const graphResponse = await page.request.get(`/api/conversations/${conversationId}`);
  expect(graphResponse.ok()).toBeTruthy();
  const graph = await graphResponse.json() as {
    activeLeafId: string;
    messages: Array<{ id: string; parentId: string | null; content: string; role: string }>;
  };
  const canonicalLeafId = graph.activeLeafId;
  const visiblePreviewLeafId = graph.messages.find((message) =>
    message.role === "assistant" &&
    message.content === "This is a simulated response to: Original lifecycle branch"
  )?.id;
  expect(visiblePreviewLeafId).toBeTruthy();
  expect(visiblePreviewLeafId).not.toBe(canonicalLeafId);

  await activeChatSession(page).getByRole("button", {
    name: "Share an immutable snapshot",
  }).click();
  const shareDialog = page.getByRole("dialog", { name: "Share conversation" });
  await shareDialog.getByRole("button", { name: "Create snapshot" }).click();
  await expect(shareDialog.getByLabel("Share link")).toBeVisible();
  const shareListResponse = await page.request.get("/api/shares");
  expect(shareListResponse.ok()).toBeTruthy();
  const shareList = await shareListResponse.json() as {
    data: Array<{ conversationId: string; leafId: string }>;
  };
  expect(
    shareList.data.find((share) => share.conversationId === conversationId)?.leafId,
  ).toBe(visiblePreviewLeafId);
  page.once("dialog", (dialog) => dialog.accept());
  await shareDialog.locator(".modal-actions").getByRole("button", { name: "Close" }).click();

  const treeTrigger = activeChatSession(page).getByRole("button", {
    name: /^View conversation tree from /,
  }).first();
  await treeTrigger.press("Enter");
  const treeDialog = page.getByRole("dialog", { name: "Conversation tree" });
  await expect(treeDialog).toBeVisible();
  await expect(treeDialog.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.getByRole("treeitem").first()).not.toHaveAttribute("aria-disabled", "true");
  const treeConversationId = await activeChatSession(page).getAttribute("data-chat-session");
  await page.keyboard.press("ControlOrMeta+K");
  await expect(treeDialog).toBeVisible();
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", treeConversationId!);
  await expect(treeDialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(treeDialog).toBeHidden();
  await expect(treeTrigger).toBeFocused();

  await openSidebar(page);
  await actions.click();
  await page.getByRole("menuitem", { name: "Restore to chats" }).click();
  await (await openSidebar(page)).getByRole("button", { name: "Chats", exact: true }).click();
  await openSidebar(page);
  await page.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) button.conversation-open`,
  ).click();
  await expect(
    activeChatSession(page).getByText(
      "This is a simulated response to: Edited lifecycle branch",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    activeChatSession(page).getByText(
      "This is a simulated response to: Original lifecycle branch",
      { exact: true },
    ),
  ).toBeHidden();
  const restoredComposer = activeChatSession(page).getByRole("textbox", { name: /message/i });
  await restoredComposer.fill("Continue only from the canonical lifecycle branch");
  await restoredComposer.press("Enter");
  await expect(
    activeChatSession(page).getByText(
      "This is a simulated response to: Continue only from the canonical lifecycle branch",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    activeChatSession(page).getByRole("button", { name: "Stop generating" }),
  ).toBeHidden({ timeout: 20_000 });
  const restoredGraphResponse = await page.request.get(`/api/conversations/${conversationId}`);
  expect(restoredGraphResponse.ok()).toBeTruthy();
  const restoredGraph = await restoredGraphResponse.json() as {
    messages: Array<{ parentId: string | null; content: string; role: string }>;
  };
  expect(
    restoredGraph.messages.find((message) =>
      message.role === "user" &&
      message.content === "Continue only from the canonical lifecycle branch"
    )?.parentId,
  ).toBe(canonicalLeafId);
});
