import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  MemoryToolExecutionStore,
  type ToolAdapter,
  ToolExecutionError,
  ToolExecutionService,
  type ToolExecutionStore,
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
    recoverySafety: "idempotent_by_execution_id",
    inputSchema: { type: "object", additionalProperties: true },
    enabled: true,
  },
  execute: (input) => Promise.resolve({ input }),
};
const persistedBillingSnapshot = {
  reservedMicros: 1,
  provider: "tool-test-memory",
  model: "tool/echo",
};

Deno.test("metered tool controls require a distinct internal reservation reconciler", () => {
  const incomplete = {
    reserve: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(),
  } as unknown as NonNullable<ConstructorParameters<typeof ToolExecutionService>[2]>;
  assertThrows(
    () => new ToolExecutionService(new MemoryToolExecutionStore(), [echoAdapter], incomplete),
    TypeError,
    "require internal reservation reconciliation",
  );
});

Deno.test("persistent tool stores require complete admission and billing controls", () => {
  const persistentStore = {} as ToolExecutionStore;
  assertThrows(
    () => new ToolExecutionService(persistentStore, [echoAdapter]),
    TypeError,
    "require accounting controls",
  );
  const complete = {
    admit: () => Promise.resolve(),
    billingSnapshot: () => persistedBillingSnapshot,
    reserve: () => Promise.resolve(),
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(),
  };
  assertThrows(
    () =>
      new ToolExecutionService(persistentStore, [echoAdapter], {
        ...complete,
        admit: undefined,
      }),
    TypeError,
    "require pre-reservation admission",
  );
  assertThrows(
    () =>
      new ToolExecutionService(persistentStore, [echoAdapter], {
        ...complete,
        billingSnapshot: undefined,
      }),
    TypeError,
    "require an immutable billing snapshot",
  );
});

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

Deno.test("registered JSON Schemas reject unexpected and malformed nested tool input", async () => {
  const adapter: ToolAdapter = {
    definition: {
      id: "nested",
      name: "Nested input",
      description: "Nested schema test",
      recoverySafety: "idempotent_by_execution_id",
      enabled: true,
      inputSchema: {
        type: "object",
        required: ["request"],
        properties: {
          request: {
            type: "object",
            required: ["mode", "items"],
            properties: {
              mode: { type: "string", enum: ["brief", "full"] },
              items: {
                type: "array",
                minItems: 1,
                maxItems: 2,
                items: {
                  type: "object",
                  required: ["label"],
                  properties: { label: { type: "string", minLength: 1, maxLength: 20 } },
                },
              },
            },
          },
        },
      },
    },
    execute: () => Promise.resolve({ ok: true }),
  };
  const { service } = serviceWith(adapter);
  await service.setPolicy({ toolId: "nested", allowed: true, actorId: "admin" });

  const definition = service.listDefinitions()[0];
  assertEquals(definition.inputSchema.additionalProperties, false);
  const requestSchema = (definition.inputSchema.properties as Record<string, unknown>)
    .request as Record<string, unknown>;
  assertEquals(requestSchema.additionalProperties, false);
  const itemsSchema = (requestSchema.properties as Record<string, unknown>).items as Record<
    string,
    unknown
  >;
  assertEquals((itemsSchema.items as Record<string, unknown>).additionalProperties, false);

  const valid = { request: { mode: "brief", items: [{ label: "one" }] } };
  assertEquals((await service.request("user", "nested", valid)).status, "pending_approval");
  const malformed = [
    { ...valid, unexpected: true },
    { request: { ...valid.request, secretOverride: "not declared" } },
    { request: { mode: "verbose", items: [{ label: "one" }] } },
    { request: { mode: "brief", items: [{ label: "one", nestedExtra: true }] } },
    { request: { mode: "brief", items: [{ label: 42 }] } },
    { request: { mode: "brief", items: [] } },
  ];
  for (const input of malformed) {
    const error = await assertRejects(
      () => service.request("user", "nested", input),
      ToolExecutionError,
    );
    assertEquals(error.code, "invalid_input");
    assertEquals(error.status, 422);
  }
  const hostileJson = {};
  Object.defineProperty(hostileJson, "toJSON", {
    value: () => undefined,
    enumerable: false,
  });
  const hostileError = await assertRejects(
    () => service.request("user", "nested", hostileJson),
    ToolExecutionError,
  );
  assertEquals(hostileError.code, "invalid_input");
});

