/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import { bootstrap, createChat, login } from "./helpers.ts";

declare global {
  var __speechPlays: number;
  var __speechPauses: number;
  var __speechRevokes: string[];
  interface Window {
    __speechPlays: number;
    __speechPauses: number;
    __speechRevokes: string[];
  }
}

test("assistant speech is capability-aware, exclusive, controllable, and cleaned up", async ({ page, request }) => {
  await bootstrap(request);
  await page.addInitScript(() => {
    localStorage.setItem("dg-chat.speech-model", "e2e/speech-alt");
    globalThis.__speechPlays = 0;
    globalThis.__speechPauses = 0;
    globalThis.__speechRevokes = [];
    let nextUrl = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => `blob:e2e-speech-${++nextUrl}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => globalThis.__speechRevokes.push(url),
    });
    class MockAudio extends EventTarget {
      src = "";
      currentTime = 0;
      duration = 125;
      preload = "";
      load() {
        this.dispatchEvent(new Event("durationchange"));
      }
      play() {
        globalThis.__speechPlays++;
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
      }
      pause() {
        globalThis.__speechPauses++;
        this.dispatchEvent(new Event("pause"));
      }
    }
    Object.defineProperty(window, "Audio", { configurable: true, value: MockAudio });
  });
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { data: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: [...payload.data, {
          id: "e2e/speech",
          displayName: "E2E Speech",
          provider: "e2e",
          capabilities: ["speech"],
          contextWindow: 4096,
        }, {
          id: "e2e/speech-alt",
          displayName: "E2E Speech Alternate",
          provider: "e2e",
          capabilities: ["speech"],
          contextWindow: 4096,
        }],
      },
    });
  });
  let speechBody: Record<string, unknown> | undefined;
  let conversationDetailGets = 0;
  await page.route("**/api/conversations/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      /^\/api\/conversations\/[0-9a-f-]+$/i.test(url.pathname)
    ) {
      conversationDetailGets += 1;
    }
    await route.continue();
  });
  await page.route("**/api/audio/speech", async (route) => {
    speechBody = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: "mock-mp3" });
  });

  await login(page);
  await createChat(page);
  await expect(page.getByRole("combobox", { name: "Speech model" })).toHaveValue(
    "e2e/speech-alt",
  );
  await page.getByRole("combobox", { name: "Speech model" }).selectOption("e2e/speech");
  await page.getByRole("combobox", { name: "Speech voice" }).selectOption("nova");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("read this polished response aloud");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/simulated response to: read this polished response aloud/i))
    .toBeVisible();

  const listen = page.getByRole("button", { name: "Read aloud", exact: true });
  await listen.click();
  await expect.poll(() => speechBody).toMatchObject({
    model: "e2e/speech",
    voice: "nova",
    response_format: "mp3",
  });
  await expect.poll(() => page.evaluate(() => globalThis.__speechPlays)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Pause read aloud" })).toBeVisible();
  expect(String(speechBody?.input)).toContain("This is a simulated response");
  await page.getByRole("button", { name: "Pause read aloud" }).click();
  await expect(page.getByRole("button", { name: "Resume read aloud" })).toBeVisible();
  const position = page.getByRole("slider", { name: "Speech playback position" });
  await position.fill("42");
  await expect(position).toHaveAttribute("aria-valuetext", "0:42 of 2:05");
  await page.getByRole("button", { name: "Resume read aloud" }).click();
  await expect(page.getByRole("button", { name: "Pause read aloud" })).toBeVisible();

  expect(await page.evaluate(() => globalThis.__speechPlays)).toBeGreaterThanOrEqual(2);
  const detailGetsBeforeFocus = conversationDetailGets;
  const revokesBeforeRefetch = await page.evaluate(() => globalThis.__speechRevokes.length);
  await page.evaluate(() => {
    // Advance only the query freshness clock so focus exercises a real no-op network refetch
    // without adding a 30-second wall-clock delay to every browser project.
    const actualNow = Date.now;
    const baseline = actualNow();
    const runtime = globalThis as typeof globalThis & { __restoreDateNow?: () => void };
    runtime.__restoreDateNow = () => {
      Date.now = actualNow;
    };
    Date.now = () => baseline + 31_000;
  });
  // A real offline/online transition drives TanStack's reconnect manager in headless Chromium;
  // synthetic focus events are intentionally ignored when the page never actually lost focus.
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await expect.poll(() => conversationDetailGets).toBeGreaterThan(detailGetsBeforeFocus);
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __restoreDateNow?: () => void };
    runtime.__restoreDateNow?.();
    delete runtime.__restoreDateNow;
  });
  await expect(page.getByRole("button", { name: "Pause read aloud" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.__speechRevokes.length)).toBe(revokesBeforeRefetch);

  await createChat(page);
  await expect.poll(() => page.evaluate(() => globalThis.__speechRevokes.length)).toBeGreaterThan(
    0,
  );
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ),
  ).toBe(true);
});

test("read aloud explains when no speech-capable model is available", async ({ page, request }) => {
  await bootstrap(request);
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as {
      data: Array<{ capabilities?: string[] }>;
    };
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: payload.data.filter((model) => !model.capabilities?.includes("speech")),
      },
    });
  });
  await login(page);
  await createChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("response without speech capability");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/simulated response to: response without speech capability/i))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Read aloud unavailable: no speech model" }))
    .toBeDisabled();
});
