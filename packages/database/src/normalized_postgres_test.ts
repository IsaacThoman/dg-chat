import { assertEquals, assertExists, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { parseStoredModelCapabilities, PostgresRepository } from "./normalized-postgres.ts";
import { backfillLegacyRuntimeSnapshot } from "./legacy-backfill.ts";
import { decodeApiResponseBody, InvalidApiResponseBodyError } from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres idempotent reservations reject recovery-owner collisions",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repo = await PostgresRepository.connect(databaseUrl!);
    await sql`TRUNCATE audit_events,ledger_entries,usage_runs,api_tokens,sessions,messages,
      conversations,auth_sessions,auth_accounts,auth_verifications,auth_users,users
      RESTART IDENTITY CASCADE`;
    try {
      const user = await repo.bootstrapAdmin({
        email: "postgres-recovery-owner-collision@example.com",
        name: "Recovery owner collision",
        passwordHash: "hash",
      }, 1_000);
      const input = {
        userId: user.id,
        usageRunId: "postgres-recovery-owner-collision",
        model: "tool/echo",
        provider: "tool",
        reservedMicros: 100,
        recoveryOwner: "tool" as const,
      };
      await repo.ensureIdempotentReservation(input);
      await assertRejects(
        () => repo.ensureIdempotentReservation({ ...input, recoveryOwner: "provider" }),
        DomainError,
        "Existing reservation does not match",
      );
      const runs = await sql<{ recovery_owner: string }[]>`SELECT recovery_owner FROM usage_runs
        WHERE id=${input.usageRunId}`;
      assertEquals(runs[0]?.recovery_owner, "tool");
      const ledger = await sql<{ kind: string }[]>`SELECT kind FROM ledger_entries
        WHERE usage_run_id=${input.usageRunId} ORDER BY sequence`;
      assertEquals([...ledger], [{ kind: "reserve" }]);

      const tokenId = crypto.randomUUID();
      await sql`INSERT INTO api_tokens(
        id,user_id,name,token_hash,preview,scopes,authority_epoch,rotation_family_id
      ) VALUES(
        ${tokenId},${user.id},'Collision token',${`collision-${tokenId}`},'fixture',
        '["chat:write"]'::jsonb,1,${tokenId}
      )`;
      const tokenRunId = "postgres-token-owner-collision";
      const tokenRun = await repo.reserve(
        user.id,
        tokenRunId,
        "tool/echo",
        100,
        "tool",
        tokenId,
      );
      assertEquals(tokenRun.tokenId, tokenId);
      await assertRejects(
        () =>
          repo.ensureIdempotentReservation({
            userId: user.id,
            usageRunId: tokenRunId,
            model: "tool/echo",
            provider: "tool",
            reservedMicros: 100,
            recoveryOwner: "provider",
          }),
        DomainError,
        "Existing reservation does not match",
      );
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres retention policy atomically gates capture and bounded scrubbing",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE retention_scrub_runs,provider_payload_captures,audit_events,jobs,
      provider_attempts,model_price_versions,provider_models,providers,ledger_entries,usage_runs,
      api_tokens,sessions,messages,conversations,users RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO retention_policy_versions(version,capture_enabled,request_body_days,
      response_body_days) VALUES(1,false,30,30) ON CONFLICT(version) DO UPDATE SET
      capture_enabled=false,request_body_days=30,response_body_days=30,updated_by=NULL`;
    await sql`INSERT INTO retention_policy_state(singleton_id,current_version) VALUES(1,1)
      ON CONFLICT(singleton_id) DO UPDATE SET current_version=1`;
    await sql`DELETE FROM retention_policy_versions WHERE version>1`;
    const userId = crypto.randomUUID();
    const providerId = crypto.randomUUID();
    const modelId = crypto.randomUUID();
    const priceId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await sql`INSERT INTO users(id,email,name,role,approval_status,state)
      VALUES(${userId},'retention-pg@example.com','Retention','admin','approved','active')`;
    await sql`INSERT INTO usage_runs(id,user_id,model,provider,recovery_owner,status)
      VALUES('retention-pg-run',${userId},'retention/model','retention','provider','completed')`;
    await sql`INSERT INTO providers(id,slug,display_name,base_url,protocol)
      VALUES(${providerId},'retention','Retention','https://example.com/v1','responses')`;
    await sql`INSERT INTO provider_models(id,provider_id,public_model_id,upstream_model_id,
      display_name,capabilities,context_window) VALUES(${modelId},${providerId},'retention/model',
      'model','Model','["chat"]',1000)`;
    await sql`INSERT INTO model_price_versions(id,provider_model_id,effective_at,
      input_micros_per_million,cached_input_micros_per_million,reasoning_micros_per_million,
      output_micros_per_million,fixed_call_micros,source) VALUES(${priceId},${modelId},now(),1,1,1,1,1,'test')`;
    await sql`INSERT INTO provider_attempts(id,usage_run_id,attempt_number,execution_epoch,
      target_ordinal,retry_number,reason,provider_id,provider_slug,provider_version,protocol,
      provider_model_id,public_model_id,upstream_model_id,model_version,pricing_version_id,
      pricing_input_micros_per_million,pricing_cached_input_micros_per_million,
      pricing_reasoning_micros_per_million,pricing_output_micros_per_million,
      pricing_fixed_call_micros,pricing_source,status,phase,completed_at)
      VALUES(${attemptId},'retention-pg-run',1,1,0,0,'primary',${providerId},'retention',1,
      'responses',${modelId},'retention/model','model',1,${priceId},1,1,1,1,1,'test',
      'succeeded','complete',now())`;
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      assertEquals(
        await repo.captureProviderPayload({
          usageRunId: "retention-pg-run",
          providerAttemptId: attemptId,
          requestBody: "disabled",
        }),
        null,
      );
      assertEquals(
        await repo.captureProviderPayload({
          usageRunId: "invalid-disabled-run",
          providerAttemptId: "not-a-uuid",
          requestBody: "must remain gated",
        }),
        null,
      );
      const policy = await repo.updateRetentionPolicy({
        expectedVersion: 1,
        captureEnabled: true,
        requestBodyDays: 1,
        responseBodyDays: 1,
      }, userId);
      const capture = await repo.captureProviderPayload({
        usageRunId: "retention-pg-run",
        providerAttemptId: attemptId,
        requestBody: "request",
        responseBody: "response",
      });
      await sql`UPDATE provider_payload_captures SET captured_at=now()-interval '2 days'
        WHERE id=${capture!.id}`;
      const secondAttemptId = crypto.randomUUID();
      await sql`INSERT INTO provider_attempts SELECT ${secondAttemptId},usage_run_id,2,
        execution_epoch,target_ordinal,retry_number,reason,breaker_before,breaker_after,retryable,
        provider_id,provider_slug,provider_version,protocol,provider_model_id,public_model_id,
        upstream_model_id,model_version,pricing_version_id,pricing_input_micros_per_million,
        pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,
        pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source,status,phase,
        error_code,http_status,visible_output,input_tokens,cached_input_tokens,reasoning_tokens,
        output_tokens,cost_micros,token_source,cost_source,latency_ms,ttft_ms,upstream_request_id,
        tokens_per_second,started_at,completed_at FROM provider_attempts WHERE id=${attemptId}`;
      const secondCapture = await repo.captureProviderPayload({
        usageRunId: "retention-pg-run",
        providerAttemptId: secondAttemptId,
        requestBody: "second",
      });
      await sql`UPDATE provider_payload_captures SET captured_at=now()-interval '2 days'
        WHERE id=${secondCapture!.id}`;
      const preview = await repo.previewRetentionScrub();
      assertEquals(preview.captures, 2);
      const concurrentRuns = await Promise.all(
        Array.from({ length: 4 }, () =>
          repo.enqueueRetentionScrub({
            idempotencyKey: "retention-pg-scrub",
            expectedPolicyVersion: policy.version,
            requestCutoffAt: preview.requestCutoffAt,
            responseCutoffAt: preview.responseCutoffAt,
          }, userId)),
      );
      assertEquals(new Set(concurrentRuns.map((run) => run.id)).size, 1);
      const run = concurrentRuns[0];
      const failedRun = await repo.enqueueRetentionScrub({
        idempotencyKey: "retention-pg-failure",
        expectedPolicyVersion: policy.version,
        requestCutoffAt: preview.requestCutoffAt,
        responseCutoffAt: preview.responseCutoffAt,
      }, userId);
      await repo.updateRetentionPolicy({
        expectedVersion: policy.version,
        captureEnabled: true,
        requestBodyDays: 90,
        responseBodyDays: 90,
      }, userId);
      const thirdAttemptId = crypto.randomUUID();
      await sql`INSERT INTO provider_attempts SELECT ${thirdAttemptId},usage_run_id,3,
        execution_epoch,target_ordinal,retry_number,reason,breaker_before,breaker_after,retryable,
        provider_id,provider_slug,provider_version,protocol,provider_model_id,public_model_id,
        upstream_model_id,model_version,pricing_version_id,pricing_input_micros_per_million,
        pricing_cached_input_micros_per_million,pricing_reasoning_micros_per_million,
        pricing_output_micros_per_million,pricing_fixed_call_micros,pricing_source,status,phase,
        error_code,http_status,visible_output,input_tokens,cached_input_tokens,reasoning_tokens,
        output_tokens,cost_micros,token_source,cost_source,latency_ms,ttft_ms,upstream_request_id,
        tokens_per_second,started_at,completed_at FROM provider_attempts WHERE id=${attemptId}`;
      const future = await repo.captureProviderPayload({
        usageRunId: "retention-pg-run",
        providerAttemptId: thirdAttemptId,
        requestBody: "after-preview",
      });
      const firstBatch = await repo.scrubRetentionBatch(run.id, 1);
      assertEquals(firstBatch.completed, false);
      const result = await repo.scrubRetentionBatch(run.id, 1);
      assertEquals(result.completed, true);
      assertEquals(result.run.requestCutoffAt, preview.requestCutoffAt);
      assertEquals(
        (await sql`SELECT request_body FROM provider_payload_captures
        WHERE id=${future!.id}`)[0].request_body,
        "after-preview",
      );
      assertEquals([
        ...await sql`SELECT request_body,response_body,scrubbed_at IS NOT NULL scrubbed
        FROM provider_payload_captures WHERE id=${capture!.id}`,
      ], [{ request_body: null, response_body: null, scrubbed: true }]);
      await repo.failRetentionScrubRun(failedRun.id, "worker_retry_exhausted");
      await repo.failRetentionScrubRun(failedRun.id, "manual_recovery");
      const failedJob = await sql`UPDATE jobs SET status='failed',attempts=5
        WHERE type='retention.scrub' AND payload->>'runId'=${failedRun.id} RETURNING id`;
      await repo.retryFailedJob(String(failedJob[0].id), userId);
      assertEquals((await repo.getRetentionScrubRun(failedRun.id)).status, "queued");
      assertEquals((await repo.scrubRetentionBatch(failedRun.id)).completed, true);
      assertEquals((await repo.scrubRetentionBatch(failedRun.id)).processed, 0);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events WHERE
        target_id=${failedRun.id} AND action='retention.scrub.failed'`)[0].count,
        ),
        1,
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events WHERE
        target_id=${failedRun.id} AND action='retention.scrub.completed'`)[0].count,
        ),
        1,
      );
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres operational analytics and job retry preserve safe canonical semantics",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE jobs, ledger_entries, usage_runs, api_tokens, sessions, messages,
      conversations, users RESTART IDENTITY CASCADE`;
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const user = await repo.bootstrapAdmin({
        email: "operational-admin-pg@example.com",
        name: "Operational admin",
        passwordHash: "hash",
      }, 1_000);
      await sql`INSERT INTO usage_runs(id,user_id,model,provider,recovery_owner,status,cost_micros,input_tokens,
        output_tokens,latency_ms,ttft_ms,actual_provider_cost_micros,
        actual_provider_input_tokens,actual_provider_cached_input_tokens,
        actual_provider_reasoning_tokens,actual_provider_output_tokens,created_at)
        VALUES ('analytics-run',${user.id},'provider/model','provider','provider','completed',40,10,5,100,20,
        25,10,2,1,5,'2026-01-01T00:00:00Z')`;
      const analytics = await repo.adminAnalytics({
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
        bucket: "day",
      });
      assertEquals(analytics.summary.calls, 1);
      assertEquals(analytics.summary.cachedInputTokens, 2);
      assertEquals(analytics.summary.providerCostMicros, 25);
      const jobRows =
        await sql`INSERT INTO jobs(type,payload,status,attempts,last_error,completed_at)
        VALUES ('attachment.ingest',${sql.json({ secret: "redacted" })},'failed',3,'failure',now())
        RETURNING id`;
      await sql`INSERT INTO jobs(type,payload,status,attempts,last_error,completed_at,created_at)
        VALUES ('attachment.inspect',${sql.json({})},'failed',1,'older',now(),
          now()-interval '1 hour'),
        ('attachment.inspect',${sql.json({})},'failed',1,'oldest',now(),
          now()-interval '2 hours')`;
      const page = await repo.listJobs({ status: "failed", limit: 1 });
      assertEquals(page.items[0].id, String(jobRows[0].id));
      assertEquals("payload" in page.items[0], false);
      const secondPage = await repo.listJobs({
        status: "failed",
        limit: 1,
        cursor: page.nextCursor!,
      });
      const thirdPage = await repo.listJobs({
        status: "failed",
        limit: 1,
        cursor: secondPage.nextCursor!,
      });
      assertEquals(secondPage.hasPrevious, true);
      assertEquals(secondPage.previousCursor, null);
      assertEquals(thirdPage.previousCursor, page.nextCursor);
      await assertRejects(
        () =>
          repo.listJobs({
            cursor: btoa(JSON.stringify({
              createdAtMicros: "99999999999999999999",
              id: crypto.randomUUID(),
            })),
          }),
        DomainError,
        "Invalid job cursor",
      );
      const retried = await repo.retryFailedJob(page.items[0].id, user.id);
      assertEquals(retried.priorAttempts, 3);
      assertEquals(retried.job.status, "queued");
      const retriedJobId = page.items[0].id;
      const audit = await sql<{ actor_id: string; metadata: { priorAttempts: number } }[]>`
        SELECT actor_id,metadata FROM audit_events
        WHERE action='job.retried' AND target_id=${retriedJobId}`;
      assertEquals(String(audit[0].actor_id), user.id);
      assertEquals(audit[0].metadata.priorAttempts, 3);
      await assertRejects(
        () => repo.retryFailedJob(page.items[0].id, user.id),
        DomainError,
        "Only failed",
      );
      const rollbackRows = await sql<{ id: string }[]>`INSERT INTO jobs
        (type,payload,status,attempts,last_error,completed_at)
        VALUES ('attachment.inspect',${sql.json({})},'failed',2,'failure',now()) RETURNING id`;
      await assertRejects(() => repo.retryFailedJob(rollbackRows[0].id, "not-a-uuid"));
      const rolledBack = await sql<{ status: string; attempts: number }[]>`
        SELECT status,attempts FROM jobs WHERE id=${rollbackRows[0].id}::uuid`;
      assertEquals(rolledBack[0], { status: "failed", attempts: 2 });
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "Postgres binary API replay round-trips decoded bytes and rejects malformed Base64 atomically",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE api_idempotency_events, api_idempotency_requests, ledger_entries,
      usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const user = await repo.bootstrapAdmin({
        email: "binary-replay-pg@example.com",
        name: "Binary replay",
        passwordHash: "hash",
      }, 1_000);
      const begin = async (suffix: string) =>
        await repo.beginApiRequest({
          userId: user.id,
          endpoint: "audio.speech",
          idempotencyKey: `postgres-binary-${suffix}`,
          requestHash: suffix.repeat(64).slice(0, 64),
          stream: false,
          model: "test/binary",
          runId: `postgres-binary-run-${suffix}`,
          reserveMicros: 10,
          provider: "test",
          quota: { maxRequests: 5, maxEvents: 5, maxBytes: 3 },
        });
      const valid = await begin("a");
      if (valid.kind !== "started") throw new Error("expected started request");
      const completed = await repo.completeApiJson({
        id: valid.request.id,
        leaseToken: valid.leaseToken,
        responseStatus: 200,
        responseBody: "SUQz",
        responseBodyEncoding: "base64",
        costMicros: 1,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        quota: { maxRequests: 5, maxEvents: 5, maxBytes: 3 },
      });
      assertEquals(completed.responseBodyEncoding, "base64");
      assertEquals(
        decodeApiResponseBody(completed.responseBody!, completed.responseBodyEncoding),
        new Uint8Array([73, 68, 51]),
      );

      const malformed = await begin("b");
      if (malformed.kind !== "started") throw new Error("expected started request");
      await assertRejects(
        () =>
          repo.completeApiJson({
            id: malformed.request.id,
            leaseToken: malformed.leaseToken,
            responseStatus: 200,
            responseBody: "YR==",
            responseBodyEncoding: "base64",
            costMicros: 1,
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
          }),
        InvalidApiResponseBodyError,
        "canonical Base64",
      );
      const state = await sql<{ request_state: string; usage_state: string }[]>`
        SELECT r.state request_state,u.status usage_state FROM api_idempotency_requests r
        JOIN usage_runs u ON u.id=r.usage_run_id WHERE r.id=${malformed.request.id}`;
      assertEquals(state[0], { request_state: "in_progress", usage_state: "reserved" });
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test("persisted provider capabilities reject legacy or malformed values explicitly", () => {
  assertEquals(parseStoredModelCapabilities(["chat", "transcription"], "valid/model"), [
    "chat",
    "transcription",
  ]);
  for (const capabilities of [["chat", "legacy-custom"], ["chat", "chat"], "chat", [1]]) {
    assertThrows(
      () => parseStoredModelCapabilities(capabilities, "broken/model"),
      DomainError,
      "invalid persisted capabilities",
    );
  }
});

