import { assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { recordIngestionFailure } from "./attachment-ingestion.ts";
import {
  claimJob,
  completeJob,
  failOrRetryJob,
  failOrRetryRetentionScrubJob,
  jobFailureWillRetry,
  retentionRunIdFromJobAssociation,
} from "./job-queue.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test("job failure retry decision matches the durable attempt budget", () => {
  assertEquals(jobFailureWillRetry({ attempts: 0 }), true);
  assertEquals(jobFailureWillRetry({ attempts: 3 }), true);
  assertEquals(jobFailureWillRetry({ attempts: 4 }), false);
});

Deno.test("retention run association is recovered only from its exact durable key", () => {
  const runId = "00000000-0000-4000-8000-000000000077";
  assertEquals(
    retentionRunIdFromJobAssociation({
      type: "retention.scrub",
      idempotencyKey: `retention.scrub:${runId}`,
    }),
    runId,
  );
  for (
    const idempotencyKey of [null, runId, `retention.scrub:${runId}:extra`, "retention.scrub:bad"]
  ) {
    assertEquals(
      retentionRunIdFromJobAssociation({ type: "retention.scrub", idempotencyKey }),
      undefined,
    );
  }
});

Deno.test({
  name: "malformed retention payload converges linked job and run without persisting secrets",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const userId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const sentinel = "super-secret-parser-detail";
    try {
      await sql`TRUNCATE jobs,retention_scrub_runs,retention_policy_state,
        retention_policy_versions,users RESTART IDENTITY CASCADE`;
      await sql`INSERT INTO users(id,email,name,role,approval_status,state)
        VALUES(${userId},${`${userId}@retention-worker.test`},'Retention worker','admin','approved','active')`;
      await sql`INSERT INTO retention_policy_versions(version,capture_enabled,request_body_days,
        response_body_days) VALUES(1,false,30,30) ON CONFLICT(version) DO NOTHING`;
      await sql`INSERT INTO retention_policy_state(singleton_id,current_version) VALUES(1,1)
        ON CONFLICT(singleton_id) DO UPDATE SET current_version=EXCLUDED.current_version`;
      const policy = await sql<{ current_version: number }[]>`SELECT current_version
        FROM retention_policy_state WHERE singleton_id=1`;
      await sql`INSERT INTO retention_scrub_runs(id,idempotency_key,status,policy_version,
        capture_enabled,request_body_days,response_body_days,request_cutoff_at,response_cutoff_at,
        requested_by) VALUES(${runId},${`malformed-${runId}`},'queued',${policy[0].current_version},
        false,30,30,now()-interval '30 days',now()-interval '30 days',${userId})`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key)
        VALUES(${jobId},'retention.scrub',${sql.json({ malformed: sentinel })},
          ${`retention.scrub:${runId}`})`;
      const claimed = await claimJob(sql, "malformed-retention-worker", 60);
      if (!claimed) throw new Error("retention job was not claimed");
      const associated = retentionRunIdFromJobAssociation(claimed);
      assertEquals(associated, runId);
      assertEquals(
        await failOrRetryRetentionScrubJob(
          sql,
          claimed,
          associated!,
          "invalid_job_payload",
          1,
        ),
        true,
      );
      const [job] = await sql<{ status: string; last_error: string }[]>`
        SELECT status,last_error FROM jobs WHERE id=${jobId}`;
      const [run] = await sql<{ status: string; error: string }[]>`
        SELECT status,error FROM retention_scrub_runs WHERE id=${runId}`;
      assertEquals(job, { status: "failed", last_error: "Retention scrub job payload is invalid" });
      assertEquals(run, {
        status: "failed",
        error: "Retention scrub stopped because its durable job payload was invalid",
      });
      const audit = JSON.stringify(
        await sql`SELECT metadata FROM audit_events
        WHERE target_id=${runId} AND action='retention.scrub.failed'`,
      );
      assertEquals(audit.includes(sentinel), false);
      assertEquals(audit.includes("invalid_job_payload"), true);
    } finally {
      await sql`DELETE FROM jobs WHERE id=${jobId}`;
      await sql`DELETE FROM audit_events WHERE target_id=${runId}`;
      await sql`DELETE FROM retention_scrub_runs WHERE id=${runId}`;
      await sql`DELETE FROM users WHERE id=${userId}`;
      await sql.end();
    }
  },
});

Deno.test({
  name: "stale running jobs are reclaimed and the previous claim is fenced",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const id = crypto.randomUUID();
    try {
      await sql`DELETE FROM jobs`;
      await sql`
        INSERT INTO jobs(id,type,payload,idempotency_key)
        VALUES(${id},'lease.test',${sql.json({ id })},${`lease.test:${id}`})
      `;

      const first = await claimJob(sql, "worker-a", 60);
      if (!first) throw new Error("first worker did not claim the job");
      assertEquals(first.id, id);
      assertEquals(first.attempts, 0);
      assertEquals(await claimJob(sql, "worker-b", 60), undefined);

      await sql`UPDATE jobs SET locked_at = now() - interval '61 seconds' WHERE id = ${id}`;
      const reclaimed = await claimJob(sql, "worker-b", 60);
      if (!reclaimed) throw new Error("stale job was not reclaimed");
      assertEquals(reclaimed.id, id);
      assertEquals(reclaimed.attempts, 1);
      assertNotEquals(reclaimed.claimToken, first.claimToken);

      assertEquals(await completeJob(sql, first), false);
      assertEquals(await failOrRetryJob(sql, first, "stale failure"), false);
      assertEquals(await completeJob(sql, reclaimed), true);
      const rows = await sql<{ status: string; attempts: number; locked_by: string | null }[]>`
        SELECT status,attempts,locked_by FROM jobs WHERE id=${id}
      `;
      assertEquals(rows[0], { status: "completed", attempts: 2, locked_by: null });
    } finally {
      await sql`DELETE FROM jobs WHERE id=${id}`;
      await sql.end();
    }
  },
});

Deno.test({
  name: "pre-processing ingestion failure transitions queued attachment and job consistently",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const userId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status)
        VALUES(${userId},${`${userId}@worker.test`},'Worker test','hash','admin','approved')`;
      await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,sha256,
        state,ingestion_status) VALUES(${attachmentId},${userId},${`uploads/${userId}/source`},
        'source.txt','text/plain',1,${"a".repeat(64)},'ready','queued')`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key) VALUES(${jobId},'attachment.ingest',${
        sql.json({ attachmentId, ownerId: userId })
      },${`attachment.ingest:${attachmentId}`})`;
      const claimed = await claimJob(sql, "pre-processing-worker", 60);
      if (!claimed) throw new Error("ingestion job was not claimed");
      assertEquals(
        await recordIngestionFailure(
          sql,
          claimed,
          { attachmentId, ownerId: userId },
          "object storage unavailable",
          1,
        ),
        true,
      );
      assertEquals(
        (await sql<{ ingestion_status: string }[]>`
          SELECT ingestion_status FROM attachments WHERE id=${attachmentId}`)[0].ingestion_status,
        "failed",
      );
      assertEquals(
        (await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${jobId}`)[0].status,
        "failed",
      );
    } finally {
      await sql`DELETE FROM jobs WHERE id=${jobId}`;
      await sql`DELETE FROM attachments WHERE id=${attachmentId}`;
      await sql`DELETE FROM users WHERE id=${userId}`;
      await sql.end();
    }
  },
});
