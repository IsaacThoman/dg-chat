export function env(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env: { get(key: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  return runtime.Deno?.env.get(name) ?? runtime.process?.env[name];
}
