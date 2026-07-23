/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import { activeChatSession, bootstrap, createChat, login } from "./helpers.ts";

type CaptureTestState = {
  mode: "success" | "denied" | "pending";
  uploadCount: number;
  trackStops: number;
  urlRevocations: number;
  requested: number;
  forcedUseClicks: number;
  forcedUseWasConnected: boolean;
  resolvePending?: () => void;
};

async function installCaptureMock(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const state: CaptureTestState = {
      mode: "success",
      uploadCount: 0,
      trackStops: 0,
      urlRevocations: 0,
      requested: 0,
      forcedUseClicks: 0,
      forcedUseWasConnected: false,
    };
    Object.defineProperty(globalThis, "__captureTest", { value: state, configurable: true });
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      state.urlRevocations++;
      revokeObjectURL(url);
    };
    const makeStream = () => {
      // srcObject performs a WebIDL brand check in Chromium. A structural object cast to
      // MediaStream therefore cannot exercise the success path; use a real canvas-backed stream
      // and instrument its real video track instead.
      const source = document.createElement("canvas");
      source.width = 2;
      source.height = 2;
      const stream = source.captureStream(1);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          state.trackStops++;
          stop();
        };
      }
      return stream;
    };
    const mediaDevices = navigator.mediaDevices ?? {};
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: mediaDevices,
      });
    }
    Object.defineProperty(mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        state.requested++;
        if (state.mode === "denied") throw new DOMException("denied", "NotAllowedError");
        if (state.mode === "pending") {
          return await new Promise<MediaStream>((resolve) => {
            state.resolvePending = () => resolve(makeStream());
          });
        }
        return makeStream();
      },
    });
    Object.defineProperties(HTMLVideoElement.prototype, {
      videoWidth: { configurable: true, get: () => 1_280 },
      videoHeight: { configurable: true, get: () => 720 },
      readyState: { configurable: true, get: () => HTMLMediaElement.HAVE_CURRENT_DATA },
    });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => undefined;
    HTMLMediaElement.prototype.load = () => undefined;
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => undefined,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      const png = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      );
      callback(new Blob([png], { type: type ?? "image/png" }));
    };
  });
}

test.beforeEach(async ({ page, request }, testInfo) => {
  testInfo.setTimeout(90_000);
  await installCaptureMock(page);
  await bootstrap(request);
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
            id: "e2e/text-only",
            displayName: "E2E text only",
            provider: "e2e",
            capabilities: ["chat", "streaming"],
            contextWindow: 8_192,
          },
        ],
      },
    });
  });
  await login(page);
  await createChat(page);

  // Model choice is an intentionally persisted user preference. Each test must establish its
  // vision-capable precondition because the downgrade journeys below leave the shared full-stack
  // administrator on the text-only model for the next test (and for Playwright retries).
  const session = activeChatSession(page);
  const modelTrigger = session.locator('button.model-trigger[aria-haspopup="listbox"]');
  await expect(modelTrigger).not.toContainText("No chat model");
  if (!(await modelTrigger.textContent())?.includes("DG Chat Simulated")) {
    await modelTrigger.click();
    const preferenceSaved = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === "/api/preferences"
    );
    await page.getByRole("option", { name: /DG Chat Simulated/ }).click();
    const preferenceResponse = await preferenceSaved;
    expect(
      preferenceResponse.ok(),
      preferenceResponse.ok() ? "vision model preference saved" : await preferenceResponse.text(),
    ).toBeTruthy();
  }
  await expect(modelTrigger).toContainText("DG Chat Simulated");
  await expect(session.getByRole("button", { name: "Capture screen", exact: true })).toBeEnabled();
});

test("previews a normalized still before routing it through the attachment uploader", async ({ page }) => {
  let uploadBody = "";
  let uploadedFilename = "";
  await page.route("**/api/attachments", async (route) => {
    const state = await page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
    );
    uploadBody = route.request().postDataBuffer()?.toString("utf8") ?? "";
    uploadedFilename = /filename="([^"]+)"/u.exec(uploadBody)?.[1] ?? "";
    await page.evaluate(() => {
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
        .uploadCount++;
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      json: {
        attachment: {
          id: "captured-screen",
          filename: uploadedFilename,
          mimeType: "image/png",
          sizeBytes: 68,
          state: "ready",
          createdAt: new Date().toISOString(),
        },
        observedUploads: state.uploadCount,
      },
    });
  });

  const session = activeChatSession(page);
  await session.getByRole("button", { name: "Capture screen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Capture your screen" });
  await expect(dialog).toContainText("review it before anything uploads");
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
        .uploadCount
    )
  ).toBe(0);

  await dialog.getByRole("button", { name: "Choose screen", exact: true }).click();
  await expect(dialog.getByAltText("Preview of the captured screen")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Use screenshot", exact: true })).toBeFocused();
  await expect(dialog.getByRole("status")).toContainText("1280 × 720");
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
        .trackStops
    )
  ).toBe(1);
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
        .uploadCount
    )
  ).toBe(0);

  await dialog.getByRole("button", { name: "Use screenshot", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => uploadedFilename).toMatch(
    /^screen-capture-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z\.png$/u,
  );
  await expect(
    session.locator(".upload-ready").getByText(uploadedFilename, { exact: true }),
  ).toBeVisible();
  expect(uploadBody).toContain(`filename="${uploadedFilename}"`);
  expect(uploadBody).toContain("Content-Type: image/png");
  await expect(session.getByRole("button", { name: "Capture screen", exact: true }))
    .toBeFocused();
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
        .urlRevocations
    )
  ).toBe(1);
});

