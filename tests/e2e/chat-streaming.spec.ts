import { expect, test } from "@playwright/test";
import { apiURL, bootstrap, createChat, login } from "./helpers.ts";

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

async function selectSlowStream(page: import("@playwright/test").Page) {
  await page.locator('button.model-trigger[aria-haspopup="listbox"]').click();
  await page.getByRole("listbox", { name: "Chat model" })
    .getByRole("option", { name: /DG Chat Slow Stream/ }).click();
  await expect(page.getByRole("button", { name: /DG Chat Slow Stream/ })).toBeVisible();
}

test("renders real incremental SSE and runs queued prompts in FIFO order", async ({ page }) => {
  test.setTimeout(60_000);
  await selectSlowStream(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  const first = Array.from(
    { length: 30 },
    (_, index) => `queue-window-${index + 1}`,
  ).join(" ");
  await composer.fill(first);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await expect(page.locator(".assistant-message")).toContainText("This is a simulated");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

  await composer.fill("cancel this prompt");
  await page.getByRole("button", { name: "Queue message" }).click();
  await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel queued message 1" }).click();
  await expect(page.getByText("1 queued", { exact: true })).toBeHidden();

  const second = "second prompt executes only after the first terminal event";
  await composer.fill(second);
  await page.getByRole("button", { name: "Queue message" }).click();
  await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
  const third = "third prompt preserves FIFO order behind the second";
  await composer.fill(third);
  await page.getByRole("button", { name: "Queue message" }).click();
  await expect(page.getByText("2 queued", { exact: true })).toBeVisible();
  await expect(page.getByText(`This is a simulated response to: ${first}`, { exact: true }))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`This is a simulated response to: ${second}`, { exact: true }))
    .toBeVisible();
  await expect(page.getByText(`This is a simulated response to: ${third}`, { exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
  const userMessages = await page.locator(".user-message").allTextContents();
  expect(userMessages.join("\n")).not.toContain("cancel this prompt");
  expect(userMessages).toHaveLength(3);
  expect(userMessages[0]).toContain(first);
  expect(userMessages[1]).toContain(second);
  expect(userMessages[2]).toContain(third);
});

test("stop persists exactly one partial assistant node across reload", async ({ page }) => {
  await selectSlowStream(page);
  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();
  const prompt =
    "stream alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon final-sentinel";
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  const assistant = page.locator(".assistant-message");
  await expect(assistant).toContainText("This is a simulated response");
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(assistant).not.toContainText("final-sentinel");
  let persisted = "";
  await expect.poll(async () => {
    const response = await page.request.get(`${apiURL}/api/conversations/${conversationId}`);
    if (!response.ok()) return "unavailable";
    const graph = await response.json() as {
      messages: Array<{ role: string; status: string; content: string }>;
    };
    const assistants = graph.messages.filter((message) => message.role === "assistant");
    persisted = assistants[0]?.content ?? "";
    return `${assistants.length}:${assistants[0]?.status ?? "missing"}`;
  }).toBe("1:stopped");
  expect(persisted).not.toContain("final-sentinel");

  await page.reload();
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await page.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) button.conversation-open`,
  ).click();
  await expect(page.locator(".assistant-message")).toHaveCount(1);
  await expect(page.getByText(persisted, { exact: true })).toBeVisible();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(page.locator(".assistant-message")).not.toContainText("final-sentinel");
});

test("regenerate and continue append recoverable assistant branches", async ({ page }) => {
  const prompt = "original immutable branch";
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(`This is a simulated response to: ${prompt}`, { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "Regenerate response in a new branch" }).click();
  await expect(page.getByLabel("Branch 2 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Previous branch" }).click();
  await expect(page.getByLabel("Branch 1 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Continue response" }).click();
  await expect(page.getByLabel("Branch 3 of 3")).toBeVisible();
  expect(
    await page.locator(".assistant-message .message-actions").evaluate((element) =>
      element.scrollWidth <= element.clientWidth
    ),
  ).toBe(true);

  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();
  const graphResponse = await page.request.get(`${apiURL}/api/conversations/${conversationId}`);
  expect(graphResponse.ok()).toBeTruthy();
  const graph = await graphResponse.json() as {
    messages: Array<{
      id: string;
      parentId: string | null;
      supersedesId: string | null;
      role: string;
      metadata: Record<string, unknown>;
    }>;
  };
  const assistants = graph.messages.filter((message) => message.role === "assistant");
  expect(assistants).toHaveLength(3);
  expect(new Set(assistants.map((message) => message.parentId)).size).toBe(1);
  expect(assistants[1].supersedesId).toBe(assistants[0].id);
  expect(assistants[2].supersedesId).toBe(assistants[0].id);
  expect(assistants[2].metadata.continuesId).toBe(assistants[0].id);
});

test("regenerating an earlier turn selects and keeps the new branch", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("first turn with a later descendant");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".assistant-message")).toHaveCount(1);
  await composer.fill("second turn makes the first assistant non-leaf");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".assistant-message")).toHaveCount(2);

  await page.getByRole("button", { name: "Regenerate response in a new branch" }).first().click();
  await expect(page.locator(".assistant-message")).toHaveCount(1);
  await expect(page.getByLabel("Branch 2 of 2")).toBeVisible();
  await expect(page.getByText("second turn makes the first assistant non-leaf")).toBeHidden();

  const conversationId = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(conversationId).toBeTruthy();
  await page.reload();
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await page.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) button.conversation-open`,
  ).click();
  await expect(page.locator(".assistant-message")).toHaveCount(1);
  await expect(page.getByLabel("Branch 2 of 2")).toBeVisible();
  await expect(page.getByText("second turn makes the first assistant non-leaf")).toBeHidden();
});
