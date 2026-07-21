import { expect, test } from "@playwright/test";
import { adminEmail, adminPassword, apiURL, bootstrap, login } from "./helpers.ts";
import { lightweightManagedStack, strictDurableCapabilities } from "./env.ts";

// Compose intentionally exposes this privileged test-only control surface on IPv4 loopback only.
// Node/Playwright may prefer ::1 for `localhost` and does not consistently retry IPv4 after a
// refused connection, so use the address that the port binding actually guarantees. Browser OIDC
// navigation still exercises the provider's configured public `localhost` issuer below.
const mockControlUrl = "http://127.0.0.1:4020";
const mockControlHeaders = { authorization: "Bearer ci-mock-oidc-control-token" };

async function signInWithOidc(page: import("@playwright/test").Page, personaName: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: /continue with organization sso/i }).click();
  await expect(page).toHaveURL(/^http:\/\/localhost:4020\/authorize/u);
  const authorizationUrl = new URL(page.url());
  expect(authorizationUrl.searchParams.get("nonce")).toBeTruthy();
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  await page.getByRole("button", { name: personaName }).click();
}

test("OIDC creates a pending applicant and approval enables a fresh SSO session", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  test.skip(lightweightManagedStack, "requires the durable OIDC-enabled stack");
  const viewport = testInfo.project.name === "mobile-chromium" ? "mobile" : "desktop";
  const retry = Math.min(testInfo.retry, 2);
  const runId = crypto.randomUUID().replaceAll("-", "");
  const persona = `new_verified_${viewport}_${retry}`;
  const personaName = `OIDC ${viewport === "mobile" ? "Mobile" : "Desktop"} ${runId.slice(0, 8)}`;
  const oidcEmail = `oidc-${viewport}-${runId}@e2e.invalid`;
  const setupStatusResponse = await request.get(`${apiURL}/api/setup/status`);
  expect(setupStatusResponse.ok()).toBeTruthy();
  const setupStatus = await setupStatusResponse.json() as { oidcEnabled?: boolean };
  if (setupStatus.oidcEnabled !== true) {
    const reason =
      "requires the OIDC-enabled stack; add docker-compose.oidc.yml to the Compose invocation";
    if (strictDurableCapabilities()) {
      throw new Error(`Full-stack E2E configuration error: ${reason}`);
    }
    test.skip(true, reason);
  }
  await bootstrap(request);
  const reset = await request.post(`${mockControlUrl}/control/reset`, {
    headers: mockControlHeaders,
  });
  expect(reset.ok()).toBeTruthy();
  const configuredPersona = await request.post(`${mockControlUrl}/control/persona`, {
    headers: mockControlHeaders,
    data: {
      persona,
      sub: `mock-sub-${viewport}-${runId}`,
      email: oidcEmail,
      name: personaName,
    },
  });
  expect(configuredPersona.ok()).toBeTruthy();

  await signInWithOidc(page, personaName);
  await expect(page).toHaveURL(/\/pending$/u);

  await page.context().clearCookies();
  await login(page, adminEmail, adminPassword);
  const usersResponse = await page.request.get(
    `${apiURL}/api/admin/users?search=${encodeURIComponent(oidcEmail)}&limit=1`,
  );
  expect(usersResponse.ok()).toBeTruthy();
  const users = await usersResponse.json() as {
    data: Array<{ id: string; email: string; version: number }>;
  };
  const applicant = users.data.find((user) => user.email === oidcEmail);
  expect(applicant).toBeTruthy();
  const approval = await page.request.patch(
    `${apiURL}/api/admin/users/${applicant!.id}/approval`,
    {
      headers: { origin: new URL(page.url()).origin },
      data: { status: "approved", expectedVersion: applicant!.version },
    },
  );
  expect(approval.ok()).toBeTruthy();
  const approved = await approval.json() as { version: number };
  const promotion = await page.request.patch(
    `${apiURL}/api/admin/users/${applicant!.id}/role`,
    {
      headers: { origin: new URL(page.url()).origin },
      data: {
        role: "admin",
        expectedVersion: approved.version,
        reason: "Validate OIDC administrator reauthentication routing",
      },
    },
  );
  expect(promotion.ok()).toBeTruthy();

  await page.context().clearCookies();
  await signInWithOidc(page, personaName);

  await expect(page).toHaveURL(/\/$/u);
  await page.getByRole("main").getByRole("button", { name: /^new chat$/i }).click();
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();

  // Reauthentication stores only a validated same-origin detail route. Preserve that browser
  // state across the external provider round trip and consume it exactly once after /pending is
  // upgraded to a full approved session.
  const returnSearch = "oidc-reauth";
  await page.goto(`/admin/users/${applicant!.id}/billing?userSearch=${returnSearch}`);
  await expect(page.getByRole("heading", { name: personaName, exact: true })).toBeVisible();
  await page.route(`**/api/admin/users/${applicant!.id}/balance-adjustments`, async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "recent_authentication_required",
          message: "A recent administrator sign-in is required",
        },
      }),
    });
  }, { times: 1 });
  await page.getByRole("button", { name: "Adjust balance" }).click();
  const adjustmentDialog = page.getByRole("dialog", { name: "Adjust balance" });
  await adjustmentDialog.getByLabel("Amount (USD)").fill("0.01");
  await adjustmentDialog.getByLabel("Reason").fill("Exercise OIDC reauthentication routing");
  await adjustmentDialog.getByRole("button", { name: "Add credit" }).click();
  await expect(adjustmentDialog.getByRole("alert")).toContainText("fresh administrator sign-in");
  await adjustmentDialog.getByRole("button", { name: "Sign in again" }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await signInWithOidc(page, personaName);
  await expect(page).toHaveURL((url) =>
    url.pathname === `/admin/users/${applicant!.id}/billing` &&
    url.searchParams.get("userSearch") === returnSearch
  );

  await page.context().clearCookies();
  await signInWithOidc(page, personaName);
  await expect(page).toHaveURL((url) => url.pathname === "/" && url.search === "");
  const stateResponse = await request.get(`${mockControlUrl}/control/state`, {
    headers: mockControlHeaders,
  });
  expect(stateResponse.ok()).toBeTruthy();
  const state = await stateResponse.json() as {
    counters: { authorize: number; tokenSuccess: number; userinfo: number };
  };
  expect(state.counters.authorize).toBeGreaterThanOrEqual(1);
  expect(state.counters.tokenSuccess).toBeGreaterThanOrEqual(1);
  expect(state.counters.userinfo).toBeGreaterThanOrEqual(1);
});
