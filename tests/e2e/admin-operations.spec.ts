import { expect, test } from "@playwright/test";
import { bootstrap, login } from "./helpers.ts";

const failedJob = {
  id: "00000000-0000-4000-8000-000000000091",
  type: "attachment.ingest",
  status: "failed",
  attempts: 3,
  availableAt: "2026-07-11T10:00:00.000Z",
  lockedAt: "2026-07-11T10:00:01.000Z",
  createdAt: "2026-07-11T10:00:00.000Z",
  completedAt: "2026-07-11T10:00:02.000Z",
  lastError: "Extraction deadline exceeded",
};

test("admin analytics and jobs are bookmarkable, accessible, and operable", async ({
  page,
  request,
}, testInfo) => {
  await bootstrap(request);
  await login(page);

  await page.goto("/admin/usage?from=not-a-date&to=2026-02-30");
  await expect(page.getByRole("heading", { name: "Usage analytics", exact: true })).toBeVisible();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(/\d{4}-\d{2}-\d{2}/u);

  await page.goto("/admin/usage?from=2026-07-01&to=2026-07-11&bucket=day");
  await expect(page.getByRole("heading", { name: "Usage analytics", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Usage analytics · DG Chat Admin");
  if (testInfo.project.name.includes("mobile")) {
    await expect(page.getByRole("combobox", { name: "Admin section" })).toHaveValue("usage");
  } else {
    await expect(page.getByRole("link", { name: "Usage analytics", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
  await expect(page.getByRole("form", { name: "Usage filters" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill("2026-01-01");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("limited to 90 days");
  await expect(page.getByLabel("To", { exact: true })).toBeFocused();
  await page.getByLabel("From", { exact: true }).fill("2026-06-01");
  await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page).toHaveURL(/from=2026-06-01/u);
  await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeEnabled();
  await page.getByLabel("From", { exact: true }).fill("2026-05-01");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page).toHaveURL(/from=2026-05-01/u);
  await page.goBack();
  await expect(page).toHaveURL(/from=2026-06-01/u);
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-06-01");
  await page.goForward();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-05-01");

  if (testInfo.project.name.includes("mobile")) {
    const overflow = await page.evaluate<{ body: number; root: number }>(`({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    expect(overflow.body).toBeLessThanOrEqual(1);
    expect(overflow.root).toBeLessThanOrEqual(1);
    await page.getByRole("combobox", { name: "Admin section" }).selectOption("jobs");
  } else {
    await page.getByRole("link", { name: "Background jobs", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/admin\/jobs/u);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/usage\?from=2026-05-01/u);
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-05-01");

  await page.route("**/api/admin/jobs?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: retried ? [] : [failedJob],
        nextCursor: null,
        previousCursor: null,
        hasPrevious: false,
      }),
    });
  });
  let retried = false;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  await page.route(`**/api/admin/jobs/${failedJob.id}/retry`, async (route) => {
    await retryGate;
    retried = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job: { ...failedJob, status: "queued", attempts: 0, lastError: null },
        priorAttempts: 3,
      }),
    });
  });
  await page.goto("/admin/jobs?status=failed&type=attachment.ingest");
  await expect(page.getByRole("heading", { name: "Background jobs", exact: true })).toBeVisible();
  const jobs = page.getByRole("list", { name: "Background jobs" });
  await expect(jobs).toContainText("Extraction deadline exceeded");
  await expect(jobs).not.toContainText("payload");
  await page.getByRole("button", { name: "Retry attachment.ingest", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Retry attachment.ingest", exact: true }))
    .toBeFocused();
  await page.getByRole("button", { name: "Retry attachment.ingest", exact: true }).click();
  await page.getByRole("button", { name: "Retry job", exact: true }).click();
  const retryDialog = page.getByRole("dialog", { name: "Retry failed job?" });
  await expect(retryDialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await expect(retryDialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect(retryDialog.getByRole("button", { name: "Retrying…", exact: true }))
    .toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  releaseRetry();
  const outcome = page.locator(".ops-announcer");
  await expect(outcome).toContainText(
    "queued with a fresh retry budget after 3 attempts",
  );
  await expect(outcome).toBeFocused();
  await expect(jobs).toBeHidden();
});

test("job cursors preserve filters across bookmarks and browser history", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  const jobs = [1, 2, 3].map((ordinal) => ({
    ...failedJob,
    id: `00000000-0000-4000-8000-00000000009${ordinal}`,
    type: `page-${ordinal}`,
  }));
  await page.route("**/api/admin/jobs?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const ordinal = cursor === "three" ? 3 : cursor === "two" ? 2 : 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [jobs[ordinal - 1]],
        nextCursor: ordinal < 3 ? (ordinal === 1 ? "two" : "three") : null,
        previousCursor: ordinal === 3 ? "two" : null,
        hasPrevious: ordinal > 1,
      }),
    });
  });

  await page.goto("/admin/jobs?status=failed&cursor=two");
  await expect(page.getByText("page-2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page).toHaveURL(/status=failed/u);
  await expect(page).not.toHaveURL(/cursor=/u);
  await expect(page.getByText("page-1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/cursor=two/u);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/cursor=three/u);
  await expect(page.getByText("page-3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page).toHaveURL(/cursor=two/u);
  await page.goBack();
  await expect(page).toHaveURL(/cursor=three/u);
  await expect(page.getByText("page-3", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/cursor=two/u);
  await expect(page.getByText("page-2", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Job filters" }).locator('select[name="status"]'),
  ).toHaveValue("failed");
});
