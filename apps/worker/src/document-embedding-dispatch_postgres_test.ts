import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import {
  BackupDataError,
  PostgresRepository,
  withRepeatableReadBackupSnapshot,
} from "@dg-chat/database";
import { runAccountedEmbeddingCall } from "../../api/src/embedding-accounting.ts";
import { claimJob } from "./job-queue.ts";
import {
  beginDurableEmbeddingDispatch,
  markDurableEmbeddingDispatchRetrySafe,
  markDurableEmbeddingNoFetchRetrySafe,
  prepareDurableEmbeddingBatch,
  recordDurableEmbeddingResponse,
  recoverRetrySafeEmbeddingDispatch,
  terminalizeUncertainEmbeddingDispatch,
  UncertainEmbeddingDispatchError,
} from "./document-embedding-dispatch.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "terminal document-embedding ownership is conservatively reaped after its job fence",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const userId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const claimToken = `embedding-owner-regression:${crypto.randomUUID()}`;
    const job = {
      id: jobId,
      type: "document.embed",
      payload: {},
      attempts: 1,
      claimToken,
      idempotencyKey: `embedding-owner-regression:${jobId}`,
      externalDeadlineMonotonicMs: performance.now() + 60_000,
    };
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,balance_micros)
        VALUES(${userId},${`${userId}@embedding-owner-regression.test`},'Embedding owner',
          'hash','admin','approved',100)`;
      await sql`INSERT INTO jobs(id,type,payload,status,attempts,locked_at,locked_by,idempotency_key)
        VALUES(${jobId},'document.embed','{}'::jsonb,'running',1,now(),${claimToken},
          ${job.idempotencyKey})`;
      const prepared = await prepareDurableEmbeddingBatch(
        sql,
        job,
        0,
        "a".repeat(64),
        1,
        1,
        5,
      );
      await repository.ensureIdempotentReservation({
        userId,
        usageRunId: prepared.usageRunId,
        model: "embedding-owner-regression",
        provider: "embedding:regression",
        reservedMicros: 10,
        recoveryOwner: "document_embedding",
      });
      await repository.startEmbeddingProviderAttempt({
        usageRunId: prepared.usageRunId,
        purpose: "document",
        provider: "regression",
        model: "embedding-owner-regression",
        upstreamModel: "embedding-owner-regression",
        itemCount: 1,
      });
      await beginDurableEmbeddingDispatch(sql, job, prepared);
      await sql`UPDATE usage_runs SET run_lease_expires_at='2000-01-01T00:00:00Z'
        WHERE id=${prepared.usageRunId}`;

      // A running or queued owner is the no-double-dispatch fence even after accounting expires.
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 0);
      await sql`UPDATE jobs SET status='failed',locked_at=NULL,locked_by=NULL,
        last_error='uncertain provider outcome' WHERE id=${jobId}`;
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 1);
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 0);

      assertEquals(
        [
          ...await sql`SELECT status,input_tokens::int,cost_micros::int,token_source,cost_source
            FROM embedding_provider_attempts WHERE usage_run_id=${prepared.usageRunId}`,
        ],
        [{
          status: "cancelled",
          input_tokens: 5,
          cost_micros: 10,
          token_source: "estimated",
          cost_source: "calculated",
        }],
      );
      assertEquals(
        [
          ...await sql`SELECT status,input_tokens::int,cost_micros::int
            FROM usage_runs WHERE id=${prepared.usageRunId}`,
        ],
        [{ status: "failed", input_tokens: 5, cost_micros: 10 }],
      );
      assertEquals(
        (await sql<{ balance: number }[]>`SELECT balance_micros::int balance FROM users
          WHERE id=${userId}`)[0].balance,
        90,
      );
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "durable embedding dispatch survives lease reaping and job reclamation without duplicate execution or charge",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 3 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    const userId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const successJobId = crypto.randomUUID();
    const uncertainJobId = crypto.randomUUID();
    const retrySafeJobId = crypto.randomUUID();
    const noFetchJobId = crypto.randomUUID();
    const model = "durable-embedding-test";
    const provider = "embedding:durable.test";
    const billing = { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 };
    const content = ["hello"];
    const requestSha256 = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(content)),
    ).then((value) =>
      Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("")
    );
    let providerCalls = 0;
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,balance_micros)
        VALUES(${userId},${`${userId}@durable-embedding.test`},'Durable embedding','hash',
          'admin','approved',1000)`;
      await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,
        sha256,state,ingestion_status,ingested_at) VALUES(${attachmentId},${userId},
        ${`users/${userId}/durable.txt`},'durable.txt','text/plain',5,${"a".repeat(64)},
        'ready','ready',now())`;
      await sql`INSERT INTO document_chunks(id,attachment_id,ordinal,content,metadata)
        VALUES(${chunkId},${attachmentId},0,'hello','{}'::jsonb)`;

      // The first process gets through provider success and durable response recording, but dies
      // before usage settlement or vector publication.
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key) VALUES(${successJobId},
        'document.embed','{}'::jsonb,${`durable-success:${successJobId}`})`;
      const first = await claimJob(sql, "durable-first", 1);
      if (!first || first.id !== successJobId) throw new Error("Success job was not claimed");
      const prepared = await prepareDurableEmbeddingBatch(
        sql,
        first,
        0,
        requestSha256,
        content.length,
        1,
        5,
      );
      await repository.ensureIdempotentReservation({
        userId,
        usageRunId: prepared.usageRunId,
        model,
        provider,
        reservedMicros: 10,
        recoveryOwner: "document_embedding",
      });
      const attempt = {
        usageRunId: prepared.usageRunId,
        purpose: "document" as const,
        provider: "durable.test",
        model,
        upstreamModel: model,
        itemCount: 1,
      };
      // Replaying this call models a committed start whose response was lost.
      await repository.startEmbeddingProviderAttempt(attempt);
      await repository.startEmbeddingProviderAttempt(attempt);
      await beginDurableEmbeddingDispatch(sql, first, prepared);
      assertEquals((await beginDurableEmbeddingDispatch(sql, first, prepared)).phase, "dispatched");
      providerCalls += 1;
      const vector = [Array(1536).fill(0).map((_unused, index) => index === 0 ? 1 : 0)];
      await sql`UPDATE usage_runs SET run_lease_expires_at=now()-interval '1 second'
        WHERE id=${prepared.usageRunId}`;
      await sql`UPDATE jobs SET locked_at=now()-interval '2 seconds' WHERE id=${successJobId}`;
      // The usage reaper must defer to the durable job even though its accounting lease expired.
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 0);

      const reclaimed = await claimJob(sql, "durable-recovery", 1);
      if (!reclaimed || reclaimed.id !== successJobId) {
        throw new Error("Success job was not reclaimed");
      }
      // Separate physical connections race the original immutable dispatch owner recording its
      // valid response against the replacement claimant inspecting the reclaimed job. Shared row
      // lock order makes either serialization safe; the original response is never discarded.
      const responseConnection = postgres(databaseUrl!, { max: 1 });
      const recoveryConnection = postgres(databaseUrl!, { max: 1 });
      const [recorded, racedRecovery] = await Promise.all([
        recordDurableEmbeddingResponse(
          responseConnection,
          first,
          prepared,
          vector,
          2,
          7,
        ),
        prepareDurableEmbeddingBatch(
          recoveryConnection,
          reclaimed,
          0,
          requestSha256,
          1,
          1,
          5,
        ),
      ]).finally(() => Promise.all([responseConnection.end(), recoveryConnection.end()]));
      assertEquals(recorded.phase, "succeeded");
      const recovered = racedRecovery.phase === "succeeded"
        ? racedRecovery
        : await prepareDurableEmbeddingBatch(sql, reclaimed, 0, requestSha256, 1, 1, 5);
      // Replaying after a lost commit response returns the durable result, not an error that could
      // poison accounting or tempt another provider call.
      assertEquals(
        (await recordDurableEmbeddingResponse(sql, first, prepared, vector, 2, 7)).phase,
        "succeeded",
      );
      await assertRejects(
        () => withRepeatableReadBackupSnapshot(databaseUrl!, () => Promise.resolve(undefined)),
        BackupDataError,
        "embedding publication is incomplete",
      );
      const embeddings = await runAccountedEmbeddingCall({
        repository,
        userId,
        usageRunId: recovered.usageRunId,
        purpose: "document",
        provider: "durable.test",
        model,
        upstreamModel: model,
        content,
        billing,
        call: async () => {
          const dispatch = await beginDurableEmbeddingDispatch(sql, reclaimed, recovered);
          if (dispatch.phase === "dispatched") providerCalls += 1;
          return {
            value: dispatch.embeddings!,
            inputTokens: dispatch.inputTokens!,
            latencyMs: dispatch.latencyMs!,
          };
        },
      });
      // A second crash after accounting settlement but before vector publication is also safe:
      // the completed run and durable response are sufficient, so no accounting start or network
      // dispatch is replayed.
      await sql`UPDATE jobs SET locked_at=now()-interval '2 seconds' WHERE id=${successJobId}`;
      const publishRecovery = await claimJob(sql, "durable-publish-recovery", 1);
      if (!publishRecovery || publishRecovery.id !== successJobId) {
        throw new Error("Settled success job was not reclaimed for publication");
      }
      const publishBatch = await prepareDurableEmbeddingBatch(
        sql,
        publishRecovery,
        0,
        requestSha256,
        1,
        1,
        5,
      );
      assertEquals(publishBatch.usageStatus, "completed");
      assertEquals(publishBatch.embeddings, embeddings);
      await sql.begin(async (tx) => {
        await tx`INSERT INTO document_chunk_embeddings(
          chunk_id,owner_id,model,embedding_version,content_sha256,embedding)
          VALUES(${chunkId},${userId},${model},'durable-v1',${"b".repeat(64)},
            ${JSON.stringify(embeddings[0])}::vector)`;
        await tx`UPDATE document_embedding_batches SET phase='committed',committed_at=now(),
          provider_response=NULL,updated_at=now()
          WHERE job_id=${successJobId} AND batch_ordinal=0`;
        await tx`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL
          WHERE id=${successJobId} AND locked_by=${publishRecovery.claimToken}`;
      });
      assertEquals(providerCalls, 1);
      assertEquals(
        (await sql<{ compacted: boolean }[]>`SELECT provider_response IS NULL compacted
          FROM document_embedding_batches WHERE job_id=${successJobId}`)[0].compacted,
        true,
      );
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM ledger_entries
          WHERE usage_run_id=${prepared.usageRunId}`)[0].count,
        2,
      );
      assertEquals(
        (await sql<{ balance: number }[]>`SELECT balance_micros::int balance FROM users
          WHERE id=${userId}`)[0].balance,
        993,
      );

      // A crash after the durable dispatch marker but before a response is fundamentally
      // ambiguous. Reclamation refuses a second provider call; once the job is terminal, the
      // ordinary usage reaper conservatively charges the reservation exactly once.
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key) VALUES(${uncertainJobId},
        'document.embed','{}'::jsonb,${`durable-uncertain:${uncertainJobId}`})`;
      const uncertainFirst = await claimJob(sql, "uncertain-first", 1);
      if (!uncertainFirst || uncertainFirst.id !== uncertainJobId) {
        throw new Error("Uncertain job was not claimed");
      }
      const uncertain = await prepareDurableEmbeddingBatch(
        sql,
        uncertainFirst,
        0,
        requestSha256,
        1,
        1,
        5,
      );
      await repository.ensureIdempotentReservation({
        userId,
        usageRunId: uncertain.usageRunId,
        model,
        provider,
        reservedMicros: 10,
        recoveryOwner: "document_embedding",
      });
      await repository.startEmbeddingProviderAttempt({
        ...attempt,
        usageRunId: uncertain.usageRunId,
      });
      await beginDurableEmbeddingDispatch(sql, uncertainFirst, uncertain);
      providerCalls += 1;
      await sql`UPDATE usage_runs SET run_lease_expires_at=now()-interval '1 second'
        WHERE id=${uncertain.usageRunId}`;
      await sql`UPDATE jobs SET locked_at=now()-interval '2 seconds' WHERE id=${uncertainJobId}`;
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 0);
      const uncertainReclaimed = await claimJob(sql, "uncertain-recovery", 1);
      if (!uncertainReclaimed || uncertainReclaimed.id !== uncertainJobId) {
        throw new Error("Uncertain job was not reclaimed");
      }
      const uncertainRecovered = await prepareDurableEmbeddingBatch(
        sql,
        uncertainReclaimed,
        0,
        requestSha256,
        1,
        1,
        5,
      );
      await assertRejects(
        () => beginDurableEmbeddingDispatch(sql, uncertainReclaimed, uncertainRecovered),
        UncertainEmbeddingDispatchError,
      );
      assertEquals(providerCalls, 2);
      assertEquals(
        await terminalizeUncertainEmbeddingDispatch(
          sql,
          uncertainReclaimed,
          uncertainRecovered.usageRunId,
        ),
        true,
      );
      assertEquals(
        await terminalizeUncertainEmbeddingDispatch(
          sql,
          uncertainReclaimed,
          uncertainRecovered.usageRunId,
        ),
        false,
      );
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 1);
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 0);
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM ledger_entries
          WHERE usage_run_id=${uncertain.usageRunId}`)[0].count,
        1,
      );
      assertEquals(
        [
          ...await sql<{ input_tokens: number; token_source: string }[]>`
          SELECT input_tokens,token_source FROM embedding_provider_attempts
          WHERE usage_run_id=${uncertain.usageRunId}`,
        ],
        [{ input_tokens: 5, token_source: "estimated" }],
      );
      assertEquals(
        (await sql<{ balance: number }[]>`SELECT balance_micros::int balance FROM users
          WHERE id=${userId}`)[0].balance,
        983,
      );

      // A deadline can win before the marker transaction starts, or after it commits but before
      // fetch. The pre_dispatch variant is also zero-cost and must advance to a fresh usage epoch
      // on the next claim instead of reusing a failed reservation.
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key) VALUES(${noFetchJobId},
        'document.embed','{}'::jsonb,${`durable-no-fetch:${noFetchJobId}`})`;
      const noFetchFirst = await claimJob(sql, "no-fetch-first", 1);
      if (!noFetchFirst || noFetchFirst.id !== noFetchJobId) {
        throw new Error("No-fetch job was not claimed");
      }
      const noFetch = await prepareDurableEmbeddingBatch(
        sql,
        noFetchFirst,
        0,
        requestSha256,
        1,
        1,
        5,
      );
      await repository.ensureIdempotentReservation({
        userId,
        usageRunId: noFetch.usageRunId,
        model,
        provider,
        reservedMicros: 10,
        recoveryOwner: "document_embedding",
      });
      await repository.startEmbeddingProviderAttempt({
        ...attempt,
        usageRunId: noFetch.usageRunId,
      });
      await markDurableEmbeddingNoFetchRetrySafe(sql, noFetchFirst, noFetch);
      await repository.finalizeEmbeddingProviderUsage({
        usageRunId: noFetch.usageRunId,
        status: "failed",
        inputTokens: 0,
        costMicros: 0,
        tokenSource: "none",
        costSource: "none",
        latencyMs: 0,
        error: "deadline before fetch",
      });
      await sql`UPDATE jobs SET locked_at=now()-interval '2 seconds' WHERE id=${noFetchJobId}`;
      const noFetchReclaimed = await claimJob(sql, "no-fetch-recovery", 1);
      if (!noFetchReclaimed || noFetchReclaimed.id !== noFetchJobId) {
        throw new Error("No-fetch job was not reclaimed");
      }
      const noFetchRetry = await prepareDurableEmbeddingBatch(
        sql,
        noFetchReclaimed,
        0,
        requestSha256,
        1,
        1,
        5,
      );
      assertEquals(noFetchRetry.phase, "pre_dispatch");
      assertEquals(noFetchRetry.dispatchEpoch, 1);
      assertEquals(noFetchRetry.usageRunId === noFetch.usageRunId, false);
      await repository.ensureIdempotentReservation({
        userId,
        usageRunId: noFetchRetry.usageRunId,
        model,
        provider,
        reservedMicros: 10,
        recoveryOwner: "document_embedding",
      });
      await repository.startEmbeddingProviderAttempt({
        ...attempt,
        usageRunId: noFetchRetry.usageRunId,
      });
      await beginDurableEmbeddingDispatch(sql, noFetchReclaimed, noFetchRetry);
      providerCalls += 1;
      await recordDurableEmbeddingResponse(
        sql,
        noFetchReclaimed,
        noFetchRetry,
        vector,
        1,
        1,
      );
      await repository.finalizeEmbeddingProviderUsage({
        usageRunId: noFetchRetry.usageRunId,
        status: "succeeded",
        inputTokens: 1,
        costMicros: 6,
        tokenSource: "provider",
        costSource: "calculated",
        latencyMs: 1,
      });
      await sql`UPDATE document_embedding_batches SET phase='committed',committed_at=now(),
        provider_response=NULL
        WHERE job_id=${noFetchJobId}`;
      await sql`UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL
        WHERE id=${noFetchJobId}`;
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count
          FROM embedding_provider_attempts WHERE usage_run_id IN
            (${noFetch.usageRunId},${noFetchRetry.usageRunId})`)[0].count,
        2,
      );

      // Terminal dispatch metadata is deliberately ephemeral, while immutable usage, provider
      // attempt, and ledger accounting remains portable. Once the failed job's accounting is
      // settled, it must not disable every installation backup forever.
      let exportedUsage = false;
      let exportedAttempt = false;
      await withRepeatableReadBackupSnapshot(databaseUrl!, async (source) => {
        for await (const batch of source.rows("usage_runs")) {
          exportedUsage ||= batch.some((row) => row.id === uncertain.usageRunId);
        }
        for await (const batch of source.rows("embedding_provider_attempts")) {
          exportedAttempt ||= batch.some((row) => row.usage_run_id === uncertain.usageRunId);
        }
      });
      assertEquals(exportedUsage, true);
      assertEquals(exportedAttempt, true);

      // A definitive HTTP rejection can commit its retry-safe marker immediately before a crash.
      // Reclamation settles that interrupted attempt at zero and advances the epoch before making
      // another provider request. The generic lease reaper uses the same zero-cost interpretation.
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key) VALUES(${retrySafeJobId},
        'document.embed','{}'::jsonb,${`durable-retry-safe:${retrySafeJobId}`})`;
      const retrySafeFirst = await claimJob(sql, "retry-safe-first", 1);
      if (!retrySafeFirst || retrySafeFirst.id !== retrySafeJobId) {
        throw new Error("Retry-safe job was not claimed");
      }
      const retrySafe = await prepareDurableEmbeddingBatch(
        sql,
        retrySafeFirst,
        0,
        requestSha256,
        1,
        1,
        5,
      );
      await repository.ensureIdempotentReservation({
        userId,
        usageRunId: retrySafe.usageRunId,
        model,
        provider,
        reservedMicros: 10,
        recoveryOwner: "document_embedding",
      });
      await repository.startEmbeddingProviderAttempt({
        ...attempt,
        usageRunId: retrySafe.usageRunId,
      });
      await beginDurableEmbeddingDispatch(sql, retrySafeFirst, retrySafe);
      providerCalls += 1;
      await markDurableEmbeddingDispatchRetrySafe(sql, retrySafeFirst, retrySafe);
      await sql`UPDATE usage_runs SET run_lease_expires_at=now()-interval '1 second'
        WHERE id=${retrySafe.usageRunId}`;
      await sql`UPDATE jobs SET locked_at=now()-interval '2 seconds' WHERE id=${retrySafeJobId}`;
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 0);
      const retrySafeReclaimed = await claimJob(sql, "retry-safe-recovery", 1);
      if (!retrySafeReclaimed || retrySafeReclaimed.id !== retrySafeJobId) {
        throw new Error("Retry-safe job was not reclaimed");
      }
      const interrupted = await prepareDurableEmbeddingBatch(
        sql,
        retrySafeReclaimed,
        0,
        requestSha256,
        1,
        1,
        5,
      );
      const retryPrepared = await recoverRetrySafeEmbeddingDispatch(
        interrupted,
        (terminal) => repository.finalizeEmbeddingProviderUsage(terminal),
        () =>
          prepareDurableEmbeddingBatch(
            sql,
            retrySafeReclaimed,
            0,
            requestSha256,
            1,
            1,
            5,
          ),
      );
      assertEquals(retryPrepared.phase, "pre_dispatch");
      assertEquals(retryPrepared.dispatchEpoch, 1);
      assertEquals(
        [
          ...await sql`SELECT status,input_tokens::int,cost_micros::int,token_source,cost_source
            FROM embedding_provider_attempts WHERE usage_run_id=${retrySafe.usageRunId}`,
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
        977,
      );
      await repository.ensureIdempotentReservation({
        userId,
        usageRunId: retryPrepared.usageRunId,
        model,
        provider,
        reservedMicros: 10,
        recoveryOwner: "document_embedding",
      });
      await repository.startEmbeddingProviderAttempt({
        ...attempt,
        usageRunId: retryPrepared.usageRunId,
      });
      await beginDurableEmbeddingDispatch(sql, retrySafeReclaimed, retryPrepared);
      providerCalls += 1;
      await markDurableEmbeddingDispatchRetrySafe(sql, retrySafeReclaimed, retryPrepared);
      await sql`UPDATE usage_runs SET run_lease_expires_at=now()-interval '1 second'
        WHERE id=${retryPrepared.usageRunId}`;
      await sql`UPDATE jobs SET status='failed',last_error='worker stopped after rejection',
        locked_at=NULL,locked_by=NULL WHERE id=${retrySafeJobId}`;
      assertEquals(await repository.reapStaleProviderExecutionLeases(), 1);
      assertEquals(
        [
          ...await sql`SELECT status,input_tokens::int,cost_micros::int,token_source,cost_source
            FROM embedding_provider_attempts WHERE usage_run_id=${retryPrepared.usageRunId}`,
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
        977,
      );
      await withRepeatableReadBackupSnapshot(databaseUrl!, () => Promise.resolve(undefined));
    } finally {
      await sql`DELETE FROM jobs WHERE id IN
        (${successJobId},${uncertainJobId},${retrySafeJobId},${noFetchJobId})`;
      await sql`DELETE FROM embedding_provider_attempts WHERE usage_run_id IN
        (SELECT id FROM usage_runs WHERE user_id=${userId})`;
      await sql`DELETE FROM ledger_entries WHERE user_id=${userId}`;
      await sql`DELETE FROM usage_runs WHERE user_id=${userId}`;
      await sql`DELETE FROM attachments WHERE id=${attachmentId}`;
      await sql`DELETE FROM users WHERE id=${userId}`;
      await repository.close();
      await sql.end();
    }
  },
});
