import { expect, test } from "@playwright/test";
import { adminEmail, adminPassword, apiURL, bootstrap, login } from "./helpers.ts";

const mockControlUrl = "http://localhost:4020";
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
  const viewport = testInfo.project.name === "mobile-chromium" ? "mobile" : "desktop";
  const retry = Math.min(testInfo.retry, 2);
  const personaName = `OIDC ${viewport === "mobile" ? "Mobile" : "Desktop"} Applicant ${retry}`;
  const oidcEmail = `oidc-new-${viewport}-${retry}@e2e.invalid`;
  await bootstrap(request);
  const reset = await request.post(`${mockControlUrl}/control/reset`, {
    headers: mockControlHeaders,
  });
  expect(reset.ok()).toBeTruthy();

  await signInWithOidc(page, personaName);
  await expect(page).toHaveURL(/\/pending$/u);

  await page.context().clearCookies();
  await login(page, adminEmail, adminPassword);
  const usersResponse = await page.request.get(`${apiURL}/api/admin/users`);
  expect(usersResponse.ok()).toBeTruthy();
  const users = await usersResponse.json() as { data: Array<{ id: string; email: string }> };
  const applicant = users.data.find((user) => user.email === oidcEmail);
  expect(applicant).toBeTruthy();
  const approval = await page.request.patch(
    `${apiURL}/api/admin/users/${applicant!.id}/approval`,
    {
      headers: { origin: new URL(page.url()).origin },
      data: { status: "approved" },
    },
  );
  expect(approval.ok()).toBeTruthy();

  await page.context().clearCookies();
  await signInWithOidc(page, personaName);

  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
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
