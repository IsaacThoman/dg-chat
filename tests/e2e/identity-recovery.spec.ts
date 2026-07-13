import { expect, test } from "@playwright/test";
import { bootstrap, login } from "./helpers.ts";

const approvedUser = {
  id: "00000000-0000-4000-8000-000000000099",
  name: "Recovery User",
  email: "recovery@example.com",
  role: "user",
  approvalStatus: "approved",
  state: "active",
  balanceMicros: 5_000_000,
  emailVerifiedAt: null,
};

async function expectNoOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.root).toBeLessThanOrEqual(1);
}

test("password recovery stays enumeration-safe and completes with a strong password", async ({ page }) => {
  let requestedEmail = "";
  await page.route("**/api/auth/password-reset/request", async (route) => {
    requestedEmail = (route.request().postDataJSON() as { email: string }).email;
    await route.fulfill({ status: 202, body: "" });
  });
  await page.goto("/forgot-password");
  await page.getByLabel("Email address", { exact: true }).fill("unknown@example.com");
  await page.getByRole("button", { name: "Send recovery link", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("If an account exists");
  expect(requestedEmail).toBe("unknown@example.com");
  await expectNoOverflow(page);

  let resetBody: unknown;
  await page.route("**/api/auth/password-reset", async (route) => {
    resetBody = route.request().postDataJSON();
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/reset-password#token=reset-safe-token");
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(
    page.locator("form").getByText("Use 10–128 characters.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute(
    "aria-describedby",
    "reset-password-guidance",
  );
  await page.getByLabel("New password", { exact: true }).fill("too-short");
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByText("Use at least 10 characters.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update password", exact: true })).toBeDisabled();
  await page.getByLabel("New password", { exact: true }).fill("Valid-Recovery-42");
  await page.getByLabel("Confirm new password", { exact: true }).fill("different-value");
  await expect(page.getByText("The passwords do not match.", { exact: true })).toBeVisible();
  await page.getByLabel("Confirm new password", { exact: true }).fill("Valid-Recovery-42");
  await expect(page.getByText("Password requirements satisfied.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Update password", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Your password is ready");
  expect(resetBody).toEqual({ token: "reset-safe-token", password: "Valid-Recovery-42" });

  // Installed PWAs and reused tabs can receive a second emailed fragment without remounting the
  // route. Sensitive fields and completion state must belong only to the token that created them.
  await page.evaluate(() => {
    location.hash = "token=second-reset-token";
  });
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Confirm new password", { exact: true })).toHaveValue("");
  await expectNoOverflow(page);
});

test("recovery and verification links fail with a useful safe path", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page.getByRole("alert")).toContainText("Request a fresh link");
  // Model an emailed link opening from another page instead of a same-document fragment update.
  await page.goto("/login");

  await page.route("**/api/auth/password-reset", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "invalid_identity_token",
          message: "Reset token is invalid or expired",
        },
      }),
    });
  });
  await page.goto("/reset-password#token=used-token");
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel("New password", { exact: true }).fill("Valid-Recovery-42");
  await page.getByLabel("Confirm new password", { exact: true }).fill("Valid-Recovery-42");
  await page.getByRole("button", { name: "Update password", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("invalid, expired, or has already been used");

  await page.route("**/api/auth/verify-email", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "invalid_identity_token",
          message: "Verification token is invalid or expired",
        },
      }),
    });
  });
  await page.goto("/verify-email#token=used-token");
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByRole("alert")).toContainText("missing, invalid, expired, or has already");
  await expectNoOverflow(page);
});

test("verification succeeds and limited approved users remain on the status screen", async ({ page }) => {
  await page.route("**/api/auth/verify-email", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { ...approvedUser, emailVerifiedAt: new Date().toISOString() },
      }),
    });
  });
  await page.goto("/verify-email#token=fresh-token");
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByRole("status")).toContainText("Verification complete");

  await page.route("**/api/**", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/setup/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bootstrapRequired: false,
        setupEnabled: true,
        oidcEnabled: false,
        emailEnabled: true,
        requireEmailVerification: true,
      }),
    });
  });
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: approvedUser, limited: true }),
    });
  });
  await page.route("**/api/auth/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        approvalStatus: "approved",
        state: "active",
        emailVerified: false,
        emailVerificationRequired: true,
        sessionLimited: true,
        fullSessionEligible: false,
        fullAccess: false,
      }),
    });
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/pending$/);
  await expect(page.getByRole("heading", { name: "Verify your email", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send a new verification link", exact: true }))
    .toBeVisible();
  await page.route("**/api/auth/verify-email/request", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "smtp_unavailable", message: "Try again" } }),
    });
  });
  await page.getByRole("button", { name: "Send a new verification link", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("couldn't send a new link");
  await expectNoOverflow(page);
});

