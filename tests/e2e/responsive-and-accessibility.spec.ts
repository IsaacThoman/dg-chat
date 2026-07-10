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

    if (testInfo.project.name.includes("mobile")) {
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
    }
  },
);

test("health and readiness distinguish process and dependencies", async ({ request }) => {
  const api = env("E2E_API_URL") ?? "http://localhost:8000";
  const [health, ready] = await Promise.all([
    request.get(`${api}/health`),
    request.get(`${api}/ready`),
  ]);
  expect(health.ok()).toBeTruthy();
  expect(ready.ok()).toBeTruthy();
});
