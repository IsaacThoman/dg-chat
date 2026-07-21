import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";
import { PostgresToolExecutionStore } from "./tool-store.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres tool store enforces ownership, policy CAS, and transition CAS",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const store = PostgresToolExecutionStore.connect(databaseUrl!);
    await runAuditTestMaintenanceSql(
      sql,
      "TRUNCATE auth_verifications, auth_sessions, auth_accounts, auth_users, tool_executions, tool_policies, audit_events, users RESTART IDENTITY CASCADE",
    );
    const users = await sql<{ id: string }[]>`
      INSERT INTO users(email,name,password_hash,approval_status)
      VALUES ('tool-owner@example.com','Owner','x','approved'),
             ('tool-other@example.com','Other','x','approved') RETURNING id`;
    try {
      const first = await store.putPolicy({
        toolId: "web_search",
        allowed: true,
        allowedDomains: ["search.internal"],
        allowPrivateNetwork: false,
        updatedBy: users[0].id,
      }, 0);
      assertEquals(first.version, 1);
      const second = await store.putPolicy({ ...first, allowed: false }, 1);
      assertEquals(second.version, 2);
      await assertRejects(
        () => store.putPolicy({ ...first, allowed: true }, 1),
        Error,
        "another session",
      );

      const now = new Date().toISOString();
      const created = await store.createExecution({
        id: crypto.randomUUID(),
        ownerId: users[0].id,
        toolId: "web_search",
        input: { query: "immutable branches" },
        status: "pending_approval",
        result: null,
        error: null,
        approvedAt: null,
        approvedBy: null,
        cancellationRequestedAt: null,
        billingSnapshot: null,
        createdAt: now,
        updatedAt: now,
      });
      assertEquals(await store.getExecution(created.id, users[1].id), undefined);
      assertEquals((await store.getExecution(created.id, users[0].id))?.input, created.input);
      assertEquals(
        (await store.transitionExecution(created.id, ["pending_approval"], {
          status: "queued",
          billingSnapshot: {
            reservedMicros: 1_000,
            provider: "tool",
            model: "tool/web_search",
          },
        }))
          ?.status,
        "queued",
      );
      assertEquals((await store.getExecution(created.id))?.billingSnapshot, {
        reservedMicros: 1_000,
        provider: "tool",
        model: "tool/web_search",
      });
      assertEquals(
        await store.transitionExecution(created.id, ["queued"], {
          billingSnapshot: {
            reservedMicros: 2_000,
            provider: "tool",
            model: "tool/web_search",
          },
        }),
        undefined,
      );
      assertEquals(
        await store.transitionExecution(created.id, ["pending_approval"], { status: "cancelled" }),
        undefined,
      );
      await store.transitionExecution(created.id, ["queued"], { status: "running" });
      await store.transitionExecution(created.id, ["running"], {
        status: "succeeded_pending_settlement",
        result: { verified: true },
      });
      await store.transitionExecution(created.id, ["succeeded_pending_settlement"], {
        status: "succeeded",
      });
      const conversations = await sql<{ id: string }[]>`INSERT INTO conversations(owner_id,title)
        VALUES(${users[0].id},'Tool linkage') RETURNING id`;
      const messages = await sql<{ id: string }[]>`INSERT INTO messages
        (conversation_id,parent_id,sibling_index,role,content,idempotency_key,metadata)
        VALUES(${conversations[0].id},NULL,0,'user','linked','tool-link',
          ${sql.json({ toolExecutionIds: [created.id] })}) RETURNING id`;
      await store.linkExecutions(users[0].id, messages[0].id, [created.id]);
      await assertRejects(
        () => store.linkExecutions(users[1].id, messages[0].id, [created.id]),
        Error,
        "invalid",
      );
      assertEquals((await sql`SELECT 1 FROM message_tool_executions`).length, 1);
      const foreign = await store.createExecution({
        ...created,
        id: crypto.randomUUID(),
        ownerId: users[1].id,
        status: "succeeded",
        result: { foreign: true },
      });
      await assertRejects(
        () =>
          sql`INSERT INTO messages
          (conversation_id,parent_id,sibling_index,role,content,idempotency_key,metadata)
          VALUES(${conversations[0].id},NULL,1,'user','forbidden','tool-link-forbidden',
            ${sql.json({ toolExecutionIds: [foreign.id] })})`,
        Error,
        "invalid",
      );
      assertEquals(
        (await sql`SELECT 1 FROM messages WHERE idempotency_key='tool-link-forbidden'`).length,
        0,
      );
      const recoverable = await store.createExecution({
        ...created,
        id: crypto.randomUUID(),
        status: "queued",
        result: null,
        billingSnapshot: {
          reservedMicros: 1_000,
          provider: "tool",
          model: "tool/web_search",
        },
      });
      const [claimed] = await store.claimRecoverable(1);
      assertEquals(claimed.id, recoverable.id);
      assertEquals(typeof claimed.claimToken, "string");
      assertEquals(await store.renewClaim(claimed.id, crypto.randomUUID(), 120_000), false);
      assertEquals(await store.renewClaim(claimed.id, claimed.claimToken!, 120_000), true);
      assertEquals(
        await store.transitionExecution(
          claimed.id,
          ["running"],
          {
            status: "failed_pending_refund",
            error: { code: "tool_execution_failed", message: "Tool execution failed" },
          },
          crypto.randomUUID(),
        ),
        undefined,
      );
      const refundPending = await store.transitionExecution(
        claimed.id,
        ["running"],
        {
          status: "failed_pending_refund",
          error: { code: "tool_execution_failed", message: "Tool execution failed" },
        },
        claimed.claimToken!,
      );
      assertEquals(refundPending?.status, "failed_pending_refund");
      assertEquals((await store.listPendingRefund(10)).map((row) => row.id), [claimed.id]);
      assertEquals(
        (await store.transitionExecution(claimed.id, ["failed_pending_refund"], {
          status: "failed",
        }))?.status,
        "failed",
      );
      const audits = await sql<{ action: string }[]>`
        SELECT action FROM audit_events WHERE target_id IN ('web_search', ${created.id})
        ORDER BY created_at, id`;
      assertEquals(audits.map((row) => row.action), [
        "tool.policy.updated",
        "tool.policy.updated",
        "tool.execution.queued",
        "tool.execution.succeeded_pending_settlement",
        "tool.execution.succeeded",
      ]);
    } finally {
      await store.close();
      await sql.end();
    }
  },
});
