import postgres from "npm:postgres@3.4.7";
import type { ProviderCredentialEnvelope } from "./repository.ts";

type Sql = ReturnType<typeof postgres>;
type JsonObject = Record<string, unknown>;
type Row = Record<string, unknown>;

export type RestoreProviderSecretsStatus =
  | "uploaded"
  | "validated"
  | "applied"
  | "failed"
  | "cancelled";

export interface RestoreProviderSecretsAttachment {
  id: string;
  restoreOperationId: string;
  status: RestoreProviderSecretsStatus;
  version: number;
  idempotencyKey: string;
  requestedBy: string | null;
  appliedBy: string | null;
  sourceObjectKey: string;
  archiveSha256: string;
  archiveBytes: number;
  sidecarId: string;
  recoveryKeyId: string;
  baseBackupId: string;
  baseArchiveSha256: string;
  baseContentRootSha256: string;
  sourceInstallationId: string;
  recordCount: number | null;
  recordsSha256: string | null;
  providerStateSha256: string | null;
  impact: JsonObject | null;
  error: string | null;
  cleanupCheckedAt: string | null;
  cleanupLeaseToken: string | null;
  cleanupLeaseExpiresAt: string | null;
  createdAt: string;
  validatedAt: string | null;
  appliedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface CreateRestoreProviderSecretsAttachment {
  restoreOperationId: string;
  requestedBy: string;
  idempotencyKey: string;
  sourceObjectKey: string;
  archiveSha256: string;
  archiveBytes: number;
  sidecarId: string;
  recoveryKeyId: string;
  baseBackupId: string;
  baseArchiveSha256: string;
  baseContentRootSha256: string;
  sourceInstallationId: string;
}

export interface ValidateRestoreProviderSecretsAttachment {
  recordCount: number;
  recordsSha256: string;
  providerStateSha256: string;
  impact: JsonObject;
}

export interface RestoredProviderCredential {
  providerId: string;
  expectedVersion: number;
  envelope: ProviderCredentialEnvelope;
}

export class RestoreProviderSecretsStoreError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "RestoreProviderSecretsStoreError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function validObjectKey(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.startsWith("/") &&
    !value.split("/").some((part) => !part || part === "..") &&
    ![...value].some((character) =>
      character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
    );
}

function positiveVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RestoreProviderSecretsStoreError("invalid", "Expected version is invalid");
  }
}

function json(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RestoreProviderSecretsStoreError("invalid", `${label} is invalid`);
  }
  return structuredClone(value as JsonObject);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function map(row: Row): RestoreProviderSecretsAttachment {
  return {
    id: String(row.id),
    restoreOperationId: String(row.restore_operation_id),
    status: row.status as RestoreProviderSecretsStatus,
    version: Number(row.version),
    idempotencyKey: String(row.idempotency_key),
    requestedBy: row.requested_by == null ? null : String(row.requested_by),
    appliedBy: row.applied_by == null ? null : String(row.applied_by),
    sourceObjectKey: String(row.source_object_key),
    archiveSha256: String(row.archive_sha256),
    archiveBytes: Number(row.archive_bytes),
    sidecarId: String(row.sidecar_id),
    recoveryKeyId: String(row.recovery_key_id),
    baseBackupId: String(row.base_backup_id),
    baseArchiveSha256: String(row.base_archive_sha256),
    baseContentRootSha256: String(row.base_content_root_sha256),
    sourceInstallationId: String(row.source_installation_id),
    recordCount: row.record_count == null ? null : Number(row.record_count),
    recordsSha256: row.records_sha256 == null ? null : String(row.records_sha256),
    providerStateSha256: row.provider_state_sha256 == null
      ? null
      : String(row.provider_state_sha256),
    impact: row.impact == null ? null : json(row.impact, "Stored sidecar impact"),
    error: row.error == null ? null : String(row.error),
    cleanupCheckedAt: nullableIso(row.cleanup_checked_at),
    cleanupLeaseToken: row.cleanup_lease_token == null ? null : String(row.cleanup_lease_token),
    cleanupLeaseExpiresAt: nullableIso(row.cleanup_lease_expires_at),
    createdAt: iso(row.created_at),
    validatedAt: nullableIso(row.validated_at),
    appliedAt: nullableIso(row.applied_at),
    completedAt: nullableIso(row.completed_at),
    updatedAt: iso(row.updated_at),
  };
}

