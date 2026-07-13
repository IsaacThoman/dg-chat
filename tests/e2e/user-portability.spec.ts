import { expect, test } from "@playwright/test";
import { bootstrap, login } from "./helpers.ts";

const preview = {
  dryRun: true,
  replayed: false,
  conversations: 2,
  messages: 7,
  attachments: 1,
  folders: 1,
  tags: 3,
  idMap: {},
};

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
});

async function openSettings(page: import("@playwright/test").Page) {
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Data & privacy", exact: true }).click();
}

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.root).toBeLessThanOrEqual(1);
}

async function contrastRatio(
  locator: import("@playwright/test").Locator,
  backgroundSelector: string,
): Promise<number> {
  return await locator.evaluate((element, selector) => {
    const channels = (value: string) =>
      value.match(/[\d.]+/g)!.slice(0, 3).map((channel) => Number(channel) / 255);
    const luminance = (value: string) => {
      const [red, green, blue] = channels(value).map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      );
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const foreground = luminance(getComputedStyle(element).color);
    const background = luminance(
      getComputedStyle(element.closest(selector) ?? document.body).backgroundColor,
    );
    return (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05);
  }, backgroundSelector);
}

test("previews and explicitly confirms a portable import", async ({ page }, testInfo) => {
  let appliedKey = "";
  await page.route("**/api/portability/import/dry-run", async (route) => {
    expect(route.request().postData()).toContain("dgchat.owner-export");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(preview),
    });
  });
  await page.route("**/api/portability/import", async (route) => {
    appliedKey = await route.request().headerValue("idempotency-key") ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...preview, dryRun: false }),
    });
  });

  await openSettings(page);
  await expect(page.getByLabel("Include temporary conversations")).not.toBeChecked();
  const supportingText = page.locator(".portability-card small").first();
  expect(await contrastRatio(supportingText, ".portability-card")).toBeGreaterThanOrEqual(4.5);
  expect(
    Number.parseFloat(
      await supportingText.evaluate((element) => getComputedStyle(element).fontSize),
    ),
  )
    .toBeGreaterThanOrEqual(12);
  await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "dark"));
  expect(await contrastRatio(supportingText, ".portability-card")).toBeGreaterThanOrEqual(4.5);
  await page.locator("html").evaluate((element) => element.removeAttribute("data-theme"));
  await page.getByRole("button", { name: "Choose archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Import chat data" });
  const fileInput = dialog.locator('input[type="file"]');
  await expect(fileInput).toBeHidden();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await fileInput.setInputFiles({
    name: `${"a".repeat(247)}.dgchat`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "dgchat.owner-export", version: 1 })),
  });
  await expect(dialog.getByText("Ready to import")).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoPageOverflow(page);
  await expect(dialog.getByLabel("Import summary")).toContainText("7");
  expect(
    Number.parseFloat(
      await dialog.locator(".portability-summary dt").first().evaluate((element) =>
        getComputedStyle(element).fontSize
      ),
    ),
  ).toBeGreaterThanOrEqual(12);
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  const completeDialog = page.getByRole("dialog", { name: "Import complete" });
  await expect(completeDialog).toContainText(
    "Your archive was imported",
  );
  expect(await completeDialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(
      true,
    );
  await expectNoPageOverflow(page);
  if (testInfo.project.name.includes("mobile")) {
    await page.setViewportSize({ width: 320, height: 760 });
    expect(
      await completeDialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await expectNoPageOverflow(page);
  }
  expect(appliedKey.length).toBeGreaterThanOrEqual(8);
});

test("the chooser accepts the same archive twice", async ({ page }) => {
  let previews = 0;
  await page.route("**/api/portability/import/dry-run", async (route) => {
    previews += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(preview),
    });
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Choose archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Import chat data" });
  const input = dialog.locator('input[type="file"]');
  const button = dialog.getByRole("button", { name: "Choose DGCHAT file" });
  const archive = {
    name: "same-archive.dgchat",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "dgchat.owner-export", version: 1 })),
  };

  for (let selection = 0; selection < 2; selection += 1) {
    const chooserPromise = page.waitForEvent("filechooser");
    await button.click();
    const chooser = await chooserPromise;
    expect(await input.inputValue()).toBe("");
    await chooser.setFiles(archive);
    await expect(dialog.getByText("Ready to import")).toBeVisible();
  }
  expect(previews).toBe(2);
});

test("ignores drops while the current archive preview is pending", async ({ page }) => {
  let previews = 0;
  let previewStarted!: () => void;
  let releasePreview!: () => void;
  const started = new Promise<void>((resolve) => previewStarted = resolve);
  const release = new Promise<void>((resolve) => releasePreview = resolve);
  await page.route("**/api/portability/import/dry-run", async (route) => {
    previews += 1;
    previewStarted();
    await release;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(preview),
    });
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Choose archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Import chat data" });
  const dropTarget = dialog.locator(".portability-drop");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "first.dgchat",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "dgchat.owner-export", version: 1 })),
  });
  await started;
  await expect(dropTarget).toHaveAttribute("aria-disabled", "true");
  await dropTarget.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([JSON.stringify({ format: "dgchat.owner-export", version: 1 })], "second.dgchat", {
        type: "application/json",
      }),
    );
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  expect(previews).toBe(1);
  releasePreview();
  await expect(dialog.getByText("Ready to import")).toBeVisible();
  await expect(dropTarget).toContainText("first.dgchat");
});

test("long server errors wrap within the import dialog", async ({ page }, testInfo) => {
  await page.route("**/api/portability/import/dry-run", async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "invalid_archive", message: "x".repeat(500) } }),
    });
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Choose archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Import chat data" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "invalid.dgchat",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "dgchat.owner-export", version: 1 })),
  });
  await expect(dialog.getByRole("alert")).toBeVisible();
  if (testInfo.project.name.includes("mobile")) {
    await page.setViewportSize({ width: 320, height: 760 });
  }
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoPageOverflow(page);
});

test("rejects invalid local files without contacting the server", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/portability/import/**", async (route) => {
    requests++;
    await route.abort();
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Choose archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Import chat data" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(dialog.getByRole("alert")).toContainText(".dgchat");
  expect(requests).toBe(0);
});
