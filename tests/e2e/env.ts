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

export interface AppReadiness {
  storage?: { ready?: boolean; storage?: string };
  objects?: { configured?: boolean; ready?: boolean };
}

export type DurableCapability = "postgres" | "objects";

/**
 * Environment flags select tests, but only live readiness can prove that durable dependencies are
 * actually available. Keep this pure so capability policy can be checked without a running app.
 */
export function missingDurableCapabilities(
  readiness: AppReadiness | null,
  required: readonly DurableCapability[],
): string[] {
  if (!readiness) return [...required];
  const missing: string[] = [];
  if (
    required.includes("postgres") &&
    (readiness.storage?.ready !== true || readiness.storage.storage !== "postgres")
  ) {
    missing.push("PostgreSQL");
  }
  if (
    required.includes("objects") &&
    (readiness.objects?.configured !== true || readiness.objects.ready !== true)
  ) {
    missing.push("object storage");
  }
  return missing;
}

/** Missing declared full-stack capabilities are configuration errors in CI and explicit runs. */
export function strictDurableCapabilities(read = env): boolean {
  return Boolean(read("CI")) || read("E2E_FULL_STACK") === "true";
}
