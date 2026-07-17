import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0041 installs a constrained at-most-once document embedding dispatch ledger",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const namespace = `embedding_dispatch_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${namespace}`);
      await sql.unsafe(`SET search_path TO ${namespace},public`);
      await sql.unsafe(`
        CREATE TABLE jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
        CREATE FUNCTION dg_chat_enforce_restore_maintenance() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0041_durable_document_embedding_dispatch.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      const jobId = crypto.randomUUID();
      await sql`INSERT INTO jobs(id) VALUES(${jobId})`;
      const usageRunId = `${jobId}:embedding:0:0`;
      await sql`INSERT INTO document_embedding_batches(
        job_id,batch_ordinal,usage_run_id,request_sha256,item_count,batch_size,
        maximum_input_tokens)
        VALUES(${jobId},0,${usageRunId},${"a".repeat(64)},1,1,5)`;
      await assertRejects(() =>
        sql`UPDATE document_embedding_batches SET retry_safe=true WHERE job_id=${jobId}`
      );
      await assertRejects(() =>
        sql`INSERT INTO document_embedding_batches(
          job_id,batch_ordinal,usage_run_id,request_sha256,item_count,batch_size,
          maximum_input_tokens)
          VALUES(${jobId},1,${`${jobId}:embedding:1:0`},${"c".repeat(64)},1,2,5)`
      );
      await assertRejects(() =>
        sql`UPDATE document_embedding_batches SET phase='succeeded' WHERE job_id=${jobId}`
      );
      await sql`UPDATE document_embedding_batches SET phase='dispatched',
        dispatch_claim_token='worker:claim',dispatched_at=now()
        WHERE job_id=${jobId}`;
      await assertRejects(() =>
        sql`UPDATE document_embedding_batches SET phase='succeeded',responded_at=now(),
          input_tokens=1,latency_ms=1 WHERE job_id=${jobId}`
      );
      await sql`UPDATE document_embedding_batches SET phase='succeeded',responded_at=now(),
        provider_response='{"embeddings":[[1]]}'::jsonb,
        provider_response_sha256=${"b".repeat(64)},input_tokens=1,latency_ms=1
        WHERE job_id=${jobId}`;
      await sql`UPDATE document_embedding_batches SET phase='committed',committed_at=now(),
        provider_response=NULL
        WHERE job_id=${jobId}`;
      assertEquals(
        [...await sql`SELECT phase,usage_run_id FROM document_embedding_batches`],
        [{ phase: "committed", usage_run_id: usageRunId }],
      );
      await sql`DELETE FROM jobs WHERE id=${jobId}`;
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count
          FROM document_embedding_batches`)[0].count,
        0,
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await sql.end();
    }
  },
});
