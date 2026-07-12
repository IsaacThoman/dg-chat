import { expect, test } from "@playwright/test";
import { bootstrap, login } from "./helpers.ts";

test("admin previews and confirms a retention scrub without exposing payload bodies", async ({
  page,
  request,
}, testInfo) => {
  await bootstrap(request);
  await login(page);
  const policy = {
    version: 1,
    captureEnabled: false,
    requestBodyDays: 7,
    responseBodyDays: 7,
    updatedAt: "2026-07-11T00:00:00.000Z",
    updatedBy: "Admin",
  };
  const run = {
    id: "00000000-0000-4000-8000-000000000071",
    idempotencyKey: "retention-e2e",
    status: "completed",
    policy: { ...policy, version: 2, captureEnabled: true },
    requestCutoffAt: "2026-07-04T00:00:00.000Z",
    responseCutoffAt: "2026-07-04T00:00:00.000Z",
    capturesScrubbed: 3,
    requestBodiesScrubbed: 2,
    responseBodiesScrubbed: 3,
    bytesScrubbed: 500,
    createdAt: "2026-07-11T00:01:00.000Z",
    startedAt: "2026-07-11T00:01:01.000Z",
    completedAt: "2026-07-11T00:01:02.000Z",
    error: null,
  };
  await page.route("**/api/admin/retention/**", (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/policy") && method === "GET") {
      return route.fulfill({ json: policy });
    }
    if (url.pathname.endsWith("/policy") && method === "PUT") {
      return route.fulfill({ json: { ...policy, ...route.request().postDataJSON(), version: 2 } });
    }
    if (url.pathname.endsWith("/previews")) {
      expect(route.request().postDataJSON()).toEqual({ expectedPolicyVersion: 2 });
      return route.fulfill({
        json: {
          policyVersion: 2,
          requestCutoffAt: "2026-07-04T00:00:00.000Z",
          responseCutoffAt: "2026-07-04T00:00:00.000Z",
          captures: 3,
          requestBodies: 2,
          responseBodies: 3,
          requestBytes: 200,
          responseBytes: 300,
        },
      });
    }
    if (url.pathname.endsWith("/scrub-runs") && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body.expectedPolicyVersion).toBe(2);
      expect(body.requestCutoffAt).toBe("2026-07-04T00:00:00.000Z");
      expect(body.responseCutoffAt).toBe("2026-07-04T00:00:00.000Z");
      expect(String(body.idempotencyKey)).toHaveLength(36);
      return route.fulfill({ json: run, status: 202 });
    }
    if (url.pathname.endsWith(`/scrub-runs/${run.id}`)) return route.fulfill({ json: run });
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto("/admin/retention");
  await expect(page).toHaveTitle("Retention · DG Chat Admin");
  await expect(page.getByText("Accounting history is always preserved")).toBeVisible();
  if (testInfo.project.name.includes("mobile")) {
    await expect(page.getByRole("combobox", { name: "Admin section" })).toHaveValue("retention");
  } else {
    await expect(page.getByRole("link", { name: "Retention", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
  await page.getByRole("checkbox", { name: /Capture new diagnostic/i }).check();
  await page.getByRole("button", { name: "Review policy change" }).click();
  const policyDialog = page.getByRole("dialog", { name: "Review retention policy" });
  await expect(policyDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await policyDialog.getByRole("button", { name: "Save policy" }).click();
  await page.getByRole("button", { name: "Preview scrub" }).click();
  await expect(page.getByText("3", { exact: true }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("secret payload content");
  await page.getByRole("button", { name: "Run scrub now" }).click();
  const scrubDialog = page.getByRole("dialog", {
    name: "Permanently scrub diagnostic bodies?",
  });
  await expect(scrubDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await scrubDialog.getByRole("checkbox").check();
  await scrubDialog.getByRole("button", { name: "Queue scrub" }).click();
  await expect(page).toHaveURL(new RegExp(`run=${run.id}`));
  await expect(page.getByRole("heading", { name: "Scrub run status" })).toBeVisible();
  await expect(page.getByText("5 bodies", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run scrub now" })).toHaveCount(0);
});

test("stale scrub recovery remains operable without horizontal overflow at 320px", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await page.setViewportSize({ width: 320, height: 800 });
  let policy = {
    version: 4,
    captureEnabled: false,
    requestBodyDays: 7,
    responseBodyDays: 14,
    updatedAt: "2026-07-11T00:00:00.000Z",
    updatedBy: null,
  };
  const preview = {
    policyVersion: 5,
    requestCutoffAt: "2026-07-04T00:00:00.000Z",
    responseCutoffAt: "2026-06-27T00:00:00.000Z",
    captures: 2,
    requestBodies: 2,
    responseBodies: 1,
    requestBytes: 200,
    responseBytes: 300,
  };
  let previewRequests = 0;
  let policyRequests = 0;
  await page.route("**/api/admin/retention/**", (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/policy")) {
      policyRequests++;
      return route.fulfill({ json: policy });
    }
    if (url.pathname.endsWith("/previews")) {
      previewRequests++;
      return route.fulfill({ json: preview });
    }
    if (url.pathname.endsWith("/scrub-runs") && method === "POST") {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "version_conflict", message: "The scrub preview is stale." },
        }),
      });
    }
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto("/admin/retention");
  await expect(page.getByLabel("Request body retention")).toBeEnabled();
  await expect(page.getByLabel("Response body retention")).toBeEnabled();
  await page.getByLabel("Request body retention").selectOption("1");
  policy = { ...policy, version: 5, updatedAt: "2026-07-11T00:01:00.000Z" };
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => policyRequests).toBeGreaterThan(1);
  await expect(page.getByRole("alert")).toContainText("changed in another session");
  await expect(page.getByLabel("Request body retention")).toHaveValue("1");
  await expect(page.getByRole("button", { name: "Preview scrub" })).toBeDisabled();
  await page.getByRole("button", { name: "Use latest policy" }).click();
  await expect(page.getByLabel("Request body retention")).toHaveValue("7");
  await page.getByRole("button", { name: "Preview scrub" }).click();
  await page.getByRole("button", { name: "Run scrub now" }).click();
  const dialog = page.getByRole("dialog", { name: "Permanently scrub diagnostic bodies?" });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Queue scrub" }).click();
  await expect(dialog.getByRole("alert")).toContainText("stale");
  const actions = dialog.locator(".ops-dialog-actions");
  await expect(actions.getByRole("button", { name: "Refresh preview" })).toBeVisible();
  const widths = await actions.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().width)
  );
  expect(widths.every((width) => width >= 240)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBeTruthy();
  await actions.getByRole("button", { name: "Refresh preview" }).click();
  await expect(dialog).toHaveCount(0);
  expect(previewRequests).toBe(2);
  await expect(page.locator(".ops-announcer").first()).toContainText(
    "stale preview was replaced",
  );
});
