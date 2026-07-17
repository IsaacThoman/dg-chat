import { expect, type Page, test } from "@playwright/test";
import { activeChatSession, bootstrap, createChat, login, openSidebar } from "./helpers.ts";

const speechPrimary = "e2e/session-speech-primary";
const speechShared = "e2e/session-speech-shared";
const transcriptionPrimary = "e2e/session-transcription-primary";
const transcriptionShared = "e2e/session-transcription-shared";

async function activeConversationId(page: Page): Promise<string> {
  const id = await page.locator(
    ".conversation-row.active [data-conversation-actions]",
  ).getAttribute("data-conversation-actions");
  expect(id).toBeTruthy();
  return id!;
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  const sidebar = await openSidebar(page);
  await sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) button.conversation-open`,
  ).click();
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", conversationId);
}

test("retained chats share speech and transcription preferences", async ({ page, request }) => {
  await bootstrap(request);
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { data: Array<{ id?: string }> };
    const fixtureIds = new Set([
      speechPrimary,
      speechShared,
      transcriptionPrimary,
      transcriptionShared,
    ]);
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: [
          ...payload.data.filter((model) => !model.id || !fixtureIds.has(model.id)),
          {
            id: speechPrimary,
            displayName: "Session Speech Primary",
            provider: "e2e",
            capabilities: ["speech"],
            contextWindow: 4096,
          },
          {
            id: speechShared,
            displayName: "Session Speech Shared",
            provider: "e2e",
            capabilities: ["speech"],
            contextWindow: 4096,
          },
          {
            id: transcriptionPrimary,
            displayName: "Session Transcription Primary",
            provider: "e2e",
            capabilities: ["transcription"],
            contextWindow: 8192,
          },
          {
            id: transcriptionShared,
            displayName: "Session Transcription Shared",
            provider: "e2e",
            capabilities: ["transcription"],
            contextWindow: 8192,
          },
        ],
      },
    });
  });

  await login(page);
  await createChat(page);
  const firstId = await activeConversationId(page);

  // Mount a second session before changing preferences so the first ChatView remains retained.
  await createChat(page);
  const secondId = await activeConversationId(page);
  expect(secondId).not.toBe(firstId);
  await expect(page.locator(`[data-chat-session="${firstId}"]`)).toHaveAttribute("hidden", "");

  await page.getByRole("combobox", { name: "Speech model" }).selectOption(speechShared);
  await page.getByRole("combobox", { name: "Speech voice" }).selectOption("nova");
  await page.getByRole("combobox", { name: "Voice transcription model" }).selectOption(
    transcriptionShared,
  );

  await openConversation(page, firstId);
  await expect(page.getByRole("combobox", { name: "Speech model" })).toHaveValue(speechShared);
  await expect(page.getByRole("combobox", { name: "Speech voice" })).toHaveValue("nova");
  await expect(page.getByRole("combobox", { name: "Voice transcription model" })).toHaveValue(
    transcriptionShared,
  );

  // The shared state is bidirectional rather than a one-time copy made during activation.
  await page.getByRole("combobox", { name: "Speech model" }).selectOption(speechPrimary);
  await page.getByRole("combobox", { name: "Speech voice" }).selectOption("coral");
  await page.getByRole("combobox", { name: "Voice transcription model" }).selectOption(
    transcriptionPrimary,
  );
  await openConversation(page, secondId);
  await expect(page.getByRole("combobox", { name: "Speech model" })).toHaveValue(speechPrimary);
  await expect(page.getByRole("combobox", { name: "Speech voice" })).toHaveValue("coral");
  await expect(page.getByRole("combobox", { name: "Voice transcription model" })).toHaveValue(
    transcriptionPrimary,
  );
});
