import { expect, type Page, test } from "@playwright/test";
import { apiURL, bootstrap, login, openSidebar } from "./helpers.ts";

interface ProviderModelFixture {
  id: string;
  displayName: string;
}

async function adminMutation(
  page: Page,
  path: string,
  method: "POST" | "PUT",
  data: unknown,
) {
  const response = await page.request.fetch(`${apiURL}${path}`, {
    method,
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  if (!response.ok()) {
    throw new Error(`${method} ${path} failed (${response.status()}): ${await response.text()}`);
  }
  return await response.json();
}

async function createModelFixture(
  page: Page,
  prefix: string,
  options: { configured?: boolean; priced?: boolean } = {},
): Promise<ProviderModelFixture> {
  const configured = options.configured ?? true;
  const priced = options.priced ?? true;
  const slugPrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = `${slugPrefix}-${crypto.randomUUID().slice(0, 8)}`;
  const displayName = `${prefix} ${slug.slice(-8)}`;
  const provider = await adminMutation(page, "/api/admin/providers", "POST", {
    slug,
    displayName: `${displayName} provider`,
    baseUrl: `https://${slug}.example.invalid/v1`,
    protocol: "chat_completions",
  });

  if (configured) {
    await adminMutation(page, `/api/admin/providers/${provider.id}/credential`, "PUT", {
      expectedVersion: provider.version,
      credential: `e2e-${slug}-secret`,
    });
  }

  const model = await adminMutation(page, "/api/admin/models", "POST", {
    providerId: provider.id,
    publicModelId: `${slug}/chat`,
    upstreamModelId: `${slug}-upstream-chat`,
    displayName,
    capabilities: ["chat", "streaming", "tools"],
    contextWindow: 32_000,
  });

  if (priced) {
    await adminMutation(page, `/api/admin/models/${model.id}/prices`, "POST", {
      providerModelId: model.id,
      expectedModelVersion: model.version,
      effectiveAt: "2026-01-01T00:00:00.000Z",
      inputMicrosPerMillion: 100_000,
      cachedInputMicrosPerMillion: 50_000,
      reasoningMicrosPerMillion: 200_000,
      outputMicrosPerMillion: 300_000,
      fixedCallMicros: 10,
      source: "e2e-resilience",
    });
  }

  return { id: model.id, displayName };
}

async function openResilience(page: Page, mobile: boolean) {
  await openSidebar(page);
  await page.getByRole("button", { name: "Admin console", exact: true }).click();
  if (mobile) {
    await page.getByRole("combobox", { name: "Admin section" }).selectOption("resilience");
  } else {
    await page.getByRole("link", { name: "Routing resilience", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Routing resilience", exact: true }))
    .toBeVisible();
}

test("an administrator creates and orders a resilient route accessibly", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  await bootstrap(request);
  await login(page);

  const primary = await createModelFixture(page, "E2E primary");
  const fallbackOne = await createModelFixture(page, "E2E fallback one");
  const fallbackTwo = await createModelFixture(page, "E2E fallback two");
  const unavailable = await createModelFixture(page, "E2E unavailable", {
    configured: false,
    priced: false,
  });

  const mobile = testInfo.project.name.includes("mobile");
  await openResilience(page, mobile);

  const createPolicy = page.getByRole("button", { name: "Create policy", exact: true });
  await createPolicy.click();
  const policyName = page.getByLabel("Name", { exact: true });
  await expect(policyName).toBeFocused();
  await policyName.press("Escape");
  await expect(createPolicy).toBeFocused();

  const uniquePolicyName = `E2E fast fallback ${crypto.randomUUID().slice(0, 8)}`;
  await createPolicy.click();
  await page.getByLabel("Name", { exact: true }).fill(uniquePolicyName);
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Retry policy created");
  await expect(page.getByText(uniquePolicyName, { exact: true })).toBeVisible();

  const unavailableCard = page.locator("article.model-card", {
    has: page.getByText(unavailable.displayName, { exact: true }),
  });
  await expect(unavailableCard.getByText("unavailable", { exact: true })).toBeVisible();
  await expect(unavailableCard).toContainText("Credential missing");
  await expect(unavailableCard).toContainText("Effective price missing");

  const editRoute = page.getByRole("button", {
    name: `Edit route for ${primary.displayName}`,
    exact: true,
  });
  await editRoute.click();
  const retryPolicy = page.getByRole("combobox", { name: "Retry policy", exact: true });
  await expect(retryPolicy).toBeFocused();
  await retryPolicy.selectOption({ label: uniquePolicyName });

  const target = page.getByRole("combobox", { name: "Fallback target" });
  await expect(target.locator(`option[value="${unavailable.id}"]`)).toBeDisabled();
  await target.selectOption(fallbackOne.id);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await target.selectOption(fallbackTwo.id);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("list", { name: `Fallback order for ${primary.displayName}` }))
    .toContainText(fallbackOne.displayName);
  await page.getByRole("button", { name: "Save route", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Fallback route updated");

  await editRoute.click();
  await page.getByRole("button", { name: `Move ${fallbackTwo.displayName} up` }).click();
  await expect(
    page.getByRole("dialog").locator('.sr-only[aria-live="polite"]'),
  ).toContainText(`${fallbackTwo.displayName} moved to position 1 of 2`);
  const orderedItems = page.getByRole("list", {
    name: `Fallback order for ${primary.displayName}`,
  }).getByRole("listitem");
  await expect(orderedItems.nth(0)).toContainText(fallbackTwo.displayName);
  await expect(orderedItems.nth(1)).toContainText(fallbackOne.displayName);
  await page.getByRole("button", { name: "Save route", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  const routesResponse = await page.request.get(`${apiURL}/api/admin/resilience/routes`);
  expect(routesResponse.ok()).toBeTruthy();
  const routes = (await routesResponse.json()).data as Array<{
    model: { id: string };
    route: { fallbackModelIds: string[] } | null;
  }>;
  expect(routes.find((entry) => entry.model.id === primary.id)?.route?.fallbackModelIds).toEqual([
    fallbackTwo.id,
    fallbackOne.id,
  ]);

  await editRoute.click();
  await retryPolicy.press("Escape");
  await expect(editRoute).toBeFocused();

  if (mobile) {
    const overflow = await page.evaluate<{ body: number; root: number }>(`({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    expect(overflow.body).toBeLessThanOrEqual(1);
    expect(overflow.root).toBeLessThanOrEqual(1);
  }
});
