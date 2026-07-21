import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { assertRuntimeDependencies } from "./runtime-dependencies.ts";

Deno.test("production refuses every missing durable runtime dependency", () => {
  const error = assertThrows(
    () =>
      assertRuntimeDependencies({
        production: true,
        databaseUrl: " ",
        redisUrl: undefined,
        objectStoreConfigured: false,
      }),
    Error,
  );
  assertEquals(
    error.message,
    "Production requires DATABASE_URL, REDIS_URL, S3 object storage",
  );
});

Deno.test("production accepts externally configured durable dependencies", () => {
  assertRuntimeDependencies({
    production: true,
    databaseUrl: "postgresql://database/app",
    redisUrl: "redis://redis:6379",
    objectStoreConfigured: true,
  });
});

Deno.test("development and tests may deliberately use in-process adapters", () => {
  assertRuntimeDependencies({
    production: false,
    objectStoreConfigured: false,
  });
});
