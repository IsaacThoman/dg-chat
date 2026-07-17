import { expect, test } from "@playwright/test";
import { activeChatSession, bootstrap, createChat, login } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

test("editing a prompt creates a recoverable branch", async ({ page }) => {
  const session = activeChatSession(page);
  const composer = session.getByRole("textbox", { name: /message/i });
  await composer.fill("Original branch prompt");
  await composer.press("Enter");
  await expect(session.getByText("Original branch prompt", { exact: true })).toBeVisible();
  await expect(session.getByText(/simulated response to: Original branch prompt/i)).toBeVisible();

  const prompt = session.getByText("Original branch prompt", { exact: true });
  await prompt.hover();
  await prompt.locator("xpath=ancestor::*[self::article or @data-message-id][1]").getByRole(
    "button",
    { name: /edit/i },
  ).click();
  const editor = session.getByRole("textbox", { name: "Edit message in a new branch" });
  const editNotice = session.getByRole("status").filter({
    hasText: "Immutable edit: create a new branch",
  });
  await expect(editNotice).toContainText(
    "The original message and every response after it will stay intact.",
  );
  const editNoticeId = await editNotice.getAttribute("id");
  expect(editNoticeId).toBeTruthy();
  await expect(editor).toHaveAttribute("aria-describedby", editNoticeId!);
  await expect(
    session.getByRole("button", { name: "Send edited message as a new branch" }),
  ).toBeVisible();
  await expect(editor).toBeFocused();
  await editor.fill("Edited branch prompt");
  await session.getByRole("button", { name: /send|save/i }).click();

  await expect(session.getByText("Edited branch prompt", { exact: true })).toBeVisible();
  await expect(session.getByText("Original branch prompt", { exact: true })).toBeHidden();

  await session.getByRole("button", { name: /^Previous branch for user message 1$/ }).click();
  await expect(session.getByRole("group", {
    name: "Branch navigation for user message 1",
  })).toBeFocused();
  await expect(session.getByText("Original branch prompt", { exact: true })).toBeVisible();
  await expect(session.getByText("Edited branch prompt", { exact: true })).toBeHidden();

  await session.getByRole("button", { name: /^Next branch for user message 1$/ }).click();
  await expect(session.getByRole("group", {
    name: "Branch navigation for user message 1",
  })).toBeFocused();
  await expect(session.getByText("Edited branch prompt", { exact: true })).toBeVisible();
  await expect(session.getByText("Original branch prompt", { exact: true })).toBeHidden();
});

test("branch controls identify their owning message when separate turns branch", async ({ page }) => {
  const session = activeChatSession(page);
  const composer = session.getByRole("textbox", { name: /message/i });

  await composer.fill("First independently branched turn");
  await composer.press("Enter");
  await expect(session.getByText(/simulated response to: First independently branched turn/i))
    .toBeVisible();
  await session.getByRole("button", { name: "Regenerate response in a new branch" }).click();

  const assistantBranches = session.getByRole("group", {
    name: "Branch navigation for assistant message 2",
  });
  await expect(assistantBranches).toBeVisible();
  await expect(
    assistantBranches.getByRole("status", {
      name: "Branch position for assistant message 2: 2 of 2",
    }),
  ).toBeVisible();

  await composer.fill("Second independently branched turn");
  await composer.press("Enter");
  await expect(session.getByText(/simulated response to: Second independently branched turn/i))
    .toBeVisible();
  const secondPrompt = session.getByText("Second independently branched turn", { exact: true });
  await secondPrompt.locator("xpath=ancestor::article[1]").getByRole("button", { name: /edit/i })
    .click();
  await composer.fill("Edited second independently branched turn");
  await composer.press("Enter");
  await expect(
    session.getByText(/simulated response to: Edited second independently branched turn/i),
  ).toBeVisible();

  const userBranches = session.getByRole("group", {
    name: "Branch navigation for user message 3",
  });
  await expect(assistantBranches).toBeVisible();
  await expect(userBranches).toBeVisible();
  const userStatus = userBranches.getByRole("status", {
    name: "Branch position for user message 3: 2 of 2",
  });
  await expect(userStatus).toBeVisible();
  const userStatusId = await userStatus.getAttribute("id");
  expect(userStatusId).toBeTruthy();
  await expect(userBranches).toHaveAttribute("aria-describedby", userStatusId!);
  await expect(
    userBranches.getByRole("button", { name: "Previous branch for user message 3" }),
  ).toHaveAttribute("aria-describedby", userStatusId!);

  await userBranches.getByRole("button", { name: "Previous branch for user message 3" }).click();
  await expect(userBranches).toBeFocused();
  await expect(session.getByText("Second independently branched turn", { exact: true }))
    .toBeVisible();
  await expect(session.getByText("Edited second independently branched turn", { exact: true }))
    .toBeHidden();

  await assistantBranches.getByRole("button", {
    name: "Previous branch for assistant message 2",
  }).click();
  await expect(assistantBranches).toBeFocused();
  await expect(session.getByText("Second independently branched turn", { exact: true }))
    .toBeHidden();
});