Deno.test({
  name: "Postgres OCR child reservation is atomic and fenced by its parent lease",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE provider_attempts, provider_model_route_targets, provider_model_routes,
      provider_retry_policies, model_price_versions, provider_models, providers,
      api_idempotency_events, api_idempotency_requests, ledger_entries, usage_runs,
      api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const user = await repo.bootstrapAdmin({
        email: "ocr-child-pg@example.com",
        name: "OCR child",
        passwordHash: "hash",
      }, 250);
      const provider = await sql<{ id: string }[]>`INSERT INTO providers
        (slug,display_name,base_url,protocol) VALUES
        ('ocr-child','OCR child','https://ocr.example/v1','chat_completions') RETURNING id`;
      const model = await sql<{ id: string }[]>`INSERT INTO provider_models
        (provider_id,public_model_id,upstream_model_id,display_name,capabilities,context_window)
        VALUES(${provider[0].id},'ocr/child','vision','OCR child','["chat","vision"]',8192)
        RETURNING id`;
      const price = await sql<{ id: string }[]>`INSERT INTO model_price_versions
        (provider_model_id,input_micros_per_million,cached_input_micros_per_million,
          reasoning_micros_per_million,output_micros_per_million,fixed_call_micros,source,
          effective_at)
        VALUES(${model[0].id},1,1,1,1,0,'test',now()-interval '1 minute') RETURNING id`;
      const parent = await repo.reserve(user.id, "ocr-pg-parent", "chat/model", 50);
      const reserve = (runId: string) =>
        repo.reserveChildProviderUsage({
          parentUsageRunId: parent.id,
          parentOwnerLeaseToken: parent.runLeaseToken!,
          runId,
          model: "ocr/child",
          provider: "ocr:child",
          reserveMicros: 150,
          pricingSnapshot: {
            pricingVersionId: price[0].id,
            inputMicrosPerMillion: 1,
            cachedInputMicrosPerMillion: 1,
            reasoningMicrosPerMillion: 1,
            outputMicrosPerMillion: 1,
            fixedCallMicros: 0,
            source: "test",
          },
        });
      const results = await Promise.allSettled([reserve("ocr-pg-a"), reserve("ocr-pg-b")]);
      assertEquals(results.filter((result) => result.status === "fulfilled").length, 1);
      const ledger = await sql<{ kind: string; amount: string }[]>`SELECT kind,
        amount_micros::text amount FROM ledger_entries ORDER BY id`;
      assertEquals(
        ledger.filter((entry) => entry.kind === "reserve").map((entry) => entry.amount).sort(),
        ["-150", "-50"],
      );
      const child = results.find((result) => result.status === "fulfilled") as
        | PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>>
        | undefined;
      await repo.refund(child!.value.id);
      await repo.refund(parent.id);
      await assertRejects(
        () => reserve("ocr-pg-stale"),
        DomainError,
        "stale",
      );

      const expanded = await repo.reserve(user.id, "ocr-pg-expand", "chat/model", 50);
      const ensure = (requiredMicros: number) =>
        repo.ensureUsageReservation({
          usageRunId: expanded.id,
          ownerLeaseToken: expanded.runLeaseToken!,
          requiredMicros,
        });
      await Promise.all([ensure(150), ensure(200)]);
      const state = await sql<{ reserved: string; balance: string; total: string }[]>`
        SELECT r.reserved_micros::text reserved,u.balance_micros::text balance,
          (SELECT sum(amount_micros)::text FROM ledger_entries
            WHERE usage_run_id=r.id AND kind='reserve') total
        FROM usage_runs r JOIN users u ON u.id=r.user_id WHERE r.id=${expanded.id}`;
      assertEquals(state[0], { reserved: "200", balance: "50", total: "-200" });
      await repo.refund(expanded.id);
      await assertRejects(() => ensure(250), DomainError, "stale");
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres customer settlement is separate from provider costs and stale leases",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE provider_attempts, provider_model_route_targets, provider_model_routes,
      provider_retry_policies, model_price_versions, provider_models, providers,
      api_idempotency_events, api_idempotency_requests, ledger_entries, usage_runs,
      api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const user = await repo.bootstrapAdmin({
        email: "provider-accounting-pg@example.com",
        name: "Provider accounting",
        passwordHash: "hash",
      }, 1_000);
      const completed = await repo.beginApiRequest({
        userId: user.id,
        endpoint: "chat.completions",
        idempotencyKey: "postgres-source-target-complete",
        requestHash: "a".repeat(64),
        stream: false,
        model: "public/source-model",
        provider: "provider",
        runId: "postgres-source-target-complete-run",
        reserveMicros: 100,
      });
      if (completed.kind !== "started") throw new Error("request did not start");
      // Simulate two fallback attempts whose aggregate target cost is much lower than the
      // immutable public/source charge supplied by the route.
      await sql`UPDATE usage_runs SET execution_epoch=1,actual_provider_cost_micros=7,
        actual_provider_input_tokens=3,actual_provider_output_tokens=2
        WHERE id=${completed.usageRun.id}`;
      await repo.completeApiJson({
        id: completed.request.id,
        leaseToken: completed.leaseToken,
        responseStatus: 200,
        responseBody: "{}",
        costMicros: 99,
        inputTokens: 91,
        outputTokens: 8,
        latencyMs: 1,
      });
      const completedState = await sql<
        Array<{
          cost: string;
          input_tokens: number;
          actual_cost: string;
          actual_input_tokens: string;
        }>
      >`SELECT cost_micros::text cost,input_tokens,
          actual_provider_cost_micros::text actual_cost,
          actual_provider_input_tokens actual_input_tokens
        FROM usage_runs WHERE id=${completed.usageRun.id}`;
      assertEquals(completedState[0], {
        cost: "99",
        input_tokens: 91,
        actual_cost: "7",
        actual_input_tokens: "3",
      });

      const fallback = await repo.beginApiRequest({
        userId: user.id,
        endpoint: "chat.completions",
        idempotencyKey: "postgres-source-target-fallback",
        requestHash: "f".repeat(64),
        stream: false,
        model: "public/low-price",
        provider: "provider",
        runId: "postgres-source-target-fallback-run",
        reserveMicros: 800,
      });
      if (fallback.kind !== "started") throw new Error("fallback request did not start");
      await sql`UPDATE usage_runs SET execution_epoch=1,actual_provider_cost_micros=700,
        actual_provider_input_tokens=600,actual_provider_output_tokens=100
        WHERE id=${fallback.usageRun.id}`;
      await repo.completeApiJson({
        id: fallback.request.id,
        leaseToken: fallback.leaseToken,
        responseStatus: 200,
        responseBody: "{}",
        costMicros: 2,
        inputTokens: 8,
        outputTokens: 1,
        latencyMs: 2,
      });
      const fallbackState = await sql<
        Array<{ customer_cost: string; customer_input: number; provider_cost: string }>
      >`SELECT cost_micros::text customer_cost,input_tokens customer_input,
          actual_provider_cost_micros::text provider_cost
        FROM usage_runs WHERE id=${fallback.usageRun.id}`;
      assertEquals(fallbackState[0], {
        customer_cost: "2",
        customer_input: 8,
        provider_cost: "700",
      });

      const begun = await repo.beginApiRequest({
        userId: user.id,
        endpoint: "chat.completions",
        idempotencyKey: "postgres-provider-failure",
        requestHash: "c".repeat(64),
        stream: false,
        model: "provider/model",
        provider: "provider",
        runId: "postgres-provider-failure-run",
        reserveMicros: 100,
      });
      if (begun.kind !== "started") throw new Error("request did not start");
      await sql`UPDATE usage_runs SET execution_epoch=1,actual_provider_cost_micros=7,
        actual_provider_input_tokens=3,actual_provider_output_tokens=2
        WHERE id=${begun.usageRun.id}`;
      await repo.failApiRequest({
        id: begun.request.id,
        leaseToken: begun.leaseToken,
        responseStatus: 502,
        responseBody: "{}",
        billing: { mode: "refund" },
      });
      const failed = await sql<
        { status: string; cost: string; input_tokens: number }[]
      >`SELECT status,cost_micros::text cost,input_tokens FROM usage_runs WHERE id=${begun.usageRun.id}`;
      assertEquals(failed[0], { status: "failed", cost: "0", input_tokens: 0 });
      const retainedProvider = await sql<
        { cost: string; input_tokens: string }[]
      >`SELECT actual_provider_cost_micros::text cost,actual_provider_input_tokens input_tokens
        FROM usage_runs WHERE id=${begun.usageRun.id}`;
      assertEquals(retainedProvider[0], { cost: "7", input_tokens: "3" });

      const stale = await repo.reserve(user.id, "postgres-provider-stale", "provider/model", 100);
      await sql`UPDATE usage_runs SET execution_epoch=1,actual_provider_cost_micros=5,
        run_lease_expires_at=now()-interval '1 second' WHERE id=${stale.id}`;
      // The generic reaper keys on durable ownership, never provider strings or run prefixes.
      const providerOwnedToolNamedRun = await repo.reserve(
        user.id,
        `tool:${crypto.randomUUID()}`,
        "tool/echo",
        100,
        "tool",
      );
      await sql`UPDATE usage_runs SET run_lease_expires_at=now()-interval '1 second'
        WHERE id=${providerOwnedToolNamedRun.id}`;
      const staleTool = await repo.ensureIdempotentReservation({
        userId: user.id,
        usageRunId: `tool:${crypto.randomUUID()}`,
        model: "tool/echo",
        provider: "tool",
        reservedMicros: 100,
        recoveryOwner: "tool",
      });
      await sql`UPDATE usage_runs SET run_lease_expires_at=now()-interval '1 second'
        WHERE id=${staleTool.id}`;
      const providers = await sql<{ id: string }[]>`INSERT INTO providers
        (slug,display_name,base_url,protocol) VALUES
        ('uncertain-provider','Uncertain provider','https://uncertain.example/v1','chat_completions')
        RETURNING id`;
      const models = await sql<{ id: string }[]>`INSERT INTO provider_models
        (provider_id,public_model_id,upstream_model_id,display_name,capabilities,context_window)
        VALUES(${providers[0].id},'uncertain/model','upstream','Uncertain model','["chat"]',8192)
        RETURNING id`;
      const prices = await sql<{ id: string }[]>`INSERT INTO model_price_versions
        (provider_model_id,effective_at,input_micros_per_million,
          cached_input_micros_per_million,reasoning_micros_per_million,
          output_micros_per_million,fixed_call_micros,source)
        VALUES(${models[0].id},now(),100000,50000,200000,300000,10,'test') RETURNING id`;
      const insertUncertainAttempt = (runId: string) =>
        sql`INSERT INTO provider_attempts
          (usage_run_id,attempt_number,execution_epoch,target_ordinal,retry_number,reason,
            breaker_before,provider_id,provider_slug,provider_version,protocol,provider_model_id,
            public_model_id,upstream_model_id,model_version,pricing_version_id,
            pricing_input_micros_per_million,pricing_cached_input_micros_per_million,
            pricing_reasoning_micros_per_million,pricing_output_micros_per_million,
            pricing_fixed_call_micros,pricing_source)
          VALUES(${runId},1,1,0,0,'primary','closed',${providers[0].id},
            'uncertain-provider',1,'chat_completions',${
          models[0].id
        },'uncertain/model','upstream',1,
            ${prices[0].id},100000,50000,200000,300000,10,'test')`;
      await insertUncertainAttempt(stale.id);
      assertEquals(await repo.reapStaleProviderExecutionLeases(), 2);
      assertEquals(await repo.reapStaleProviderExecutionLeases(), 0);
      const reaped = await sql<
        { status: string; cost: string; run_lease_token: string | null }[]
      >`SELECT status,cost_micros::text cost,run_lease_token::text FROM usage_runs WHERE id=${stale.id}`;
      assertEquals(reaped[0], { status: "failed", cost: "0", run_lease_token: null });
      const attempts = await sql<
        { status: string; error_code: string | null }[]
      >`SELECT status,error_code FROM provider_attempts WHERE usage_run_id=${stale.id}`;
      assertEquals([...attempts], [{ status: "cancelled", error_code: "execution_lease_expired" }]);
      assertEquals(
        (await sql<{ status: string; provider: string; recovery_owner: string }[]>`
          SELECT status,provider,recovery_owner FROM usage_runs
          WHERE id=${providerOwnedToolNamedRun.id}`)[0],
        { status: "failed", provider: "tool", recovery_owner: "provider" },
      );
      const preservedTool = await sql<
        { status: string; run_lease_token: string | null; recovery_owner: string }[]
      >`SELECT status,run_lease_token::text,recovery_owner FROM usage_runs
        WHERE id=${staleTool.id}`;
      assertEquals(preservedTool[0].status, "reserved");
      assertEquals(preservedTool[0].recovery_owner, "tool");
      assertEquals(typeof preservedTool[0].run_lease_token, "string");
      assertEquals(
        (await sql`SELECT kind FROM ledger_entries WHERE usage_run_id=${staleTool.id}`)
          .map((entry) => entry.kind),
        ["reserve"],
      );

      const api = await repo.beginApiRequest({
        userId: user.id,
        endpoint: "chat.completions",
        idempotencyKey: "postgres-uncertain-api-reaper",
        requestHash: "e".repeat(64),
        stream: false,
        model: "uncertain/model",
        provider: "uncertain-provider",
        runId: "postgres-uncertain-api-run",
        reserveMicros: 100,
      });
      if (api.kind !== "started") throw new Error("API request did not start");
      await sql`UPDATE usage_runs SET execution_epoch=1 WHERE id=${api.usageRun.id}`;
      await sql`UPDATE api_idempotency_requests SET lease_expires_at=now()-interval '1 second',
        observed_cost_micros=25,observed_input_tokens=5,observed_output_tokens=2,
        observed_latency_ms=10
        WHERE id=${api.request.id}`;
      await insertUncertainAttempt(api.usageRun.id);
      const apiBalanceBefore = await sql<
        { balance: string }[]
      >`SELECT balance_micros::text balance FROM users WHERE id=${user.id}`;
      assertEquals(await repo.reapStaleApiRequests(), 1);
      const apiRun = await sql<
        { status: string; cost: string }[]
      >`SELECT status,cost_micros::text cost FROM usage_runs WHERE id=${api.usageRun.id}`;
      const apiBalanceAfter = await sql<
        { balance: string }[]
      >`SELECT balance_micros::text balance FROM users WHERE id=${user.id}`;
      const apiAttempts = await sql<
        { status: string; error_code: string | null; retryable: boolean }[]
      >`SELECT status,error_code,retryable FROM provider_attempts
        WHERE usage_run_id=${api.usageRun.id}`;
      assertEquals([...apiRun], [{ status: "failed", cost: "25" }]);
      assertEquals(Number(apiBalanceAfter[0].balance), Number(apiBalanceBefore[0].balance) + 75);
      assertEquals([...apiAttempts], [{
        status: "cancelled",
        error_code: "api_lease_expired",
        retryable: true,
      }]);
      assertEquals(await repo.usage(user.id), {
        balanceMicros: Number(apiBalanceAfter[0].balance),
        calls: 3,
        inputTokens: 104,
        outputTokens: 11,
        spentMicros: 126,
      });
      const analytics = await repo.adminAnalytics({
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
        bucket: "hour",
        userId: user.id,
      });
      assertEquals(analytics.summary.completed, 2);
      assertEquals(analytics.summary.failed, 4);

      const conversation = await repo.createConversation(user.id, "Uncertain generation");
      const generation = await repo.beginGeneration({
        message: {
          conversationId: conversation.id,
          ownerId: user.id,
          parentId: null,
          role: "user",
          content: "hello",
          model: "uncertain/model",
          expectedVersion: conversation.version,
          idempotencyKey: "postgres-uncertain-generation-user",
        },
        runId: "postgres-uncertain-generation-run",
        provider: "uncertain-provider",
        reserveMicros: 100,
      });
      if (generation.kind !== "started") throw new Error("generation did not start");
      await sql`UPDATE usage_runs SET execution_epoch=1,
        generation_lease_expires_at=now()-interval '1 second' WHERE id=${generation.usageRun.id}`;
      await insertUncertainAttempt(generation.usageRun.id);
      const generationBalanceBefore = await sql<
        { balance: string }[]
      >`SELECT balance_micros::text balance FROM users WHERE id=${user.id}`;
      assertEquals(await repo.reapStaleGenerations(), 1);
      const generationRun = await sql<
        { status: string; cost: string }[]
      >`SELECT status,cost_micros::text cost FROM usage_runs WHERE id=${generation.usageRun.id}`;
      const generationBalanceAfter = await sql<
        { balance: string }[]
      >`SELECT balance_micros::text balance FROM users WHERE id=${user.id}`;
      const generationAttempts = await sql<
        { status: string; error_code: string | null }[]
      >`SELECT status,error_code FROM provider_attempts
        WHERE usage_run_id=${generation.usageRun.id}`;
      assertEquals([...generationRun], [{ status: "failed", cost: "0" }]);
      assertEquals(
        Number(generationBalanceAfter[0].balance),
        Number(generationBalanceBefore[0].balance) + 100,
      );
      assertEquals([...generationAttempts], [{
        status: "cancelled",
        error_code: "generation_lease_expired",
      }]);
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "normalized repository commits identity, graph, and credit mutations atomically",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();

    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const admin = await repo.bootstrapAdmin({
        email: "admin@database.test",
        name: "Admin",
        passwordHash: "hash",
        emailVerified: true,
      }, 5_000_000);
      assertEquals(admin.balanceMicros, 5_000_000);
      await assertRejects(
        () =>
          repo.bootstrapAdmin({
            email: "other@database.test",
            name: "Other",
            passwordHash: "hash",
          }, 5_000_000),
        DomainError,
        "already exists",
      );

      const applicant = await repo.createUser({
        email: "user@database.test",
        name: "User",
        passwordHash: "hash",
        emailVerified: true,
      });
      const oidcOnly = await repo.createUser({
        email: "oidc-only@database.test",
        name: "OIDC only",
        emailVerified: true,
      });
      assertEquals(oidcOnly.passwordHash, null);
      const limitedSession = await repo.createSession(applicant.id, "limited-session-hash", true);
      let managedApplicant = await repo.decideUserApproval({
        actorId: admin.id,
        targetUserId: applicant.id,
        expectedVersion: applicant.version,
        status: "approved",
        startingCreditMicros: 1_000_000,
      });
      assertEquals((await repo.getSession(limitedSession.tokenHash))?.limited, true);
      const session = await repo.createSession(applicant.id, "session-hash", false);
      assertEquals((await repo.getSession(session.tokenHash))?.userId, applicant.id);
      assertEquals((await repo.listSessions(applicant.id))[0].id, session.id);
      managedApplicant = await repo.decideUserApproval({
        actorId: admin.id,
        targetUserId: applicant.id,
        expectedVersion: managedApplicant.version,
        status: "rejected",
        startingCreditMicros: 0,
        reason: "Exercise rejected credential invalidation",
      });
      assertEquals(await repo.getSession(session.tokenHash), undefined);
      assertEquals((await repo.getSession(limitedSession.tokenHash))?.limited, true);
      await repo.decideUserApproval({
        actorId: admin.id,
        targetUserId: applicant.id,
        expectedVersion: managedApplicant.version,
        status: "approved",
        startingCreditMicros: 0,
      });

      const identityUser = await repo.createUser({
        email: "identity@database.test",
        name: "Identity",
        passwordHash: "old-hash",
      });
      const identitySql = postgres(databaseUrl!, { max: 1 });
      await identitySql.begin(async (tx) => {
        await tx`INSERT INTO auth_users
          (id,name,email,email_verified,created_at,updated_at)
          VALUES (${identityUser.id},${identityUser.name},${identityUser.email},false,now(),now())`;
        await tx`INSERT INTO auth_accounts
          (id,account_id,provider_id,user_id,password,created_at,updated_at)
          VALUES (${crypto.randomUUID()},${identityUser.id},'credential',${identityUser.id},'old-hash',now(),now())`;
      });
      await identitySql.end();
      await assertRejects(
        () =>
          repo.decideUserApproval({
            actorId: admin.id,
            targetUserId: identityUser.id,
            expectedVersion: identityUser.version,
            status: "approved",
            startingCreditMicros: 10,
            requireEmailVerification: true,
          }),
        DomainError,
        "verified",
      );
      await Promise.all([
        repo.createIdentityToken(
          identityUser.id,
          "email_verification",
          "verify-db-hash",
          new Date(Date.now() + 60_000).toISOString(),
          identityUser.authorityEpoch,
        ),
        repo.createIdentityToken(
          identityUser.id,
          "email_verification",
          "verify-db-hash-concurrent",
          new Date(Date.now() + 60_000).toISOString(),
          identityUser.authorityEpoch,
        ),
      ]);
      await repo.verifyEmail("verify-db-hash");
      await repo.verifyEmail("verify-db-hash-concurrent");
      await assertRejects(
        () => repo.verifyEmail("verify-db-hash"),
        DomainError,
        "invalid or expired",
      );
      await repo.decideUserApproval({
        actorId: admin.id,
        targetUserId: identityUser.id,
        expectedVersion: identityUser.version,
        status: "approved",
        startingCreditMicros: 0,
        requireEmailVerification: true,
      });
      const identitySession = await repo.createSession(
        identityUser.id,
        "identity-session-hash",
        false,
      );
      const identityApiToken = await repo.createApiToken(identityUser.id, {
        name: "identity-token",
        scopes: ["chat:write"],
        tokenHash: "identity-api-hash",
        preview: "identity…hash",
      });
      await Promise.all([
        repo.createIdentityToken(
          identityUser.id,
          "password_reset",
          "reset-db-hash",
          new Date(Date.now() + 60_000).toISOString(),
          identityUser.authorityEpoch,
        ),
        repo.createIdentityToken(
          identityUser.id,
          "password_reset",
          "reset-db-hash-concurrent",
          new Date(Date.now() + 60_000).toISOString(),
          identityUser.authorityEpoch,
        ),
      ]);
      await repo.resetPassword("reset-db-hash", "new-hash");
      const resetSql = postgres(databaseUrl!, { max: 1 });
      const [resetCredential] = await resetSql<
        { password: string; password_hash: string | null }[]
      >`SELECT a.password,u.password_hash FROM auth_accounts a
        JOIN users u ON u.id=a.user_id
        WHERE a.provider_id='credential' AND a.user_id=${identityUser.id}`;
      await resetSql.end();
      assertEquals(resetCredential, { password: "new-hash", password_hash: null });
      assertEquals(await repo.getSession(identitySession.tokenHash), undefined);
      assertEquals((await repo.findApiTokenByHash("identity-api-hash"))?.revokedAt !== null, true);
      assertEquals(identityApiToken.userId, identityUser.id);
      await assertRejects(
        () => repo.resetPassword("reset-db-hash", "again"),
        DomainError,
        "invalid or expired",
      );
      await assertRejects(
        () => repo.resetPassword("reset-db-hash-concurrent", "again"),
        DomainError,
        "invalid or expired",
      );
      await repo.recordAudit({
        actorId: identityUser.id,
        action: "identity.test",
        targetType: "user",
        targetId: identityUser.id,
      });
      await repo.recordAudit({
        actorId: applicant.id,
        action: "identity.other",
        targetType: "session",
        targetId: session.id,
      });
      assertEquals(
        (await repo.listAudit({ action: "identity.test", actorId: identityUser.id })).data.some(
          (event) => event.action === "identity.test" && event.targetId === identityUser.id,
        ),
        true,
      );
      const auditFirstPage = await repo.listAudit({ limit: 1 });
      assertEquals(auditFirstPage.data.length, 1);
      assertEquals(typeof auditFirstPage.nextCursor, "string");
      const auditSecondPage = await repo.listAudit({
        limit: 1,
        cursor: auditFirstPage.nextCursor!,
      });
      assertEquals(
        auditSecondPage.data.some((event) => event.id === auditFirstPage.data[0].id),
        false,
      );
      const precisionEvents = await Promise.all([
        repo.recordAudit({ action: "precision.audit", targetType: "test" }),
        repo.recordAudit({ action: "precision.audit", targetType: "test" }),
        repo.recordAudit({ action: "precision.audit", targetType: "test" }),
      ]);
      const precisionSql = postgres(databaseUrl!, { max: 1 });
      await precisionSql`UPDATE audit_events SET created_at='2026-07-10 00:00:00.000100+00' WHERE id=${
        precisionEvents[0].id
      }`;
      await precisionSql`UPDATE audit_events SET created_at='2026-07-10 00:00:00.000200+00' WHERE id IN (${
        precisionEvents[1].id
      },${precisionEvents[2].id})`;
      await precisionSql.end();
      const sameTimestamp = [precisionEvents[1].id, precisionEvents[2].id].sort().reverse();
      const expectedPrecisionOrder = [...sameTimestamp, precisionEvents[0].id];
      const seenPrecision: string[] = [];
      let precisionCursor: string | undefined;
      do {
        const page = await repo.listAudit({
          action: "precision.audit",
          limit: 1,
          cursor: precisionCursor,
        });
        seenPrecision.push(...page.data.map((event) => event.id));
        precisionCursor = page.nextCursor ?? undefined;
      } while (precisionCursor);
      assertEquals(seenPrecision, expectedPrecisionOrder);

      const quotaUser = await repo.createUser({
        email: "quota-requests@database.test",
        name: "Request Quota",
        passwordHash: "hash",
        emailVerified: true,
      });
      await repo.decideUserApproval({
        actorId: admin.id,
        targetUserId: quotaUser.id,
        expectedVersion: quotaUser.version,
        status: "approved",
        startingCreditMicros: 1_000_000,
      });
      const requestQuota = { maxRequests: 1, maxEvents: 10, maxBytes: 10_000 };
      const quotaStarts = await Promise.allSettled(["a", "b"].map((suffix) =>
        repo.beginApiRequest({
          userId: quotaUser.id,
          endpoint: "responses",
          idempotencyKey: `postgres-quota-${suffix}`,
          requestHash: suffix.repeat(64),
          stream: true,
          model: "test/model",
          runId: `postgres-quota-run-${suffix}`,
          reserveMicros: 1,
          provider: "test",
          quota: requestQuota,
        })
      ));
      assertEquals(quotaStarts.map((result) => result.status).sort(), ["fulfilled", "rejected"]);

      const eventQuotaUser = await repo.createUser({
        email: "quota-events@database.test",
        name: "Event Quota",
        passwordHash: "hash",
        emailVerified: true,
      });
      await repo.decideUserApproval({
        actorId: admin.id,
        targetUserId: eventQuotaUser.id,
        expectedVersion: eventQuotaUser.version,
        status: "approved",
        startingCreditMicros: 1_000_000,
      });
      const eventQuota = { maxRequests: 2, maxEvents: 1, maxBytes: 10_000 };
      const eventStarts = [];
      for (const suffix of ["d", "e"]) {
        const begun = await repo.beginApiRequest({
          userId: eventQuotaUser.id,
          endpoint: "responses",
          idempotencyKey: `postgres-event-${suffix}`,
          requestHash: suffix.repeat(64),
          stream: true,
          model: "test/model",
          runId: `postgres-event-run-${suffix}`,
          reserveMicros: 1,
          provider: "test",
          quota: eventQuota,
        });
        if (begun.kind !== "started") throw new Error("missing event quota start");
        eventStarts.push(begun);
      }
      const eventWrites = await Promise.allSettled(
        eventStarts.map((begun) =>
          repo.appendApiSseFrame(
            begun.request.id,
            begun.leaseToken,
            0,
            "data: quota\n\n",
            undefined,
            undefined,
            eventQuota,
          )
        ),
      );
      assertEquals(eventWrites.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
      const quotaSql = postgres(databaseUrl!, { max: 1 });
      const quotaEvents = await quotaSql<
        { count: number }[]
      >`SELECT count(*)::int count FROM api_idempotency_events e JOIN api_idempotency_requests r ON r.id=e.request_id WHERE r.user_id=${eventQuotaUser.id}`;
      assertEquals(quotaEvents[0].count, 1);
      await quotaSql.end();

      const chat = await repo.createConversation(applicant.id, "Branches");
      const original = await repo.appendMessage({
        conversationId: chat.id,
        ownerId: applicant.id,
        parentId: null,
        role: "user",
        content: "original",
        expectedVersion: 0,
        idempotencyKey: "message-original",
      });
      const edited = await repo.appendMessage({
        conversationId: chat.id,
        ownerId: applicant.id,
        parentId: null,
        supersedesId: original.id,
        role: "user",
        content: "edited",
        expectedVersion: 1,
        idempotencyKey: "message-edited",
      });
      assertEquals(edited.siblingIndex, 1);
      assertEquals((await repo.detail(chat.id, applicant.id)).messages.length, 2);
      const assistant = await repo.appendMessage({
        conversationId: chat.id,
        ownerId: applicant.id,
        parentId: edited.id,
        role: "assistant",
        content: "ready for the next turn",
        expectedVersion: 2,
        idempotencyKey: "message-assistant",
      });

      await repo.reserve(applicant.id, "run-1", "test/model", 100_000, "test");
      await repo.settle("run-1", 25_000, 10, 20, 5);
      assertEquals((await repo.usage(applicant.id)).balanceMicros, 975_000);
      assertEquals((await repo.listLedger(applicant.id)).map((entry) => entry.kind), [
        "grant",
        "reserve",
        "refund",
      ]);
      const current = await repo.detail(chat.id, applicant.id);
      const started = await repo.beginGeneration({
        message: {
          conversationId: chat.id,
          ownerId: applicant.id,
          parentId: assistant.id,
          role: "user",
          content: "atomic",
          model: "test/model",
          expectedVersion: current.version,
          idempotencyKey: "atomic-user",
        },
        runId: "atomic-run",
        provider: "test",
        reserveMicros: 50_000,
      });
      if (started.kind !== "started") throw new Error("generation did not start");
      const completed = await repo.completeGeneration({
        conversationId: chat.id,
        ownerId: applicant.id,
        userMessageId: started.message.id,
        runId: "atomic-run",
        leaseToken: started.leaseToken,
        idempotencyKey: "atomic-assistant",
        content: "answer",
        model: "test/model",
        costMicros: 10_000,
        inputTokens: 1,
        outputTokens: 2,
        latencyMs: 3,
      });
      assertEquals(completed.message.content, "answer");
      assertEquals((await repo.usage(applicant.id)).balanceMicros, 965_000);

      const replayInput = {
        userId: applicant.id,
        endpoint: "chat.completions" as const,
        idempotencyKey: "postgres-replay-0001",
        requestHash: "c".repeat(64),
        stream: true,
        model: "test/model",
        runId: "postgres-replay-run-1",
        reserveMicros: 100_000,
        provider: "test",
      };
      const concurrent = await Promise.all([
        repo.beginApiRequest(replayInput),
        repo.beginApiRequest(replayInput),
      ]);
      assertEquals(concurrent.map((result) => result.kind).sort(), ["in_progress", "started"]);
      const replayStarted = concurrent.find((result) => result.kind === "started");
      if (!replayStarted || replayStarted.kind !== "started") throw new Error("missing winner");
      const terminal = await repo.completeApiStream({
        id: replayStarted.request.id,
        leaseToken: replayStarted.leaseToken,
        responseStatus: 200,
        frames: [
          { sequence: 0, frame: 'data: {"delta":"hello"}\n\n' },
          { sequence: 1, frame: 'data: {"delta":" world"}\n\n' },
        ],
        terminalFrame: "data: [DONE]\n\n",
        costMicros: 20_000,
        inputTokens: 4,
        outputTokens: 2,
        latencyMs: 8,
      });
      assertEquals(terminal.frames.length, 3);
      const largeTerminal = `event: response.completed\ndata: ${
        JSON.stringify({ text: `${"\u0000".repeat(200_000)}${"🦖".repeat(80_000)}` })
      }\n\n`;
      const chunkedReplay = await repo.beginApiRequest({
        ...replayInput,
        idempotencyKey: "postgres-replay-chunked",
        requestHash: "9".repeat(64),
        runId: "postgres-replay-chunked-run",
      });
      if (chunkedReplay.kind !== "started") throw new Error("missing chunked replay request");
      const chunkedTerminal = await repo.completeApiStream({
        id: chunkedReplay.request.id,
        leaseToken: chunkedReplay.leaseToken,
        responseStatus: 200,
        terminalFrame: largeTerminal,
        costMicros: 20_000,
        inputTokens: 4,
        outputTokens: 2,
        latencyMs: 8,
      });
      assertEquals(chunkedTerminal.frames.length > 1, true);
      assertEquals(chunkedTerminal.frames.map((frame) => frame.frame).join(""), largeTerminal);
      assertEquals(
        chunkedTerminal.frames.every((frame) =>
          new TextEncoder().encode(frame.frame).length <= 1_048_576
        ),
        true,
      );
      const replayReservationUser = await repo.createUser({
        email: "replay-reservation@database.test",
        name: "Replay reservation",
        passwordHash: "hash",
        emailVerified: true,
      });
      await repo.decideUserApproval({
        actorId: admin.id,
        targetUserId: replayReservationUser.id,
        expectedVersion: replayReservationUser.version,
        status: "approved",
        startingCreditMicros: 1_000_000,
      });
      const reservationQuota = { maxRequests: 10, maxEvents: 20_000, maxBytes: 67_108_864 };
      await assertRejects(
        () =>
          repo.beginApiRequest({
            userId: replayReservationUser.id,
            endpoint: "responses",
            idempotencyKey: "postgres-invalid-replay-reservation",
            requestHash: "e".repeat(64),
            stream: true,
            model: "test/model",
            runId: "postgres-invalid-replay-reservation-run",
            reserveMicros: 1,
            provider: "test",
            quota: reservationQuota,
            replayReservedBytes: 0,
            replayReservedEvents: 1,
          }),
        DomainError,
        "Invalid idempotent request parameters",
      );
      const reservationStarts = await Promise.allSettled(
        ["a", "b"].map((suffix) =>
          repo.beginApiRequest({
            userId: replayReservationUser.id,
            endpoint: "responses",
            idempotencyKey: `postgres-replay-reservation-${suffix}`,
            requestHash: suffix.repeat(64),
            stream: true,
            model: "test/model",
            runId: `postgres-replay-reservation-run-${suffix}`,
            reserveMicros: 1,
            provider: "test",
            quota: reservationQuota,
            replayReservedBytes: 40_000_000,
            replayReservedEvents: 9_000,
          })
        ),
      );
      assertEquals(
        reservationStarts.map((result) => result.status).sort(),
        ["fulfilled", "rejected"],
      );
      const failureReservation = await repo.beginApiRequest({
        userId: replayReservationUser.id,
        endpoint: "responses",
        idempotencyKey: "postgres-failure-reservation",
        requestHash: "f".repeat(64),
        stream: true,
        model: "test/model",
        runId: "postgres-failure-reservation-run",
        reserveMicros: 1,
        provider: "test",
        quota: reservationQuota,
        replayReservedBytes: 16,
        replayReservedEvents: 1,
      });
      if (failureReservation.kind !== "started") {
        throw new Error("missing failure reservation request");
      }
      await assertRejects(
        () =>
          repo.failApiRequest({
            id: failureReservation.request.id,
            leaseToken: failureReservation.leaseToken,
            responseStatus: 500,
            responseBody: '{"error":"provider failed"}',
            terminalFrame: "event: response.failed\ndata: {}\n\n",
            billing: { mode: "refund" },
          }),
        DomainError,
        "Reserved replay capacity",
      );
      const failureReservationState = await repo.getApiRequest(
        replayReservationUser.id,
        "responses",
        "postgres-failure-reservation",
      );
      assertEquals(failureReservationState?.state, "in_progress");
      assertEquals(failureReservationState?.frames, []);
      const failureQuotaUser = await repo.createUser({
        email: "failure-quota@database.test",
        name: "Failure quota",
        passwordHash: "hash",
        emailVerified: true,
      });
      await repo.decideUserApproval({
        actorId: admin.id,
        targetUserId: failureQuotaUser.id,
        expectedVersion: failureQuotaUser.version,
        status: "approved",
        startingCreditMicros: 1_000_000,
      });
      const failureQuotaRequest = await repo.beginApiRequest({
        userId: failureQuotaUser.id,
        endpoint: "chat.completions",
        idempotencyKey: "postgres-failure-custom-quota",
        requestHash: "a".repeat(64),
        stream: false,
        model: "test/model",
        runId: "postgres-failure-custom-quota-run",
        reserveMicros: 1,
        provider: "test",
        quota: { maxRequests: 10, maxEvents: 10, maxBytes: 100 },
      });
      if (failureQuotaRequest.kind !== "started") {
        throw new Error("missing custom failure quota request");
      }
      await assertRejects(
        () =>
          repo.failApiRequest({
            id: failureQuotaRequest.request.id,
            leaseToken: failureQuotaRequest.leaseToken,
            responseStatus: 500,
            responseBody: "x".repeat(101),
            quota: { maxRequests: 10, maxEvents: 10, maxBytes: 100 },
            billing: { mode: "refund" },
          }),
        DomainError,
        "User replay storage quota exceeded",
      );
      const mutate = postgres(databaseUrl!, { max: 1 });

      const atomicRejected = await repo.beginApiRequest({
        ...replayInput,
        idempotencyKey: "postgres-atomic-rejected",
        requestHash: "2".repeat(64),
        runId: "postgres-atomic-rejected-run",
      });
      if (atomicRejected.kind !== "started") throw new Error("missing atomic rejected request");
      await assertRejects(
        () =>
          repo.completeApiStream({
            id: atomicRejected.request.id,
            leaseToken: atomicRejected.leaseToken,
            responseStatus: 200,
            frames: [{ sequence: 0, frame: "event: response.created\ndata: {}\n\n" }],
            terminalFrame: "event: response.completed\ndata: {}\n\n",
            costMicros: 10_000,
            inputTokens: 2,
            outputTokens: 3,
            latencyMs: 5,
            quota: { maxRequests: 10, maxEvents: 1, maxBytes: 10_000 },
          }),
        DomainError,
        "quota",
      );
      const atomicState = await mutate<
        { state: string; events: number; status: string }[]
      >`SELECT r.state,(SELECT count(*)::int FROM api_idempotency_events e WHERE e.request_id=r.id) events,u.status FROM api_idempotency_requests r JOIN usage_runs u ON u.id=r.usage_run_id WHERE r.id=${atomicRejected.request.id}`;
      assertEquals(atomicState[0], { state: "in_progress", events: 0, status: "reserved" });
      for (let sequence = 0; sequence < 3; sequence++) {
        const [beginAgain] = await Promise.all([
          repo.beginApiRequest({
            ...replayInput,
            idempotencyKey: "postgres-atomic-rejected",
            requestHash: "2".repeat(64),
            runId: `ignored-replay-run-${sequence}`,
          }),
          repo.appendApiSseFrame(
            atomicRejected.request.id,
            atomicRejected.leaseToken,
            sequence,
            `data: lock-order-${sequence}\n\n`,
          ),
        ]);
        assertEquals(beginAgain.kind, "in_progress");
      }
      await repo.failApiRequest({
        id: atomicRejected.request.id,
        leaseToken: atomicRejected.leaseToken,
        responseStatus: 500,
        responseBody: '{"error":"lock-order-test-complete"}',
        billing: { mode: "refund" },
      });
      const replayed = await repo.beginApiRequest(replayInput);
      assertEquals(replayed.kind, "completed");
      assertEquals((await repo.usage(applicant.id)).balanceMicros, 925_000);
      await assertRejects(
        () => repo.beginApiRequest({ ...replayInput, requestHash: "d".repeat(64) }),
        DomainError,
        "payload differs",
      );
      await mutate`UPDATE api_idempotency_requests SET expires_at=now()-interval '1 second' WHERE id=${terminal.id}`;
      assertEquals(await repo.pruneExpiredApiRequests(), 1);
      const reused = await repo.beginApiRequest({
        ...replayInput,
        runId: "postgres-replay-run-1-reused",
      });
      assertEquals(reused.kind, "started");
      if (reused.kind !== "started") throw new Error("missing reused request");
      await repo.failApiRequest({
        id: reused.request.id,
        leaseToken: reused.leaseToken,
        responseStatus: 500,
        responseBody: '{"error":"cancelled"}',
        billing: { mode: "refund" },
      });
      const retainedRuns = await mutate<
        { id: string }[]
      >`SELECT id FROM usage_runs WHERE id IN ('postgres-replay-run-1','postgres-replay-run-1-reused') ORDER BY id`;
      assertEquals(retainedRuns.length, 2);

      const stale = await repo.beginApiRequest({
        ...replayInput,
        idempotencyKey: "postgres-replay-0002",
        runId: "postgres-replay-run-2",
        reserveMicros: 50_000,
        retentionSeconds: 60,
      });
      if (stale.kind !== "started") throw new Error("missing stale request");
      await mutate`UPDATE api_idempotency_requests SET lease_expires_at=now()-interval '1 second' WHERE id=${stale.request.id}`;
      await assertRejects(
        () =>
          repo.appendApiSseFrame(
            stale.request.id,
            stale.leaseToken,
            0,
            "data: stale\n\n",
          ),
        DomainError,
        "lease",
      );
      await assertRejects(
        () => repo.heartbeatApiRequest(stale.request.id, stale.leaseToken),
        DomainError,
        "lease",
      );
      await assertRejects(
        () =>
          repo.completeApiJson({
            id: stale.request.id,
            leaseToken: stale.leaseToken,
            responseStatus: 200,
            responseBody: "{}",
            costMicros: 0,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
          }),
        DomainError,
        "lease",
      );
      await assertRejects(
        () =>
          repo.failApiRequest({
            id: stale.request.id,
            leaseToken: stale.leaseToken,
            responseStatus: 500,
            responseBody: "{}",
            billing: { mode: "refund" },
          }),
        DomainError,
        "lease",
      );
      assertEquals(await repo.reapStaleApiRequests(), 1);
      await mutate`UPDATE api_idempotency_requests SET expires_at=now()-interval '1 second' WHERE id=${stale.request.id}`;
      assertEquals(await repo.pruneExpiredApiRequests(), 1);
      await mutate.end();

      const secondAdmin = await repo.createUser({
        email: "admin2@database.test",
        name: "Admin 2",
        passwordHash: "hash",
        role: "admin",
        approvalStatus: "approved",
        emailVerified: true,
      });
      const removals = await Promise.allSettled([
        repo.setAdminUserState({
          actorId: admin.id,
          targetUserId: secondAdmin.id,
          expectedVersion: secondAdmin.version,
          state: "suspended",
          reason: "Concurrent final-admin coverage",
        }),
        repo.setAdminUserState({
          actorId: secondAdmin.id,
          targetUserId: admin.id,
          expectedVersion: admin.version,
          state: "suspended",
          reason: "Concurrent final-admin coverage",
        }),
      ]);
      assertEquals(removals.filter((result) => result.status === "fulfilled").length, 1);
      assertEquals(removals.filter((result) => result.status === "rejected").length, 1);
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "Postgres provider resilience serializes acyclic routes and immutable attempts",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE provider_attempts,provider_model_route_targets,provider_model_routes,
      provider_retry_policies,model_price_versions,provider_models,providers,audit_events,
      ledger_entries,usage_runs,api_tokens,sessions,messages,conversations,users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const actor = await repo.bootstrapAdmin({
        email: "resilience@database.test",
        name: "Resilience",
        passwordHash: "x",
      }, 1_000);
      const policy = await repo.createProviderRetryPolicy({
        name: "transient",
        maxAttempts: 3,
        maxRetries: 1,
        baseDelayMs: 100,
        maxDelayMs: 2_000,
        backoffMultiplierBps: 20_000,
        jitterBps: 1_000,
        firstTokenTimeoutMs: 10_000,
        idleTimeoutMs: 20_000,
        totalTimeoutMs: 60_000,
        retryableStatuses: [429, 503],
      }, { actorId: actor.id, action: "retry.create" });
      const provider = await repo.createProvider({
        slug: "resilience",
        displayName: "Resilience",
        baseUrl: "https://resilience.database.test/v1",
        protocol: "chat_completions",
      }, { actorId: actor.id, action: "provider.create" });
      const credentialed = await repo.setProviderCredential(provider.id, provider.version, {
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyId: "test",
          credentialVersion: 1,
          wrappedKeyNonce: "bm9uY2U=",
          wrappedKey: "d3JhcA==",
          contentNonce: "bm9uY2U=",
          ciphertext: "Y2lwaGVy",
        },
      }, { actorId: actor.id, action: "provider.credential" });
      const responsesProvider = await repo.createProvider({
        slug: "resilience-responses",
        displayName: "Resilience Responses",
        baseUrl: "https://responses-resilience.database.test/v1",
        protocol: "responses",
      }, { actorId: actor.id, action: "provider.create" });
      const credentialedResponses = await repo.setProviderCredential(
        responsesProvider.id,
        responsesProvider.version,
        {
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyId: "test",
            credentialVersion: 1,
            wrappedKeyNonce: "bm9uY2U=",
            wrappedKey: "d3JhcA==",
            contentNonce: "bm9uY2U=",
            ciphertext: "Y2lwaGVy",
          },
        },
        { actorId: actor.id, action: "provider.credential" },
      );
      const makeModel = async (name: string, targetProvider = credentialed) => {
        const model = await repo.createProviderModel({
          providerId: targetProvider.id,
          publicModelId: `resilience/${name}`,
          upstreamModelId: name,
          displayName: name,
          capabilities: ["chat"],
          contextWindow: 1_000,
        }, { actorId: actor.id, action: "model.create" });
        const price = await repo.createModelPriceVersion({
          providerModelId: model.id,
          expectedModelVersion: model.version,
          effectiveAt: "2026-01-01T00:00:00Z",
          inputMicrosPerMillion: 10,
          cachedInputMicrosPerMillion: 5,
          reasoningMicrosPerMillion: 30,
          outputMicrosPerMillion: 20,
          fixedCallMicros: 1,
          source: "test",
        }, { actorId: actor.id, action: "price.create" });
        return { model: (await repo.findProviderModel(model.id))!, price };
      };
      const a = await makeModel("a"),
        b = await makeModel("b"),
        c = await makeModel("c", credentialedResponses);
      const routeA = await repo.setProviderModelRoute({
        sourceModelId: a.model.id,
        expectedVersion: 0,
        retryPolicyId: policy.id,
        fallbackModelIds: [b.model.id],
      }, { actorId: actor.id, action: "route.set" });
      await repo.setProviderModelRoute({
        sourceModelId: b.model.id,
        expectedVersion: 0,
        fallbackModelIds: [c.model.id],
      }, { actorId: actor.id, action: "route.set" });
      await assertRejects(
        () =>
          repo.setProviderModelRoute({
            sourceModelId: c.model.id,
            expectedVersion: 0,
            fallbackModelIds: [a.model.id],
          }, { actorId: actor.id, action: "route.set" }),
        DomainError,
        "acyclic",
      );
      const plan = await repo.resolveProviderExecutionPlan(a.model.id, "2026-06-01T00:00:00Z");
      assertEquals(plan.targets.map((target) => target.providerModelId), [
        a.model.id,
        b.model.id,
        c.model.id,
      ]);
      await repo.updateProviderModel(c.model.id, c.model.version, { enabled: false }, {
        actorId: actor.id,
        action: "model.disable",
      });
      await assertRejects(
        () =>
          repo.setProviderModelRoute({
            sourceModelId: a.model.id,
            expectedVersion: routeA.version,
            fallbackModelIds: [c.model.id],
          }, { actorId: actor.id, action: "route.set" }),
        DomainError,
        "compatible",
      );
      assertEquals(
        (await repo.resolveProviderExecutionPlan(a.model.id, "2026-06-01T00:00:00Z")).targets.map((
          target,
        ) => target.providerModelId),
        [a.model.id, b.model.id],
      );
      const run = await repo.reserve(
        actor.id,
        "postgres-resilience-run",
        a.model.publicModelId,
        100,
        credentialed.slug,
        undefined,
        plan.targets[0].pricing,
      );
      const ownerLeaseToken = run.runLeaseToken!;
      const claim = await repo.claimProviderExecution(run.id, ownerLeaseToken);
      const ownership = { ownerLeaseToken, executionEpoch: claim.executionEpoch };
      const attempt = await repo.startProviderAttempt({
        ...ownership,
        usageRunId: run.id,
        attemptNumber: 1,
        targetOrdinal: 1,
        retryNumber: 0,
        reason: "fallback",
        breakerBefore: "closed",
        ...plan.targets[1],
      });
      assertEquals(
        (await repo.startProviderAttempt({
          ...ownership,
          usageRunId: run.id,
          attemptNumber: 1,
          targetOrdinal: 1,
          retryNumber: 0,
          reason: "fallback",
          breakerBefore: "closed",
          ...plan.targets[1],
        })).id,
        attempt.id,
      );
      const finish = {
        ...ownership,
        id: attempt.id,
        status: "failed" as const,
        phase: "headers" as const,
        errorCode: "http_503",
        httpStatus: 503,
        visibleOutput: false,
        inputTokens: 10,
        cachedInputTokens: 2,
        reasoningTokens: 0,
        outputTokens: 0,
        costMicros: 2,
        tokenSource: "provider" as const,
        costSource: "calculated" as const,
        latencyMs: 25,
        ttftMs: null,
        breakerAfter: "open" as const,
        retryable: true,
        upstreamRequestId: "req_provider_1",
        tokensPerSecond: 400,
      };
      const terminal = await repo.finishProviderAttempt(finish);
      assertEquals((await repo.finishProviderAttempt(finish)).completedAt, terminal.completedAt);
      const skipped = await repo.startProviderAttempt({
        ...ownership,
        usageRunId: run.id,
        attemptNumber: 8,
        targetOrdinal: 2,
        retryNumber: 0,
        reason: "circuit_skip",
        breakerBefore: "open",
        ...plan.targets[2],
      });
      await repo.finishProviderAttempt({
        ...ownership,
        id: skipped.id,
        status: "skipped",
        phase: "planning",
        errorCode: "circuit_open",
        visibleOutput: false,
        inputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        tokenSource: "none",
        costSource: "none",
        latencyMs: 0,
        breakerAfter: "open",
        retryable: true,
      });
      await repo.startProviderAttempt({
        ...ownership,
        usageRunId: run.id,
        attemptNumber: 9,
        targetOrdinal: 1,
        retryNumber: 1,
        reason: "retry",
        breakerBefore: "closed",
        ...plan.targets[1],
      });
      assertEquals(
        (await repo.listProviderAttempts(run.id)).map((item) => item.attemptNumber),
        [1, 8, 9],
      );
      assertEquals(
        (await repo.listProviderAttempts(run.id))[0].pricing.pricingVersionId,
        b.price.id,
      );
      assertEquals(run.pricingSnapshot?.pricingVersionId, a.price.id);
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "Postgres provider registry fences stale writes and atomically audits immutable prices",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE model_price_versions, provider_models, providers, audit_events,
      document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs,
      api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const actor = await repo.bootstrapAdmin({
        email: "registry@database.test",
        name: "Registry",
        passwordHash: "hash",
      }, 1);
      const created = await repo.createProvider({
        slug: "database-provider",
        displayName: "Database Provider",
        baseUrl: "https://provider.database.test/v1/",
        protocol: "chat_completions",
      }, { actorId: actor.id, action: "provider.create" });
      const credentialed = await repo.setProviderCredential(created.id, created.version, {
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyId: "key-1",
          credentialVersion: 1,
          wrappedKeyNonce: "bm9uY2U=",
          wrappedKey: "d3JhcHBlZA==",
          contentNonce: "bm9uY2U=",
          ciphertext: "c2VjcmV0LWNpcGhlcnRleHQ=",
        },
      }, { actorId: actor.id, action: "provider.credential.replace" });
      assertEquals(credentialed.hasCredential, true);
      assertEquals(typeof credentialed.credentialUpdatedAt, "string");
      assertEquals("credentialEnvelope" in credentialed, false);
      assertEquals(
        (await repo.getProviderCredential(created.id))?.envelope.ciphertext,
        "c2VjcmV0LWNpcGhlcnRleHQ=",
      );
      await assertRejects(
        () =>
          repo.updateProvider(created.id, created.version, { displayName: "Stale" }, {
            actorId: actor.id,
            action: "provider.update",
          }),
        DomainError,
        "reload",
      );

      const model = await repo.createProviderModel({
        providerId: created.id,
        publicModelId: "database/reasoner",
        upstreamModelId: "reasoner",
        displayName: "Reasoner",
        capabilities: ["chat", "streaming"],
        contextWindow: 64_000,
      }, { actorId: actor.id, action: "provider_model.create" });
      const first = await repo.createModelPriceVersion({
        providerModelId: model.id,
        expectedModelVersion: model.version,
        effectiveAt: "2026-01-01T00:00:00Z",
        inputMicrosPerMillion: 10,
        cachedInputMicrosPerMillion: 2,
        reasoningMicrosPerMillion: 20,
        outputMicrosPerMillion: 30,
        fixedCallMicros: 1,
        source: "test-contract",
      }, { actorId: actor.id, action: "model_price.create" });
      const snapshotted = await repo.reserve(
        actor.id,
        "postgres-pricing-snapshot",
        model.publicModelId,
        1,
        created.slug,
        undefined,
        {
          pricingVersionId: first.id,
          inputMicrosPerMillion: first.inputMicrosPerMillion,
          cachedInputMicrosPerMillion: first.cachedInputMicrosPerMillion,
          reasoningMicrosPerMillion: first.reasoningMicrosPerMillion,
          outputMicrosPerMillion: first.outputMicrosPerMillion,
          fixedCallMicros: first.fixedCallMicros,
          source: first.source,
        },
      );
      assertEquals(snapshotted.pricingSnapshot?.pricingVersionId, first.id);
      await assertRejects(
        () =>
          repo.createModelPriceVersion({
            providerModelId: model.id,
            expectedModelVersion: model.version,
            effectiveAt: "2026-02-01T00:00:00Z",
            inputMicrosPerMillion: 1,
            cachedInputMicrosPerMillion: 1,
            reasoningMicrosPerMillion: 1,
            outputMicrosPerMillion: 1,
            fixedCallMicros: 1,
            source: "stale",
          }, { actorId: actor.id, action: "model_price.create" }),
        DomainError,
        "reload",
      );
      const repricedModel = (await repo.findProviderModel(model.id))!;
      const second = await repo.createModelPriceVersion({
        providerModelId: model.id,
        expectedModelVersion: repricedModel.version,
        effectiveAt: "2026-07-01T00:00:00Z",
        inputMicrosPerMillion: 11,
        cachedInputMicrosPerMillion: 3,
        reasoningMicrosPerMillion: 21,
        outputMicrosPerMillion: 31,
        fixedCallMicros: 2,
        source: "test-contract-h2",
      }, { actorId: actor.id, action: "model_price.create" });
      assertEquals(
        (await repo.effectiveModelPrice(model.id, "2026-06-30T23:59:59Z"))?.id,
        first.id,
      );
      assertEquals(
        (await repo.effectiveModelPrice(model.id, "2026-07-01T00:00:00Z"))?.id,
        second.id,
      );
      assertEquals((await repo.listModelPriceVersions(model.id)).length, 2);
      const settledSnapshot = await repo.settle("postgres-pricing-snapshot", 1, 1, 1, 1);
      assertEquals(settledSnapshot.pricingSnapshot, {
        pricingVersionId: first.id,
        inputMicrosPerMillion: 10,
        cachedInputMicrosPerMillion: 2,
        reasoningMicrosPerMillion: 20,
        outputMicrosPerMillion: 30,
        fixedCallMicros: 1,
        source: "test-contract",
      });

      const disabled = await repo.updateProvider(
        created.id,
        credentialed.version,
        { enabled: false },
        { actorId: actor.id, action: "provider.disable" },
      );
      assertEquals(disabled.healthStatus, "disabled");
      assertEquals((await repo.listProviders(true)).length, 0);
      const audits = await repo.listAudit({ targetType: "provider" });
      assertEquals(audits.data.map((event) => event.action), [
        "provider.disable",
        "provider.credential.replace",
        "provider.create",
      ]);

      const invalidActor = crypto.randomUUID();
      await assertRejects(
        () =>
          repo.updateProvider(disabled.id, disabled.version, { displayName: "Must Roll Back" }, {
            actorId: invalidActor,
            action: "provider.update",
          }),
      );
      assertEquals((await repo.findProvider(disabled.id))?.displayName, "Database Provider");
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "Postgres provider registry honors the exact test-only HTTP host exception",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const previousEnvironment = Deno.env.get("DENO_ENV");
    const previousHost = Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST");
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE providers, audit_events, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      Deno.env.set("DENO_ENV", "test");
      Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", "mock-provider");
      const actor = await repo.bootstrapAdmin({
        email: "provider-http@database.test",
        name: "Provider HTTP",
        passwordHash: "hash",
      }, 1);
      const provider = await repo.createProvider({
        slug: "contract-http",
        displayName: "Contract HTTP",
        baseUrl: "http://mock-provider:4010/v1/",
        protocol: "responses",
      }, { actorId: actor.id, action: "provider.create" });
      assertEquals(provider.baseUrl, "http://mock-provider:4010/v1");
      await assertRejects(
        () =>
          repo.createProvider({
            slug: "wrong-http-host",
            displayName: "Wrong HTTP host",
            baseUrl: "http://different-provider:4010/v1",
            protocol: "responses",
          }, { actorId: actor.id, action: "provider.create" }),
        DomainError,
        "Provider base URL is invalid",
      );
      Deno.env.set("DENO_ENV", "production");
      await assertRejects(
        () =>
          repo.createProvider({
            slug: "production-http-host",
            displayName: "Production HTTP host",
            baseUrl: "http://mock-provider:4010/v1",
            protocol: "responses",
          }, { actorId: actor.id, action: "provider.create" }),
        DomainError,
        "Provider base URL is invalid",
      );
    } finally {
      await repo.close();
      if (previousEnvironment === undefined) Deno.env.delete("DENO_ENV");
      else Deno.env.set("DENO_ENV", previousEnvironment);
      if (previousHost === undefined) Deno.env.delete("OPENAI_TEST_ALLOW_HTTP_HOST");
      else Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", previousHost);
    }
  },
});

