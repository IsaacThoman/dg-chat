import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0046 creates boot-scoped worker liveness with bounded states and job metadata",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `worker_instances_${crypto.randomUUID().replaceAll("-", "")}`;
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`CREATE FUNCTION dg_chat_enforce_restore_maintenance()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0046_worker_instances.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      const id = crypto.randomUUID();
      await sql`INSERT INTO worker_instances(instance_id,worker_name,state)
        VALUES(${id},'replica-a','starting')`;
      assertEquals(
        [
          ...await sql`SELECT instance_id::text,worker_name,state,heartbeat_stale_ms,
          progress_stale_ms,health_clock_tolerance_ms FROM worker_instances`,
        ],
        [{
          instance_id: id,
          worker_name: "replica-a",
          state: "starting",
          heartbeat_stale_ms: 20_000,
          progress_stale_ms: 180_000,
          health_clock_tolerance_ms: 5_000,
        }],
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET current_job_id=${crypto.randomUUID()} WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET state='unknown' WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET stopped_at=now() WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET state='stopped' WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET last_completed_at=now() WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET last_completed_job_id=${crypto.randomUUID()},
          last_completed_job_type='attachment.inspect' WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET heartbeat_stale_ms=999 WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET heartbeat_stale_ms=300001 WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET progress_stale_ms=999 WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET progress_stale_ms=3600001 WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET health_clock_tolerance_ms=-1 WHERE instance_id=${id}`
      );
      await assertRejects(() =>
        sql`UPDATE worker_instances SET health_clock_tolerance_ms=60001 WHERE instance_id=${id}`
      );
      await sql`UPDATE worker_instances SET heartbeat_stale_ms=1000,
        progress_stale_ms=3600000,health_clock_tolerance_ms=0 WHERE instance_id=${id}`;
      await sql`UPDATE worker_instances SET heartbeat_stale_ms=300000,
        progress_stale_ms=1000,health_clock_tolerance_ms=60000 WHERE instance_id=${id}`;
      const completedJobId = crypto.randomUUID();
      await sql`UPDATE worker_instances SET last_completed_at=now(),
        last_completed_job_id=${completedJobId},last_completed_job_type='attachment.inspect'
        WHERE instance_id=${id}`;
      await sql`UPDATE worker_instances SET state='stopped',stopped_at=now() WHERE instance_id=${id}`;
      await assertRejects(() =>
        sql`UPDATE worker_instances SET stopped_at=NULL WHERE instance_id=${id}`
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
