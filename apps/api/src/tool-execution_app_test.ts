import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import {
  MemoryToolExecutionStore,
  type ToolAdapter,
  ToolExecutionService,
} from "./tool-execution.ts";
import { createApp } from "./app.ts";

function cookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

// deno-lint-ignore no-explicit-any
const json = (response: Response): Promise<any> => response.json();

Deno.test("tool API enforces admin allowlisting, explicit approval, status, cancel, and audit", async () => {
  let release!: () => void;
  const adapter: ToolAdapter = {
    definition: {
      id: "test_tool",
      name: "Test tool",
      description: "Adapter for API tests",
      recoverySafety: "idempotent_by_execution_id",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string", minLength: 1 } },
      },
      enabled: true,
    },
    execute: async (_input, { signal }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: true };
    },
  };
  const tools = new ToolExecutionService(new MemoryToolExecutionStore(), [adapter]);
  const { app } = createApp({ setupToken: "tools-setup", toolExecutionService: tools });
  assertEquals(
    (await app.request("/api/setup/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-setup-token": "tools-setup" },
      body: JSON.stringify({
        email: "tools-admin@example.com",
        name: "Tools Admin",
        password: "correct horse battery staple",
      }),
    })).status,
    201,
  );
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "tools-admin@example.com",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };

  assertEquals((await json(await app.request("/api/tools", { headers }))).data, []);
  const denied = await app.request("/api/tools/executions", {
    method: "POST",
    headers,
    body: JSON.stringify({ toolId: "test_tool", input: {} }),
  });
  assertEquals(denied.status, 403);
  assertEquals((await json(denied)).error.code, "tool_not_allowed");

  const policyResponse = await app.request("/api/admin/tools/test_tool/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      allowed: true,
      allowedDomains: ["search.example.com"],
      allowPrivateNetwork: false,
      expectedVersion: 0,
    }),
  });
  assertEquals(policyResponse.status, 200);
  assertEquals((await json(policyResponse)).version, 1);
  assertEquals((await json(await app.request("/api/tools", { headers }))).data[0].id, "test_tool");

  const request = await app.request("/api/tools/executions", {
    method: "POST",
    headers,
    body: JSON.stringify({ toolId: "test_tool", input: { query: "hello" } }),
  });
  assertEquals(request.status, 201);
  const execution = await json(request);
  assertEquals(execution.status, "pending_approval");
  const approval = await app.request(`/api/tools/executions/${execution.id}/approve`, {
    method: "POST",
    headers,
  });
  assertEquals(approval.status, 202);
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await json(
      await app.request(`/api/tools/executions/${execution.id}`, { headers }),
    );
    if (state.status === "running") {
      assertEquals("claimToken" in state, false);
      assertEquals("claimExpiresAt" in state, false);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const cancel = await app.request(`/api/tools/executions/${execution.id}`, {
    method: "DELETE",
    headers,
  });
  assertEquals(cancel.status, 200);
  assertEquals((await json(cancel)).status, "cancelled");
  release();
  const audit = await json(
    await app.request("/api/admin/audit?targetType=tool_execution", {
      headers,
    }),
  );
  assertEquals(audit.data.map((event: { action: string }) => event.action).sort(), [
    "tool.execution.approved",
    "tool.execution.cancelled",
    "tool.execution.requested",
  ]);
});

Deno.test("approved tools reserve and settle credit and enforce a per-user tool rate limit", async () => {
  const adapter: ToolAdapter = {
    definition: {
      id: "metered_tool",
      name: "Metered tool",
      description: "Metered adapter",
      recoverySafety: "idempotent_by_execution_id",
      inputSchema: { type: "object" },
      enabled: true,
    },
    execute: () => Promise.resolve({ ok: true }),
  };
  const { app } = createApp({
    setupToken: "metered-setup",
    toolAdapters: [adapter],
    toolReserveMicros: 1_000,
    toolRateLimitPerMinute: 1,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "metered-setup" },
    body: JSON.stringify({
      email: "metered-admin@example.com",
      name: "Metered Admin",
      password: "correct horse battery staple",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "metered-admin@example.com",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  await app.request("/api/admin/tools/metered_tool/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({ allowed: true, expectedVersion: 0 }),
  });
  const create = async () =>
    await json(
      await app.request("/api/tools/executions", {
        method: "POST",
        headers,
        body: JSON.stringify({ toolId: "metered_tool", input: {} }),
      }),
    );
  const first = await create();
  assertEquals(
    (await app.request(`/api/tools/executions/${first.id}/approve`, { method: "POST", headers }))
      .status,
    202,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await json(await app.request(`/api/tools/executions/${first.id}`, { headers }));
    if (current.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const usage = await json(await app.request("/api/usage", { headers }));
  assertEquals(usage.spentMicros, 1_000);
  const second = await create();
  const limited = await app.request(`/api/tools/executions/${second.id}/approve`, {
    method: "POST",
    headers,
  });
  assertEquals(limited.status, 429);
  assertEquals((await json(limited)).error.code, "rate_limited");
  assertEquals(
    (await json(await app.request(`/api/tools/executions/${second.id}`, { headers }))).status,
    "pending_approval",
  );
});

Deno.test("tool API categorically normalizes legacy persisted exception text", async () => {
  const adapter: ToolAdapter = {
    definition: {
      id: "legacy_tool",
      name: "Legacy tool",
      description: "Legacy failure fixture",
      recoverySafety: "read_only",
      inputSchema: { type: "object" },
      enabled: true,
    },
    execute: () => Promise.resolve({ ok: true }),
  };
  const store = new MemoryToolExecutionStore();
  const tools = new ToolExecutionService(store, [adapter]);
  const { app } = createApp({ setupToken: "legacy-tool-setup", toolExecutionService: tools });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "legacy-tool-setup" },
    body: JSON.stringify({
      email: "legacy-tool-admin@example.com",
      name: "Legacy Tool Admin",
      password: "correct horse battery staple",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "legacy-tool-admin@example.com",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  await tools.setPolicy({ toolId: "legacy_tool", allowed: true, actorId: "admin" });
  const requested = await json(
    await app.request("/api/tools/executions", {
      method: "POST",
      headers,
      body: JSON.stringify({ toolId: "legacy_tool", input: {} }),
    }),
  );
  const secret = "postgres://operator:password@metadata.internal/private";
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "failed",
    error: { code: "request_failed", message: secret },
  });

  const response = await app.request(`/api/tools/executions/${requested.id}`, { headers });
  const body = await json(response);
  assertEquals(response.status, 200);
  assertEquals(body.error, {
    code: "tool_upstream_unavailable",
    message: "Tool service is unavailable",
  });
  assertEquals(JSON.stringify(body).includes(secret), false);
});
