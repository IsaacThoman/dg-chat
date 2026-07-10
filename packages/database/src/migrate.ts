import postgres from "npm:postgres@3.4.7";
import { drizzle } from "npm:drizzle-orm@0.45.2/postgres-js";
import { migrate } from "npm:drizzle-orm@0.45.2/postgres-js/migrator";

const url = Deno.env.get("DATABASE_URL");
if (!url) throw new Error("DATABASE_URL is required");
const client = postgres(url, { max: 1 });
await migrate(drizzle(client), {
  migrationsFolder: new URL("../migrations", import.meta.url).pathname,
});
await client.end();
