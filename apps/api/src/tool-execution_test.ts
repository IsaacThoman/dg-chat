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
  for (let attempt = 0; attempt < 100 && !store.release; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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
    execute: () => {
      calls++;
      return Promise.resolve({ recovered: true });
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

Deno.test("lost reservation acknowledgement preserves approval for recovery", async () => {
  const store = new MemoryToolExecutionStore();
  let attempts = 0;
  const service = new ToolExecutionService(store, [echoAdapter], {
    reserve: () => {
      if (++attempts === 1) return Promise.reject(new Error("connection lost after commit"));
      return Promise.resolve();
    },
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(),
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await assertRejects(() => service.approve("user", requested.id), Error, "connection lost");
  assertEquals(
    (await service.get("user", requested.id)).status,
    "queued_pending_reservation",
  );
  await service.recover();
  await waitFor(service, "user", requested.id, "succeeded");
  assertEquals(attempts, 2);
});

Deno.test("queued cancellation refunds its reservation", async () => {
  const store = new MemoryToolExecutionStore();
  let refunds = 0;
  const service = new ToolExecutionService(store, [echoAdapter], {
    reserve: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => {
      refunds++;
      return Promise.resolve();
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "queued",
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
  });
  assertEquals((await service.cancel("user", requested.id)).status, "cancelled");
  assertEquals(refunds, 1);
});

Deno.test("recovery refunds when cancellation wins after reservation", async () => {
  const store = new MemoryToolExecutionStore();
  let release!: () => void;
  let reserved!: () => void;
  let refunds = 0;
  const reservationStarted = new Promise<void>((resolve) => reserved = resolve);
  const reservationRelease = new Promise<void>((resolve) => release = resolve);
  const service = new ToolExecutionService(store, [echoAdapter], {
    reserve: async () => {
      reserved();
      await reservationRelease;
    },
    settle: () => Promise.resolve(),
    refund: () => {
      refunds++;
      return Promise.resolve();
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "queued_pending_reservation",
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
  });
  const recovery = service.recover();
  await reservationStarted;
  const cancellation = service.cancel("user", requested.id);
  release();
  await cancellation;
  await recovery;
  assertEquals((await service.get("user", requested.id)).status, "cancelled");
  assertEquals(refunds, 2);
});

Deno.test("concurrent recoverers do not refund the winning shared reservation", async () => {
  const store = new MemoryToolExecutionStore();
  let arrivals = 0;
  let release!: () => void;
  let refunds = 0;
  const barrier = new Promise<void>((resolve) => release = resolve);
  const controls = {
    reserve: async () => {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
    },
    settle: () => Promise.resolve(),
    refund: () => {
      refunds++;
      return Promise.resolve();
    },
  };
  const first = new ToolExecutionService(store, [echoAdapter], controls);
  const second = new ToolExecutionService(store, [echoAdapter], controls);
  await first.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await first.request("user", "echo", {});
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "queued_pending_reservation",
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
  });
  await Promise.all([first.recover(), second.recover()]);
  await waitFor(first, "user", requested.id, "succeeded");
  assertEquals(refunds, 0);
});

Deno.test("recovery finalizes cancellation after refund committed before tool transition", async () => {
  const store = new MemoryToolExecutionStore();
  let reserves = 0;
  let refunds = 0;
  const service = new ToolExecutionService(store, [echoAdapter], {
    reserve: () => {
      reserves++;
      return Promise.resolve();
    },
    settle: () => Promise.resolve(),
    refund: () => {
      refunds++;
      return Promise.resolve(true);
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "queued_pending_reservation",
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
    cancellationRequestedAt: new Date().toISOString(),
  });
  await service.recover();
  assertEquals((await service.get("user", requested.id)).status, "cancelled");
  assertEquals(refunds, 1);
  assertEquals(reserves, 0);
});

Deno.test("approve does not refund when a concurrent recoverer advances its reservation", async () => {
  const store = new MemoryToolExecutionStore();
  let reserveCalls = 0;
  let firstReserveStarted!: () => void;
  let releaseFirst!: () => void;
  let refunds = 0;
  const started = new Promise<void>((resolve) => firstReserveStarted = resolve);
  const release = new Promise<void>((resolve) => releaseFirst = resolve);
  const controls = {
    reserve: async () => {
      reserveCalls++;
      if (reserveCalls === 1) {
        firstReserveStarted();
        await release;
      }
    },
    settle: () => Promise.resolve(),
    refund: () => {
      refunds++;
      return Promise.resolve(true);
    },
  };
  const approver = new ToolExecutionService(store, [echoAdapter], controls);
  const recoverer = new ToolExecutionService(store, [echoAdapter], controls);
  await approver.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await approver.request("user", "echo", {});
  const approval = approver.approve("user", requested.id);
  await started;
  const recovery = recoverer.recover();
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await store.getExecution(requested.id, "user");
    if (current?.status !== "queued_pending_reservation") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  releaseFirst();
  const approved = await approval;
  await recovery;
  assertEquals(["queued", "running", "succeeded"].includes(approved.status), true);
  await waitFor(approver, "user", requested.id, "succeeded");
  assertEquals(refunds, 0);
});

Deno.test("approve finalizes a concurrent cancellation marker without dispatch", async () => {
  const store = new MemoryToolExecutionStore();
  let adapterCalls = 0;
  let reserveStarted!: () => void;
  let releaseReserve!: () => void;
  let cancelRefundStarted!: () => void;
  let releaseCancelRefund!: () => void;
  let refundCalls = 0;
  const reserveAtBarrier = new Promise<void>((resolve) => reserveStarted = resolve);
  const reserveRelease = new Promise<void>((resolve) => releaseReserve = resolve);
  const refundAtBarrier = new Promise<void>((resolve) => cancelRefundStarted = resolve);
  const refundRelease = new Promise<void>((resolve) => releaseCancelRefund = resolve);
  const service = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: () => {
      adapterCalls++;
      return Promise.resolve({ forbidden: true });
    },
  }], {
    reserve: async () => {
      reserveStarted();
      await reserveRelease;
    },
    settle: () => Promise.resolve(),
    refund: async () => {
      refundCalls++;
      if (refundCalls === 1) {
        cancelRefundStarted();
        await refundRelease;
      }
      return true;
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  const approval = service.approve("user", requested.id);
  await reserveAtBarrier;
  const cancellation = service.cancel("user", requested.id);
  await refundAtBarrier;
  releaseReserve();
  await assertRejects(() => approval, ToolExecutionError, "cancelled");
  releaseCancelRefund();
  assertEquals((await cancellation).status, "cancelled");
  await service.recover();
  assertEquals((await service.get("user", requested.id)).status, "cancelled");
  assertEquals(adapterCalls, 0);
});

Deno.test("fresh-service recovery finalizes a crashed queued cancellation marker", async () => {
  const store = new MemoryToolExecutionStore();
  let adapterCalls = 0;
  let refunds = 0;
  const adapter: ToolAdapter = {
    ...echoAdapter,
    execute: () => {
      adapterCalls++;
      return Promise.resolve({ forbidden: true });
    },
  };
  const service = new ToolExecutionService(store, [adapter], {
    reserve: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => {
      refunds++;
      return Promise.resolve(true);
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "queued",
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
    cancellationRequestedAt: new Date().toISOString(),
  });
  // Simulates a process crash after pending->queued but before refund/final cancellation.
  const restarted = new ToolExecutionService(store, [adapter], service.controls);
  await restarted.recover();
  assertEquals((await restarted.get("user", requested.id)).status, "cancelled");
  assertEquals(refunds, 1);
  assertEquals(adapterCalls, 0);
});

Deno.test("pre-debit approval failure finalizes a concurrent cancellation marker", async () => {
  const store = new MemoryToolExecutionStore();
  let reserveCalls = 0;
  let firstReserveStarted!: () => void;
  let releaseFirstReserve!: () => void;
  const started = new Promise<void>((resolve) => firstReserveStarted = resolve);
  const release = new Promise<void>((resolve) => releaseFirstReserve = resolve);
  const denial = () =>
    Object.assign(new Error("insufficient credit"), {
      code: "insufficient_credit",
    });
  const service = new ToolExecutionService(store, [echoAdapter], {
    reserve: async () => {
      if (++reserveCalls === 1) {
        firstReserveStarted();
        await release;
      }
      throw denial();
    },
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(false),
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  const approval = service.approve("user", requested.id);
  await started;
  await assertRejects(() => service.cancel("user", requested.id), Error, "insufficient credit");
  releaseFirstReserve();
  await assertRejects(() => approval, Error, "insufficient credit");
  assertEquals((await service.get("user", requested.id)).status, "cancelled");
});
