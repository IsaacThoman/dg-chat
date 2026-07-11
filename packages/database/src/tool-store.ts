import postgres from "npm:postgres@3.4.7";

export type StoredToolExecutionStatus =
  | "pending_approval"
  | "queued"
  | "running"
  | "succeeded_pending_settlement"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface StoredToolPolicy {
  toolId: string;
  allowed: boolean;
  allowedDomains: string[];
  allowPrivateNetwork: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface StoredToolExecution {
  id: string;
  ownerId: string;
  toolId: string;
  input: unknown;
  status: StoredToolExecutionStatus;
  result: unknown | null;
  error: { code: string; message: string } | null;
  approvedAt: string | null;
  approvedBy: string | null;
  cancellationRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const nullableIso = (value: unknown) => value == null ? null : iso(value);
const policy = (row: Row): StoredToolPolicy => ({
  toolId: String(row.tool_id),
  allowed: Boolean(row.allowed),
  allowedDomains: Array.isArray(row.allowed_domains) ? row.allowed_domains.map(String) : [],
  allowPrivateNetwork: Boolean(row.allow_private_network),
  version: Number(row.version),
  updatedAt: iso(row.updated_at),
  updatedBy: String(row.updated_by),
});
const execution = (row: Row): StoredToolExecution => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  toolId: String(row.tool_id),
  input: row.input,
  status: String(row.status) as StoredToolExecutionStatus,
  result: row.result ?? null,
  error: row.error as StoredToolExecution["error"] ?? null,
  approvedAt: nullableIso(row.approved_at),
  approvedBy: row.approved_by == null ? null : String(row.approved_by),
  cancellationRequestedAt: nullableIso(row.cancellation_requested_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

/** Durable tool state with database-level CAS and ownership-scoped reads. */
export class PostgresToolExecutionStore {
  readonly #sql: postgres.Sql;

  private constructor(sql: postgres.Sql) {
    this.#sql = sql;
  }

  static connect(url: string) {
    return new PostgresToolExecutionStore(postgres(url, { max: 4 }));
  }

  async close() {
    await this.#sql.end();
  }

  async listPolicies(): Promise<StoredToolPolicy[]> {
    return (await this.#sql`SELECT * FROM tool_policies ORDER BY tool_id`).map(policy);
  }

  async getPolicy(toolId: string): Promise<StoredToolPolicy | undefined> {
    const [row] = await this.#sql`SELECT * FROM tool_policies WHERE tool_id = ${toolId}`;
    return row ? policy(row) : undefined;
  }

  async putPolicy(
    value: Omit<StoredToolPolicy, "version" | "updatedAt">,
    expectedVersion?: number,
  ): Promise<StoredToolPolicy> {
    const expected = expectedVersion ?? 0;
    const rows = await this.#sql.begin(async (tx) => {
      const result = expected === 0
        ? await tx`
          INSERT INTO tool_policies
          (tool_id, allowed, allowed_domains, allow_private_network, version, updated_by)
          VALUES (${value.toolId}, ${value.allowed}, ${tx.json(value.allowedDomains)},
          ${value.allowPrivateNetwork}, 1, ${value.updatedBy}::uuid
          ) ON CONFLICT (tool_id) DO NOTHING RETURNING *`
        : await tx`
          UPDATE tool_policies SET
          allowed = ${value.allowed},
          allowed_domains = ${tx.json(value.allowedDomains)},
          allow_private_network = ${value.allowPrivateNetwork},
          version = tool_policies.version + 1,
          updated_by = ${value.updatedBy}::uuid,
          updated_at = now()
        WHERE tool_id = ${value.toolId} AND version = ${expected}
        RETURNING *`;
      if (result.length) {
        await tx`
          INSERT INTO audit_events(actor_id, action, target_type, target_id, metadata)
          VALUES (${value.updatedBy}::uuid, 'tool.policy.updated', 'tool_policy', ${value.toolId},
            ${
          tx.json({
            allowed: value.allowed,
            allowedDomains: value.allowedDomains,
            allowPrivateNetwork: value.allowPrivateNetwork,
            version: Number(result[0].version),
          })
        })`;
      }
      return result;
    });
    if (!rows.length) {
      const error = new Error("Tool policy changed in another session");
      error.name = "ToolPolicyVersionConflict";
      throw error;
    }
    return policy(rows[0]);
  }

  async createExecution(value: StoredToolExecution): Promise<StoredToolExecution> {
    const [row] = await this.#sql`
      INSERT INTO tool_executions
        (id, owner_id, tool_id, input, status, result, error, approved_at, approved_by,
         cancellation_requested_at, created_at, updated_at)
      VALUES (${value.id}::uuid, ${value.ownerId}::uuid, ${value.toolId}, ${
      this.#sql.json(value.input as never)
    },
        ${value.status}, ${value.result == null ? null : this.#sql.json(value.result as never)},
        ${value.error == null ? null : this.#sql.json(value.error)}, ${value.approvedAt},
        ${value.approvedBy}::uuid, ${value.cancellationRequestedAt}, ${value.createdAt}, ${value.updatedAt})
      RETURNING *`;
    return execution(row);
  }

  async getExecution(id: string, ownerId?: string): Promise<StoredToolExecution | undefined> {
    const rows = ownerId
      ? await this
        .#sql`SELECT * FROM tool_executions WHERE id = ${id}::uuid AND owner_id = ${ownerId}::uuid`
      : await this.#sql`SELECT * FROM tool_executions WHERE id = ${id}::uuid`;
    return rows[0] ? execution(rows[0]) : undefined;
  }

  async transitionExecution(
    id: string,
    expected: readonly StoredToolExecutionStatus[],
    patch: Partial<Omit<StoredToolExecution, "id" | "ownerId" | "toolId" | "input" | "createdAt">>,
  ): Promise<StoredToolExecution | undefined> {
    const row = await this.#sql.begin(async (tx) => {
      const [updated] = await tx`
        UPDATE tool_executions SET
        status = COALESCE(${patch.status ?? null}, status),
        result = CASE WHEN ${patch.result === undefined} THEN result
          ELSE ${patch.result == null ? null : tx.json(patch.result as never)} END,
        error = CASE WHEN ${patch.error === undefined} THEN error
          ELSE ${patch.error == null ? null : tx.json(patch.error)} END,
        approved_at = CASE WHEN ${patch.approvedAt === undefined} THEN approved_at
          ELSE ${patch.approvedAt ?? null}::timestamptz END,
        approved_by = CASE WHEN ${patch.approvedBy === undefined} THEN approved_by
          ELSE ${patch.approvedBy ?? null}::uuid END,
        cancellation_requested_at = CASE WHEN ${patch.cancellationRequestedAt === undefined}
          THEN cancellation_requested_at ELSE ${
        patch.cancellationRequestedAt ?? null
      }::timestamptz END,
        updated_at = now()
      WHERE id = ${id}::uuid AND status = ANY(${expected as string[]})
      RETURNING *`;
      if (updated && patch.status && patch.status !== "running") {
        await tx`
          INSERT INTO audit_events(actor_id, action, target_type, target_id, metadata)
          VALUES (${String(updated.owner_id)}::uuid, ${`tool.execution.${patch.status}`},
            'tool_execution', ${id}, ${tx.json({ toolId: String(updated.tool_id) })})`;
      }
      return updated;
    });
    if (!row) return undefined;
    return execution(row);
  }

  async linkExecutions(ownerId: string, messageId: string, executionIds: readonly string[]) {
    await this.#sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM tool_executions
        WHERE owner_id=${ownerId}::uuid AND status='succeeded'
          AND id=ANY(${executionIds as string[]}::uuid[]) FOR UPDATE`;
      if (rows.length !== executionIds.length) throw new Error("Tool execution linkage is invalid");
      for (const executionId of executionIds) {
        await tx`INSERT INTO message_tool_executions(message_id,execution_id)
          VALUES(${messageId}::uuid,${executionId}::uuid) ON CONFLICT DO NOTHING`;
      }
    });
  }

  async claimRecoverable(limit: number): Promise<StoredToolExecution[]> {
    return await this.#sql.begin(async (tx) => {
      const claimToken = crypto.randomUUID();
      const rows = await tx`
        WITH candidates AS (
          SELECT id FROM tool_executions
          WHERE status='queued' OR (status='running' AND
            (claim_expires_at IS NULL OR claim_expires_at < now()))
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit}
        )
        UPDATE tool_executions e SET status='running',claim_token=${claimToken}::uuid,
          claim_expires_at=now()+interval '2 minutes',updated_at=now()
        FROM candidates c WHERE e.id=c.id RETURNING e.*`;
      return rows.map(execution);
    });
  }

  async listPendingSettlement(limit: number): Promise<StoredToolExecution[]> {
    return (await this.#sql`SELECT * FROM tool_executions
      WHERE status='succeeded_pending_settlement' ORDER BY updated_at LIMIT ${limit}`)
      .map(execution);
  }
}
