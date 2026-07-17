/// <reference lib="dom" />

import { type BrowserContext, expect, type Response, test } from "@playwright/test";
import { env } from "./env.ts";

interface WebAppManifest {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>;
}

async function expectOfflineNavigationFailure(context: BrowserContext, path: string) {
  const page = await context.newPage();
  let response: Response | null = null;
  let navigationError: unknown;
  try {
    response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 8_000 });
  } catch (error) {
    navigationError = error;
  } finally {
    await page.close();
  }

  expect(response, `${path} must not receive the cached SPA shell`).toBeNull();
  expect(navigationError, `${path} must reach the unavailable network`).toBeTruthy();
}

async function expectOnlineServerNavigation(context: BrowserContext, path: string) {
  const page = await context.newPage();
  try {
    const response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 8_000 });
    expect(response, `${path} must receive a server response`).not.toBeNull();
    expect(response?.fromServiceWorker(), `${path} must bypass the SPA navigation handler`).toBe(
      false,
    );
    expect(response?.headers()["content-type"] ?? "", `${path} must not serve the SPA shell`)
      .not.toContain("text/html");
  } finally {
    await page.close();
  }
}

test("production PWA precaches only the product shell and excludes server-owned routes", async ({ context, page }) => {
  test.setTimeout(60_000);
  const navigationResponse = await page.goto("/forgot-password");

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  if (!manifestHref) {
    if (env("CI") === "true" || env("E2E_EXPECT_PWA") === "true") {
      expect(manifestHref, "the production deployment must advertise its web app manifest")
        .toBeTruthy();
    }
    test.skip(true, "The Vite development server does not generate the production PWA.");
    return;
  }

  expect(navigationResponse?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(navigationResponse?.headers()["content-security-policy"]).toBe(
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; " +
      "form-action 'self'; frame-ancestors 'none'; frame-src 'none'; " +
      "img-src 'self' data: blob: https:; manifest-src 'self'; media-src 'self' blob:; " +
      "object-src 'none'; script-src 'self'; script-src-attr 'none'; " +
      "style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
  );
  await expect(page.getByRole("heading", { name: "Reset your password", exact: true }))
    .toBeVisible();
  const executableScripts = await page.locator("script").evaluateAll((scripts) =>
    scripts.map((script) => ({
      source: script.getAttribute("src"),
      body: script.textContent ?? "",
    }))
  );
  expect(executableScripts.length).toBeGreaterThan(0);
  expect(executableScripts.every(({ source, body }) => source?.startsWith("/") && !body.trim()))
    .toBe(true);

  const themeBootstrap = await page.request.get("/theme-bootstrap.js");
  expect(themeBootstrap.ok()).toBe(true);
  expect(themeBootstrap.headers()["content-type"]).toContain("javascript");
  expect(themeBootstrap.headers()["x-content-type-options"]).toBe("nosniff");

  const manifestResponse = await page.request.get(manifestHref);
  expect(manifestResponse.ok()).toBe(true);
  expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = await manifestResponse.json() as WebAppManifest;
  expect(manifest).toMatchObject({
    id: "/",
    name: "DG Chat",
    short_name: "DG Chat",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    }),
    expect.objectContaining({
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    }),
    expect.objectContaining({
      src: "/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    }),
  ]));
  for (const icon of manifest.icons ?? []) {
    expect(icon.src, "every manifest icon needs a fetchable source").toBeTruthy();
    const iconResponse = await page.request.get(icon.src!);
    expect(iconResponse.ok(), `${icon.src} should be fetchable`).toBe(true);
    expect(iconResponse.headers()["content-type"]).toContain(icon.type ?? "image/");
    expect((await iconResponse.body()).byteLength, `${icon.src} should not be empty`)
      .toBeGreaterThan(
        0,
      );
  }
  const maskableIcon = await page.evaluate(async () => {
    const decode = async (source: string) => {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Unable to fetch ${source}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas 2D is unavailable");
      context.drawImage(bitmap, 0, 0);
      return {
        width: bitmap.width,
        height: bitmap.height,
        pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
      };
    };
    const [maskable, ordinary] = await Promise.all([
      decode("/icon-maskable-512.png"),
      decode("/icon-512.png"),
    ]);
    const background = [0x17, 0x13, 0x1f, 0xff];
    const center = maskable.width / 2;
    const safeRadius = maskable.width * 0.4;
    let foregroundPixels = 0;
    let transparentPixels = 0;
    let unsafeForegroundPixels = 0;
    let differsFromOrdinary = false;
    for (let offset = 0; offset < maskable.pixels.length; offset += 4) {
      const pixel = offset / 4;
      const x = pixel % maskable.width;
      const y = Math.floor(pixel / maskable.width);
      if (maskable.pixels[offset + 3] !== 255) transparentPixels++;
      if (!differsFromOrdinary) {
        for (let channel = 0; channel < 4; channel++) {
          if (maskable.pixels[offset + channel] !== ordinary.pixels[offset + channel]) {
            differsFromOrdinary = true;
            break;
          }
        }
      }
      let isBackground = true;
      for (let channel = 0; channel < 4; channel++) {
        if (maskable.pixels[offset + channel] !== background[channel]) {
          isBackground = false;
          break;
        }
      }
      if (!isBackground) {
        foregroundPixels++;
        if (Math.hypot(x + 0.5 - center, y + 0.5 - center) > safeRadius) {
          unsafeForegroundPixels++;
        }
      }
    }
    const corners = [[0, 0], [maskable.width - 1, 0], [0, maskable.height - 1], [
      maskable.width - 1,
      maskable.height - 1,
    ]].map(([x, y]) => {
      const offset = (y * maskable.width + x) * 4;
      return [...maskable.pixels.slice(offset, offset + 4)];
    });
    return {
      width: maskable.width,
      height: maskable.height,
      corners,
      foregroundPixels,
      transparentPixels,
      unsafeForegroundPixels,
      differsFromOrdinary,
    };
  });
  expect(maskableIcon).toMatchObject({
    width: 512,
    height: 512,
    corners: Array(4).fill([0x17, 0x13, 0x1f, 0xff]),
    transparentPixels: 0,
    unsafeForegroundPixels: 0,
    differsFromOrdinary: true,
  });
  expect(maskableIcon.foregroundPixels).toBeGreaterThan(10_000);
  for (
    const path of [
      "/api",
      "/v1",
      "/health/",
      "/ready/replica",
      "/metrics/",
    ]
  ) {
    const serverOwnedResponse = await page.request.get(path);
    expect(serverOwnedResponse.headers()["content-type"] ?? "", `${path} must not serve the SPA`)
      .not.toContain("text/html");
  }
  for (const path of ["/metrics", "/metrics/", "/metrics/internal"]) {
    const metricsResponse = await page.request.get(path);
    expect(metricsResponse.status(), `${path} must be unavailable on the public proxy`).toBe(404);
    expect(metricsResponse.headers()["content-type"]).toContain("application/json");
    expect(await metricsResponse.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  }

  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("Service workers are unavailable");
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Service worker activation timed out")), 15_000)
      ),
    ]);
  });
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await expect.poll(
    () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    { timeout: 15_000, message: "the production page to be controlled by its service worker" },
  ).toBe(true);
  const workers = context.serviceWorkers();
  expect(workers.length).toBeGreaterThan(0);
  expect(workers.some((worker) => new URL(worker.url()).pathname === "/sw.js")).toBe(true);

  // Version N must retain its precache while any version-N client remains open. In particular,
  // version N+1 must not claim this page or skip its waiting phase, because that could delete an
  // old lazy chunk while another tab is streaming or holding a draft.
  const workerSource = await (await page.request.get("/sw.js")).text();
  // Workbox's prompt mode retains one guarded SKIP_WAITING message handler. DG Chat deliberately
  // never calls the returned activation function; an unconditional install-time skip would add a
  // second call (and omit this waiting-only lifecycle).
  expect(workerSource).toContain("SKIP_WAITING");
  expect(workerSource.match(/\.skipWaiting\s*\(/g)).toHaveLength(1);
  expect(workerSource).not.toMatch(/clientsClaim\s*\(/);
  const precachedScripts = [...workerSource.matchAll(/url:\s*"(assets\/[^"?]+\.js)"/g)]
    .map((match) => match[1]);
  expect(precachedScripts.length, "version N must retain its split JavaScript graph")
    .toBeGreaterThan(5);
  expect(
    precachedScripts.some((path) => /(?:diagram|mermaid|cytoscape)/i.test(path)),
    "a lazily loaded rich-output chunk must remain in version N's precache",
  ).toBe(true);
  expect(workerSource).toMatch(/url:\s*"assets\/KaTeX_[^"]+\.(?:woff2?|ttf)"/);

  for (
    const path of [
      "/api?navigation-probe=1",
      "/v1?navigation-probe=1",
      "/health?navigation-probe=1",
      "/ready?navigation-probe=1",
      "/metrics?navigation-probe=1",
      "/%61pi/setup/status",
      "/%76%31/models",
      "/%68ealth",
      "/%6detrics?navigation-probe=1",
    ]
  ) {
    await expectOnlineServerNavigation(context, path);
  }

  await context.setOffline(true);
  try {
    const shell = await page.goto("/forgot-password?offline-shell=1", {
      waitUntil: "domcontentloaded",
    });
    expect(shell).not.toBeNull();
    expect(shell?.ok()).toBe(true);
    expect(shell?.fromServiceWorker()).toBe(true);
    expect(shell?.headers()["content-type"]).toContain("text/html");
    await expect(page.getByRole("heading", { name: "Reset your password", exact: true }))
      .toBeVisible();

    for (
      const path of [
        "/api",
        "/api?navigation-probe=offline",
        "/api/setup/status",
        "/api/auth/oidc/callback?code=offline&state=offline",
        "/v1",
        "/v1?navigation-probe=offline",
        "/v1/models",
        "/health",
        "/health?navigation-probe=offline",
        "/health/",
        "/ready",
        "/ready?navigation-probe=offline",
        "/ready/replica",
        "/metrics?navigation-probe=offline",
        "/metrics/",
        "/%61pi/setup/status",
        "/%76%31/models",
        "/%68ealth",
        "/%6detrics?navigation-probe=offline",
      ]
    ) {
      await expectOfflineNavigationFailure(context, path);
    }
  } finally {
    await context.setOffline(false);
  }
});
