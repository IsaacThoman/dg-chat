/// <reference lib="dom" />

import { expect, test } from "@playwright/test";

const capability = "R".repeat(43);
const createdAt = "2026-07-15T12:00:00.000Z";

const source = [
  "# Rich output",
  "",
  "<script>window.__richOutputAttacked = true</script>",
  "[unsafe link](javascript:window.__richOutputAttacked=true)",
  "![remote tracker](https:example.com/rich-output-tracker.png)",
  "![second tracker](https:example.com/second-rich-output-tracker.png)",
  "",
  "The integral is $$\\int_0^1 x^2 dx = \\frac{1}{3}$$.",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Safe input] --> B{Decision}",
  "  B -->|Yes| C[Rendered output]",
  "```",
  "",
  "```mermaid",
  "this is deliberately not valid Mermaid syntax %%%",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  "  D[Third preview] --> E[Serialized]",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  "  F[Fourth source] --> G[Limited]",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  "  H[Fifth source] --> I[Preserved]",
  "```",
  "",
  "```ts filename=answer.ts version=1",
  "export const answer = 41;",
  "```",
  "",
  "```ts filename=answer.ts version=2",
  "export const answer = 42;",
  "```",
].join("\n");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __richOutputAttacked?: boolean }).__richOutputAttacked = false;
  });
  await page.route(`**/api/public/shares/${capability}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        share: {
          id: "rich-output-share",
          title: "Rich output accessibility lab",
          conversationVersion: 1,
          identity: { visibility: "anonymous", displayName: null },
          attachmentPolicy: "redact",
          messages: [{
            id: "rich-output-message",
            parentId: null,
            role: "assistant",
            content: source,
            status: "complete",
            attachmentIds: [],
            createdAt,
          }],
          attachments: [],
          createdAt,
          expiresAt: null,
        },
      },
    }));
});

test(
  "renders secure lazy math, diagrams, and keyboard-operable artifacts",
  async ({ page }, testInfo) => {
    test.setTimeout(45_000);
    let remoteTrackerRequests = 0;
    await page.route("https://example.com/**", (route) => {
      remoteTrackerRequests += 1;
      return route.fulfill({ status: 204 });
    });
    const mathFontResponses: Array<{ status: number; url: string }> = [];
    page.on("response", (response) => {
      if (/KaTeX_.+\.(?:woff2?|ttf)(?:\?|$)/.test(response.url())) {
        mathFontResponses.push({ status: response.status(), url: response.url() });
      }
    });
    await page.goto(`/share/${capability}`);
    const markdown = page.locator("[data-rich-markdown]");
    await expect(markdown.getByRole("heading", { name: "Rich output" })).toBeVisible();

    await expect(markdown.locator(".katex")).toBeVisible({ timeout: 20_000 });
    await expect(markdown.locator('[data-mermaid-state="ready"]')).toHaveCount(2, {
      timeout: 20_000,
    });
    await expect(markdown.locator('[data-mermaid-state="error"]')).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(markdown.locator('.mermaid-error[role="alert"]'))
      .toContainText("Diagram preview unavailable");
    await expect(markdown.getByText("this is deliberately not valid Mermaid syntax %%%"))
      .toBeVisible();
    await expect(markdown.locator('[data-mermaid-state="limited"]')).toHaveCount(2);
    await expect(markdown.getByText("H[Fifth source] --> I[Preserved]")).toBeVisible();
    expect(remoteTrackerRequests).toBe(0);
    const loadRemoteImage = markdown.getByRole("button", {
      name: "Load image: remote tracker",
      exact: true,
    });
    await expect(loadRemoteImage).toBeVisible();
    await expect(markdown.getByRole("button", {
      name: "Load image: second tracker",
      exact: true,
    })).toBeVisible();
    await loadRemoteImage.click();
    await expect.poll(() => remoteTrackerRequests).toBe(1);
    expect(mathFontResponses.length).toBeGreaterThan(0);
    expect(mathFontResponses.filter((response) => response.status >= 400)).toEqual([]);

    expect(
      await page.evaluate(() =>
        (window as typeof window & { __richOutputAttacked?: boolean }).__richOutputAttacked
      ),
    ).toBe(false);
    await expect(markdown.locator("script, foreignObject, iframe, object, embed")).toHaveCount(0);
    await expect(markdown.locator('[href^="javascript:"]')).toHaveCount(0);
    await expect(markdown.locator("[onload], [onerror], [onclick]")).toHaveCount(0);
    await expect(markdown.locator('.mermaid-canvas svg[role="img"]')).toHaveCount(2);
    await expect(markdown.locator('.mermaid-canvas svg[aria-label="Mermaid diagram"]'))
      .toHaveCount(2);

    const artifacts = markdown.locator(".rich-artifact");
    await expect(artifacts).toHaveCount(2);
    const first = artifacts.first();
    await expect(first.getByText("1 of 2")).toBeVisible();
    await first.getByRole("button", { name: "Preview" }).focus();
    await page.keyboard.press("Tab");
    await expect(first.getByRole("button", { name: "Source" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(first.getByRole("button", { name: "Source" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(first.getByLabel("Source of answer.ts")).toContainText("answer = 41");

    const downloadPromise = page.waitForEvent("download");
    await first.getByRole("button", { name: "Export" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("answer.ts");

    await artifacts.nth(1).getByRole("button", { name: "Previous version" }).click();
    await expect(first).toBeFocused();

    const viewport = page.viewportSize();
    if (testInfo.project.name === "mobile-chromium" && viewport) {
      expect(
        await first.evaluate((element) => element.getBoundingClientRect().right <= innerWidth + 1),
      )
        .toBe(true);
      expect(await markdown.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
        .toBe(true);
      for (const button of await markdown.getByRole("button").all()) {
        const box = await button.boundingBox();
        if (box) expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
  },
);
