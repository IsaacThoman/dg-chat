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
  await card.getByLabel("Domain allowlist").fill("searxng");
  const privateNetwork = card.getByRole("checkbox", { name: /private network targets/i });
  if (!(await privateNetwork.isChecked())) await privateNetwork.check();
  await card.getByRole("button", { name: "Save policy" }).click();
  await expect(card.getByText(/Policy version \d+/)).toBeVisible();

  if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "New chat ⌘ K", exact: true }).click();
  await page.getByRole("button", { name: "Open web search" }).click();
  await expect(page.getByRole("dialog", { name: "Web search" })).toBeVisible();
  await page.getByLabel("Search query").fill("immutable conversation graphs");
  await page.getByRole("button", { name: "Review search" }).click();
  await expect(page.getByText("Status: pending approval")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Search cancelled.")).toBeVisible();
});
