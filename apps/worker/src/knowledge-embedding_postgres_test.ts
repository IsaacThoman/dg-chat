import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { knowledgeEmbeddingIdentityVersion, PostgresRepository } from "@dg-chat/database";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function eventually(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the embedding worker");
}

Deno.test({
  name: "spawned worker retries a failed embedding call, accounts credits, and populates rows once",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const userId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
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
      baseUrl: `https://127.0.0.1:${port}/v1`,
      model: "mock-embedding",
      upstreamModel: "mock-embedding",
    });
    const workerEnv = {
      ...Deno.env.toObject(),
      DATABASE_URL: databaseUrl!,
      DENO_ENV: "test",
      OPENAI_TEST_ALLOW_HTTP_HOST: "127.0.0.1",
      KNOWLEDGE_EMBEDDING_BASE_URL: `https://127.0.0.1:${port}/v1`,
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
        return rows[0]?.status === "completed";
      });
      worker.kill("SIGTERM");
      await worker.status;
      worker = undefined;

      if (calls !== 2) {
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
        [{ count: 1 }],
      );
      assertEquals(
        [
          ...await sql<{ status: string; input_tokens: number; cost_micros: number }[]>`
          SELECT status,input_tokens::int,cost_micros::int FROM usage_runs
          WHERE id LIKE ${`${jobId}:embedding:%`} ORDER BY created_at`,
        ],
        [
          { status: "failed", input_tokens: 0, cost_micros: 0 },
          { status: "completed", input_tokens: 3, cost_micros: 8 },
        ],
      );
      const successfulRunId = `${jobId}:embedding:2:0`;
      // Reproduce the legacy split-finalization crash: usage/ledger committed, attempt finish lost.
      await sql`UPDATE embedding_provider_attempts SET status='running',input_tokens=0,
        cost_micros=0,token_source='none',cost_source='none',latency_ms=NULL,completed_at=NULL
        WHERE usage_run_id=${successfulRunId}`;
      const accountingRepo = await PostgresRepository.connect(databaseUrl!);
      const terminal = {
        usageRunId: successfulRunId,
        status: "succeeded" as const,
        inputTokens: 3,
        costMicros: 8,
        tokenSource: "provider" as const,
        costSource: "calculated" as const,
        latencyMs: 1,
      };
      await accountingRepo.finalizeEmbeddingProviderUsage(terminal);
      await accountingRepo.finalizeEmbeddingProviderUsage(terminal);
      await accountingRepo.close();
      assertEquals(
        [
          ...await sql<{ status: string; input_tokens: number; cost_micros: number }[]>`
          SELECT status,input_tokens,cost_micros::int FROM embedding_provider_attempts
          WHERE usage_run_id=${successfulRunId}`,
        ],
        [{ status: "succeeded", input_tokens: 3, cost_micros: 8 }],
      );
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ledger_entries
          WHERE usage_run_id=${successfulRunId}`)[0].count,
        2,
      );
      assertEquals(
        [
          ...await sql<{
            status: string;
            token_source: string;
            input_tokens: number;
            cost_micros: number;
          }[]>`SELECT status,token_source,input_tokens,cost_micros::int
          FROM embedding_provider_attempts WHERE usage_run_id LIKE ${`${jobId}:embedding:%`}
          ORDER BY started_at`,
        ],
        [
          { status: "failed", token_source: "none", input_tokens: 0, cost_micros: 0 },
          { status: "succeeded", token_source: "provider", input_tokens: 3, cost_micros: 8 },
        ],
      );
      const balance = await sql<{ balance: number }[]>`
        SELECT balance_micros::int AS balance FROM users WHERE id=${userId}`;
      assertEquals(balance[0].balance, 992);

      worker = spawnWorker();
      await new Promise((resolve) => setTimeout(resolve, 300));
      worker.kill("SIGTERM");
      await worker.status;
      worker = undefined;
      assertEquals(calls, 2);
    } finally {
      if (worker) {
        worker.kill("SIGTERM");
        await worker.status.catch(() => undefined);
      }
      await server.shutdown();
      await sql`DELETE FROM jobs WHERE id=${jobId}`;
      await sql`DELETE FROM embedding_provider_attempts WHERE usage_run_id IN
        (SELECT id FROM usage_runs WHERE user_id=${userId})`;
      await sql`DELETE FROM ledger_entries WHERE user_id=${userId}`;
      await sql`DELETE FROM usage_runs WHERE user_id=${userId}`;
      await sql`DELETE FROM attachments WHERE id=${attachmentId}`;
      await sql`DELETE FROM users WHERE id=${userId}`;
      await sql.end();
    }
  },
});
