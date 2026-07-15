import { defineConfig, devices } from "@playwright/test";

const runtime = globalThis as typeof globalThis & {
  Deno?: { env: { get(key: string): string | undefined } };
  process?: { env: Record<string, string | undefined> };
};
const env = (name: string) => runtime.Deno?.env.get(name) ?? runtime.process?.env[name];
const baseURL = env("E2E_BASE_URL") ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(env("CI")),
  retries: env("CI") ? 2 : 0,
  // Managed journeys share one self-hosted installation and intentionally exercise global limits,
  // bootstrap state, retention, and account lifecycle. Parallel workers would race that state and
  // exhaust the administrator's real authentication quota, so keep managed runs isolated locally
  // as well as in CI. Lightweight external stacks that do not opt into full-stack journeys may
  // still use Playwright's default worker count.
  workers: env("CI") || env("E2E_MANAGED_SERVER") === "true" || env("E2E_FULL_STACK") === "true"
    ? 1
    : undefined,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: env("CI")
    ? [["line"], ["html", { open: "never" }], ["junit", { outputFile: "test-results/junit.xml" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/artifacts",
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: env("E2E_MANAGED_SERVER") === "true"
    ? [
      {
        command: "deno task dev",
        url: `${env("E2E_API_URL") ?? "http://localhost:8000"}/health`,
        reuseExistingServer: !env("CI"),
        timeout: 120_000,
        // Browser journeys repeatedly authenticate the same fixture administrator. Dedicated
        // rate-limit tests cover the production defaults; a high managed-stack quota prevents
        // unrelated journeys from becoming order- and wall-clock-dependent.
        env: {
          // Keep the disposable managed stack self-contained. External stacks do not use this
          // webServer block and still require an explicitly provisioned setup secret.
          SETUP_TOKEN: env("SETUP_TOKEN") ?? "e2e-setup-token",
          AUTH_RATE_LIMIT: env("E2E_AUTH_RATE_LIMIT") ?? "1000",
          AUTH_CLIENT_RATE_LIMIT: env("E2E_AUTH_CLIENT_RATE_LIMIT") ?? "1000",
          // Exercise the configured approval default instead of accidentally validating the
          // product's built-in $5 fallback in every browser journey.
          DEFAULT_APPROVAL_CREDIT_USD: env("DEFAULT_APPROVAL_CREDIT_USD") ?? "6.75",
        },
      },
      {
        command: "deno task dev:web --host 0.0.0.0",
        url: baseURL,
        reuseExistingServer: !env("CI"),
        timeout: 120_000,
      },
    ]
    : undefined,
});