test("keeps denials and a late permission result private, stopped, and retryable", async ({ page }) => {
  let uploadRequests = 0;
  await page.route("**/api/attachments", async (route) => {
    uploadRequests++;
    await route.abort();
  });
  const trackStops = () =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
        .trackStops
    );
  const session = activeChatSession(page);
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest.mode =
      "denied";
  });
  await session.getByRole("button", { name: "Capture screen", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Capture your screen" });
  await dialog.getByRole("button", { name: "Choose screen", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("cancelled or denied");
  const tryAgain = dialog.getByRole("button", { name: "Try again", exact: true });
  await expect(tryAgain).toBeFocused();
  await tryAgain.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(tryAgain).toBeFocused();
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  expect(uploadRequests).toBe(0);
  expect(await trackStops()).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest.mode =
      "pending";
  });
  await session.getByRole("button", { name: "Capture screen", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Capture your screen" });
  await dialog.getByRole("button", { name: "Choose screen", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Waiting for your screen selection");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
      .resolvePending?.();
  });
  await expect.poll(trackStops).toBe(1);
  await expect(page.getByRole("dialog", { name: "Capture your screen" })).toBeHidden();
  expect(uploadRequests).toBe(0);
});

test("cancels and fences a pending capture when the selected model loses vision", async ({ page }) => {
  let uploadRequests = 0;
  await page.route("**/api/attachments", async (route) => {
    uploadRequests++;
    await route.abort();
  });
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest.mode =
      "pending";
  });
  const session = activeChatSession(page);
  await session.getByRole("button", { name: "Capture screen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Capture your screen" });
  await dialog.getByRole("button", { name: "Choose screen", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();

  await session.locator('button.model-trigger[aria-haspopup="listbox"]').dispatchEvent("click");
  await page.locator('[data-slot="select-content"][data-open] [role="option"]', {
    hasText: "E2E text only",
  }).dispatchEvent("click");
  await expect(dialog).toBeHidden();
  const unavailableCapture = session.getByRole("button", {
    name: "Capture screen unavailable: the selected model does not support images",
  });
  await expect(unavailableCapture).toHaveAttribute("aria-disabled", "true");
  await unavailableCapture.focus();
  await expect(unavailableCapture).toBeFocused();
  const explanationId = await unavailableCapture.getAttribute("aria-describedby");
  expect(explanationId).toBeTruthy();
  await expect(session.locator(`[id="${explanationId}"]`)).toBeVisible();
  await expect(session.locator(`[id="${explanationId}"]`)).toContainText(
    "selected model does not support images",
  );

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
      .resolvePending?.();
  });
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
        .trackStops
    )
  ).toBe(1);
  expect(uploadRequests).toBe(0);
});

test("synchronously fences Use Screenshot on an immediate model capability downgrade", async ({ page }) => {
  let uploadRequests = 0;
  await page.route("**/api/attachments", async (route) => {
    uploadRequests++;
    await route.abort();
  });
  const session = activeChatSession(page);
  await session.getByRole("button", { name: "Capture screen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Capture your screen" });
  await dialog.getByRole("button", { name: "Choose screen", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Use screenshot", exact: true })).toBeFocused();

  await session.locator('button.model-trigger[aria-haspopup="listbox"]').dispatchEvent("click");
  await page.evaluate(() => {
    const testState = (globalThis as typeof globalThis & { __captureTest: CaptureTestState })
      .__captureTest;
    const option = [...document.querySelectorAll<HTMLElement>(
      '[data-slot="select-content"][data-open] [role="option"]',
    )].find((item) => item.textContent?.includes("E2E text only"));
    const useScreenshot = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.trim() === "Use screenshot"
    );
    if (!option || !useScreenshot) throw new Error("mounted downgrade controls are missing");
    // React handles the option click at its root before the event reaches document. Attempt the
    // preview action later in that same native event task: the new render has committed, while the
    // passive cancellation effect has not had an opportunity to be the safety mechanism.
    document.addEventListener("click", () => {
      testState.forcedUseClicks++;
      testState.forcedUseWasConnected = useScreenshot.isConnected;
      useScreenshot.click();
    }, { once: true });
    option.click();
  });

  await expect.poll(() =>
    page.evaluate(() => {
      const state = (globalThis as typeof globalThis & { __captureTest: CaptureTestState })
        .__captureTest;
      return { clicks: state.forcedUseClicks, connected: state.forcedUseWasConnected };
    })
  ).toEqual({ clicks: 1, connected: true });
  await expect(dialog).toBeHidden();
  const unavailableCapture = session.getByRole("button", {
    name: "Capture screen unavailable: the selected model does not support images",
  });
  await expect(unavailableCapture).toHaveAttribute("aria-disabled", "true");
  // aria-disabled remains intentionally focusable/click-explanatory, while Playwright correctly
  // excludes it from ordinary actionable controls. Force the pointer event to exercise that
  // explicit explanatory path without pretending the capture action itself is enabled.
  await unavailableCapture.click({ force: true });
  const explanationId = await unavailableCapture.getAttribute("aria-describedby");
  expect(explanationId).toBeTruthy();
  await expect(session.locator(`[id="${explanationId}"]`)).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureTest: CaptureTestState }).__captureTest
        .urlRevocations
    )
  ).toBe(1);
  expect(uploadRequests).toBe(0);
});
