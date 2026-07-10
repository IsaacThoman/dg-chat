import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { env } from "./env.ts";

export const apiURL = env("E2E_API_URL") ?? "http://localhost:8000";
export const adminEmail = env("E2E_ADMIN_EMAIL") ?? "admin@e2e.invalid";
export const adminPassword = env("E2E_ADMIN_PASSWORD") ?? "Correct-Horse-42-Battery!";

export async function bootstrap(request: APIRequestContext): Promise<void> {
  const status = await request.get(`${apiURL}/api/setup/status`);
  expect(status.ok()).toBeTruthy();
  const setup = await status.json() as { bootstrapRequired?: boolean };
  if (setup.bootstrapRequired === false) return;

  const response = await request.post(`${apiURL}/api/setup/bootstrap`, {
    headers: { "x-setup-token": env("SETUP_TOKEN") ?? "e2e-setup-token" },
    data: { name: "E2E Administrator", email: adminEmail, password: adminPassword },
  });
  expect([200, 201, 409]).toContain(response.status());
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
  await expect(page).toHaveURL(/\/$/);
}

export async function createChat(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "New chat ⌘ K", exact: true });
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await button.click();
}

export function uniqueUser(prefix = "applicant") {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    name: "E2E Applicant",
    email: `${prefix}-${suffix}@e2e.invalid`,
    password: "Valid-Pass-42!",
  };
}