function validateCreate(input: CreateRestoreProviderSecretsAttachment): void {
  if (
    !UUID.test(input.restoreOperationId) || !UUID.test(input.requestedBy) ||
    !UUID.test(input.sidecarId) || !UUID.test(input.baseBackupId) ||
    !UUID.test(input.sourceInstallationId) ||
    input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 ||
    !validObjectKey(input.sourceObjectKey) || !SHA256.test(input.archiveSha256) ||
    !SHA256.test(input.baseArchiveSha256) || !SHA256.test(input.baseContentRootSha256) ||
    !Number.isSafeInteger(input.archiveBytes) || input.archiveBytes < 1 ||
    !KEY_ID.test(input.recoveryKeyId)
  ) throw new RestoreProviderSecretsStoreError("invalid", "Restore sidecar metadata is invalid");
}

function assertEnvelope(value: ProviderCredentialEnvelope, expectedVersion: number): void {
  const encoded = [value.wrappedKeyNonce, value.wrappedKey, value.contentNonce, value.ciphertext];
  if (
    value.version !== 1 || value.algorithm !== "AES-256-GCM" ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(value.keyId) ||
    value.credentialVersion !== expectedVersion ||
    encoded.some((part) =>
      typeof part !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(part) || part.length > 65_536
    )
  ) throw new RestoreProviderSecretsStoreError("invalid", "Provider envelope is invalid");
}

/** Durable destination control plane for encrypted provider-secret restore attachments. */
export class PostgresRestoreProviderSecretsStore {
  readonly #sql: Sql;

  private constructor(sql: Sql) {
    this.#sql = sql;
  }

  static async connect(databaseUrl: string) {
    const sql = postgres(databaseUrl, { max: 4 });
    await sql`SELECT 1`;
    return new PostgresRestoreProviderSecretsStore(sql);
  }

  close() {
    return this.#sql.end({ timeout: 5 });
  }

  async get(id: string): Promise<RestoreProviderSecretsAttachment> {
    if (!UUID.test(id)) {
      throw new RestoreProviderSecretsStoreError("invalid", "Sidecar ID is invalid");
    }
    const [row] = await this.#sql<
      Row[]
    >`SELECT * FROM backup_restore_secret_sidecars WHERE id=${id}`;
    if (!row) {
      throw new RestoreProviderSecretsStoreError("not_found", "Restore sidecar was not found");
    }
    return map(row);
  }

