import { expect, type Page, test } from "@playwright/test";
import { bootstrap, login, openSidebar } from "./helpers.ts";

// Password verification intentionally uses production-strength hashing and can consume most of
// the repository default on constrained self-hosted runners before the journey itself begins.
test.describe.configure({ timeout: 90_000 });

interface SeedConversation {
  id: string;
  title: string;
  version: number;
}

interface SeedMessage {
  id: string;
}

interface SeedFolder {
  id: string;
  name: string;
  membershipVersion: number;
}

interface SeedTag {
  id: string;
  name: string;
}

function nonce(label: string): string {
  return `${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function mutationHeaders(page: Page, idempotencyKey?: string): Record<string, string> {
  return {
    Origin: new URL(page.url()).origin,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

async function createConversation(page: Page, title: string): Promise<SeedConversation> {
  const response = await page.request.post("/api/conversations", {
    headers: mutationHeaders(page, nonce("conversation")),
    data: { title, temporary: false },
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as SeedConversation;
}

async function appendMessage(
  page: Page,
  conversation: SeedConversation,
  input: {
    content: string;
    parentId?: string | null;
    supersedesId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<SeedMessage> {
  const response = await page.request.post(`/api/conversations/${conversation.id}/messages`, {
    headers: mutationHeaders(page),
    data: {
      role: "user",
      content: input.content,
      parentId: input.parentId ?? null,
      ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      expectedVersion: conversation.version,
      idempotencyKey: nonce("message"),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  conversation.version += 1;
  return await response.json() as SeedMessage;
}

async function updateConversation(
  page: Page,
  conversation: SeedConversation,
  patch: { archived?: boolean; deleted?: boolean },
): Promise<void> {
  const response = await page.request.patch(`/api/conversations/${conversation.id}`, {
    headers: mutationHeaders(page),
    data: { expectedVersion: conversation.version, ...patch },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const updated = await response.json() as SeedConversation;
  conversation.version = updated.version;
}

async function createFolder(page: Page, name: string): Promise<SeedFolder> {
  const response = await page.request.post("/api/folders", {
    headers: mutationHeaders(page, nonce("folder")),
    data: { name },
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as SeedFolder;
}

async function createTag(page: Page, name: string): Promise<SeedTag> {
  const response = await page.request.post("/api/tags", {
    headers: mutationHeaders(page, nonce("tag")),
    data: { name, color: "#7c3aed" },
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as SeedTag;
}

async function searchSidebar(page: Page, query: string) {
  const sidebar = await openSidebar(page);
  const responsePromise = page.waitForResponse((response) => {
    if (!response.url().endsWith("/api/conversations/search")) return false;
    if (response.request().method() !== "POST") return false;
    try {
      return (response.request().postDataJSON() as { query?: string }).query === query;
    } catch {
      return false;
    }
  });
  await sidebar.getByPlaceholder("Search conversations").fill(query);
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBeTruthy();
  return { sidebar, response };
}

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
});

test("guides one-character searches without presenting a server failure", async ({ page }) => {
  const sidebar = await openSidebar(page);
  const input = sidebar.getByPlaceholder("Search conversations");
  await input.fill("n");
  await expect(sidebar.getByText("Enter at least 2 characters to search", { exact: true }))
    .toBeVisible();
  await expect(input).toHaveAttribute("aria-describedby", /-minimum$/u);
  await expect(sidebar.getByRole("alert").filter({ hasText: "Search is unavailable" }))
    .toHaveCount(0);
  await expect(sidebar.locator(".conversation-row")).toHaveCount(0);

  await input.fill("");
  await expect(sidebar.getByText("Enter at least 2 characters to search", { exact: true }))
    .toHaveCount(0);
  await expect(input).not.toHaveAttribute("aria-describedby", /-minimum$/u);
});

test("bounds long conversation histories and expands them incrementally", async ({ page }) => {
  await createConversation(page, nonce("window-anchor"));
  await page.route("**/api/conversations", async (route) => {
    if (
      route.request().method() !== "GET" ||
      new URL(route.request().url()).pathname !== "/api/conversations"
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json() as { data: unknown[] };
    const synthetic = Array.from({ length: 250 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      title: `Long history ${index + 1}`,
      activeLeafId: null,
      version: 1,
      pinned: false,
      archivedAt: null,
      deletedAt: null,
      updatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
    }));
    await route.fulfill({ response, json: { ...payload, data: [...payload.data, ...synthetic] } });
  });
  await page.reload();

  const sidebar = await openSidebar(page);
  await expect(sidebar.locator(".conversation-row")).toHaveCount(75);
  await expect(sidebar.getByText(/Showing 75 of \d+ chats/u)).toBeVisible();
  await sidebar.getByRole("button", { name: "Show 75 more chats", exact: true }).click();
  await expect(sidebar.locator(".conversation-row")).toHaveCount(150);
});

test("finds titles and only visible messages on the immutable active path", async ({ page }) => {
  const titleNeedle = nonce("title-needle");
  const inactiveNeedle = nonce("inactive-needle");
  const activeNeedle = nonce("active-needle");
  const conversation = await createConversation(page, `Roadmap ${titleNeedle}`);
  const inactive = await appendMessage(page, conversation, { content: inactiveNeedle });
  await appendMessage(page, conversation, {
    content: `Visible current branch ${activeNeedle}`,
    supersedesId: inactive.id,
  });
  await page.reload();

  const titleSearch = await searchSidebar(page, titleNeedle);
  await expect(
    titleSearch.sidebar.locator(`[data-conversation-actions="${conversation.id}"]`),
  ).toBeVisible();

  const inactiveSearch = await searchSidebar(page, inactiveNeedle);
  await expect(inactiveSearch.sidebar.getByText("No conversations match", { exact: true }))
    .toBeVisible();
  await expect(
    inactiveSearch.sidebar.locator(`[data-conversation-actions="${conversation.id}"]`),
  ).toHaveCount(0);

  const activeSearch = await searchSidebar(page, activeNeedle);
  const activeRow = activeSearch.sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${conversation.id}"])`,
  );
  await expect(activeRow).toBeVisible();
  await expect(activeRow.locator("small")).toContainText(activeNeedle);
});

