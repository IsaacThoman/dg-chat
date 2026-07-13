import { expect, test } from "@playwright/test";
import { bootstrap, login, uniqueUser } from "./helpers.ts";
import { apiURL } from "./helpers.ts";

test("administrators approve, search, and manage an immutable account lifecycle", async ({
  page,
  request,
}, testInfo) => {
  await bootstrap(request);
  const applicant = uniqueUser("admin-lifecycle");

  await page.goto("/login");
  await page.getByRole("button", { name: "Request access" }).click();
  await page.getByLabel(/name/i).fill(applicant.name);
  await page.getByLabel(/email/i).fill(applicant.email);
  await page.getByLabel(/^password/i).fill(applicant.password);
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page).toHaveURL(/\/pending$/u);

  await page.context().clearCookies();
  await login(page);
  await page.goto("/admin/applicants");
  await expect(page.getByRole("heading", { name: "Applicants", exact: true })).toBeVisible();
  const applicantRow = page.locator(".applicant-row").filter({ hasText: applicant.email });
  await applicantRow.getByRole("button", { name: "Approve", exact: true }).click();
  const approvalDialog = page.getByRole("dialog", { name: `Approve ${applicant.name}?` });
  await expect(approvalDialog).toBeVisible();
  await approvalDialog.getByLabel("Starting credit (USD)").fill("7.25");
  await approvalDialog.getByLabel("Internal note (optional)").fill("Approved in E2E review");
  await approvalDialog.getByRole("button", { name: "Approve applicant" }).click();
  await expect(approvalDialog).toBeHidden();

  const approvedResponse = await page.request.get(
    `${apiURL}/api/admin/users?search=${encodeURIComponent(applicant.email)}&limit=1`,
  );
  expect(approvedResponse.ok()).toBeTruthy();
  const approvedPage = await approvedResponse.json() as {
    data: Array<{ approvalStatus: string; balanceMicros: number }>;
  };
  expect(approvedPage.data[0]).toMatchObject({
    approvalStatus: "approved",
    balanceMicros: 7_250_000,
  });

  await page.goto("/admin/users");
  const filters = page.getByRole("search", { name: "Filter users" });
  await filters.getByRole("textbox", { name: "Search users" }).fill(applicant.email);
  await filters.getByRole("button", { name: "Apply" }).click();
  const userRow = page.locator(".admin-user-table .applicant-row").filter({
    hasText: applicant.email,
  });
  await expect(userRow).toBeVisible();

  await userRow.getByRole("button", { name: `Manage ${applicant.name}` }).click();
  await page.getByRole("button", { name: "Promote to admin" }).click();
  const promoteDialog = page.getByRole("dialog", { name: `Promote ${applicant.name}?` });
  await promoteDialog.getByLabel("Reason").fill("Add incident coverage");
  await promoteDialog.getByRole("button", { name: "Confirm promote" }).click();
  await expect(promoteDialog).toBeHidden();
  await expect(userRow).toContainText("admin");

  await userRow.getByRole("button", { name: `Manage ${applicant.name}` }).click();
  await page.getByRole("button", { name: "Suspend account" }).click();
  const suspendDialog = page.getByRole("dialog", { name: `Suspend ${applicant.name}?` });
  await suspendDialog.getByLabel("Reason").fill("Credential compromise drill");
  await suspendDialog.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(suspendDialog).toBeHidden();
  await expect(userRow).toContainText("suspended");

  if (testInfo.project.name.includes("mobile")) {
    const overflow = await page.evaluate<{ body: number; root: number }>(`({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    expect(overflow.body).toBeLessThanOrEqual(1);
    expect(overflow.root).toBeLessThanOrEqual(1);
    const manageBox = await userRow.getByRole("button", { name: `Manage ${applicant.name}` })
      .boundingBox();
    expect(manageBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});
