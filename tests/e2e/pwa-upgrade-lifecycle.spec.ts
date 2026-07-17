/// <reference lib="dom" />

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { env } from "./env.ts";

type FixtureVersion = "n" | "n-plus-one";

function workerSource(version: FixtureVersion) {
  const cache = `dg-chat-upgrade-fixture-${version}`;
  const lazyAsset = `/pwa-fixture-lazy-${version}.js`;
  return `
const VERSION = ${JSON.stringify(version)};
const CACHE = ${JSON.stringify(cache)};
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((entry) => entry.add(${JSON.stringify(lazyAsset)})));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith("dg-chat-upgrade-fixture-") && key !== CACHE)
    .map((key) => caches.delete(key)))));
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === location.origin && url.pathname.startsWith("/pwa-fixture-lazy-")) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data === "DG_CHAT_FIXTURE_VERSION") event.ports[0]?.postMessage(VERSION);
});
`;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}

async function startUpgradeFixture(upstreamOrigin: string) {
  let version: FixtureVersion = "n";
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      if (path === "/sw.js") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/javascript; charset=utf-8",
          "Service-Worker-Allowed": "/",
        });
        response.end(workerSource(version));
        return;
      }
      if (path.startsWith("/pwa-fixture-lazy-")) {
        const requested = path === `/pwa-fixture-lazy-${version}.js`;
        response.writeHead(requested ? 200 : 404, {
          "Cache-Control": "no-store",
          "Content-Type": "application/javascript; charset=utf-8",
        });
        response.end(requested ? `export default ${JSON.stringify(version)};` : "not found");
        return;
      }

      const upstream = await fetch(new URL(request.url ?? "/", upstreamOrigin), {
        method: request.method,
        headers: { accept: request.headers.accept ?? "*/*" },
      });
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!["content-encoding", "content-length", "transfer-encoding"].includes(name)) {
          headers[name] = value;
        }
      });
      response.writeHead(upstream.status, headers);
      response.end(new Uint8Array(await upstream.arrayBuffer()));
    } catch (error) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "fixture proxy failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    deployNextVersion: () => {
      version = "n-plus-one";
    },
    close: () => closeServer(server),
  };
}

async function controlledVersion(page: Page): Promise<string | null> {
  return await page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return null;
    return await new Promise<string>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(
        () => reject(new Error("worker version response timed out")),
        3000,
      );
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      };
      controller.postMessage("DG_CHAT_FIXTURE_VERSION", [channel.port2]);
    });
  });
}

async function waitForWorkerControl(page: Page) {
  const controlled = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  });
  if (!controlled) await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => controlledVersion(page), { timeout: 15_000 }).not.toBeNull();
}

async function expectUpdateNoticeClearsComposer(page: Page) {
  await page.evaluate(() => {
    const composer = document.createElement("div");
    composer.className = "composer-wrap pwa-upgrade-composer-probe";
    Object.assign(composer.style, {
      position: "fixed",
      inset: "auto 0 0 0",
      height: "180px",
      background: "var(--bg)",
    });
    const send = document.createElement("button");
    send.type = "button";
    send.className = "send-button";
    send.setAttribute("aria-label", "Send");
    composer.append(send);
    document.body.append(composer);
  });
  const notice = page.locator(".pwa-update-notice");
  const composer = page.locator(".pwa-upgrade-composer-probe");
  await expect.poll(async () => {
    const [noticeBounds, composerBounds] = await Promise.all([
      notice.boundingBox(),
      composer.boundingBox(),
    ]);
    if (!noticeBounds || !composerBounds) return false;
    return noticeBounds.y + noticeBounds.height <= composerBounds.y;
  }).toBe(true);
  const noticeBounds = await notice.boundingBox();
  const viewport = page.viewportSize();
  expect(noticeBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(noticeBounds?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((noticeBounds?.x ?? 0) + (noticeBounds?.width ?? Number.POSITIVE_INFINITY))
    .toBeLessThanOrEqual(viewport?.width ?? 0);
  expect((noticeBounds?.y ?? 0) + (noticeBounds?.height ?? Number.POSITIVE_INFINITY))
    .toBeLessThanOrEqual(viewport?.height ?? 0);
}

test("a two-version update waits for every old client and retains old lazy chunks", async ({ context, page }) => {
  test.setTimeout(60_000);
  const baseURL = env("E2E_BASE_URL") ?? "http://localhost:5173";
  const manifest = await page.request.get(`${baseURL}/manifest.webmanifest`);
  if (!manifest.ok()) {
    if (env("CI") === "true" || env("E2E_EXPECT_PWA") === "true") {
      expect(manifest.ok(), "the production deployment must provide its PWA build").toBe(true);
    }
    test.skip(true, "The development server does not generate a production PWA.");
    return;
  }

  const fixture = await startUpgradeFixture(new URL(baseURL).origin);
  const secondPage = await context.newPage();
  try {
    await page.goto(`${fixture.origin}/forgot-password`);
    await waitForWorkerControl(page);
    expect(await controlledVersion(page)).toBe("n");

    await secondPage.goto(`${fixture.origin}/forgot-password`);
    await waitForWorkerControl(secondPage);
    expect(await controlledVersion(secondPage)).toBe("n");

    fixture.deployNextVersion();
    await Promise.all([page, secondPage].map((client) =>
      client.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        await registration.update();
      })
    ));
    await expect.poll(
      () => page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting)),
      { timeout: 15_000 },
    ).toBe(true);
    await expect(page.getByText("An update is ready", { exact: true })).toBeVisible();
    await expect(secondPage.getByText("An update is ready", { exact: true })).toBeVisible();
    await expectUpdateNoticeClearsComposer(page);
    await expectUpdateNoticeClearsComposer(secondPage);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await controlledVersion(page)).toBe("n");
    expect(await controlledVersion(secondPage)).toBe("n");
    expect(
      await page.evaluate(async () => {
        const response = await fetch("/pwa-fixture-lazy-n.js");
        return { ok: response.ok, status: response.status, body: await response.text() };
      }),
    ).toEqual({ ok: true, status: 200, body: 'export default "n";' });

    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await controlledVersion(secondPage)).toBe("n");
    await secondPage.close();

    // Once no N client remains, the browser can activate N+1 without an app-issued skipWaiting.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const upgradedPage = await context.newPage();
    try {
      await upgradedPage.goto(`${fixture.origin}/forgot-password`);
      await waitForWorkerControl(upgradedPage);
      await expect.poll(() => controlledVersion(upgradedPage), { timeout: 15_000 })
        .toBe("n-plus-one");
    } finally {
      await upgradedPage.close();
    }
  } finally {
    if (!page.isClosed()) await page.close();
    if (!secondPage.isClosed()) await secondPage.close();
    await fixture.close();
  }
});
