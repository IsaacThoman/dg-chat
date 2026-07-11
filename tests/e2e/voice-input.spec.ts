import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

declare global {
  interface Window {
    __voiceTrackStops: number;
  }
}

test("voice recording previews, retries transcription, and inserts without sending", async ({ page, request }) => {
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
  await page.route("**/v1/audio/transcriptions", async (route) => {
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { text: "inserted voice transcript" },
    });
  });

  await login(page);
  await createChat(page);
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
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Recording");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Recording ready", { exact: true })).toBeVisible();
  await expect(page.locator("audio")).toBeVisible();

  await page.getByRole("button", { name: "Insert transcript", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.locator("audio")).toBeVisible();
  await page.getByRole("button", { name: "Insert transcript", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Transcribing");
  await composer.fill("Draft before after plus concurrent edit");
  await expect(composer).toHaveValue(
    "Draft before after plus concurrent edit inserted voice transcript",
  );
  await expect(page.locator("article.user-message")).toHaveCount(0);
  expect(attempts).toBe(2);
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
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeFocused();
  await page.waitForTimeout(300);
  await expect(composer).toHaveValue(beforeCancel);
});

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
