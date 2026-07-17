import { expect, type Page, test } from "@playwright/test";
import { activeChatSession, bootstrap, login, openSidebar, uniqueUser } from "./helpers.ts";
import { lightweightManagedStack } from "./env.ts";

async function authenticatedRequest(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
) {
  return await page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, { path, method: options.method ?? "GET", body: options.body });
}

async function currentConversationVersion(page: Page, conversationId: string): Promise<number> {
  const response = await authenticatedRequest(page, `/api/conversations/${conversationId}`);
  expect(response.status).toBe(200);
  return (response.body as { version: number }).version;
}

async function conversationHasCompletedReply(
  page: Page,
  conversationId: string,
  userContent: string,
): Promise<boolean> {
  const response = await authenticatedRequest(page, `/api/conversations/${conversationId}`);
  if (response.status !== 200) return false;
  const detail = response.body as {
    activeLeafId: string | null;
    messages: Array<{
      id: string;
      parentId: string | null;
      role: string;
      content: string;
      status: string;
      metadata?: Record<string, unknown>;
    }>;
  };
  const user = detail.messages.find((message) =>
    message.role === "user" &&
    (message.content === userContent || message.metadata?.authoredContent === userContent)
  );
  if (!user) return false;
  const assistant = detail.messages.find((message) =>
    message.role === "assistant" && message.parentId === user.id && message.status === "complete"
  );
  return assistant?.id === detail.activeLeafId;
}

test("tool discovery reports outages honestly and execution polling never overlaps", async ({ page, request }) => {
  test.setTimeout(60_000);
  await bootstrap(request);
  await login(page);
  let catalogAvailable = false;
  await page.route("**/api/tools", async (route) => {
    if (route.request().method() !== "GET") return await route.continue();
    if (!catalogAvailable) {
      return await route.fulfill({
        status: 503,
        contentType: "application/json",
        json: { error: { code: "catalog_unavailable", message: "Synthetic tool catalog outage" } },
      });
    }
    return await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        data: [{
          id: "web_search",
          name: "Web search",
          description: "Search safely",
          enabled: true,
          inputSchema: {},
        }],
      },
    });
  });
  const now = new Date().toISOString();
  const execution = (status: "pending_approval" | "running" | "succeeded") => ({
    id: "00000000-0000-4000-8000-000000000777",
    ownerId: "00000000-0000-4000-8000-000000000778",
    toolId: "web_search",
    input: { query: "poll safety" },
    status,
    result: status === "succeeded" ? { results: [] } : null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  let createCount = 0;
  const createStarted = Promise.withResolvers<void>();
  const releaseFirstCreate = Promise.withResolvers<void>();
  await page.route("**/api/tools/executions", async (route) => {
    if (route.request().method() !== "POST") return await route.continue();
    createCount += 1;
    if (createCount === 1) {
      createStarted.resolve();
      await releaseFirstCreate.promise;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      json: execution("pending_approval"),
    });
  });
  let activePolls = 0;
  let maximumActivePolls = 0;
  let pollCount = 0;
  let approveCount = 0;
  await page.route("**/api/tools/executions/**", async (route) => {
    const method = route.request().method();
    if (method === "POST" && route.request().url().endsWith("/approve")) {
      approveCount += 1;
      return await route.fulfill({
        // Model a lost acknowledgement: the server advanced the execution, but the client saw
        // an error. Polling must resume and reconcile instead of leaving stale approval UI.
        status: 503,
        contentType: "application/json",
        json: { error: { code: "ack_lost", message: "Synthetic lost acknowledgement" } },
      });
    }
    if (method !== "GET") return await route.continue();
    activePolls += 1;
    maximumActivePolls = Math.max(maximumActivePolls, activePolls);
    pollCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 900));
    activePolls -= 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: execution(pollCount >= 2 ? "succeeded" : "running"),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open web search" }).click();
  const dialog = page.getByRole("dialog", { name: "Web search" });
  await expect(dialog.getByRole("alert")).toContainText("Synthetic tool catalog outage", {
    timeout: 15_000,
  });
  await expect(dialog.getByText("not enabled by an administrator")).toHaveCount(0);
  catalogAvailable = true;
  await dialog.getByRole("button", { name: "Try loading tools again" }).click();
  await dialog.getByLabel("Search query").fill("dismissed request");
  await dialog.getByRole("button", { name: "Review search" }).click();
  await createStarted.promise;
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  releaseFirstCreate.resolve();
  await page.getByRole("button", { name: "Open web search" }).click();
  await expect(dialog.getByLabel("Search query")).toHaveValue("");
  await expect(dialog.getByText(/Status:/u)).toHaveCount(0);
  await dialog.getByLabel("Search query").fill("poll safety");
  await dialog.getByRole("button", { name: "Review search" }).click();
  await dialog.getByRole("button", { name: "Approve this search" }).click();
  await expect(dialog.getByText("Status: succeeded")).toBeVisible({ timeout: 15_000 });
  expect(approveCount).toBe(1);
  expect(maximumActivePolls).toBe(1);
  expect(pollCount).toBe(2);
});

