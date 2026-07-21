import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { withAuditTestMaintenance } from "../../../packages/database/src/postgres-test-maintenance.ts";
import { reconcileEmbeddingJobsBatch, reconcileStartupQueues } from "./startup-reconciliation.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "startup reconciliation commits bounded batches and resumes durable progress",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, {
      max: 2,
      connection: { statement_timeout: 5_000 },
    });
    const userId = crypto.randomUUID();
    const version = `startup-${crypto.randomUUID()}`;
    const model = "startup-reconciliation-test";
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,state)
        VALUES(${userId},${`${userId}@startup-reconciliation.test`},'Startup reconciliation',
          'hash','admin','approved','active')`;
      await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,
          sha256,state,ingestion_status,ingested_at,created_at,physical_object)
        SELECT gen_random_uuid(),${userId},'users/'||${userId}||'/startup-'||n||'.txt',
          'startup-'||n||'.txt','text/plain',1,lpad(to_hex(n),64,'0'),'ready','ready',now(),
          now()+n*interval '1 millisecond',false FROM generate_series(1,205) n`;
      await sql`INSERT INTO document_chunks(id,attachment_id,ordinal,content,metadata)
        SELECT gen_random_uuid(),id,0,'startup content','{}'::jsonb FROM attachments
        WHERE owner_id=${userId}`;

      // Model a process interruption after one bounded commit. The next process starts from
      // durable queued rows and only creates the remaining jobs.
      assertEquals(await reconcileEmbeddingJobsBatch(sql, { model, version }), 100);
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM jobs
          WHERE idempotency_key LIKE ${`document.embed:%:${version}`}`)[0].count,
        100,
      );
      const resumed = await reconcileStartupQueues(sql, {
        generatedCleanupGraceSeconds: 600,
        embedding: { model, version },
        signal: new AbortController().signal,
      });
      assertEquals(resumed.embeddings, 105);
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM jobs
          WHERE idempotency_key LIKE ${`document.embed:%:${version}`}`)[0].count,
        205,
      );
      assertEquals(
        await reconcileStartupQueues(sql, {
          generatedCleanupGraceSeconds: 600,
          embedding: { model, version },
          signal: new AbortController().signal,
        }),
        { cleanup: 0, embeddings: 0 },
      );
    } finally {
      await withAuditTestMaintenance(sql, async (tx) => {
        await tx`DELETE FROM jobs WHERE idempotency_key LIKE ${`document.embed:%:${version}`}`;
        await tx`DELETE FROM attachments WHERE owner_id=${userId}`;
        await tx`DELETE FROM attachment_storage_usage WHERE owner_id=${userId}`;
        await tx`DELETE FROM attachment_storage_blobs WHERE owner_id=${userId}`;
        await tx`DELETE FROM users WHERE id=${userId}`;
      });
      await sql.end();
    }
  },
});
