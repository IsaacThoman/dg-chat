import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

test("sends a ready attachment without prompt text and keeps empty text-only sends blocked", async ({ page }) => {
  const attachment = {
    id: "attachment-only-ready",
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 4,
    state: "ready",
    createdAt: "2026-07-10T00:00:00.000Z",
  };
  let generationBody: Record<string, unknown> | undefined;
  await page.route("**/api/attachments", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ attachment }),
    }));
  await page.route("**/api/conversations/*/generate/stream", async (route) => {
    generationBody = route.request().postDataJSON() as Record<string, unknown>;
    const conversationId = new URL(route.request().url()).pathname.split("/").at(-3)!;
    const generationId = crypto.randomUUID();
    const user = {
      id: crypto.randomUUID(),
      parentId: generationBody.parentId ?? null,
      role: "user",
      content: generationBody.content,
      model: generationBody.model,
      createdAt: new Date().toISOString(),
      attachments: [attachment],
    };
    const assistant = {
      id: crypto.randomUUID(),
      parentId: user.id,
      role: "assistant",
      content: "I can see the attachment.",
      model: generationBody.model,
      createdAt: new Date().toISOString(),
    };
    const conversation = {
      id: conversationId,
      title: "New chat",
      activeLeafId: assistant.id,
      version: 2,
      pinned: false,
      archivedAt: null,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
    };
    const events = [
      {
        type: "generation.started",
        generationId,
        sequence: 0,
        user,
        conversation: { ...conversation, activeLeafId: user.id, version: 1 },
      },
      { type: "generation.completed", generationId, sequence: 1, assistant, conversation },
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });

  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  await expect(page.getByText("1 KB · Ready", { exact: true })).toBeVisible();
  await expect(send).toBeEnabled();
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect.poll(() => generationBody?.content).toBe("");
  expect(generationBody?.attachmentIds).toEqual([attachment.id]);
  await expect(page.getByText("I can see the attachment.", { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();
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
  await page.route("**/api/conversations/*/generate/stream", async (route) => {
    generationCount += 1;
    generationBody = route.request().postDataJSON() as Record<string, unknown>;
    const conversationId = new URL(route.request().url()).pathname.split("/").at(-3)!;
    const now = "2026-07-10T00:00:00.000Z";
    const generationId = `attachment-generation-${generationCount}`;
    const user = {
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
    };
    const assistant = {
      id: `attachment-assistant-message-${generationCount}`,
      parentId: user.id,
      supersedesId: null,
      siblingIndex: 0,
      role: "assistant",
      content: "Attachment request received",
      model: generationBody.model,
      metadata: {},
      createdAt: now,
    };
    const conversation = {
      id: conversationId,
      title: "New chat",
      activeLeafId: assistant.id,
      version: Number(generationBody.expectedVersion ?? 0) + 2,
      pinned: false,
      archivedAt: null,
      deletedAt: null,
      updatedAt: now,
    };
    const events = [
      {
        type: "generation.started",
        generationId,
        sequence: 0,
        user,
        conversation: {
          ...conversation,
          activeLeafId: user.id,
          version: conversation.version - 1,
        },
      },
      {
        type: "generation.completed",
        generationId,
        sequence: 1,
        assistant,
        conversation,
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
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
  await composer.fill("");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => generationCount).toBe(2);
  await expect.poll(() => generationBody?.content).toBe("");
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
