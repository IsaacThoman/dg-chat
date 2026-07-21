/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import { activeChatSession, bootstrap, createChat, login, openSidebar } from "./helpers.ts";

declare global {
  interface Window {
    __voiceTrackStops: number;
    __voiceObjectUrls: string[];
    __voiceRevokedUrls: string[];
    __voiceTranscriptionStarted: number;
    __voiceTranscriptionAborted: number;
    __voiceRecorderLast?: EventTarget;
    __resolveLateVoiceTranscription?: () => void;
  }
}

async function activeConversationId(page: import("@playwright/test").Page): Promise<string> {
  const value = await page.locator(".conversation-row.active [data-conversation-actions]")
    .getAttribute("data-conversation-actions");
  expect(value).toBeTruthy();
  return value!;
}

async function openConversation(
  page: import("@playwright/test").Page,
  conversationId: string,
): Promise<void> {
  const sidebar = await openSidebar(page);
  await sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${conversationId}"]) button.conversation-open`,
  ).click();
  await expect(activeChatSession(page)).toHaveAttribute("data-chat-session", conversationId);
}

test("inactive chats release recording, preview, and transcription resources without late insertion", async ({ page, request }) => {
  test.setTimeout(90_000);
  await bootstrap(request);
  await page.addInitScript(() => {
    globalThis.__voiceTrackStops = 0;
    globalThis.__voiceObjectUrls = [];
    globalThis.__voiceRevokedUrls = [];
    globalThis.__voiceTranscriptionStarted = 0;
    globalThis.__voiceTranscriptionAborted = 0;

    let objectUrlSequence = 0;
    URL.createObjectURL = () => {
      const value = `blob:voice-e2e-${++objectUrlSequence}`;
      globalThis.__voiceObjectUrls.push(value);
      return value;
    };
    URL.revokeObjectURL = (value) => globalThis.__voiceRevokedUrls.push(value);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => {
          const track = Object.assign(new EventTarget(), {
            stop: () => globalThis.__voiceTrackStops++,
          });
          return Promise.resolve({ getTracks: () => [track] });
        },
      },
    });
    class TestMediaRecorder extends EventTarget {
      static isTypeSupported(type: string) {
        return type.startsWith("audio/webm");
      }
      state: RecordingState = "inactive";
      mimeType: string;
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super();
        this.mimeType = options?.mimeType ?? "audio/webm";
        globalThis.__voiceRecorderLast = this;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        queueMicrotask(() => {
          const available = new Event("dataavailable") as BlobEvent;
          Object.defineProperty(available, "data", {
            value: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], {
              type: this.mimeType,
            }),
          });
          this.dispatchEvent(available);
          this.dispatchEvent(new Event("stop"));
        });
      }
    }
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: TestMediaRecorder,
    });

    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/api/audio/transcriptions")) return nativeFetch(input, init);
      globalThis.__voiceTranscriptionStarted++;
      init?.signal?.addEventListener(
        "abort",
        () => globalThis.__voiceTranscriptionAborted++,
        { once: true },
      );
      return new Promise<Response>((resolve) => {
        globalThis.__resolveLateVoiceTranscription = () =>
          resolve(Response.json({ text: "must never be inserted" }));
      });
    };
  });
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { data: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: [...payload.data, {
          id: "e2e/voice-cleanup",
          displayName: "E2E Voice Cleanup",
          provider: "e2e",
          capabilities: ["transcription"],
          contextWindow: 8192,
        }],
      },
    });
  });

  await login(page);
  await createChat(page);
  const ownerId = await activeConversationId(page);
  const draft = "Do not mutate this retained draft";
  await page.getByRole("textbox", { name: "Message" }).fill(draft);

  // An actual active MediaRecorder must stop when its owning chat becomes inactive.
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await createChat(page);
  await expect.poll(() => page.evaluate(() => globalThis.__voiceTrackStops)).toBeGreaterThan(0);
  await page.evaluate(() => globalThis.__voiceRecorderLast?.dispatchEvent(new Event("error")));
  await openConversation(page, ownerId);
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeVisible();
  await expect(page.getByText("The recording stopped unexpectedly.", { exact: true }))
    .toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(draft);

  // A completed preview owns a blob URL which must be revoked on deactivation.
  await page.getByRole("button", { name: "Start voice input" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Recording ready", { exact: true })).toBeVisible();
  const previewUrl = await page.evaluate(() => globalThis.__voiceObjectUrls.at(-1));
  expect(previewUrl).toBeTruthy();
  await createChat(page);
  await expect.poll(() =>
    page.evaluate((url) => globalThis.__voiceRevokedUrls.includes(url), previewUrl!)
  ).toBe(true);
  await openConversation(page, ownerId);
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeVisible();

  // Even a fetch implementation which resolves after abort cannot insert into the hidden draft.
  await page.getByRole("button", { name: "Start voice input" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Insert transcript", exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__voiceTranscriptionStarted)).toBe(1);
  await createChat(page);
  await expect.poll(() => page.evaluate(() => globalThis.__voiceTranscriptionAborted)).toBe(1);
  await page.evaluate(() => globalThis.__resolveLateVoiceTranscription?.());
  await page.waitForTimeout(100);
  await openConversation(page, ownerId);
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(draft);
  await expect(page.getByRole("textbox", { name: "Message" })).not.toHaveValue(
    /must never be inserted/,
  );
});
