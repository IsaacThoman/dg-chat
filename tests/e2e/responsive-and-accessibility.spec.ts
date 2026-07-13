import { expect, test } from "@playwright/test";
import { env } from "./env.ts";
import { bootstrap, createChat, login } from "./helpers.ts";

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${color}`);
    const [red, green, blue] = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

test(
  "primary chat controls remain usable at the project viewport",
  async ({ page, request }, testInfo) => {
    await bootstrap(request);
    await login(page);
    await createChat(page);
    const mobile = testInfo.project.name.includes("mobile");
    const composer = page.getByRole("textbox", { name: /message/i });
    await expect(composer).toBeVisible();
    await composer.focus();
    await expect(composer).toBeFocused();
    if (mobile) {
      await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "New chat ⌘ K", exact: true }))
        .toHaveCount(0);
    } else {
      await expect(page.getByRole("button", { name: "New chat ⌘ K", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeHidden();
      await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeHidden();
    }
    await expect(page.getByRole("button", { name: "Attach files" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Open web search" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Tools (not available yet)" })).toBeDisabled();
    await expect(page.getByRole("button", {
      name: /^(Start voice input|Voice input unavailable:)/,
    })).toBeVisible();

    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const composerGradient = await page.locator(".composer-wrap").evaluate((element) =>
      getComputedStyle(element).backgroundImage
    );
    expect(composerGradient).toContain("rgb(23, 23, 21)");
    expect(composerGradient).not.toContain("rgb(255, 255, 255)");
    const darkSidebarColors = await page.evaluate(() => {
      const newChat = document.querySelector<HTMLElement>(".new-chat")!;
      const search = document.querySelector<HTMLElement>(".search")!;
      const searchInput = search.querySelector<HTMLElement>("input")!;
      return {
        newChat: {
          foreground: getComputedStyle(newChat).color,
          background: getComputedStyle(newChat).backgroundColor,
        },
        search: {
          foreground: getComputedStyle(searchInput).color,
          background: getComputedStyle(search).backgroundColor,
        },
      };
    });
    expect(contrastRatio(
      darkSidebarColors.newChat.foreground,
      darkSidebarColors.newChat.background,
    )).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(
      darkSidebarColors.search.foreground,
      darkSidebarColors.search.background,
    )).toBeGreaterThanOrEqual(4.5);
    const attachButton = page.getByRole("button", { name: "Attach files" });
    await attachButton.hover();
    const iconHoverColors = await attachButton.evaluate((element) => ({
      foreground: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }));
    expect(contrastRatio(
      iconHoverColors.foreground,
      iconHoverColors.background,
    )).toBeGreaterThanOrEqual(3);

    if (mobile) {
      await page.setViewportSize({ width: 320, height: 800 });
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
      expect(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          document.body.scrollWidth <= document.body.clientWidth
        ),
      ).toBe(true);
      const sendBox = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
      expect(sendBox).not.toBeNull();
      expect((sendBox?.x ?? 0) + (sendBox?.width ?? 0)).toBeLessThanOrEqual(
        page.viewportSize()?.width ?? 320,
      );
    }
  },
);

test("mobile drawer is inert while closed and sheds modal state at the desktop breakpoint", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile drawer regression");
  await bootstrap(request);
  await login(page);
  await createChat(page);
  await createChat(page);

  const sidebar = page.locator("aside.sidebar");
  const open = page.getByRole("button", { name: "Open menu", exact: true });
  await page.setViewportSize({ width: 760, height: 800 });
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(open).toBeVisible();
  await page.setViewportSize({ width: 761, height: 800 });
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).not.toHaveAttribute("inert", "");
  await expect(open).toBeHidden();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(page.getByRole("dialog", { name: "Workspace navigation", exact: true }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "New chat ⌘ K", exact: true })).toHaveCount(0);

  await open.click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation", exact: true });
  await expect(drawer).toBeVisible();
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeFocused();

  const actions = drawer.locator(".conversation-row.active [data-conversation-actions]");
  await expect(actions).toHaveCount(1);
  const actionLabel = await actions.getAttribute("aria-label");
  const actionId = await actions.getAttribute("data-conversation-actions");
  expect(actionLabel).toBeTruthy();
  expect(actionId).toBeTruthy();
  await actions.click();
  const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
  await expect(rename).toBeFocused();
  await rename.press("Shift+Tab");
  expect(await sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await rename.focus();
  await rename.press("End");
  const lastMenuItem = page.getByRole("menuitem").last();
  await expect(lastMenuItem).toBeFocused();
  await lastMenuItem.press("Tab");
  expect(await sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await rename.click();
  const renameDialog = page.getByRole("dialog", { name: "Rename conversation", exact: true });
  await expect(renameDialog).toBeVisible();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebar).not.toHaveAttribute("role", "dialog");
  const renameClose = renameDialog.getByRole("button", { name: "Close", exact: true });
  const renameSave = renameDialog.getByRole("button", { name: "Save", exact: true });
  await renameClose.focus();
  await renameClose.press("Shift+Tab");
  await expect(renameSave).toBeFocused();
  await renameSave.press("Tab");
  await expect(renameClose).toBeFocused();
  await renameDialog.press("Escape");
  await expect(renameDialog).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);
  await expect(actions).toBeFocused();

  await actions.click();
  await rename.click();
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(renameDialog).toBeVisible();
  await expect(sidebar).not.toHaveAttribute("inert", "");
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toHaveAttribute("inert", "");
  await renameDialog.press("Escape");
  await expect(renameDialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(drawer).toBeVisible();

  await actions.click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  const trashDialog = page.getByRole("dialog", {
    name: "Move conversation to trash?",
    exact: true,
  });
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);
  await trashDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trashDialog).toHaveCount(0);
  await expect(actions).toBeFocused();

  await actions.click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await page.route("**/api/conversations/*", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Injected failure" } }),
      });
      return;
    }
    await route.fallback();
  });
  const confirmTrash = trashDialog.getByRole("button", { name: "Move to trash", exact: true });
  await confirmTrash.click();
  await expect(trashDialog.getByRole("alert")).toHaveText("Action failed. Try again.");
  await expect(trashDialog).toBeVisible();
  await page.unroute("**/api/conversations/*");
  await trashDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trashDialog).toHaveCount(0);
  await actions.click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await expect(trashDialog.getByRole("alert")).toHaveCount(0);
  await confirmTrash.click();
  await expect(trashDialog).toHaveCount(0);
  await expect(
    drawer.locator(`[data-conversation-actions="${actionId!}"]`),
  ).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeFocused();
  const fallbackAction = drawer.locator(".conversation-row.active [data-conversation-actions]");
  await expect(fallbackAction).toHaveCount(1);
  await expect(fallbackAction).not.toHaveAttribute("data-conversation-actions", actionId!);

  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(sidebar).not.toHaveClass(/mobile-open/);
  await expect(sidebar).not.toHaveAttribute("role", "dialog");
  await expect(sidebar).not.toHaveAttribute("aria-modal", "true");
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
});

test("mobile top-level navigation restores focus", async ({ page, request }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile focus restoration regression");
  await bootstrap(request);
  await login(page);
  await createChat(page);

  const destinations = ["Admin console", "Settings", "Knowledge"];
  for (const destination of destinations) {
    const openMenu = page.getByRole("button", { name: "Open menu", exact: true });
    await openMenu.click();
    await page.getByRole("dialog", { name: "Workspace navigation", exact: true }).getByRole(
      "button",
      { name: destination, exact: true },
    ).click();
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeFocused();
  }
});

test("every admin section is reachable across desktop and mobile", async ({
  page,
  request,
}, testInfo) => {
  await bootstrap(request);
  await login(page);
  const mobile = testInfo.project.name.includes("mobile");
  if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "Admin console", exact: true }).click();

  const sections = [
    ["overview", "Overview", "Workspace overview"],
    ["applicants", "Applicants", "Applicants"],
    ["users", "Users", "Users"],
    ["providers", "Providers", "Providers"],
    ["models", "Models & pricing", "Models & pricing"],
    ["resilience", "Routing resilience", "Routing resilience"],
    ["usage", "Usage analytics", "Usage analytics"],
    ["jobs", "Background jobs", "Background jobs"],
    ["audit", "Audit log", "Audit log"],
    ["retention", "Retention", "Retention"],
    ["storage", "Storage & backups", "Storage & backups"],
  ] as const;

  if (mobile) {
    const selector = page.getByRole("combobox", { name: "Admin section" });
    await expect(selector).toBeVisible();
    const box = await selector.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await selector.focus();
    await expect(selector).toBeFocused();
    for (const [value, _label, heading] of sections) {
      await selector.selectOption(value);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    return;
  }

  for (const [_value, label, heading] of sections) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
});

test("health and readiness distinguish process and dependencies", async ({ request }) => {
  const api = env("E2E_API_URL") ?? "http://localhost:8000";
  const [health, ready] = await Promise.all([
    request.get(`${api}/health`),
    request.get(`${api}/ready`),
  ]);
  expect(health.ok()).toBeTruthy();
  expect(ready.ok()).toBeTruthy();
});

test("provider credentials, failures, and modal focus are safely managed", async ({
  page,
  request,
}, testInfo) => {
  await bootstrap(request);
  await login(page);
  const mobile = testInfo.project.name.includes("mobile");
  if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "Admin console", exact: true }).click();
  if (mobile) {
    await page.getByRole("combobox", { name: "Admin section" }).selectOption("providers");
  } else {
    await page.getByRole("link", { name: "Providers", exact: true }).click();
  }

  const addProvider = page.getByRole("button", { name: "Add provider", exact: true });
  await addProvider.click();
  const displayName = page.getByLabel("Display name", { exact: true });
  await expect(displayName).toBeFocused();
  await displayName.press("Escape");
  await expect(addProvider).toBeFocused();

  await addProvider.click();
  const suffix = crypto.randomUUID().slice(0, 8);
  const providerName = `E2E Provider ${suffix}`;
  await page.getByLabel("Display name", { exact: true }).fill(providerName);
  await page.getByLabel(/Provider ID/).fill(`e2e-${suffix}`);
  const baseUrl = page.getByLabel(/Base URL/);
  await baseUrl.fill("https://provider.invalid/v1?unsafe=true");
  await page.getByLabel(/API credential/).fill(`e2e-secret-${suffix}`);
  await page.getByRole("button", { name: "Save provider", exact: true }).click();
  const providerError = page.getByRole("dialog", { name: "Add provider", exact: true })
    .getByRole("alert");
  await expect(providerError).toBeFocused();
  const providerErrorBox = await providerError.boundingBox();
  const providerDialogBox = await page.getByRole("dialog", { name: "Add provider", exact: true })
    .boundingBox();
  expect(providerErrorBox).not.toBeNull();
  expect(providerDialogBox).not.toBeNull();
  expect(providerErrorBox!.y).toBeGreaterThanOrEqual(providerDialogBox!.y);
  expect(providerErrorBox!.y + providerErrorBox!.height).toBeLessThanOrEqual(
    providerDialogBox!.y + providerDialogBox!.height,
  );
  await baseUrl.fill("https://provider.invalid/v1");
  await page.getByRole("button", { name: "Save provider", exact: true }).click();
  await expect(page.getByRole("heading", { name: providerName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Manage ${providerName}`, exact: true }).click();
  const replacement = page.getByLabel(/Replace credential/);
  await expect(replacement).toHaveValue("");
  await expect(replacement).toHaveAttribute("autocomplete", "new-password");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: `Test ${providerName}`, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Provider connection failed");
  await expect(page.locator("body")).not.toContainText(`e2e-secret-${suffix}`);
});