Deno.test("tool registry rejects unsupported schemas instead of silently under-validating", () => {
  assertThrows(
    () =>
      serviceWith({
        ...echoAdapter,
        definition: {
          ...echoAdapter.definition,
          inputSchema: {
            type: "object",
            additionalProperties: true,
            $ref: "https://attacker.invalid/schema",
          },
        },
      }),
    Error,
    "Tool schema is invalid or uses unsupported keywords",
  );
  assertThrows(
    () =>
      serviceWith({
        ...echoAdapter,
        definition: {
          ...echoAdapter.definition,
          recoverySafety: undefined,
        } as unknown as ToolAdapter["definition"],
      }),
    Error,
    "safe recovery semantics",
  );
});

Deno.test("Draft 7 composed schemas preserve sibling semantics and require explicit closure", async () => {
  const composed: ToolAdapter = {
    ...echoAdapter,
    definition: {
      ...echoAdapter.definition,
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          left: { type: "string" },
          right: { type: "integer" },
        },
        allOf: [
          {
            type: "object",
            required: ["left"],
            properties: { left: { type: "string", minLength: 1 } },
          },
          {
            type: "object",
            required: ["right"],
            properties: { right: { type: "integer", minimum: 1 } },
          },
        ],
      },
    },
  };
  const { service } = serviceWith(composed);
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  assertEquals(
    (await service.request("user", "echo", { left: "ok", right: 2 })).status,
    "pending_approval",
  );
  await assertRejects(
    () => service.request("user", "echo", { left: "ok", right: 2, extra: true }),
    ToolExecutionError,
  );
  for (
    const inputSchema of [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: { kind: { type: "string" }, value: { type: "string" } },
        anyOf: [
          { type: "object", required: ["kind"], properties: { kind: { const: "a" } } },
          { type: "object", required: ["kind"], properties: { kind: { const: "b" } } },
        ],
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: { kind: { type: "string" }, value: { type: "string" } },
        if: { type: "object", required: ["kind"], properties: { kind: { const: "a" } } },
        then: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string", minLength: 1 } },
        },
        else: { type: "object", properties: {} },
      },
    ]
  ) {
    const candidate = serviceWith({
      ...echoAdapter,
      definition: { ...echoAdapter.definition, inputSchema },
    }).service;
    await candidate.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
    assertEquals(
      (await candidate.request("user", "echo", { kind: "a", value: "ok" })).status,
      "pending_approval",
    );
  }
  assertThrows(
    () =>
      serviceWith({
        ...composed,
        definition: {
          ...composed.definition,
          inputSchema: {
            type: "object",
            allOf: [{ type: "object", properties: { left: { type: "string" } } }],
          },
        },
      }),
    Error,
    "must declare additionalProperties explicitly",
  );
  assertThrows(
    () =>
      serviceWith({
        ...echoAdapter,
        definition: {
          ...echoAdapter.definition,
          inputSchema: {
            $ref: "#/definitions/payload",
            definitions: {
              payload: { type: "object", properties: { value: { type: "string" } } },
            },
          },
        },
      }),
    Error,
    "reusable object definitions must declare additionalProperties explicitly",
  );
});

