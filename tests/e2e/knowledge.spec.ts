import { expect, test } from "@playwright/test";
import { apiURL, bootstrap, createChat, login } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

async function openSidebar(page: import("@playwright/test").Page) {
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
}

test("manages a collection and persists conversation knowledge", async ({ page }, testInfo) => {
  const suffix = `${Date.now()}-${testInfo.project.name}`;
  const originalName = `Knowledge ${suffix}`;
  const renamedName = `Product docs ${suffix}`;
  const filename = `knowledge-${suffix}.txt`;

  // Exercise the real upload and ingestion path so the collection can only accept a genuinely
  // ready, owner-scoped attachment. The worker updates this status asynchronously.
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from(`DG Chat knowledge browser test document ${suffix}.`),
  });
  await expect.poll(async () => {
    const response = await page.request.get(`${apiURL}/api/attachments`);
    if (!response.ok()) return "unavailable";
    const body = await response.json() as {
      data: Array<{ filename: string; ingestionStatus?: string }>;
    };
    return body.data.find((attachment) => attachment.filename === filename)?.ingestionStatus ??
      "missing";
  }, { timeout: 30_000 }).toBe("ready");

  await openSidebar(page);
  await page.getByRole("complementary").getByRole("button", {
    name: "Knowledge",
    exact: true,
  }).click();
  await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();

  const create = page.getByRole("button", { name: "Create collection" });
  await create.click();
  await page.getByRole("dialog", { name: "New collection" }).getByLabel("Name").fill(originalName);
  await page.getByRole("dialog", { name: "New collection" })
    .getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: originalName })).toBeVisible();

  await page.getByRole("button", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename collection" });
  await renameDialog.getByLabel("Name").fill(renamedName);
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: renamedName })).toBeVisible();

  await page.getByRole("button", { name: "Add uploaded file" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add an uploaded file" });
  await addDialog.getByRole("radio", { name: new RegExp(filename) }).check();
  await addDialog.getByRole("button", { name: "Add file" }).click();
  await expect(page.getByText(filename, { exact: true })).toBeVisible();
  await expect(page.locator(".knowledge-list nav button.active")).toContainText(
    "1 file",
  );

  await openSidebar(page);
  await page.getByRole("complementary").getByRole("button", { name: "Chats", exact: true })
    .click();
  const knowledgeTrigger = page.getByRole("main").getByRole("button", { name: /^Knowledge/ });
  await knowledgeTrigger.click();
  const picker = page.getByRole("dialog", { name: "Conversation knowledge" });
  await picker.getByRole("checkbox", { name: new RegExp(renamedName) }).check();
  await picker.getByRole("radio", { name: /Full context/ }).check();
  await picker.getByRole("button", { name: "Use knowledge" }).click();
  await expect(knowledgeTrigger).toContainText("1");

  await page.reload();
  await expect(knowledgeTrigger).toContainText("1");
  await knowledgeTrigger.click();
  const persistedPicker = page.getByRole("dialog", { name: "Conversation knowledge" });
  await expect(persistedPicker.getByRole("checkbox", { name: new RegExp(renamedName) }))
    .toBeChecked();
  await expect(persistedPicker.getByRole("radio", { name: /Full context/ })).toBeChecked();
  await persistedPicker.getByRole("checkbox", { name: new RegExp(renamedName) }).uncheck();
  await persistedPicker.getByRole("button", { name: "Remove knowledge" }).click();
  await expect(knowledgeTrigger).not.toContainText("1");

  await openSidebar(page);
  await page.getByRole("complementary").getByRole("button", {
    name: "Knowledge",
    exact: true,
  }).click();
  await expect(page.getByRole("heading", { name: renamedName })).toBeVisible();
  const removeFile = page.getByRole("button", { name: `Remove ${filename} from collection` });
  if (testInfo.project.name.includes("mobile")) {
    const removeBox = await removeFile.boundingBox();
    const createBox = await create.boundingBox();
    expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(createBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await removeFile.click();
  await expect(page.getByText(filename, { exact: true })).toBeHidden();

  await page.getByRole("button", { name: `Delete ${renamedName}` }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete collection?" });
  await expect(deleteDialog).toContainText("cannot be undone");
  await deleteDialog.getByRole("button", { name: "Delete collection" }).click();
  await expect(page.getByRole("heading", { name: renamedName })).toBeHidden();
});
