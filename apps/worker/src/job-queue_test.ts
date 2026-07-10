import { assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { claimJob, completeJob, failOrRetryJob } from "./job-queue.ts";

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
