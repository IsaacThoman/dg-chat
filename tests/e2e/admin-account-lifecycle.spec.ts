import { expect, type Locator, test } from "@playwright/test";
import { formatStartingCreditMicros } from "../../apps/web/src/adminLifecycleUi.ts";
import { adminEmail, bootstrap, login, uniqueUser } from "./helpers.ts";
import { apiURL } from "./helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("administrators approve, search, and manage an immutable account lifecycle", async ({
  browser,
  page,
  request,
}, testInfo) => {
  const mobile = testInfo.project.name.includes("mobile");
  const assertMobileLayout = async (...targets: Locator[]) => {
    if (!mobile) return;
    const overflow = await page.evaluate<{ body: number; root: number }>(`({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    expect(overflow.body).toBeLessThanOrEqual(1);
    expect(overflow.root).toBeLessThanOrEqual(1);
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  };

  await bootstrap(request);
  const applicant = uniqueUser("admin-lifecycle");

  await page.goto("/login");
  await page.getByRole("button", { name: "Request access" }).click();
  await page.getByLabel(/name/i).fill(applicant.name);
  await page.getByLabel(/email/i).fill(applicant.email);
  await page.getByLabel(/^password/i).fill(applicant.password);
  await page.getByRole("button", { name: "Request access" }).click();
  // Account creation performs password hashing plus several transactionally fenced identity
  // writes. Keep this assertion bounded, but allow a busy self-hosted PostgreSQL instance to
  // finish safely instead of encouraging the client to retry an already-committed signup.
  await expect(page).toHaveURL(/\/pending$/u, { timeout: 20_000 });

  await page.context().clearCookies();
  await login(page);
  const settingsResponse = await page.request.get(`${apiURL}/api/admin/settings`);
  expect(settingsResponse.ok()).toBeTruthy();
  const defaultApprovalCreditMicros = (await settingsResponse.json() as {
    defaultApprovalCreditMicros: number;
  }).defaultApprovalCreditMicros;
  const defaultApprovalCredit = formatStartingCreditMicros(defaultApprovalCreditMicros);
  const compactApplicants = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/admin/users" &&
      url.searchParams.get("approvalStatus") === "pending" &&
      url.searchParams.get("limit") === "5";
  });
  await page.goto("/admin/overview");
  await compactApplicants;
  const fullApplicants = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/admin/users" &&
      url.searchParams.get("approvalStatus") === "pending" &&
      url.searchParams.get("limit") === "25";
  });
  await page.getByRole("button", { name: "View all" }).first().click();
  await fullApplicants;
  await expect(page.getByRole("heading", { name: "Applicants", exact: true })).toBeVisible();
  const applicantRow = page.locator(".applicant-row").filter({ hasText: applicant.email });
  await applicantRow.getByRole("button", { name: "Approve", exact: true }).click();
  const approvalDialog = page.getByRole("dialog", { name: `Approve ${applicant.name}?` });
  await expect(approvalDialog).toBeVisible();
  const startingCredit = approvalDialog.getByLabel("Starting credit override (USD, optional)");
  await expect(startingCredit).toHaveValue("");
  await expect(startingCredit).toHaveAttribute(
    "placeholder",
    `Server default: $${defaultApprovalCredit}`,
  );
  await approvalDialog.getByLabel("Internal note (optional)").fill("Approved in E2E review");
  const approvalRequest = page.waitForRequest((request) =>
    request.method() === "PATCH" && new URL(request.url()).pathname.endsWith("/approval")
  );
  await approvalDialog.getByRole("button", { name: "Approve applicant" }).click();
  const submittedApproval = await approvalRequest;
  expect(submittedApproval.postDataJSON()).not.toHaveProperty("startingCreditMicros");
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
    balanceMicros: defaultApprovalCreditMicros,
  });

  // Seed real target security resources through the owner surface. Signing in again also creates
  // a full workspace session beside the limited signup/status session.
  await page.context().clearCookies();
  await login(page, applicant.email, applicant.password);
  const tokenResponse = await page.request.post(`${apiURL}/api/tokens`, {
    // APIRequestContext reuses the browser cookies but does not synthesize a browser Origin.
    // Supply the actual same-origin page value so this setup call exercises, rather than bypasses,
    // the API's browser-CSRF boundary.
    headers: { origin: new URL(page.url()).origin },
    data: {
      name: "Pre-promotion automation",
      scopes: ["chat:write"],
      rpmLimit: 60,
      burstLimit: 10,
    },
  });
  expect(tokenResponse.status()).toBe(201);

  await page.context().clearCookies();
  await login(page);

  await page.goto("/admin/users");
  const filters = page.getByRole("search", { name: "Filter users" });
  await filters.getByRole("textbox", { name: "Search users" }).fill(applicant.email);
  await filters.getByRole("button", { name: "Apply" }).click();
  const userRow = page.locator(".admin-user-table .applicant-row").filter({
    hasText: applicant.email,
  });
  await expect(userRow).toBeVisible();

  await userRow.getByRole("button", { name: `Manage ${applicant.name}` }).click();
  await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]+\/account\?.*userSearch=/u);
  const detailHeading = page.getByRole("heading", { name: applicant.name, exact: true });
  await expect(detailHeading).toBeVisible();
  await expect(detailHeading).toBeFocused();
  await expect(page).toHaveTitle(`${applicant.name} · Users · DG Chat Admin`);
  const tabs = page.getByRole("tablist", { name: "User administration" });
  await expect(tabs.getByRole("tab", { name: "Account" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("button", { name: "Promote to admin" }).click();
  const promoteDialog = page.getByRole("dialog", { name: `Promote ${applicant.name}?` });
  await promoteDialog.getByLabel("Reason").fill("Add incident coverage");
  await promoteDialog.getByRole("button", { name: "Confirm promote" }).click();
  await expect(promoteDialog).toBeHidden();
  await expect(page.getByLabel("Account status")).toContainText("admin");

  // Promotion is an authority change, so every credential issued under the user's previous
  // authority epoch must already be revoked. Sign in through an isolated browser context and
  // create a fresh credential under the new epoch so this journey can independently exercise
  // both automatic lifecycle invalidation and an administrator-initiated family revocation.
  const ownerContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const ownerPage = await ownerContext.newPage();
    await login(ownerPage, applicant.email, applicant.password);
    const postPromotionToken = await ownerPage.request.post(`${apiURL}/api/tokens`, {
      headers: { origin: new URL(ownerPage.url()).origin },
      data: {
        name: "Lifecycle automation",
        scopes: ["chat:write"],
        rpmLimit: 60,
        burstLimit: 10,
      },
    });
    expect(postPromotionToken.status()).toBe(201);
  } finally {
    await ownerContext.close();
  }

  // Modal teardown restores focus to its opener. Wait for that accessibility contract before
  // deliberately moving into the tab strip, otherwise the cleanup can reclaim focus mid-keypress.
  await expect(page.getByRole("button", { name: "Demote to user" })).toBeFocused();

  // The ARIA tab strip is URL-backed and supports the standard arrow-key model.
  const accountTab = tabs.getByRole("tab", { name: "Account" });
  await accountTab.focus();
  await expect(accountTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/\/sessions(?:\?|$)/u);
  const sessionsTab = tabs.getByRole("tab", { name: "Sessions" });
  await expect(sessionsTab).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(sessionsTab).toBeFocused();
  await expect(page.getByRole("heading", { name: "Signed-in sessions" })).toBeVisible();
  const revokeSession = page.getByRole("button", { name: "Revoke", exact: true }).first();
  await expect(revokeSession).toBeEnabled();
  await assertMobileLayout(revokeSession);
  await revokeSession.click();
  const sessionDialog = page.getByRole("dialog", { name: "Revoke session?" });
  await sessionDialog.getByLabel("Reason").fill("Lost browser during E2E drill");
  await sessionDialog.getByRole("button", { name: "Revoke session" }).click();
  await expect(sessionDialog).toBeHidden();

  await tabs.getByRole("tab", { name: "API tokens" }).click();
  await expect(page).toHaveURL(/\/tokens(?:\?|$)/u);
  const automaticallyRevokedToken = page.locator(".admin-user-token-card").filter({
    hasText: "Pre-promotion automation",
  });
  await expect(automaticallyRevokedToken).toContainText("revoked");
  await expect(
    automaticallyRevokedToken.getByRole("button", { name: "Revoke token family" }),
  ).toHaveCount(0);
  const tokenCard = page.locator(".admin-user-token-card").filter({
    hasText: "Lifecycle automation",
  });
  await expect(tokenCard).toContainText("chat:write");
  const revokeToken = tokenCard.getByRole("button", { name: "Revoke token family" });
  await assertMobileLayout(revokeToken);
  await revokeToken.click();
  const tokenDialog = page.getByRole("dialog", { name: "Revoke Lifecycle automation?" });
  await tokenDialog.getByLabel("Reason").fill("Credential exposure exercise");
  await tokenDialog.getByRole("button", { name: "Revoke token family" }).click();
  await expect(tokenDialog).toBeHidden();
  await expect(tokenCard).toContainText("revoked");

  await tabs.getByRole("tab", { name: "Billing" }).click();
  await expect(page).toHaveURL(/\/billing(?:\?|$)/u);
  await expect(page.getByText(`$${defaultApprovalCredit}`, { exact: true }).first()).toBeVisible();
  const adjustBalance = page.getByRole("button", { name: "Adjust balance" });
  await assertMobileLayout(adjustBalance);
  await adjustBalance.click();
  const adjustmentDialog = page.getByRole("dialog", { name: "Adjust balance" });
  await adjustmentDialog.getByLabel("Amount (USD)").fill("1.234567");
  await adjustmentDialog.getByLabel("Reason").fill("Exact E2E support credit");
  const adjustedBalance = formatStartingCreditMicros(defaultApprovalCreditMicros + 1_234_567);
  await expect(adjustmentDialog.getByText(`$${adjustedBalance}`, { exact: true })).toBeVisible();
  const addCredit = adjustmentDialog.getByRole("button", { name: "Add credit" });
  await assertMobileLayout(addCredit);
  await addCredit.click();
  await expect(adjustmentDialog).toBeHidden();
  await expect(page.getByText(`$${adjustedBalance}`, { exact: true }).first()).toBeVisible();
  const adjustmentRow = page.locator(".admin-user-ledger tbody tr").filter({
    hasText: "Exact E2E support credit",
  });
  await expect(adjustmentRow).toContainText("+$1.234567");
  if (mobile) {
    const ledger = page.locator(".admin-user-ledger-wrap");
    const dimensions = await ledger.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
    await assertMobileLayout();
  }

  await tabs.getByRole("tab", { name: "Account" }).click();
  await page.getByRole("button", { name: "Suspend account" }).click();
  const suspendDialog = page.getByRole("dialog", { name: `Suspend ${applicant.name}?` });
  await suspendDialog.getByLabel("Reason").fill("Credential compromise drill");
  await suspendDialog.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(suspendDialog).toBeHidden();
  await expect(page.getByLabel("Account status")).toContainText("suspended");

  if (mobile) {
    await assertMobileLayout();
    for (const tab of await tabs.getByRole("tab").all()) {
      const box = await tab.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  }

  // The acting administrator's exact server-resolved session is visibly protected.
  const adminLookup = await page.request.get(
    `${apiURL}/api/admin/users?search=${encodeURIComponent(adminEmail)}&limit=1`,
  );
  expect(adminLookup.ok()).toBeTruthy();
  const adminId = (await adminLookup.json() as { data: Array<{ id: string }> }).data[0].id;
  await page.goto(`/admin/users/${adminId}/sessions`);
  const currentSession = page.locator(".admin-user-resource-list li").filter({
    hasText: "Current administrator session",
  });
  await expect(currentSession).toBeVisible();
  await expect(currentSession.getByRole("button", { name: "Revoke" })).toBeDisabled();
  await expect(currentSession).toContainText("protected");
});
