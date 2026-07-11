import { assertEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { PostgresRepository, PostgresToolExecutionStore } from "@dg-chat/database";
import { type ToolAdapter, ToolExecutionService } from "./tool-execution.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres startup recovery resumes a tool reservation after a lost acknowledgement",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repo = await PostgresRepository.connect(databaseUrl!);
    const store = PostgresToolExecutionStore.connect(databaseUrl!);
    await sql`TRUNCATE tool_executions, tool_policies, audit_events, ledger_entries, usage_runs,
      api_tokens, sessions, messages, conversations, users RESTART IDENTITY CASCADE`;
    try {
      const user = await repo.bootstrapAdmin({
        email: "tool-lost-ack@example.com",
        name: "Lost ack",
        passwordHash: "hash",
      }, 10_000);
      const adapter: ToolAdapter = {
        definition: {
          id: "echo",
          name: "Echo",
          description: "Echo",
          inputSchema: { type: "object" },
          enabled: true,
        },
        execute: () => Promise.resolve({ recovered: true }),
      };
      const reserveMicros = 1_000;
      const service = new ToolExecutionService(store, [adapter], {
        reserve: (execution) =>
          repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
          }).then(() => undefined),
        settle: (execution) =>
          repo.settle(`tool:${execution.id}`, reserveMicros, 0, 0, 0).then(() => undefined),
        refund: (execution, error) =>
          repo.refund(`tool:${execution.id}`, error).then(() => undefined),
      });
      await service.setPolicy({ toolId: "echo", allowed: true, actorId: user.id });
      const requested = await service.request(user.id, "echo", {});
      await store.transitionExecution(requested.id, ["pending_approval"], {
        status: "queued_pending_reservation",
        approvedAt: new Date().toISOString(),
        approvedBy: user.id,
      });
      // The debit committed, but the process died before acknowledging it or advancing the state.
      await repo.ensureIdempotentReservation({
        userId: user.id,
        usageRunId: `tool:${requested.id}`,
        model: "tool/echo",
        provider: "tool",
        reservedMicros: reserveMicros,
      });
      await service.recover();
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await service.get(user.id, requested.id)).status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assertEquals((await service.get(user.id, requested.id)).status, "succeeded");
      const entries = await sql<{ kind: string; amount: string }[]>`
        SELECT kind,amount_micros::text amount FROM ledger_entries
        WHERE usage_run_id=${`tool:${requested.id}`} ORDER BY id`;
      assertEquals([...entries], [{ kind: "reserve", amount: "-1000" }]);
      assertEquals((await repo.usage(user.id)).balanceMicros, 9_000);
    } finally {
      await store.close();
      await repo.close();
      await sql.end();
    }
  },
});
