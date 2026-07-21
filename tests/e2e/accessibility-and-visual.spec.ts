/// <reference lib="dom" />

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(
    results.violations,
    JSON.stringify(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        description: violation.description,
        targets: violation.nodes.map((node) => node.target),
      })),
      null,
      2,
    ),
  ).toEqual([]);
}

test("login and primary chat surfaces have no automated WCAG A/AA violations", async ({ page, request }) => {
  await bootstrap(request);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await login(page);
  await createChat(page);
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test("login shell visual contract remains stable", async ({ page, request }) => {
  await bootstrap(request);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  await expect(page).toHaveScreenshot("login-shell.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    maxDiffPixelRatio: 0.005,
  });
});
