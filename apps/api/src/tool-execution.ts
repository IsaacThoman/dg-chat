export type ToolExecutionStatus =
  | "pending_approval"
  | "queued_pending_reservation"
  | "queued"
  | "running"
  | "succeeded_pending_settlement"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** A disabled tool fails closed even if an old policy record still allows it. */
  enabled: boolean;
}

export interface ToolPolicy {
  toolId: string;
  allowed: boolean;
  allowedDomains: string[];
  allowPrivateNetwork: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface ToolExecution {
  id: string;
  ownerId: string;
  toolId: string;
  input: unknown;
  status: ToolExecutionStatus;
  result: unknown | null;
  error: { code: string; message: string } | null;
  approvedAt: string | null;
  approvedBy: string | null;
  cancellationRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Persistence boundary. PostgreSQL can implement this without changing execution semantics. */
export interface ToolExecutionStore {
  listPolicies(): Promise<ToolPolicy[]>;
  getPolicy(toolId: string): Promise<ToolPolicy | undefined>;
  putPolicy(
    policy: Omit<ToolPolicy, "version" | "updatedAt">,
    expectedVersion?: number,
  ): Promise<ToolPolicy>;
  createExecution(execution: ToolExecution): Promise<ToolExecution>;
  getExecution(id: string, ownerId?: string): Promise<ToolExecution | undefined>;
  /** Atomic compare-and-set; returns undefined if the current status no longer matches. */
  transitionExecution(
    id: string,
    expected: readonly ToolExecutionStatus[],
    patch: Partial<Omit<ToolExecution, "id" | "ownerId" | "toolId" | "input" | "createdAt">>,
  ): Promise<ToolExecution | undefined>;
  linkExecutions?(
    ownerId: string,
    messageId: string,
    executionIds: readonly string[],
  ): Promise<void>;
  claimRecoverable?(limit: number): Promise<ToolExecution[]>;
  listPendingSettlement?(limit: number): Promise<ToolExecution[]>;
  listPendingReservation?(limit: number): Promise<ToolExecution[]>;
}

export interface ToolAdapterContext {
  executionId: string;
  ownerId: string;
  signal: AbortSignal;
  policy: ToolPolicy;
}

export interface ToolAdapter {
  definition: ToolDefinition;
  execute(input: unknown, context: ToolAdapterContext): Promise<unknown>;
}

export class ToolExecutionError extends Error {
  constructor(
    readonly code:
      | "tool_not_found"
      | "tool_not_allowed"
      | "execution_not_found"
      | "approval_required"
      | "execution_terminal"
      | "version_conflict"
      | "rate_limited"
      | "invalid_input",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateJson(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 1_000 && value.every((v) => validateJson(v, depth + 1));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 1_000 &&
    entries.every(([key, item]) => key.length <= 256 && validateJson(item, depth + 1));
}

export class MemoryToolExecutionStore implements ToolExecutionStore {
  readonly #policies = new Map<string, ToolPolicy>();
  readonly #executions = new Map<string, ToolExecution>();

  listPolicies() {
    return Promise.resolve([...this.#policies.values()].map(clone));
  }
  getPolicy(toolId: string) {
    const value = this.#policies.get(toolId);
    return Promise.resolve(value ? clone(value) : undefined);
  }
  putPolicy(
    policy: Omit<ToolPolicy, "version" | "updatedAt">,
    expectedVersion?: number,
  ) {
    const current = this.#policies.get(policy.toolId);
    if ((current?.version ?? 0) !== (expectedVersion ?? current?.version ?? 0)) {
      throw new ToolExecutionError(
        "version_conflict",
        "Tool policy changed in another session",
        409,
      );
    }
    const next = {
      ...clone(policy),
      version: (current?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#policies.set(policy.toolId, next);
    return Promise.resolve(clone(next));
  }
  createExecution(execution: ToolExecution) {
    if (this.#executions.has(execution.id)) throw new Error("Duplicate tool execution");
    this.#executions.set(execution.id, clone(execution));
    return Promise.resolve(clone(execution));
  }
  getExecution(id: string, ownerId?: string) {
    const value = this.#executions.get(id);
    return Promise.resolve(
      value && (!ownerId || value.ownerId === ownerId) ? clone(value) : undefined,
    );
  }
  transitionExecution(
    id: string,
    expected: readonly ToolExecutionStatus[],
    patch: Partial<Omit<ToolExecution, "id" | "ownerId" | "toolId" | "input" | "createdAt">>,
  ) {
    const current = this.#executions.get(id);
    if (!current || !expected.includes(current.status)) return Promise.resolve(undefined);
    const next = { ...current, ...clone(patch), updatedAt: new Date().toISOString() };
    this.#executions.set(id, next);
    return Promise.resolve(clone(next));
  }
  claimRecoverable(limit: number) {
    const claimed: ToolExecution[] = [];
    for (const execution of this.#executions.values()) {
      if (execution.status !== "queued" || claimed.length >= limit) continue;
      execution.status = "running";
      execution.updatedAt = new Date().toISOString();
      claimed.push(clone(execution));
    }
    return Promise.resolve(claimed);
  }
  listPendingSettlement(limit: number) {
    return Promise.resolve(
      [...this.#executions.values()]
        .filter((execution) => execution.status === "succeeded_pending_settlement")
        .slice(0, limit).map(clone),
    );
  }
  listPendingReservation(limit: number) {
    return Promise.resolve(
      [...this.#executions.values()]
        .filter((execution) => execution.status === "queued_pending_reservation")
        .slice(0, limit).map(clone),
    );
  }
}

const TERMINAL: readonly ToolExecutionStatus[] = [
  "succeeded_pending_settlement",
  "succeeded",
  "failed",
  "cancelled",
];

export class ToolExecutionService {
  readonly #adapters = new Map<string, ToolAdapter>();
  readonly #active = new Map<string, AbortController>();

  constructor(
    readonly store: ToolExecutionStore,
    adapters: readonly ToolAdapter[],
    readonly controls?: {
      reserve(execution: ToolExecution): Promise<void>;
      settle(execution: ToolExecution, latencyMs: number): Promise<void>;
      /** Returns false only when no matching reservation existed yet. */
      refund(execution: ToolExecution, error?: string): Promise<boolean | void>;
    },
  ) {
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.definition.id)) throw new Error("Duplicate tool adapter id");
      this.#adapters.set(adapter.definition.id, adapter);
    }
  }

  listDefinitions() {
    return [...this.#adapters.values()].map((adapter) => clone(adapter.definition));
  }

  async listPolicies() {
    const policies = new Map(
      (await this.store.listPolicies()).map((policy) => [policy.toolId, policy]),
    );
    return this.listDefinitions().map((definition) => ({
      definition,
      policy: policies.get(definition.id) ?? null,
    }));
  }

  async setPolicy(input: {
    toolId: string;
    allowed: boolean;
    allowedDomains?: string[];
    allowPrivateNetwork?: boolean;
    expectedVersion?: number;
    actorId: string;
  }) {
    if (!this.#adapters.has(input.toolId)) {
      throw new ToolExecutionError("tool_not_found", "Tool is not registered", 404);
    }
    const domains = [
      ...new Set(
        (input.allowedDomains ?? []).map((value) =>
          value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
        ),
      ),
    ];
    if (domains.some((domain) => !domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain))) {
      throw new ToolExecutionError("invalid_input", "Tool domain allowlist is invalid", 422);
    }
    try {
      return await this.store.putPolicy({
        toolId: input.toolId,
        allowed: input.allowed,
        allowedDomains: domains,
        allowPrivateNetwork: input.allowPrivateNetwork === true,
        updatedBy: input.actorId,
      }, input.expectedVersion);
    } catch (error) {
      if (error instanceof Error && error.name === "ToolPolicyVersionConflict") {
        throw new ToolExecutionError(
          "version_conflict",
          "Tool policy changed in another session",
          409,
        );
      }
      throw error;
    }
  }

  async request(ownerId: string, toolId: string, input: unknown): Promise<ToolExecution> {
    const adapter = this.#adapters.get(toolId);
    const policy = await this.store.getPolicy(toolId);
    if (!adapter || !adapter.definition.enabled || !policy?.allowed) {
      throw new ToolExecutionError(
        "tool_not_allowed",
        "Tool is unavailable or not allowlisted",
        403,
      );
    }
    if (!validateJson(input) || JSON.stringify(input).length > 256_000) {
      throw new ToolExecutionError("invalid_input", "Tool input must be bounded JSON", 422);
    }
    const now = new Date().toISOString();
    return await this.store.createExecution({
      id: crypto.randomUUID(),
      ownerId,
      toolId,
      input: clone(input),
      status: "pending_approval",
      result: null,
      error: null,
      approvedAt: null,
      approvedBy: null,
      cancellationRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async get(ownerId: string, id: string): Promise<ToolExecution> {
    const execution = await this.store.getExecution(id, ownerId);
    if (!execution) {
      throw new ToolExecutionError("execution_not_found", "Tool execution was not found", 404);
    }
    if (execution.status === "succeeded_pending_settlement" && this.controls) {
      try {
        await this.controls.settle(execution, 0);
        return await this.store.transitionExecution(id, ["succeeded_pending_settlement"], {
          status: "succeeded",
        }) ?? execution;
      } catch {
        return execution;
      }
    }
    return execution;
  }

  async resolveSucceeded(ownerId: string, ids: readonly string[]) {
    if (ids.length > 8 || new Set(ids).size !== ids.length) {
      throw new ToolExecutionError("invalid_input", "Tool execution identifiers are invalid", 422);
    }
    const values = await Promise.all(ids.map((id) => this.get(ownerId, id)));
    if (values.some((value) => value.status !== "succeeded")) {
      throw new ToolExecutionError(
        "execution_terminal",
        "Every linked tool execution must have succeeded",
        409,
      );
    }
    return values;
  }

  async linkToMessage(ownerId: string, messageId: string, ids: readonly string[]) {
    if (ids.length) await this.store.linkExecutions?.(ownerId, messageId, ids);
  }

  async recover(limit = 25) {
    const pendingReservation = await this.store.listPendingReservation?.(limit) ?? [];
    for (const execution of pendingReservation) {
      try {
        if (execution.cancellationRequestedAt) {
          const refunded = await this.controls?.refund(
            execution,
            "tool execution cancelled before dispatch",
          );
          if (refunded === false) {
            // A reservation may still be committing with a lost acknowledgement. Establish or
            // observe it, then refund it. On a later retry, refund returns true for terminal runs.
            await this.controls?.reserve(execution);
            await this.controls?.refund(execution, "tool execution cancelled before dispatch");
          }
          await this.store.transitionExecution(execution.id, ["queued_pending_reservation"], {
            status: "cancelled",
          });
          continue;
        }
        await this.controls?.reserve(execution);
        const queued = await this.store.transitionExecution(execution.id, [
          "queued_pending_reservation",
        ], {
          status: "queued",
        });
        if (!queued) {
          const current = await this.store.getExecution(execution.id, execution.ownerId);
          // Another replica may have advanced the same idempotent reservation. It owns settlement;
          // only a cancellation means the shared reservation must be refunded here.
          if (current?.status === "cancelled" || current?.cancellationRequestedAt) {
            await this.controls?.refund(execution, "reservation lost cancellation race");
          }
        } else if (queued.cancellationRequestedAt) {
          await this.controls?.refund(execution, "tool execution cancelled before dispatch");
          await this.store.transitionExecution(execution.id, ["queued"], {
            status: "cancelled",
          });
        }
      } catch {
        // Retain the durable pending state. A later maintenance pass retries idempotently.
      }
    }
    const pendingSettlement = await this.store.listPendingSettlement?.(limit) ?? [];
    for (const execution of pendingSettlement) await this.get(execution.ownerId, execution.id);
    const executions = await this.store.claimRecoverable?.(limit) ?? [];
    for (const execution of executions) {
      const adapter = this.#adapters.get(execution.toolId);
      const policy = await this.store.getPolicy(execution.toolId);
      if (adapter && policy?.allowed) {
        void this.#dispatch(execution, adapter, policy, true);
      } else {
        await this.store.transitionExecution(execution.id, ["running"], {
          status: "failed",
          error: { code: "tool_not_allowed", message: "Tool policy changed before execution" },
        });
        await this.controls?.refund(execution, "tool policy changed before execution");
      }
    }
    return executions.length + pendingSettlement.length + pendingReservation.length;
  }

  async approve(ownerId: string, id: string): Promise<ToolExecution> {
    const execution = await this.get(ownerId, id);
    if (execution.status !== "pending_approval") {
      throw new ToolExecutionError(
        TERMINAL.includes(execution.status) ? "execution_terminal" : "approval_required",
        "Tool execution cannot be approved in its current state",
        409,
      );
    }
    const adapter = this.#adapters.get(execution.toolId);
    const policy = await this.store.getPolicy(execution.toolId);
    // Recheck policy at approval time so revocation between request and approval fails closed.
    if (!adapter || !adapter.definition.enabled || !policy?.allowed) {
      throw new ToolExecutionError("tool_not_allowed", "Tool is no longer allowlisted", 403);
    }
    const now = new Date().toISOString();
    let queued: ToolExecution | undefined;
    try {
      const pending = await this.store.transitionExecution(id, ["pending_approval"], {
        status: "queued_pending_reservation",
        approvedAt: now,
        approvedBy: ownerId,
      });
      if (!pending) throw new Error("Tool execution changed");
      await this.controls?.reserve(execution);
      queued = await this.store.transitionExecution(id, ["queued_pending_reservation"], {
        status: "queued",
      });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      // Unknown failures may be a committed reservation with a lost acknowledgement. Preserve the
      // durable reconciliation state; only failures known to happen before a debit are retryable by
      // the user as a fresh approval.
      if (code === "insufficient_credit" || code === "rate_limited") {
        await this.store.transitionExecution(id, ["queued_pending_reservation"], {
          status: "pending_approval",
          approvedAt: null,
          approvedBy: null,
        });
      }
      throw error;
    }
    if (!queued) {
      await this.controls?.refund(execution, "tool execution changed before approval");
      throw new ToolExecutionError("execution_terminal", "Tool execution changed", 409);
    }
    void this.recover();
    return queued;
  }

  async cancel(ownerId: string, id: string): Promise<ToolExecution> {
    const execution = await this.get(ownerId, id);
    if (TERMINAL.includes(execution.status)) {
      throw new ToolExecutionError("execution_terminal", "Tool execution is already complete", 409);
    }
    const now = new Date().toISOString();
    if (execution.status === "queued_pending_reservation" || execution.status === "queued") {
      const refundPending = await this.store.transitionExecution(id, [execution.status], {
        status: "queued_pending_reservation",
        cancellationRequestedAt: now,
      });
      if (!refundPending) {
        throw new ToolExecutionError("execution_terminal", "Tool execution changed", 409);
      }
      const refunded = await this.controls?.refund(
        refundPending,
        "tool execution cancelled before dispatch",
      );
      if (refunded === false) {
        await this.controls?.reserve(refundPending);
        await this.controls?.refund(refundPending, "tool execution cancelled before dispatch");
      }
      const cancelled = await this.store.transitionExecution(id, ["queued_pending_reservation"], {
        status: "cancelled",
      });
      return cancelled ?? await this.get(ownerId, id);
    }
    const cancelled = await this.store.transitionExecution(id, ["pending_approval", "running"], {
      status: "cancelled",
      cancellationRequestedAt: now,
    });
    if (!cancelled) {
      throw new ToolExecutionError("execution_terminal", "Tool execution changed", 409);
    }
    this.#active.get(id)?.abort("user_cancelled");
    return cancelled;
  }

  async #dispatch(
    execution: ToolExecution,
    adapter: ToolAdapter,
    policy: ToolPolicy,
    claimed = false,
  ) {
    const controller = new AbortController();
    const startedAt = performance.now();
    this.#active.set(execution.id, controller);
    let upstreamSucceeded = false;
    try {
      // Fence the exact policy revision immediately before execution. An administrator can revoke
      // or narrow a policy after user approval but before this microtask begins.
      const currentPolicy = await this.store.getPolicy(execution.toolId);
      if (!currentPolicy?.allowed || currentPolicy.version !== policy.version) {
        throw new Error("Tool policy changed before execution began");
      }
      const running = claimed ? execution : await this.store.transitionExecution(
        execution.id,
        ["queued"],
        { status: "running" },
      );
      if (!running) return;
      const result = await adapter.execute(execution.input, {
        executionId: execution.id,
        ownerId: execution.ownerId,
        signal: controller.signal,
        policy: currentPolicy,
      });
      if (!validateJson(result) || JSON.stringify(result).length > 1_000_000) {
        throw new Error("Tool returned an invalid or oversized result");
      }
      upstreamSucceeded = true;
      const recorded = await this.store.transitionExecution(execution.id, ["running"], {
        status: "succeeded_pending_settlement",
        result: clone(result),
      });
      if (!recorded) return;
      await this.controls?.settle(
        execution,
        Math.max(0, Math.round(performance.now() - startedAt)),
      );
      await this.store.transitionExecution(execution.id, ["succeeded_pending_settlement"], {
        status: "succeeded",
      });
    } catch (error) {
      if (upstreamSucceeded) return;
      if (controller.signal.aborted) {
        await this.store.transitionExecution(execution.id, ["queued", "running"], {
          status: "cancelled",
          cancellationRequestedAt: new Date().toISOString(),
        });
      } else {
        await this.store.transitionExecution(execution.id, ["queued", "running"], {
          status: "failed",
          error: {
            code: "tool_execution_failed",
            message: error instanceof Error
              ? error.message.slice(0, 1_000)
              : "Tool execution failed",
          },
        });
      }
      await this.controls?.refund(
        execution,
        error instanceof Error ? error.message.slice(0, 1_000) : "Tool execution failed",
      );
    } finally {
      this.#active.delete(execution.id);
    }
  }
}
