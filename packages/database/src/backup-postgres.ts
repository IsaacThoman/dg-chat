import postgres from "npm:postgres@3.4.7";

type Sql = ReturnType<typeof postgres>;
type JsonObject = Record<string, unknown>;

export type BackupOperationKind = "export" | "restore";
export type BackupOperationStatus =
  | "queued"
  | "running"
  | "validated"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackupOperation {
  id: string;
  kind: BackupOperationKind;
  status: BackupOperationStatus;
  version: number;
  actorId: string | null;
  actorEmail: string;
  actorName: string;
  idempotencyKey: string;
  stage: string;
  sourceObjectKey: string | null;
  artifactObjectKey: string | null;
  archiveSha256: string | null;
  options: JsonObject;
  manifest: JsonObject | null;
  impact: JsonObject | null;
  confirmationFingerprint: string | null;
  objectsProcessed: number;
  objectsTotal: number;
  bytesProcessed: number;
  bytesTotal: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  validatedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface InstallationState {
  installationId: string;
  maintenanceEnabled: boolean;
  version: number;
  restoreEpoch: number;
  activeRestoreId: string | null;
  updatedAt: string;
}

export interface CreateBackupOperationInput {
  kind: BackupOperationKind;
  actorId: string;
  idempotencyKey: string;
  options?: JsonObject;
  sourceObjectKey?: string | null;
  archiveSha256?: string | null;
}

export interface BackupProgressInput {
  stage: string;
  objectsProcessed: number;
  objectsTotal: number;
  bytesProcessed: number;
  bytesTotal: number;
  manifest?: JsonObject | null;
  impact?: JsonObject | null;
}

export interface BackupCompletionInput {
  archiveSha256: string;
  artifactObjectKey?: string | null;
  manifest?: JsonObject;
  impact?: JsonObject;
}

export type BackupFailureCode =
  | "archive_invalid"
  | "archive_unsupported"
  | "object_missing"
  | "object_mismatch"
  | "database_unavailable"
  | "operation_timed_out"
  | "internal_error";

const FAILURE_MESSAGES: Record<BackupFailureCode, string> = {
  archive_invalid: "The backup archive is invalid",
  archive_unsupported: "The backup archive version is not supported",
  object_missing: "A referenced backup object is missing",
  object_mismatch: "A referenced backup object failed integrity validation",
  database_unavailable: "The database became unavailable during the backup operation",
  operation_timed_out: "The backup operation timed out",
  internal_error: "The backup operation failed",
};

export class BackupOperationError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "BackupOperationError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupOperationError("invalid", `${field} must be an object`);
  }
  return structuredClone(value as JsonObject);
}

function validObjectKey(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.startsWith("/") &&
    !value.split("/").some((part) => !part || part === "..") &&
    ![...value].some((character) =>
      character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
    );
}

function positiveVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BackupOperationError("invalid", "Expected version must be a positive integer");
  }
}

function assertOperationId(value: string): void {
  if (!UUID.test(value)) {
    throw new BackupOperationError("invalid", "Backup operation ID is invalid");
  }
}