test("conversation tree uses a single roving tab stop and complete arrow navigation", async ({ page }) => {
  const session = activeChatSession(page);
  const composer = session.getByRole("textbox", { name: /message/i });
  await composer.fill("Tree keyboard navigation seed");
  await composer.press("Enter");
  await expect(session.getByText(/simulated response to: Tree keyboard navigation seed/i))
    .toBeVisible();
  await session.getByRole("button", { name: "Regenerate response in a new branch" }).click();

  const treeTrigger = session.getByRole("button", {
    name: /^View conversation tree from assistant message 2$/,
  });
  await treeTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Conversation tree" });
  const tree = dialog.getByRole("tree", { name: "Conversation branches" });
  const enabledItems = tree.locator('[role="treeitem"]:not([aria-disabled="true"])');
  const tabStop = tree.locator('[role="treeitem"][tabindex="0"]');
  await expect(tabStop).toHaveCount(1);
  await expect(enabledItems.first()).toHaveAttribute("aria-expanded", "true");
  await expect(enabledItems.last()).not.toHaveAttribute("aria-expanded", /.+/);

  await tabStop.focus();
  const firstFocusedId = await tabStop.getAttribute("data-tree-message-id");
  await tabStop.press("ArrowDown");
  await expect(tabStop).toHaveCount(1);
  await expect(tabStop).toBeFocused();
  expect(await tabStop.getAttribute("data-tree-message-id")).not.toBe(firstFocusedId);
  await tabStop.press("End");
  await expect(enabledItems.last()).toBeFocused();
  await enabledItems.last().press("Home");
  await expect(enabledItems.first()).toBeFocused();
  await enabledItems.first().press("ArrowRight");
  await expect(enabledItems.nth(1)).toBeFocused();
  await enabledItems.nth(1).press("ArrowLeft");
  await expect(enabledItems.first()).toBeFocused();

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(treeTrigger).toBeFocused();
});

test("composer supports keyboard submission and does not submit Shift+Enter", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill("first line");
  await composer.press("Shift+Enter");
  await composer.type("second line");
  await expect(composer).toHaveValue(/first line\nsecond line/);
  await composer.press("Enter");
  await expect(
    activeChatSession(page).locator("article.user-message").filter({
      hasText: /first line\s*second line/,
    }),
  )
    .toBeVisible();
});

test("composer ignores IME composition Enter and sends only after composition ends", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill("正在输入");
  await composer.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
    );
  });
  await expect(composer).toHaveValue("正在输入");
  await expect(activeChatSession(page).locator("article.user-message")).toHaveCount(0);
  await composer.press("Enter");
  await expect(page.getByText("正在输入", { exact: true })).toBeVisible();
});

test("canceling an immutable edit restores the existing draft", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill("Saved message");
  await composer.press("Enter");
  await expect(page.getByText(/simulated response to: Saved message/i)).toBeVisible();
  const draft = Array.from(
    { length: 18 },
    (_, index) => `Unsent draft line ${index + 1} that must survive`,
  ).join("\n");
  await composer.fill(draft);
  const draftBounds = await composer.boundingBox();
  expect(draftBounds?.height ?? 0).toBeGreaterThan(34);
  expect(draftBounds?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(160);
  expect(await composer.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  const prompt = page.getByText("Saved message", { exact: true });
  await prompt.locator("xpath=ancestor::article[1]").getByRole("button", { name: /edit/i }).click();
  await expect(composer).toHaveValue("Saved message");
  const editBounds = await composer.boundingBox();
  expect(editBounds?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(draftBounds?.height ?? 0);
  await page.getByRole("button", { name: "Cancel edit" }).click();
  await expect(composer).toHaveValue(draft);
  await expect(composer).toBeFocused();
  expect(
    await composer.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
      length: (element as HTMLTextAreaElement).value.length,
    })),
  ).toEqual({
    start: draft.length,
    end: draft.length,
    length: draft.length,
  });
  const restoredBounds = await composer.boundingBox();
  expect(restoredBounds?.height).toBe(draftBounds?.height);
  expect(await composer.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
});

