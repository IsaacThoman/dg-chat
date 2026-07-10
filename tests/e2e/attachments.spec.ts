import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

test("uploads, retains attachments on edit branches, and removes unsent uploads", async ({
  page,
}, testInfo) => {
  const attachment = {
    id: "attachment-ready-1",
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 11,
    state: "ready",
    createdAt: "2026-07-10T00:00:00.000Z",
  };
  let generationBody: Record<string, unknown> | undefined;
  let generationCount = 0;
  let deleted = false;
  await page.route("**/api/attachments", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ attachment }),
    });
  });
  await page.route("**/api/attachments/*", async (route) => {
    deleted = true;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/conversations/*/generate", async (route) => {
    generationCount += 1;
    generationBody = route.request().postDataJSON() as Record<string, unknown>;
    const conversationId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const now = "2026-07-10T00:00:00.000Z";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: `attachment-user-message-${generationCount}`,
          parentId: generationBody.parentId ?? null,
          supersedesId: generationBody.supersedesId ?? null,
          siblingIndex: generationCount - 1,
          role: "user",
          content: generationBody.content,
          model: generationBody.model,
          metadata: {},
          createdAt: now,
          attachments: generationBody.attachmentIds ? [attachment] : [],
        },
        assistant: {
          id: `attachment-assistant-message-${generationCount}`,
          parentId: `attachment-user-message-${generationCount}`,
          supersedesId: null,
          siblingIndex: 0,
          role: "assistant",
          content: "Attachment request received",
          model: generationBody.model,
          metadata: {},
          createdAt: now,
        },
        conversation: {
          id: conversationId,
          title: "New chat",
          activeLeafId: `attachment-assistant-message-${generationCount}`,
          version: Number(generationBody.expectedVersion ?? 0) + 1,
          pinned: false,
          archivedAt: null,
          deletedAt: null,
          updatedAt: now,
        },
      }),
    });
  });

  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello world"),
  });
  await expect(page.getByText("1 KB · Ready", { exact: true })).toBeVisible();
  const remove = page.getByRole("button", { name: "Remove attachment notes.txt" });
  if (testInfo.project.name.includes("mobile")) {
    const box = await remove.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Use the uploaded notes");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => generationBody?.attachmentIds).toEqual([attachment.id]);
  await expect(page.getByLabel("Selected attachments")).toBeHidden();
  await expect(page.locator("article.user-message .attachment")).toHaveCount(1);

  await page.getByRole("button", { name: "Edit without overwriting" }).click();
  await expect(page.getByText("Retained from the original branch", { exact: true })).toBeVisible();
  await page.getByRole("button", {
    name: "Exclude attachment notes.txt from edited branch",
  }).click();
  await expect(page.getByText("Retained from the original branch", { exact: true })).toBeHidden();
  expect(deleted).toBe(false);
  await page.getByRole("button", { name: "Cancel edit" }).click();
  await page.getByRole("button", { name: "Edit without overwriting" }).click();
  await expect(page.getByText("Retained from the original branch", { exact: true })).toBeVisible();
  await composer.fill("Use the uploaded notes, edited");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => generationCount).toBe(2);
  await expect.poll(() => generationBody?.attachmentIds).toEqual([attachment.id]);
  await expect.poll(() => generationBody?.supersedesId).toBe("attachment-user-message-1");

  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["hello world"], "notes.txt", { type: "text/plain" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    element.dispatchEvent(event);
  });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect.poll(() => deleted).toBe(true);
  await expect(remove).toBeHidden();
});

test("failed and cancelled uploads block send and can be retried", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/attachments", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "File type blocked" } }),
      });
      return;
    }
    if (attempts === 3) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        attachment: {
          id: `attachment-${attempts}`,
          filename: attempts === 3 ? "cancel.txt" : "retry.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          state: "ready",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      }),
    }).catch(() => undefined);
  });

  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry"),
  });
  await expect(page.getByText("File type blocked", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Blocked while upload failed");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry upload retry.txt" }).click();
  await expect(page.getByText(/Ready$/, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  await page.locator(".composer-wrap").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["cancel"], "cancel.txt", { type: "text/plain" }));
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    element.dispatchEvent(event);
  });
  await page.getByRole("button", { name: "Cancel upload cancel.txt" }).click();
  await expect(page.getByText("Upload cancelled.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry upload cancel.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
});
