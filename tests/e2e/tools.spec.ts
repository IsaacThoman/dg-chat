import { expect, test } from "@playwright/test";
import { bootstrap, login } from "./helpers.ts";

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
  await expect(policyVersion.or(concurrentUpdate)).toBeVisible();
  if (await concurrentUpdate.isVisible()) {
    // Desktop and mobile projects intentionally run together. The policy uses optimistic CAS, so
    // the loser must refresh and observe the winner's equivalent configuration.
    await page.getByRole("button", { name: "Refresh" }).click();
  }
  await expect(policyVersion).toBeVisible();

  if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "New chat ⌘ K", exact: true }).click();
  await page.getByRole("button", { name: "Open web search" }).click();
  await expect(page.getByRole("dialog", { name: "Web search" })).toBeVisible();
  await page.getByLabel("Search query").fill("immutable conversation graphs");
  await page.getByRole("button", { name: "Review search" }).click();
  await expect(page.getByText("Status: pending approval")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Search cancelled.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

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
});
