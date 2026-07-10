import { expect, test } from "@playwright/test";
import { env } from "./env.ts";
import { bootstrap, login } from "./helpers.ts";

test(
  "primary chat controls remain usable at the project viewport",
  async ({ page, request }, testInfo) => {
    await bootstrap(request);
    await login(page);
    const composer = page.getByRole("textbox", { name: /message/i });
    await expect(composer).toBeVisible();
    await composer.focus();
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "New chat ⌘ K", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach files (not available yet)" }))
      .toBeDisabled();
    await expect(page.getByRole("button", { name: "Web search (not available yet)" }))
      .toBeDisabled();
    await expect(page.getByRole("button", { name: "Tools (not available yet)" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Voice input (not available yet)" }))
      .toBeDisabled();

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
    ["usage", "Usage analytics", "Usage analytics"],
    ["jobs", "Background jobs", "Background jobs"],
    ["audit", "Audit log", "Audit log"],
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
    await page.getByRole("button", { name: label, exact: true }).click();
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