test("opens a server-only result created after the lifecycle list was loaded", async ({ page }) => {
  const title = nonce("concurrent-tab-search");
  const lifecycleLoaded = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === "/api/conversations"
  );
  await page.reload();
  await lifecycleLoaded;
  const concurrent = await createConversation(page, title);

  const { sidebar } = await searchSidebar(page, title);
  const row = sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${concurrent.id}"])`,
  );
  await expect(row).toBeVisible();
  await row.locator("button.conversation-open").click();

  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(
    sidebar.locator(`.conversation-row.active [data-conversation-actions="${concurrent.id}"]`),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
});

test("loads additional result pages and announces that the first count is partial", async ({ page }) => {
  const needle = nonce("paged-search");
  const seeded = await Promise.all(
    Array.from({ length: 27 }, (_, index) => createConversation(page, `${needle} ${index + 1}`)),
  );
  const expectedIds = seeded.map((conversation) => conversation.id).sort();

  const { sidebar } = await searchSidebar(page, needle);
  await expect(sidebar.locator(".conversation-row")).toHaveCount(25);
  const firstPageIds = await sidebar.locator(
    ".conversation-row [data-conversation-actions]",
  ).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-conversation-actions"))
  );
  expect(new Set(firstPageIds).size).toBe(25);
  expect(firstPageIds.every((id) => id !== null && expectedIds.includes(id))).toBe(true);
  await expect(sidebar.getByText("25 conversations loaded; more results available", {
    exact: true,
  })).toBeAttached();

  const nextPage = page.waitForResponse((response) => {
    if (!response.url().endsWith("/api/conversations/search")) return false;
    try {
      const body = response.request().postDataJSON() as { query?: string; cursor?: string };
      return body.query === needle && typeof body.cursor === "string" && body.cursor.length > 0;
    } catch {
      return false;
    }
  });
  await sidebar.getByRole("button", { name: "Load more results", exact: true }).click();
  expect((await nextPage).ok()).toBeTruthy();

  await expect(sidebar.locator(".conversation-row")).toHaveCount(27);
  const loadedIds = await sidebar.locator(
    ".conversation-row [data-conversation-actions]",
  ).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-conversation-actions"))
  );
  expect(new Set(loadedIds).size).toBe(27);
  expect(loadedIds.filter((id): id is string => id !== null).sort()).toEqual(expectedIds);
  await expect(sidebar.getByRole("button", { name: "Load more results", exact: true }))
    .toHaveCount(0);
  await expect(sidebar.getByText("27 conversations loaded", { exact: true })).toBeAttached();
});

