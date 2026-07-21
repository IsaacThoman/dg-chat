import { compileToolInputSchema } from "./tool-schema.ts";
import { types as nodeTypes } from "node:util";

export type ToolExecutionStatus =
  | "pending_approval"
  | "queued_pending_reservation"
  | "queued"
  | "running"
  | "failed_pending_refund"
  | "cancelled_pending_refund"
  | "succeeded_pending_settlement"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  /** JSON Schema Draft 7; common ajv-formats values are validated. */
  inputSchema: Record<string, unknown>;
  /** Recovery may repeat dispatch after a process failure; adapters must declare why that is safe. */
  recoverySafety: "read_only" | "idempotent_by_execution_id";
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

/** Immutable accounting identity captured before the approval-time debit is attempted. */
export interface ToolBillingSnapshot {
  reservedMicros: number;
  provider: string;
  model: string;
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
  billingSnapshot: ToolBillingSnapshot | null;
  createdAt: string;
  updatedAt: string;
  /** Store-internal lease data used to fence recovery across replicas. */
  claimToken?: string | null;
  claimExpiresAt?: string | null;
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
    claimToken?: string,
  ): Promise<ToolExecution | undefined>;
  linkExecutions?(
    ownerId: string,
    messageId: string,
    executionIds: readonly string[],
  ): Promise<void>;
  claimRecoverable?(limit: number): Promise<ToolExecution[]>;
  listPendingSettlement?(limit: number): Promise<ToolExecution[]>;
  listPendingReservation?(limit: number): Promise<ToolExecution[]>;
  listPendingCancellation?(limit: number): Promise<ToolExecution[]>;
  listPendingRefund?(limit: number): Promise<ToolExecution[]>;
  renewClaim?(id: string, claimToken: string, leaseMs: number): Promise<boolean>;
}

export interface ToolAdapterContext {
  executionId: string;
  /** Must be used as the upstream idempotency key by idempotent adapters. */
  idempotencyKey: string;
  ownerId: string;
  signal: AbortSignal;
  policy: ToolPolicy;
}

export interface ToolAdapter {
  definition: ToolDefinition;
  execute(input: unknown, context: ToolAdapterContext): Promise<unknown>;
}

export class ToolAdapterError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "policy_denied"
      | "not_configured"
      | "upstream_unavailable"
      | "invalid_response"
      | "timeout",
  ) {
    super("Tool adapter failed");
    this.name = "ToolAdapterError";
  }
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

