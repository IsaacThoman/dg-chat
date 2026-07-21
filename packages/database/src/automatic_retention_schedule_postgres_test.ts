import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres automatic retention fences replicas and rolls back partial scheduling",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 8 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        `TRUNCATE retention_schedule_state,retention_scrub_runs,audit_events,jobs
         RESTART IDENTITY CASCADE`,
      );
      await sql`INSERT INTO retention_policy_versions(version,capture_enabled,request_body_days,
        response_body_days) VALUES(1,false,30,30) ON CONFLICT(version) DO UPDATE SET
        capture_enabled=false,request_body_days=30,response_body_days=30,updated_by=NULL`;
      await sql`INSERT INTO retention_policy_state(singleton_id,current_version) VALUES(1,1)
        ON CONFLICT(singleton_id) DO UPDATE SET current_version=1`;
      await sql`INSERT INTO retention_schedule_state(singleton_id,interval_seconds,next_due_at,
        last_policy_version,updated_at)
        VALUES(1,86400,'2025-12-31T00:00:00Z',1,'2025-12-30T00:00:00Z')`;

      await assertRejects(() =>
        sql.begin(async (tx) => {
          const runId = crypto.randomUUID();
          await tx`INSERT INTO retention_scrub_runs(id,idempotency_key,status,policy_version,
            capture_enabled,request_body_days,response_body_days,request_cutoff_at,
            response_cutoff_at,requested_by)
            VALUES(${runId},'retention.auto:rolled-back','queued',1,false,30,30,
              '2025-12-01T00:00:00Z','2025-12-01T00:00:00Z',NULL)`;
          await tx`INSERT INTO jobs(type,payload,idempotency_key) VALUES(
            'retention.scrub',${tx.json({ runId })},${`retention.scrub:${runId}`})`;
          throw new Error("simulated scheduler crash");
        })
      );
      assertEquals(
        Number((await sql`SELECT count(*)::int count FROM retention_scrub_runs`)[0].count),
        0,
      );
      const historicalRunId = crypto.randomUUID();
      await sql`INSERT INTO retention_scrub_runs(id,idempotency_key,status,policy_version,
        capture_enabled,request_body_days,response_body_days,request_cutoff_at,
        response_cutoff_at,requested_by,completed_at)
        VALUES(${historicalRunId},'retention.auto:policy:1','completed',1,false,30,30,
          '2025-11-01T00:00:00Z','2025-11-01T00:00:00Z',NULL,'2025-12-01T00:00:00Z')`;

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.scheduleRetentionScrub({
            intervalSeconds: 86_400,
            now: "2026-01-01T00:00:00.000Z",
          })),
      );
      assertEquals(results.filter((result) => result.scheduled).length, 1);
      assertEquals(
        Number((await sql`SELECT count(*)::int count FROM retention_scrub_runs`)[0].count),
        2,
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*)::int count FROM jobs WHERE type='retention.scrub'`)[0].count,
        ),
        1,
      );
      const run = await sql<{
        idempotency_key: string;
        requested_by: string | null;
        request_cutoff_at: Date;
        policy_version: number;
      }[]>`SELECT idempotency_key,requested_by,request_cutoff_at,policy_version
        FROM retention_scrub_runs WHERE id<>${historicalRunId}`;
      assertEquals(run[0].idempotency_key.startsWith("retention.auto:"), true);
      assertEquals(run[0].idempotency_key === "retention.auto:policy:1", false);
      assertEquals(run[0].requested_by, null);
      assertEquals(run[0].request_cutoff_at.toISOString(), "2025-12-02T00:00:00.000Z");
      assertEquals(run[0].policy_version, 1);
      const audit = await sql<{ actor_id: string | null }[]>`SELECT actor_id FROM audit_events
        WHERE action='retention.schedule.enqueued'`;
      assertEquals([...audit], [{ actor_id: null }]);
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