test("edit mode locks generation and branch actions without losing draft", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill("Branch action lock seed");
  await composer.press("Enter");

  const regenerate = page.getByRole("button", { name: "Regenerate response in a new branch" });
  await expect(regenerate).toBeEnabled();
  await regenerate.click();
  await expect(page.getByRole("status", { name: /Branch position for .*: 2 of 2/ })).toBeVisible();
  await expect(regenerate).toBeEnabled();

  await composer.fill("Unsent draft protected from special actions");
  const prompt = page.getByText("Branch action lock seed", { exact: true });
  await prompt.locator("xpath=ancestor::article[1]").getByRole("button", { name: /edit/i }).click();
  await expect(composer).toHaveValue("Branch action lock seed");

  await expect(regenerate).toBeDisabled();
  await expect(page.getByRole("button", { name: "Continue response" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Previous branch for / })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^View conversation tree from / })).toBeDisabled();

  await page.getByRole("button", { name: "Cancel edit" }).click();
  await expect(composer).toHaveValue("Unsent draft protected from special actions");
  await expect(regenerate).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Previous branch for / })).toBeEnabled();
});

test("a delayed active-leaf switch blocks every generation entry point", async ({ page }) => {
  const session = activeChatSession(page);
  const composer = session.locator("textarea[data-chat-composer]");
  await composer.fill("Branch switch generation lock seed");
  await composer.press("Enter");
  await expect(session.getByText(/simulated response to: Branch switch generation lock seed/i))
    .toBeVisible();
  await session.getByRole("button", { name: "Regenerate response in a new branch" }).click();

  const previousBranch = session.getByRole("button", {
    name: /^Previous branch for assistant message 2$/,
  });
  await expect(previousBranch).toBeEnabled();
  await composer.fill("Draft must wait for the canonical branch");

  let releaseLeafSwitch!: () => void;
  const leafSwitchGate = new Promise<void>((resolve) => {
    releaseLeafSwitch = resolve;
  });
  let selectedLeafId = "";
  let leafSwitchPending = false;
  await page.route("**/api/conversations/*/active-leaf", async (route) => {
    const body = route.request().postDataJSON() as { leafId?: string };
    selectedLeafId = body.leafId ?? "";
    leafSwitchPending = true;
    await leafSwitchGate;
    await route.continue();
  });

  const generationBodies: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/generate/stream")
    ) {
      generationBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await previousBranch.click();
  await expect.poll(() => leafSwitchPending).toBe(true);
  expect(selectedLeafId).toBeTruthy();
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveValue("Draft must wait for the canonical branch");
  await expect(session.getByText(/Switching branches… New generations/)).toBeVisible();
  await expect(session.getByRole("button", { name: "Regenerate response in a new branch" }))
    .toBeDisabled();
  await expect(session.getByRole("button", { name: "Continue response" })).toBeDisabled();

  // Temporarily removing the DOM-level disabled attribute and dispatching events directly proves
  // the workflow guards—not only the visible controls—reject stale-leaf generation attempts.
  for (const name of ["Regenerate response in a new branch", "Continue response"]) {
    await session.getByRole("button", { name }).evaluate((button) => {
      button.removeAttribute("disabled");
      (button as HTMLButtonElement).click();
      button.setAttribute("disabled", "");
    });
  }
  await session.locator("form.composer").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => generationBodies.length, { timeout: 1_000 }).toBe(0);

  releaseLeafSwitch();
  await expect(composer).toBeEnabled();
  await composer.press("Enter");
  await expect.poll(() => generationBodies.length).toBe(1);
  expect(generationBodies[0]?.parentId).toBe(selectedLeafId);
  await expect(
    session.getByText(/simulated response to: Draft must wait for the canonical branch/i),
  )
    .toBeVisible();
});

test("editing preserves the original Markdown source exactly", async ({ page }) => {
  const markdown = "**Bold** and `code` with _emphasis_";
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill(markdown);
  await composer.press("Enter");

  const prompt = activeChatSession(page).locator("article.user-message").filter({
    hasText: "Bold and code",
  });
  await prompt.getByRole("button", { name: /edit/i }).click();
  await expect(composer).toHaveValue(markdown);
});
