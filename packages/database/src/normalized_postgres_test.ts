import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { backfillLegacyRuntimeSnapshot } from "./legacy-backfill.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres provider accounting is authoritative for API failure and stale run leases",
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
      assertEquals(failed[0], { status: "failed", cost: "7", input_tokens: 3 });

      const stale = await repo.reserve(user.id, "postgres-provider-stale", "provider/model", 100);
      await sql`UPDATE usage_runs SET execution_epoch=1,actual_provider_cost_micros=5,
        run_lease_expires_at=now()-interval '1 second' WHERE id=${stale.id}`;
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
      assertEquals(await repo.reapStaleProviderExecutionLeases(), 1);
      assertEquals(await repo.reapStaleProviderExecutionLeases(), 0);
      const reaped = await sql<
        { status: string; cost: string; run_lease_token: string | null }[]
      >`SELECT status,cost_micros::text cost,run_lease_token::text FROM usage_runs WHERE id=${stale.id}`;
      assertEquals(reaped[0], { status: "failed", cost: "100", run_lease_token: null });
      const attempts = await sql<
        { status: string; error_code: string | null }[]
      >`SELECT status,error_code FROM provider_attempts WHERE usage_run_id=${stale.id}`;
      assertEquals([...attempts], [{ status: "cancelled", error_code: "execution_lease_expired" }]);

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
      await sql`UPDATE api_idempotency_requests SET lease_expires_at=now()-interval '1 second'
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
        { status: string; error_code: string | null }[]
      >`SELECT status,error_code FROM provider_attempts WHERE usage_run_id=${api.usageRun.id}`;
      assertEquals([...apiRun], [{ status: "failed", cost: "100" }]);
      assertEquals([...apiBalanceAfter], [...apiBalanceBefore]);
      assertEquals([...apiAttempts], [{ status: "cancelled", error_code: "api_lease_expired" }]);

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
      assertEquals([...generationRun], [{ status: "failed", cost: "100" }]);
      assertEquals([...generationBalanceAfter], [...generationBalanceBefore]);
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
    await sql`TRUNCATE audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
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
      await repo.approveUser(applicant.id, "approved", 1_000_000);
      const session = await repo.createSession(applicant.id, "session-hash", false);
      assertEquals((await repo.getSession(session.tokenHash))?.userId, applicant.id);
      assertEquals((await repo.listSessions(applicant.id))[0].id, session.id);

      const identityUser = await repo.createUser({
        email: "identity@database.test",
        name: "Identity",
        passwordHash: "old-hash",
      });
      await assertRejects(
        () => repo.approveUser(identityUser.id, "approved", 10, true),
        DomainError,
        "verified",
      );
      await Promise.all([
        repo.createIdentityToken(
          identityUser.id,
          "email_verification",
          "verify-db-hash",
          new Date(Date.now() + 60_000).toISOString(),
        ),
        repo.createIdentityToken(
          identityUser.id,
          "email_verification",
          "verify-db-hash-concurrent",
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ]);
      await repo.verifyEmail("verify-db-hash");
      await repo.verifyEmail("verify-db-hash-concurrent");
      await assertRejects(
        () => repo.verifyEmail("verify-db-hash"),
        DomainError,
        "invalid or expired",
      );
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
        ),
        repo.createIdentityToken(
          identityUser.id,
          "password_reset",
          "reset-db-hash-concurrent",
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ]);
      await repo.resetPassword("reset-db-hash", "new-hash");
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
      await repo.approveUser(quotaUser.id, "approved", 1_000_000);
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
      await repo.approveUser(eventQuotaUser.id, "approved", 1_000_000);
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
      assertEquals((await repo.usage(applicant.id)).balanceMicros, 945_000);
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
        repo.setUserState(admin.id, "suspended"),
        repo.setUserState(secondAdmin.id, "suspended"),
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
      const makeModel = async (name: string) => {
        const model = await repo.createProviderModel({
          providerId: provider.id,
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
      const a = await makeModel("a"), b = await makeModel("b"), c = await makeModel("c");
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
  name: "legacy runtime snapshot backfill preserves all domain collections and is idempotent",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE repository_migrations, operation_idempotency, audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users, runtime_snapshots RESTART IDENTITY CASCADE`;
    const userId = crypto.randomUUID(),
      conversationId = crypto.randomUUID(),
      messageId = crypto.randomUUID();
    const tokenId = crypto.randomUUID(),
      ledgerId = crypto.randomUUID(),
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
        balanceMicros: 100,
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
      }],
      usageRuns: [["legacy-run", {
        id: "legacy-run",
        userId,
        model: "legacy/model",
        status: "completed",
        reservedMicros: 100,
        costMicros: 0,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
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
      assertEquals(rows[0].count, 1, table);
    }
    const imported = await verify<
      { idempotency_key: string }[]
    >`SELECT idempotency_key FROM messages WHERE id=${messageId}`;
    assertEquals(imported[0].idempotency_key, "legacy-message");
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
    await sql`TRUNCATE audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
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

      await repo.updateConversation(owner.id, conversation.id, { archived: true });
      await assertReadOnly();
      await repo.updateConversation(owner.id, conversation.id, { archived: false, deleted: true });
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
    await sql`TRUNCATE audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
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
    await sql`TRUNCATE audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
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
        (await repo.listJobs()).filter((job) => job.type === "attachment.inspect").length,
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
  name: "normalized generation atomically links only ready attachments and rejects replay drift",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
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
    await sql`TRUNCATE audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
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
      assertEquals(jobs.filter((job) => job.type === "attachment.ingest").length, 1);
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
    await sql`TRUNCATE audit_events, document_chunks, message_attachments, attachments, jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
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
        (await repo.listJobs()).filter((job) => job.type === "attachment.ingest").length,
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
        (await repo.listJobs()).filter((job) => job.type === "attachment.ingest").length,
        2,
      );
    } finally {
      await repo.close();
    }
  },
});