Deno.test("Draft 7 common formats are enforced and other dialects fail closed", async () => {
  const formatted: ToolAdapter = {
    ...echoAdapter,
    definition: {
      ...echoAdapter.definition,
      inputSchema: {
        type: "object",
        required: ["email", "createdAt"],
        properties: {
          email: { type: "string", format: "email" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
  };
  const { service } = serviceWith(formatted);
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  await service.request("user", "echo", {
    email: "user@example.com",
    createdAt: "2026-07-16T12:00:00Z",
  });
  await assertRejects(
    () => service.request("user", "echo", { email: "not-an-email", createdAt: "yesterday" }),
    ToolExecutionError,
  );
  assertThrows(
    () =>
      serviceWith({
        ...formatted,
        definition: {
          ...formatted.definition,
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
          },
        },
      }),
    Error,
    "dialect must be JSON Schema Draft 7",
  );
});

Deno.test("tool JSON limits use UTF-8 bytes and recheck normalized schemas", async () => {
  const textAdapter: ToolAdapter = {
    ...echoAdapter,
    definition: { ...echoAdapter.definition, inputSchema: { type: "string" } },
  };
  const { service } = serviceWith(textAdapter);
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const multibyte = "😀".repeat(70_000);
  const error = await assertRejects(
    () => service.request("user", "echo", multibyte),
    ToolExecutionError,
  );
  assertEquals(error.code, "invalid_input");
  const objectService = serviceWith(echoAdapter).service;
  await objectService.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const wideKeyError = await assertRejects(
    () => objectService.request("user", "echo", { ["😀".repeat(70)]: true }),
    ToolExecutionError,
  );
  assertEquals(wideKeyError.code, "invalid_input");
  assertThrows(
    () =>
      serviceWith({
        ...echoAdapter,
        definition: {
          ...echoAdapter.definition,
          inputSchema: { type: "object", description: multibyte },
        },
      }),
    Error,
    "size limit",
  );
});

Deno.test("recovery revalidates durable tool input before adapter dispatch", async () => {
  let adapterCalls = 0;
  const adapter: ToolAdapter = {
    ...echoAdapter,
    definition: {
      ...echoAdapter.definition,
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string", minLength: 1 } },
      },
    },
    execute: () => {
      adapterCalls++;
      return Promise.resolve({ forbidden: true });
    },
  };
  const store = new MemoryToolExecutionStore();
  const service = new ToolExecutionService(store, [adapter]);
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const now = new Date().toISOString();
  const imported = await store.createExecution({
    id: crypto.randomUUID(),
    ownerId: "user",
    toolId: "echo",
    input: { query: "valid", undeclaredCredential: "must-not-dispatch" },
    status: "queued",
    result: null,
    error: null,
    approvedAt: now,
    approvedBy: "user",
    cancellationRequestedAt: null,
    billingSnapshot: persistedBillingSnapshot,
    createdAt: now,
    updatedAt: now,
  });
  await service.recover();
  const failed = await waitFor(service, "user", imported.id, "failed");
  assertEquals(adapterCalls, 0);
  assertEquals(failed.error, {
    code: "tool_invalid_request",
    message: "Tool request was rejected",
  });
});

Deno.test("tool inputs and results are snapshotted without invoking accessors or Proxy traps", async () => {
  let inputGetterCalls = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, "query", {
    enumerable: true,
    get: () => {
      inputGetterCalls++;
      return "secret";
    },
  });
  const { service: inputService } = serviceWith(echoAdapter);
  await inputService.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  await assertRejects(
    () => inputService.request("user", "echo", accessorInput),
    ToolExecutionError,
  );
  assertEquals(inputGetterCalls, 0);

  let resultGetterCalls = 0;
  let refunds = 0;
  const store = new MemoryToolExecutionStore();
  const resultService = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: () => {
      const result = {};
      Object.defineProperty(result, "credential", {
        enumerable: true,
        get: () => {
          resultGetterCalls++;
          return "must-not-be-read";
        },
      });
      return Promise.resolve(result);
    },
  }], {
    reserve: () => Promise.resolve(),
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => {
      refunds++;
      return Promise.resolve();
    },
  });
  await resultService.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await resultService.request("user", "echo", {});
  await resultService.approve("user", requested.id);
  const failed = await waitFor(resultService, "user", requested.id, "failed");
  assertEquals(resultGetterCalls, 0);
  assertEquals(refunds, 1);
  assertEquals(failed.result, null);

  let proxyTraps = 0;
  const proxy = new Proxy({}, {
    ownKeys: () => {
      proxyTraps++;
      throw new Error("proxy trap secret");
    },
  });
  await assertRejects(() => inputService.request("user", "echo", proxy), ToolExecutionError);
  assertEquals(proxyTraps, 0);
});

Deno.test("recovered tool input enforces the same UTF-8 byte cap as new requests", async () => {
  let calls = 0;
  const store = new MemoryToolExecutionStore();
  const service = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: () => {
      calls++;
      return Promise.resolve({});
    },
  }]);
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const now = new Date().toISOString();
  const imported = await store.createExecution({
    id: crypto.randomUUID(),
    ownerId: "user",
    toolId: "echo",
    input: "😀".repeat(70_000),
    status: "queued",
    result: null,
    error: null,
    approvedAt: now,
    approvedBy: "user",
    cancellationRequestedAt: null,
    billingSnapshot: persistedBillingSnapshot,
    createdAt: now,
    updatedAt: now,
  });
  await service.recover();
  const failed = await waitFor(service, "user", imported.id, "failed");
  assertEquals(calls, 0);
  assertEquals(failed.error?.code, "tool_invalid_request");
});

