/// <reference lib="dom" />

import { expect, type Page, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import { activeChatSession, apiURL, bootstrap, createChat, login, openSidebar } from "./helpers.ts";

async function activeConversationId(page: Page): Promise<string> {
  const id = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(id).toBeTruthy();
  return id!;
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  const sidebar = await openSidebar(page);
  await sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) button.conversation-open`,
  ).click();
  await expect(page.locator(`[data-chat-session="${conversationId}"]`)).not.toHaveAttribute(
    "hidden",
    "",
  );
}

async function selectSlowStream(page: Page): Promise<void> {
  await activeChatSession(page).locator('button.model-trigger[aria-haspopup="listbox"]').click();
  await page.getByRole("listbox", { name: "Chat model" })
    .getByRole("option", { name: /DG Chat Slow Stream/ }).click();
}

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  // Let the initial lifecycle query settle before createChat snapshots the current row. Otherwise
  // a fallback selection can satisfy the helper's "active id changed" assertion while the
  // requested conversation is still being created.
  const sidebar = await openSidebar(page);
  await expect(sidebar.getByText("Loading conversations…", { exact: true })).toHaveCount(0);
  const existing = await page.request.get(`${apiURL}/api/conversations`);
  expect(existing.ok()).toBeTruthy();
  const existingBody = await existing.json() as { data: unknown[] };
  if (existingBody.data.length > 0) {
    await expect(page.locator(".conversation-row.active [data-conversation-actions]"))
      .toHaveCount(1);
  }
  await createChat(page);
});

test("drafts and ready uploads survive conversation, view, and new-chat switches", async ({ page }) => {
  const attachment = {
    id: crypto.randomUUID(),
    filename: "continuity-notes.txt",
    mimeType: "text/plain",
    sizeBytes: 14,
    state: "ready",
    createdAt: new Date().toISOString(),
  };
  await page.route(
    "**/api/attachments",
    (route) =>
      route.fulfill({ status: 201, contentType: "application/json", json: { attachment } }),
  );

  const firstId = await activeConversationId(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("First conversation draft");
  await activeChatSession(page).locator('input[type="file"]').setInputFiles({
    name: attachment.filename,
    mimeType: attachment.mimeType,
    buffer: Buffer.from("continuity data"),
  });
  await expect(page.getByText("1 KB · Ready", { exact: true })).toBeVisible();

  await (await openSidebar(page)).getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await (await openSidebar(page)).getByRole("button", { name: "Chats", exact: true }).click();
  await expect(composer).toHaveValue("First conversation draft");
  await expect(activeChatSession(page).getByText("continuity-notes.txt", { exact: true }))
    .toBeVisible();

  await createChat(page);
  const secondId = await activeConversationId(page);
  expect(secondId).not.toBe(firstId);
  await page.getByRole("textbox", { name: "Message" }).fill("Second conversation draft");

  await openConversation(page, firstId);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "First conversation draft",
  );
  await expect(activeChatSession(page).getByText("continuity-notes.txt", { exact: true }))
    .toBeVisible();

  await openConversation(page, secondId);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Second conversation draft",
  );
});

test("an immutable edit draft survives switching to a new conversation", async ({ page }) => {
  const firstId = await activeConversationId(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Saved edit source");
  await composer.press("Enter");
  await expect(page.getByText(/simulated response to: Saved edit source/i)).toBeVisible();

  await page.getByText("Saved edit source", { exact: true }).locator("xpath=ancestor::article[1]")
    .getByRole("button", { name: "Edit without overwriting" }).click();
  await expect(composer).toHaveValue("Saved edit source");
  await composer.fill("Unsaved immutable edit branch");
  await expect(composer).toHaveValue("Unsaved immutable edit branch");

  await createChat(page);
  const retainedComposer = page.locator(
    `[data-chat-session="${firstId}"] textarea[aria-label="Edit message in a new branch"]`,
  );
  await expect(retainedComposer).toHaveValue("Unsaved immutable edit branch");
  await openConversation(page, firstId);
  await expect(
    activeChatSession(page).getByText("Immutable edit: create a new branch", { exact: true }),
  )
    .toBeVisible();
  await expect(page.getByRole("textbox", { name: "Edit message in a new branch" })).toHaveValue(
    "Unsaved immutable edit branch",
  );
});

test("evicts oldest clean chat sessions while retaining a protected draft", async ({ page }) => {
  const protectedId = await activeConversationId(page);
  const draft = "Keep this unsaved draft while clean sessions are released";
  await page.getByRole("textbox", { name: "Message" }).fill(draft);

  const cleanIds: string[] = [];
  for (let index = 0; index < 7; index++) {
    await createChat(page);
    cleanIds.push(await activeConversationId(page));
  }

  await expect(page.locator("[data-chat-session]")).toHaveCount(6);
  await expect(page.locator(`[data-chat-session="${protectedId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-chat-session="${cleanIds[0]}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-chat-session="${cleanIds.at(-1)}"]`)).toHaveCount(1);

  await openConversation(page, protectedId);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(draft);
});

test("hard-bounds mounted chats without discarding protected drafts", async ({ page }) => {
  const drafts = new Map<string, string>();
  for (let index = 0; index < 6; index++) {
    const conversationId = await activeConversationId(page);
    const draft = `Protected capacity draft ${index + 1}`;
    drafts.set(conversationId, draft);
    await page.getByRole("textbox", { name: "Message" }).fill(draft);
    if (index < 5) await createChat(page);
  }

  const activeBeforeDeniedVisit = await activeConversationId(page);
  await expect(page.locator("[data-chat-session]")).toHaveCount(6);
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: "New chat ⌘ K", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Six chats already contain unsent or in-progress work",
  );
  await expect(page.getByRole("button", { name: "Review unfinished chat", exact: true }))
    .toBeFocused();
  await expect(page.locator("[data-chat-session]")).toHaveCount(6);
  expect(await activeConversationId(page)).toBe(activeBeforeDeniedVisit);

  const [oldestProtectedId, oldestDraft] = drafts.entries().next().value!;
  const oldestRow = page.locator(
    `.conversation-row:has([data-conversation-actions="${oldestProtectedId}"])`,
  );
  await expect(page.locator('[data-protected-work="unfinished"]')).toHaveCount(6);
  await expect(oldestRow.locator('[data-protected-work="unfinished"]'))
    .toHaveText("Unfinished");
  const describedBy = await oldestRow.locator("button.conversation-open")
    .getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(oldestRow.locator(`[id="${describedBy}"]`))
    .toHaveText("This chat has unfinished work.");

  await page.getByRole("button", { name: "Dismiss chat limit notice", exact: true }).click();
  await expect(activeChatSession(page).getByRole("textbox", { name: "Message" }))
    .toBeFocused();
  await (await openSidebar(page)).getByRole("button", { name: "New chat ⌘ K", exact: true })
    .click();

  await page.getByRole("button", { name: "Review unfinished chat", exact: true }).click();
  expect(await activeConversationId(page)).toBe(oldestProtectedId);
  await expect(activeChatSession(page).getByRole("textbox", { name: "Message" }))
    .toHaveValue(oldestDraft);
  await expect(activeChatSession(page).getByRole("textbox", { name: "Message" })).toBeFocused();
  await expect(page.locator("[data-chat-session]")).toHaveCount(6);

  await page.getByRole("textbox", { name: "Message" }).fill("");
  await createChat(page);
  await expect(page.locator("[data-chat-session]")).toHaveCount(6);

  const [preservedId, preservedDraft] = [...drafts.entries()][1];
  await openConversation(page, preservedId);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(preservedDraft);
  await expect(page.locator("[data-chat-session]")).toHaveCount(6);
});

test("a capacity-rejected lifecycle view never exposes an unrelated retained chat", async ({ page }) => {
  const origin = new URL(page.url()).origin;
  const createdResponse = await page.request.post("/api/conversations", {
    headers: {
      Origin: origin,
      "Idempotency-Key": `archived-capacity-${crypto.randomUUID()}`,
    },
    data: { title: "Archived capacity destination", temporary: false },
  });
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const archived = await createdResponse.json() as { id: string; version: number };
  const archivedResponse = await page.request.patch(`/api/conversations/${archived.id}`, {
    headers: { Origin: origin },
    data: { archived: true, expectedVersion: archived.version },
  });
  expect(archivedResponse.ok(), await archivedResponse.text()).toBeTruthy();

  await page.reload();
  await expect(activeChatSession(page)).toHaveCount(1);
  let liveConversationId = "";
  let liveDraft = "";
  for (let index = 0; index < 6; index++) {
    liveConversationId = await activeConversationId(page);
    liveDraft = `Lifecycle capacity draft ${index + 1}`;
    await activeChatSession(page).getByRole("textbox", { name: "Message" }).fill(liveDraft);
    if (index < 5) await createChat(page);
  }
  await expect(page.locator('[data-protected-work="unfinished"]')).toHaveCount(6);

  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Six chats already contain unsent or in-progress work",
  );
  await expect(page.getByRole("heading", { name: "Conversation not opened" })).toBeVisible();
  await expect(activeChatSession(page)).toHaveCount(0);
  await expect(page.locator(`[data-chat-session="${liveConversationId}"]`)).toHaveAttribute(
    "hidden",
    "",
  );
  await expect.poll(async () =>
    await page.locator("textarea").evaluateAll((elements, expected) =>
      elements
        .filter((element) => (element as HTMLTextAreaElement).value === expected)
        .map((element) => Boolean(element.closest("[hidden]"))), liveDraft)
  ).toEqual([true]);
});

test("capacity recovery focuses Stop before the composer for an in-progress chat", async ({ page }) => {
  test.setTimeout(90_000);
  const streamingId = await activeConversationId(page);
  for (let index = 0; index < 5; index++) {
    await createChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill(`Protected recovery draft ${index}`);
  }
  await openConversation(page, streamingId);
  await selectSlowStream(page);
  const longPrompt = Array.from({ length: 320 }, (_, index) => `capacity-stream-${index}`).join(
    " ",
  );
  await page.getByRole("textbox", { name: "Message" }).fill(longPrompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await (await openSidebar(page)).getByRole("button", { name: "New chat ⌘ K", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Six chats already contain unsent or in-progress work",
  );
  await page.getByRole("button", { name: "Review unfinished chat", exact: true }).click();
  expect(await activeConversationId(page)).toBe(streamingId);
  const stop = activeChatSession(page).getByRole("button", { name: "Stop generating" });
  await expect(stop).toBeFocused();
  await stop.click();
  await expect(stop).toBeHidden();
});

test("a same-tick new-chat action burst creates exactly one conversation", async ({ page }) => {
  const beforeResponse = await page.request.get(`${apiURL}/api/conversations`);
  expect(beforeResponse.ok()).toBeTruthy();
  const before = await beforeResponse.json() as { data: Array<{ id: string }> };
  const beforeIds = new Set(before.data.map((conversation) => conversation.id));
  let createRequests = 0;
  let createdRequestFinished = false;
  let delayedRefreshes = 0;
  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET" && createdRequestFinished && delayedRefreshes === 0) {
      delayedRefreshes += 1;
      await refreshGate;
      await route.continue();
      return;
    }
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createRequests += 1;
    // Keep the first request pending long enough for React state updates to be irrelevant. The
    // synchronous claim, rather than a rerendered disabled button, must reject the same-task burst.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const response = await route.fetch();
    createdRequestFinished = true;
    await route.fulfill({ response });
  });

  const sidebar = await openSidebar(page);
  // Keep a DOM locator after the mobile drawer closes; role locators intentionally exclude the
  // now-inert sidebar even though the retained button is the element whose busy state we verify.
  const newChat = sidebar.locator("button.new-chat");
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/conversations"
  );
  await newChat.evaluate((element) => {
    const button = element as HTMLButtonElement;
    // Dispatch both repeated clicks and the documented shortcut in one browser task. React has no
    // opportunity to commit its busy state between these entry points. On desktop the shortcut is
    // the winning action; the mobile modal drawer intentionally suppresses global shortcuts, so
    // its first click wins instead.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
    button.click();
    button.click();
  });
  await expect(newChat).toBeDisabled();
  await expect(newChat).toHaveAttribute("aria-busy", "true");

  const response = await createdResponse;
  expect(response.ok(), response.ok() ? "conversation created" : await response.text())
    .toBeTruthy();
  const created = await response.json() as { id: string };
  expect(createRequests).toBe(1);

  // The list refresh is deliberately still pending. A newly created chat must become usable from
  // the POST response itself instead of making keyboard users wait on a redundant list fetch.
  await expect.poll(() => delayedRefreshes).toBe(1);
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", created.id);
  await expect(activeChatSession(page).getByRole("textbox", { name: "Message" })).toBeFocused();
  releaseRefresh?.();

  await expect.poll(async () => {
    const conversationsResponse = await page.request.get(`${apiURL}/api/conversations`);
    if (!conversationsResponse.ok()) return [];
    const conversations = await conversationsResponse.json() as { data: Array<{ id: string }> };
    return conversations.data.filter((conversation) => !beforeIds.has(conversation.id))
      .map((conversation) => conversation.id);
  }).toEqual([created.id]);
  await expect(page.locator(".conversation-row.active [data-conversation-actions]"))
    .toHaveAttribute(
      "data-conversation-actions",
      created.id,
    );
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", created.id);
  await expect(activeChatSession(page).getByRole("textbox", { name: "Message" })).toBeFocused();
  const activationAnnouncement = page.locator(".chat-activation-announcement");
  await expect(activationAnnouncement)
    .toHaveText("New chat ready. Message composer focused.");
  await expect(activationAnnouncement).toHaveAttribute("aria-live", "polite");
  await expect(activationAnnouncement).toHaveAttribute("aria-atomic", "true");
  await expect(activationAnnouncement).not.toHaveAttribute("role", "status");
  expect(await page.locator("[data-chat-session]").count()).toBeLessThanOrEqual(6);
});

test("a chat created during a capacity race remains explicitly recoverable without another POST", async ({ page }) => {
  test.setTimeout(90_000);
  for (let index = 0; index < 5; index++) {
    await page.getByRole("textbox", { name: "Message" }).fill(`Race-protected draft ${index}`);
    await createChat(page);
  }
  const cleanActiveId = await activeConversationId(page);
  await expect(page.locator("[data-chat-session]")).toHaveCount(6);
  await expect(page.locator('[data-protected-work="unfinished"]')).toHaveCount(5);

  let createRequests = 0;
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createRequests += 1;
    const response = await route.fetch();
    await responseGate;
    await route.fulfill({ response });
  });

  const sidebar = await openSidebar(page);
  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/conversations"
  );
  await sidebar.locator("button.new-chat").click();
  await expect.poll(() => createRequests).toBe(1);

  // The capacity probe already admitted this request. Protect the last clean mounted session
  // before the delayed successful response is allowed to activate its newly created chat.
  await page.locator(
    `[data-chat-session="${cleanActiveId}"] textarea[aria-label="Message"]`,
  ).evaluate((textarea) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, "Draft added while conversation creation is pending");
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await expect(page.locator('[data-protected-work="unfinished"]')).toHaveCount(6);
  releaseResponse?.();

  const response = await createResponse;
  expect(response.ok(), response.ok() ? "conversation created" : await response.text())
    .toBeTruthy();
  const created = await response.json() as { id: string };
  const recovery = page.getByRole("alert").filter({
    hasText: /Your new chat (?:was created|is safe)/,
  });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Open created chat" })).toBeFocused();
  await expect(page.locator(`[data-conversation-actions="${created.id}"]`)).toHaveCount(1);
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", cleanActiveId);
  expect(createRequests).toBe(1);

  const recoverySidebar = await openSidebar(page);
  await recoverySidebar.locator("button.new-chat").evaluate((element) => {
    const button = element as HTMLButtonElement;
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
    button.click();
  });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Open created chat" })).toBeFocused();
  expect(createRequests).toBe(1);

  await activeChatSession(page).getByRole("textbox", { name: "Message" }).fill("");
  await recovery.getByRole("button", { name: "Open created chat" }).click();
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", created.id);
  await expect(activeChatSession(page).getByRole("textbox", { name: "Message" })).toBeFocused();
  await expect(recovery).toBeHidden();
  expect(createRequests).toBe(1);
});

test("failed new-chat creation preserves context and retries the same idempotent operation", async ({ page }) => {
  const originalId = await activeConversationId(page);
  const keys: string[] = [];
  let attempts = 0;
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts += 1;
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        json: { error: { message: "Temporary conversation service failure" } },
      });
      return;
    }
    await route.fulfill({ response: await route.fetch() });
  });

  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: "New chat ⌘ K", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "current chat is unchanged" });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "Try again" })).toBeFocused();
  expect(await activeConversationId(page)).toBe(originalId);

  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(alert).toBeHidden();
  expect(attempts).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  await expect(page.locator(".conversation-row.active [data-conversation-actions]"))
    .not.toHaveAttribute("data-conversation-actions", originalId);
  expect(await activeConversationId(page)).not.toBe(originalId);
  await expect(activeChatSession(page).getByRole("textbox", { name: "Message" })).toBeFocused();
});

test("two conversations stream concurrently while the first drains its prompt queue", async ({ page }) => {
  test.setTimeout(70_000);
  await selectSlowStream(page);
  const firstId = await activeConversationId(page);
  const firstPrompt = Array.from({ length: 28 }, (_, index) => `background-one-${index}`).join(" ");
  const queuedPrompt = "queued prompt survives and runs after the hidden stream";
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(firstPrompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await composer.fill(queuedPrompt);
  await page.getByRole("button", { name: "Queue message" }).click();
  await expect(page.getByText("1 queued", { exact: true })).toBeVisible();

  await createChat(page);
  const secondId = await activeConversationId(page);
  const secondPrompt = Array.from({ length: 24 }, (_, index) => `background-two-${index}`).join(
    " ",
  );
  await page.getByRole("textbox", { name: "Message" }).fill(secondPrompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

  const sidebar = await openSidebar(page);
  await expect(sidebar.locator(`[data-conversation-actions="${firstId}"]`)).toBeDisabled();
  await expect(sidebar.locator(`[data-conversation-actions="${secondId}"]`)).toBeDisabled();
  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  await expect.poll(async () => {
    const response = await page.request.get(`${apiURL}/api/conversations/${firstId}`);
    if (!response.ok()) return [];
    const graph = await response.json() as {
      messages: Array<{ role: string; content: string; status?: string }>;
    };
    return graph.messages.filter((message) => message.role === "assistant")
      .map((message) => message.status);
  }, { timeout: 45_000 }).toEqual(["complete", "complete"]);

  await expect.poll(async () => {
    const response = await page.request.get(`${apiURL}/api/conversations/${secondId}`);
    if (!response.ok()) return "";
    const graph = await response.json() as {
      messages: Array<{ role: string; content: string; status?: string }>;
    };
    return graph.messages.find((message) => message.role === "assistant")?.status ?? "";
  }, { timeout: 45_000 }).toBe("complete");

  await (await openSidebar(page)).getByRole("button", { name: "Chats", exact: true }).click();
  await openConversation(page, firstId);
  await expect(page.getByText(`This is a simulated response to: ${firstPrompt}`, { exact: true }))
    .toBeVisible();
  await expect(page.getByText(`This is a simulated response to: ${queuedPrompt}`, { exact: true }))
    .toBeVisible();
  await expect(page.getByText("1 queued", { exact: true })).toBeHidden();
});
