import { expect, test } from "@playwright/test";
import { env } from "./env.ts";
import { bootstrap, createChat, login } from "./helpers.ts";

test(
  "primary chat controls remain usable at the project viewport",
  async ({ page, request }, testInfo) => {
    await bootstrap(request);
    await login(page);
    await createChat(page);
    const composer = page.getByRole("textbox", { name: /message/i });
    await expect(composer).toBeVisible();
    await composer.focus();
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "New chat ⌘ K", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach files" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Open web search" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Tools (not available yet)" })).toBeDisabled();
    await expect(page.getByRole("button", {
      name: /^(Start voice input|Voice input unavailable:)/,
    })).toBeVisible();

    if (testInfo.project.name.includes("mobile")) {
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
    }
  },
);

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
  await page.getByLabel(/Base URL/).fill("https://provider.invalid/v1");
  await page.getByLabel(/API credential/).fill(`e2e-secret-${suffix}`);
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
    const api = env("E2E_API_URL") ?? "http://localhost:8000";
    const csv = await page.context().request.get(new URL(href!, api).toString());
    expect(csv.ok()).toBeTruthy();
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(await csv.text()).toContain("identity.bootstrap_admin");
  },
);