Deno.test("adapter failures are categorical and never persist or refund secret-bearing details", async () => {
  const secrets = ["Bearer upstream-super-secret", "postgres://admin:hidden@db/internal"];
  const hostileError = new Error(`hostile adapter included ${secrets[0]}`);
  Object.defineProperties(hostileError, {
    name: {
      get: () => {
        throw new Error(secrets[1]);
      },
    },
    code: {
      get: () => {
        throw new Error(secrets[1]);
      },
    },
  });
  let hostileProxyTraps = 0;
  const hostileProxy = new Proxy(new Error(`proxy carried ${secrets[0]}`), {
    getPrototypeOf: () => {
      hostileProxyTraps++;
      throw new Error(secrets[1]);
    },
    get: () => {
      hostileProxyTraps++;
      throw new Error(secrets[1]);
    },
  });
  const cases = [
    {
      expected: {
        code: "tool_execution_failed",
        message: "Tool execution failed",
      },
      error: new Error(`adapter crashed with ${secrets[0]}`),
    },
    {
      expected: {
        code: "tool_invalid_response",
        message: "Tool service returned an invalid response",
      },
      error: Object.assign(new Error(`malformed body included ${secrets[1]}`), {
        name: "WebSearchError",
        code: "invalid_response",
      }),
    },
    {
      expected: {
        code: "tool_execution_failed",
        message: "Tool execution failed",
      },
      error: hostileError,
    },
    {
      expected: {
        code: "tool_execution_failed",
        message: "Tool execution failed",
      },
      error: hostileProxy,
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    let refundReason = "";
    const store = new MemoryToolExecutionStore();
    const service = new ToolExecutionService(store, [{
      ...echoAdapter,
      execute: () => Promise.reject(fixture.error),
    }], {
      reserve: () => Promise.resolve(),
      reconcileReservation: () => Promise.resolve(),
      settle: () => Promise.resolve(),
      refund: (_execution, reason) => {
        refundReason = reason ?? "";
        return Promise.resolve();
      },
    });
    await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
    const requested = await service.request(`user-${index}`, "echo", {});
    await service.approve(`user-${index}`, requested.id);
    const failed = await waitFor(service, `user-${index}`, requested.id, "failed");
    assertEquals(failed.error, fixture.expected);
    assertEquals(refundReason, fixture.expected.message);
    const exposed = JSON.stringify({ execution: failed, refundReason });
    for (const secret of secrets) assertEquals(exposed.includes(secret), false);
  }
  assertEquals(hostileProxyTraps, 0);
});

Deno.test("failed refunds remain durable and recovery retries before becoming terminal", async () => {
  let allowRefund = false;
  let refundAttempts = 0;
  let adapterCalls = 0;
  const store = new MemoryToolExecutionStore();
  const service = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: () => {
      adapterCalls++;
      return Promise.reject(new Error("upstream secret"));
    },
  }], {
    reserve: () => Promise.resolve(),
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => {
      refundAttempts++;
      return allowRefund ? Promise.resolve() : Promise.reject(new Error("ledger offline"));
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await service.approve("user", requested.id);
  const pending = await waitFor(service, "user", requested.id, "failed_pending_refund");
  assertEquals(pending.error, { code: "tool_execution_failed", message: "Tool execution failed" });
  assertEquals(adapterCalls, 1);
  allowRefund = true;
  await service.recover();
  assertEquals((await service.get("user", requested.id)).status, "failed");
  assertEquals(refundAttempts, 2);
  assertEquals(adapterCalls, 1);
});

Deno.test("disabled and revoked tools durably refund recovered reservations without dispatch", async () => {
  for (const mode of ["disabled", "revoked"] as const) {
    let allowRefund = false;
    let calls = 0;
    const adapter: ToolAdapter = {
      ...echoAdapter,
      definition: { ...echoAdapter.definition },
      execute: () => {
        calls++;
        return Promise.resolve({ forbidden: true });
      },
    };
    const store = new MemoryToolExecutionStore();
    const controls = {
      reserve: () => Promise.resolve(),
      reconcileReservation: () => Promise.resolve(),
      settle: () => Promise.resolve(),
      refund: () => allowRefund ? Promise.resolve() : Promise.reject(new Error("ledger offline")),
    };
    const first = new ToolExecutionService(store, [adapter], controls);
    const policy = await first.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
    const requested = await first.request("user", "echo", {});
    await store.transitionExecution(requested.id, ["pending_approval"], {
      status: "queued",
      billingSnapshot: persistedBillingSnapshot,
      approvedAt: new Date().toISOString(),
      approvedBy: "user",
    });
    if (mode === "disabled") adapter.definition.enabled = false;
    else {
      await first.setPolicy({
        toolId: "echo",
        allowed: false,
        expectedVersion: policy.version,
        actorId: "admin",
      });
    }
    const restarted = new ToolExecutionService(store, [adapter], controls);
    await restarted.recover();
    assertEquals(
      (await restarted.get("user", requested.id)).status,
      "failed_pending_refund",
    );
    assertEquals(calls, 0);
    allowRefund = true;
    await restarted.recover();
    assertEquals((await restarted.get("user", requested.id)).status, "failed");
    assertEquals(calls, 0);
  }
});

Deno.test("running cancellation survives an abort-ignoring late result until refund succeeds", async () => {
  let release!: () => void;
  let allowRefund = false;
  let refundAttempts = 0;
  const store = new MemoryToolExecutionStore();
  const service = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: async () => {
      await new Promise<void>((resolve) => release = resolve);
      return { tooLate: true };
    },
  }], {
    reserve: () => Promise.resolve(),
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => {
      refundAttempts++;
      return allowRefund ? Promise.resolve() : Promise.reject(new Error("ledger offline"));
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await service.approve("user", requested.id);
  await waitFor(service, "user", requested.id, "running");
  assertEquals((await service.cancel("user", requested.id)).status, "cancelled_pending_refund");
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals((await service.get("user", requested.id)).status, "cancelled_pending_refund");
  allowRefund = true;
  await service.recover();
  const cancelled = await service.get("user", requested.id);
  assertEquals(cancelled.status, "cancelled");
  assertEquals(cancelled.result, null);
  assertEquals(refundAttempts >= 2, true);
});

Deno.test("recovery claims are renewed, fenced, and expose the execution idempotency key", async () => {
  const store = new MemoryToolExecutionStore();
  const now = new Date().toISOString();
  const created = await store.createExecution({
    id: crypto.randomUUID(),
    ownerId: "user",
    toolId: "echo",
    input: {},
    status: "queued",
    result: null,
    error: null,
    approvedAt: now,
    approvedBy: "user",
    cancellationRequestedAt: null,
    billingSnapshot: persistedBillingSnapshot,
    createdAt: now,
    updatedAt: now,
  });
  const [claimed] = await store.claimRecoverable(1);
  assertEquals(claimed.id, created.id);
  assertEquals(typeof claimed.claimToken, "string");
  assertEquals(await store.renewClaim(claimed.id, claimed.claimToken!, 120_000), true);
  assertEquals(
    await store.transitionExecution(
      claimed.id,
      ["running"],
      { status: "failed" },
      crypto.randomUUID(),
    ),
    undefined,
  );
  assertEquals((await store.getExecution(claimed.id))?.status, "running");

  let observedKey = "";
  const service = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: (_input, context) => {
      observedKey = context.idempotencyKey;
      return Promise.resolve({ ok: true });
    },
  }]);
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  // Expire the first synthetic lease so service recovery obtains a fresh fenced claim.
  await store.transitionExecution(claimed.id, ["running"], {
    claimExpiresAt: new Date(0).toISOString(),
  }, claimed.claimToken!);
  await service.recover();
  await waitFor(service, "user", claimed.id, "succeeded");
  assertEquals(observedKey, claimed.id);
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
    reconcileReservation: () => Promise.resolve(),
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
    reconcileReservation: () => Promise.resolve(),
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
    reconcileReservation: () => {
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
    billingSnapshot: persistedBillingSnapshot,
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
    reconcileReservation: () => {
      attempts++;
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
    reconcileReservation: () => Promise.resolve(),
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
    billingSnapshot: persistedBillingSnapshot,
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
    reconcileReservation: async () => {
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
    billingSnapshot: persistedBillingSnapshot,
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
    reconcileReservation: async () => {
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
    billingSnapshot: persistedBillingSnapshot,
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
    reconcileReservation: () => Promise.resolve(),
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
    billingSnapshot: persistedBillingSnapshot,
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
    reconcileReservation: async () => {
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
    reconcileReservation: () => Promise.resolve(),
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

Deno.test("cancellation reconciliation bypasses admission limits and refunds a losing approval once", async () => {
  const store = new MemoryToolExecutionStore();
  let adapterCalls = 0;
  let admissionCalls = 0;
  let reconciliationCalls = 0;
  let refundEntries = 0;
  let reservation = false;
  let refunded = false;
  let admissionStarted!: () => void;
  let releaseAdmission!: () => void;
  const started = new Promise<void>((resolve) => admissionStarted = resolve);
  const release = new Promise<void>((resolve) => releaseAdmission = resolve);
  const service = new ToolExecutionService(store, [{
    ...echoAdapter,
    execute: () => {
      adapterCalls++;
      return Promise.resolve({ forbidden: true });
    },
  }], {
    reserve: async () => {
      admissionCalls++;
      admissionStarted();
      await release;
      if (refunded) {
        throw Object.assign(new Error("reservation already reconciled"), {
          code: "idempotency_conflict",
        });
      }
      reservation = true;
    },
    reconcileReservation: () => {
      reconciliationCalls++;
      if (!refunded) reservation = true;
      return Promise.resolve();
    },
    settle: () => Promise.resolve(),
    refund: () => {
      if (!reservation) return Promise.resolve(false);
      if (!refunded) {
        refunded = true;
        refundEntries++;
      }
      return Promise.resolve(true);
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  const approval = service.approve("user", requested.id);
  await started;

  assertEquals((await service.cancel("user", requested.id)).status, "cancelled");
  releaseAdmission();
  await assertRejects(() => approval, ToolExecutionError, "cancelled");

  assertEquals((await service.get("user", requested.id)).status, "cancelled");
  assertEquals(admissionCalls, 1);
  assertEquals(reconciliationCalls, 1);
  assertEquals(refundEntries, 1);
  assertEquals(adapterCalls, 0);
});

Deno.test("concurrent refund reconcilers create exactly one ledger refund", async () => {
  const store = new MemoryToolExecutionStore();
  let arrivals = 0;
  let release!: () => void;
  let refunded = false;
  let refundEntries = 0;
  const barrier = new Promise<void>((resolve) => release = resolve);
  const controls = {
    reserve: () => Promise.resolve(),
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: async () => {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
      if (!refunded) {
        refunded = true;
        refundEntries++;
      }
      return true;
    },
  };
  const first = new ToolExecutionService(store, [echoAdapter], controls);
  const second = new ToolExecutionService(store, [echoAdapter], controls);
  await first.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await first.request("user", "echo", {});
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "cancelled_pending_refund",
    billingSnapshot: persistedBillingSnapshot,
    cancellationRequestedAt: new Date().toISOString(),
  });

  await Promise.all([first.recover(), second.recover()]);

  assertEquals((await first.get("user", requested.id)).status, "cancelled");
  assertEquals(arrivals, 2);
  assertEquals(refundEntries, 1);
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
    reconcileReservation: () => Promise.resolve(),
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
    billingSnapshot: persistedBillingSnapshot,
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

Deno.test("insufficient-credit reconciliation survives a crash and refunds a late lost-ack debit", async () => {
  const store = new MemoryToolExecutionStore();
  const denial = Object.assign(new Error("insufficient credit"), {
    code: "insufficient_credit",
  });
  let reservationExists = false;
  let refundEntries = 0;
  const service = new ToolExecutionService(store, [echoAdapter], {
    reserve: () => Promise.resolve(),
    reconcileReservation: () => Promise.reject(denial),
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(reservationExists),
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  await store.transitionExecution(requested.id, ["pending_approval"], {
    status: "queued_pending_reservation",
    billingSnapshot: persistedBillingSnapshot,
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
    cancellationRequestedAt: new Date().toISOString(),
  });
  await service.recover();
  assertEquals(
    (await service.get("user", requested.id)).status,
    "cancelled_pending_refund",
  );

  // The admitted reservation commits after the process that observed insufficient credit dies;
  // its acknowledgement is lost. A fresh process must still find and refund that debit.
  reservationExists = true;
  const restarted = new ToolExecutionService(store, [echoAdapter], {
    reserve: () => Promise.resolve(),
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => {
      if (!reservationExists) return Promise.resolve(false);
      reservationExists = false;
      refundEntries++;
      return Promise.resolve(true);
    },
  });
  await restarted.recover();
  assertEquals((await restarted.get("user", requested.id)).status, "cancelled");
  assertEquals(refundEntries, 1);
});

Deno.test("pre-debit approval denial cannot terminally fence a concurrent cancellation", async () => {
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
    reconcileReservation: () => Promise.reject(denial()),
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(false),
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  const approval = service.approve("user", requested.id);
  await started;
  assertEquals(
    (await service.cancel("user", requested.id)).status,
    "cancelled_pending_refund",
  );
  releaseFirstReserve();
  await assertRejects(() => approval, ToolExecutionError, "cancelled");
  assertEquals(
    (await service.get("user", requested.id)).status,
    "cancelled_pending_refund",
  );
});

Deno.test("restart recovery uses the immutable approval billing snapshot after config drift", async () => {
  const store = new MemoryToolExecutionStore();
  let configuredReserveMicros = 125;
  let snapshotCalls = 0;
  const reconciled: number[] = [];
  const settled: number[] = [];
  const refunded: number[] = [];
  const controls = {
    billingSnapshot: (execution: { toolId: string }) => {
      snapshotCalls++;
      return {
        reservedMicros: configuredReserveMicros,
        provider: "tool-original",
        model: `tool/${execution.toolId}@original`,
      };
    },
    reserve: () => Promise.resolve(),
    reconcileReservation: (execution: { billingSnapshot: { reservedMicros: number } | null }) => {
      reconciled.push(execution.billingSnapshot!.reservedMicros);
      return Promise.resolve();
    },
    settle: (execution: { billingSnapshot: { reservedMicros: number } | null }) => {
      settled.push(execution.billingSnapshot!.reservedMicros);
      return Promise.resolve();
    },
    refund: (execution: { billingSnapshot: { reservedMicros: number } | null }) => {
      refunded.push(execution.billingSnapshot!.reservedMicros);
      return Promise.resolve(true);
    },
  };
  const first = new ToolExecutionService(store, [echoAdapter], controls);
  await first.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });

  const settleRequest = await first.request("user", "echo", {});
  const originalSnapshot = controls.billingSnapshot(settleRequest);
  await store.transitionExecution(settleRequest.id, ["pending_approval"], {
    status: "queued_pending_reservation",
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
    billingSnapshot: originalSnapshot,
  });
  assertEquals(
    await store.transitionExecution(settleRequest.id, ["queued_pending_reservation"], {
      billingSnapshot: { ...originalSnapshot, reservedMicros: 9_999 },
    }),
    undefined,
  );
  const refundRequest = await first.request("user", "echo", {});
  await store.transitionExecution(refundRequest.id, ["pending_approval"], {
    status: "failed_pending_refund",
    approvedAt: new Date().toISOString(),
    approvedBy: "user",
    billingSnapshot: originalSnapshot,
    error: { code: "tool_execution_failed", message: "Tool execution failed" },
  });

  configuredReserveMicros = 9_999;
  const callsBeforeRestart = snapshotCalls;
  const restarted = new ToolExecutionService(store, [echoAdapter], controls);
  await restarted.recover();
  await waitFor(restarted, "user", settleRequest.id, "succeeded");

  assertEquals(snapshotCalls, callsBeforeRestart);
  assertEquals(reconciled, [125]);
  assertEquals(settled, [125]);
  assertEquals(refunded, [125]);
  assertEquals((await restarted.get("user", settleRequest.id)).billingSnapshot, originalSnapshot);
  assertEquals((await restarted.get("user", refundRequest.id)).status, "failed");
});

Deno.test("approval rollback observes a cancellation marker written after its read", async () => {
  class RollbackReadStore extends MemoryToolExecutionStore {
    reads = 0;
    catchRead!: () => void;
    releaseCatchRead!: () => void;
    readonly atCatchRead = new Promise<void>((resolve) => this.catchRead = resolve);
    readonly catchReadRelease = new Promise<void>((resolve) => this.releaseCatchRead = resolve);
    override async getExecution(id: string, ownerId?: string) {
      const value = await super.getExecution(id, ownerId);
      if (++this.reads === 2) {
        this.catchRead();
        await this.catchReadRelease;
      }
      return value;
    }
  }
  const store = new RollbackReadStore();
  const denial = () =>
    Object.assign(new Error("insufficient credit"), {
      code: "insufficient_credit",
    });
  const service = new ToolExecutionService(store, [echoAdapter], {
    reserve: () => Promise.reject(denial()),
    reconcileReservation: () => Promise.reject(denial()),
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(false),
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const requested = await service.request("user", "echo", {});
  const approval = service.approve("user", requested.id);
  await store.atCatchRead;
  assertEquals(
    (await service.cancel("user", requested.id)).status,
    "cancelled_pending_refund",
  );
  store.releaseCatchRead();
  await assertRejects(() => approval, ToolExecutionError, "cancelled");
  assertEquals(
    (await service.get("user", requested.id)).status,
    "cancelled_pending_refund",
  );
});

Deno.test("admission rejection or outage leaves no durable billing or recoverable work", async () => {
  for (
    const rejection of [
      new Error("redis unavailable"),
      new ToolExecutionError("rate_limited", "Tool rate limit exceeded", 429),
    ]
  ) {
    const store = new MemoryToolExecutionStore();
    let snapshots = 0;
    let reserves = 0;
    let adapterCalls = 0;
    const service = new ToolExecutionService(store, [{
      ...echoAdapter,
      execute: () => {
        adapterCalls++;
        return Promise.resolve({ forbidden: true });
      },
    }], {
      admit: () => Promise.reject(rejection),
      billingSnapshot: () => {
        snapshots++;
        return persistedBillingSnapshot;
      },
      reserve: () => {
        reserves++;
        return Promise.resolve();
      },
      reconcileReservation: () => Promise.resolve(),
      settle: () => Promise.resolve(),
      refund: () => Promise.resolve(false),
    });
    await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
    const request = await service.request("user", "echo", {});
    await assertRejects(() => service.approve("user", request.id));
    const persisted = await service.get("user", request.id);
    assertEquals(persisted.status, "pending_approval");
    assertEquals(persisted.billingSnapshot, null);
    assertEquals(await service.recover(), 0);
    assertEquals({ snapshots, reserves, adapterCalls }, {
      snapshots: 0,
      reserves: 0,
      adapterCalls: 0,
    });
  }
});

Deno.test("crash after admission remains pending and can be explicitly approved after restart", async () => {
  const store = new MemoryToolExecutionStore();
  let admissions = 0;
  let crash = true;
  let reserves = 0;
  const controls = {
    admit: () => {
      admissions++;
      return Promise.resolve();
    },
    billingSnapshot: () => {
      if (crash) throw new Error("process stopped after limiter admission");
      return persistedBillingSnapshot;
    },
    reserve: () => {
      reserves++;
      return Promise.resolve();
    },
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(false),
  };
  const first = new ToolExecutionService(store, [echoAdapter], controls);
  await first.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const request = await first.request("user", "echo", {});
  await assertRejects(() => first.approve("user", request.id), Error, "process stopped");
  assertEquals((await first.get("user", request.id)).billingSnapshot, null);
  assertEquals(await first.recover(), 0);

  crash = false;
  const restarted = new ToolExecutionService(store, [echoAdapter], controls);
  await restarted.approve("user", request.id);
  await waitFor(restarted, "user", request.id, "succeeded");
  assertEquals({ admissions, reserves }, { admissions: 2, reserves: 1 });
});

Deno.test("cancellation during admission cannot create a snapshot, debit, or refund", async () => {
  const store = new MemoryToolExecutionStore();
  let entered!: () => void;
  let release!: () => void;
  let reserves = 0;
  let refunds = 0;
  const atAdmission = new Promise<void>((resolve) => entered = resolve);
  const admitted = new Promise<void>((resolve) => release = resolve);
  const service = new ToolExecutionService(store, [echoAdapter], {
    admit: async () => {
      entered();
      await admitted;
    },
    billingSnapshot: () => persistedBillingSnapshot,
    reserve: () => {
      reserves++;
      return Promise.resolve();
    },
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => {
      refunds++;
      return Promise.resolve(false);
    },
  });
  await service.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const request = await service.request("user", "echo", {});
  const approval = service.approve("user", request.id);
  await atAdmission;
  assertEquals((await service.cancel("user", request.id)).status, "cancelled");
  release();
  await assertRejects(() => approval, ToolExecutionError, "cancelled");
  assertEquals((await service.get("user", request.id)).billingSnapshot, null);
  assertEquals({ reserves, refunds }, { reserves: 0, refunds: 0 });
});

Deno.test("two replicas may admit concurrently but create one debit and one dispatch", async () => {
  const store = new MemoryToolExecutionStore();
  let admissions = 0;
  let release!: () => void;
  let reserves = 0;
  let dispatches = 0;
  const barrier = new Promise<void>((resolve) => release = resolve);
  const controls = {
    admit: async () => {
      if (++admissions === 2) release();
      await barrier;
    },
    billingSnapshot: () => persistedBillingSnapshot,
    reserve: () => {
      reserves++;
      return Promise.resolve();
    },
    reconcileReservation: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refund: () => Promise.resolve(false),
  };
  const adapter = {
    ...echoAdapter,
    execute: () => {
      dispatches++;
      return Promise.resolve({ ok: true });
    },
  };
  const first = new ToolExecutionService(store, [adapter], controls);
  const second = new ToolExecutionService(store, [adapter], controls);
  await first.setPolicy({ toolId: "echo", allowed: true, actorId: "admin" });
  const request = await first.request("user", "echo", {});
  const outcomes = await Promise.allSettled([
    first.approve("user", request.id),
    second.approve("user", request.id),
  ]);
  await waitFor(first, "user", request.id, "succeeded");
  assertEquals(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assertEquals({ admissions, reserves, dispatches }, { admissions: 2, reserves: 1, dispatches: 1 });
});
