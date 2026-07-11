import { expect, test } from "@playwright/test";
import { apiURL, bootstrap, login, uniqueUser } from "./helpers.ts";

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
    await page.getByRole("button", { name: "Tools & search", exact: true }).click();
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
  await page.reload();
  await expect(page.getByText("Summarize the attached verified search result.", { exact: true }))
    .toBeVisible();
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
  await page.getByRole("button", { name: "Previous branch" }).click();
  await expect(original).toBeVisible();
  await page.getByRole("button", { name: "Next branch" }).click();
  await expect(page.getByText("Edited summary that retains verified search provenance.", {
    exact: true,
  })).toBeVisible();
});

test("a second approved user cannot inspect another user's tool execution", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  const adminHeaders = { origin: new URL(page.url()).origin };
  const policies = await page.request.get(`${apiURL}/api/admin/tools`);
  const webSearch = (await policies.json()).data.find((item: { definition: { id: string } }) =>
    item.definition.id === "web_search"
  );
  await page.request.put(`${apiURL}/api/admin/tools/web_search/policy`, {
    headers: adminHeaders,
    data: {
      allowed: true,
      allowedDomains: ["search-proxy"],
      allowPrivateNetwork: true,
      expectedVersion: webSearch.policy?.version ?? 0,
    },
  });
  const executionResponse = await page.request.post(`${apiURL}/api/tools/executions`, {
    headers: adminHeaders,
    data: { toolId: "web_search", input: { query: "private owner result" } },
  });
  expect(executionResponse.status()).toBe(201);
  const execution = await executionResponse.json() as { id: string };

  const applicant = uniqueUser("tool-owner-denial");
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: "Request access" }).click();
  await page.getByLabel(/name/i).fill(applicant.name);
  await page.getByLabel(/email/i).fill(applicant.email);
  await page.getByLabel(/^password/i).fill(applicant.password);
  await page.getByRole("button", { name: "Request access" }).click();
  await page.context().clearCookies();
  await login(page);
  const users = (await (await page.request.get(`${apiURL}/api/admin/users`)).json()).data as Array<{
    id: string;
    email: string;
  }>;
  const user = users.find((candidate) => candidate.email === applicant.email)!;
  await page.request.patch(`${apiURL}/api/admin/users/${user.id}/approval`, {
    headers: adminHeaders,
    data: { status: "approved" },
  });
  await page.context().clearCookies();
  await login(page, applicant.email, applicant.password);
  const denied = await page.request.get(`${apiURL}/api/tools/executions/${execution.id}`);
  expect(denied.status()).toBe(404);
  await expect(denied.json()).resolves.toMatchObject({ error: { code: "execution_not_found" } });
});
