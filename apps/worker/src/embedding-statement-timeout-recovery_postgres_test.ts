import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { PostgresRepository } from "@dg-chat/database";
import { claimJob, renewJobClaim } from "./job-queue.ts";
import {
  beginDurableEmbeddingDispatch,
  callEmbeddingProviderAfterFence,
  prepareDurableEmbeddingBatch,
  recordDurableEmbeddingResponse,
} from "./document-embedding-dispatch.ts";
import { runDatabaseOperation } from "./resilient-loop.ts";
import { retryWorkerClaimedDatabaseOperation } from "./worker-database.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const policy = { initialDelayMs: 10, maxDelayMs: 10 };

async function realStatementTimeout(sql: ReturnType<typeof postgres>): Promise<void> {
  await runDatabaseOperation(() =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout='10ms'`;
      await tx`SELECT pg_sleep(0.05)`;
    })
  );
}

Deno.test({
  name: "worker retries 57014 immediately before fetch and after provider response",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!, {
      conversationSearch: false,
      poolMax: 2,
    });
    const userId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const requestSha256 = "a".repeat(64);
    let providerCalls = 0;
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,state,balance_micros)
        VALUES(${userId},${`${userId}@embedding-57014.test`},'Embedding timeout','hash','admin',
          'approved','active',1000)`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key)
        VALUES(${jobId},'document.embed','{}'::jsonb,${`embedding-57014:${jobId}`})`;
      const job = await claimJob(sql, "embedding-57014", 60);
      if (!job || job.id !== jobId) throw new Error("Timeout test job was not claimed");
      const originalDeadline = job.externalDeadlineMonotonicMs;
      const prepared = await prepareDurableEmbeddingBatch(
        sql,
        job,
        0,
        requestSha256,
        1,
        1,
        5,
      );
      await repository.ensureIdempotentReservation({
        userId,
        usageRunId: prepared.usageRunId,
        model: "embedding-57014",
        provider: "embedding:timeout.test",
        reservedMicros: 10,
        recoveryOwner: "document_embedding",
      });
      await repository.startEmbeddingProviderAttempt({
        usageRunId: prepared.usageRunId,
        purpose: "document",
        provider: "timeout.test",
        model: "embedding-57014",
        upstreamModel: "embedding-57014",
        itemCount: 1,
      });

      let preFetchAttempts = 0;
      const dispatched = await retryWorkerClaimedDatabaseOperation(
        async () => {
          preFetchAttempts += 1;
          if (preFetchAttempts === 1) await realStatementTimeout(sql);
          return await beginDurableEmbeddingDispatch(sql, job, prepared);
        },
        () => renewJobClaim(sql, job),
        { signal: new AbortController().signal, policy },
      );
      const vector = await callEmbeddingProviderAfterFence({
        signal: new AbortController().signal,
        usageRunId: prepared.usageRunId,
        markNoFetchRetrySafe: () => Promise.resolve(),
        call: () => {
          providerCalls += 1;
          return Promise.resolve([Array(1536).fill(0)] as number[][]);
        },
      });

      let responseAttempts = 0;
      const recorded = await retryWorkerClaimedDatabaseOperation(
        async () => {
          responseAttempts += 1;
          if (responseAttempts === 1) await realStatementTimeout(sql);
          return await recordDurableEmbeddingResponse(sql, job, dispatched, vector, 1, 7);
        },
        () => renewJobClaim(sql, job),
        { signal: new AbortController().signal, policy },
      );
      await repository.finalizeEmbeddingProviderUsage({
        usageRunId: prepared.usageRunId,
        status: "succeeded",
        inputTokens: 1,
        costMicros: 6,
        tokenSource: "provider",
        costSource: "calculated",
        latencyMs: 7,
      });

      assertEquals(preFetchAttempts, 2);
      assertEquals(responseAttempts, 2);
      assertEquals(providerCalls, 1);
      assertEquals(recorded.phase, "succeeded");
      assertEquals(recorded.dispatchEpoch, 0);
      assertEquals(job.externalDeadlineMonotonicMs, originalDeadline);
      assertEquals(
        [
          ...await sql`SELECT status,input_tokens::int,cost_micros::int,token_source,cost_source
          FROM embedding_provider_attempts WHERE usage_run_id=${prepared.usageRunId}`,
        ],
        [{
          status: "succeeded",
          input_tokens: 1,
          cost_micros: 6,
          token_source: "provider",
          cost_source: "calculated",
        }],
      );
      assertEquals(
        (await sql<{ balance: number }[]>`SELECT balance_micros::int balance FROM users
          WHERE id=${userId}`)[0].balance,
        994,
      );
    } finally {
      await sql`DELETE FROM jobs WHERE id=${jobId}`;
      await sql`DELETE FROM embedding_provider_attempts WHERE usage_run_id IN
        (SELECT id FROM usage_runs WHERE user_id=${userId})`;
      await sql`DELETE FROM ledger_entries WHERE user_id=${userId}`;
      await sql`DELETE FROM usage_runs WHERE user_id=${userId}`;
      await sql`DELETE FROM users WHERE id=${userId}`;
      await Promise.all([repository.close(), sql.end()]);
    }
  },
});