function mapOperation(row: Record<string, unknown>): BackupOperation {
  return {
    id: String(row.id),
    kind: row.kind as BackupOperationKind,
    status: row.status as BackupOperationStatus,
    version: Number(row.version),
    actorId: row.actor_id == null ? null : String(row.actor_id),
    actorEmail: String(row.actor_email),
    actorName: String(row.actor_name),
    idempotencyKey: String(row.idempotency_key),
    stage: String(row.stage),
    sourceObjectKey: row.source_object_key == null ? null : String(row.source_object_key),
    artifactObjectKey: row.artifact_object_key == null ? null : String(row.artifact_object_key),
    archiveSha256: row.archive_sha256 == null ? null : String(row.archive_sha256),
    options: jsonObject(row.options, "Stored backup options"),
    manifest: row.manifest == null ? null : jsonObject(row.manifest, "Stored backup manifest"),
    impact: row.impact == null ? null : jsonObject(row.impact, "Stored restore impact"),
    confirmationFingerprint: row.confirmation_fingerprint == null
      ? null
      : String(row.confirmation_fingerprint),
    objectsProcessed: Number(row.objects_processed),
    objectsTotal: Number(row.objects_total),
    bytesProcessed: Number(row.bytes_processed),
    bytesTotal: Number(row.bytes_total),
    error: row.error == null ? null : String(row.error),
    createdAt: iso(row.created_at),
    startedAt: nullableIso(row.started_at),
    validatedAt: nullableIso(row.validated_at),
    completedAt: nullableIso(row.completed_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapInstallation(row: Record<string, unknown>): InstallationState {
  return {
    installationId: String(row.installation_id),
    maintenanceEnabled: Boolean(row.maintenance_enabled),
    version: Number(row.version),
    restoreEpoch: Number(row.restore_epoch),
    activeRestoreId: row.active_restore_id == null ? null : String(row.active_restore_id),
    updatedAt: iso(row.updated_at),
  };
}

/** Durable PostgreSQL control plane for backup jobs and maintenance-fenced restores. */
export class PostgresBackupStore {
  readonly #sql: Sql;

  private constructor(sql: Sql) {
    this.#sql = sql;
  }

  static async connect(url: string): Promise<PostgresBackupStore> {
    const sql = postgres(url, { max: 5 });
    await sql`SELECT 1`;
    return new PostgresBackupStore(sql);
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async installationState(): Promise<InstallationState> {
    const [row] = await this.#sql<Record<string, unknown>[]>`
      SELECT * FROM installation_state WHERE singleton_id=1
    `;
    if (!row) throw new BackupOperationError("not_found", "Installation state is missing");
    return mapInstallation(row);
  }

  async create(input: CreateBackupOperationInput): Promise<BackupOperation> {
    if (!UUID.test(input.actorId)) throw new BackupOperationError("invalid", "Actor ID is invalid");
    if (!["export", "restore"].includes(input.kind)) {
      throw new BackupOperationError("invalid", "Backup operation kind is invalid");
    }
    if (
      input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 ||
      [...input.idempotencyKey].some((part) =>
        part.charCodeAt(0) <= 31 || part.charCodeAt(0) === 127
      )
    ) throw new BackupOperationError("invalid", "Idempotency key is invalid");
    if (input.sourceObjectKey != null && !validObjectKey(input.sourceObjectKey)) {
      throw new BackupOperationError("invalid", "Source object key is invalid");
    }
    if (input.archiveSha256 != null && !SHA256.test(input.archiveSha256)) {
      throw new BackupOperationError("invalid", "Archive digest is invalid");
    }
    const options = jsonObject(input.options ?? {}, "Backup options");
    return await this.#sql.begin(async (tx) => {
      const inserted = await tx<Record<string, unknown>[]>`
        INSERT INTO backup_operations(
          kind,actor_id,actor_email,actor_name,idempotency_key,options,
          source_object_key,archive_sha256
        ) SELECT ${input.kind},u.id,u.email,u.name,${input.idempotencyKey},
          ${tx.json(options as never)},${input.sourceObjectKey ?? null},
          ${input.archiveSha256 ?? null}
        FROM users u WHERE u.id=${input.actorId}
        ON CONFLICT(actor_id,kind,idempotency_key) DO NOTHING RETURNING *
      `;
      if (inserted[0]) return mapOperation(inserted[0]);
      const [existing] = await tx<Record<string, unknown>[]>`
        SELECT *, options=${tx.json(options as never)}::jsonb AS options_match
        FROM backup_operations
        WHERE actor_id=${input.actorId} AND kind=${input.kind}
          AND idempotency_key=${input.idempotencyKey} FOR UPDATE
      `;
      if (!existing) {
        throw new BackupOperationError("not_found", "Backup operation actor was not found");
      }
      if (
        existing.source_object_key !== (input.sourceObjectKey ?? null) ||
        existing.archive_sha256 !== (input.archiveSha256 ?? null) || existing.options_match !== true
      ) {
        throw new BackupOperationError(
          "conflict",
          "Idempotency key was reused with different input",
        );
      }
      return mapOperation(existing);
    });
  }

  async get(id: string): Promise<BackupOperation> {
    assertOperationId(id);
    const [row] = await this.#sql<Record<string, unknown>[]>`
      SELECT * FROM backup_operations WHERE id=${id}
    `;
    if (!row) throw new BackupOperationError("not_found", "Backup operation was not found");
    return mapOperation(row);
  }

  async findByIdempotency(
    actorId: string,
    kind: BackupOperationKind,
    idempotencyKey: string,
  ): Promise<BackupOperation | undefined> {
    if (!UUID.test(actorId)) throw new BackupOperationError("invalid", "Actor ID is invalid");
    if (!["export", "restore"].includes(kind)) {
      throw new BackupOperationError("invalid", "Backup operation kind is invalid");
    }
    if (
      idempotencyKey.length < 8 || idempotencyKey.length > 200 ||
      [...idempotencyKey].some((part) => part.charCodeAt(0) <= 31 || part.charCodeAt(0) === 127)
    ) throw new BackupOperationError("invalid", "Idempotency key is invalid");
    const [row] = await this.#sql<Record<string, unknown>[]>`
      SELECT * FROM backup_operations
      WHERE actor_id=${actorId} AND kind=${kind} AND idempotency_key=${idempotencyKey}
    `;
    return row ? mapOperation(row) : undefined;
  }

  async list(kind?: BackupOperationKind, limit = 50): Promise<BackupOperation[]> {
    if (kind !== undefined && !["export", "restore"].includes(kind)) {
      throw new BackupOperationError("invalid", "Backup operation kind is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BackupOperationError("invalid", "Backup operation limit must be between 1 and 100");
    }
    const rows = await this.#sql<Record<string, unknown>[]>`
      SELECT * FROM backup_operations
      WHERE (${kind ?? null}::text IS NULL OR kind=${kind ?? null})
      ORDER BY created_at DESC,id DESC LIMIT ${limit}
    `;
    return rows.map(mapOperation);
  }

  async claim(id: string, expectedVersion: number): Promise<BackupOperation> {
    assertOperationId(id);
    positiveVersion(expectedVersion);
    const [row] = await this.#sql<Record<string, unknown>[]>`
      UPDATE backup_operations SET status='running',stage='starting',started_at=now(),
        updated_at=now(),version=version+1
      WHERE id=${id} AND status='queued' AND version=${expectedVersion}
      RETURNING *
    `;
    if (!row) throw new BackupOperationError("conflict", "Backup operation claim is stale");
    return mapOperation(row);
  }

  async updateProgress(
    id: string,
    expectedVersion: number,
    input: BackupProgressInput,
  ): Promise<BackupOperation> {
    assertOperationId(id);
    positiveVersion(expectedVersion);
    if (!input.stage || input.stage.length > 80) {
      throw new BackupOperationError("invalid", "Backup operation stage is invalid");
    }
    for (
      const value of [
        input.objectsProcessed,
        input.objectsTotal,
        input.bytesProcessed,
        input.bytesTotal,
      ]
    ) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new BackupOperationError("invalid", "Backup operation progress is invalid");
      }
    }
    if (
      input.objectsProcessed > input.objectsTotal || input.bytesProcessed > input.bytesTotal
    ) throw new BackupOperationError("invalid", "Backup operation progress exceeds its total");
    const manifest = input.manifest == null ? null : jsonObject(input.manifest, "Backup manifest");
    const impact = input.impact == null ? null : jsonObject(input.impact, "Restore impact");
    const [row] = await this.#sql<Record<string, unknown>[]>`
      UPDATE backup_operations SET stage=${input.stage},
        objects_processed=${input.objectsProcessed},objects_total=${input.objectsTotal},
        bytes_processed=${input.bytesProcessed},bytes_total=${input.bytesTotal},
        manifest=COALESCE(${manifest ? this.#sql.json(manifest as never) : null},manifest),
        impact=COALESCE(${impact ? this.#sql.json(impact as never) : null},impact),
        updated_at=now(),version=version+1
      WHERE id=${id} AND status='running' AND version=${expectedVersion}
        AND objects_processed <= ${input.objectsProcessed}
        AND objects_total IN (0,${input.objectsTotal})
        AND bytes_processed <= ${input.bytesProcessed}
        AND bytes_total IN (0,${input.bytesTotal})
      RETURNING *
    `;
    if (!row) throw new BackupOperationError("conflict", "Backup progress update is stale");
    return mapOperation(row);
  }

  async validateRestore(
    id: string,
    expectedVersion: number,
    input: { archiveSha256: string; manifest: JsonObject; impact: JsonObject },
  ): Promise<BackupOperation> {
    assertOperationId(id);
    positiveVersion(expectedVersion);
    if (!SHA256.test(input.archiveSha256)) {
      throw new BackupOperationError("invalid", "Archive digest is invalid");
    }
    const manifest = jsonObject(input.manifest, "Backup manifest");
    const impact = jsonObject(input.impact, "Restore impact");
    const fingerprint = input.archiveSha256.slice(0, 8).toUpperCase();
    const [row] = await this.#sql<Record<string, unknown>[]>`
      UPDATE backup_operations SET status='validated',stage='validated',
        archive_sha256=${input.archiveSha256},manifest=${this.#sql.json(manifest as never)},
        impact=${this.#sql.json(impact as never)},confirmation_fingerprint=${fingerprint},
        validated_at=now(),updated_at=now(),version=version+1
      WHERE id=${id} AND kind='restore' AND status='running' AND version=${expectedVersion}
        AND (archive_sha256 IS NULL OR archive_sha256=${input.archiveSha256})
        AND objects_processed=objects_total AND bytes_processed=bytes_total
      RETURNING *
    `;
    if (!row) {
      throw new BackupOperationError("conflict", "Restore validation is stale or incomplete");
    }
    return mapOperation(row);
  }

  async beginRestoreApply(
    id: string,
    expectedVersion: number,
    confirmationFingerprint: string,
  ): Promise<BackupOperation> {
    assertOperationId(id);
    positiveVersion(expectedVersion);
    if (!/^[A-F0-9]{8}$/u.test(confirmationFingerprint)) {
      throw new BackupOperationError("invalid", "Restore confirmation fingerprint is invalid");
    }
    const [row] = await this.#sql<Record<string, unknown>[]>`
      UPDATE backup_operations SET status='running',stage='restore_staging',
        updated_at=now(),version=version+1
      WHERE id=${id} AND kind='restore' AND status='validated' AND version=${expectedVersion}
        AND confirmation_fingerprint=${confirmationFingerprint}
      RETURNING *
    `;
    if (!row) {
      throw new BackupOperationError(
        "conflict",
        "Restore confirmation is stale or does not match the validated archive",
      );
    }
    return mapOperation(row);
  }

  async complete(
    id: string,
    expectedVersion: number,
    input: BackupCompletionInput,
  ): Promise<BackupOperation> {
    assertOperationId(id);
    positiveVersion(expectedVersion);
    if (!SHA256.test(input.archiveSha256)) {
      throw new BackupOperationError("invalid", "Archive digest is invalid");
    }
    if (input.artifactObjectKey != null && !validObjectKey(input.artifactObjectKey)) {
      throw new BackupOperationError("invalid", "Artifact object key is invalid");
    }
    const manifest = input.manifest ? jsonObject(input.manifest, "Backup manifest") : null;
    const impact = input.impact ? jsonObject(input.impact, "Restore impact") : null;
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
      const active = await tx`SELECT 1 FROM installation_state
        WHERE singleton_id=1 AND active_restore_id=${id}`;
      if (active.length) {
        throw new BackupOperationError(
          "conflict",
          "Active restore maintenance must end before completion",
        );
      }
      const [row] = await tx<Record<string, unknown>[]>`
        UPDATE backup_operations SET status='completed',stage='completed',
          archive_sha256=${input.archiveSha256},artifact_object_key=${
        input.artifactObjectKey ?? null
      },
          manifest=COALESCE(${manifest ? tx.json(manifest as never) : null},manifest),
          impact=COALESCE(${impact ? tx.json(impact as never) : null},impact),
          completed_at=now(),updated_at=now(),version=version+1
        WHERE id=${id} AND kind='export' AND status='running' AND version=${expectedVersion}
          AND (archive_sha256 IS NULL OR archive_sha256=${input.archiveSha256})
          AND objects_processed=objects_total AND bytes_processed=bytes_total
        RETURNING *
      `;
      if (!row) {
        throw new BackupOperationError("conflict", "Backup completion is stale or incomplete");
      }
      return mapOperation(row);
    });
  }

  async finishRestore(
    operationId: string,
    expectedOperationVersion: number,
    expectedInstallationVersion: number,
    input: BackupCompletionInput,
  ): Promise<{ operation: BackupOperation; installation: InstallationState }> {
    assertOperationId(operationId);
    positiveVersion(expectedOperationVersion);
    positiveVersion(expectedInstallationVersion);
    if (!SHA256.test(input.archiveSha256)) {
      throw new BackupOperationError("invalid", "Archive digest is invalid");
    }
    if (input.artifactObjectKey != null && !validObjectKey(input.artifactObjectKey)) {
      throw new BackupOperationError("invalid", "Artifact object key is invalid");
    }
    const manifest = input.manifest ? jsonObject(input.manifest, "Backup manifest") : null;
    const impact = input.impact ? jsonObject(input.impact, "Restore impact") : null;
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
      const [installation] = await tx<Record<string, unknown>[]>`
        UPDATE installation_state SET maintenance_enabled=false,active_restore_id=NULL,
          version=version+1,updated_at=now()
        WHERE singleton_id=1 AND maintenance_enabled=true AND active_restore_id=${operationId}
          AND version=${expectedInstallationVersion}
        RETURNING *
      `;
      if (!installation) {
        throw new BackupOperationError("conflict", "Restore maintenance completion is stale");
      }
      const [operation] = await tx<Record<string, unknown>[]>`
        UPDATE backup_operations SET status='completed',stage='completed',
          archive_sha256=${input.archiveSha256},artifact_object_key=${
        input.artifactObjectKey ?? null
      },
          manifest=COALESCE(${manifest ? tx.json(manifest as never) : null},manifest),
          impact=COALESCE(${impact ? tx.json(impact as never) : null},impact),
          completed_at=now(),updated_at=now(),version=version+1
        WHERE id=${operationId} AND kind='restore' AND status='running'
          AND stage='database_restored'
          AND version=${expectedOperationVersion}
          AND (archive_sha256 IS NULL OR archive_sha256=${input.archiveSha256})
          AND objects_processed=objects_total AND bytes_processed=bytes_total
        RETURNING *
      `;
      if (!operation) {
        throw new BackupOperationError("conflict", "Restore completion is stale or incomplete");
      }
      return { operation: mapOperation(operation), installation: mapInstallation(installation) };
    });
  }

  async failRestore(
    operationId: string,
    expectedOperationVersion: number,
    expectedInstallationVersion: number,
    code: BackupFailureCode,
  ): Promise<{ operation: BackupOperation; installation: InstallationState }> {
    assertOperationId(operationId);
    positiveVersion(expectedOperationVersion);
    positiveVersion(expectedInstallationVersion);
    const message = FAILURE_MESSAGES[code];
    if (!message) throw new BackupOperationError("invalid", "Backup failure code is invalid");
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
      const [installation] = await tx<Record<string, unknown>[]>`
        UPDATE installation_state SET maintenance_enabled=false,active_restore_id=NULL,
          version=version+1,updated_at=now()
        WHERE singleton_id=1 AND maintenance_enabled=true AND active_restore_id=${operationId}
          AND version=${expectedInstallationVersion}
        RETURNING *
      `;
      if (!installation) {
        throw new BackupOperationError("conflict", "Restore maintenance failure release is stale");
      }
      const [operation] = await tx<Record<string, unknown>[]>`
        UPDATE backup_operations SET status='failed',stage='failed',error=${message},
          completed_at=now(),updated_at=now(),version=version+1
        WHERE id=${operationId} AND kind='restore' AND status='running'
          AND stage<>'database_restored'
          AND version=${expectedOperationVersion} RETURNING *
      `;
      if (!operation) throw new BackupOperationError("conflict", "Restore failure update is stale");
      return { operation: mapOperation(operation), installation: mapInstallation(installation) };
    });
  }

  async fail(
    id: string,
    expectedVersion: number,
    code: BackupFailureCode,
  ): Promise<BackupOperation> {
    assertOperationId(id);
    positiveVersion(expectedVersion);
    const message = FAILURE_MESSAGES[code];
    if (!message) throw new BackupOperationError("invalid", "Backup failure code is invalid");
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
      const active = await tx`SELECT 1 FROM installation_state
        WHERE singleton_id=1 AND active_restore_id=${id}`;
      if (active.length) {
        throw new BackupOperationError(
          "conflict",
          "Active restore maintenance must end before failure",
        );
      }
      const [row] = await tx<Record<string, unknown>[]>`
        UPDATE backup_operations SET status='failed',stage='failed',error=${message},
          completed_at=now(),updated_at=now(),version=version+1
        WHERE id=${id} AND status='running' AND stage<>'database_restored'
          AND version=${expectedVersion} RETURNING *
      `;
      if (!row) throw new BackupOperationError("conflict", "Backup failure update is stale");
      return mapOperation(row);
    });
  }

  async cancel(id: string, expectedVersion: number): Promise<BackupOperation> {
    assertOperationId(id);
    positiveVersion(expectedVersion);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
      const active = await tx`SELECT 1 FROM installation_state
        WHERE singleton_id=1 AND active_restore_id=${id}`;
      if (active.length) {
        throw new BackupOperationError("conflict", "An active restore cannot be cancelled");
      }
      const [row] = await tx<Record<string, unknown>[]>`
        UPDATE backup_operations SET status='cancelled',stage='cancelled',
          completed_at=now(),updated_at=now(),version=version+1
        WHERE id=${id} AND status IN ('queued','running','validated')
          AND stage<>'database_restored'
          AND version=${expectedVersion} RETURNING *
      `;
      if (!row) throw new BackupOperationError("conflict", "Backup cancellation is stale");
      return mapOperation(row);
    });
  }

  async beginRestoreMaintenance(
    operationId: string,
    expectedOperationVersion: number,
  ): Promise<{ operation: BackupOperation; installation: InstallationState }> {
    assertOperationId(operationId);
    positiveVersion(expectedOperationVersion);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
      const [operation] = await tx<Record<string, unknown>[]>`
        SELECT * FROM backup_operations WHERE id=${operationId} FOR UPDATE
      `;
      if (
        !operation || operation.kind !== "restore" || operation.status !== "running" ||
        Number(operation.version) !== expectedOperationVersion
      ) throw new BackupOperationError("conflict", "Restore operation is stale or not running");
      const [state] = await tx<Record<string, unknown>[]>`
        SELECT * FROM installation_state WHERE singleton_id=1 FOR UPDATE
      `;
      if (!state) throw new BackupOperationError("not_found", "Installation state is missing");
      if (state.active_restore_id != null && String(state.active_restore_id) !== operationId) {
        throw new BackupOperationError("conflict", "Another restore owns maintenance mode");
      }
      if (String(state.active_restore_id ?? "") === operationId) {
        return { operation: mapOperation(operation), installation: mapInstallation(state) };
      }
      const [updated] = await tx<Record<string, unknown>[]>`
        UPDATE installation_state SET maintenance_enabled=true,active_restore_id=${operationId},
          restore_epoch=restore_epoch+1,version=version+1,updated_at=now()
        WHERE singleton_id=1 AND maintenance_enabled=false AND active_restore_id IS NULL
        RETURNING *
      `;
      if (!updated) {
        throw new BackupOperationError("conflict", "Installation maintenance state changed");
      }
      return { operation: mapOperation(operation), installation: mapInstallation(updated) };
    });
  }

  async endRestoreMaintenance(
    operationId: string,
    expectedInstallationVersion: number,
  ): Promise<InstallationState> {
    assertOperationId(operationId);
    positiveVersion(expectedInstallationVersion);
    return await this.#sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
      const [row] = await tx<Record<string, unknown>[]>`
        UPDATE installation_state SET maintenance_enabled=false,active_restore_id=NULL,
          version=version+1,updated_at=now()
        WHERE singleton_id=1 AND maintenance_enabled=true AND active_restore_id=${operationId}
          AND version=${expectedInstallationVersion}
        RETURNING *
      `;
      if (!row) throw new BackupOperationError("conflict", "Restore maintenance release is stale");
      return mapInstallation(row);
    });
  }
}
