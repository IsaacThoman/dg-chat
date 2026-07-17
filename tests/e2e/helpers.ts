import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { env } from "./env.ts";
import { assertSafeE2ETarget } from "./target-safety.ts";

export const apiURL = env("E2E_API_URL") ?? "http://localhost:8000";
const baseURL = env("E2E_BASE_URL") ?? "http://localhost:5173";

// Playwright config enforces this before suite discovery. Keep the assertion beside the
// destructive bootstrap helper as defense in depth for scripts that import helpers directly.
assertSafeE2ETarget({
  targetUrls: [baseURL, apiURL],
  allowDestructiveRemote: env("E2E_ALLOW_DESTRUCTIVE_REMOTE"),
  setupToken: env("SETUP_TOKEN"),
  adminEmail: env("E2E_ADMIN_EMAIL"),
  adminPassword: env("E2E_ADMIN_PASSWORD"),
});

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
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

export function workspaceSidebar(page: Page) {
  return page.locator('aside.sidebar[aria-label="Workspace navigation"]');
}

/** The session host retains inactive chats, so raw CSS locators should start from this root. */
export function activeChatSession(page: Page) {
  return page.locator("[data-chat-session]:not([hidden])");
}

async function sidebarIsExposed(page: Page): Promise<boolean> {
  const sidebar = workspaceSidebar(page);
  if (await sidebar.count() !== 1) return false;
  return await sidebar.evaluate((element) =>
    element.getAttribute("aria-hidden") !== "true" &&
    !element.hasAttribute("inert")
  );
}

/**
 * Exposes the responsive workspace sidebar without assuming a viewport breakpoint or ARIA role.
 * The same aside is a complementary landmark on desktop, an inert off-canvas element while a
 * mobile drawer is closed, and a modal dialog while that drawer is open.
 */
export async function openSidebar(page: Page) {
  const sidebar = workspaceSidebar(page);
  await expect(sidebar).toHaveCount(1);
  if (await sidebarIsExposed(page)) return sidebar;

  // A nested row dialog temporarily makes an already-open drawer inert. Wait for that dialog's
  // cleanup instead of trying to click the Open menu control behind the physical drawer.
  if (await sidebar.evaluate((element) => element.classList.contains("mobile-open"))) {
    await expect.poll(() => sidebarIsExposed(page), {
      message: "the open workspace drawer to become interactive again",
    }).toBe(true);
    return sidebar;
  }

  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect.poll(() => sidebarIsExposed(page), {
    message: "the workspace sidebar to become interactive",
  }).toBe(true);
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveAttribute("role", "dialog");
  await expect(
    sidebar.getByRole("button", { name: "Close sidebar", exact: true }),
  ).toBeFocused();
  return sidebar;
}

export async function createChat(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "New chat ⌘ K", exact: true });
  await openSidebar(page);
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/conversations"
  );
  await button.click();
  const response = await createdResponse;
  expect(response.ok(), response.ok() ? "conversation created" : await response.text())
    .toBeTruthy();
  const created = await response.json() as { id: string };
  await expect(
    page.locator(".conversation-row.active [data-conversation-actions]"),
    "the exact newly created conversation to become active",
  ).toHaveAttribute("data-conversation-actions", created.id);
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", created.id);
}

export function uniqueUser(prefix = "applicant") {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    name: "E2E Applicant",
    email: `${prefix}-${suffix}@e2e.invalid`,
    password: "Valid-Pass-42!",
  };
}
