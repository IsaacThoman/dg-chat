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
