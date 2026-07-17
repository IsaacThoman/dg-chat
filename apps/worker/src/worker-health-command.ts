import postgres from "npm:postgres@3.4.7";
import { objectStoreFromEnv } from "@dg-chat/database";
import {
  parseWorkerLivenessConfig,
  probeWorkerHealth,
  readWorkerInstanceFile,
} from "./worker-liveness.ts";

/** Container health command. It intentionally emits no dependency details or credentials. */
export async function runWorkerHealthCommand(
  env: Record<string, string | undefined> = Deno.env.toObject(),
) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return false;
  let config;
  let instanceId;
  let objectStore;
  try {
    config = parseWorkerLivenessConfig(env);
    instanceId = await readWorkerInstanceFile(config.instanceFile);
    objectStore = objectStoreFromEnv(env);
  } catch {
    return false;
  }
  if (!objectStore || objectStore.implementation !== "s3") return false;
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(config.healthTimeoutMs / 1_000)),
    connection: { statement_timeout: config.healthTimeoutMs },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.healthTimeoutMs);
  try {
    return await Promise.race([
      probeWorkerHealth({ sql, objectStore, instanceId, config }),
      new Promise<false>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(false), { once: true });
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    objectStore.close();
    await sql.end({ timeout: 0 }).catch(() => undefined);
  }
}
