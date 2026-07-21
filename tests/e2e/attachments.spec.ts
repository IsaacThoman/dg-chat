import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import { activeChatSession, bootstrap, createChat, login } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

test("sends and selectively shares a ready attachment while keeping empty text-only sends blocked", async ({ page }) => {
  const attachment = {
    id: "attachment-only-ready",
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 4,
    state: "ready",
    createdAt: "2026-07-10T00:00:00.000Z",
  };
  let generationBody: Record<string, unknown> | undefined;
  let shareBody: Record<string, unknown> | undefined;
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
  await page.route("**/api/conversations/*/shares", async (route) => {
    shareBody = route.request().postDataJSON() as Record<string, unknown>;
    const capability = String(shareBody.capability);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        share: {
          id: crypto.randomUUID(),
          conversationId: new URL(route.request().url()).pathname.split("/").at(-2),
          leafId: shareBody.leafId,
          conversationVersion: shareBody.expectedConversationVersion,
          title: "Attachment snapshot",
          identityVisibility: shareBody.identityVisibility,
          attachmentPolicy: shareBody.attachmentPolicy,
          attachmentCount: 1,
          messageCount: 2,
          version: 1,
          createdAt: new Date().toISOString(),
          expiresAt: null,
          revokedAt: null,
        },
        capability,
        path: `/share/${capability}`,
        replayed: false,
      }),
    });
  });

  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await activeChatSession(page).locator('input[type="file"]').setInputFiles({
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

  await page.getByRole("button", { name: "Share an immutable snapshot" }).click();
  const shareDialog = page.getByRole("dialog", { name: "Share conversation" });
  await shareDialog.getByRole("radio", { name: "Choose files" }).check();
  await expect(shareDialog.getByRole("button", { name: "Create snapshot" })).toBeDisabled();
  await shareDialog.getByRole("checkbox", { name: "diagram.png" }).check();
  await expect(shareDialog.getByRole("button", { name: "Create snapshot" })).toBeEnabled();
  await shareDialog.getByRole("button", { name: "Create snapshot" }).click();
  await expect(shareDialog.getByRole("heading", { name: "Snapshot ready" })).toBeVisible();
  expect(shareBody).toMatchObject({
    attachmentPolicy: "selected",
    selectedAttachmentIds: [attachment.id],
  });
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

  const input = activeChatSession(page).locator('input[type="file"]');
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
  await expect(activeChatSession(page).locator("article.user-message .attachment")).toHaveCount(1);

  await page.getByRole("button", { name: "Edit without overwriting" }).click();
  await expect(page.getByText("Retained from the original branch", { exact: true })).toBeVisible();
  await page.getByRole("button", {
    name: "Exclude attachment notes.txt from edited branch",
  }).click();
  await expect(page.getByText("Retained from the original branch", { exact: true })).toBeHidden();
  await expect(page.getByText("Excluded from this edited branch", { exact: true })).toBeVisible();
  const includeOriginal = page.getByRole("button", {
    name: "Include attachment notes.txt in edited branch",
  });
  await expect(includeOriginal).toBeFocused();
  await includeOriginal.click();
  await expect(page.getByText("Retained from the original branch", { exact: true })).toBeVisible();
  await expect(page.getByText("Excluded from this edited branch", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", {
    name: "Exclude attachment notes.txt from edited branch",
  })).toBeFocused();
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

test("isolates draft uploads from immutable edits and restores them afterward", async ({ page }) => {
  const uploadedAttachments = [
    {
      id: "draft-upload",
      filename: "draft-notes.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      state: "ready",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
    {
      id: "cancelled-edit-upload",
      filename: "cancelled-edit.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      state: "ready",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
    {
      id: "submitted-edit-upload",
      filename: "submitted-edit.txt",
      mimeType: "text/plain",
      sizeBytes: 13,
      state: "ready",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  ];
  let uploadIndex = 0;
  const deletedAttachmentIds: string[] = [];
  const generationBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/attachments", async (route) => {
    const attachment = uploadedAttachments[uploadIndex++];
    expect(attachment).toBeDefined();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ attachment }),
    });
  });
  await page.route("**/api/attachments/*", async (route) => {
    deletedAttachmentIds.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/conversations/*/generate/stream", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    generationBodies.push(body);
    const generationNumber = generationBodies.length;
    const conversationId = new URL(route.request().url()).pathname.split("/").at(-3)!;
    const now = "2026-07-10T00:00:00.000Z";
    const userId = `isolated-upload-user-${generationNumber}`;
    const assistantId = `isolated-upload-assistant-${generationNumber}`;
    const generationId = `isolated-upload-generation-${generationNumber}`;
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds as string[] : [];
    const user = {
      id: userId,
      parentId: body.parentId ?? null,
      supersedesId: body.supersedesId ?? null,
      siblingIndex: generationNumber - 1,
      role: "user",
      content: body.content,
      model: body.model,
      metadata: {},
      createdAt: now,
      attachments: uploadedAttachments.filter((attachment) =>
        attachmentIds.includes(attachment.id)
      ),
    };
    const assistant = {
      id: assistantId,
      parentId: userId,
      supersedesId: null,
      siblingIndex: 0,
      role: "assistant",
      content: `Isolated upload response ${generationNumber}`,
      model: body.model,
      metadata: {},
      createdAt: now,
    };
    const conversation = {
      id: conversationId,
      title: "New chat",
      activeLeafId: assistantId,
      version: Number(body.expectedVersion ?? 0) + 2,
      pinned: false,
      archivedAt: null,
      deletedAt: null,
      updatedAt: now,
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        {
          type: "generation.started",
          generationId,
          sequence: 0,
          user,
          conversation: {
            ...conversation,
            activeLeafId: userId,
            version: conversation.version - 1,
          },
        },
        { type: "generation.completed", generationId, sequence: 1, assistant, conversation },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });

  const composer = page.getByRole("textbox", { name: "Message" });
  const fileInput = activeChatSession(page).locator('input[type="file"]');
  await composer.fill("Saved prompt");
  await composer.press("Enter");
  await expect(page.getByText("Isolated upload response 1", { exact: true })).toBeVisible();

  await composer.fill("Unsent draft text");
  await fileInput.setInputFiles({
    name: "draft-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("draft notes"),
  });
  await expect(page.getByText("draft-notes.txt", { exact: true })).toBeVisible();
  await activeChatSession(page).locator(".composer-wrap").evaluate((element) => {
    const transfer = new DataTransfer();
    const oversized = new File(["oversized"], "oversized.txt", { type: "text/plain" });
    Object.defineProperty(oversized, "size", { value: 25 * 1024 * 1024 + 1 });
    transfer.items.add(oversized);
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    element.dispatchEvent(event);
  });
  const draftSelectionError = page.getByText(
    "Each attachment must be 25 MB or smaller.",
    { exact: true },
  );
  await expect(draftSelectionError).toBeVisible();

  await page.getByRole("button", { name: "Edit without overwriting" }).click();
  await expect(page.getByText("draft-notes.txt", { exact: true })).toBeHidden();
  await expect(draftSelectionError).toBeHidden();
  await fileInput.setInputFiles({
    name: "cancelled-edit.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("cancel edit"),
  });
  await expect(page.getByText("cancelled-edit.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel edit" }).click();
  await expect(page.getByText("cancelled-edit.txt", { exact: true })).toBeHidden();
  await expect(page.getByText("draft-notes.txt", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Unsent draft text");
  await expect(draftSelectionError).toBeVisible();
  await expect.poll(() => deletedAttachmentIds).toContain("cancelled-edit-upload");

  await page.getByRole("button", { name: "Edit without overwriting" }).click();
  await expect(page.getByText("draft-notes.txt", { exact: true })).toBeHidden();
  await expect(draftSelectionError).toBeHidden();
  await fileInput.setInputFiles({
    name: "submitted-edit.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("submit edit"),
  });
  await expect(page.getByText("submitted-edit.txt", { exact: true })).toBeVisible();
  await composer.fill("Edited prompt");
  await composer.press("Enter");
  await expect.poll(() => generationBodies.length).toBe(2);
  expect(generationBodies[1]?.attachmentIds).toEqual(["submitted-edit-upload"]);
  expect(generationBodies[1]?.attachmentIds).not.toContain("draft-upload");
  await expect(page.getByRole("button", { name: "Remove attachment submitted-edit.txt" }))
    .toBeHidden();
  await expect(page.getByText("draft-notes.txt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove attachment draft-notes.txt" }))
    .toBeVisible();
  await expect(composer).toHaveValue("Unsent draft text");
  await expect(draftSelectionError).toBeVisible();
});

test("double-clicking upload retry claims one request and leaves no orphan object", async ({ page }) => {
  let attempts = 0;
  const createdAttachmentIds: string[] = [];
  const deletedAttachmentIds: string[] = [];
  await page.route("**/api/attachments", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Retry this upload" } }),
      });
      return;
    }
    const id = `claimed-retry-${attempts}`;
    createdAttachmentIds.push(id);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        attachment: {
          id,
          filename: "double-retry.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          state: "ready",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      }),
    });
  });
  await page.route("**/api/attachments/*", async (route) => {
    deletedAttachmentIds.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    await route.fulfill({ status: 204, body: "" });
  });

  await activeChatSession(page).locator('input[type="file"]').setInputFiles({
    name: "double-retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry"),
  });
  await expect(page.getByText("Retry this upload", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry upload double-retry.txt", exact: true })
    .dblclick();
  await expect(
    activeChatSession(page).locator(".upload-ready").filter({ hasText: "double-retry.txt" }),
  )
    .toContainText("Ready");
  await expect.poll(() => attempts).toBe(2);
  expect(createdAttachmentIds).toEqual(["claimed-retry-2"]);

  await page.getByRole("button", {
    name: "Remove attachment double-retry.txt",
    exact: true,
  }).click();
  await expect.poll(() => deletedAttachmentIds).toEqual(["claimed-retry-2"]);
  expect(createdAttachmentIds.filter((id) => !deletedAttachmentIds.includes(id))).toEqual([]);
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

  const input = activeChatSession(page).locator('input[type="file"]');
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

  await activeChatSession(page).locator(".composer-wrap").evaluate((element) => {
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
  await page.getByRole("button", { name: "Retry upload cancel.txt" }).click();
  const retried = activeChatSession(page).locator(".upload-ready").filter({
    hasText: "cancel.txt",
  });
  await expect(retried).toContainText("Ready");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});
