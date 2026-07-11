import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

const pngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const lazySourceAttachmentId = "00000000-0000-4000-8000-000000000999";

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
          capabilities: ["image_editing"],
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
  const editBodies: Record<string, unknown>[] = [];
  const historyAssets: Array<Record<string, unknown>> = [asset];
  let editOrdinal = 0;
  let deleted = false;
  const lazySource: { asset?: Record<string, unknown> } = {};
  let allowLazySource = false;
  await page.route("**/api/images**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/images/by-attachment/")) {
      if (!allowLazySource) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "temporary_failure", message: "Try again" } }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(lazySource.asset),
        });
      }
      return;
    }
    if (url.pathname === "/api/images/generations" && route.request().method() === "POST") {
      generatedBody = route.request().postDataJSON() as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assets: [asset], costMicros: 25 }),
      });
      return;
    }
    if (url.pathname === "/api/images/edits" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      editBodies.push(body);
      editOrdinal++;
      const sourceId = (body.images as Array<{ file_id: string }>)[0].file_id;
      const edited = {
        ...asset,
        id: `00000000-0000-4000-8000-00000000091${editOrdinal}`,
        attachmentId: `00000000-0000-4000-8000-00000000092${editOrdinal}`,
        operation: "edit",
        prompt: body.prompt,
        sourceAttachmentIds: [editOrdinal === 2 ? lazySourceAttachmentId : sourceId],
        createdAt: `2026-07-11T12:0${editOrdinal}:00.000Z`,
      };
      historyAssets.unshift(edited);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assets: [edited], costMicros: 25 }),
      });
      return;
    }
    if (url.pathname === "/api/images" && route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: historyAssets.map((item) =>
            item.id === asset.id
              ? {
                ...item,
                contentUrl: deleted ? null : asset.contentUrl,
                status: deleted ? "deleted" : "ready",
                deletedAt: deleted ? "2026-07-11T12:05:00.000Z" : null,
              }
              : item
          ),
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
  await page.route("**/api/attachments", async (route) => {
    if (route.request().method() !== "POST") return await route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        attachment: {
          id: "00000000-0000-4000-8000-000000000930",
          filename: "mask.png",
          mimeType: "image/png",
          sizeBytes: 68,
          state: "ready",
        },
      }),
    });
  });

  await login(page);
  await createChat(page);
  await expect(page.getByRole("button", { name: "Create images" })).toBeVisible();
  await expect(page.getByRole("button", { name: /edit image/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Create images" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create images" });
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("combobox").first().selectOption("e2e/image");
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
  await page.getByRole("combobox", { name: "Show active or deleted images" })
    .selectOption("active");
  const sourceCard = page.locator(`[data-generated-asset-id="${asset.id}"]`);
  await sourceCard.getByRole("button", { name: "Edit", exact: true }).click();
  const firstEditDialog = page.getByRole("dialog", { name: "Edit image" });
  await expect(firstEditDialog).toBeVisible();
  await firstEditDialog.getByRole("combobox").first().selectOption("e2e/edit-only");
  await expect(page.getByRole("img", { name: "Image to edit" })).toBeVisible();
  await expect(page.getByLabel("Describe your changes")).toBeFocused();
  await page.getByLabel("Describe your changes").fill("Make the robot blue");
  await page.getByRole("button", { name: "Create edit" }).click();
  await expect(page.getByText("New immutable version created")).toBeVisible();
  expect(editBodies[0]).toMatchObject({
    images: [{ file_id: asset.attachmentId }],
    prompt: "Make the robot blue",
  });
  expect(editBodies[0].mask).toBeUndefined();
  await page.getByRole("dialog", { name: "Edit image" })
    .getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByRole("button", { name: "Open image history" }).click();
  const firstEdit = historyAssets[0] as { id: string; attachmentId: string };
  lazySource.asset = {
    ...firstEdit,
    attachmentId: lazySourceAttachmentId,
  };
  await page.locator(`[data-generated-asset-id="${firstEdit.id}"]`)
    .getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit image" }).getByRole("combobox").first()
    .selectOption("e2e/edit-only");
  const maskInput = page.locator('input[type="file"][accept="image/png,.png"]');
  await maskInput.setInputFiles({
    name: "mask.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngDataUrl.split(",")[1], "base64"),
  });
  await expect(page.getByText("Ready · transparent areas will be edited")).toBeVisible();
  await page.getByLabel("Describe your changes").fill("Add a gold visor");
  await page.getByRole("button", { name: "Create edit" }).click();
  await expect(page.getByText("New immutable version created")).toBeVisible();
  expect(editBodies[1]).toMatchObject({
    images: [{ file_id: firstEdit.attachmentId }],
    mask: { file_id: "00000000-0000-4000-8000-000000000930" },
  });
  await page.getByRole("dialog", { name: "Edit image" })
    .getByRole("button", { name: "Close", exact: true }).last().click();
  historyAssets.splice(historyAssets.findIndex((item) => item.id === firstEdit.id), 1);
  await page.getByRole("button", { name: "Open image history" }).click();
  const secondEdit = historyAssets[0] as { id: string };
  await page.locator(`[data-generated-asset-id="${secondEdit.id}"]`)
    .getByRole("button", { name: `Generated image: Add a gold visor` }).click();
  await expect(page.getByRole("heading", { name: "Version lineage" })).toBeVisible();
  await expect(page.locator(".image-lineage-source-error")).toContainText(
    "Source 1 unavailable.",
  );
  await expect(page.getByRole("status")).toContainText(
    "Source 1 unavailable. Retry is available.",
  );
  allowLazySource = true;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Source 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Source 2" })).toHaveCount(0);
  await page.getByRole("dialog", { name: "Image history" })
    .getByRole("button", { name: "Edit", exact: true }).click();
  const cleanupDialog = page.getByRole("dialog", { name: "Edit image" });
  await cleanupDialog.getByRole("combobox").first().selectOption("e2e/edit-only");
  await cleanupDialog.locator('input[type="file"][accept="image/png,.png"]').setInputFiles({
    name: "cleanup-mask.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngDataUrl.split(",")[1], "base64"),
  });
  await expect(cleanupDialog.getByText("Ready · transparent areas will be edited")).toBeVisible();
  await cleanupDialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(cleanupDialog.getByRole("button", { name: "Close anyway", exact: true }))
    .toBeVisible();
  await cleanupDialog.getByRole("button", { name: "Close anyway", exact: true }).click();
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
