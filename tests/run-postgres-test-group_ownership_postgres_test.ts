import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { destructiveDatabaseConfig, ownedDatabaseName } from "./run-postgres-test-group.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "destructive PostgreSQL helper refuses an unowned database inside its namespace",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const config = destructiveDatabaseConfig();
    const unowned = ownedDatabaseName(config, "unowned_probe");
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = "/postgres";
    const sql = postgres(adminUrl.toString(), { max: 1 });
    let created = false;
    try {
      const existing = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${unowned}) exists`;
      assertEquals(existing[0].exists, false, "the unique CI namespace must start unused");
      await sql.unsafe(`CREATE DATABASE "${unowned}"`);
      created = true;

      const child = new Deno.Command(Deno.execPath(), {
        cwd: new URL("..", import.meta.url),
        args: [
          "run",
          "--allow-env",
          "--allow-net",
          "--allow-run",
          "tests/run-postgres-test-group.ts",
          "unowned_probe",
          "deno",
          "eval",
          "console.log('must not run')",
        ],
        env: Deno.env.toObject(),
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const output = await child.output();
      assertEquals(output.success, false);
      assertStringIncludes(
        new TextDecoder().decode(output.stderr),
        "Refusing to drop unowned database",
      );
      assertEquals(
        (await sql<{ exists: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${unowned}) exists`)[0].exists,
        true,
      );
      assertEquals(new TextDecoder().decode(output.stdout).includes("must not run"), false);
    } finally {
      if (created) await sql.unsafe(`DROP DATABASE "${unowned}" WITH (FORCE)`);
      await sql.end();
    }
  },
});