Deno.test({
  name: "Postgres stale API reaping never exceeds an exact replay reservation",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE api_idempotency_requests, usage_runs, ledger_entries, users
      RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    const mutate = postgres(databaseUrl!, { max: 1 });
    try {
      const user = await repo.bootstrapAdmin({
        email: "api-reaper-bound@database.test",
        name: "API reaper bound",
        passwordHash: "hash",
      }, 1_000_000);
      const prefix = 'data: {"delta":"bounded"}\n\n';
      const prefixBytes = new TextEncoder().encode(prefix).length;
      const begun = await repo.beginApiRequest({
        userId: user.id,
        endpoint: "chat.completions",
        idempotencyKey: "postgres-reaper-exact-bound",
        requestHash: "f".repeat(64),
        stream: true,
        model: "test/model",
        runId: "postgres-reaper-exact-bound-run",
        reserveMicros: 100,
        provider: "test",
        replayReservedBytes: prefixBytes,
        replayReservedEvents: 1,
      });
      if (begun.kind !== "started") throw new Error("expected started request");
      await repo.appendApiSseFrame(begun.request.id, begun.leaseToken, 0, prefix);
      await mutate`UPDATE api_idempotency_requests
        SET lease_expires_at=now()-interval '1 second' WHERE id=${begun.request.id}`;

      assertEquals(await repo.reapStaleApiRequests(), 1);
      const failed = (await repo.getApiRequest(
        user.id,
        "chat.completions",
        "postgres-reaper-exact-bound",
      ))!;
      assertEquals(failed.state, "failed");
      assertEquals(failed.frames.map(({ frame }) => frame), [prefix]);
      assertEquals(failed.responseBody, null);
      assertEquals(failed.failureStartedStream, true);
      assertEquals(failed.responseStatus, 200);
      assertEquals(failed.responseHeaders["content-type"], "text/event-stream");
      assertEquals(failed.responseHeaders["cache-control"], "no-cache");
      const usage = await repo.usage(user.id);
      assertEquals(usage.balanceMicros, 1_000_000);

      await mutate`UPDATE api_idempotency_requests SET expires_at=now()-interval '1 second'
        WHERE id=${begun.request.id}`;
      assertEquals(await repo.pruneExpiredApiRequests(), 1);
      const quota = { maxRequests: 1, maxBytes: prefixBytes, maxEvents: 1 };
      const legacy = await repo.beginApiRequest({
        userId: user.id,
        endpoint: "responses",
        idempotencyKey: "postgres-reaper-custom-quota",
        requestHash: "e".repeat(64),
        stream: true,
        model: "test/model",
        runId: "postgres-reaper-custom-quota-run",
        reserveMicros: 100,
        provider: "test",
        quota,
      });
      if (legacy.kind !== "started") throw new Error("expected legacy request to start");
      await repo.appendApiSseFrame(
        legacy.request.id,
        legacy.leaseToken,
        0,
        prefix,
        120,
        undefined,
        quota,
      );
      await mutate`UPDATE api_idempotency_requests
        SET lease_expires_at=now()-interval '1 second' WHERE id=${legacy.request.id}`;
      assertEquals(await repo.reapStaleApiRequests(100, quota), 1);
      const legacyFailed = (await repo.getApiRequest(
        user.id,
        "responses",
        "postgres-reaper-custom-quota",
      ))!;
      assertEquals(legacyFailed.frames.map(({ frame }) => frame), [prefix]);
      assertEquals(legacyFailed.responseBody, null);
      assertEquals(legacyFailed.responseStatus, 200);
    } finally {
      await mutate.end();
      await repo.close();
    }
  },
});

