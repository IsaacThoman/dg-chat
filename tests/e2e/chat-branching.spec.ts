import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

test("editing a prompt creates a recoverable branch", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill("Original branch prompt");
  await composer.press("Enter");
  await expect(page.getByText("Original branch prompt", { exact: true })).toBeVisible();
  await expect(page.getByText(/simulated response to: Original branch prompt/i)).toBeVisible();

  const prompt = page.getByText("Original branch prompt", { exact: true });
  await prompt.hover();
  await prompt.locator("xpath=ancestor::*[self::article or @data-message-id][1]").getByRole(
    "button",
    { name: /edit/i },
  ).click();
  const editor = page.getByRole("textbox", { name: /message/i });
  await editor.fill("Edited branch prompt");
  await page.getByRole("button", { name: /send|save/i }).click();

  await expect(page.getByText("Edited branch prompt", { exact: true })).toBeVisible();
  await expect(page.getByText("Original branch prompt", { exact: true })).toBeHidden();

  await page.getByRole("button", { name: "Previous branch" }).click();
  await expect(page.getByText("Original branch prompt", { exact: true })).toBeVisible();
  await expect(page.getByText("Edited branch prompt", { exact: true })).toBeHidden();

  await page.getByRole("button", { name: "Next branch" }).click();
  await expect(page.getByText("Edited branch prompt", { exact: true })).toBeVisible();
  await expect(page.getByText("Original branch prompt", { exact: true })).toBeHidden();
});

test("composer supports keyboard submission and does not submit Shift+Enter", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill("first line");
  await composer.press("Shift+Enter");
  await composer.type("second line");
  await expect(composer).toHaveValue(/first line\nsecond line/);
  await composer.press("Enter");
  await expect(page.locator("article.user-message").filter({ hasText: /first line\s*second line/ }))
    .toBeVisible();
});

test("editing preserves the original Markdown source exactly", async ({ page }) => {
  const markdown = "**Bold** and `code` with _emphasis_";
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill(markdown);
  await composer.press("Enter");

  const prompt = page.locator("article.user-message").filter({ hasText: "Bold and code" });
  await prompt.getByRole("button", { name: /edit/i }).click();
  await expect(composer).toHaveValue(markdown);
});