test("admin enables web search and a user explicitly reviews and cancels a tool call", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  test.skip(lightweightManagedStack, "requires the durable tool and search adapter stack");
  await bootstrap(request);
  await login(page);
  const mobile = testInfo.project.name.includes("mobile");
  await openSidebar(page);
  await page.getByRole("button", { name: "Admin console", exact: true }).click();
  if (mobile) {
    await page.getByRole("combobox", { name: "Admin section" }).selectOption("tools");
  } else {
    await page.getByRole("link", { name: "Tools & search", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Tools & web search" })).toBeVisible();
  const card = page.locator("article", { hasText: "Web search" });
  const enabled = card.getByRole("checkbox", { name: "Enable" });
  if (!(await enabled.isChecked())) await enabled.check();
  await card.getByLabel("Domain allowlist").fill("search-proxy");
  const privateNetwork = card.getByRole("checkbox", { name: /private network targets/i });
  if (!(await privateNetwork.isChecked())) await privateNetwork.check();
  await card.getByRole("button", { name: "Save policy" }).click();
  const policyVersion = card.getByText(/Policy version \d+/);
  const concurrentUpdate = card.getByText("Tool policy changed in another session");
  if (await concurrentUpdate.count() > 0 && await concurrentUpdate.first().isVisible()) {
    // Desktop and mobile projects intentionally run together. The policy uses optimistic CAS, so
    // the loser must refresh and observe the winner's equivalent configuration.
    await page.getByRole("button", { name: "Refresh" }).click();
  }
  await expect(policyVersion.first()).toBeVisible();

  await openSidebar(page);
  await page.getByRole("button", { name: "New chat ⌘ K", exact: true }).click();
  await page.getByRole("button", { name: "Open web search" }).click();
  await expect(page.getByRole("dialog", { name: "Web search" })).toBeVisible();
  await page.getByLabel("Search query").fill("immutable conversation graphs");
  await page.getByRole("button", { name: "Review search" }).click();
  await expect(page.getByText("Status: pending approval")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Search cancelled.")).toBeVisible();
  await page.getByRole("dialog", { name: "Web search" }).getByRole("button", {
    name: "Close",
    exact: true,
  }).click();

  await page.getByRole("button", { name: "Open web search" }).click();
  await page.getByLabel("Search query").fill("OpenAI compatible API");
  await page.getByRole("button", { name: "Review search" }).click();
  await page.getByRole("button", { name: "Approve this search" }).click();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const status = page.locator(".tool-execution-status");
    await expect(status).toContainText(/Status:\s*(?:succeeded|failed)/u, { timeout: 30_000 });
    if (await status.getByText("Status: succeeded").isVisible()) break;
    await page.getByRole("button", { name: "Try search again" }).click();
    await page.getByRole("button", { name: "Review search" }).click();
    await page.getByRole("button", { name: "Approve this search" }).click();
  }
  await expect(page.getByText("Status: succeeded")).toBeVisible();
  await page.getByRole("button", { name: "Add to next message" }).click();
  await expect(page.getByText("Approved web search", { exact: true })).toBeVisible();
  const prompt = `Summarize the attached verified search result ${crypto.randomUUID()}.`;
  const editedPrompt =
    `Edited summary that retains verified search provenance ${crypto.randomUUID()}.`;
  const session = activeChatSession(page);
  await session.getByRole("textbox", { name: "Message", exact: true }).fill(prompt);
  await session.getByRole("button", { name: "Send", exact: true }).click();
  await expect(session.getByText(prompt, { exact: true }).last()).toBeVisible();
  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  if (!conversationId) throw new Error("Active conversation ID was not available");
  await expect.poll(
    () => activeChatSession(page).locator(".assistant-message .markdown").last().textContent(),
    { timeout: 20_000, message: "the generation to commit before reloading" },
  ).not.toBe("");
  await expect.poll(
    () => conversationHasCompletedReply(page, conversationId, prompt),
    { timeout: 20_000, message: "the initial generation to settle before reloading" },
  ).toBe(true);
  await page.reload();
  await expect(activeChatSession(page).getByText(prompt, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const concurrentEditRename = await authenticatedRequest(
    page,
    `/api/conversations/${conversationId}`,
    {
      method: "PATCH",
      body: {
        title: "Concurrent edit retry test",
        expectedVersion: await currentConversationVersion(page, conversationId),
      },
    },
  );
  expect(concurrentEditRename.status).toBe(200);
  const original = activeChatSession(page).getByText(prompt, { exact: true });
  await original.hover();
  await original.locator("xpath=ancestor::*[self::article or @data-message-id][1]")
    .getByRole("button", { name: /edit/i }).click();
  await activeChatSession(page).getByRole("textbox", {
    name: "Edit message in a new branch",
  }).fill(editedPrompt);
  await activeChatSession(page).getByRole("button", {
    name: "Send edited message as a new branch",
  }).click();
  await expect(
    activeChatSession(page).getByText(editedPrompt, { exact: true }).last(),
  ).toBeVisible();
  await expect.poll(
    () => conversationHasCompletedReply(page, conversationId, editedPrompt),
    { timeout: 20_000, message: "the edited branch generation to settle" },
  ).toBe(true);
  await page.reload();
  await expect(activeChatSession(page).getByText(editedPrompt, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const concurrentRename = await authenticatedRequest(
    page,
    `/api/conversations/${conversationId}`,
    {
      method: "PATCH",
      body: {
        title: "Concurrent branch navigation test",
        expectedVersion: await currentConversationVersion(page, conversationId),
      },
    },
  );
  expect(concurrentRename.status).toBe(200);
  const edited = activeChatSession(page).getByText(editedPrompt, { exact: true }).last();
  await edited.locator("xpath=ancestor::*[self::article or @data-message-id][1]")
    .getByRole("button", { name: /^Previous branch for / }).click();
  await expect(original).toBeVisible();
  await expect(page.getByText("That branch changed in another tab.")).toHaveCount(0);
  await original.locator("xpath=ancestor::*[self::article or @data-message-id][1]")
    .getByRole("button", { name: /^Next branch for / }).click();
  await expect(activeChatSession(page).getByText(editedPrompt, { exact: true })).toBeVisible();
});

test("a second approved user cannot inspect another user's tool execution", async ({ page, request }) => {
  test.skip(lightweightManagedStack, "requires the durable tool and search adapter stack");
  await bootstrap(request);
  await login(page);
  const policies = await authenticatedRequest(page, "/api/admin/tools");
  expect(policies.status).toBe(200);
  const webSearch = (policies.body as {
    data: Array<{
      definition: { id: string };
      policy?: {
        version: number;
      };
    }>;
  }).data.find((item) => item.definition.id === "web_search");
  if (!webSearch) throw new Error("Web search policy was not returned");
  const policy = await authenticatedRequest(page, "/api/admin/tools/web_search/policy", {
    method: "PUT",
    body: {
      allowed: true,
      allowedDomains: ["search-proxy"],
      allowPrivateNetwork: true,
      expectedVersion: webSearch.policy?.version ?? 0,
    },
  });
  expect(policy.status).toBe(200);
  const executionResponse = await authenticatedRequest(page, "/api/tools/executions", {
    method: "POST",
    body: { toolId: "web_search", input: { query: "private owner result" } },
  });
  expect(executionResponse.status).toBe(201);
  const execution = executionResponse.body as { id: string };

  const applicant = uniqueUser("tool-owner-denial");
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: "Request access" }).click();
  await page.getByLabel(/name/i).fill(applicant.name);
  await page.getByLabel(/email/i).fill(applicant.email);
  await page.getByLabel(/^password/i).fill(applicant.password);
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page).toHaveURL(/\/pending$/);
  await page.context().clearCookies();
  await login(page);
  const usersResponse = await authenticatedRequest(
    page,
    `/api/admin/users?search=${encodeURIComponent(applicant.email)}&limit=1`,
  );
  expect(usersResponse.status).toBe(200);
  const users = (usersResponse.body as {
    data: Array<{
      id: string;
      email: string;
      version: number;
    }>;
  }).data;
  const user = users.find((candidate) => candidate.email === applicant.email)!;
  const approval = await authenticatedRequest(page, `/api/admin/users/${user.id}/approval`, {
    method: "PATCH",
    body: { status: "approved", expectedVersion: user.version },
  });
  expect(approval.status).toBe(200);
  await page.context().clearCookies();
  await login(page, applicant.email, applicant.password);
  const denied = await authenticatedRequest(page, `/api/tools/executions/${execution.id}`);
  expect(denied.status).toBe(404);
  expect(denied.body).toMatchObject({ error: { code: "execution_not_found" } });
});
