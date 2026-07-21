import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { destructiveDatabaseConfig, ownedDatabaseName } from "./run-postgres-test-group.ts";

function environment(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

Deno.test("destructive PostgreSQL helper requires exact opt-in and reserved namespace", () => {
  const base = {
    DATABASE_URL: "postgresql://ci:secret@127.0.0.1/app",
    POSTGRES_TEST_DATABASE_PREFIX: "dgchat_ci_123_1_",
  };
  for (const value of [undefined, "1", "TRUE", " true", "true "]) {
    assertThrows(() =>
      destructiveDatabaseConfig(environment({
        ...base,
        DG_CHAT_ALLOW_DESTRUCTIVE_TEST_DATABASES: value,
      }))
    );
  }
  assertThrows(() =>
    destructiveDatabaseConfig(environment({
      ...base,
      DG_CHAT_ALLOW_DESTRUCTIVE_TEST_DATABASES: "true",
      POSTGRES_TEST_DATABASE_PREFIX: "other_ci_123_",
    }))
  );
});

Deno.test("destructive PostgreSQL helper derives only prefix-owned bounded names", () => {
  const config = destructiveDatabaseConfig(environment({
    DATABASE_URL: "postgresql://ci:secret@127.0.0.1/app",
    DG_CHAT_ALLOW_DESTRUCTIVE_TEST_DATABASES: "true",
    POSTGRES_TEST_DATABASE_PREFIX: "dgchat_ci_123_1_",
  }));
  assertEquals(config.template, "dgchat_ci_123_1_template");
  assertEquals(ownedDatabaseName(config, "worker_test_001"), "dgchat_ci_123_1_worker_test_001");
  for (const suffix of ["", "_prod", "../prod", "DGCHAT", "a".repeat(25), "template"]) {
    assertThrows(() => ownedDatabaseName(config, suffix));
  }
});

Deno.test("destructive PostgreSQL helper refuses a namespace that aliases its base database", () => {
  assertThrows(() =>
    destructiveDatabaseConfig(environment({
      DATABASE_URL: "postgresql://ci:secret@127.0.0.1/dgchat_ci_123_1_template",
      DG_CHAT_ALLOW_DESTRUCTIVE_TEST_DATABASES: "true",
      POSTGRES_TEST_DATABASE_PREFIX: "dgchat_ci_123_1_",
    }))
  );
});
