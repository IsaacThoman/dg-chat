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
    await sql`INSERT INTO runtime_snapshots(id,payload) VALUES('primary',${sql.json(snapshot)})`;
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
