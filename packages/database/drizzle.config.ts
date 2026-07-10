import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: Deno.env.get("DATABASE_URL") ?? "postgres://dgchat:dgchat@localhost:5432/dgchat",
  },
});
