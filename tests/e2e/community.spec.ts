import { expect, test } from "@playwright/test";
import { apiURL, bootstrap, login, openSidebar, uniqueUser } from "./helpers.ts";
import { type AppReadiness, missingDurableCapabilities, strictDurableCapabilities } from "./env.ts";

async function requireCommunityStack(
  request: import("@playwright/test").APIRequestContext,
) {
  const response = await request.get(`${apiURL}/ready`);
  const readiness = await response.json().catch(() => null) as AppReadiness | null;
  const missing = missingDurableCapabilities(readiness, ["postgres"]);
  if (!missing.length) return;
  const reason = `requires live ${
    missing.join(" and ")
  } readiness; /ready returned HTTP ${response.status()}`;
  if (strictDurableCapabilities()) {
    throw new Error(`Full-stack E2E configuration error: ${reason}`);
  }
  test.skip(true, reason);
}

test("community participation is private by default, durable, and conflict-safe", async ({
  page,
  request,
}, testInfo) => {
  testInfo.setTimeout(120_000);
  await requireCommunityStack(request);
  await bootstrap(request);
  const member = uniqueUser(`community-${testInfo.project.name.replaceAll(/[^a-z0-9]/gi, "-")}`);
  const nickname = `Pilot ${crypto.randomUUID().slice(0, 7)}`;

  await page.goto("/login");
  await page.getByRole("button", { name: "Request access" }).click();
  await page.getByLabel(/name/i).fill(member.name);
  await page.getByLabel(/email/i).fill(member.email);
  await page.getByLabel(/^password/i).fill(member.password);
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page).toHaveURL(/\/pending$/);

  await page.context().clearCookies();
  await login(page);
  const usersResponse = await page.request.get(
    `${apiURL}/api/admin/users?search=${encodeURIComponent(member.email)}&limit=1`,
  );
  expect(usersResponse.ok(), await usersResponse.text()).toBeTruthy();
  const user = ((await usersResponse.json()) as {
    data: Array<{ id: string; email: string; version: number }>;
  }).data.find((candidate) => candidate.email === member.email);
  expect(user).toBeTruthy();
  const approval = await page.request.patch(`${apiURL}/api/admin/users/${user!.id}/approval`, {
    headers: { origin: new URL(page.url()).origin },
    data: { status: "approved", expectedVersion: user!.version },
  });
  expect(approval.ok(), await approval.text()).toBeTruthy();

  await page.context().clearCookies();
  await login(page, member.email, member.password);
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: "Community", exact: true }).click();
  await expect(page).toHaveURL(/\/community\?metric=calls&window=30d$/);
  await expect(page.getByRole("heading", { name: "See how the community is creating" }))
    .toBeVisible();

  const join = page.getByRole("checkbox", { name: /Join the community leaderboard/ });
  const shareBalance = page.getByRole("checkbox", { name: /Share my current balance/ });
  await expect(join).not.toBeChecked();
  await expect(page.getByRole("radio", { name: /^Anonymous/ })).toBeChecked();
  await expect(shareBalance).toBeDisabled();
  await expect(page.locator("body")).not.toContainText(user!.id);

  await join.check();
  await page.getByRole("radio", { name: /^Nickname/ }).check();
  await page.getByRole("textbox", { name: "Nickname", exact: true }).fill(nickname);
  await page.getByRole("radio", { name: "Violet" }).check();
  await expect(shareBalance).toBeEnabled();
  await expect(shareBalance).not.toBeChecked();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Nickname", exact: true })).toHaveValue(
    nickname,
  );
  await expect(join).toBeChecked();
  await expect(shareBalance).not.toBeChecked();

  const tokens = page.getByRole("tab", { name: "Tokens" });
  await page.getByRole("tab", { name: "Calls" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tokens).toBeFocused();
  await expect(tokens).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Balance" })).toBeFocused();
  await expect(page.getByText("Current snapshot", { exact: true })).toBeVisible();

  const current = await page.request.get(`${apiURL}/api/community/profile`);
  expect(current.ok(), await current.text()).toBeTruthy();
  const latest = await current.json() as { version: number };
  const external = await page.request.patch(`${apiURL}/api/community/profile`, {
    headers: { origin: new URL(page.url()).origin },
    data: {
      expectedVersion: latest.version,
      optedIn: true,
      identityMode: "nickname",
      nickname,
      color: "blue",
      shareBalance: false,
    },
  });
  expect(external.ok(), await external.text()).toBeTruthy();

  const draftName = `${nickname} X`;
  await page.getByRole("textbox", { name: "Nickname", exact: true }).fill(draftName);
  await page.getByRole("button", { name: "Save profile" }).click();
  const conflict = page.getByRole("alert");
  await expect(conflict).toContainText("without overwriting");
  await expect(conflict).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Nickname", exact: true })).toHaveValue(
    draftName,
  );
  await expect(page.getByRole("radio", { name: "Blue" })).toBeChecked();
  await page.getByRole("button", { name: "Review and save again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved" })).toBeVisible();

  await shareBalance.check();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved" })).toBeVisible();
  await page.getByRole("tab", { name: "Balance" }).click();
  await expect(page.getByRole("tabpanel")).toContainText(draftName);

  if (testInfo.project.name.includes("mobile")) {
    const overflow = await page.evaluate(() =>
      Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        document.body.scrollWidth - document.body.clientWidth,
      )
    );
    expect(overflow).toBeLessThanOrEqual(1);
    for (
      const control of [
        page.getByRole("tab", { name: "Calls" }),
        page.getByRole("button", { name: "Save profile" }),
        page.getByTitle("Violet", { exact: true }),
      ]
    ) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  }
});