function snapshotJson(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (depth > 12) throw new Error("JSON nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new Error("Value is not plain JSON data");
  }
  if (seen.has(value)) throw new Error("JSON data is cyclic");
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) throw new Error("Symbol keys are not JSON");
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1_000) {
        throw new Error("Array is not bounded plain data");
      }
      const allowed = new Set([
        "length",
        ...Array.from({ length: value.length }, (_, i) => String(i)),
      ]);
      if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
        throw new Error("Array has non-JSON properties");
      }
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("Sparse or accessor arrays are not JSON data");
        }
        output.push(snapshotJson(descriptor.value, seen, depth + 1));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Object is not plain JSON data");
    }
    const entries = Object.entries(descriptors);
    if (entries.length > 1_000) throw new Error("Object has too many properties");
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of entries) {
      if (
        !key || new TextEncoder().encode(key).byteLength > 256 || !("value" in descriptor) ||
        !descriptor.enumerable
      ) throw new Error("Object contains non-JSON properties");
      Object.defineProperty(output, key, {
        value: snapshotJson(descriptor.value, seen, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function boundedJsonSnapshot(value: unknown, maxBytes: number): unknown | undefined {
  try {
    const snapshot = snapshotJson(value, new WeakSet());
    const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
    return encoded.byteLength <= maxBytes ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

const TOOL_FAILURES = {
  tool_invalid_request: "Tool request was rejected",
  tool_policy_denied: "Tool execution was blocked by policy",
  tool_unavailable: "Tool service is not configured",
  tool_timeout: "Tool service timed out",
  tool_upstream_unavailable: "Tool service is unavailable",
  tool_invalid_response: "Tool service returned an invalid response",
  tool_execution_failed: "Tool execution failed",
} as const;

type PublicToolFailureCode = keyof typeof TOOL_FAILURES;

function categorizedToolFailure(code: string): {
  code: PublicToolFailureCode;
  message: string;
} {
  switch (code) {
    case "invalid_request":
    case "tool_invalid_request":
      return { code: "tool_invalid_request", message: TOOL_FAILURES.tool_invalid_request };
    case "policy_denied":
    case "tool_not_allowed":
    case "tool_policy_denied":
      return { code: "tool_policy_denied", message: TOOL_FAILURES.tool_policy_denied };
    case "not_configured":
    case "tool_unavailable":
      return { code: "tool_unavailable", message: TOOL_FAILURES.tool_unavailable };
    case "request_timeout":
    case "timeout":
    case "tool_timeout":
      return { code: "tool_timeout", message: TOOL_FAILURES.tool_timeout };
    case "request_failed":
    case "upstream_unavailable":
    case "tool_upstream_unavailable":
      return {
        code: "tool_upstream_unavailable",
        message: TOOL_FAILURES.tool_upstream_unavailable,
      };
    case "invalid_response":
    case "response_too_large":
    case "tool_invalid_response":
      return { code: "tool_invalid_response", message: TOOL_FAILURES.tool_invalid_response };
    default:
      return { code: "tool_execution_failed", message: TOOL_FAILURES.tool_execution_failed };
  }
}

/** Normalize restored/legacy failure payloads without evaluating hostile getters or proxies. */
export function normalizeToolExecutionError(
  error: unknown,
): { code: PublicToolFailureCode; message: string } | null {
  if (error === null || error === undefined) return null;
  try {
    if (typeof error !== "object" || nodeTypes.isProxy(error)) {
      return categorizedToolFailure("");
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return categorizedToolFailure(typeof descriptor?.value === "string" ? descriptor.value : "");
  } catch {
    return categorizedToolFailure("");
  }
}

export function normalizeToolExecutionForRead(execution: ToolExecution): ToolExecution {
  return execution.error === null
    ? execution
    : { ...execution, error: normalizeToolExecutionError(execution.error) };
}

function safeAdapterFailure(error: unknown): { code: string; message: string } {
  let code: string = "unknown";
  try {
    if (!nodeTypes.isProxy(error) && error instanceof ToolAdapterError) {
      code = error.code;
    } else if (!nodeTypes.isProxy(error) && error instanceof Error) {
      // Do not invoke getters on an arbitrary object thrown by an adapter. Only WebSearchError's
      // own data properties participate in the cross-module categorization contract.
      const name = Object.getOwnPropertyDescriptor(error, "name");
      const errorCode = Object.getOwnPropertyDescriptor(error, "code");
      if (name?.value === "WebSearchError" && typeof errorCode?.value === "string") {
        code = errorCode.value;
      }
    }
  } catch {
    code = "unknown";
  }
  return categorizedToolFailure(code);
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
    claimToken?: string,
  ) {
    const current = this.#executions.get(id);
    if (
      !current || !expected.includes(current.status) ||
      (claimToken !== undefined && current.claimToken !== claimToken) ||
      (patch.billingSnapshot !== undefined && current.billingSnapshot !== null)
    ) return Promise.resolve(undefined);
    const next = { ...current, ...clone(patch), updatedAt: new Date().toISOString() };
    if (patch.status && patch.status !== "running") {
      next.claimToken = null;
      next.claimExpiresAt = null;
    }
    this.#executions.set(id, next);
    return Promise.resolve(clone(next));
  }
  claimRecoverable(limit: number) {
    const claimed: ToolExecution[] = [];
    for (const execution of this.#executions.values()) {
      const expired = !execution.claimExpiresAt ||
        Date.parse(execution.claimExpiresAt) <= Date.now();
      if (
        (execution.status !== "queued" && !(execution.status === "running" && expired)) ||
        execution.cancellationRequestedAt ||
        claimed.length >= limit
      ) continue;
      execution.status = "running";
      execution.claimToken = crypto.randomUUID();
      execution.claimExpiresAt = new Date(Date.now() + 120_000).toISOString();
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
        .filter((execution) =>
          execution.status === "queued_pending_reservation" &&
          !execution.cancellationRequestedAt
        )
        .slice(0, limit).map(clone),
    );
  }
  listPendingCancellation(limit: number) {
    return Promise.resolve(
      [...this.#executions.values()]
        .filter((execution) =>
          execution.cancellationRequestedAt &&
          ["queued_pending_reservation", "queued"].includes(execution.status)
        )
        .slice(0, limit).map(clone),
    );
  }
  listPendingRefund(limit: number) {
    return Promise.resolve(
      [...this.#executions.values()]
        .filter((execution) =>
          ["failed_pending_refund", "cancelled_pending_refund"].includes(execution.status)
        )
        .slice(0, limit).map(clone),
    );
  }
  renewClaim(id: string, claimToken: string, leaseMs: number) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 600_000) {
      return Promise.resolve(false);
    }
    const execution = this.#executions.get(id);
    if (
      !execution || execution.status !== "running" || execution.claimToken !== claimToken
    ) return Promise.resolve(false);
    execution.claimExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    execution.updatedAt = new Date().toISOString();
    return Promise.resolve(true);
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
  readonly #definitions = new Map<string, ToolDefinition>();
  readonly #inputValidators = new Map<string, (value: unknown) => boolean>();
  readonly #active = new Map<string, AbortController>();
  readonly #billingSnapshot?: (execution: ToolExecution) => ToolBillingSnapshot;
  readonly #admit?: (execution: ToolExecution) => Promise<void>;

  constructor(
    readonly store: ToolExecutionStore,
    adapters: readonly ToolAdapter[],
    readonly controls?: {
      /** User-admission path; implementations may consume a rate-limit slot. */
      admit?(execution: ToolExecution): Promise<void>;
      billingSnapshot?(execution: ToolExecution): ToolBillingSnapshot;
      reserve(execution: ToolExecution): Promise<void>;
      /** Idempotent crash/race reconciliation; implementations must bypass request rate limits. */
      reconcileReservation(execution: ToolExecution): Promise<void>;
      settle(execution: ToolExecution, latencyMs: number): Promise<void>;
      /** Returns false only when no matching reservation existed yet. */
      refund(execution: ToolExecution, error?: string): Promise<boolean | void>;
    },
  ) {
    const persistentStore = !(store instanceof MemoryToolExecutionStore);
    if (persistentStore && !controls) {
      throw new TypeError("Persistent tool execution stores require accounting controls");
    }
    if (controls && typeof controls.reconcileReservation !== "function") {
      throw new TypeError("Tool accounting controls require internal reservation reconciliation");
    }
    if (
      persistentStore && typeof controls?.billingSnapshot !== "function"
    ) {
      throw new TypeError("Tool accounting controls require an immutable billing snapshot");
    }
    if (
      persistentStore && typeof controls?.admit !== "function"
    ) {
      throw new TypeError("Tool accounting controls require pre-reservation admission");
    }
    // Memory-only tests use an in-process accounting fake and cannot recover across a restart.
    // Persistent stores must always supply the real immutable approval-time terms above.
    this.#billingSnapshot = controls?.billingSnapshot ?? (controls
      ? (execution) => ({
        reservedMicros: 1,
        provider: "tool-test-memory",
        model: `tool/${execution.toolId}`,
      })
      : undefined);
    this.#admit = controls?.admit ?? (controls ? () => Promise.resolve() : undefined);
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.definition.id)) throw new Error("Duplicate tool adapter id");
      if (
        !(["read_only", "idempotent_by_execution_id"] as const).includes(
          adapter.definition.recoverySafety,
        )
      ) throw new Error("Tool adapter must declare safe recovery semantics");
      const compiled = compileToolInputSchema(adapter.definition.inputSchema);
      this.#adapters.set(adapter.definition.id, adapter);
      this.#definitions.set(adapter.definition.id, {
        ...adapter.definition,
        inputSchema: compiled.schema,
      });
      this.#inputValidators.set(adapter.definition.id, compiled.validate);
    }
  }

  listDefinitions() {
    return [...this.#definitions.values()].map(clone);
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
    const snapshot = boundedJsonSnapshot(input, 256_000);
    if (snapshot === undefined) {
      throw new ToolExecutionError("invalid_input", "Tool input must be bounded JSON", 422);
    }
    if (!this.#inputValidators.get(toolId)?.(snapshot)) {
      throw new ToolExecutionError(
        "invalid_input",
        "Tool input does not match the registered schema",
        422,
      );
    }
    const now = new Date().toISOString();
    return await this.store.createExecution({
      id: crypto.randomUUID(),
      ownerId,
      toolId,
      input: snapshot,
      status: "pending_approval",
      result: null,
      error: null,
      approvedAt: null,
      approvedBy: null,
      cancellationRequestedAt: null,
      billingSnapshot: null,
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
        return normalizeToolExecutionForRead(
          await this.store.transitionExecution(id, [
            "succeeded_pending_settlement",
          ], {
            status: "succeeded",
          }) ?? execution,
        );
      } catch {
        return normalizeToolExecutionForRead(execution);
      }
    }
    return normalizeToolExecutionForRead(execution);
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

  async #reconcileReservation(execution: ToolExecution) {
    if (!this.controls) return;
    this.#requireBillingSnapshot(execution);
    await this.controls.reconcileReservation(execution);
  }

  #requireBillingSnapshot(execution: ToolExecution): ToolBillingSnapshot {
    const value = execution.billingSnapshot;
    if (
      !value || !Number.isSafeInteger(value.reservedMicros) || value.reservedMicros <= 0 ||
      value.reservedMicros > Number.MAX_SAFE_INTEGER ||
      typeof value.provider !== "string" || value.provider.length < 1 ||
      value.provider.length > 255 || typeof value.model !== "string" || value.model.length < 1 ||
      value.model.length > 255
    ) throw new Error("Tool execution is missing a valid billing snapshot");
    return value;
  }

  async #refundCancellation(execution: ToolExecution, reason: string) {
    const refunded = await this.controls?.refund(execution, reason);
    if (refunded !== false) return;
    // A failed ensure is not proof that an already-admitted reservation cannot commit later. Until
    // accounting exposes a durable admission-failed fence, every failure keeps the refund outbox
    // pending so startup recovery can observe and refund a late/lost-ack debit.
    await this.#reconcileReservation(execution);
    await this.controls?.refund(execution, reason);
  }

  async #finishPendingRefund(execution: ToolExecution): Promise<ToolExecution> {
    const cancelled = execution.status === "cancelled_pending_refund";
    const normalizedError = normalizeToolExecutionError(execution.error);
    try {
      if (cancelled) {
        await this.#refundCancellation(execution, "Tool execution was cancelled");
      } else {
        await this.controls?.refund(
          execution,
          normalizedError?.message ?? TOOL_FAILURES.tool_execution_failed,
        );
      }
    } catch {
      // The pending status is the durable outbox. Recovery retries the idempotent ledger refund.
      return execution;
    }
    return await this.store.transitionExecution(
      execution.id,
      [execution.status],
      { status: cancelled ? "cancelled" : "failed" },
    ) ?? await this.store.getExecution(execution.id, execution.ownerId) ?? execution;
  }

  async recover(limit = 25) {
    const pendingRefund = await this.store.listPendingRefund?.(limit) ?? [];
    for (const execution of pendingRefund) await this.#finishPendingRefund(execution);
    const pendingCancellation = await this.store.listPendingCancellation?.(limit) ?? [];
    for (const execution of pendingCancellation) {
      try {
        const pending = await this.store.transitionExecution(
          execution.id,
          ["queued_pending_reservation", "queued"],
          { status: "cancelled_pending_refund" },
        );
        const current = pending ?? await this.store.getExecution(execution.id, execution.ownerId);
        if (current?.status === "cancelled_pending_refund") {
          await this.#finishPendingRefund(current);
        }
      } catch {
        // The cancellation marker or refund-outbox state remains durable for the next pass.
      }
    }
    const pendingReservation = await this.store.listPendingReservation?.(limit) ?? [];
    for (const execution of pendingReservation) {
      try {
        if (execution.cancellationRequestedAt) {
          const pending = await this.store.transitionExecution(execution.id, [
            "queued_pending_reservation",
          ], {
            status: "cancelled_pending_refund",
          });
          if (pending) await this.#finishPendingRefund(pending);
          continue;
        }
        await this.#reconcileReservation(execution);
        const queued = await this.store.transitionExecution(execution.id, [
          "queued_pending_reservation",
        ], {
          status: "queued",
        });
        if (!queued) {
          const current = await this.store.getExecution(execution.id, execution.ownerId);
          // Another replica may have advanced the same idempotent reservation. It owns settlement;
          // only a cancellation means the shared reservation must be refunded here.
          if (current?.status === "cancelled") {
            // Cancellation may have become terminal while this reservation acknowledgement was in
            // flight. Reconcile/refund the shared run without reopening the execution state.
            await this.#refundCancellation(execution, "Tool execution was cancelled");
          } else if (current?.status === "cancelled_pending_refund") {
            await this.#finishPendingRefund(current);
          } else if (current?.cancellationRequestedAt) {
            const pending = await this.store.transitionExecution(execution.id, [current.status], {
              status: "cancelled_pending_refund",
            });
            if (pending) await this.#finishPendingRefund(pending);
          }
        } else if (queued.cancellationRequestedAt) {
          const pending = await this.store.transitionExecution(execution.id, ["queued"], {
            status: "cancelled_pending_refund",
          });
          if (pending) await this.#finishPendingRefund(pending);
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
      if (adapter?.definition.enabled && policy?.allowed) {
        void this.#dispatch(execution, adapter, policy, true);
      } else {
        const pending = await this.store.transitionExecution(execution.id, ["running"], {
          status: "failed_pending_refund",
          error: categorizedToolFailure("tool_policy_denied"),
        }, execution.claimToken ?? undefined);
        if (pending) await this.#finishPendingRefund(pending);
      }
    }
    return pendingRefund.length + executions.length + pendingSettlement.length +
      pendingReservation.length +
      pendingCancellation.length;
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
    let accountingExecution = execution;
    let reservationMayExist = false;
    try {
      // Limiter admission is intentionally outside durable execution state. A denial or Redis
      // outage leaves no snapshot/debit for startup recovery to mistake as admitted work.
      await this.#admit?.(execution);
      const billingSnapshot = execution.billingSnapshot ??
        this.#billingSnapshot?.(execution) ??
        null;
      if (this.controls) {
        this.#requireBillingSnapshot({ ...execution, billingSnapshot });
      }
      const pending = await this.store.transitionExecution(id, ["pending_approval"], {
        status: "queued_pending_reservation",
        approvedAt: now,
        approvedBy: ownerId,
        ...(execution.billingSnapshot === null ? { billingSnapshot } : {}),
      });
      if (!pending) throw new Error("Tool execution changed");
      accountingExecution = pending;
      reservationMayExist = true;
      if (this.controls) this.#requireBillingSnapshot(pending);
      await this.controls?.reserve(pending);
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
        const current = await this.store.getExecution(id, ownerId);
        if (current?.cancellationRequestedAt) {
          const pending = await this.store.transitionExecution(id, [
            "queued_pending_reservation",
          ], {
            status: "cancelled_pending_refund",
          });
          if (pending) await this.#finishPendingRefund(pending);
        } else {
          const rolledBack = await this.store.transitionExecution(id, [
            "queued_pending_reservation",
          ], {
            status: "pending_approval",
            approvedAt: null,
            approvedBy: null,
          });
          // A cancellation marker can be written after the read above but before this status CAS.
          // The transition preserves it, so finalize rather than strand a marked pending row.
          if (rolledBack?.cancellationRequestedAt) {
            const pending = await this.store.transitionExecution(id, ["pending_approval"], {
              status: "cancelled_pending_refund",
            });
            if (pending) await this.#finishPendingRefund(pending);
          }
        }
      }
      // Approval can lose to cancellation after its debit commits or while an internal reconciler
      // is creating the same idempotent reservation. The loser must help drain the durable refund
      // outbox before returning; a rate-limit result is never evidence that no debit can arrive.
      const current = await this.store.getExecution(id, ownerId);
      if (current?.status === "cancelled_pending_refund") {
        await this.#finishPendingRefund(current);
        throw new ToolExecutionError("execution_terminal", "Tool execution was cancelled", 409);
      }
      if (current?.status === "cancelled") {
        if (reservationMayExist) {
          await this.#refundCancellation(accountingExecution, "Tool execution was cancelled");
        }
        throw new ToolExecutionError("execution_terminal", "Tool execution was cancelled", 409);
      }
      throw error;
    }
    if (queued?.cancellationRequestedAt) {
      const pendingRefund = await this.store.transitionExecution(id, ["queued"], {
        status: "cancelled_pending_refund",
      });
      if (pendingRefund) await this.#finishPendingRefund(pendingRefund);
      throw new ToolExecutionError("execution_terminal", "Tool execution was cancelled", 409);
    }
    if (!queued) {
      const current = await this.store.getExecution(id, ownerId);
      if (
        current && ["queued", "running", "succeeded_pending_settlement", "succeeded"].includes(
          current.status,
        )
      ) {
        void this.recover();
        return current;
      }
      if (current?.status === "cancelled_pending_refund") {
        await this.#finishPendingRefund(current);
        throw new ToolExecutionError("execution_terminal", "Tool execution was cancelled", 409);
      }
      if (current?.status === "cancelled") {
        // A concurrent reconciler may have finalized the refund before this approval observed it.
        await this.#refundCancellation(accountingExecution, "Tool execution was cancelled");
        throw new ToolExecutionError("execution_terminal", "Tool execution was cancelled", 409);
      }
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
    if (execution.status === "failed_pending_refund") {
      throw new ToolExecutionError("execution_terminal", "Tool execution is already complete", 409);
    }
    if (execution.status === "cancelled_pending_refund") {
      return await this.#finishPendingRefund(execution);
    }
    const now = new Date().toISOString();
    if (execution.status === "queued_pending_reservation" || execution.status === "queued") {
      const refundPending = await this.store.transitionExecution(id, [execution.status], {
        status: "cancelled_pending_refund",
        cancellationRequestedAt: now,
      });
      if (!refundPending) {
        throw new ToolExecutionError("execution_terminal", "Tool execution changed", 409);
      }
      return await this.#finishPendingRefund(refundPending);
    }
    const pendingApproval = execution.status === "pending_approval";
    const cancelled = await this.store.transitionExecution(id, [execution.status], {
      status: pendingApproval ? "cancelled" : "cancelled_pending_refund",
      cancellationRequestedAt: now,
    });
    if (!cancelled) {
      throw new ToolExecutionError("execution_terminal", "Tool execution changed", 409);
    }
    this.#active.get(id)?.abort("user_cancelled");
    return pendingApproval ? cancelled : await this.#finishPendingRefund(cancelled);
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
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const claimToken = execution.claimToken ?? undefined;
    try {
      // Fence the exact policy revision immediately before execution. An administrator can revoke
      // or narrow a policy after user approval but before this microtask begins.
      const currentPolicy = await this.store.getPolicy(execution.toolId);
      if (
        !adapter.definition.enabled || !currentPolicy?.allowed ||
        currentPolicy.version !== policy.version
      ) {
        throw new ToolAdapterError("policy_denied");
      }
      // Recovery can encounter rows created by an older deployment or imported from a backup.
      // Revalidate at the final trust boundary rather than relying only on request-time checks.
      const inputSnapshot = boundedJsonSnapshot(execution.input, 256_000);
      if (
        inputSnapshot === undefined ||
        !this.#inputValidators.get(execution.toolId)?.(inputSnapshot)
      ) {
        throw new ToolAdapterError("invalid_request");
      }
      const running = claimed ? execution : await this.store.transitionExecution(
        execution.id,
        ["queued"],
        { status: "running" },
      );
      if (!running) return;
      if (claimToken && this.store.renewClaim) {
        if (!await this.store.renewClaim(execution.id, claimToken, 120_000)) return;
        heartbeat = setInterval(() => {
          void this.store.renewClaim?.(execution.id, claimToken, 120_000).then((renewed) => {
            if (!renewed) controller.abort("claim_lost");
          }).catch(() => controller.abort("claim_renewal_failed"));
        }, 30_000);
      }
      const result = await adapter.execute(inputSnapshot, {
        executionId: execution.id,
        idempotencyKey: execution.id,
        ownerId: execution.ownerId,
        signal: controller.signal,
        policy: currentPolicy,
      });
      const resultSnapshot = boundedJsonSnapshot(result, 1_000_000);
      if (resultSnapshot === undefined) {
        throw new ToolAdapterError("invalid_response");
      }
      const recorded = await this.store.transitionExecution(execution.id, ["running"], {
        status: "succeeded_pending_settlement",
        result: resultSnapshot,
      }, claimToken);
      if (!recorded) {
        const current = await this.store.getExecution(execution.id, execution.ownerId);
        if (
          current?.status === "failed_pending_refund" ||
          current?.status === "cancelled_pending_refund"
        ) await this.#finishPendingRefund(current);
        return;
      }
      upstreamSucceeded = true;
      await this.controls?.settle(
        execution,
        Math.max(0, Math.round(performance.now() - startedAt)),
      );
      await this.store.transitionExecution(execution.id, ["succeeded_pending_settlement"], {
        status: "succeeded",
      });
    } catch (error) {
      if (upstreamSucceeded) return;
      const failure = safeAdapterFailure(error);
      const cancelled = controller.signal.aborted;
      const pending = await this.store.transitionExecution(
        execution.id,
        ["queued", "running"],
        {
          status: cancelled ? "cancelled_pending_refund" : "failed_pending_refund",
          cancellationRequestedAt: new Date().toISOString(),
          ...(cancelled ? {} : { error: failure, cancellationRequestedAt: null }),
        },
        claimToken,
      );
      if (pending) {
        await this.#finishPendingRefund(pending);
      } else {
        const current = await this.store.getExecution(execution.id, execution.ownerId);
        if (
          current?.status === "failed_pending_refund" ||
          current?.status === "cancelled_pending_refund"
        ) await this.#finishPendingRefund(current);
      }
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      this.#active.delete(execution.id);
    }
  }
}
