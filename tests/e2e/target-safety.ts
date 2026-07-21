export interface E2ETargetSafetyOptions {
  targetUrls: readonly string[];
  allowDestructiveRemote?: string;
  setupToken?: string;
  adminEmail?: string;
  adminPassword?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseTargetUrl(targetUrl: string): URL {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error("Refusing to run E2E tests: a target URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "Refusing to run E2E tests: every target must use HTTP or HTTPS.",
    );
  }
  return url;
}

/**
 * Browser journeys create users, conversations, files, tokens, and administrator state. Keep
 * convenient fixture defaults strictly local and require an unmistakable opt-in plus explicit
 * credentials before any part of the suite can target a remote installation.
 */
export function assertSafeE2ETarget(options: E2ETargetSafetyOptions): void {
  const targets = options.targetUrls.map(parseTargetUrl);
  const remoteTargets = targets.filter((target) =>
    !LOOPBACK_HOSTS.has(target.hostname.replace(/^\[|\]$/g, "").toLowerCase())
  );
  if (remoteTargets.length === 0) return;

  const missing: string[] = [];
  if (options.allowDestructiveRemote !== "true") missing.push("E2E_ALLOW_DESTRUCTIVE_REMOTE=true");
  if (!options.setupToken?.trim()) missing.push("SETUP_TOKEN");
  if (!options.adminEmail?.trim()) missing.push("E2E_ADMIN_EMAIL");
  if (!options.adminPassword?.trim()) missing.push("E2E_ADMIN_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `Refusing to run destructive E2E tests against remote target(s) ${
        [...new Set(remoteTargets.map((target) => JSON.stringify(target.origin)))].join(", ")
      }. Explicitly provide ${missing.join(", ")}. Use only a disposable installation.`,
    );
  }
}
