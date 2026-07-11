import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

const pngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

test("image generation is capability-aware, durable, and keyboard accessible", async ({ page, request }) => {
  await bootstrap(request);
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { data: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: [...payload.data, {
          id: "e2e/image",
          displayName: "E2E Image",
          provider: "e2e",
          capabilities: ["image_generation"],
          contextWindow: 4096,
        }, {
          id: "e2e/edit-only",
          displayName: "E2E Edit (not ready)",
          provider: "e2e",
          capabilities: ["image_edit"],
          contextWindow: 4096,
        }],
      },
    });
  });
  const asset = {
    id: "00000000-0000-4000-8000-000000000901",
    attachmentId: "00000000-0000-4000-8000-000000000902",
    contentUrl: pngDataUrl,
    thumbnailUrl: null,
    sourceAttachmentIds: [],
    operation: "generation",
    prompt: "A friendly accessibility robot",
    revisedPrompt: "A polished friendly accessibility robot",
    model: "e2e/image",
    width: 1024,
    height: 1024,
    mimeType: "image/png",
    sizeBytes: 68,
    status: "ready",
    costMicros: 25,
    createdAt: "2026-07-11T12:00:00.000Z",
    deletedAt: null,
  } as const;
  let generatedBody: Record<string, unknown> | undefined;
  let deleted = false;
  await page.route("**/api/images**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/images/generations" && route.request().method() === "POST") {
      generatedBody = route.request().postDataJSON() as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 75));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assets: [asset], costMicros: 25 }),
      });
      return;
    }
    if (url.pathname === "/api/images" && route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{
            ...asset,
            contentUrl: deleted ? null : asset.contentUrl,
            status: deleted ? "deleted" : "ready",
            deletedAt: deleted ? "2026-07-11T12:05:00.000Z" : null,
          }],
          nextCursor: null,
        }),
      });
      return;
    }
    if (url.pathname === `/api/images/${asset.id}` && route.request().method() === "DELETE") {
      deleted = true;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (
      url.pathname === `/api/images/${asset.id}/restore` && route.request().method() === "POST"
    ) {
      deleted = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(asset),
      });
      return;
    }
    await route.continue();
  });

  await login(page);
  await createChat(page);
  await expect(page.getByRole("button", { name: "Create images" })).toBeVisible();
  await expect(page.getByRole("button", { name: /edit image/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Create images" }).click();
  await expect(page.getByRole("dialog", { name: "Create images" })).toBeVisible();
  await page.getByLabel("Describe the image").fill(asset.prompt);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Creating durable image assets");
  await expect(page.getByRole("img", { name: `Generated image: ${asset.prompt}` })).toBeVisible();
  expect(generatedBody).toMatchObject({ model: "e2e/image", prompt: asset.prompt, n: 1 });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("dialog", { name: "Create images" })
    .getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByText("Ready · remains in image history")).toBeVisible();

  await page.getByRole("button", { name: "Open image history" }).click();
  await expect(page.getByRole("heading", { name: "Images" })).toBeVisible();
  await page.getByRole("button", { name: "Delete generated image" }).click();
  await page.getByRole("combobox", { name: "Show active or deleted images" })
    .selectOption("deleted");
  await expect(page.getByText("deleted", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download generated image" })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("No images match this view.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Image history" })).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const dom = (globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }).document;
      return dom.documentElement.scrollWidth <= dom.documentElement.clientWidth;
    }),
  ).toBe(true);
});
