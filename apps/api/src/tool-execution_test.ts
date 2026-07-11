import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  MemoryToolExecutionStore,
  type ToolAdapter,
  ToolExecutionError,
  ToolExecutionService,
} from "./tool-execution.ts";

const waitFor = async (
  service: ToolExecutionService,
  ownerId: string,
  id: string,
  status: string,
) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await service.get(ownerId, id);
    if (value.status === status) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Execution did not reach ${status}`);
};

function serviceWith(adapter: ToolAdapter) {
  const store = new MemoryToolExecutionStore();
  return { store, service: new ToolExecutionService(store, [adapter]) };
}

const echoAdapter: ToolAdapter = {
  definition: {
    id: "echo",
    name: "Echo",
    description: "Echo test",
    inputSchema: { type: "object" },
    enabled: true,
  },
  execute: (input) => Promise.resolve({ input }),
};

Deno.test("tools fail closed until allowlisted and require user approval before dispatch", async () => {
  let calls = 0;
  const { service } = serviceWith({
    ...echoAdapter,
    execute: (input) => {
      calls++;
      return Promise.resolve({ input });
    },
  });
  await assertRejects(
    () => service.request("user", "echo", { ok: true }),
    ToolExecutionError,
    "unavailable",
  );
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", { ok: true });
  assertEquals(requested.status, "pending_approval");
  assertEquals(calls, 0);
  const approved = await service.approve("user", requested.id);
  assertEquals(approved.status, "queued");
  const complete = await waitFor(service, "user", requested.id, "succeeded");
  assertEquals(complete.result, { input: { ok: true } });
  assertEquals(calls, 1);
  await assertRejects(
    () => service.approve("user", requested.id),
    ToolExecutionError,
    "current state",
  );
});

Deno.test("tool cancellation aborts active work and cannot be overwritten by late completion", async () => {
  let release!: () => void;
  let observedAbort = false;
  const { service } = serviceWith({
    ...echoAdapter,
    execute: async (_input, { signal }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
      return { tooLate: true };
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const execution = await service.request("user", "echo", {});
  await service.approve("user", execution.id);
  await waitFor(service, "user", execution.id, "running");
  const cancelled = await service.cancel("user", execution.id);
  assertEquals(cancelled.status, "cancelled");
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(observedAbort, true);
  assertEquals((await service.get("user", execution.id)).status, "cancelled");
});

Deno.test("policy revocation between request and approval blocks execution", async () => {
  const { service } = serviceWith(echoAdapter);
  const policy = await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const execution = await service.request("user", "echo", {});
  await service.setPolicy({
    toolId: "echo",
    allowed: false,
    expectedVersion: policy.version,
    actorId: "admin",
  });
  await assertRejects(
    () => service.approve("user", execution.id),
    ToolExecutionError,
    "no longer allowlisted",
  );
  assertEquals((await service.get("user", execution.id)).status, "pending_approval");
});

Deno.test("tool executions are owner-isolated and policy writes use optimistic versions", async () => {
  const { service } = serviceWith(echoAdapter);
  const policy = await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const execution = await service.request("owner-a", "echo", {});
  await assertRejects(() => service.get("owner-b", execution.id), ToolExecutionError, "not found");
  await assertRejects(
    () =>
      service.setPolicy({
        toolId: "echo",
        allowed: false,
        expectedVersion: policy.version - 1,
        actorId: "admin",
      }),
    ToolExecutionError,
    "another session",
  );
});

Deno.test("policy revision is fenced immediately before dispatch and reserved credit is refunded", async () => {
  class DispatchFenceStore extends MemoryToolExecutionStore {
    reads = 0;
    release!: () => void;
    override async getPolicy(toolId: string) {
      this.reads++;
      if (this.reads === 3) await new Promise<void>((resolve) => this.release = resolve);
      return await super.getPolicy(toolId);
    }
  }
  const store = new DispatchFenceStore();
  let calls = 0;
  const billing: string[] = [];
  const service = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: () => {
      calls++;
      return Promise.resolve({});
    },
  }], {
    reserve: () => {
      billing.push("reserve");
      return Promise.resolve();
    },
    settle: () => {
      billing.push("settle");
      return Promise.resolve();
    },
    refund: () => {
      billing.push("refund");
      return Promise.resolve();
    },
  });
  const initial = await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const execution = await service.request("user", "echo", {});
  await service.approve("user", execution.id);
  await service.setPolicy({
    toolId: "echo",
    allowed: false,
    expectedVersion: initial.version,
    actorId: "admin",
  });
  store.release();
  await waitFor(service, "user", execution.id, "failed");
  assertEquals(calls, 0);
  assertEquals(billing, ["reserve", "refund"]);
});

Deno.test("successful upstream result survives settlement failure and repairs without refund", async () => {
  const store = new MemoryToolExecutionStore();
  let settlementAttempts = 0;
  let refunds = 0;
  const service = new ToolExecutionService(store, [echoAdapter], {
    reserve: () => Promise.resolve(),
    settle: () => {
      if (++settlementAttempts === 1) return Promise.reject(new Error("ledger unavailable"));
      return Promise.resolve();
    },
    refund: () => {
      refunds++;
      return Promise.resolve();
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", { durable: true });
  await service.approve("user", requested.id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = await store.getExecution(requested.id, "user");
  assertEquals(stored?.status, "succeeded_pending_settlement");
  assertEquals(stored?.result, { input: { durable: true } });
  assertEquals(refunds, 0);
  assertEquals((await service.get("user", requested.id)).status, "succeeded");
  assertEquals(settlementAttempts, 2);
});

Deno.test("startup recovery completes a persisted approval reservation before dispatch", async () => {
  const store = new MemoryToolExecutionStore();
  let reserves = 0;
  let calls = 0;
  const service = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: async () => {
      calls++;
      return { recovered: true };
    },
  }], {
    reserve: () => {
      reserves++;
      return Promise.resolve();
    },
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(),
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "queued_pending_reservation",
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
  });
  assertEquals(await service.recover(), 2);
  await waitFor(service, "user", requested.id, "succeeded");
  assertEquals(reserves, 1);
  assertEquals(calls, 1);
});
