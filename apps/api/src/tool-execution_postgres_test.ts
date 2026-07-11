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
          repo.refund(`tool:${execution.id}`, error).then((run) => run !== undefined),
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

      let reserveCalls = 0;
      let firstReserveStarted!: () => void;
      let releaseFirst!: () => void;
      const started = new Promise<void>((resolve) => firstReserveStarted = resolve);
      const release = new Promise<void>((resolve) => releaseFirst = resolve);
      const racingControls = {
        reserve: async (execution: { id: string; ownerId: string; toolId: string }) => {
          await repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
          });
          if (++reserveCalls === 1) {
            firstReserveStarted();
            await release;
          }
        },
        settle: (execution: { id: string }) =>
          repo.settle(`tool:${execution.id}`, reserveMicros, 0, 0, 0).then(() => undefined),
        refund: (execution: { id: string }, error?: string) =>
          repo.refund(`tool:${execution.id}`, error).then((run) => run !== undefined),
      };
      const approver = new ToolExecutionService(store, [adapter], racingControls);
      const recoverer = new ToolExecutionService(store, [adapter], racingControls);
      const raced = await approver.request(user.id, "echo", {});
      const approval = approver.approve(user.id, raced.id);
      await started;
      const recovery = recoverer.recover();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (await store.getExecution(raced.id, user.id))?.status !== "queued_pending_reservation"
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      releaseFirst();
      await approval;
      await recovery;
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await approver.get(user.id, raced.id)).status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assertEquals((await approver.get(user.id, raced.id)).status, "succeeded");
      const racedEntries = await sql<{ kind: string }[]>`
        SELECT kind FROM ledger_entries WHERE usage_run_id=${`tool:${raced.id}`} ORDER BY id`;
      assertEquals([...racedEntries], [{ kind: "reserve" }]);

      const crashedCancellation = await service.request(user.id, "echo", {});
      await store.transitionExecution(crashedCancellation.id, ["pending_approval"], {
        status: "queued",
        approvedAt: new Date().toISOString(),
        approvedBy: user.id,
        cancellationRequestedAt: new Date().toISOString(),
      });
      await repo.ensureIdempotentReservation({
        userId: user.id,
        usageRunId: `tool:${crashedCancellation.id}`,
        model: "tool/echo",
        provider: "tool",
        reservedMicros: reserveMicros,
      });
      const restarted = new ToolExecutionService(store, [adapter], service.controls);
      await restarted.recover();
      assertEquals(
        (await restarted.get(user.id, crashedCancellation.id)).status,
        "cancelled",
      );
      const cancellationEntries = await sql<{ kind: string }[]>`
        SELECT kind FROM ledger_entries
        WHERE usage_run_id=${`tool:${crashedCancellation.id}`} ORDER BY id`;
      assertEquals(cancellationEntries.map((entry) => entry.kind).sort(), ["refund", "reserve"]);
    } finally {
      await store.close();
      await repo.close();
      await sql.end();
    }
  },
});
