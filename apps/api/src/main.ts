import { createApp } from "./app.ts";
import { MemoryRepository, PostgresStateRepository } from "@dg-chat/database";

const port = Number(Deno.env.get("PORT") ?? 8000);
const databaseUrl = Deno.env.get("DATABASE_URL");
const repository = databaseUrl
  ? await PostgresStateRepository.connect(databaseUrl)
  : new MemoryRepository();
const { app } = createApp({ repository });
console.log(JSON.stringify({ level: "info", message: "API listening", port }));
Deno.serve({ port, onListen: () => {} }, app.fetch);
