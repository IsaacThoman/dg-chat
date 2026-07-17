import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import {
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  knowledgeEmbeddingIdentityVersion,
} from "@dg-chat/database";
import { withAuditTestMaintenance } from "../../../packages/database/src/postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for embedding shutdown state");
}

async function childStatusWithin(
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<Deno.CommandStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.status,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Embedding worker did not stop within budget")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test({
  name:
    "shutdown during a dispatched embedding call terminalizes uncertainty once without replaying or retry-budget churn",
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
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => providerStarted = resolve);
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async (request) => {
      if (!new URL(request.url).pathname.endsWith("/embeddings")) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      calls += 1;
      providerStarted();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) return resolve();
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return Response.json({ error: { message: "client disconnected" } }, { status: 499 });
    });
    const port = (server.addr as Deno.NetAddr).port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const version = knowledgeEmbeddingIdentityVersion({
      baseVersion: "shutdown-v1",
      baseUrl,
      model: "shutdown-embedding",
      upstreamModel: "shutdown-embedding",
      batchSize: 8,
    });
    const workerEnv = {
      ...Deno.env.toObject(),
      DATABASE_URL: databaseUrl!,
      DENO_ENV: "test",
      OPENAI_TEST_ALLOW_HTTP_HOST: "127.0.0.1",
      KNOWLEDGE_EMBEDDING_BASE_URL: baseUrl,
      KNOWLEDGE_EMBEDDING_API_KEY: "test-secret",
      KNOWLEDGE_EMBEDDING_MODEL: "shutdown-embedding",
      KNOWLEDGE_EMBEDDING_VERSION: "shutdown-v1",
      KNOWLEDGE_EMBEDDING_BATCH_SIZE: "8",
      KNOWLEDGE_EMBEDDING_INPUT_MICROS_PER_MILLION: "1000000",
      KNOWLEDGE_EMBEDDING_FIXED_CALL_MICROS: "5",
      WORKER_POLL_MS: "10",
      WORKER_JOB_LEASE_SECONDS: "10",
      WORKER_JOB_DEADLINE_MARGIN_MS: "1000",
      WORKER_DATABASE_OPERATION_TIMEOUT_MS: "500",
      WORKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS: "2000",
      S3_BUCKET: "embedding-shutdown-test",
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
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,state,balance_micros)
        VALUES(${userId},${`${userId}@embedding-shutdown.test`},'Embedding shutdown','hash',
          'admin','approved','active',1000)`;
      await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,sha256,
        state,ingestion_status,ingested_at) VALUES(${attachmentId},${userId},
          ${`users/${userId}/shutdown.txt`},'shutdown.txt','text/plain',11,${"a".repeat(64)},
          'ready','ready',now())`;
      await sql`INSERT INTO document_chunks(id,attachment_id,ordinal,content,metadata)
        VALUES(${chunkId},${attachmentId},0,'hello world','{}'::jsonb)`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key,created_at)
        VALUES(${jobId},'document.embed',${sql.json({ attachmentId, ownerId: userId, version })},
          ${`document.embed:${attachmentId}:${version}`},now()-interval '1 day')`;

      worker = spawnWorker();
      await started;
      await eventually(async () =>
        Boolean(
          (await sql<{ phase: string }[]>`SELECT phase FROM document_embedding_batches
          WHERE job_id=${jobId}`)[0]?.phase === "dispatched",
        )
      );
      const stopStarted = performance.now();
      worker.kill("SIGTERM");
      const stopStatus = await childStatusWithin(worker, 4_000);
      assertEquals(stopStatus.success, true);
      worker = undefined;
      if (performance.now() - stopStarted > 3_500) {
        throw new Error("Embedding shutdown exceeded its bounded terminalization window");
      }

      const [job] = await sql<{ status: string; attempts: number; last_error: string }[]>`
        SELECT status,attempts,last_error FROM jobs WHERE id=${jobId}`;
      assertEquals(job.status, "failed");
      assertEquals(job.attempts, 1);
      assertStringIncludes(job.last_error, "outcome is uncertain");
      assertEquals(calls, 1);
      assertEquals(
        [
          ...await sql`SELECT status,input_tokens::int,cost_micros::int,token_source,cost_source
            FROM embedding_provider_attempts WHERE usage_run_id LIKE ${`${jobId}:embedding:%`}`,
        ],
        [{
          status: "cancelled",
          input_tokens: 11,
          cost_micros: 16,
          token_source: "estimated",
          cost_source: "calculated",
        }],
      );
      assertEquals(
        (await sql<{ balance: number }[]>`SELECT balance_micros::int balance FROM users
          WHERE id=${userId}`)[0].balance,
        984,
      );
      // Keep restart proof scoped to the terminal job. The startup reconciler intentionally
      // enqueues every eligible attachment for the active embedding identity, so make this source
      // ineligible and prove the failed durable job itself cannot dispatch again.
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
      },${`embedding-restart-probe:${restartProbeJobId}`})`;
      worker = spawnWorker();
      await eventually(async () =>
        (await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${restartProbeJobId}`)[0]
          ?.status === "completed"
      );
      worker.kill("SIGTERM");
      const restartStatus = await worker.status;
      assertEquals(restartStatus.success, true);
      worker = undefined;
      assertEquals(calls, 1);
      assertEquals(
        (await sql<{ attempts: number }[]>`SELECT attempts FROM jobs WHERE id=${jobId}`)[0]
          .attempts,
        1,
      );
    } finally {
      if (worker) {
        try {
          worker.kill("SIGKILL");
        } catch {
          // The child may have exited between the assertion failure and cleanup.
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
