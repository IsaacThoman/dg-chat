import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

async function openSidebar(page: import("@playwright/test").Page) {
  if ((page.viewportSize()?.width ?? 1280) > 800) return;
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  if (await menu.isVisible()) await menu.click();
}

async function createProject(page: import("@playwright/test").Page, name: string) {
  await openSidebar(page);
  const trigger = page.getByRole("button", { name: "Create project", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function createTag(page: import("@playwright/test").Page, name: string) {
  await openSidebar(page);
  const trigger = page.getByRole("button", { name: "Create tag", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create tag" });
  await dialog.getByLabel("Tag name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
});

test("projects and tags organize, filter, and preserve conversations when deleted", async ({ page }) => {
  const suffix = `${Date.now()}-${test.info().project.name}`;
  const projectName = `Research ${suffix}`;
  const tagName = `Review ${suffix}`;
  await createChat(page);
  const actions = page.locator(".conversation-row.active [data-conversation-actions]");
  const conversationId = await actions.getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();

  await createProject(page, projectName);
  await createTag(page, tagName);
  await page.getByRole("button", { name: "All chats", exact: true }).click();
  const currentActions = page.locator(`[data-conversation-actions="${conversationId}"]`);
  await currentActions.click();
  await page.getByRole("menuitem", { name: "Organize", exact: true }).click();
  const organize = page.getByRole("dialog", { name: "Organize conversation" });
  await organize.getByLabel("Project").selectOption({ label: projectName });
  await organize.getByRole("checkbox", { name: tagName, exact: true }).check();
  await organize.getByRole("button", { name: "Save", exact: true }).click();
  await expect(organize).toBeHidden();

  await openSidebar(page);
  await page.getByRole("button", { name: projectName, exact: true }).click();
  await expect(currentActions).toBeVisible();
  const tagFilter = page.getByRole("button", { name: tagName, exact: true });
  await tagFilter.click();
  await expect(tagFilter).toHaveAttribute("aria-pressed", "true");
  await expect(currentActions).toBeVisible();

  await page.getByRole("button", { name: `Manage ${projectName}`, exact: true }).click();
  const manage = page.getByRole("dialog", { name: "Manage project" });
  await expect(manage).toContainText("Deleting a project never deletes its conversations.");
  await manage.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(manage).toBeHidden();
  await expect(page.getByRole("button", { name: projectName, exact: true })).toHaveCount(0);
  await expect(currentActions).toBeVisible();

  await page.reload();
  await openSidebar(page);
  await expect(currentActions).toBeVisible();
});

test("preferences persist across reload and workspace modals restore keyboard focus", async ({ page }) => {
  await openSidebar(page);
  const createProjectButton = page.getByRole("button", { name: "Create project", exact: true });
  await createProjectButton.focus();
  await createProjectButton.press("Enter");
  const createDialog = page.getByRole("dialog", { name: "Create project" });
  await expect(createDialog.getByLabel("Project name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toBeHidden();
  await expect(createProjectButton).toBeFocused();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const dark = page.getByRole("radio", { name: /Dark/ });
  await dark.click();
  await expect(dark).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const compact = page.getByRole("switch", { name: "Compact conversations", exact: true });
  if (await compact.getAttribute("aria-checked") !== "true") await compact.click();
  await expect(compact).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Personalization", exact: true }).click();
  const instructions = `Answer with testable evidence ${Date.now()}`;
  await page.getByLabel("Custom instructions").fill(instructions);
  await page.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();

  await page.reload();
  await openSidebar(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Dark/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Compact conversations", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Personalization", exact: true }).click();
  await expect(page.getByLabel("Custom instructions")).toHaveValue(instructions);
});
