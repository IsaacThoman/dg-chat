import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0026 initializes fenced retention policy and bounded provider captures",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `privacy_retention_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE usage_runs(id text PRIMARY KEY);
        CREATE TABLE provider_attempts(
          id uuid PRIMARY KEY,
          usage_run_id text NOT NULL REFERENCES usage_runs(id)
        );
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0026_privacy_retention.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      assertEquals([
        ...await sql`SELECT version,capture_enabled,request_body_days,response_body_days
        FROM retention_policy_versions`,
      ], [{
        version: 1,
        capture_enabled: false,
        request_body_days: 30,
        response_body_days: 30,
      }]);
      const userId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      await sql`INSERT INTO users(id) VALUES(${userId})`;
      await sql`INSERT INTO usage_runs(id) VALUES('run')`;
      await sql`INSERT INTO provider_attempts(id,usage_run_id) VALUES(${attemptId},'run')`;
      await sql`INSERT INTO provider_payload_captures(usage_run_id,provider_attempt_id,
        request_body,request_bytes) VALUES('run',${attemptId},'request',7)`;
      await assertRejects(() =>
        sql`INSERT INTO retention_policy_versions(version,capture_enabled,
        request_body_days,response_body_days,updated_by) VALUES(2,true,2,30,${userId})`
      );
      const otherAttemptId = crypto.randomUUID();
      await sql`INSERT INTO usage_runs(id) VALUES('other-run')`;
      await sql`INSERT INTO provider_attempts(id,usage_run_id)
        VALUES(${otherAttemptId},'other-run')`;
      await assertRejects(() =>
        sql`INSERT INTO provider_payload_captures(usage_run_id,
        provider_attempt_id,response_body,response_bytes) VALUES('run',${otherAttemptId},'x',1)`
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
