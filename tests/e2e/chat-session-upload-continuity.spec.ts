/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import { activeChatSession, bootstrap, createChat, login, openSidebar } from "./helpers.ts";

async function activeConversationId(page: import("@playwright/test").Page): Promise<string> {
  const value = await page.locator(".conversation-row.active [data-conversation-actions]")
    .getAttribute("data-conversation-actions");
  expect(value).toBeTruthy();
  return value!;
}

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

test("an in-flight upload survives chat and settings navigation without deletion", async ({ page }) => {
  const attachment = {
    id: crypto.randomUUID(),
    filename: "still-uploading.txt",
    mimeType: "text/plain",
    sizeBytes: 20,
    state: "ready",
    ingestionStatus: "not_applicable",
    createdAt: new Date().toISOString(),
  };
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let uploadStarted = false;
  let uploadCompleted = false;
  let deleteRequests = 0;
  await page.route("**/api/attachments", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    uploadStarted = true;
    await uploadGate;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      json: { attachment },
    });
    uploadCompleted = true;
  });
  await page.route("**/api/attachments/*", async (route) => {
    if (route.request().method() === "DELETE") {
      deleteRequests++;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.continue();
  });

  const ownerId = await activeConversationId(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Keep this draft with its in-flight upload");
  await activeChatSession(page).locator('input[type="file"]').setInputFiles({
    name: attachment.filename,
    mimeType: attachment.mimeType,
    buffer: Buffer.from("continuity upload"),
  });
  await expect.poll(() => uploadStarted).toBe(true);
  await expect(
    activeChatSession(page).getByRole("progressbar", { name: `Upload ${attachment.filename}` }),
  ).toBeVisible();

  await createChat(page);
  await (await openSidebar(page)).getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  releaseUpload();
  await expect.poll(() => uploadCompleted).toBe(true);
  expect(deleteRequests).toBe(0);

  await (await openSidebar(page)).getByRole("button", { name: "Chats", exact: true }).click();
  const sidebar = await openSidebar(page);
  await sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${ownerId}"]) button.conversation-open`,
  ).click();
  await expect(activeChatSession(page).getByText(attachment.filename, { exact: true }))
    .toBeVisible();
  await expect(activeChatSession(page).getByText("1 KB · Ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Keep this draft with its in-flight upload",
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  expect(deleteRequests).toBe(0);
});

test("a canceled late-success upload retains a retry until private content is deleted", async ({ page }) => {
  const attachment = {
    id: crypto.randomUUID(),
    filename: "cancel-race-private.txt",
    mimeType: "text/plain",
    sizeBytes: 21,
    state: "ready",
    ingestionStatus: "not_applicable",
    createdAt: new Date().toISOString(),
  };
  await page.evaluate((resolvedAttachment) => {
    const runtime = globalThis as typeof globalThis & {
      __resolveLateUpload?: () => void;
      XMLHttpRequest: typeof XMLHttpRequest;
    };
    class LateSuccessUploadRequest {
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      status = 0;
      responseText = "";
      withCredentials = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      send() {
        runtime.__resolveLateUpload = () => {
          this.status = 201;
          this.responseText = JSON.stringify({ attachment: resolvedAttachment });
          this.onload?.();
        };
      }
      // Model the narrow transport race where abort cannot retract an already accepted response.
      abort() {}
    }
    runtime.XMLHttpRequest = LateSuccessUploadRequest as unknown as typeof XMLHttpRequest;
  }, attachment);

  let deleteRequests = 0;
  await page.route(`**/api/attachments/${attachment.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deleteRequests += 1;
    if (deleteRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        json: { error: { message: "Injected cleanup outage" } },
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("The draft must remain usable after cleanup recovery");
  await activeChatSession(page).locator('input[type="file"]').setInputFiles({
    name: attachment.filename,
    mimeType: attachment.mimeType,
    buffer: Buffer.from("private cancellation race"),
  });
  const cancel = page.getByRole("button", { name: `Cancel upload ${attachment.filename}` });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __resolveLateUpload?: () => void };
    runtime.__resolveLateUpload?.();
  });

  const cleanupFailure = activeChatSession(page).getByText(
    "Couldn’t remove this canceled upload. Retry removal.",
    { exact: true },
  );
  await expect(cleanupFailure).toBeVisible();
  expect(deleteRequests).toBe(1);
  const retry = page.getByRole("button", { name: `Retry removing ${attachment.filename}` });
  await retry.click();
  await expect(activeChatSession(page).getByText(attachment.filename, { exact: true }))
    .toBeHidden();
  expect(deleteRequests).toBe(2);
  await expect(composer).toHaveValue("The draft must remain usable after cleanup recovery");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("canceling an edit keeps failed attachment cleanup visible and retryable", async ({ page }) => {
  await activeChatSession(page).locator('button.model-trigger[aria-haspopup="listbox"]').click();
  await page.getByRole("listbox", { name: "Chat model" })
    .getByRole("option", { name: /DG Chat Simulated/ })
    .click();
  const attachment = {
    id: crypto.randomUUID(),
    filename: "discarded-edit-private.txt",
    mimeType: "text/plain",
    sizeBytes: 22,
    state: "ready",
    ingestionStatus: "not_applicable",
    createdAt: new Date().toISOString(),
  };
  let deleteRequests = 0;
  await page.route("**/api/attachments", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      json: { attachment },
    });
  });
  await page.route(`**/api/attachments/${attachment.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deleteRequests += 1;
    if (deleteRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        json: { error: { message: "Injected edit cleanup outage" } },
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Immutable edit cleanup source");
  await composer.press("Enter");
  await expect(
    activeChatSession(page).getByText(/simulated response to: Immutable edit cleanup source/i),
  )
    .toBeVisible();
  await activeChatSession(page).getByText("Immutable edit cleanup source", { exact: true })
    .locator("xpath=ancestor::article[1]")
    .getByRole("button", { name: "Edit without overwriting" })
    .click();
  await activeChatSession(page).locator('input[type="file"]').setInputFiles({
    name: attachment.filename,
    mimeType: attachment.mimeType,
    buffer: Buffer.from("private edit cancellation"),
  });
  await expect(activeChatSession(page).getByText("1 KB · Ready", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Cancel edit" }).click();
  await expect(page.getByText("Create a new branch", { exact: true })).toBeHidden();
  await expect(activeChatSession(page).getByText("Couldn’t remove this upload.", { exact: true }))
    .toBeVisible();
  expect(deleteRequests).toBe(1);

  await page.getByRole("button", { name: `Retry removing ${attachment.filename}` }).click();
  await expect(activeChatSession(page).getByText(attachment.filename, { exact: true }))
    .toBeHidden();
  expect(deleteRequests).toBe(2);
  await expect(composer).toHaveValue("");
  await expect(
    activeChatSession(page).getByText("Immutable edit cleanup source", { exact: true }),
  ).toBeVisible();
});