Deno.test({
  name: "Postgres serializes OCR graph edits and protocol default invariants",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE model_price_versions, provider_models, providers, audit_events,
      ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users
      RESTART IDENTITY CASCADE`;
    await sql.end();
    const firstRepo = await PostgresRepository.connect(databaseUrl!);
    const secondRepo = await PostgresRepository.connect(databaseUrl!);
    try {
      const actor = await firstRepo.bootstrapAdmin({
        email: "model-invariants@database.test",
        name: "Model invariants",
        passwordHash: "hash",
      }, 1);
      const mutation = { actorId: actor.id, action: "model.invariant" };
      const provider = await firstRepo.createProvider({
        slug: "model-invariants",
        displayName: "Model invariants",
        baseUrl: "https://invariants.database.test/v1",
        protocol: "chat_completions",
      }, mutation);
      const model = (name: string) =>
        firstRepo.createProviderModel({
          providerId: provider.id,
          publicModelId: `model-invariants/${name}`,
          upstreamModelId: name,
          displayName: name,
          capabilities: ["chat", "vision"],
          contextWindow: 8_192,
        }, mutation);
      const a = await model("a");
      const b = await model("b");
      const ocr = (target: string) => ({
        ocr: { enabled: true, providerId: provider.id, model: target, prompt: "Extract text" },
      });
      const edits = await Promise.allSettled([
        firstRepo.updateProviderModel(a.id, a.version, { customParams: ocr(b.id) }, mutation),
        secondRepo.updateProviderModel(b.id, b.version, { customParams: ocr(a.id) }, mutation),
      ]);
      assertEquals(edits.filter((result) => result.status === "fulfilled").length, 1);
      assertEquals(edits.filter((result) => result.status === "rejected").length, 1);
      const rejected = edits.find((result): result is PromiseRejectedResult =>
        result.status === "rejected"
      );
      assertEquals(rejected?.reason instanceof DomainError, true);
      const persisted = await firstRepo.listProviderModels(provider.id);
      const ocrSource = persisted.find((model) =>
        model.customParams.ocr && typeof model.customParams.ocr === "object"
      )!;
      const targetId = String((ocrSource.customParams.ocr as Record<string, unknown>).model);
      const ocrTarget = (await firstRepo.findProviderModel(targetId))!;
      await assertRejects(
        () =>
          firstRepo.updateProvider(
            provider.id,
            provider.version,
            { enabled: false },
            mutation,
          ),
        DomainError,
        "must remain enabled",
      );
      await assertRejects(
        () =>
          firstRepo.updateProviderModel(ocrTarget.id, ocrTarget.version, {
            capabilities: ["vision"],
          }, mutation),
        DomainError,
        "both chat and vision",
      );

      const stopModel = await model("stop");
      await firstRepo.updateProviderModel(stopModel.id, stopModel.version, {
        customParams: { stop: "END" },
      }, mutation);
      await assertRejects(
        () =>
          firstRepo.updateProvider(
            provider.id,
            provider.version,
            { protocol: "responses" },
            mutation,
          ),
        DomainError,
        "not supported by Responses providers",
      );
      const currentSource = (await firstRepo.findProviderModel(ocrSource.id))!;
      await firstRepo.updateProviderModel(currentSource.id, currentSource.version, {
        enabled: false,
      }, mutation);
      const currentTarget = (await firstRepo.findProviderModel(ocrTarget.id))!;
      await firstRepo.updateProviderModel(currentTarget.id, currentTarget.version, {
        enabled: false,
      }, mutation);
      const currentProvider = (await firstRepo.findProvider(provider.id))!;
      await firstRepo.updateProvider(
        currentProvider.id,
        currentProvider.version,
        { enabled: false },
        mutation,
      );
      const disabledSource = (await firstRepo.findProviderModel(currentSource.id))!;
      await assertRejects(
        () =>
          firstRepo.updateProviderModel(disabledSource.id, disabledSource.version, {
            enabled: true,
          }, mutation),
        DomainError,
        "must remain enabled",
      );
      const responses = await firstRepo.createProvider({
        slug: "responses-invariants",
        displayName: "Responses invariants",
        baseUrl: "https://responses.database.test/v1",
        protocol: "responses",
      }, mutation);
      await assertRejects(
        () =>
          firstRepo.createProviderModel({
            providerId: responses.id,
            publicModelId: "responses-invariants/invalid",
            upstreamModelId: "invalid",
            displayName: "Invalid",
            capabilities: ["chat"],
            contextWindow: 8_192,
            customParams: { seed: 7 },
          }, mutation),
        DomainError,
        "not supported by Responses providers",
      );
    } finally {
      await firstRepo.close();
      await secondRepo.close();
    }
  },
});

Deno.test({
  name: "legacy runtime snapshot backfill preserves all domain collections and is idempotent",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, repository_migrations, operation_idempotency, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users, runtime_snapshots RESTART IDENTITY CASCADE`;
    const userId = crypto.randomUUID(),
      conversationId = crypto.randomUUID(),
      messageId = crypto.randomUUID();
    const tokenId = crypto.randomUUID(),
      ledgerId = crypto.randomUUID(),
      reserveLedgerId = crypto.randomUUID(),
      jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const snapshot = {
      users: [[userId, {
        id: userId,
        email: "legacy@test.invalid",
        name: "Legacy",
        passwordHash: "hash",
        role: "user",
        approvalStatus: "approved",
        state: "active",
        balanceMicros: 80,
        createdAt: now,
      }]],
      sessions: [["session-hash", {
        tokenHash: "session-hash",
        userId,
        limited: false,
        expiresAt: Date.now() + 60_000,
      }]],
      tokens: [[tokenId, {
        id: tokenId,
        userId,
        tokenHash: "token-hash",
        name: "Legacy token",
        preview: "legacy",
        scopes: ["chat:write"],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: now,
      }]],
      conversations: [[conversationId, {
        id: conversationId,
        ownerId: userId,
        title: "Legacy chat",
        activeLeafId: messageId,
        version: 1,
        pinned: false,
        temporary: false,
        archivedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      }]],
      messages: [[messageId, {
        id: messageId,
        conversationId,
        parentId: null,
        supersedesId: null,
        generationId: null,
        siblingIndex: 0,
        role: "user",
        content: "legacy",
        model: null,
        status: "complete",
        metadata: {},
        createdAt: now,
      }]],
      idempotency: [[`${conversationId}:legacy-message`, messageId]],
      ledger: [{
        id: ledgerId,
        userId,
        usageRunId: "legacy-run",
        kind: "grant",
        amountMicros: 100,
        balanceAfterMicros: 100,
        createdAt: now,
      }, {
        id: reserveLedgerId,
        userId,
        usageRunId: "legacy-reserved-run",
        kind: "reserve",
        amountMicros: -20,
        balanceAfterMicros: 80,
        createdAt: now,
      }],
      usageRuns: [["legacy-run", {
        id: "legacy-run",
        userId,
        tokenId,
        model: "legacy/model",
        status: "completed",
        reservedMicros: 100,
        costMicros: 0,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        createdAt: now,
      }], ["legacy-reserved-run", {
        id: "legacy-reserved-run",
        userId,
        tokenId: null,
        model: "legacy/model",
        status: "reserved",
        reservedMicros: 20,
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: null,
        createdAt: now,
      }]],
      jobs: [{
        id: jobId,
        type: "retention.scrub",
        payload: { legacy: true },
        status: "queued",
        attempts: 0,
        createdAt: now,
      }],
    };
    await sql`INSERT INTO runtime_snapshots(id,payload) VALUES('primary',${
      sql.json(JSON.stringify(snapshot))
    })`;
    await sql`INSERT INTO repository_migrations(name,metadata) VALUES('legacy-runtime-snapshot-v1','{}')`;
    await sql.end();
    assertEquals((await backfillLegacyRuntimeSnapshot(databaseUrl!)).status, "imported");
    assertEquals((await backfillLegacyRuntimeSnapshot(databaseUrl!)).status, "already_imported");
    const verify = postgres(databaseUrl!, { max: 1 });
    for (
      const table of [
        "users",
        "sessions",
        "api_tokens",
        "conversations",
        "messages",
        "ledger_entries",
        "usage_runs",
        "jobs",
      ]
    ) {
      const rows = await verify.unsafe<{ count: number }[]>(
        `SELECT count(*)::int count FROM ${table}`,
      );
      assertEquals(
        rows[0].count,
        table === "ledger_entries" ? 3 : table === "usage_runs" ? 2 : 1,
        table,
      );
    }
    const imported = await verify<
      { idempotency_key: string }[]
    >`SELECT idempotency_key FROM messages WHERE id=${messageId}`;
    assertEquals(imported[0].idempotency_key, "legacy-message");
    const importedUsage = await verify<
      { id: string; recovery_owner: string; status: string; token_id: string | null }[]
    >`SELECT id,recovery_owner,status,token_id FROM usage_runs ORDER BY id`;
    assertEquals([...importedUsage], [
      {
        id: "legacy-reserved-run",
        recovery_owner: "provider",
        status: "failed",
        token_id: null,
      },
      {
        id: "legacy-run",
        recovery_owner: "provider",
        status: "completed",
        token_id: tokenId,
      },
    ]);
    assertEquals(
      [
        ...await verify<{ kind: string; sequence: string; balance: string }[]>`
        SELECT kind,sequence::text,balance_after_micros::text balance
        FROM ledger_entries ORDER BY sequence`,
      ],
      [
        { kind: "grant", sequence: "1", balance: "100" },
        { kind: "reserve", sequence: "2", balance: "80" },
        { kind: "refund", sequence: "3", balance: "100" },
      ],
    );
    assertEquals(
      (await verify<{ balance: string }[]>`SELECT balance_micros::text balance FROM users
        WHERE id=${userId}`)[0].balance,
      "100",
    );
    await verify.end();
  },
});

