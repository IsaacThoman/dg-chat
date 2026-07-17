import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { PostgresRepository, PostgresToolExecutionStore } from "@dg-chat/database";
import { runAuditTestMaintenanceSql } from "../../../packages/database/src/postgres-test-maintenance.ts";
import { type ToolAdapter, ToolExecutionService } from "./tool-execution.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const billingSnapshot = (toolId: string, reservedMicros = 1_000) => ({
  reservedMicros,
  provider: "tool",
  model: `tool/${toolId}`,
});

Deno.test({
  name: "Postgres startup recovery resumes a tool reservation after a lost acknowledgement",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repo = await PostgresRepository.connect(databaseUrl!);
    const store = PostgresToolExecutionStore.connect(databaseUrl!);
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE tool_executions, tool_policies, audit_events, ledger_entries, usage_runs,
        api_tokens, sessions, messages, conversations, auth_sessions, auth_accounts,
        auth_verifications, auth_users, users RESTART IDENTITY CASCADE`,
    );
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
          recoverySafety: "idempotent_by_execution_id",
          inputSchema: { type: "object" },
          enabled: true,
        },
        execute: () => Promise.resolve({ recovered: true }),
      };
      const reserveMicros = 1_000;
      const service = new ToolExecutionService(store, [adapter], {
        admit: () => Promise.resolve(),
        billingSnapshot: (execution) => billingSnapshot(execution.toolId, reserveMicros),
        reserve: (execution) =>
          repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
          }).then(() => undefined),
        reconcileReservation: (execution) =>
          repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
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
        billingSnapshot: billingSnapshot(requested.toolId, reserveMicros),
      });
      // The debit committed, but the process died before acknowledging it or advancing the state.
      await repo.ensureIdempotentReservation({
        userId: user.id,
        usageRunId: `tool:${requested.id}`,
        model: "tool/echo",
        provider: "tool",
        reservedMicros: reserveMicros,
        recoveryOwner: "tool",
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
        admit: () => Promise.resolve(),
        billingSnapshot: (execution: { toolId: string }) =>
          billingSnapshot(execution.toolId, reserveMicros),
        reserve: async (execution: { id: string; ownerId: string; toolId: string }) => {
          await repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
          });
          if (++reserveCalls === 1) {
            firstReserveStarted();
            await release;
          }
        },
        reconcileReservation: async (
          execution: { id: string; ownerId: string; toolId: string },
        ) => {
          await repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
          });
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
        billingSnapshot: billingSnapshot(crashedCancellation.toolId, reserveMicros),
      });
      await repo.ensureIdempotentReservation({
        userId: user.id,
        usageRunId: `tool:${crashedCancellation.id}`,
        model: "tool/echo",
        provider: "tool",
        reservedMicros: reserveMicros,
        recoveryOwner: "tool",
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

      let refundAttempts = 0;
      const failing = new ToolExecutionService(store, [{
        ...adapter,
        execute: () => Promise.reject(new Error("provider failure")),
      }], {
        admit: () => Promise.resolve(),
        billingSnapshot: (execution) => billingSnapshot(execution.toolId, reserveMicros),
        reserve: (execution) =>
          repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
          }).then(() => undefined),
        reconcileReservation: (execution) =>
          repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
          }).then(() => undefined),
        settle: () => Promise.resolve(),
        refund: (execution, error) => {
          if (++refundAttempts === 1) {
            return Promise.reject(new Error("ledger temporarily offline"));
          }
          return repo.refund(`tool:${execution.id}`, error).then((run) => run !== undefined);
        },
      });
      const failedRequest = await failing.request(user.id, "echo", {});
      await failing.approve(user.id, failedRequest.id);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (await failing.get(user.id, failedRequest.id)).status === "failed_pending_refund"
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assertEquals(
        (await failing.get(user.id, failedRequest.id)).status,
        "failed_pending_refund",
      );
      const afterCrash = new ToolExecutionService(store, [adapter], failing.controls);
      await afterCrash.recover();
      assertEquals((await afterCrash.get(user.id, failedRequest.id)).status, "failed");
      const failedEntries = await sql<{ kind: string }[]>`
        SELECT kind FROM ledger_entries WHERE usage_run_id=${`tool:${failedRequest.id}`} ORDER BY id`;
      assertEquals(failedEntries.map((entry) => entry.kind).sort(), ["refund", "reserve"]);

      const concurrentRefund = await service.request(user.id, "echo", {});
      await store.transitionExecution(concurrentRefund.id, ["pending_approval"], {
        status: "cancelled_pending_refund",
        approvedAt: new Date().toISOString(),
        approvedBy: user.id,
        cancellationRequestedAt: new Date().toISOString(),
        billingSnapshot: billingSnapshot(concurrentRefund.toolId, reserveMicros),
      });
      await repo.ensureIdempotentReservation({
        userId: user.id,
        usageRunId: `tool:${concurrentRefund.id}`,
        model: "tool/echo",
        provider: "tool",
        reservedMicros: reserveMicros,
        recoveryOwner: "tool",
      });
      const reconcilerA = new ToolExecutionService(store, [adapter], service.controls);
      const reconcilerB = new ToolExecutionService(store, [adapter], service.controls);
      await Promise.all([reconcilerA.recover(), reconcilerB.recover()]);
      assertEquals((await service.get(user.id, concurrentRefund.id)).status, "cancelled");
      const concurrentEntries = await sql<{ kind: string }[]>`
        SELECT kind FROM ledger_entries WHERE usage_run_id=${`tool:${concurrentRefund.id}`}
        ORDER BY sequence`;
      assertEquals(concurrentEntries.map((entry) => entry.kind), ["reserve", "refund"]);

      let admissionCalls = 0;
      let reconciliationCalls = 0;
      let admissionStarted!: () => void;
      let releaseAdmission!: () => void;
      const atAdmission = new Promise<void>((resolve) => admissionStarted = resolve);
      const admissionRelease = new Promise<void>((resolve) => releaseAdmission = resolve);
      const racingCancellationControls = {
        admit: () => Promise.resolve(),
        billingSnapshot: (execution: { toolId: string }) =>
          billingSnapshot(execution.toolId, reserveMicros),
        reserve: async (execution: { id: string; ownerId: string; toolId: string }) => {
          admissionCalls++;
          admissionStarted();
          await admissionRelease;
          await repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
          });
        },
        reconcileReservation: async (
          execution: { id: string; ownerId: string; toolId: string },
        ) => {
          reconciliationCalls++;
          await repo.ensureIdempotentReservation({
            userId: execution.ownerId,
            usageRunId: `tool:${execution.id}`,
            model: `tool/${execution.toolId}`,
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
          });
        },
        settle: (execution: { id: string }) =>
          repo.settle(`tool:${execution.id}`, reserveMicros, 0, 0, 0).then(() => undefined),
        refund: (execution: { id: string }, error?: string) =>
          repo.refund(`tool:${execution.id}`, error).then((run) => run !== undefined),
      };
      const racingCancellation = new ToolExecutionService(
        store,
        [adapter],
        racingCancellationControls,
      );
      const racedCancellation = await racingCancellation.request(user.id, "echo", {});
      const losingApproval = racingCancellation.approve(user.id, racedCancellation.id);
      await atAdmission;
      assertEquals(
        (await racingCancellation.cancel(user.id, racedCancellation.id)).status,
        "cancelled",
      );
      releaseAdmission();
      await assertRejects(() => losingApproval, Error, "cancelled");
      const racedCancellationEntries = await sql<{ kind: string }[]>`
        SELECT kind FROM ledger_entries
        WHERE usage_run_id=${`tool:${racedCancellation.id}`} ORDER BY sequence`;
      assertEquals(racedCancellationEntries.map((entry) => entry.kind), ["reserve", "refund"]);
      assertEquals(admissionCalls, 1);
      assertEquals(reconciliationCalls, 1);

      const balance = (await repo.usage(user.id)).balanceMicros;
      await repo.reserve(user.id, "tool-test-credit-drain", "test/drain", balance, "test");
      const noReservation = await service.request(user.id, "echo", {});
      await store.transitionExecution(noReservation.id, ["pending_approval"], {
        status: "queued_pending_reservation",
        approvedAt: new Date().toISOString(),
        approvedBy: user.id,
        cancellationRequestedAt: new Date().toISOString(),
        billingSnapshot: billingSnapshot(noReservation.toolId, reserveMicros),
      });
      await restarted.recover();
      assertEquals(
        (await restarted.get(user.id, noReservation.id)).status,
        "cancelled_pending_refund",
      );
      assertEquals(
        (await sql`SELECT 1 FROM usage_runs WHERE id=${`tool:${noReservation.id}`}`).length,
        0,
      );
      await repo.refund("tool-test-credit-drain");
      await restarted.recover();
      assertEquals((await restarted.get(user.id, noReservation.id)).status, "cancelled");
      const delayedEntries = await sql<{ kind: string }[]>`
        SELECT kind FROM ledger_entries WHERE usage_run_id=${`tool:${noReservation.id}`}
        ORDER BY sequence`;
      assertEquals(delayedEntries.map((entry) => entry.kind), ["reserve", "refund"]);
    } finally {
      await store.close();
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "Postgres tool reconciliation recognizes an exact-balance debit after a lost acknowledgement",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repo = await PostgresRepository.connect(databaseUrl!);
    const store = PostgresToolExecutionStore.connect(databaseUrl!);
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE tool_executions, tool_policies, audit_events, ledger_entries, usage_runs,
        api_tokens, sessions, messages, conversations, auth_sessions, auth_accounts,
        auth_verifications, auth_users, users RESTART IDENTITY CASCADE`,
    );
    try {
      const reserveMicros = 1_000;
      const user = await repo.bootstrapAdmin({
        email: "tool-exact-balance-lost-ack@example.com",
        name: "Exact balance lost ack",
        passwordHash: "hash",
      }, reserveMicros);
      const adapter: ToolAdapter = {
        definition: {
          id: "echo",
          name: "Echo",
          description: "Echo",
          recoverySafety: "idempotent_by_execution_id",
          inputSchema: { type: "object" },
          enabled: true,
        },
        execute: () => Promise.resolve({ recovered: true }),
      };
      const ensure = (execution: { id: string; ownerId: string; toolId: string }) =>
        repo.ensureIdempotentReservation({
          userId: execution.ownerId,
          usageRunId: `tool:${execution.id}`,
          model: `tool/${execution.toolId}`,
          provider: "tool",
          reservedMicros: reserveMicros,
          recoveryOwner: "tool",
        }).then(() => undefined);
      const service = new ToolExecutionService(store, [adapter], {
        admit: () => Promise.resolve(),
        billingSnapshot: (execution) => billingSnapshot(execution.toolId, reserveMicros),
        reserve: ensure,
        reconcileReservation: ensure,
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
        billingSnapshot: billingSnapshot(requested.toolId, reserveMicros),
      });

      // The only credit was durably debited, but the caller never observed the response. Recovery
      // must discover that identical reservation before applying current-balance admission again.
      await ensure(requested);
      assertEquals((await repo.usage(user.id)).balanceMicros, 0);
      await service.recover();
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await service.get(user.id, requested.id)).status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assertEquals((await service.get(user.id, requested.id)).status, "succeeded");
      const entries = await sql<{ kind: string; amount: string }[]>`
        SELECT kind,amount_micros::text amount FROM ledger_entries
        WHERE usage_run_id=${`tool:${requested.id}`} ORDER BY sequence`;
      assertEquals([...entries], [{ kind: "reserve", amount: "-1000" }]);
      assertEquals((await repo.usage(user.id)).balanceMicros, 0);

      const collisionA = await repo.createUser({
        email: "tool-collision-a@example.com",
        name: "Collision A",
        passwordHash: "hash",
      });
      const collisionB = await repo.createUser({
        email: "tool-collision-b@example.com",
        name: "Collision B",
        passwordHash: "hash",
      });
      await sql`UPDATE users SET balance_micros=${reserveMicros}
        WHERE id IN (${collisionA.id},${collisionB.id})`;
      const collidingRunId = `tool:${crypto.randomUUID()}`;
      const collisionResults = await Promise.allSettled(
        [collisionA, collisionB].map((owner) =>
          repo.ensureIdempotentReservation({
            userId: owner.id,
            usageRunId: collidingRunId,
            model: "tool/echo",
            provider: "tool",
            reservedMicros: reserveMicros,
            recoveryOwner: "tool",
          })
        ),
      );
      assertEquals(collisionResults.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = collisionResults.find((result) => result.status === "rejected");
      assertEquals(rejected?.status, "rejected");
      if (rejected?.status === "rejected") {
        assertEquals((rejected.reason as { code?: string }).code, "idempotency_conflict");
      }
      const collisionLedger = await sql<{ kind: string }[]>`
        SELECT kind FROM ledger_entries WHERE usage_run_id=${collidingRunId}`;
      assertEquals([...collisionLedger], [{ kind: "reserve" }]);
      const collisionBalances = await sql<{ balance: string }[]>`
        SELECT balance_micros::text balance FROM users
        WHERE id IN (${collisionA.id},${collisionB.id}) ORDER BY balance_micros`;
      assertEquals(collisionBalances.map((row) => row.balance), ["0", "1000"]);
    } finally {
      await store.close();
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres restart recovery settles and refunds the persisted tool billing snapshot",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repo = await PostgresRepository.connect(databaseUrl!);
    const store = PostgresToolExecutionStore.connect(databaseUrl!);
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE tool_executions, tool_policies, audit_events, ledger_entries, usage_runs,
        api_tokens, sessions, messages, conversations, auth_sessions, auth_accounts,
        auth_verifications, auth_users, users RESTART IDENTITY CASCADE`,
    );
    try {
      const user = await repo.bootstrapAdmin({
        email: "tool-billing-snapshot@example.com",
        name: "Billing snapshot",
        passwordHash: "hash",
      }, 5_000);
      const adapter: ToolAdapter = {
        definition: {
          id: "echo",
          name: "Echo",
          description: "Echo",
          recoverySafety: "idempotent_by_execution_id",
          inputSchema: { type: "object" },
          enabled: true,
        },
        execute: () => Promise.resolve({ recovered: true }),
      };
      let configuredMicros = 777;
      let currentConfigReads = 0;
      const controls = {
        admit: () => Promise.resolve(),
        billingSnapshot: (execution: { toolId: string }) => {
          currentConfigReads++;
          return billingSnapshot(execution.toolId, configuredMicros);
        },
        reserve: async (execution: Awaited<ReturnType<typeof store.getExecution>>) => {
          const value = execution!;
          await repo.ensureIdempotentReservation({
            userId: value.ownerId,
            usageRunId: `tool:${value.id}`,
            model: value.billingSnapshot!.model,
            provider: value.billingSnapshot!.provider,
            reservedMicros: value.billingSnapshot!.reservedMicros,
            recoveryOwner: "tool",
          });
        },
        reconcileReservation: async (
          execution: Awaited<ReturnType<typeof store.getExecution>>,
        ) => {
          const value = execution!;
          await repo.ensureIdempotentReservation({
            userId: value.ownerId,
            usageRunId: `tool:${value.id}`,
            model: value.billingSnapshot!.model,
            provider: value.billingSnapshot!.provider,
            reservedMicros: value.billingSnapshot!.reservedMicros,
            recoveryOwner: "tool",
          });
        },
        settle: (execution: Awaited<ReturnType<typeof store.getExecution>>) =>
          repo.settle(
            `tool:${execution!.id}`,
            execution!.billingSnapshot!.reservedMicros,
            0,
            0,
            0,
          ).then(() => undefined),
        refund: (execution: Awaited<ReturnType<typeof store.getExecution>>, error?: string) =>
          repo.refund(`tool:${execution!.id}`, error).then((run) => run !== undefined),
      };
      const first = new ToolExecutionService(store, [adapter], controls);
      await first.setPolicy({ toolId: "echo", allowed: true, actorId: user.id });
      const captured = billingSnapshot("echo", configuredMicros);

      const settleRequest = await first.request(user.id, "echo", {});
      await store.transitionExecution(settleRequest.id, ["pending_approval"], {
        status: "queued_pending_reservation",
        approvedAt: new Date().toISOString(),
        approvedBy: user.id,
        billingSnapshot: captured,
      });
      await controls.reserve(await store.getExecution(settleRequest.id));

      const refundRequest = await first.request(user.id, "echo", {});
      await store.transitionExecution(refundRequest.id, ["pending_approval"], {
        status: "failed_pending_refund",
        approvedAt: new Date().toISOString(),
        approvedBy: user.id,
        billingSnapshot: captured,
        error: { code: "tool_execution_failed", message: "Tool execution failed" },
      });
      await controls.reserve(await store.getExecution(refundRequest.id));

      configuredMicros = 2_222;
      const readsBeforeRestart = currentConfigReads;
      const restarted = new ToolExecutionService(store, [adapter], controls);
      await restarted.recover();
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await restarted.get(user.id, settleRequest.id)).status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assertEquals(currentConfigReads, readsBeforeRestart);
      assertEquals((await restarted.get(user.id, settleRequest.id)).status, "succeeded");
      assertEquals((await restarted.get(user.id, refundRequest.id)).status, "failed");
      const runs = await sql<{ id: string; reserved: string; cost: string }[]>`
        SELECT id,reserved_micros::text reserved,cost_micros::text cost FROM usage_runs
        WHERE id IN (${`tool:${settleRequest.id}`},${`tool:${refundRequest.id}`}) ORDER BY id`;
      assertEquals(runs.every((run) => run.reserved === "777"), true);
      assertEquals(
        runs.find((run) => run.id === `tool:${settleRequest.id}`)?.cost,
        "777",
      );
      const refundLedger = await sql<{ kind: string; amount: string }[]>`
        SELECT kind,amount_micros::text amount FROM ledger_entries
        WHERE usage_run_id=${`tool:${refundRequest.id}`} ORDER BY sequence`;
      assertEquals([...refundLedger], [
        { kind: "reserve", amount: "-777" },
        { kind: "refund", amount: "777" },
      ]);

      for (
        const invalid of [
          { ...captured, reservedMicros: Number.NaN },
          { ...captured, reservedMicros: -1 },
          { ...captured, provider: "" },
        ]
      ) {
        const rejected = await assertRejects(() =>
          repo.ensureIdempotentReservation({
            userId: user.id,
            usageRunId: `tool:${crypto.randomUUID()}`,
            recoveryOwner: "tool",
            ...invalid,
          })
        );
        assertEquals((rejected as { code?: string }).code, "validation_error");
      }
    } finally {
      await store.close();
      await repo.close();
      await sql.end();
    }
  },
});
