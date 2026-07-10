import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { backfillLegacyRuntimeSnapshot } from "./legacy-backfill.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

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
      });
      await repo.approveUser(applicant.id, "approved", 1_000_000);
      const session = await repo.createSession(applicant.id, "session-hash", false);
      assertEquals((await repo.getSession(session.tokenHash))?.userId, applicant.id);

      const quotaUser = await repo.createUser({
        email: "quota-requests@database.test",
        name: "Request Quota",
        passwordHash: "hash",
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
          parentId: edited.id,
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
      const completed = await repo.completeGeneration({
        conversationId: chat.id,
        ownerId: applicant.id,
        userMessageId: started.message.id,
        runId: "atomic-run",
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
