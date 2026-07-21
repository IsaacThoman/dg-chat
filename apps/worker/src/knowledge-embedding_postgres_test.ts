import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import {
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  knowledgeEmbeddingIdentityVersion,
} from "@dg-chat/database";
import { withAuditTestMaintenance } from "../../../packages/database/src/postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function eventually(check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the embedding worker");
}

Deno.test({
  name: "spawned worker never replays an ambiguous 503 embedding dispatch and charges once",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const userId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const restartProbeAttachmentId = crypto.randomUUID();
    const restartProbeJobId = crypto.randomUUID();
    let calls = 0;
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async (request) => {
      if (!new URL(request.url).pathname.endsWith("/embeddings")) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      calls += 1;
      const body = await request.json() as { input?: unknown[] };
      if (calls === 1) {
        return Response.json({ error: { message: "retry me" } }, { status: 503 });
      }
      return Response.json({
        object: "list",
        data: (body.input ?? []).map((_value, index) => ({
          object: "embedding",
          index,
          embedding: Array(1536).fill(0).map((_unused, dimension) => dimension === index ? 1 : 0),
        })),
        model: "mock-embedding",
        usage: { prompt_tokens: 3, total_tokens: 3 },
      });
    });
    const port = (server.addr as Deno.NetAddr).port;
    const effectiveVersion = knowledgeEmbeddingIdentityVersion({
      baseVersion: "mock-v1",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "mock-embedding",
      upstreamModel: "mock-embedding",
      batchSize: 8,
    });
    const workerEnv = {
      ...Deno.env.toObject(),
      DATABASE_URL: databaseUrl!,
      DENO_ENV: "test",
      OPENAI_TEST_ALLOW_HTTP_HOST: "127.0.0.1",
      KNOWLEDGE_EMBEDDING_BASE_URL: `http://127.0.0.1:${port}/v1`,
      KNOWLEDGE_EMBEDDING_API_KEY: "test-secret",
      KNOWLEDGE_EMBEDDING_MODEL: "mock-embedding",
      KNOWLEDGE_EMBEDDING_VERSION: "mock-v1",
      KNOWLEDGE_EMBEDDING_BATCH_SIZE: "8",
      KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION: "1000000",
      KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS: "5",
      WORKER_POLL_MS: "10",
      WORKER_JOB_LEASE_SECONDS: "10",
      WORKER_JOB_DEADLINE_MARGIN_MS: "1000",
      S3_BUCKET: "embedding-test",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_ALLOW_INSECURE: "true",
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test-secret",
    };
    const spawnWorker = () =>
      new Deno.Command(Deno.execPath(), {
        cwd: new URL("../../..", import.meta.url),
        args: ["run", "--allow-all", "apps/worker/src/main.ts"],
        env: workerEnv,
        stdout: "null",
        stderr: "null",
      }).spawn();
    let worker: Deno.ChildProcess | undefined;
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,balance_micros)
        VALUES(${userId},${`${userId}@embedding.test`},'Embedding test','hash','admin','approved',1000)`;
      await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,sha256,
        state,ingestion_status,ingested_at) VALUES(${attachmentId},${userId},
        ${`users/${userId}/knowledge.txt`},'knowledge.txt','text/plain',11,${"a".repeat(64)},
        'ready','ready',now())`;
      await sql`INSERT INTO document_chunks(id,attachment_id,ordinal,content,metadata)
        VALUES(${chunkId},${attachmentId},0,'hello world','{}'::jsonb)`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key)
        VALUES(${jobId},'document.embed',${
        sql.json({ attachmentId, ownerId: userId, version: effectiveVersion })
      },
        ${`document.embed:${attachmentId}:${effectiveVersion}`})`;

      worker = spawnWorker();
      await eventually(async () => {
        const rows = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${jobId}`;
        return rows[0]?.status === "failed";
      });
      worker.kill("SIGTERM");
      assertEquals((await worker.status).success, true);
      worker = undefined;

      if (calls !== 1) {
        throw new Error(JSON.stringify({
          calls,
          jobs: [...await sql`SELECT status,attempts,last_error FROM jobs WHERE id=${jobId}`],
          runs: [
            ...await sql`SELECT id,status,cost_micros,error FROM usage_runs
            WHERE user_id=${userId} ORDER BY created_at`,
          ],
        }));
      }
      assertEquals(
        [
          ...await sql<{ count: number }[]>`SELECT count(*)::int AS count
          FROM document_chunk_embeddings
          WHERE chunk_id=${chunkId} AND embedding_version=${effectiveVersion}`,
        ],
        [{ count: 0 }],
      );
      assertEquals(
        [
          ...await sql<{ status: string; input_tokens: number; cost_micros: number }[]>`
          SELECT status,input_tokens::int,cost_micros::int FROM usage_runs
          WHERE id LIKE ${`${jobId}:embedding:%`} ORDER BY created_at`,
        ],
        [{ status: "failed", input_tokens: 11, cost_micros: 16 }],
      );
      assertEquals(
        [
          ...await sql<{
            phase: string;
            dispatch_epoch: number;
            retry_safe: boolean;
          }[]>`
          SELECT phase,dispatch_epoch,retry_safe FROM document_embedding_batches
          WHERE job_id=${jobId}`,
        ],
        [{ phase: "dispatched", dispatch_epoch: 0, retry_safe: false }],
      );
      assertEquals(
        [
          ...await sql<{
            status: string;
            token_source: string;
            input_tokens: number;
            cost_micros: number;
          }[]>`SELECT status,token_source,input_tokens,cost_micros::int
          FROM embedding_provider_attempts WHERE usage_run_id LIKE ${`${jobId}:embedding:%`}`,
        ],
        [{ status: "failed", token_source: "estimated", input_tokens: 11, cost_micros: 16 }],
      );
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ledger_entries
          WHERE usage_run_id LIKE ${`${jobId}:embedding:%`}`)[0].count,
        1,
      );
      const balance = await sql<{ balance: number }[]>`
        SELECT balance_micros::int AS balance FROM users WHERE id=${userId}`;
      assertEquals(balance[0].balance, 984);

      await sql`UPDATE attachments SET state='deleted',deleted_at=now(),updated_at=now()
        WHERE id=${attachmentId}`;
      await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,sha256,
        state,ingestion_status) VALUES(${restartProbeAttachmentId},${userId},
        ${`users/${userId}/restart-probe.txt`},'restart-probe.txt','text/plain',1,
        ${"b".repeat(64)},'ready','not_applicable')`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key)
        VALUES(${restartProbeJobId},'attachment.inspect',${
        sql.json({
          attachmentId: restartProbeAttachmentId,
          ownerId: userId,
          inspectionEpoch: 1,
          requiredInspectionMode: "local",
          inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
        })
      },${`knowledge-restart-probe:${restartProbeJobId}`})`;
      worker = spawnWorker();
      await eventually(async () =>
        (await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${restartProbeJobId}`)[0]
          ?.status === "completed"
      );
      worker.kill("SIGTERM");
      assertEquals((await worker.status).success, true);
      worker = undefined;
      assertEquals(calls, 1);
    } finally {
      if (worker) {
        try {
          worker.kill("SIGKILL");
        } catch {
          // Already exited.
        }
        await worker.status.catch(() => undefined);
      }
      await server.shutdown();
      await withAuditTestMaintenance(sql, async (tx) => {
        await tx`DELETE FROM jobs WHERE id IN (${jobId},${restartProbeJobId})`;
        await tx`DELETE FROM embedding_provider_attempts WHERE usage_run_id IN
          (SELECT id FROM usage_runs WHERE user_id=${userId})`;
        await tx`DELETE FROM ledger_entries WHERE user_id=${userId}`;
        await tx`DELETE FROM usage_runs WHERE user_id=${userId}`;
        await tx`DELETE FROM attachments WHERE id IN (${attachmentId},${restartProbeAttachmentId})`;
        await tx`DELETE FROM attachment_storage_usage WHERE owner_id=${userId}`;
        await tx`DELETE FROM attachment_storage_blobs WHERE owner_id=${userId}`;
        await tx`DELETE FROM users WHERE id=${userId}`;
      });
      await sql.end();
    }
  },
});