  async findByIdempotency(restoreOperationId: string, idempotencyKey: string) {
    if (
      !UUID.test(restoreOperationId) || idempotencyKey.length < 8 || idempotencyKey.length > 200
    ) {
      throw new RestoreProviderSecretsStoreError("invalid", "Restore sidecar lookup is invalid");
    }
    const [row] = await this.#sql<Row[]>`
      SELECT * FROM backup_restore_secret_sidecars
      WHERE restore_operation_id=${restoreOperationId} AND idempotency_key=${idempotencyKey}`;
    return row ? map(row) : undefined;
  }

  async create(input: CreateRestoreProviderSecretsAttachment) {
    validateCreate(input);
    return await this.#sql.begin(async (tx) => {
      const [restore] = await tx<Row[]>`
        SELECT kind,status,archive_sha256,manifest FROM backup_operations
        WHERE id=${input.restoreOperationId} FOR SHARE`;
      if (!restore) {
        throw new RestoreProviderSecretsStoreError("not_found", "Base restore was not found");
      }
      const manifest = restore.manifest == null ? null : json(restore.manifest, "Base manifest");
      const source = manifest?.source && typeof manifest.source === "object" &&
          !Array.isArray(manifest.source)
        ? manifest.source as JsonObject
        : null;
      if (
        restore.kind !== "restore" || restore.status !== "completed" ||
        restore.archive_sha256 !== input.baseArchiveSha256 ||
        manifest?.backupId !== input.baseBackupId ||
        manifest?.contentRootSha256 !== input.baseContentRootSha256 ||
        source?.installationId !== input.sourceInstallationId
      ) {
        throw new RestoreProviderSecretsStoreError(
          "conflict",
          "Provider-secret sidecar does not match the completed restore",
        );
      }
      const existing = await tx<Row[]>`
        SELECT * FROM backup_restore_secret_sidecars
        WHERE restore_operation_id=${input.restoreOperationId} FOR UPDATE`;
      if (existing[0]) {
        const item = map(existing[0]);
        if (
          item.idempotencyKey === input.idempotencyKey &&
          item.sourceObjectKey === input.sourceObjectKey &&
          item.archiveSha256 === input.archiveSha256 &&
          item.archiveBytes === input.archiveBytes && item.sidecarId === input.sidecarId &&
          item.recoveryKeyId === input.recoveryKeyId
        ) return item;
        throw new RestoreProviderSecretsStoreError(
          "conflict",
          "A sidecar is already paired with this restore",
        );
      }
      const [row] = await tx<Row[]>`INSERT INTO backup_restore_secret_sidecars(
          restore_operation_id,idempotency_key,requested_by,source_object_key,archive_sha256,
          archive_bytes,sidecar_id,recovery_key_id,base_backup_id,base_archive_sha256,
          base_content_root_sha256,source_installation_id
        ) VALUES(
          ${input.restoreOperationId},${input.idempotencyKey},${input.requestedBy},
          ${input.sourceObjectKey},${input.archiveSha256},${input.archiveBytes},${input.sidecarId},
          ${input.recoveryKeyId},${input.baseBackupId},${input.baseArchiveSha256},
          ${input.baseContentRootSha256},${input.sourceInstallationId}
        ) RETURNING *`;
      return map(row);
    });
  }

  async validate(
    id: string,
    expectedVersion: number,
    input: ValidateRestoreProviderSecretsAttachment,
  ) {
    positiveVersion(expectedVersion);
    if (
      !UUID.test(id) || !Number.isSafeInteger(input.recordCount) || input.recordCount < 0 ||
      !SHA256.test(input.recordsSha256) || !SHA256.test(input.providerStateSha256)
    ) throw new RestoreProviderSecretsStoreError("invalid", "Sidecar validation result is invalid");
    const impact = json(input.impact, "Sidecar impact");
    const [row] = await this.#sql<Row[]>`UPDATE backup_restore_secret_sidecars SET
        status='validated',record_count=${input.recordCount},records_sha256=${input.recordsSha256},
        provider_state_sha256=${input.providerStateSha256},impact=${
      this.#sql.json(impact as never)
    },
        validated_at=now(),updated_at=now(),version=version+1
      WHERE id=${id} AND status='uploaded' AND version=${expectedVersion} RETURNING *`;
    if (!row) throw new RestoreProviderSecretsStoreError("conflict", "Sidecar validation is stale");
    return map(row);
  }

  async apply(
    id: string,
    expectedVersion: number,
    actorId: string,
    expectedProviderStateSha256: string,
    credentials: readonly RestoredProviderCredential[],
  ) {
    positiveVersion(expectedVersion);
    if (!UUID.test(id) || !UUID.test(actorId) || !SHA256.test(expectedProviderStateSha256)) {
      throw new RestoreProviderSecretsStoreError("invalid", "Sidecar apply request is invalid");
    }
    const seen = new Set<string>();
    for (const credential of credentials) {
      if (
        !UUID.test(credential.providerId) || !Number.isSafeInteger(credential.expectedVersion) ||
        credential.expectedVersion < 1 || seen.has(credential.providerId)
      ) throw new RestoreProviderSecretsStoreError("invalid", "Provider restore set is invalid");
      seen.add(credential.providerId);
      assertEnvelope(credential.envelope, credential.expectedVersion + 1);
    }
    return await this.#sql.begin("isolation level serializable", async (tx) => {
      const [attachment] = await tx<Row[]>`
        SELECT s.*,o.kind restore_kind,o.status restore_status,o.archive_sha256 restore_sha256
        FROM backup_restore_secret_sidecars s
        JOIN backup_operations o ON o.id=s.restore_operation_id
        WHERE s.id=${id} FOR UPDATE OF s,o`;
      if (
        !attachment || attachment.status !== "validated" ||
        Number(attachment.version) !== expectedVersion ||
        attachment.provider_state_sha256 !== expectedProviderStateSha256 ||
        attachment.restore_kind !== "restore" || attachment.restore_status !== "completed" ||
        attachment.restore_sha256 !== attachment.base_archive_sha256 ||
        Number(attachment.record_count) !== credentials.length
      ) throw new RestoreProviderSecretsStoreError("conflict", "Sidecar apply is stale");
      const ordered = [...credentials].sort((a, b) => a.providerId.localeCompare(b.providerId));
      for (const credential of ordered) {
        const [provider] = await tx<Row[]>`
          SELECT version,enabled,credential_envelope FROM providers
          WHERE id=${credential.providerId} FOR UPDATE`;
        if (
          !provider || Number(provider.version) !== credential.expectedVersion ||
          provider.enabled !== false || provider.credential_envelope != null
        ) {
          throw new RestoreProviderSecretsStoreError(
            "conflict",
            "A restored provider changed after preview",
          );
        }
        const updated = await tx`UPDATE providers SET
            credential_envelope=${
          tx.json(credential.envelope as never)
        },credential_updated_at=now(),
            enabled=false,health_status='disabled',health_checked_at=NULL,health_latency_ms=NULL,
            health_error=NULL,version=version+1,updated_at=now()
          WHERE id=${credential.providerId} AND version=${credential.expectedVersion}
            AND enabled=false AND credential_envelope IS NULL RETURNING id`;
        if (!updated.length) {
          throw new RestoreProviderSecretsStoreError(
            "conflict",
            "A restored provider changed after preview",
          );
        }
      }
      await tx`INSERT INTO audit_events(actor_id,action,target_type,target_id,metadata)
        VALUES(${actorId},'backup.provider_secrets_restored','backup_operation',
          ${String(attachment.restore_operation_id)},${
        tx.json({
          sidecarId: id,
          providerCount: credentials.length,
          providersRemainDisabled: true,
        })
      })`;
      const [applied] = await tx<Row[]>`UPDATE backup_restore_secret_sidecars SET
          status='applied',applied_by=${actorId},applied_at=now(),completed_at=now(),updated_at=now(),
          version=version+1
        WHERE id=${id} AND status='validated' AND version=${expectedVersion} RETURNING *`;
      if (!applied) {
        throw new RestoreProviderSecretsStoreError("conflict", "Sidecar apply is stale");
      }
      return map(applied);
    });
  }

  async fail(id: string, expectedVersion: number, error: string) {
    positiveVersion(expectedVersion);
    if (!UUID.test(id) || !error || error.length > 1000) {
      throw new RestoreProviderSecretsStoreError("invalid", "Sidecar failure is invalid");
    }
    const [row] = await this.#sql<Row[]>`UPDATE backup_restore_secret_sidecars SET
        status='failed',error=${error},completed_at=now(),updated_at=now(),version=version+1
      WHERE id=${id} AND status IN ('uploaded','validated') AND version=${expectedVersion}
      RETURNING *`;
    if (!row) throw new RestoreProviderSecretsStoreError("conflict", "Sidecar failure is stale");
    return map(row);
  }

  async cancel(id: string, expectedVersion: number) {
    positiveVersion(expectedVersion);
    if (!UUID.test(id)) {
      throw new RestoreProviderSecretsStoreError("invalid", "Sidecar ID is invalid");
    }
    const [row] = await this.#sql<Row[]>`UPDATE backup_restore_secret_sidecars SET
        status='cancelled',completed_at=now(),updated_at=now(),version=version+1
      WHERE id=${id} AND status IN ('uploaded','validated') AND version=${expectedVersion}
      RETURNING *`;
    if (!row) {
      throw new RestoreProviderSecretsStoreError("conflict", "Sidecar cancellation is stale");
    }
    return map(row);
  }

  async claimCleanup(
    leaseToken: string,
    leaseSeconds: number,
    recheckMilliseconds: number,
    limit = 100,
  ) {
    if (
      !UUID.test(leaseToken) || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 ||
      leaseSeconds > 3600 || !Number.isSafeInteger(recheckMilliseconds) ||
      recheckMilliseconds < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
    ) throw new RestoreProviderSecretsStoreError("invalid", "Sidecar cleanup claim is invalid");
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>`UPDATE backup_restore_secret_sidecars SET
          cleanup_lease_token=${leaseToken},
          cleanup_lease_expires_at=now()+(${leaseSeconds}::text || ' seconds')::interval,
          updated_at=now()
        WHERE id IN (
          SELECT id FROM backup_restore_secret_sidecars
          WHERE status IN ('applied','failed','cancelled')
            AND (cleanup_checked_at IS NULL OR cleanup_checked_at < now()-
              (${recheckMilliseconds}::text || ' milliseconds')::interval)
            AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at < now())
          ORDER BY completed_at,id FOR UPDATE SKIP LOCKED LIMIT ${limit}
        ) RETURNING *`;
      return rows.map(map);
    });
  }

  async recordCleanup(id: string, objectKey: string, archiveSha256: string, leaseToken: string) {
    if (
      !UUID.test(id) || !UUID.test(leaseToken) || !validObjectKey(objectKey) ||
      !SHA256.test(archiveSha256)
    ) {
      throw new RestoreProviderSecretsStoreError("invalid", "Sidecar cleanup result is invalid");
    }
    const rows = await this.#sql`UPDATE backup_restore_secret_sidecars SET
        cleanup_checked_at=now(),cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL,updated_at=now()
      WHERE id=${id} AND source_object_key=${objectKey} AND archive_sha256=${archiveSha256}
        AND cleanup_lease_token=${leaseToken} RETURNING id`;
    return rows.length === 1;
  }

  async releaseCleanup(id: string, leaseToken: string) {
    if (!UUID.test(id) || !UUID.test(leaseToken)) {
      throw new RestoreProviderSecretsStoreError("invalid", "Sidecar cleanup lease is invalid");
    }
    const rows = await this.#sql`UPDATE backup_restore_secret_sidecars SET
        cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL,updated_at=now()
      WHERE id=${id} AND cleanup_lease_token=${leaseToken} RETURNING id`;
    return rows.length === 1;
  }
}
