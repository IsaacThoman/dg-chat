import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { knowledgeEmbeddingIdentityVersion } from "@dg-chat/database";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for pre-dispatch deadline state");
}

Deno.test({
  name: "lease deadline during reservation never fetches and refunds at zero cost",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const locker = postgres(databaseUrl!, { max: 1 });
    const userId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    let providerCalls = 0;
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, () => {
      providerCalls += 1;
      return Response.json({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }],
        model: "deadline-embedding",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    });
    const baseUrl = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/v1`;
    const version = knowledgeEmbeddingIdentityVersion({
      baseVersion: "deadline-v1",
      baseUrl,
      model: "deadline-embedding",
      upstreamModel: "deadline-embedding",
      batchSize: 8,
    });
    let releaseLock!: () => void;
    const release = new Promise<void>((resolve) => releaseLock = resolve);
    let acquiredLock!: () => void;
    const acquired = new Promise<void>((resolve) => acquiredLock = resolve);
    let lockTransaction: Promise<unknown> | undefined;
    let worker: Deno.ChildProcess | undefined;
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,state,balance_micros)
        VALUES(${userId},${`${userId}@embedding-deadline.test`},'Embedding deadline','hash',
          'admin','approved','active',1000)`;
      await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,sha256,
        state,ingestion_status,ingested_at) VALUES(${attachmentId},${userId},
        ${`users/${userId}/deadline.txt`},'deadline.txt','text/plain',8,${"d".repeat(64)},
        'ready','ready',now())`;
      await sql`INSERT INTO document_chunks(id,attachment_id,ordinal,content,metadata)
        VALUES(${chunkId},${attachmentId},0,'deadline','{}'::jsonb)`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key,created_at)
        VALUES(${jobId},'document.embed',${sql.json({ attachmentId, ownerId: userId, version })},
          ${`document.embed:${attachmentId}:${version}`},now()-interval '1 day')`;
      lockTransaction = locker.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
        acquiredLock();
        await release;
      });
      await acquired;

      worker = new Deno.Command(Deno.execPath(), {
        cwd: new URL("../../..", import.meta.url),
        args: ["run", "--allow-all", "apps/worker/src/main.ts"],
        env: {
          ...Deno.env.toObject(),
          DATABASE_URL: databaseUrl!,
          DENO_ENV: "test",
          OPENAI_TEST_ALLOW_HTTP_HOST: "127.0.0.1",
          KNOWLEDGE_EMBEDDING_BASE_URL: baseUrl,
          KNOWLEDGE_EMBEDDING_API_KEY: "test-secret",
          KNOWLEDGE_EMBEDDING_MODEL: "deadline-embedding",
          KNOWLEDGE_EMBEDDING_VERSION: "deadline-v1",
          KNOWLEDGE_EMBEDDING_BATCH_SIZE: "8",
          KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION: "1000000",
          KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS: "5",
          WORKER_POLL_MS: "10",
          WORKER_JOB_LEASE_SECONDS: "3",
          WORKER_JOB_DEADLINE_MARGIN_MS: "2000",
          WORKER_DATABASE_OPERATION_TIMEOUT_MS: "2000",
          WORKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS: "3000",
          S3_BUCKET: "embedding-deadline-test",
          S3_ENDPOINT: "http://127.0.0.1:1",
          S3_ALLOW_INSECURE: "true",
          S3_ACCESS_KEY: "test",
          S3_SECRET_KEY: "test-secret",
        },
        stdout: "null",
        stderr: "null",
      }).spawn();
      await eventually(async () =>
        Boolean(
          (await sql<{ phase: string }[]>`SELECT phase FROM document_embedding_batches
            WHERE job_id=${jobId}`)[0]?.phase === "pre_dispatch",
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      releaseLock();
      await lockTransaction;
      lockTransaction = undefined;

      await eventually(async () => {
        const [job] = await sql<{ status: string; attempts: number }[]>`
          SELECT status,attempts FROM jobs WHERE id=${jobId}`;
        const [run] = await sql<{ status: string }[]>`SELECT status FROM usage_runs
          WHERE id LIKE ${`${jobId}:embedding:%`}`;
        return job?.status === "queued" && job.attempts === 0 && run?.status === "failed";
      });
      worker.kill("SIGTERM");
      const status = await worker.status;
      assertEquals(status.success, true);
      worker = undefined;
      assertEquals(providerCalls, 0);
      assertEquals(
        [
          ...await sql`SELECT status,input_tokens::int,cost_micros::int,token_source,cost_source
          FROM embedding_provider_attempts WHERE usage_run_id LIKE ${`${jobId}:embedding:%`}`,
        ],
        [{
          status: "failed",
          input_tokens: 0,
          cost_micros: 0,
          token_source: "none",
          cost_source: "none",
        }],
      );
      assertEquals(
        (await sql<{ balance: number }[]>`SELECT balance_micros::int balance FROM users
          WHERE id=${userId}`)[0].balance,
        1000,
      );
    } finally {
      if (worker) {
        try {
          worker.kill("SIGKILL");
        } catch {
          // Already exited.
        }
        await worker.status.catch(() => undefined);
      }
      releaseLock?.();
      await lockTransaction?.catch(() => undefined);
      await server.shutdown();
      await sql`DELETE FROM jobs WHERE id=${jobId}`;
      await sql`DELETE FROM embedding_provider_attempts WHERE usage_run_id IN
        (SELECT id FROM usage_runs WHERE user_id=${userId})`;
      await sql`DELETE FROM ledger_entries WHERE user_id=${userId}`;
      await sql`DELETE FROM usage_runs WHERE user_id=${userId}`;
      await sql`DELETE FROM attachments WHERE id=${attachmentId}`;
      await sql`DELETE FROM users WHERE id=${userId}`;
      await Promise.all([locker.end(), sql.end()]);
    }
  },
});
