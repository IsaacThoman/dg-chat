import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { env } from "./env.ts";

export const apiURL = env("E2E_API_URL") ?? "http://localhost:8000";
export const adminEmail = env("E2E_ADMIN_EMAIL") ?? "admin@e2e.invalid";
export const adminPassword = env("E2E_ADMIN_PASSWORD") ?? "Correct-Horse-42-Battery!";

async function bootstrapRequired(request: APIRequestContext): Promise<boolean> {
  const status = await request.get(`${apiURL}/api/setup/status`, { timeout: 30_000 });
  expect(status.ok()).toBeTruthy();
  const setup = await status.json() as { bootstrapRequired?: boolean };
  return setup.bootstrapRequired !== false;
}

export async function bootstrap(request: APIRequestContext): Promise<void> {
  if (!(await bootstrapRequired(request))) return;

  const response = await request.post(`${apiURL}/api/setup/bootstrap`, {
    timeout: 30_000,
    headers: { "x-setup-token": env("SETUP_TOKEN") ?? "e2e-setup-token" },
    data: { name: "E2E Administrator", email: adminEmail, password: adminPassword },
  });
  expect([200, 201, 409]).toContain(response.status());
  // Parallel browser projects can both observe an unconfigured installation. A 409 means one
  // bootstrap won the one-time claim, not necessarily that its administrator transaction has
  // already committed. Never race ahead into sign-in until setup is observably complete.
  await expect.poll(() => bootstrapRequired(request), { timeout: 30_000 }).toBe(false);
}

export async function login(
  page: Page,
  email = adminEmail,
  password = adminPassword,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // Password verification is deliberately expensive and can exceed the global assertion timeout
  // on constrained self-hosted runners. Keep the production-strength hash and give this one
  // boundary enough time to complete.
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
}

export async function createChat(page: Page): Promise<void> {
  const activeActions = page.locator(".conversation-row.active [data-conversation-actions]");
  const previousId = await activeActions.count() === 1
    ? await activeActions.getAttribute("data-conversation-actions")
    : null;
  const button = page.getByRole("button", { name: "New chat ⌘ K", exact: true });
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await button.click();
  await expect.poll(
    () => activeActions.getAttribute("data-conversation-actions"),
    { message: "the newly created conversation to become active" },
  ).not.toBe(previousId);
}

export function uniqueUser(prefix = "applicant") {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    name: "E2E Applicant",
    email: `${prefix}-${suffix}@e2e.invalid`,
    password: "Valid-Pass-42!",
  };
}
