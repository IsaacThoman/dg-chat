import { expect, type Page, test } from "@playwright/test";
import { bootstrap, login, uniqueUser } from "./helpers.ts";

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

test("admin enables web search and a user explicitly reviews and cancels a tool call", async ({
  page,
  request,
}, testInfo) => {
  await bootstrap(request);
  await login(page);
  const mobile = testInfo.project.name.includes("mobile");
  if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
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

  if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
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
  await expect(page.getByText("Status: succeeded")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Add to next message" }).click();
  await expect(page.getByText("Approved web search", { exact: true })).toBeVisible();
  await page.getByLabel("Message").fill("Summarize the attached verified search result.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Summarize the attached verified search result.", { exact: true }))
    .toBeVisible();
  await expect.poll(
    () => page.locator(".assistant-message .markdown").last().textContent(),
    { timeout: 20_000, message: "the generation to commit before reloading" },
  ).not.toBe("");
  await page.reload();
  await expect(page.getByText("Summarize the attached verified search result.", { exact: true }))
    .toBeVisible();
  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  if (!conversationId) throw new Error("Active conversation ID was not available");
  const concurrentEditRename = await authenticatedRequest(
    page,
    `/api/conversations/${conversationId}`,
    {
      method: "PATCH",
      body: { title: "Concurrent edit retry test" },
    },
  );
  expect(concurrentEditRename.status).toBe(200);
  const original = page.getByText("Summarize the attached verified search result.", {
    exact: true,
  });
  await original.hover();
  await original.locator("xpath=ancestor::*[self::article or @data-message-id][1]")
    .getByRole("button", { name: /edit/i }).click();
  await page.getByRole("textbox", { name: /message/i }).fill(
    "Edited summary that retains verified search provenance.",
  );
  await page.getByRole("button", { name: /send|save/i }).click();
  await expect(page.getByText("Edited summary that retains verified search provenance.", {
    exact: true,
  })).toBeVisible();
  await expect.poll(
    async () => {
      const detail = await authenticatedRequest(page, `/api/conversations/${conversationId}`);
      return detail.status === 200 && JSON.stringify(detail.body).includes(
        "Edited summary that retains verified search provenance.",
      );
    },
    { timeout: 20_000, message: "the edited branch generation to commit" },
  ).toBe(true);
  await page.reload();
  await expect(page.getByText("Edited summary that retains verified search provenance.", {
    exact: true,
  })).toBeVisible();
  const concurrentRename = await authenticatedRequest(
    page,
    `/api/conversations/${conversationId}`,
    {
      method: "PATCH",
      body: { title: "Concurrent branch navigation test" },
    },
  );
  expect(concurrentRename.status).toBe(200);
  await page.getByRole("button", { name: "Previous branch" }).click();
  await expect(original).toBeVisible();
  await expect(page.getByText("That branch changed in another tab.")).toHaveCount(0);
  await page.getByRole("button", { name: "Next branch" }).click();
  await expect(page.getByText("Edited summary that retains verified search provenance.", {
    exact: true,
  })).toBeVisible();
});

test("a second approved user cannot inspect another user's tool execution", async ({ page, request }) => {
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
  const usersResponse = await authenticatedRequest(page, "/api/admin/users");
  expect(usersResponse.status).toBe(200);
  const users = (usersResponse.body as {
    data: Array<{
      id: string;
      email: string;
    }>;
  }).data;
  const user = users.find((candidate) => candidate.email === applicant.email)!;
  const approval = await authenticatedRequest(page, `/api/admin/users/${user.id}/approval`, {
    method: "PATCH",
    body: { status: "approved" },
  });
  expect(approval.status).toBe(200);
  await page.context().clearCookies();
  await login(page, applicant.email, applicant.password);
  const denied = await authenticatedRequest(page, `/api/tools/executions/${execution.id}`);
  expect(denied.status).toBe(404);
  expect(denied.body).toMatchObject({ error: { code: "execution_not_found" } });
});