test("renders an accessible initial failure and retries the same search", async ({ page }) => {
  const needle = nonce("initial-retry-search");
  const conversation = await createConversation(page, `Retryable ${needle}`);
  let failed = false;
  await page.route("**/api/conversations/search", async (route) => {
    const body = route.request().postDataJSON() as { query?: string };
    if (body.query !== needle || failed) {
      await route.continue();
      return;
    }
    failed = true;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      json: {
        error: {
          message: "Search is temporarily unavailable",
          type: "server_error",
          code: "search_unavailable",
        },
      },
    });
  });

  const sidebar = await openSidebar(page);
  const failedResponse = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/conversations/search") return false;
    try {
      return (response.request().postDataJSON() as { query?: string }).query === needle;
    } catch {
      return false;
    }
  });
  await sidebar.getByPlaceholder("Search conversations").fill(needle);
  expect((await failedResponse).status()).toBe(503);

  const alert = sidebar.getByRole("alert").filter({ hasText: "Search is unavailable" });
  await expect(alert).toBeVisible();
  const retry = alert.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  await expect(sidebar.getByText("Conversation search failed", { exact: true })).toBeAttached();
  await expect(sidebar.locator(".conversation-row")).toHaveCount(0);

  const retriedResponse = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/conversations/search") return false;
    try {
      return (response.request().postDataJSON() as { query?: string }).query === needle &&
        response.status() === 200;
    } catch {
      return false;
    }
  });
  await retry.click();
  expect((await retriedResponse).ok()).toBeTruthy();
  await expect(alert).toHaveCount(0);
  await expect(sidebar.locator(".conversation-row [data-conversation-actions]"))
    .toHaveAttribute("data-conversation-actions", conversation.id);
  await expect(sidebar.getByText("1 conversation loaded", { exact: true })).toBeAttached();
});

test("preserves page one when load more fails and completes after retry", async ({ page }) => {
  const needle = nonce("page-retry-search");
  const seeded = await Promise.all(
    Array.from({ length: 27 }, (_, index) => createConversation(page, `${needle} ${index + 1}`)),
  );
  const expectedIds = seeded.map((conversation) => conversation.id).sort();
  let failedCursorRequest = false;
  await page.route("**/api/conversations/search", async (route) => {
    const body = route.request().postDataJSON() as { query?: string; cursor?: string };
    if (body.query !== needle || !body.cursor || failedCursorRequest) {
      await route.continue();
      return;
    }
    failedCursorRequest = true;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      json: {
        error: {
          message: "The next search page is temporarily unavailable",
          type: "server_error",
          code: "search_unavailable",
        },
      },
    });
  });

  const { sidebar } = await searchSidebar(page, needle);
  await expect(sidebar.locator(".conversation-row")).toHaveCount(25);
  const firstPageIds = await sidebar.locator(
    ".conversation-row [data-conversation-actions]",
  ).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-conversation-actions"))
  );
  expect(new Set(firstPageIds).size).toBe(25);
  expect(firstPageIds.every((id) => id !== null && expectedIds.includes(id))).toBe(true);

  const failedPage = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/conversations/search") return false;
    try {
      const body = response.request().postDataJSON() as { query?: string; cursor?: string };
      return body.query === needle && Boolean(body.cursor) && response.status() === 503;
    } catch {
      return false;
    }
  });
  await sidebar.getByRole("button", { name: "Load more results", exact: true }).click();
  await failedPage;

  const pageAlert = sidebar.getByRole("alert").filter({
    hasText: "More results couldn’t be loaded.",
  });
  await expect(pageAlert).toBeVisible();
  const retry = pageAlert.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  await expect(sidebar.locator(".conversation-row")).toHaveCount(25);
  const preservedIds = await sidebar.locator(
    ".conversation-row [data-conversation-actions]",
  ).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-conversation-actions"))
  );
  expect(preservedIds).toEqual(firstPageIds);
  await expect(sidebar.getByText("25 conversations loaded; more results available", {
    exact: true,
  })).toBeAttached();

  const retriedPage = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/conversations/search") return false;
    try {
      const body = response.request().postDataJSON() as { query?: string; cursor?: string };
      return body.query === needle && Boolean(body.cursor) && response.status() === 200;
    } catch {
      return false;
    }
  });
  await retry.click();
  expect((await retriedPage).ok()).toBeTruthy();
  await expect(pageAlert).toHaveCount(0);
  await expect(sidebar.locator(".conversation-row")).toHaveCount(27);
  const completedIds = await sidebar.locator(
    ".conversation-row [data-conversation-actions]",
  ).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-conversation-actions"))
  );
  expect(new Set(completedIds).size).toBe(27);
  expect(completedIds.filter((id): id is string => id !== null).sort()).toEqual(expectedIds);
  await expect(sidebar.getByText("27 conversations loaded", { exact: true })).toBeAttached();
});