Deno.test({
  name: "normalized repository fences graph writes after archive or deletion",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "readonly@database.test",
        name: "Read-only owner",
        passwordHash: "hash",
      }, 1_000_000);
      const conversation = await repo.createConversation(owner.id, "Read only");
      const root = await repo.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "root",
        expectedVersion: 0,
        idempotencyKey: "readonly-root",
      });
      const assertReadOnly = async () => {
        await assertRejects(
          () =>
            repo.appendMessage({
              conversationId: conversation.id,
              ownerId: owner.id,
              parentId: root.id,
              role: "user",
              content: "blocked",
              expectedVersion: 2,
              idempotencyKey: `readonly-message-${crypto.randomUUID()}`,
            }),
          DomainError,
          "read-only",
        );
        await assertRejects(
          () =>
            repo.beginGeneration({
              message: {
                conversationId: conversation.id,
                ownerId: owner.id,
                parentId: root.id,
                role: "user",
                content: "blocked generation",
                model: "simulated/dg-chat",
                expectedVersion: 2,
                idempotencyKey: `readonly-generation-${crypto.randomUUID()}`,
              },
              runId: `readonly-run-${crypto.randomUUID()}`,
              provider: "simulated",
              reserveMicros: 1,
            }),
          DomainError,
          "read-only",
        );
        await assertRejects(
          () => repo.setActiveLeaf(conversation.id, owner.id, root.id, 2),
          DomainError,
          "read-only",
        );
      };

      await repo.updateConversation(owner.id, conversation.id, {
        archived: true,
        expectedVersion: conversation.version + 1,
      });
      await assertReadOnly();
      await repo.updateConversation(owner.id, conversation.id, {
        archived: false,
        deleted: true,
        expectedVersion: conversation.version + 2,
      });
      await assertReadOnly();
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "Postgres web generation controls stop across owners and preserve regenerate siblings",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE generation_controls, provider_attempts, ledger_entries, usage_runs,
      messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "stream-control@database.test",
        name: "Stream owner",
        passwordHash: "hash",
      }, 1_000_000);
      const other = await repo.createUser({
        email: "stream-other@database.test",
        name: "Other",
        passwordHash: "hash",
        approvalStatus: "approved",
      });
      const conversation = await repo.createConversation(owner.id, "Streaming");
      const generationId = crypto.randomUUID();
      const started = await repo.beginGeneration({
        message: {
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: null,
          role: "user",
          content: "hello",
          model: "simulated/dg-chat",
          expectedVersion: 0,
          idempotencyKey: "pg-stream-user",
        },
        runId: "pg-stream-run",
        generationId,
        provider: "simulated",
        reserveMicros: 100,
      });
      if (started.kind !== "started") throw new Error("generation did not start");
      await assertRejects(
        () => repo.requestGenerationStop(conversation.id, other.id, generationId),
        DomainError,
        "not found",
      );
      assertEquals(
        (await repo.requestGenerationStop(conversation.id, owner.id, generationId)).generationId,
        generationId,
      );
      assertEquals(
        await repo.generationStopRequested("pg-stream-run", owner.id, started.leaseToken),
        true,
      );
      const original = await repo.completeGeneration({
        conversationId: conversation.id,
        ownerId: owner.id,
        userMessageId: started.message.id,
        runId: "pg-stream-run",
        leaseToken: started.leaseToken,
        idempotencyKey: "pg-stream-assistant",
        content: "partial",
        model: "simulated/dg-chat",
        costMicros: 1,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: "stopped",
        metadata: { runId: "pg-stream-run" },
      });
      assertEquals(original.message.status, "stopped");
      const regeneration = await repo.beginAssistantGeneration({
        conversationId: conversation.id,
        ownerId: owner.id,
        sourceAssistantId: original.message.id,
        mode: "regenerate",
        model: "simulated/dg-chat",
        expectedVersion: original.conversation.version,
        idempotencyKey: "pg-stream-regenerate",
        runId: "pg-stream-regenerate-run",
        generationId: crypto.randomUUID(),
        provider: "simulated",
        reserveMicros: 100,
      });
      if (regeneration.kind !== "started") throw new Error("regeneration did not start");
      assertEquals(regeneration.conversation.activeLeafId, original.message.id);
      assertEquals(regeneration.conversation.version, original.conversation.version + 1);
      const replacement = await repo.completeGeneration({
        conversationId: conversation.id,
        ownerId: owner.id,
        userMessageId: regeneration.message.id,
        runId: "pg-stream-regenerate-run",
        leaseToken: regeneration.leaseToken,
        idempotencyKey: "pg-stream-regenerated-assistant",
        content: "replacement",
        model: "simulated/dg-chat",
        costMicros: 1,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        supersedesId: original.message.id,
        metadata: { runId: "pg-stream-regenerate-run" },
      });
      assertEquals(replacement.message.parentId, original.message.parentId);
      assertEquals(replacement.message.supersedesId, original.message.id);
      assertEquals((await repo.detail(conversation.id, owner.id)).messages.length, 3);

      const nextUser = await repo.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: replacement.message.id,
        role: "user",
        content: "next",
        expectedVersion: replacement.conversation.version,
        idempotencyKey: "pg-stream-next-user",
      });
      const laterAssistant = await repo.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: nextUser.id,
        role: "assistant",
        content: "later",
        expectedVersion: replacement.conversation.version + 1,
        idempotencyKey: "pg-stream-later-assistant",
      });
      const earlier = await repo.beginAssistantGeneration({
        conversationId: conversation.id,
        ownerId: owner.id,
        sourceAssistantId: replacement.message.id,
        mode: "continue",
        model: "simulated/dg-chat",
        expectedVersion: replacement.conversation.version + 2,
        idempotencyKey: "pg-stream-earlier-continue",
        runId: "pg-stream-earlier-continue-run",
        generationId: crypto.randomUUID(),
        provider: "simulated",
        reserveMicros: 100,
      });
      if (earlier.kind !== "started") throw new Error("earlier continuation did not start");
      assertEquals(earlier.conversation.activeLeafId, replacement.message.id);
      const selected = await repo.setActiveLeaf(
        conversation.id,
        owner.id,
        laterAssistant.id,
        earlier.conversation.version,
      );
      const earlierTerminal = await repo.completeGeneration({
        conversationId: conversation.id,
        ownerId: owner.id,
        userMessageId: earlier.message.id,
        runId: "pg-stream-earlier-continue-run",
        leaseToken: earlier.leaseToken,
        idempotencyKey: "pg-stream-earlier-continue-assistant",
        content: "continued earlier",
        model: "simulated/dg-chat",
        costMicros: 1,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        supersedesId: replacement.message.id,
      });
      assertEquals(selected.activeLeafId, laterAssistant.id);
      assertEquals(earlierTerminal.conversation.activeLeafId, laterAssistant.id);
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "Postgres earlier failed and reaped generations advance only untouched selections",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE generation_controls, provider_attempts, ledger_entries, usage_runs,
      messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    const expirySql = postgres(databaseUrl!, { max: 1 });
    try {
      const owner = await repo.bootstrapAdmin({
        email: "earlier-terminal@database.test",
        name: "Earlier terminal owner",
        passwordHash: "hash",
      }, 1_000_000);
      for (const terminal of ["failure", "reaper"] as const) {
        for (const preserveLaterSelection of [false, true]) {
          const suffix = `${terminal}-${preserveLaterSelection ? "selected" : "untouched"}`;
          const conversation = await repo.createConversation(owner.id, `Earlier ${suffix}`);
          const userOne = await repo.appendMessage({
            conversationId: conversation.id,
            ownerId: owner.id,
            parentId: null,
            role: "user",
            content: "one",
            expectedVersion: 0,
            idempotencyKey: `pg-${suffix}-user-one`,
          });
          const assistantOne = await repo.appendMessage({
            conversationId: conversation.id,
            ownerId: owner.id,
            parentId: userOne.id,
            role: "assistant",
            content: "one answer",
            expectedVersion: 1,
            idempotencyKey: `pg-${suffix}-assistant-one`,
          });
          const userTwo = await repo.appendMessage({
            conversationId: conversation.id,
            ownerId: owner.id,
            parentId: assistantOne.id,
            role: "user",
            content: "two",
            expectedVersion: 2,
            idempotencyKey: `pg-${suffix}-user-two`,
          });
          const assistantTwo = await repo.appendMessage({
            conversationId: conversation.id,
            ownerId: owner.id,
            parentId: userTwo.id,
            role: "assistant",
            content: "two answer",
            expectedVersion: 3,
            idempotencyKey: `pg-${suffix}-assistant-two`,
          });
          const runId = `pg-${suffix}-run`;
          const begun = await repo.beginAssistantGeneration({
            conversationId: conversation.id,
            ownerId: owner.id,
            sourceAssistantId: assistantOne.id,
            mode: "regenerate",
            model: "simulated/dg-chat",
            expectedVersion: 4,
            idempotencyKey: `pg-${suffix}-regenerate`,
            runId,
            generationId: crypto.randomUUID(),
            provider: "simulated",
            reserveMicros: 10,
          });
          if (begun.kind !== "started") throw new Error("generation did not start");
          if (preserveLaterSelection) {
            await repo.setActiveLeaf(
              conversation.id,
              owner.id,
              assistantTwo.id,
              begun.conversation.version,
            );
          }

          let terminalMessageId: string;
          if (terminal === "failure") {
            terminalMessageId = (await repo.failGeneration({
              conversationId: conversation.id,
              ownerId: owner.id,
              userMessageId: userOne.id,
              runId,
              leaseToken: begun.leaseToken,
              idempotencyKey: `pg-${suffix}-error`,
              model: "simulated/dg-chat",
              error: "provider failed",
              supersedesId: assistantOne.id,
            })).message.id;
          } else {
            await expirySql`UPDATE usage_runs SET generation_lease_expires_at=now()-interval '1 second'
              WHERE id=${runId}`;
            assertEquals(await repo.reapStaleGenerations(), 1);
            const terminalMessage = (await repo.detail(conversation.id, owner.id)).messages.find(
              (message) => message.metadata.runId === runId,
            );
            if (!terminalMessage) throw new Error("reaper terminal was not created");
            terminalMessageId = terminalMessage.id;
          }

          assertEquals(
            (await repo.detail(conversation.id, owner.id)).activeLeafId,
            preserveLaterSelection ? assistantTwo.id : terminalMessageId,
            suffix,
          );
        }
      }
    } finally {
      await repo.close();
      await expirySql.end();
    }
  },
});

