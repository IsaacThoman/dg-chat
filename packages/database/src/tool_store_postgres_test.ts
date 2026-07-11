import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
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
    await sql`TRUNCATE tool_executions, tool_policies, audit_events, users RESTART IDENTITY CASCADE`;
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
        createdAt: now,
        updatedAt: now,
      });
      assertEquals(await store.getExecution(created.id, users[1].id), undefined);
      assertEquals((await store.getExecution(created.id, users[0].id))?.input, created.input);
      assertEquals(
        (await store.transitionExecution(created.id, ["pending_approval"], { status: "queued" }))
          ?.status,
        "queued",
      );
      assertEquals(
        await store.transitionExecution(created.id, ["pending_approval"], { status: "cancelled" }),
        undefined,
      );
      const audits = await sql<{ action: string }[]>`
        SELECT action FROM audit_events WHERE target_id IN ('web_search', ${created.id})
        ORDER BY created_at, id`;
      assertEquals(audits.map((row) => row.action), [
        "tool.policy.updated",
        "tool.policy.updated",
        "tool.execution.queued",
      ]);
    } finally {
      await store.close();
      await sql.end();
    }
  },
});
