import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login, uniqueUser } from "./helpers.ts";
import { env } from "./env.ts";

test("a public signup remains pending until an administrator approves it", async ({ page, request }) => {
  await bootstrap(request);
  const applicant = uniqueUser();

  await page.goto("/login");
  await page.getByRole("button", { name: "Request access" }).click();
  await page.getByLabel(/name/i).fill(applicant.name);
  await page.getByLabel(/email/i).fill(applicant.email);
  await page.getByLabel(/^password/i).fill(applicant.password);
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page).toHaveURL(/\/pending$/);

  await page.context().clearCookies();
  await login(page);
  const usersResponse = await page.request.get(
    `${env("E2E_API_URL") ?? "http://localhost:8000"}/api/admin/users`,
  );
  const users = (await usersResponse.json()).data as Array<{ id: string; email: string }>;
  const applicantUser = users.find((user) => user.email === applicant.email);
  expect(applicantUser).toBeTruthy();
  await page.request.patch(
    `${env("E2E_API_URL") ?? "http://localhost:8000"}/api/admin/users/${
      applicantUser!.id
    }/approval`,
    { data: { status: "approved" } },
  );

  await page.context().clearCookies();
  await login(page, applicant.email, applicant.password);
  await createChat(page);
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
});

test("unauthenticated API errors use the OpenAI error envelope", async ({ request }) => {
  const response = await request.post(
    `${env("E2E_API_URL") ?? "http://localhost:8000"}/v1/chat/completions`,
    {
      data: { model: "mock/mock-fast", messages: [{ role: "user", content: "hello" }] },
    },
  );
  expect(response.status()).toBe(401);
  const body = await response.json();
  expect(body).toMatchObject({ error: { message: expect.any(String), type: expect.any(String) } });
});