Deno.test({
  name: "normalized generation leases claim once and fence stale owners",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    await sql`TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "generation-lease@database.test",
        name: "Lease owner",
        passwordHash: "hash",
      }, 1_000_000);
      const conversation = await repo.createConversation(owner.id, "Lease");
      const input = {
        message: {
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: null,
          role: "user" as const,
          content: "generate once",
          model: "simulated/dg-chat",
          expectedVersion: 0,
          idempotencyKey: "postgres-lease-user",
        },
        runId: "postgres-generation-lease",
        provider: "simulated",
        reserveMicros: 100,
        leaseSeconds: 60,
      };
      await assertRejects(
        () =>
          repo.beginGeneration({
            ...input,
            message: {
              ...input.message,
              role: "assistant",
              idempotencyKey: "postgres-invalid-generation-role",
            },
            runId: "postgres-invalid-generation-role",
          }),
        DomainError,
        "user message",
      );
      const started = await repo.beginGeneration(input);
      if (started.kind !== "started") throw new Error("generation did not start");
      await sql`UPDATE usage_runs SET generation_lease_expires_at=now()-interval '1 second' WHERE id=${input.runId}`;
      const contenders = await Promise.all([
        repo.beginGeneration(input),
        repo.beginGeneration(input),
      ]);
      assertEquals(contenders.map((result) => result.kind).sort(), ["claimed", "in_progress"]);
      const claimed = contenders.find((result) => result.kind === "claimed");
      if (!claimed || claimed.kind !== "claimed") throw new Error("generation was not claimed");
      await assertRejects(
        () =>
          repo.completeGeneration({
            conversationId: conversation.id,
            ownerId: owner.id,
            userMessageId: started.message.id,
            runId: input.runId,
            leaseToken: started.leaseToken,
            idempotencyKey: "postgres-lease-stale-assistant",
            content: "stale",
            model: "simulated/dg-chat",
            costMicros: 10,
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
          }),
        DomainError,
        "lease",
      );
      await repo.heartbeatGeneration(input.runId, owner.id, claimed.leaseToken, 60);
      const completed = await repo.completeGeneration({
        conversationId: conversation.id,
        ownerId: owner.id,
        userMessageId: claimed.message.id,
        runId: input.runId,
        leaseToken: claimed.leaseToken,
        idempotencyKey: "postgres-lease-assistant",
        content: "owned",
        model: "simulated/dg-chat",
        costMicros: 10,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      });
      assertEquals(completed.message.content, "owned");
      assertEquals(completed.usageRun.generationLeaseToken, null);

      const abandonedConversation = await repo.createConversation(owner.id, "Abandoned");
      const abandoned = await repo.beginGeneration({
        ...input,
        message: {
          ...input.message,
          conversationId: abandonedConversation.id,
          expectedVersion: 0,
          idempotencyKey: "postgres-reaper-user",
        },
        runId: "postgres-generation-reaper",
      });
      if (abandoned.kind !== "started") throw new Error("abandoned generation did not start");
      await sql`UPDATE usage_runs SET generation_lease_expires_at=now()-interval '1 second' WHERE id='postgres-generation-reaper'`;
      const abandonedControls = await sql<{ generation_id: string }[]>`
        SELECT generation_id::text FROM generation_controls
        WHERE run_id='postgres-generation-reaper'
      `;
      await assertRejects(
        () =>
          repo.requestGenerationStop(
            abandonedConversation.id,
            owner.id,
            abandonedControls[0].generation_id,
          ),
        DomainError,
        "not found",
      );
      assertEquals(await repo.reapStaleGenerations(), 1);
      assertEquals(await repo.reapStaleGenerations(), 0);
      const reapedDetail = await repo.detail(abandonedConversation.id, owner.id);
      const reapedAssistant = reapedDetail.messages.find((message) => message.role === "assistant");
      assertEquals(reapedAssistant?.status, "error");
      assertEquals(reapedAssistant?.metadata.runId, "postgres-generation-reaper");

      const stoppedConversation = await repo.createConversation(owner.id, "Stopped reaper");
      const stoppedGenerationId = crypto.randomUUID();
      const stopped = await repo.beginGeneration({
        ...input,
        message: {
          ...input.message,
          conversationId: stoppedConversation.id,
          expectedVersion: 0,
          idempotencyKey: "postgres-stopped-reaper-user",
        },
        runId: "postgres-stopped-reaper",
        generationId: stoppedGenerationId,
      });
      if (stopped.kind !== "started") throw new Error("stopped reaper did not start");
      await repo.requestGenerationStop(stoppedConversation.id, owner.id, stoppedGenerationId);
      await sql`UPDATE usage_runs SET generation_lease_expires_at=now()-interval '1 second'
        WHERE id='postgres-stopped-reaper'`;
      assertEquals(await repo.reapStaleGenerations(), 1);
      const stoppedDetail = await repo.detail(stoppedConversation.id, owner.id);
      const stoppedAssistant = stoppedDetail.messages.find((message) =>
        message.role === "assistant"
      );
      assertEquals(stoppedAssistant?.status, "stopped");
      assertEquals(stoppedAssistant?.metadata.stopReason, "user");
      await assertRejects(
        () =>
          repo.failGeneration({
            conversationId: abandonedConversation.id,
            ownerId: owner.id,
            userMessageId: abandoned.message.id,
            runId: "postgres-generation-reaper",
            leaseToken: abandoned.leaseToken,
            idempotencyKey: "postgres-reaper-error",
            model: "simulated/dg-chat",
            error: "stale",
          }),
        DomainError,
      );
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "normalized knowledge collections serialize first bind and hide soft-deleted parents",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE conversation_knowledge_bindings, knowledge_collection_attachments,
      knowledge_collections, audit_events, document_chunks, message_attachments, attachments,
      jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users
      RESTART IDENTITY CASCADE`;
    const first = await PostgresRepository.connect(databaseUrl!);
    const second = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await first.bootstrapAdmin({
        email: "knowledge-pg@database.test",
        name: "Knowledge",
        passwordHash: "hash",
      }, 100);
      const conversation = await first.createConversation(owner.id, "Knowledge");
      const collection = await first.createKnowledgeCollection(owner.id, {
        name: "Docs",
        idempotencyKey: "knowledge-pg-docs",
      });
      const bindings = await Promise.all([
        first.bindKnowledgeCollection(conversation.id, collection.id, owner.id, "retrieval", 0),
        second.bindKnowledgeCollection(conversation.id, collection.id, owner.id, "retrieval", 0),
      ]);
      assertEquals(bindings.map((value) => value.version), [1, 1]);
      assertEquals((await first.listConversationKnowledge(conversation.id, owner.id)).length, 1);
      const secondCollection = await first.createKnowledgeCollection(owner.id, {
        name: "Second",
        idempotencyKey: "knowledge-pg-second",
      });
      const replacements = await Promise.all([
        first.replaceConversationKnowledge(conversation.id, owner.id, {
          collectionIds: [collection.id, secondCollection.id],
          mode: "full_context",
        }),
        second.replaceConversationKnowledge(conversation.id, owner.id, {
          collectionIds: [collection.id, secondCollection.id],
          mode: "full_context",
        }),
      ]);
      assertEquals(replacements.map((value) => value.length), [2, 2]);
      assertEquals(
        (await first.listConversationKnowledge(conversation.id, owner.id)).map((
          value,
        ) => [value.collectionId, value.mode]).sort(),
        [[collection.id, "full_context"], [secondCollection.id, "full_context"]].sort(),
      );
      await first.deleteKnowledgeCollection(collection.id, owner.id, 1);
      assertEquals(
        (await first.listConversationKnowledge(conversation.id, owner.id)).map((value) =>
          value.collectionId
        ),
        [secondCollection.id],
      );
      await assertRejects(
        () => second.bindKnowledgeCollection(conversation.id, collection.id, owner.id, "retrieval"),
        DomainError,
        "not found",
      );
      await assertRejects(
        () => first.unbindKnowledgeCollection(conversation.id, collection.id, owner.id, 1),
        DomainError,
        "not found",
      );
      await assertRejects(
        () =>
          first.createKnowledgeCollection(owner.id, {
            name: "Docs",
            idempotencyKey: "knowledge-pg-docs",
          }),
        DomainError,
        "already used",
      );
    } finally {
      await first.close();
      await second.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "normalized attachments enforce ownership, dedupe, immutable links, and jobs",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "attachments@database.test",
        name: "Attachments",
        passwordHash: "hash",
      }, 1_000_000);
      const stranger = await repo.createUser({
        email: "attachment-stranger@database.test",
        name: "Stranger",
        passwordHash: "hash",
      });
      const conversation = await repo.createConversation(owner.id, "Files");
      const message = await repo.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "file",
        expectedVersion: 0,
        idempotencyKey: "attachment-message",
      });
      const base = {
        ownerId: owner.id,
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        sha256: "b".repeat(64),
      };
      const concurrent = await Promise.all([
        repo.createAttachment({ ...base, objectKey: `users/${owner.id}/objects/one` }),
        repo.createAttachment({ ...base, objectKey: `users/${owner.id}/objects/two` }),
      ]);
      assertEquals(new Set(concurrent.map((result) => result.attachment.id)).size, 1);
      assertEquals(new Set(concurrent.map((result) => result.inspectionJobId)).size, 1);
      assertEquals(concurrent.map((result) => result.deduplicated).sort(), [false, true]);
      assertEquals(
        (await repo.listJobs()).items.filter((job) => job.type === "attachment.inspect").length,
        1,
      );
      const attachment = concurrent[0].attachment;
      await assertRejects(
        () => repo.getAttachment(attachment.id, stranger.id),
        DomainError,
        "not found",
      );
      await repo.transitionAttachment(attachment.id, owner.id, "pending", "inspecting");
      await repo.transitionAttachment(attachment.id, owner.id, "inspecting", "ready");
      await repo.linkAttachmentToMessage(message.id, attachment.id, owner.id);
      await repo.linkAttachmentToMessage(message.id, attachment.id, owner.id);
      assertEquals((await repo.listMessageAttachments(message.id, owner.id)).length, 1);
      await assertRejects(
        () => repo.linkAttachmentToMessage(message.id, attachment.id, stranger.id),
        DomainError,
      );
      await repo.deleteAttachment(attachment.id, owner.id);
      assertEquals((await repo.listAttachments(owner.id)).length, 0);
      assertEquals((await repo.listMessageAttachments(message.id, owner.id))[0].state, "deleted");
      const replacement = await repo.createAttachment({
        ...base,
        objectKey: `users/${owner.id}/objects/replacement`,
      });
      assertEquals(replacement.deduplicated, false);
      assertEquals(replacement.attachment.id === attachment.id, false);
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "generated assets finalize concurrently with immutable owner-scoped lineage",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE generated_asset_inputs,generated_assets,audit_events,document_chunks,
      message_attachments,attachments,jobs,ledger_entries,usage_runs,model_price_versions,
      provider_models,providers,api_tokens,sessions,messages,conversations,users
      RESTART IDENTITY CASCADE`;
    const first = await PostgresRepository.connect(databaseUrl!);
    const second = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await first.bootstrapAdmin({
        email: "generated-assets@database.test",
        name: "Generated assets",
        passwordHash: "hash",
      }, 1_000_000);
      const stranger = await first.createUser({
        email: "generated-assets-stranger@database.test",
        name: "Stranger",
        passwordHash: "hash",
      });
      const provider = await first.createProvider({
        slug: "generated-images",
        displayName: "Generated images",
        baseUrl: "https://images.example/v1",
        protocol: "responses",
      }, { actorId: owner.id, action: "provider.create" });
      const model = await first.createProviderModel({
        providerId: provider.id,
        publicModelId: "generated-images/artist",
        upstreamModelId: "artist-v1",
        displayName: "Artist",
        capabilities: ["image_generation"],
        contextWindow: 1,
      }, { actorId: owner.id, action: "provider_model.create" });
      const price = await first.createModelPriceVersion({
        providerModelId: model.id,
        expectedModelVersion: model.version,
        effectiveAt: "2020-01-01T00:00:00.000Z",
        inputMicrosPerMillion: 1,
        cachedInputMicrosPerMillion: 2,
        reasoningMicrosPerMillion: 3,
        outputMicrosPerMillion: 4,
        fixedCallMicros: 5,
        source: "asset-postgres-test",
      }, { actorId: owner.id, action: "model_price.create" });
      const pricingSnapshot = {
        pricingVersionId: price.id,
        inputMicrosPerMillion: price.inputMicrosPerMillion,
        cachedInputMicrosPerMillion: price.cachedInputMicrosPerMillion,
        reasoningMicrosPerMillion: price.reasoningMicrosPerMillion,
        outputMicrosPerMillion: price.outputMicrosPerMillion,
        fixedCallMicros: price.fixedCallMicros,
        source: price.source,
      };
      await first.reserve(
        owner.id,
        "generated-asset-run",
        model.publicModelId,
        100,
        provider.slug,
        undefined,
        pricingSnapshot,
      );
      const createAttachment = async (name: string, digest: string) =>
        (await first.createAttachment({
          ownerId: owner.id,
          objectKey: `generated/${owner.id}/${name}.png`,
          filename: `${name}.png`,
          mimeType: "image/png",
          sizeBytes: 100,
          sha256: digest.repeat(64).slice(0, 64),
          state: "ready",
        })).attachment;
      const source = await createAttachment("source", "a");
      const mask = await createAttachment("mask", "c");
      const output = await createAttachment("output", "b");
      const input = {
        ownerId: owner.id,
        usageRunId: "generated-asset-run",
        providerModelId: model.id,
        publicModelId: model.publicModelId,
        upstreamModelId: model.upstreamModelId,
        providerSlug: provider.slug,
        pricingSnapshot,
        idempotencyKey: "generated-assets-postgres",
        requestHash: "c".repeat(64),
        operation: "edit" as const,
        prompt: "Revise the generated image",
        providerCreatedAt: 1_700_000_000,
        assets: [{
          attachmentId: output.id,
          ordinal: 0,
          width: 1024,
          height: 1024,
          inputs: [
            {
              attachmentId: source.id,
              role: "source" as const,
              ordinal: 0,
              width: 1024,
              height: 1024,
            },
            {
              attachmentId: mask.id,
              role: "mask" as const,
              ordinal: 0,
              width: 1024,
              height: 1024,
              hasAlpha: true,
            },
          ],
        }],
      };
      const stage = await first.stageGeneratedObject({
        ownerId: owner.id,
        usageRunId: input.usageRunId,
        ordinal: 0,
        objectKey: output.objectKey,
        mimeType: output.mimeType,
        sizeBytes: output.sizeBytes,
        sha256: output.sha256,
      });
      await first.markGeneratedObjectStored(stage.id, owner.id);
      await first.attachGeneratedObject(stage.id, owner.id, output.id);
      for (const [ordinal, attachment] of [source, mask].entries()) {
        const inputStage = await first.stageGeneratedObject({
          ownerId: owner.id,
          usageRunId: input.usageRunId,
          purpose: "edit_input",
          ordinal,
          objectKey: attachment.objectKey,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256,
        });
        await first.markGeneratedObjectStored(inputStage.id, owner.id);
        await first.attachGeneratedObject(inputStage.id, owner.id, attachment.id);
      }
      const concurrent = await Promise.all([
        first.finalizeGeneratedAssets(input),
        second.finalizeGeneratedAssets(input),
      ]);
      assertEquals(concurrent[0][0].id, concurrent[1][0].id);
      assertEquals(
        concurrent[0][0].inputs.find((lineage) => lineage.role === "source")?.attachmentId,
        source.id,
      );
      assertEquals(concurrent[0][0].inputs.find((lineage) => lineage.role === "mask"), {
        attachmentId: mask.id,
        role: "mask",
        ordinal: 0,
        width: 1024,
        height: 1024,
        hasAlpha: true,
      });
      assertEquals(
        (await sql<{ state: string }[]>`SELECT state FROM generated_object_staging
          WHERE id=${stage.id}`)[0].state,
        "finalized",
      );
      await first.updateProvider(provider.id, provider.version, { slug: "renamed-images" }, {
        actorId: owner.id,
        action: "provider.update",
      });
      const currentModel = await first.findProviderModel(model.id);
      assertExists(currentModel);
      await first.updateProviderModel(model.id, currentModel.version, {
        publicModelId: "renamed-images/new-artist",
        upstreamModelId: "artist-v2",
      }, { actorId: owner.id, action: "provider_model.update" });
      const historical = await first.getGeneratedAsset(concurrent[0][0].id, owner.id);
      assertEquals({
        publicModelId: historical.publicModelId,
        upstreamModelId: historical.upstreamModelId,
        providerSlug: historical.providerSlug,
        pricingSnapshot: historical.pricingSnapshot,
      }, {
        publicModelId: model.publicModelId,
        upstreamModelId: model.upstreamModelId,
        providerSlug: provider.slug,
        pricingSnapshot,
      });
      assertEquals((await first.finalizeGeneratedAssets(input))[0].id, concurrent[0][0].id);
      await assertRejects(
        () =>
          first.finalizeGeneratedAssets({
            ...input,
            assets: [{
              ...input.assets[0],
              inputs: input.assets[0].inputs.map((lineage) => ({
                ...lineage,
                width: 512,
                height: 512,
              })),
            }],
          }),
        DomainError,
        "differs",
      );
      await assertRejects(
        () => first.getGeneratedAsset(concurrent[0][0].id, stranger.id),
        DomainError,
        "not found",
      );
      const conversation = await first.createConversation(owner.id, "Generated output");
      const message = await first.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "preserve",
        expectedVersion: 0,
        idempotencyKey: "generated-output-message",
      });
      await first.linkAttachmentToMessage(message.id, output.id, owner.id);
      await first.deleteGeneratedAsset(concurrent[0][0].id, owner.id);
      assertEquals((await first.listGeneratedAssets(owner.id)).length, 0);
      assertEquals((await first.listMessageAttachments(message.id, owner.id))[0].id, output.id);
      assertEquals((await first.getAttachment(output.id, owner.id)).state, "ready");
      assertEquals(
        (await first.restoreGeneratedAsset(concurrent[0][0].id, owner.id)).deletedAt,
        null,
      );
      await assertRejects(
        () =>
          first.finalizeGeneratedAssets({
            ...input,
            requestHash: "d".repeat(64),
          }),
        DomainError,
        "differs",
      );
      await assertRejects(
        () =>
          first.finalizeGeneratedAssets({
            ...input,
            idempotencyKey: "generated-assets-other-key",
          }),
        DomainError,
        "already has generated assets",
      );
      assertEquals(
        (await sql`SELECT count(*)::int count FROM generated_assets`)[0].count,
        1,
      );
    } finally {
      await first.close();
      await second.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "normalized generation atomically links only ready attachments and rejects replay drift",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "generation-attachments@database.test",
        name: "Generation Attachments",
        passwordHash: "hash",
      }, 1_000_000);
      const conversation = await repo.createConversation(owner.id, "Generation attachments");
      await assertRejects(
        () =>
          repo.beginGeneration({
            message: {
              conversationId: conversation.id,
              ownerId: owner.id,
              parentId: null,
              role: "user",
              content: "   ",
              model: "simulated/dg-chat",
              expectedVersion: 0,
              idempotencyKey: "generation-empty-message",
            },
            runId: "generation-empty-run",
            provider: "simulated",
            reserveMicros: 100,
            attachmentIds: [],
          }),
        DomainError,
        "content or at least one attachment",
      );
      assertEquals((await repo.detail(conversation.id, owner.id)).messages.length, 0);
      assertEquals((await repo.findUser(owner.id))?.balanceMicros, 1_000_000);
      const created = await repo.createAttachment({
        ownerId: owner.id,
        objectKey: `users/${owner.id}/objects/generation-attachment`,
        filename: "ready.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        sha256: "d".repeat(64),
      });
      const input = {
        message: {
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: null,
          role: "user" as const,
          content: "Use this file",
          model: "simulated/dg-chat",
          expectedVersion: 0,
          idempotencyKey: "generation-attachment-message",
        },
        runId: "generation-attachment-run",
        provider: "simulated",
        reserveMicros: 100,
        attachmentIds: [created.attachment.id],
      };

      await assertRejects(
        () => repo.beginGeneration(input),
        DomainError,
        "not ready",
      );
      assertEquals((await repo.detail(conversation.id, owner.id)).messages.length, 0);
      assertEquals((await repo.findUser(owner.id))?.balanceMicros, 1_000_000);

      await repo.transitionAttachment(created.attachment.id, owner.id, "pending", "inspecting");
      await repo.transitionAttachment(created.attachment.id, owner.id, "inspecting", "ready");
      const started = await repo.beginGeneration(input);
      if (started.kind !== "started") throw new Error("generation did not start");
      assertEquals(
        (await repo.listMessageAttachments(started.message.id, owner.id)).map((a) => a.id),
        [created.attachment.id],
      );
      assertEquals((await repo.beginGeneration(input)).kind, "in_progress");
      await assertRejects(
        () => repo.beginGeneration({ ...input, attachmentIds: [] }),
        DomainError,
        "payload differs",
      );
      assertEquals((await repo.detail(conversation.id, owner.id)).messages.length, 1);
      assertEquals((await repo.findUser(owner.id))?.balanceMicros, 999_900);
      assertEquals((await repo.listMessageAttachments(started.message.id, owner.id)).length, 1);
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "normalized text ingestion replaces chunks atomically and isolates owners",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "ingestion@database.test",
        name: "Ingestion",
        passwordHash: "hash",
      }, 1);
      const stranger = await repo.createUser({
        email: "ingestion-stranger@database.test",
        name: "Stranger",
        passwordHash: "hash",
      });
      const created = await repo.createAttachment({
        ownerId: owner.id,
        objectKey: `users/${owner.id}/objects/ingestion`,
        filename: "notes.json",
        mimeType: "application/json",
        sizeBytes: 2,
        sha256: "e".repeat(64),
        state: "ready",
      });
      assertEquals(created.attachment.ingestionStatus, "queued");
      const jobs = await repo.listJobs();
      assertEquals(jobs.items.filter((job) => job.type === "attachment.ingest").length, 1);
      const mutate = postgres(databaseUrl!, { max: 1 });
      await mutate`UPDATE attachments SET ingestion_status='processing' WHERE id=${created.attachment.id}`;
      await mutate.end();
      const chunk = {
        id: "00000000-0000-8000-8000-000000000002",
        ordinal: 0,
        content: "{}",
        metadata: {
          sourceAttachmentId: created.attachment.id,
          extractorVersion: "json-v2",
          chunkerVersion: "semantic-v3",
          pageNumber: 3,
          pageLabel: "A-3",
          section: "Configuration",
          sectionPath: ["Manual", "Configuration"],
          startLine: 1,
          endLine: 1,
        },
      };
      await repo.completeAttachmentIngestion(created.attachment.id, owner.id, [chunk]);
      assertEquals(
        (await repo.listDocumentChunks(created.attachment.id, owner.id))[0].content,
        "{}",
      );
      assertEquals(
        (await repo.listDocumentChunks(created.attachment.id, owner.id))[0].metadata,
        chunk.metadata,
      );
      await assertRejects(
        () => repo.listDocumentChunks(created.attachment.id, stranger.id),
        DomainError,
        "not found",
      );
      const mutateAgain = postgres(databaseUrl!, { max: 1 });
      await mutateAgain`UPDATE attachments SET ingestion_status='processing' WHERE id=${created.attachment.id}`;
      await mutateAgain.end();
      await assertRejects(
        () =>
          repo.completeAttachmentIngestion(created.attachment.id, owner.id, [{
            ...chunk,
            ordinal: 1,
          }]),
        DomainError,
        "invalid",
      );
      await assertRejects(
        () =>
          repo.completeAttachmentIngestion(created.attachment.id, owner.id, [{
            ...chunk,
            metadata: { ...chunk.metadata, sectionPath: ["x".repeat(501)] },
          }]),
        DomainError,
        "invalid",
      );
      assertEquals(
        (await repo.listDocumentChunks(created.attachment.id, owner.id))[0].content,
        "{}",
      );
      await repo.failAttachmentIngestion(created.attachment.id, owner.id, "missing object");
      const legacyRepair = postgres(databaseUrl!, { max: 1 });
      await legacyRepair`UPDATE attachments SET ingestion_status='queued'
        WHERE id=${created.attachment.id}`;
      await legacyRepair`UPDATE jobs SET status='failed'
        WHERE idempotency_key=${`attachment.ingest:${created.attachment.id}`}`;
      await legacyRepair.end();
      assertEquals(
        (await repo.retryAttachmentIngestion(created.attachment.id, owner.id)).ingestionStatus,
        "queued",
      );
    } finally {
      await repo.close();
    }
  },
});

Deno.test({
  name: "normalized PDF and DOCX eligibility queues and retries with owner isolation",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "formats@database.test",
        name: "Formats",
        passwordHash: "hash",
      }, 1);
      const stranger = await repo.createUser({
        email: "formats-stranger@database.test",
        name: "Stranger",
        passwordHash: "hash",
      });
      const eligible = [
        ["application/pdf", "document.pdf"],
        [
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "document.docx",
        ],
      ] as const;
      for (const [index, [mimeType, filename]] of eligible.entries()) {
        let attachment = (await repo.createAttachment({
          ownerId: owner.id,
          objectKey: `users/${owner.id}/objects/${filename}`,
          filename,
          mimeType,
          sizeBytes: 10,
          sha256: String(index + 1).repeat(64),
          state: index === 0 ? "ready" : "pending",
        })).attachment;
        if (index === 1) {
          await repo.transitionAttachment(attachment.id, owner.id, "pending", "inspecting");
          attachment = await repo.transitionAttachment(
            attachment.id,
            owner.id,
            "inspecting",
            "ready",
          );
        }
        assertEquals(attachment.ingestionStatus, "queued");
        await assertRejects(
          () => repo.beginAttachmentIngestion(attachment.id, stranger.id),
          DomainError,
          "not found",
        );
        assertEquals(
          (await repo.beginAttachmentIngestion(attachment.id, owner.id)).ingestionStatus,
          "processing",
        );
        assertEquals(
          (await repo.failAttachmentIngestion(attachment.id, owner.id, "extract failed"))
            .ingestionStatus,
          "failed",
        );
        await assertRejects(
          () => repo.retryAttachmentIngestion(attachment.id, stranger.id),
          DomainError,
          "not found",
        );
        assertEquals(
          (await repo.retryAttachmentIngestion(attachment.id, owner.id)).ingestionStatus,
          "queued",
        );
      }
      assertEquals(
        (await repo.listJobs()).items.filter((job) => job.type === "attachment.ingest").length,
        2,
      );

      for (
        const [index, mimeType] of [
          "application/vnd.ms-word.document.macroEnabled.12",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ].entries()
      ) {
        const attachment = (await repo.createAttachment({
          ownerId: owner.id,
          objectKey: `users/${owner.id}/objects/unsupported-${index}`,
          filename: "unsupported.office",
          mimeType,
          sizeBytes: 10,
          sha256: String(index + 3).repeat(64),
          state: "ready",
        })).attachment;
        assertEquals(attachment.ingestionStatus, "not_applicable");
        await assertRejects(
          () => repo.beginAttachmentIngestion(attachment.id, owner.id),
          DomainError,
          "not queued",
        );
      }
      assertEquals(
        (await repo.listJobs()).items.filter((job) => job.type === "attachment.ingest").length,
        2,
      );
    } finally {
      await repo.close();
    }
  },
});
