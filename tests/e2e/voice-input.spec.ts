/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import { activeChatSession, bootstrap, createChat, login, openSidebar } from "./helpers.ts";

declare global {
  interface Window {
    __voiceTrackStops: number;
  }
  var __voiceTrackStops: number;
}

test(
  "voice recording previews, retries transcription, and inserts without sending",
  async ({ page, request }, testInfo) => {
    // This journey intentionally covers reload persistence, retry, concurrent draft editing, and
    // cancellation. Preserve the normal action/assertion deadlines while allowing all four flows
    // to complete on a populated self-hosted installation.
    testInfo.setTimeout(90_000);
    await bootstrap(request);
    await page.addInitScript(() => {
      try {
        localStorage.setItem("dg-chat.transcription-model", "e2e/transcribe-alt");
      } catch {
        // The initial opaque document has no storage; the target document does.
      }
      globalThis.__voiceTrackStops = 0;
      const track = Object.assign(new EventTarget(), {
        stop: () => globalThis.__voiceTrackStops++,
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: () => Promise.resolve({ getTracks: () => [track] }) },
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
      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        value: TestMediaRecorder,
      });
    });
    await page.route("**/api/models", async (route) => {
      const upstream = await route.fetch();
      const payload = await upstream.json() as { data: unknown[] };
      await route.fulfill({
        response: upstream,
        json: {
          ...payload,
          data: [
            ...payload.data,
            {
              id: "e2e/transcribe",
              displayName: "E2E Transcription",
              provider: "e2e",
              capabilities: ["transcription"],
              contextWindow: 8192,
            },
            {
              id: "e2e/transcribe-alt",
              displayName: "E2E Transcription Alternate",
              provider: "e2e",
              capabilities: ["transcription"],
              contextWindow: 8192,
            },
          ],
        },
      });
    });
    let attempts = 0;
    let multipart = "";
    let releaseStaleTranscription: (() => void) | undefined;
    const staleTranscriptionMayFinish = new Promise<void>((resolve) => {
      releaseStaleTranscription = resolve;
    });
    let releaseSuccessfulTranscription: (() => void) | undefined;
    const successfulTranscriptionMayFinish = new Promise<void>((resolve) => {
      releaseSuccessfulTranscription = resolve;
    });
    let releaseCancelledTranscription: (() => void) | undefined;
    const cancelledTranscriptionMayFinish = new Promise<void>((resolve) => {
      releaseCancelledTranscription = resolve;
    });
    await page.route("**/api/audio/transcriptions", async (route) => {
      attempts++;
      multipart = route.request().postDataBuffer()?.toString("utf8") ?? "";
      if (attempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          json: {
            error: { message: "Transcription is temporarily unavailable", code: "provider_error" },
          },
        });
        return;
      }
      if (attempts === 2) {
        await staleTranscriptionMayFinish;
      } else if (attempts === 3) {
        await successfulTranscriptionMayFinish;
      } else {
        await cancelledTranscriptionMayFinish;
      }
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: { text: "inserted voice transcript" },
        });
      } catch {
        // The cancellation flow deliberately aborts its intercepted request before releasing it.
      }
    });

    await login(page);
    await createChat(page);
    const firstId = await page.locator(".conversation-row.active [data-conversation-actions]")
      .getAttribute("data-conversation-actions");
    expect(firstId).toBeTruthy();
    const voiceModel = page.getByRole("combobox", { name: "Voice transcription model" });
    await expect(voiceModel).toHaveValue("e2e/transcribe-alt");
    await page.reload();
    await expect(voiceModel).toHaveValue("e2e/transcribe-alt");
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth
      ),
    ).toBe(true);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Draft before after");
    await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 6));

    await page.getByRole("button", { name: "Start voice input" }).click();
    const stopRecording = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stopRecording).toBeVisible();
    await expect(stopRecording).toBeFocused();
    if (testInfo.project.name === "mobile-chromium") {
      expect((await stopRecording.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByLabel("Voice input", { exact: true }).getByRole("status"))
      .toContainText("Recording");
    await stopRecording.click();
    await expect(page.getByText("Recording ready", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Insert transcript", exact: true }))
      .toBeFocused();
    await expect(page.locator("audio")).toBeVisible();

    await page.getByRole("button", { name: "Insert transcript", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
    await expect(page.getByRole("button", { name: "Insert transcript", exact: true }))
      .toBeFocused();
    await expect(page.locator("audio")).toBeVisible();
    await page.getByRole("button", { name: "Insert transcript", exact: true }).click();
    await expect(page.getByLabel("Voice input", { exact: true }).getByRole("status"))
      .toContainText("Transcribing");
    await expect(page.getByRole("button", { name: "Cancel transcription" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

    // Switching chats is an explicit cancellation boundary. Even if the old HTTP response wins
    // a same-task race with effect cleanup, its target token no longer matches and it cannot write
    // into either retained composer.
    await createChat(page);
    releaseStaleTranscription?.();
    const sidebar = await openSidebar(page);
    await sidebar.locator(
      `.conversation-row:has([data-conversation-actions="${firstId}"]) button.conversation-open`,
    ).click();
    await expect(activeChatSession(page).getByRole("button", { name: "Start voice input" }))
      .toBeVisible();
    await expect(composer).toHaveValue("Draft before after");
    await page.waitForTimeout(100);
    await expect(composer).not.toHaveValue(/inserted voice transcript/);

    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText("Recording ready", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Insert transcript", exact: true }).click();
    await expect(page.getByLabel("Voice input", { exact: true }).getByRole("status"))
      .toContainText("Transcribing");
    const concurrentDraft = Array.from(
      { length: 14 },
      (_, index) => `Draft before after plus concurrent edit line ${index + 1}`,
    ).join("\n");
    await composer.fill(concurrentDraft);
    releaseSuccessfulTranscription?.();
    await expect(composer).toHaveValue(
      `${concurrentDraft} inserted voice transcript`,
    );
    const transcribedBounds = await composer.boundingBox();
    expect(transcribedBounds?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(160);
    expect(await composer.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await expect(activeChatSession(page).locator("article.user-message")).toHaveCount(0);
    expect(attempts).toBe(3);
    expect(multipart).toContain('name="model"');
    expect(multipart).toContain("e2e/transcribe-alt");
    expect(multipart).toContain('name="file"');
    expect(await page.evaluate(() => globalThis.__voiceTrackStops)).toBeGreaterThanOrEqual(1);

    const beforeCancel = await composer.inputValue();
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText("Recording ready", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Insert transcript", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel transcription" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel transcription" }).click();
    releaseCancelledTranscription?.();
    await expect(page.getByRole("button", { name: "Start voice input" })).toBeFocused();
    await page.waitForTimeout(300);
    await expect(composer).toHaveValue(beforeCancel);
  },
);

test("voice cancellation releases the microphone and restores the idle control", async ({ page, request }) => {
  await bootstrap(request);
  await page.addInitScript(() => {
    globalThis.__voiceTrackStops = 0;
    const track = Object.assign(new EventTarget(), {
      stop: () => globalThis.__voiceTrackStops++,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve({ getTracks: () => [track] }) },
    });
    class TestMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
      }
    }
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: TestMediaRecorder,
    });
  });
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { data: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: [...payload.data, {
          id: "e2e/transcribe",
          displayName: "E2E Transcription",
          provider: "e2e",
          capabilities: ["transcription"],
          contextWindow: 8192,
        }],
      },
    });
  });
  await login(page);
  await createChat(page);
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).press("Escape");
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeFocused();
  expect(await page.evaluate(() => globalThis.__voiceTrackStops)).toBeGreaterThanOrEqual(1);
});

test("switching chats cancels a pending microphone permission request", async ({ page, request }) => {
  await bootstrap(request);
  await page.addInitScript(() => {
    globalThis.__voiceTrackStops = 0;
    let resolvePermission: ((stream: { getTracks: () => EventTarget[] }) => void) | undefined;
    const permission = new Promise<{ getTracks: () => EventTarget[] }>((resolve) => {
      resolvePermission = resolve;
    });
    const track = Object.assign(new EventTarget(), {
      stop: () => globalThis.__voiceTrackStops++,
    });
    Object.assign(globalThis, {
      __resolveVoicePermission: () => resolvePermission?.({ getTracks: () => [track] }),
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => permission },
    });
    class TestMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
      }
    }
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: TestMediaRecorder,
    });
  });
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { data: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: [...payload.data, {
          id: "e2e/transcribe",
          displayName: "E2E Transcription",
          provider: "e2e",
          capabilities: ["transcription"],
          contextWindow: 8192,
        }],
      },
    });
  });

  await login(page);
  await createChat(page);
  const firstId = await page.locator(".conversation-row.active [data-conversation-actions]")
    .getAttribute("data-conversation-actions");
  expect(firstId).toBeTruthy();
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByLabel("Voice input", { exact: true }).getByRole("status"))
    .toContainText("Waiting for microphone permission");

  await createChat(page);
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __resolveVoicePermission?: () => void })
      .__resolveVoicePermission?.();
  });
  await expect.poll(() => page.evaluate(() => globalThis.__voiceTrackStops)).toBe(1);

  const sidebar = await openSidebar(page);
  await sidebar.locator(
    `.conversation-row:has([data-conversation-actions="${firstId}"]) button.conversation-open`,
  ).click();
  await expect(activeChatSession(page).getByRole("button", { name: "Start voice input" }))
    .toBeVisible();
});

test("voice control explains an unsupported browser before requesting permission", async ({ page, request }) => {
  await bootstrap(request);
  await page.addInitScript(() => {
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  });
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { data: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: [...payload.data, {
          id: "e2e/transcribe",
          displayName: "E2E Transcription",
          provider: "e2e",
          capabilities: ["transcription"],
          contextWindow: 8192,
        }],
      },
    });
  });
  await login(page);
  await createChat(page);
  await expect(page.getByRole("button", {
    name: "Voice input unavailable: voice recording is not supported by this browser",
  })).toBeDisabled();
});
