import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const themeBootstrap = readFileSync(
  new URL("../public/theme-bootstrap.js", import.meta.url),
  "utf8",
);
const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");

function executeThemeBootstrap(options: {
  saved?: string | null;
  systemDark?: boolean;
  storageFailure?: boolean;
}) {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const meta = {
    content: "#f7f7f5",
    setAttribute(name: string, value: string) {
      if (name === "content") this.content = value;
    },
  };
  runInNewContext(themeBootstrap, {
    document: {
      documentElement: root,
      querySelector: (selector: string) => selector === 'meta[name="theme-color"]' ? meta : null,
    },
    localStorage: {
      getItem: () => {
        if (options.storageFailure) throw new Error("storage unavailable");
        return options.saved ?? null;
      },
    },
    matchMedia: () => ({ matches: options.systemDark ?? false }),
  });
  return { root, meta };
}

describe("production web security boundary", () => {
  it("loads every executable script from a same-origin asset", () => {
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc=(?:"\/[^"\s]+"|'\/[^'\s]+')/u);
      expect(body.trim()).toBe("");
    }
    expect(indexHtml).toContain('<script src="/theme-bootstrap.js"></script>');
    expect(indexHtml.indexOf("/theme-bootstrap.js")).toBeLessThan(
      indexHtml.indexOf("/src/main.tsx"),
    );
    expect(themeBootstrap).not.toMatch(/\b(?:eval|Function)\s*\(/u);
    expect(themeBootstrap).not.toContain("document.write");
  });

  it("applies the saved or system theme before the application starts", () => {
    const dark = executeThemeBootstrap({ saved: "dark" });
    expect(dark.root.dataset).toEqual({ theme: "dark", themePreference: "dark" });
    expect(dark.root.style.colorScheme).toBe("dark");
    expect(dark.meta.content).toBe("#171715");

    const system = executeThemeBootstrap({ saved: "system", systemDark: true });
    expect(system.root.dataset).toEqual({ theme: "dark", themePreference: "system" });

    const unavailable = executeThemeBootstrap({ storageFailure: true, systemDark: true });
    expect(unavailable.root.dataset).toEqual({ theme: "light", themePreference: "system" });
    expect(unavailable.root.style.colorScheme).toBe("light");
  });

  it("ships an explicit CSP without an inline-script escape hatch", () => {
    const match = dockerfile.match(/add_header Content-Security-Policy "([^"]+)" always;/u);
    expect(match?.[1].split("; ")).toEqual([
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "img-src 'self' data: blob: https:",
      "manifest-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "script-src 'self'",
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
    ]);
    expect(match?.[1]).not.toMatch(/script-src[^;]*(?:'unsafe-inline'|'unsafe-eval'|\*)/u);
    expect(dockerfile).toContain('add_header X-Content-Type-Options "nosniff" always;');
  });

  it("denies public metrics instead of forwarding them to the application", () => {
    const metricsLocation = dockerfile.match(
      /location ~ \^\/metrics\(\?:\/\|\$\) \{([\s\S]*?)\n {2}\}/u,
    )?.[1];
    expect(metricsLocation).toContain("return 404");
    expect(metricsLocation).not.toContain("proxy_pass");
    expect(dockerfile).not.toMatch(/\(health\|ready\|metrics\)/u);
  });

  it("re-resolves the API service after a Compose dependency restart", () => {
    expect(dockerfile).toContain("resolver 127.0.0.11 valid=5s ipv6=off;");
    expect(dockerfile).toContain("set $dgchat_app_upstream app:8000;");
    expect(dockerfile.match(/proxy_pass http:\/\/\$dgchat_app_upstream;/gu)).toHaveLength(2);
    expect(dockerfile).not.toContain("proxy_pass http://app:8000;");
  });

  it("streams request bodies to the application's route-specific limiters", () => {
    expect(dockerfile).toContain("client_max_body_size 0;");
    const apiProxy = dockerfile.match(
      /location ~ \^\/\(api\|v1\)\(\?:\/\|\$\) \{([\s\S]*?)\n {2}\}/u,
    )?.[1];
    expect(apiProxy).toContain("proxy_request_buffering off;");
  });
});