test("keeps hostile message snippets inert in the search results", async ({ page }) => {
  const needle = nonce("hostile-search");
  const conversation = await createConversation(page, "Inert result rendering");
  const hostile = `<img src=x onerror="window.__searchSnippetExecuted=true"> ${needle}`;
  await appendMessage(page, conversation, { content: hostile });
  await page.addInitScript(() => {
    (window as typeof window & { __searchSnippetExecuted?: boolean }).__searchSnippetExecuted =
      false;
  });
  await page.reload();

  const { sidebar } = await searchSidebar(page, needle);
  const row = sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${conversation.id}"])`,
  );
  await expect(row).toBeVisible();
  await expect(row.locator("small")).toContainText("<img src=x onerror=");
  await expect(row.locator("img, script, iframe, object, embed")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(() =>
      (window as typeof window & { __searchSnippetExecuted?: boolean }).__searchSnippetExecuted
    )
  ).toBe(false);
});

test("applies lifecycle, project, and tag scope before rendering results", async ({ page }) => {
  const lifecycleNeedle = nonce("lifecycle-search");
  const archived = await createConversation(page, `Archived ${lifecycleNeedle}`);
  const trashed = await createConversation(page, `Trashed ${lifecycleNeedle}`);
  await updateConversation(page, archived, { archived: true });
  await updateConversation(page, trashed, { deleted: true });

  const scopeNeedle = nonce("scope-search");
  const inside = await createConversation(page, `Inside ${scopeNeedle}`);
  const outside = await createConversation(page, `Outside ${scopeNeedle}`);
  const folder = await createFolder(page, nonce("Search project"));
  const tag = await createTag(page, nonce("Search tag"));
  const membership = await page.request.put(`/api/folders/${folder.id}/conversations`, {
    headers: mutationHeaders(page),
    data: {
      conversationIds: [inside.id],
      expectedMembershipVersions: { [folder.id]: folder.membershipVersion },
    },
  });
  expect(membership.ok(), await membership.text()).toBeTruthy();
  const tags = await page.request.put(`/api/conversations/${inside.id}/tags`, {
    headers: mutationHeaders(page),
    data: { tagIds: [tag.id], expectedVersion: 0 },
  });
  expect(tags.ok(), await tags.text()).toBeTruthy();
  await page.reload();

  const chatLifecycle = await searchSidebar(page, lifecycleNeedle);
  await expect(chatLifecycle.sidebar.getByText("No conversations match", { exact: true }))
    .toBeVisible();
  await chatLifecycle.sidebar.getByRole("button", { name: "Archived", exact: true }).click();
  await openSidebar(page);
  await expect(
    chatLifecycle.sidebar.locator(`[data-conversation-actions="${archived.id}"]`),
  ).toBeVisible();
  await expect(
    chatLifecycle.sidebar.locator(`[data-conversation-actions="${trashed.id}"]`),
  ).toHaveCount(0);
  await chatLifecycle.sidebar.getByRole("button", { name: "Trash", exact: true }).click();
  await openSidebar(page);
  await expect(
    chatLifecycle.sidebar.locator(`[data-conversation-actions="${trashed.id}"]`),
  ).toBeVisible();
  await expect(
    chatLifecycle.sidebar.locator(`[data-conversation-actions="${archived.id}"]`),
  ).toHaveCount(0);

  await chatLifecycle.sidebar.getByRole("button", { name: "Chats", exact: true }).click();
  await openSidebar(page);
  await chatLifecycle.sidebar.getByRole("button", { name: folder.name, exact: true }).click();
  await chatLifecycle.sidebar.getByRole("button", { name: tag.name, exact: true }).click();
  const scopedSearch = await searchSidebar(page, scopeNeedle);
  const requestBody = scopedSearch.response.request().postDataJSON() as {
    folderId?: string;
    tagIds?: string[];
  };
  expect(requestBody.folderId).toBe(folder.id);
  expect(requestBody.tagIds).toEqual([tag.id]);
  await expect(
    scopedSearch.sidebar.locator(`[data-conversation-actions="${inside.id}"]`),
  ).toBeVisible();
  await expect(
    scopedSearch.sidebar.locator(`[data-conversation-actions="${outside.id}"]`),
  ).toHaveCount(0);
});
