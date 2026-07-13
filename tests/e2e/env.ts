export function env(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env: { get(key: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  return runtime.Deno?.env.get(name) ?? runtime.process?.env[name];
}

/** The built-in managed server is intentionally lightweight unless durable services are supplied. */
export const lightweightManagedStack = env("E2E_MANAGED_SERVER") === "true" &&
  env("E2E_FULL_STACK") !== "true";
