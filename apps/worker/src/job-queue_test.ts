import { assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { claimJob, completeJob, failOrRetryJob, heartbeatJob } from "./job-queue.ts";
import { recordIngestionFailure } from "./attachment-ingestion.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

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
      assertEquals(await heartbeatJob(sql, first), true);
      assertEquals(await claimJob(sql, "worker-b", 60), undefined);

      await sql`UPDATE jobs SET locked_at = now() - interval '61 seconds' WHERE id = ${id}`;
      const reclaimed = await claimJob(sql, "worker-b", 60);
      if (!reclaimed) throw new Error("stale job was not reclaimed");
      assertEquals(reclaimed.id, id);
      assertEquals(reclaimed.attempts, 1);
      assertNotEquals(reclaimed.claimToken, first.claimToken);
      assertEquals(await heartbeatJob(sql, first), false);
      assertEquals(await heartbeatJob(sql, reclaimed), true);

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