test("stale verification responses cannot overwrite a removed or newer emailed link", async ({ page }) => {
  let releaseSlow!: () => void;
  let finishSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const slowFinished = new Promise<void>((resolve) => {
    finishSlow = resolve;
  });
  await page.route("**/api/auth/verify-email", async (route) => {
    const token = (route.request().postDataJSON() as { token: string }).token;
    if (token === "slow-verification-token") {
      await slowGate;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "invalid_identity_token", message: "Expired" },
        }),
      });
      finishSlow();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { ...approvedUser, emailVerifiedAt: new Date().toISOString() },
      }),
    });
  });
  await page.goto("/verify-email#token=slow-verification-token");
  await expect(page.getByText("Checking your link…", { exact: true })).toBeVisible();

  // The app scrubs emailed fragments. A reused PWA tab can then navigate to the same tokenless
  // route without remounting, which must invalidate the request that is already in flight.
  await page.evaluate(() => {
    history.pushState(history.state, "", "/verify-email");
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await expect(page.getByRole("alert")).toContainText(
    "missing, invalid, expired, or has already been used",
  );
  releaseSlow();
  await slowFinished;
  await expect(page.getByRole("alert")).toContainText(
    "missing, invalid, expired, or has already been used",
  );

  await page.evaluate(() => {
    location.hash = "token=fresh-verification-token";
  });
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByRole("status")).toContainText("Verification complete");
});

test("identity forms announce blocking errors and associate password guidance", async ({ page }) => {
  let bootstrapRequired = false;
  await page.route("**/api/setup/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bootstrapRequired,
        setupEnabled: true,
        oidcEnabled: false,
        emailEnabled: true,
        requireEmailVerification: false,
      }),
    });
  });
  await page.route("**/api/auth/sign-in/email", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "invalid_credentials", message: "Invalid" } }),
    });
  });
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill("missing@example.com");
  await page.getByLabel("Password", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("couldn't sign you in");

  await page.getByRole("button", { name: "Request access", exact: true }).click();
  const signupPassword = page.getByLabel("Password", { exact: true });
  await signupPassword.fill("short");
  await expect(signupPassword).toHaveAttribute("aria-describedby", "signup-password-guidance");
  await expect(signupPassword).toHaveAttribute("aria-invalid", "true");

  bootstrapRequired = true;
  await page.route("**/api/setup/bootstrap", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "invalid_setup_token", message: "Invalid" } }),
    });
  });
  await page.goto("/setup");
  await page.getByLabel("Setup token", { exact: true }).fill("wrong-token");
  await page.getByLabel("Administrator name", { exact: true }).fill("Admin");
  await page.getByLabel("Email address", { exact: true }).fill("admin@example.com");
  const setupPassword = page.getByLabel("Password", { exact: true });
  await setupPassword.fill("correct horse battery");
  await expect(setupPassword).toHaveAttribute("aria-describedby", "setup-password-guidance");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Setup failed");
});

test("account settings distinguish sessions and tolerate a transient current-session probe", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "better_auth:current-session",
              userId: approvedUser.id,
              source: "better_auth",
              limited: false,
              current: true,
              createdAt: "2026-07-02T00:00:00.000Z",
              expiresAt: "2026-08-02T00:00:00.000Z",
              invalidatedAt: null,
            },
            {
              id: "better_auth:session-one",
              userId: approvedUser.id,
              source: "better_auth",
              limited: false,
              current: false,
              createdAt: "2026-07-01T00:00:00.000Z",
              expiresAt: "2026-08-01T00:00:00.000Z",
              invalidatedAt: null,
            },
          ],
        }),
      });
      return;
    }
    await route.fallback();
  });
  let revoked = false;
  await page.route("**/api/sessions/better_auth%3Asession-one", async (route) => {
    revoked = true;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "service_unavailable", message: "Try again" } }),
    });
  });
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Signed-in sessions", exact: true }))
    .toBeVisible();
  await expect(page.getByText("Workspace session · This device", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign out workspace session created/ }))
    .toBeVisible();
  await page.getByRole("button", { name: /Revoke workspace session created/ }).click();
  expect(revoked).toBe(true);
  await expect(page.locator(".session-notice")).toContainText(
    "current sign-in could not be rechecked",
  );
  await expect(page).not.toHaveURL(/\/login$/);
  await expectNoOverflow(page);
});

test("revoking the current session returns to sign in", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [{
          id: "better_auth:current-session",
          userId: approvedUser.id,
          source: "better_auth",
          limited: false,
          current: true,
          createdAt: "2026-07-02T00:00:00.000Z",
          expiresAt: "2026-08-02T00:00:00.000Z",
          invalidatedAt: null,
        }],
      }),
    });
  });
  await page.route("**/api/sessions/better_auth%3Acurrent-session", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unauthorized", message: "Signed out" } }),
    });
  });
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Sign out workspace session created/ }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("auth recovery remains reachable on a short zoomed viewport", async ({ page }) => {
  await page.setViewportSize({ width: 740, height: 420 });
  await page.goto("/reset-password#token=short-viewport-token");
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  const darkBackground = await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    return getComputedStyle(document.querySelector(".auth-page")!).backgroundColor;
  });
  expect(darkBackground).not.toBe("rgb(245, 244, 240)");
  const submit = page.getByRole("button", { name: "Update password", exact: true });
  const back = page.getByRole("link", { name: "Request a different link", exact: true });
  await expect(submit).toBeVisible();
  await expect(back).toBeVisible();
  const scrollState = await page.locator(".auth-page").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(scrollState.overflowY).toBe("auto");
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  await expectNoOverflow(page);
});