test("Responses providers expose safe defaults and typed OCR targets", async ({
  page,
  request,
}, testInfo) => {
  test.slow();
  await bootstrap(request);
  await login(page);
  const mobile = testInfo.project.name.includes("mobile");
  if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "Admin console", exact: true }).click();
  if (mobile) {
    await page.getByRole("combobox", { name: "Admin section" }).selectOption("providers");
  } else {
    await page.getByRole("link", { name: "Providers", exact: true }).click();
  }

  const suffix = crypto.randomUUID().slice(0, 8);
  const providerName = `Responses E2E ${suffix}`;
  const providerSlug = `responses-${suffix}`;
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  const providerDialog = page.getByRole("dialog", { name: "Add provider", exact: true });
  await providerDialog.getByLabel("Display name", { exact: true }).fill(providerName);
  await providerDialog.getByLabel(/Provider ID/).fill(providerSlug);
  await providerDialog.getByLabel(/Base URL/).fill("https://provider.invalid/v1");
  await providerDialog.getByLabel(/Upstream protocol/).selectOption("responses");
  await providerDialog.getByLabel("Enabled", { exact: true }).check();
  await providerDialog.getByLabel(/API credential/).fill(`responses-secret-${suffix}`);
  await providerDialog.getByRole("button", { name: "Save provider", exact: true }).click();
  await expect(page.getByRole("heading", { name: providerName, exact: true })).toBeVisible();
  const providerCard = page.locator(".provider-card").filter({
    has: page.getByRole("heading", { name: providerName, exact: true }),
  });
  await expect(providerCard).toContainText("Protocol");
  await expect(providerCard).toContainText("Responses");

  if (mobile) {
    await page.getByRole("combobox", { name: "Admin section" }).selectOption("models");
  } else {
    await page.getByRole("link", { name: "Models & pricing", exact: true }).click();
  }

  const addModel = page.getByRole("button", { name: "Add model", exact: true });
  await addModel.click();
  let modelDialog = page.getByRole("dialog", { name: "Add model", exact: true });
  await modelDialog.getByRole("combobox", { name: "Provider", exact: true })
    .selectOption({ label: providerName });
  await modelDialog.getByLabel("Upstream model ID", { exact: true }).fill(`vision-${suffix}`);
  await modelDialog.getByLabel("Public model ID", { exact: true })
    .fill(`${providerSlug}/vision`);
  const visionName = `Vision target ${suffix}`;
  await modelDialog.getByLabel("Display name", { exact: true }).fill(visionName);
  await modelDialog.getByLabel("vision", { exact: true }).check();
  await modelDialog.getByLabel("Enabled", { exact: true }).check();
  await modelDialog.getByText("Advanced provider defaults", { exact: true }).click();
  await expect(modelDialog).toContainText(
    "Responses providers accept temperature, top_p, response_format, and parallel_tool_calls.",
  );
  await modelDialog.getByLabel(/Safe defaults/).fill('{"temperature":0.2}');
  await modelDialog.getByRole("button", { name: "Save model", exact: true }).click();
  await expect(page.getByRole("heading", { name: visionName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Add pricing for ${visionName}`, exact: true }).click();
  const priceDialog = page.getByRole("dialog", {
    name: `Add pricing revision · ${visionName}`,
    exact: true,
  });
  await priceDialog.getByRole("button", { name: "Add revision", exact: true }).click();
  const visionCard = page.locator(".model-card").filter({
    has: page.getByRole("heading", { name: visionName, exact: true }),
  });
  await expect(visionCard.getByText("available", { exact: true })).toBeVisible();

  await addModel.click();
  modelDialog = page.getByRole("dialog", { name: "Add model", exact: true });
  await modelDialog.getByRole("combobox", { name: "Provider", exact: true })
    .selectOption({ label: providerName });
  await modelDialog.getByLabel("Upstream model ID", { exact: true }).fill(`source-${suffix}`);
  await modelDialog.getByLabel("Public model ID", { exact: true })
    .fill(`${providerSlug}/source`);
  const sourceName = `OCR source ${suffix}`;
  await modelDialog.getByLabel("Display name", { exact: true }).fill(sourceName);
  await modelDialog.getByText("Advanced provider defaults", { exact: true }).click();
  const safeDefaults = modelDialog.getByLabel(/Safe defaults/);
  await safeDefaults.fill('{"stop":"END"}');
  await modelDialog.getByRole("button", { name: "Save model", exact: true }).click();
  const modelError = modelDialog.getByRole("alert");
  await expect(modelError).toContainText(
    `${providerSlug}/source: stop is not supported by Responses providers`,
  );
  await expect(modelError).toBeFocused();
  const errorBox = await modelError.boundingBox();
  const dialogBox = await modelDialog.boundingBox();
  expect(errorBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(errorBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
  expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
  await safeDefaults.fill('{"temperature":0.4}');
  await modelDialog.getByLabel("Enable bounded OCR for images sent to this model", {
    exact: true,
  }).check();
  const ocrProvider = modelDialog.getByRole("combobox", { name: "OCR provider", exact: true });
  await expect(ocrProvider.locator("option:checked")).toHaveText(providerName);
  const visionSelector = modelDialog.getByRole("combobox", {
    name: "Vision model",
    exact: true,
  });
  await expect(visionSelector.locator("option")).toHaveCount(2);
  await visionSelector.selectOption({ label: `${visionName} (${providerSlug}/vision)` });
  if (mobile) {
    expect(await modelDialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
  }
  await modelDialog.getByRole("button", { name: "Save model", exact: true }).click();
  await expect(page.getByRole("heading", { name: sourceName, exact: true })).toBeVisible();
  const sourceCard = page.locator(".model-card").filter({
    has: page.getByRole("heading", { name: sourceName, exact: true }),
  });
  await expect(sourceCard).toContainText(`OCR → ${visionName}`);
  await expect(sourceCard).toContainText("Responses");

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.locator(".admin-main")).toHaveCSS("background-color", "rgb(23, 23, 21)");
  await expect(page.locator(".admin-nav")).toHaveCSS("background-color", "rgb(34, 34, 32)");
  await expect(page.getByRole("heading", { name: "Models & pricing", exact: true })).toHaveCSS(
    "color",
    "rgb(242, 241, 237)",
  );
  if (mobile) await page.setViewportSize({ width: 320, height: 700 });
  await addModel.click();
  modelDialog = page.getByRole("dialog", { name: "Add model", exact: true });
  await expect(modelDialog.getByText("Provider", { exact: true })).toHaveCSS(
    "color",
    "rgb(242, 241, 237)",
  );
  const providerSelect = modelDialog.getByRole("combobox", { name: "Provider", exact: true });
  await providerSelect.focus();
  await page.keyboard.press("Tab");
  await expect(modelDialog.getByLabel("Upstream model ID", { exact: true })).toBeFocused();
  if (mobile) {
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
        document.body.scrollWidth <= document.body.clientWidth
      ),
    ).toBe(true);
  }
  await modelDialog.getByRole("button", { name: "Close", exact: true }).click();
});

test(
  "audit log filters real events and exports a bounded CSV page",
  async ({ page, request }, testInfo) => {
    await bootstrap(request);
    await login(page);
    const mobile = testInfo.project.name.includes("mobile");
    if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("button", { name: "Admin console", exact: true }).click();
    if (mobile) {
      await page.getByRole("combobox", { name: "Admin section" }).selectOption("audit");
    } else {
      await page.getByRole("link", { name: "Audit log", exact: true }).click();
    }

    const filters = page.getByRole("form", { name: "Audit filters" });
    await expect(filters).toBeVisible();
    await filters.getByLabel("Action").fill("identity.bootstrap_admin");
    await filters.getByRole("button", { name: "Apply filters" }).click();
    const table = page.getByRole("table", { name: "Audit events" });
    await expect(table).toBeVisible();
    await expect(table.getByText("identity.bootstrap_admin", { exact: true })).toBeVisible();

    const exportLink = page.getByRole("link", { name: "Export page CSV" });
    await expect(exportLink).toHaveAttribute(
      "href",
      /audit\.csv\?.*action=identity\.bootstrap_admin/,
    );
    const href = await exportLink.getAttribute("href");
    // Request through the same web origin as the signed-in page. This both exercises
    // the production-style reverse-proxy path and preserves the host-only session
    // cookie (localhost and 127.0.0.1 intentionally do not share cookies).
    const csv = await page.context().request.get(new URL(href!, page.url()).toString());
    expect(csv.ok()).toBeTruthy();
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(await csv.text()).toContain("identity.bootstrap_admin");
  },
);
