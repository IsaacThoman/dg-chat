import postgres from "npm:postgres@3.4.7";
import { drizzle } from "npm:drizzle-orm@0.45.2/postgres-js";
import { migrate } from "npm:drizzle-orm@0.45.2/postgres-js/migrator";

const url = Deno.env.get("DATABASE_URL");
if (!url) throw new Error("DATABASE_URL is required");
const client = postgres(url, { max: 1 });
const retries = Number(Deno.env.get("MIGRATION_CONNECT_RETRIES") ?? 30);
if (!Number.isSafeInteger(retries) || retries < 1 || retries > 120) {
  throw new Error("MIGRATION_CONNECT_RETRIES must be an integer from 1 to 120");
}
try {
  let connected = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await client`SELECT 1`;
      connected = true;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, attempt * 200)));
      }
    }
  }
  if (!connected) throw lastError;
  await migrate(drizzle(client), {
    migrationsFolder: new URL("../migrations", import.meta.url).pathname,
  });
} finally {
  await client.end();
}
