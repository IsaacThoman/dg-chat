import { createApp } from "./app.ts";
import {
  backfillLegacyRuntimeSnapshot,
  MemoryRepository,
  PostgresRepository,
} from "@dg-chat/database";
import { MemoryRateLimiter, RedisRateLimiter } from "./rate-limit.ts";

const port = Number(Deno.env.get("PORT") ?? 8000);
const databaseUrl = Deno.env.get("DATABASE_URL");
if (databaseUrl) {
  const backfill = await backfillLegacyRuntimeSnapshot(databaseUrl);
  if (backfill.status === "imported") {
    console.log(
      JSON.stringify({ level: "info", message: "Legacy repository imported", ...backfill }),
    );
  }
}
const repository = databaseUrl
  ? await PostgresRepository.connect(databaseUrl)
  : new MemoryRepository();
const rateLimiter = Deno.env.get("REDIS_URL")
  ? new RedisRateLimiter(Deno.env.get("REDIS_URL")!)
  : new MemoryRateLimiter();
const { app } = createApp({ repository, rateLimiter });
console.log(JSON.stringify({ level: "info", message: "API listening", port }));
const server = Deno.serve({ port, onListen: () => {} }, app.fetch);
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", message: "API shutting down", signal }));
  await server.shutdown();
  await Promise.all([repository.close(), rateLimiter.close()]);
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => void shutdown(signal));
}
