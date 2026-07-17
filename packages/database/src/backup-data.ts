import postgres from "npm:postgres@3.4.7";
import { isModelCapability, parsePublicConversationShare } from "@dg-chat/contracts";
import type { ProviderCredentialEnvelope } from "./repository.ts";
import {
  providerCustomParamsViolation,
  providerDefaultsViolation,
  type ProviderModelInvariantRecord,
  providerModelOcrGraphViolation,
  providerOcrTargetProviderViolation,
  type ProviderProtocol,
} from "./provider-model-invariants.ts";

export const BACKUP_DATA_SCHEMA_VERSION = "0053" as const;
const PRE_COMMUNITY_PROFILE_BACKUP_DATA_SCHEMA_VERSION = "0050" as const;
const PRE_ATTACHMENT_CONTROL_BACKUP_DATA_SCHEMA_VERSION = "0049" as const;
const PRE_AUTOMATIC_RETENTION_BACKUP_DATA_SCHEMA_VERSION = "0045" as const;
const PRE_TOOL_ACCOUNTING_BACKUP_DATA_SCHEMA_VERSION = "0043" as const;
const PRE_AUTHORITY_EPOCH_BACKUP_DATA_SCHEMA_VERSION = "0039" as const;
const ADMIN_SECURITY_BILLING_BACKUP_DATA_SCHEMA_VERSION = "0038" as const;
const ADMIN_LIFECYCLE_BACKUP_DATA_SCHEMA_VERSION = "0037" as const;
const IMMUTABLE_SHARING_BACKUP_DATA_SCHEMA_VERSION = "0034" as const;
const CONVERSATION_PORTABILITY_BACKUP_DATA_SCHEMA_VERSION = "0033" as const;
const TEMPORARY_LIFECYCLE_BACKUP_DATA_SCHEMA_VERSION = "0032" as const;
const LEGACY_BACKUP_DATA_SCHEMA_VERSION = "0028" as const;
export const PRE_AUTOMATIC_RETENTION_BACKUP_DATA_OMITTED_TABLES = Object.freeze(
  new Set(["retention_schedule_state"]),
);
export const PRE_COMMUNITY_PROFILE_BACKUP_DATA_OMITTED_TABLES = Object.freeze(
  new Set(["community_profiles"]),
);
export const PRE_ATTACHMENT_CONTROL_BACKUP_DATA_OMITTED_TABLES = Object.freeze(
  new Set([
    "attachment_storage_installation",
    "attachment_storage_usage",
    "attachment_storage_blobs",
    "attachment_storage_releases",
  ]),
);
export const LEGACY_BACKUP_DATA_OMITTED_TABLES = Object.freeze(
  new Set([
    "user_preferences",
    "conversation_folders",
    "conversation_folder_memberships",
    "conversation_tags",
    "conversation_tag_sets",
    "conversation_tag_bindings",
    "conversation_share_snapshots",
    "admin_balance_adjustments",
    "retention_schedule_state",
  ]),
);
export const ADMIN_LIFECYCLE_BACKUP_DATA_OMITTED_TABLES = Object.freeze(
  new Set(["admin_balance_adjustments"]),
);
export const PRE_IMMUTABLE_SHARING_BACKUP_DATA_OMITTED_TABLES = Object.freeze(
  new Set(["admin_balance_adjustments", "conversation_share_snapshots"]),
);
export function isSupportedBackupDataSchemaVersion(value: string): boolean {
  return value === BACKUP_DATA_SCHEMA_VERSION ||
    value === PRE_COMMUNITY_PROFILE_BACKUP_DATA_SCHEMA_VERSION ||
    value === PRE_ATTACHMENT_CONTROL_BACKUP_DATA_SCHEMA_VERSION ||
    value === PRE_AUTOMATIC_RETENTION_BACKUP_DATA_SCHEMA_VERSION ||
    value === PRE_TOOL_ACCOUNTING_BACKUP_DATA_SCHEMA_VERSION ||
    value === PRE_AUTHORITY_EPOCH_BACKUP_DATA_SCHEMA_VERSION ||
    value === ADMIN_SECURITY_BILLING_BACKUP_DATA_SCHEMA_VERSION ||
    value === ADMIN_LIFECYCLE_BACKUP_DATA_SCHEMA_VERSION ||
    value === IMMUTABLE_SHARING_BACKUP_DATA_SCHEMA_VERSION ||
    value === CONVERSATION_PORTABILITY_BACKUP_DATA_SCHEMA_VERSION ||
    value === TEMPORARY_LIFECYCLE_BACKUP_DATA_SCHEMA_VERSION ||
    value === LEGACY_BACKUP_DATA_SCHEMA_VERSION;
}
const hasCurrentPortableRowShape = (version: string) =>
  version === BACKUP_DATA_SCHEMA_VERSION ||
  version === PRE_COMMUNITY_PROFILE_BACKUP_DATA_SCHEMA_VERSION ||
  version === PRE_ATTACHMENT_CONTROL_BACKUP_DATA_SCHEMA_VERSION ||
  version === PRE_AUTOMATIC_RETENTION_BACKUP_DATA_SCHEMA_VERSION;
const requiresLegacyPortableUpgrade = (version: string) => !hasCurrentPortableRowShape(version);
const requiresAttachmentControlUpgrade = (version: string) =>
  version !== BACKUP_DATA_SCHEMA_VERSION &&
  version !== PRE_COMMUNITY_PROFILE_BACKUP_DATA_SCHEMA_VERSION;

export function isCanonicalManifestOnlyAttachmentMetadata(
  value: Readonly<Record<string, unknown>>,
): boolean {
  return value.object_key ===
      `imports/${String(value.owner_id)}/${String(value.id)}/manifest-only` &&
    value.state === "failed" &&
    value.deleted_at !== null &&
    value.deleted_at !== undefined &&
    value.inspection_error === "Attachment bytes were not included in the .dgchat manifest" &&
    value.ingestion_status === "failed" &&
    value.ingestion_error === "Attachment bytes require a separate restore" &&
    value.ingested_at === null;
}

export const BACKUP_DATA_BATCH_SIZE = 100;
export const BACKUP_DATA_MAX_BATCH_SIZE = 500;
export const BACKUP_DATA_MAX_ROWS_PER_TABLE = 10_000_000;

export type BackupDiagnosticPolicy = "excluded" | "scrubbed" | "included";
export type BackupDataRow = Readonly<Record<string, unknown>>;
export type BackupDataBatch = readonly BackupDataRow[];

type ColumnKind =
  | "text"
  | "uuid"
  | "integer"
  | "bigint"
  | "double"
  | "boolean"
  | "timestamp"
  | "json"
  | "vector";
type ColumnKinds = Readonly<Record<string, ColumnKind>>;

export interface BackupDataTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly insertColumns: readonly string[];
  readonly orderBy: string;
  readonly kinds: ColumnKinds;
  readonly syntheticColumns?: Readonly<Record<string, string>>;
}

const words = (value: string) => value.trim().split(/\s+/u);
const table = (
  name: string,
  columns: string,
  orderBy: string,
  kinds: ColumnKinds = {},
  options: {
    insertColumns?: string;
    syntheticColumns?: Readonly<Record<string, string>>;
  } = {},
): BackupDataTable =>
  Object.freeze({
    name,
    columns: Object.freeze(words(columns)),
    insertColumns: Object.freeze(words(options.insertColumns ?? columns)),
    orderBy,
    kinds: Object.freeze({ ...kinds }),
    ...(options.syntheticColumns
      ? { syntheticColumns: Object.freeze(options.syntheticColumns) }
      : {}),
  });

const UUID_COLUMNS = new Set([
  "id",
  "user_id",
  "owner_id",
  "actor_id",
  "conversation_id",
  "message_id",
  "attachment_id",
  "collection_id",
  "group_id",
  "token_id",
  "provider_id",
  "provider_model_id",
  "target_model_id",
  "source_model_id",
  "retry_policy_id",
  "route_id",
  "pricing_version_id",
  "updated_by",
  "requested_by",
  "approved_by",
  "generated_asset_id",
  "provider_attempt_id",
  "chunk_id",
  "rotation_family_id",
  "rotated_from_token_id",
  "replaced_by_token_id",
  "parent_id",
  "supersedes_id",
  "generation_id",
  "active_leaf_id",
  "leaf_id",
  "target_user_id",
  "ledger_entry_id",
  "audit_event_id",
  "last_run_id",
]);
const TIMESTAMP_SUFFIX = /(?:_at|_expires_at)$/u;
const inferKinds = (columns: readonly string[], explicit: ColumnKinds): ColumnKinds =>
  Object.fromEntries(columns.map((column) => [
    column,
    explicit[column] ??
      (UUID_COLUMNS.has(column) ? "uuid" : TIMESTAMP_SUFFIX.test(column) ? "timestamp" : "text"),
  ])) as ColumnKinds;

const T = (
  name: string,
  columns: string,
  orderBy: string,
  explicit: ColumnKinds = {},
  options: Parameters<typeof table>[4] = {},
) => {
  const parsed = words(columns);
  return table(name, columns, orderBy, inferKinds(parsed, explicit), options);
};

/**
 * Reviewed portable-data catalog through migration 0028. Tables absent here are deliberately
 * ephemeral or control-plane state and are invalid in a portable backup.
 */
export const BACKUP_DATA_TABLES: readonly BackupDataTable[] = Object.freeze([
  T(
    "users",
    "id email name password_hash role approval_status state version authority_epoch balance_micros created_at updated_at deleted_at email_verified_at",
    "id",
    {
      version: "integer",
      authority_epoch: "bigint",
      balance_micros: "bigint",
    },
  ),
  T(
    "community_profiles",
    "user_id opted_in identity_mode nickname color share_balance version created_at updated_at",
    "user_id",
    {
      opted_in: "boolean",
      share_balance: "boolean",
      version: "integer",
    },
  ),
  T("auth_users", "id name email email_verified image created_at updated_at", "id", {
    email_verified: "boolean",
  }),
  T(
    "auth_accounts",
    "id account_id provider_id user_id scope password created_at updated_at",
    "id",
    { account_id: "text", provider_id: "text" },
  ),
  T(
    "providers",
    "id slug display_name base_url protocol enabled version health_status health_checked_at health_latency_ms health_error created_at updated_at credential_redacted",
    "id",
    {
      enabled: "boolean",
      version: "integer",
      health_latency_ms: "integer",
      credential_redacted: "boolean",
    },
    {
      insertColumns:
        "id slug display_name base_url protocol enabled version health_status health_checked_at health_latency_ms health_error created_at updated_at",
      syntheticColumns: { credential_redacted: "boolean" },
    },
  ),
  T(
    "provider_models",
    "id provider_id public_model_id upstream_model_id display_name capabilities context_window enabled version custom_params created_at updated_at",
    "id",
    {
      capabilities: "json",
      context_window: "integer",
      enabled: "boolean",
      version: "integer",
      custom_params: "json",
    },
  ),
  T("model_aliases", "id alias target_model_id description version created_at updated_at", "id", {
    version: "integer",
  }),
  T(
    "model_price_versions",
    "id provider_model_id effective_at input_micros_per_million cached_input_micros_per_million reasoning_micros_per_million output_micros_per_million fixed_call_micros source created_at",
    "id",
    {
      input_micros_per_million: "bigint",
      cached_input_micros_per_million: "bigint",
      reasoning_micros_per_million: "bigint",
      output_micros_per_million: "bigint",
      fixed_call_micros: "bigint",
    },
  ),
  T(
    "provider_retry_policies",
    "id name enabled max_attempts max_retries base_delay_ms max_delay_ms backoff_multiplier_bps jitter_bps first_token_timeout_ms idle_timeout_ms total_timeout_ms retryable_statuses version created_at updated_at",
    "id",
    {
      enabled: "boolean",
      max_attempts: "integer",
      max_retries: "integer",
      base_delay_ms: "integer",
      max_delay_ms: "integer",
      backoff_multiplier_bps: "integer",
      jitter_bps: "integer",
      first_token_timeout_ms: "integer",
      idle_timeout_ms: "integer",
      total_timeout_ms: "integer",
      retryable_statuses: "json",
      version: "integer",
    },
  ),
  T(
    "provider_model_routes",
    "id source_model_id retry_policy_id version created_at updated_at",
    "id",
    { version: "integer" },
  ),
  T("provider_model_route_targets", "route_id target_model_id ordinal", "route_id,ordinal", {
    ordinal: "integer",
  }),
  T(
    "api_tokens",
    "id user_id name token_hash preview scopes expires_at revoked_at last_used_at created_at version rpm_limit burst_limit access_mode rotation_family_id rotation_generation rotated_from_token_id replaced_by_token_id overlap_ends_at authority_epoch",
    "id",
    {
      scopes: "json",
      version: "integer",
      rpm_limit: "integer",
      burst_limit: "integer",
      rotation_generation: "integer",
      authority_epoch: "bigint",
    },
  ),
  T("access_groups", "id name description version created_at updated_at", "id", {
    version: "integer",
  }),
  T("access_group_users", "group_id user_id", "group_id,user_id"),
  T("access_group_models", "group_id provider_model_id", "group_id,provider_model_id"),
  T("access_group_tokens", "group_id token_id user_id", "group_id,token_id"),
  T(
    "attachment_storage_installation",
    "singleton_id physical_bytes physical_objects updated_at",
    "singleton_id",
    {
      singleton_id: "integer",
      physical_bytes: "bigint",
      physical_objects: "bigint",
    },
  ),
  T(
    "attachment_storage_usage",
    "owner_id physical_bytes physical_objects updated_at",
    "owner_id",
    {
      physical_bytes: "bigint",
      physical_objects: "bigint",
    },
  ),
  T(
    "attachment_storage_blobs",
    "owner_id object_key size_bytes sha256 mime_type admitted_at",
    "owner_id,object_key",
    { size_bytes: "bigint" },
  ),
  T(
    "attachment_storage_releases",
    "id stage_id usage_run_id owner_id object_key attachment_id size_bytes sha256 mime_type reason released_at",
    "id",
    { size_bytes: "bigint" },
  ),
  T(
    "attachments",
    "id owner_id object_key filename mime_type size_bytes sha256 width height state created_at inspection_error inspection_epoch version physical_object required_inspection_mode inspection_policy_version updated_at deleted_at ingestion_status ingestion_error ingested_at",
    "id",
    {
      size_bytes: "bigint",
      width: "integer",
      height: "integer",
      inspection_epoch: "integer",
      version: "integer",
      physical_object: "boolean",
    },
  ),
  T(
    "conversations",
    "id owner_id title active_leaf_id version pinned temporary temporary_expires_at archived_at deleted_at created_at updated_at",
    "id",
    {
      version: "integer",
      pinned: "boolean",
      temporary: "boolean",
    },
  ),
  T(
    "conversation_share_snapshots",
    "id owner_id conversation_id leaf_id conversation_version title identity_visibility attachment_policy owner_name_snapshot public_snapshot source_attachments secret_hash idempotency_key payload_hash version expires_at revoked_at created_at",
    "id",
    {
      conversation_version: "integer",
      public_snapshot: "json",
      source_attachments: "json",
      version: "integer",
    },
  ),
  T(
    "user_preferences",
    "user_id version theme compact_conversations reduce_motion custom_instructions use_memory save_history preferred_model_id created_at updated_at",
    "user_id",
    {
      version: "integer",
      compact_conversations: "boolean",
      reduce_motion: "boolean",
      use_memory: "boolean",
      save_history: "boolean",
    },
  ),
  T(
    "conversation_folders",
    "id owner_id name normalized_name position version membership_version created_at updated_at",
    "id",
    { position: "integer", version: "integer", membership_version: "integer" },
  ),
  T(
    "conversation_folder_memberships",
    "folder_id conversation_id owner_id position created_at updated_at",
    "folder_id,position,conversation_id",
    { position: "integer" },
  ),
  T(
    "conversation_tags",
    "id owner_id name normalized_name color version created_at updated_at",
    "id",
    { version: "integer" },
  ),
  T("conversation_tag_sets", "conversation_id owner_id version updated_at", "conversation_id", {
    version: "integer",
  }),
  T(
    "conversation_tag_bindings",
    "conversation_id tag_id owner_id created_at",
    "conversation_id,tag_id",
  ),
  T(
    "messages",
    "id conversation_id parent_id supersedes_id generation_id sibling_index role content model status metadata idempotency_key created_at",
    "conversation_id,sibling_index,id",
    {
      sibling_index: "integer",
      metadata: "json",
    },
  ),
  T(
    "message_attachments",
    "message_id attachment_id position",
    "message_id,position,attachment_id",
    { position: "integer" },
  ),
  T(
    "knowledge_collections",
    "id owner_id name description idempotency_key version created_at updated_at deleted_at",
    "id",
    { version: "integer" },
  ),
  T(
    "knowledge_collection_attachments",
    "collection_id attachment_id created_at",
    "collection_id,attachment_id",
  ),
  T(
    "conversation_knowledge_bindings",
    "conversation_id collection_id owner_id mode version created_at updated_at",
    "conversation_id,collection_id",
    { version: "integer" },
  ),
  T(
    "usage_runs",
    "id user_id token_id model provider recovery_owner status input_tokens output_tokens cost_micros latency_ms ttft_ms error created_at completed_at reserved_micros pricing_version_id pricing_input_micros_per_million pricing_cached_input_micros_per_million pricing_reasoning_micros_per_million pricing_output_micros_per_million pricing_fixed_call_micros pricing_source execution_epoch actual_provider_cost_micros actual_provider_input_tokens actual_provider_cached_input_tokens actual_provider_reasoning_tokens actual_provider_output_tokens",
    "id",
    {
      id: "text",
      input_tokens: "integer",
      output_tokens: "integer",
      cost_micros: "bigint",
      latency_ms: "integer",
      ttft_ms: "integer",
      reserved_micros: "bigint",
      execution_epoch: "integer",
      pricing_input_micros_per_million: "bigint",
      pricing_cached_input_micros_per_million: "bigint",
      pricing_reasoning_micros_per_million: "bigint",
      pricing_output_micros_per_million: "bigint",
      pricing_fixed_call_micros: "bigint",
      actual_provider_cost_micros: "bigint",
      actual_provider_input_tokens: "bigint",
      actual_provider_cached_input_tokens: "bigint",
      actual_provider_reasoning_tokens: "bigint",
      actual_provider_output_tokens: "bigint",
    },
  ),
  T(
    "ledger_entries",
    "id user_id usage_run_id kind sequence amount_micros balance_after_micros metadata created_at",
    "user_id,sequence,id",
    {
      id: "uuid",
      usage_run_id: "text",
      sequence: "bigint",
      amount_micros: "bigint",
      balance_after_micros: "bigint",
      metadata: "json",
    },
  ),
  T(
    "provider_attempts",
    "id usage_run_id attempt_number execution_epoch target_ordinal retry_number reason breaker_before breaker_after retryable provider_id provider_slug provider_version protocol provider_model_id public_model_id upstream_model_id model_version pricing_version_id pricing_input_micros_per_million pricing_cached_input_micros_per_million pricing_reasoning_micros_per_million pricing_output_micros_per_million pricing_fixed_call_micros pricing_source status phase error_code http_status visible_output input_tokens cached_input_tokens reasoning_tokens output_tokens cost_micros token_source cost_source latency_ms ttft_ms upstream_request_id tokens_per_second started_at completed_at",
    "usage_run_id,attempt_number",
    {
      usage_run_id: "text",
      attempt_number: "integer",
      execution_epoch: "integer",
      target_ordinal: "integer",
      retry_number: "integer",
      retryable: "boolean",
      provider_version: "integer",
      model_version: "integer",
      pricing_input_micros_per_million: "bigint",
      pricing_cached_input_micros_per_million: "bigint",
      pricing_reasoning_micros_per_million: "bigint",
      pricing_output_micros_per_million: "bigint",
      pricing_fixed_call_micros: "bigint",
      http_status: "integer",
      visible_output: "boolean",
      input_tokens: "integer",
      cached_input_tokens: "integer",
      reasoning_tokens: "integer",
      output_tokens: "integer",
      cost_micros: "bigint",
      latency_ms: "integer",
      ttft_ms: "integer",
      tokens_per_second: "double",
    },
  ),
  T(
    "embedding_provider_attempts",
    "id usage_run_id parent_usage_run_id purpose provider model upstream_model item_count status input_tokens cost_micros token_source cost_source latency_ms error started_at completed_at",
    "id",
    {
      usage_run_id: "text",
      parent_usage_run_id: "text",
      item_count: "integer",
      input_tokens: "integer",
      cost_micros: "bigint",
      latency_ms: "integer",
    },
  ),
  T(
    "document_chunks",
    "id attachment_id ordinal content embedding metadata",
    "attachment_id,ordinal",
    {
      ordinal: "integer",
      embedding: "vector",
      metadata: "json",
    },
  ),
  T(
    "document_chunk_embeddings",
    "chunk_id owner_id model embedding_version content_sha256 embedding created_at updated_at",
    "chunk_id,model,embedding_version",
    {
      embedding: "vector",
    },
  ),
  T(
    "generated_assets",
    "id owner_id usage_run_id provider_model_id public_model_id upstream_model_id provider_slug pricing_version_id pricing_input_micros_per_million pricing_cached_input_micros_per_million pricing_reasoning_micros_per_million pricing_output_micros_per_million pricing_fixed_call_micros pricing_source attachment_id idempotency_key request_hash operation prompt provider_created_at ordinal width height revised_prompt created_at updated_at deleted_at",
    "id",
    {
      usage_run_id: "text",
      pricing_input_micros_per_million: "bigint",
      pricing_cached_input_micros_per_million: "bigint",
      pricing_reasoning_micros_per_million: "bigint",
      pricing_output_micros_per_million: "bigint",
      pricing_fixed_call_micros: "bigint",
      provider_created_at: "bigint",
      ordinal: "integer",
      width: "integer",
      height: "integer",
    },
  ),
  T(
    "generated_asset_inputs",
    "generated_asset_id owner_id attachment_id role ordinal width height has_alpha",
    "generated_asset_id,role,ordinal",
    {
      ordinal: "integer",
      width: "integer",
      height: "integer",
      has_alpha: "boolean",
    },
  ),
  T(
    "tool_policies",
    "tool_id allowed allowed_domains allow_private_network version updated_by updated_at",
    "tool_id",
    {
      tool_id: "text",
      allowed: "boolean",
      allowed_domains: "json",
      allow_private_network: "boolean",
      version: "integer",
    },
  ),
  T(
    "tool_executions",
    "id owner_id tool_id input status result error approved_at approved_by cancellation_requested_at billing_snapshot created_at updated_at",
    "id",
    {
      input: "json",
      result: "json",
      error: "json",
      billing_snapshot: "json",
    },
  ),
  T("message_tool_executions", "message_id execution_id created_at", "message_id,execution_id", {
    execution_id: "uuid",
  }),
  T(
    "audit_events",
    "id actor_id action target_type target_id metadata created_at",
    "created_at,id",
    {
      metadata: "json",
    },
  ),
  T(
    "admin_balance_adjustments",
    "id actor_id target_user_id idempotency_key_hash request_hash amount_micros balance_before_micros balance_after_micros reason ledger_entry_id audit_event_id created_at",
    "created_at,id",
    {
      idempotency_key_hash: "text",
      request_hash: "text",
      amount_micros: "bigint",
      balance_before_micros: "bigint",
      balance_after_micros: "bigint",
      reason: "text",
    },
  ),
  T(
    "retention_policy_versions",
    "version capture_enabled request_body_days response_body_days updated_at updated_by",
    "version",
    {
      version: "integer",
      capture_enabled: "boolean",
      request_body_days: "integer",
      response_body_days: "integer",
    },
  ),
  T("retention_policy_state", "singleton_id current_version", "singleton_id", {
    singleton_id: "integer",
    current_version: "integer",
  }),
  T(
    "retention_scrub_runs",
    "id idempotency_key status policy_version capture_enabled request_body_days response_body_days request_cutoff_at response_cutoff_at requested_by captures_scrubbed request_bodies_scrubbed response_bodies_scrubbed bytes_scrubbed created_at started_at completed_at error",
    "id",
    {
      policy_version: "integer",
      capture_enabled: "boolean",
      request_body_days: "integer",
      response_body_days: "integer",
      captures_scrubbed: "integer",
      request_bodies_scrubbed: "integer",
      response_bodies_scrubbed: "integer",
      bytes_scrubbed: "bigint",
    },
  ),
  T(
    "retention_schedule_state",
    "singleton_id interval_seconds next_due_at last_policy_version last_scheduled_at last_run_id updated_at",
    "singleton_id",
    {
      singleton_id: "integer",
      interval_seconds: "integer",
      last_policy_version: "integer",
    },
  ),
  T(
    "provider_payload_captures",
    "id usage_run_id provider_attempt_id request_body response_body request_bytes response_bytes captured_at scrubbed_at",
    "id",
    {
      usage_run_id: "text",
      request_bytes: "integer",
      response_bytes: "integer",
    },
  ),
]);

export const BACKUP_DATA_TABLE_NAMES = Object.freeze(BACKUP_DATA_TABLES.map((entry) => entry.name));
const CATALOG = new Map(BACKUP_DATA_TABLES.map((entry) => [entry.name, entry]));

export const BACKUP_REDACTED_OR_TRANSIENT_COLUMNS = Object.freeze(
  {
    users: ["password_reset_pending", "password_reset_token_identifier"],
    auth_accounts: [
      "access_token",
      "refresh_token",
      "id_token",
      "access_token_expires_at",
      "refresh_token_expires_at",
    ],
    providers: ["credential_envelope", "credential_updated_at"],
    usage_runs: [
      "generation_lease_token",
      "generation_lease_expires_at",
      "execution_owner_lease_token",
      "run_lease_token",
      "run_lease_expires_at",
    ],
    tool_executions: ["claim_token", "claim_expires_at"],
  } as const,
);

/** Fails closed when a migration adds a table or column without a reviewed portability decision. */
export async function verifyBackupDataCatalog(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' ORDER BY table_name,ordinal_position
    `;
    const actual = new Map<string, string[]>();
    for (const row of rows) {
      const columns = actual.get(row.table_name) ?? [];
      columns.push(row.column_name);
      actual.set(row.table_name, columns);
    }
    const control = new Set([
      ...BACKUP_EPHEMERAL_TABLES,
      "backup_operations",
      "backup_restore_secret_sidecars",
      "installation_state",
      "repository_migrations",
    ]);
    for (const name of actual.keys()) {
      if (!CATALOG.has(name) && !control.has(name)) {
        throw new BackupDataError("invariant", `Database table ${name} has no backup policy`);
      }
    }
    for (const definition of BACKUP_DATA_TABLES) {
      const databaseColumns = actual.get(definition.name);
      if (!databaseColumns) {
        throw new BackupDataError("invariant", `Backup table ${definition.name} is missing`);
      }
      const synthetic = new Set(Object.keys(definition.syntheticColumns ?? {}));
      const reviewed = new Set([
        ...definition.columns.filter((column) => !synthetic.has(column)),
        ...((BACKUP_REDACTED_OR_TRANSIENT_COLUMNS as Record<string, readonly string[]>)[
          definition.name
        ] ?? []),
      ]);
      const unexpected = databaseColumns.filter((column) => !reviewed.has(column));
      const missing = [...reviewed].filter((column) => !databaseColumns.includes(column));
      if (unexpected.length || missing.length) {
        throw new BackupDataError(
          "invariant",
          `Backup columns for ${definition.name} are out of date`,
        );
      }
    }
    const triggers = await sql<{ table_name: string; trigger_count: number }[]>`
      SELECT c.relname table_name,count(*)::int trigger_count
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
        AND t.tgname='dg_chat_restore_maintenance_fence'
      GROUP BY c.relname ORDER BY c.relname
    `;
    const fenced = new Map(triggers.map((row) => [row.table_name, row.trigger_count]));
    const business = new Set([...BACKUP_DATA_TABLE_NAMES, ...BACKUP_EPHEMERAL_TABLES]);
    for (const name of business) {
      if (fenced.get(name) !== 1) {
        throw new BackupDataError(
          "invariant",
          `Database table ${name} is missing its restore maintenance fence`,
        );
      }
    }
    for (
      const name of [
        "backup_operations",
        "backup_restore_secret_sidecars",
        "installation_state",
        "repository_migrations",
      ]
    ) {
      if (fenced.has(name)) {
        throw new BackupDataError(
          "invariant",
          `Database control table ${name} must remain outside the restore maintenance fence`,
        );
      }
    }
    const auditGuards = await sql<{
      trigger_count: number;
      trigger_type: number | null;
      function_name: string | null;
    }[]>`
      SELECT count(*)::int trigger_count,
        max(t.tgtype::int)::int trigger_type,
        max(p.proname) function_name
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname='public' AND c.relname='audit_events'
        AND t.tgname='dg_chat_audit_events_append_only' AND NOT t.tgisinternal
    `;
    const auditGuard = auditGuards[0];
    if (
      auditGuard?.trigger_count !== 1 ||
      // pg_trigger bit flags: BEFORE=2, DELETE=8, UPDATE=16, TRUNCATE=32. The absence of
      // ROW=1 proves this is a statement trigger, so even a zero-row mutation is rejected.
      auditGuard.trigger_type !== 58 ||
      auditGuard.function_name !== "dg_chat_enforce_audit_event_immutability"
    ) {
      throw new BackupDataError(
        "invariant",
        "Database audit history is missing its append-only guard",
      );
    }
    const storageGuards = await sql<{
      table_name: string;
      trigger_name: string;
      trigger_type: number;
      function_name: string;
    }[]>`
      SELECT c.relname table_name,t.tgname trigger_name,t.tgtype::int trigger_type,
        p.proname function_name
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname='public' AND NOT t.tgisinternal AND (
        (c.relname='attachment_storage_blobs' AND
          t.tgname='dg_chat_attachment_storage_blobs_append_only') OR
        (c.relname='attachment_storage_releases' AND
          t.tgname='dg_chat_attachment_storage_releases_append_only')
      ) ORDER BY c.relname
    `;
    if (
      storageGuards.length !== 2 ||
      storageGuards.some((guard) =>
        guard.trigger_type !== 58 ||
        guard.function_name !== "dg_chat_enforce_attachment_blob_history"
      )
    ) {
      throw new BackupDataError(
        "invariant",
        "Database attachment storage history is missing its append-only guard",
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface BackupExportSource {
  readonly schemaVersion: typeof BACKUP_DATA_SCHEMA_VERSION;
  readonly installationId: string;
  readonly tables: readonly BackupDataTable[];
  rows(tableName: string): AsyncIterable<BackupDataBatch>;
}

/**
 * Persistence-only provider credential captured alongside a portable backup.
 * The envelope is still encrypted with the source installation's provider key.
 * It must never be written into the ordinary backup archive or returned to a client.
 */
export interface BackupProviderCredential {
  readonly providerId: string;
  readonly envelope: ProviderCredentialEnvelope;
}

export type BackupProviderCredentialBatch = readonly BackupProviderCredential[];

/** Available only through the explicitly privileged snapshot entry point. */
export interface PrivilegedBackupExportSource extends BackupExportSource {
  providerCredentials(): AsyncIterable<BackupProviderCredentialBatch>;
}

export interface BackupDataSource {
  readonly schemaVersion: string;
  rows(tableName: string): AsyncIterable<BackupDataBatch>;
}

export interface BackupRestoreImpact {
  readonly rowsByTable: Readonly<Record<string, number>>;
  readonly totalRows: number;
  readonly users: number;
  readonly conversations: number;
  readonly attachments: number;
  readonly providersDisabledForRedactedCredentials: number;
  readonly restoreOperationVersion: number | null;
  readonly installationVersion: number | null;
}

export interface RestoreBackupDataOptions {
  restoreOperationId: string;
  expectedOperationVersion: number;
  expectedInstallationVersion: number;
  objectKeyMap?: ReadonlyMap<string, string>;
  /** Test-only failure injection after validation but before commit. */
  beforeCommit?: () => void | Promise<void>;
}

export const BACKUP_EPHEMERAL_TABLES = Object.freeze(
  [
    "sessions",
    "auth_sessions",
    "auth_verifications",
    "identity_tokens",
    "operation_idempotency",
    "conversation_portability_imports",
    "api_idempotency_events",
    "api_idempotency_requests",
    "file_upload_staging",
    "attachment_upload_staging",
    "generation_controls",
    "jobs",
    "document_embedding_batches",
    "generated_object_staging",
    "runtime_snapshots",
    "worker_instances",
  ] as const,
);

export class BackupDataError extends Error {
  constructor(
    readonly code: "invalid_source" | "invariant" | "maintenance" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "BackupDataError";
  }
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error("Unsafe internal SQL identifier");
  return `"${value}"`;
}

function exportExpression(
  definition: BackupDataTable,
  column: string,
  policy: BackupDiagnosticPolicy,
) {
  if (definition.name === "providers" && column === "credential_redacted") {
    return "credential_envelope IS NOT NULL AS credential_redacted";
  }
  if (definition.name === "provider_payload_captures" && policy === "scrubbed") {
    if (column === "request_body" || column === "response_body") return `NULL::text AS ${column}`;
    if (column === "scrubbed_at") return "COALESCE(scrubbed_at,captured_at) AS scrubbed_at";
  }
  return safeIdentifier(column);
}

function portableValue(value: unknown, kind: ColumnKind): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (kind === "bigint") return String(value);
  if (kind === "vector" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed;
    } catch {
      throw new BackupDataError("invalid_source", "Database returned an invalid vector");
    }
  }
  return structuredClone(value);
}

interface BackupSnapshotOptions {
  diagnosticPolicy?: BackupDiagnosticPolicy;
  batchSize?: number;
}

async function withBackupSnapshot<T>(
  databaseUrl: string,
  privileged: boolean,
  consumer: (source: PrivilegedBackupExportSource) => Promise<T>,
  options: BackupSnapshotOptions = {},
): Promise<T> {
  const batchSize = options.batchSize ?? BACKUP_DATA_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > BACKUP_DATA_MAX_BATCH_SIZE) {
    throw new BackupDataError("invalid_source", "Backup export batch size is invalid");
  }
  const policy = options.diagnosticPolicy ?? "excluded";
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await sql.begin("isolation level repeatable read read only", async (tx) => {
      const [state] = await tx<{ installation_id: string }[]>`
        SELECT installation_id FROM installation_state WHERE singleton_id=1
      `;
      if (!state) throw new BackupDataError("invariant", "Installation state is missing");
      const [activeEmbeddingBatch] = await tx<{ phase: string }[]>`
        SELECT b.phase FROM document_embedding_batches b
        JOIN jobs j ON j.id=b.job_id
        LEFT JOIN usage_runs u ON u.id=b.usage_run_id
        LEFT JOIN embedding_provider_attempts a ON a.usage_run_id=b.usage_run_id
        WHERE b.phase<>'committed' AND (
          j.status IN ('queued','running') OR u.status='reserved' OR a.status='running'
        )
        ORDER BY b.updated_at LIMIT 1`;
      if (activeEmbeddingBatch) {
        throw new BackupDataError(
          "conflict",
          "Backup cannot start while document embedding publication is incomplete",
        );
      }
      const tables = policy === "excluded"
        ? BACKUP_DATA_TABLES.filter((entry) => entry.name !== "provider_payload_captures")
        : BACKUP_DATA_TABLES;
      let active: string | null = null;
      const source: BackupExportSource & Partial<PrivilegedBackupExportSource> = {
        schemaVersion: BACKUP_DATA_SCHEMA_VERSION,
        installationId: state.installation_id,
        tables,
        rows(tableName: string): AsyncIterable<BackupDataBatch> {
          const definition = tables.find((entry) => entry.name === tableName);
          if (!definition) throw new BackupDataError("invalid_source", "Unknown backup table");
          if (active !== null) {
            throw new BackupDataError("conflict", "Backup tables must be streamed sequentially");
          }
          active = tableName;
          return (async function* () {
            try {
              const columns = definition.columns.map((column) =>
                exportExpression(definition, column, policy)
              ).join(",");
              const query = `SELECT ${columns} FROM ${
                safeIdentifier(definition.name)
              } ORDER BY ${definition.orderBy}`;
              for await (const rows of tx.unsafe(query).cursor(batchSize)) {
                yield rows.map((row: Record<string, unknown>) =>
                  Object.freeze(Object.fromEntries(
                    definition.columns.map((column) => [
                      column,
                      portableValue(row[column], definition.kinds[column]),
                    ]),
                  ))
                );
              }
            } finally {
              active = null;
            }
          })();
        },
      };
      if (privileged) {
        source.providerCredentials = function (): AsyncIterable<BackupProviderCredentialBatch> {
          if (active !== null) {
            throw new BackupDataError(
              "conflict",
              "Backup data streams must be consumed sequentially",
            );
          }
          active = "provider_credentials";
          return (async function* () {
            try {
              for await (
                const rows of tx<{
                  id: string;
                  credential_envelope: ProviderCredentialEnvelope;
                }[]>`
                  SELECT id,credential_envelope FROM providers
                  WHERE credential_envelope IS NOT NULL ORDER BY id
                `.cursor(batchSize)
              ) {
                yield rows.map((row) =>
                  Object.freeze({
                    providerId: row.id,
                    envelope: Object.freeze(structuredClone(row.credential_envelope)),
                  })
                );
              }
            } finally {
              active = null;
            }
          })();
        };
      }
      return await consumer(source as PrivilegedBackupExportSource);
    }) as unknown as T;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Streams only the redacted, portable data surface from one repeatable-read snapshot. */
export function withRepeatableReadBackupSnapshot<T>(
  databaseUrl: string,
  consumer: (source: BackupExportSource) => Promise<T>,
  options: BackupSnapshotOptions = {},
): Promise<T> {
  return withBackupSnapshot(databaseUrl, false, consumer, options);
}

/**
 * Streams portable data and source-encrypted provider envelopes from the exact same snapshot.
 * Callers must keep the credential stream separate from the ordinary backup artifact.
 */
export function withPrivilegedRepeatableReadBackupSnapshot<T>(
  databaseUrl: string,
  consumer: (source: PrivilegedBackupExportSource) => Promise<T>,
  options: BackupSnapshotOptions = {},
): Promise<T> {
  return withBackupSnapshot(databaseUrl, true, consumer, options);
}

function exactRow(definition: BackupDataTable, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupDataError("invalid_source", `${definition.name} row must be an object`);
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...definition.columns].sort();
  if (
    actual.length !== expected.length || actual.some((column, index) => column !== expected[index])
  ) {
    throw new BackupDataError(
      "invalid_source",
      `${definition.name} row columns do not match the catalog`,
    );
  }
  for (const column of definition.columns) validateValue(definition, column, row[column]);
  return row;
}

function exactSourceRow(
  definition: BackupDataTable,
  value: unknown,
  schemaVersion: string,
): Record<string, unknown> {
  if (
    hasCurrentPortableRowShape(schemaVersion) && definition.name === "usage_runs" && value &&
    typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).status === "reserved"
  ) {
    const amount = (value as Record<string, unknown>).reserved_micros;
    let validRecoveryReserve = false;
    try {
      const parsed = typeof amount === "number" && Number.isSafeInteger(amount)
        ? BigInt(amount)
        : typeof amount === "string" && /^-?[0-9]+$/u.test(amount)
        ? BigInt(amount)
        : null;
      validRecoveryReserve = parsed !== null && parsed >= 1n && parsed <= 9_007_199_254_740_991n;
    } catch {
      validRecoveryReserve = false;
    }
    if (!validRecoveryReserve) {
      throw new BackupDataError("invariant", "Backup contains unsafe recovery accounting state");
    }
  }
  if (
    requiresLegacyPortableUpgrade(schemaVersion) && definition.name === "usage_runs" && value &&
    typeof value === "object" && !Array.isArray(value) && !("recovery_owner" in value)
  ) {
    return exactRow(definition, {
      ...(value as Record<string, unknown>),
      // Cross-table ownership is assigned after every row has been staged. Never infer authority
      // from an attacker-controlled run-ID prefix.
      recovery_owner: "provider",
    });
  }
  if (
    requiresLegacyPortableUpgrade(schemaVersion) && definition.name === "tool_executions" &&
    value &&
    typeof value === "object" && !Array.isArray(value) && !("billing_snapshot" in value)
  ) {
    const legacy = value as Record<string, unknown>;
    const activeWithRequiredSnapshot = ["queued_pending_reservation", "queued", "running"].includes(
      String(legacy.status),
    );
    return exactRow(definition, {
      ...legacy,
      // Preserve the legacy state until every table is staged. The relationship-aware accounting
      // repair below can then distinguish an outstanding debit (which must enter a settlement or
      // refund outbox) from an unreserved external call (which must fail closed without replay).
      // Current staging constraints require a snapshot for queued/running states, so use the
      // snapshot-free pending state as a staging-only sentinel; both paths are still nonterminal
      // and the repair always resolves them before staged validation.
      status: activeWithRequiredSnapshot ? "pending_approval" : legacy.status,
      result: activeWithRequiredSnapshot ? null : legacy.result,
      error: legacy.error == null
        ? null
        : { code: "tool_execution_failed", message: "Tool execution failed" },
      billing_snapshot: null,
    });
  }
  if (
    requiresLegacyPortableUpgrade(schemaVersion) && definition.name === "ledger_entries" && value &&
    typeof value === "object" && !Array.isArray(value)
  ) {
    return exactRow(definition, { ...(value as Record<string, unknown>), sequence: null });
  }
  if (
    requiresLegacyPortableUpgrade(schemaVersion) &&
    schemaVersion !== PRE_TOOL_ACCOUNTING_BACKUP_DATA_SCHEMA_VERSION &&
    definition.name === "users" && value &&
    typeof value === "object" && !Array.isArray(value)
  ) {
    const legacy = value as Record<string, unknown>;
    const wasDeleted = legacy.state === "deleted";
    return exactRow(definition, {
      ...legacy,
      state: wasDeleted ? "suspended" : legacy.state,
      version: legacy.version ?? 1,
      authority_epoch: 1,
      deleted_at: wasDeleted
        ? legacy.deleted_at ?? legacy.updated_at ?? legacy.created_at
        : legacy.deleted_at,
    });
  }
  if (
    requiresLegacyPortableUpgrade(schemaVersion) &&
    schemaVersion !== PRE_TOOL_ACCOUNTING_BACKUP_DATA_SCHEMA_VERSION &&
    definition.name === "api_tokens" && value &&
    typeof value === "object" && !Array.isArray(value)
  ) {
    return exactRow(definition, { ...(value as Record<string, unknown>), authority_epoch: 1 });
  }
  if (
    requiresAttachmentControlUpgrade(schemaVersion) &&
    definition.name === "attachments" && value &&
    typeof value === "object" && !Array.isArray(value)
  ) {
    const legacy = value as Record<string, unknown>;
    return exactRow(definition, {
      ...legacy,
      width: "width" in legacy ? legacy.width : null,
      height: "height" in legacy ? legacy.height : null,
      inspection_epoch: 1,
      version: 1,
      // Pre-0050 conversation imports used an exact, server-authored tombstone shape because a
      // physical-presence column did not yet exist. This compatibility rule is intentionally
      // confined to legacy archives; all new writes persist the explicit physical_object bit.
      physical_object: !isCanonicalManifestOnlyAttachmentMetadata(legacy),
      required_inspection_mode: "local",
      inspection_policy_version: "worker-policy-v1",
    });
  }
  if (
    requiresLegacyPortableUpgrade(schemaVersion) && definition.name === "attachments" && value &&
    typeof value === "object" && !Array.isArray(value) && !("width" in value) &&
    !("height" in value)
  ) {
    return exactRow(definition, {
      ...(value as Record<string, unknown>),
      width: null,
      height: null,
    });
  }
  if (
    requiresLegacyPortableUpgrade(schemaVersion) && definition.name === "message_attachments" &&
    value && typeof value === "object" && !Array.isArray(value) && !("position" in value)
  ) {
    return exactRow(definition, { ...(value as Record<string, unknown>), position: null });
  }
  if (
    schemaVersion === LEGACY_BACKUP_DATA_SCHEMA_VERSION && definition.name === "conversations" &&
    value && typeof value === "object" && !Array.isArray(value) &&
    !("temporary_expires_at" in value)
  ) {
    const legacy = value as Record<string, unknown>;
    const createdAt = legacy.created_at;
    const temporary = legacy.temporary;
    const upgraded = {
      ...legacy,
      temporary_expires_at: temporary === true && typeof createdAt === "string" &&
          Number.isFinite(Date.parse(createdAt))
        ? new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString()
        : null,
    };
    return exactRow(definition, upgraded);
  }
  return exactRow(definition, value);
}

function validateValue(definition: BackupDataTable, column: string, value: unknown): void {
  if (value === null) return;
  const kind = definition.kinds[column];
  const invalid = () => {
    throw new BackupDataError(
      "invalid_source",
      `${definition.name}.${column} has an invalid value`,
    );
  };
  if (kind === "uuid") {
    if (
      typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ) invalid();
  } else if (kind === "integer") {
    if (!Number.isSafeInteger(value)) invalid();
  } else if (kind === "bigint") {
    if ((typeof value !== "string" || !/^-?[0-9]+$/u.test(value)) && !Number.isSafeInteger(value)) {
      invalid();
    }
  } else if (kind === "double") {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  } else if (kind === "boolean") {
    if (typeof value !== "boolean") invalid();
  } else if (kind === "timestamp") {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid();
  } else if (kind === "json") {
    try {
      JSON.stringify(value);
    } catch {
      invalid();
    }
  } else if (kind === "vector") {
    if (
      !Array.isArray(value) ||
      value.some((part) => typeof part !== "number" || !Number.isFinite(part))
    ) invalid();
  } else if (typeof value !== "string") invalid();
}

function sqlValue(tx: postgres.TransactionSql, kind: ColumnKind, value: unknown): unknown {
  if (value == null) return null;
  if (kind === "json") return tx.json(value as never);
  if (kind === "vector") return `[${(value as number[]).join(",")}]`;
  return value;
}

async function stageSource(
  tx: postgres.TransactionSql,
  source: BackupDataSource,
  suffix: string,
  objectKeyMap: ReadonlyMap<string, string>,
): Promise<{ stage: Map<string, string>; counts: Record<string, number> }> {
  if (!isSupportedBackupDataSchemaVersion(source.schemaVersion)) {
    throw new BackupDataError("invalid_source", "Backup data schema version is unsupported");
  }
  const stage = new Map<string, string>();
  const counts: Record<string, number> = {};
  for (const definition of BACKUP_DATA_TABLES) {
    const temporary = `backup_${suffix}_${definition.name}`;
    stage.set(definition.name, temporary);
    await tx.unsafe(
      `CREATE TEMP TABLE ${safeIdentifier(temporary)} (LIKE ${
        safeIdentifier(definition.name)
      } INCLUDING ALL) ON COMMIT DROP`,
    );
    if (
      requiresLegacyPortableUpgrade(source.schemaVersion) && definition.name === "ledger_entries"
    ) {
      await tx.unsafe(
        `ALTER TABLE ${safeIdentifier(temporary)} ALTER COLUMN sequence DROP NOT NULL`,
      );
    }
    for (const [column, type] of Object.entries(definition.syntheticColumns ?? {})) {
      await tx.unsafe(
        `ALTER TABLE ${safeIdentifier(temporary)} ADD COLUMN ${safeIdentifier(column)} ${type}`,
      );
    }
    let count = 0;
    const omittedByWireVersion = source.schemaVersion !== BACKUP_DATA_SCHEMA_VERSION &&
        PRE_COMMUNITY_PROFILE_BACKUP_DATA_OMITTED_TABLES.has(definition.name) ||
      requiresAttachmentControlUpgrade(source.schemaVersion) &&
        PRE_ATTACHMENT_CONTROL_BACKUP_DATA_OMITTED_TABLES.has(definition.name) ||
      source.schemaVersion !== BACKUP_DATA_SCHEMA_VERSION &&
        source.schemaVersion !== PRE_COMMUNITY_PROFILE_BACKUP_DATA_SCHEMA_VERSION &&
        source.schemaVersion !== PRE_ATTACHMENT_CONTROL_BACKUP_DATA_SCHEMA_VERSION &&
        PRE_AUTOMATIC_RETENTION_BACKUP_DATA_OMITTED_TABLES.has(definition.name);
    if (omittedByWireVersion) {
      counts[definition.name] = 0;
      continue;
    }
    for await (const batch of source.rows(definition.name)) {
      if (!Array.isArray(batch) || batch.length > BACKUP_DATA_MAX_BATCH_SIZE) {
        throw new BackupDataError("invalid_source", `${definition.name} batch is invalid`);
      }
      if (count + batch.length > BACKUP_DATA_MAX_ROWS_PER_TABLE) {
        throw new BackupDataError("invalid_source", `${definition.name} has too many rows`);
      }
      if (!batch.length) continue;
      const values: unknown[] = [];
      const tuples = batch.map((raw, rowIndex) => {
        const row = exactSourceRow(definition, raw, source.schemaVersion);
        const placeholders = definition.columns.map((column) => {
          let value = row[column];
          if (
            (definition.name === "attachments" ||
              definition.name === "attachment_storage_blobs" ||
              definition.name === "attachment_storage_releases") &&
            column === "object_key" &&
            typeof value === "string"
          ) {
            value = objectKeyMap.get(value) ?? value;
          }
          values.push(sqlValue(tx, definition.kinds[column], value));
          return `$${
            rowIndex * definition.columns.length + definition.columns.indexOf(column) + 1
          }`;
        });
        return `(${placeholders.join(",")})`;
      });
      try {
        await tx.unsafe(
          `INSERT INTO ${safeIdentifier(temporary)} (${
            definition.columns.map(safeIdentifier).join(",")
          }) VALUES ${tuples.join(",")}`,
          values as never[],
        );
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && (code.startsWith("22") || code.startsWith("23"))) {
          throw new BackupDataError(
            "invalid_source",
            `${definition.name} violates schema constraints`,
          );
        }
        throw error;
      }
      count += batch.length;
    }
    counts[definition.name] = count;
  }
  if (source.schemaVersion !== BACKUP_DATA_SCHEMA_VERSION) {
    const schedule = safeIdentifier(stage.get("retention_schedule_state")!);
    await tx.unsafe(
      `INSERT INTO ${schedule}(singleton_id,interval_seconds,next_due_at,updated_at)
       VALUES(1,86400,now(),now()) ON CONFLICT(singleton_id) DO NOTHING`,
    );
  }
  if (requiresAttachmentControlUpgrade(source.schemaVersion)) {
    const attachments = safeIdentifier(stage.get("attachments")!);
    const blobs = safeIdentifier(stage.get("attachment_storage_blobs")!);
    const usage = safeIdentifier(stage.get("attachment_storage_usage")!);
    const installation = safeIdentifier(stage.get("attachment_storage_installation")!);
    await tx.unsafe(
      `INSERT INTO ${blobs}(owner_id,object_key,size_bytes,sha256,mime_type,admitted_at)
       SELECT DISTINCT ON(owner_id,object_key)
         owner_id,object_key,size_bytes,sha256,mime_type,created_at
       FROM ${attachments} WHERE physical_object=true
       ORDER BY owner_id,object_key,created_at,id`,
    );
    await tx.unsafe(
      `INSERT INTO ${usage}(owner_id,physical_bytes,physical_objects,updated_at)
       SELECT owner_id,sum(size_bytes),count(*),now()
       FROM ${blobs} GROUP BY owner_id`,
    );
    await tx.unsafe(
      `INSERT INTO ${installation}(
         singleton_id,physical_bytes,physical_objects,updated_at
       )
       SELECT 1,COALESCE(sum(size_bytes),0),count(*),now() FROM ${blobs}`,
    );
  }
  if (requiresLegacyPortableUpgrade(source.schemaVersion)) {
    // Legacy wire formats predate explicit recovery ownership. Recover only the relationship that
    // is actually present in the portable catalog; API replay and document-batch controls are
    // intentionally ephemeral and therefore cannot appear in an archive.
    await tx.unsafe(
      `UPDATE ${safeIdentifier(stage.get("usage_runs")!)} AS usage SET recovery_owner='tool'
       FROM ${safeIdentifier(stage.get("tool_executions")!)} AS execution
       WHERE usage.id='tool:' || execution.id::text AND usage.user_id=execution.owner_id
         AND usage.token_id IS NULL`,
    );
  }
  if (requiresLegacyPortableUpgrade(source.schemaVersion)) {
    const ledgerName = stage.get("ledger_entries")!;
    const usersName = stage.get("users")!;
    try {
      await tx`SELECT dg_chat_reconstruct_ledger_sequences(
        ${ledgerName}::regclass,
        ${usersName}::regclass
      )`;
    } catch (error) {
      if ((error as { code?: unknown }).code === "23514") {
        throw new BackupDataError("invariant", "Backup ledger history is inconsistent");
      }
      throw error;
    }
    await tx.unsafe(
      `ALTER TABLE ${safeIdentifier(ledgerName)} ALTER COLUMN sequence SET NOT NULL`,
    );
    await upgradeLegacyToolAccounting(tx, stage);
  }
  return { stage, counts };
}

async function upgradeLegacyToolAccounting(
  tx: postgres.TransactionSql,
  stage: ReadonlyMap<string, string>,
): Promise<void> {
  const table = (name: string) => safeIdentifier(stage.get(name)!);
  const usage = table("usage_runs");
  const tools = table("tool_executions");
  const ledger = table("ledger_entries");
  const repair = safeIdentifier(
    `backup_tool_repair_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
  );
  await tx.unsafe(`CREATE TEMP TABLE ${repair} ON COMMIT DROP AS
    SELECT e.id execution_id,u.reserved_micros,u.provider,u.model,
      (u.id IS NOT NULL AND u.user_id=e.owner_id AND u.token_id IS NULL
        AND u.recovery_owner='tool' AND u.status='reserved'
        AND u.reserved_micros BETWEEN 1 AND 9007199254740991
        AND char_length(u.provider) BETWEEN 1 AND 255
        AND char_length(u.model) BETWEEN 1 AND 255
        AND evidence.reserve_count=1 AND evidence.reserve_total=-u.reserved_micros
        AND evidence.terminal_count=0 AND evidence.owner_mismatch_count=0) owned_reserved,
      (u.id IS NOT NULL AND u.user_id=e.owner_id AND u.token_id IS NULL
        AND u.recovery_owner='tool' AND u.status='reserved'
        AND u.reserved_micros BETWEEN 1 AND 9007199254740991
        AND u.provider='tool' AND u.model='tool/' || e.tool_id
        AND evidence.reserve_count=1 AND evidence.reserve_total=-u.reserved_micros
        AND evidence.terminal_count=0 AND evidence.owner_mismatch_count=0) canonical_reserved
    FROM ${tools} e LEFT JOIN ${usage} u ON u.id='tool:' || e.id::text
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE kind='reserve')::int reserve_count,
        COALESCE(sum(amount_micros) FILTER (WHERE kind='reserve'),0)::bigint reserve_total,
        count(*) FILTER (WHERE kind IN ('settle','refund'))::int terminal_count,
        count(*) FILTER (WHERE user_id IS DISTINCT FROM e.owner_id)::int owner_mismatch_count
      FROM ${ledger} WHERE usage_run_id=u.id
    ) evidence ON true`);
  await tx.unsafe(`UPDATE ${tools} e SET billing_snapshot=jsonb_build_object(
      'reservedMicros',r.reserved_micros,'provider',r.provider,'model',r.model)
    FROM ${repair} r WHERE e.id=r.execution_id AND r.owned_reserved`);
  // A restore never replays an old external call. Outstanding canonical successes settle; every
  // other owned debit enters the refund outbox. Rows without debit evidence fail closed.
  await tx.unsafe(`UPDATE ${tools} e SET
      status=CASE WHEN e.status='succeeded' AND r.canonical_reserved
        THEN 'succeeded_pending_settlement'
        WHEN e.status='failed' THEN 'failed_pending_refund'
        ELSE 'cancelled_pending_refund' END,
      result=CASE WHEN e.status='succeeded' AND r.canonical_reserved THEN e.result ELSE NULL END,
      error=CASE WHEN e.status='failed'
        THEN jsonb_build_object('code','tool_execution_failed','message','Tool execution failed')
        ELSE NULL END,
      cancellation_requested_at=CASE
        WHEN e.status IN ('failed','succeeded') AND r.canonical_reserved
          THEN e.cancellation_requested_at
        ELSE COALESCE(e.cancellation_requested_at,now()) END
    FROM ${repair} r WHERE e.id=r.execution_id AND r.owned_reserved
      AND e.status IN ('pending_approval','queued_pending_reservation','queued','running',
        'succeeded','failed','cancelled')`);
  await tx.unsafe(`UPDATE ${tools} e SET status='failed',result=NULL,
      error=jsonb_build_object('code','tool_execution_failed','message','Tool execution failed')
    FROM ${repair} r WHERE e.id=r.execution_id AND NOT r.owned_reserved
      AND e.status IN ('pending_approval','queued_pending_reservation','queued','running')`);
  await tx.unsafe(`UPDATE ${usage} u SET error=CASE
      WHEN e.status IN ('cancelled_pending_refund','cancelled') THEN 'Tool execution was cancelled'
      ELSE COALESCE(e.error->>'message','Tool execution failed') END
    FROM ${tools} e WHERE u.id='tool:' || e.id::text AND u.error IS NOT NULL`);
}

function insertSelection(definition: BackupDataTable): string {
  return definition.insertColumns.map((column) => {
    if (definition.name === "providers" && column === "enabled") {
      return "CASE WHEN credential_redacted THEN false ELSE enabled END AS enabled";
    }
    return safeIdentifier(column);
  }).join(",");
}

/**
 * Credential-redacted restores deliberately stage affected providers as disabled. An enabled OCR
 * source is an operational dependency on its target provider, so stage that source as disabled as
 * well. Its configuration remains intact and will be validated again if an administrator later
 * enables it after restoring credentials and the target provider.
 */
async function disableRedactedOcrSources(
  tx: postgres.TransactionSql,
  stage: ReadonlyMap<string, string>,
): Promise<void> {
  const models = safeIdentifier(stage.get("provider_models")!);
  const providers = safeIdentifier(stage.get("providers")!);
  await tx.unsafe(`UPDATE ${models} source SET enabled=false FROM ${providers} target_provider
    WHERE source.enabled=true AND target_provider.credential_redacted=true
      AND jsonb_typeof(source.custom_params->'ocr')='object'
      AND source.custom_params->'ocr'->>'enabled'='true'
      AND source.custom_params->'ocr'->>'providerId'=target_provider.id::text`);
}

interface BackupRelation {
  from: string;
  columns: readonly string[];
  to: string;
  target: readonly string[];
}

const RELATIONS: readonly BackupRelation[] = Object.freeze([
  { from: "community_profiles", columns: ["user_id"], to: "users", target: ["id"] },
  { from: "auth_users", columns: ["id"], to: "users", target: ["id"] },
  { from: "auth_accounts", columns: ["user_id"], to: "auth_users", target: ["id"] },
  { from: "provider_models", columns: ["provider_id"], to: "providers", target: ["id"] },
  { from: "model_aliases", columns: ["target_model_id"], to: "provider_models", target: ["id"] },
  {
    from: "model_price_versions",
    columns: ["provider_model_id"],
    to: "provider_models",
    target: ["id"],
  },
  {
    from: "provider_model_routes",
    columns: ["source_model_id"],
    to: "provider_models",
    target: ["id"],
  },
  {
    from: "provider_model_routes",
    columns: ["retry_policy_id"],
    to: "provider_retry_policies",
    target: ["id"],
  },
  {
    from: "provider_model_route_targets",
    columns: ["route_id"],
    to: "provider_model_routes",
    target: ["id"],
  },
  {
    from: "provider_model_route_targets",
    columns: ["target_model_id"],
    to: "provider_models",
    target: ["id"],
  },
  { from: "api_tokens", columns: ["user_id"], to: "users", target: ["id"] },
  {
    from: "api_tokens",
    columns: ["rotation_family_id", "rotated_from_token_id"],
    to: "api_tokens",
    target: ["rotation_family_id", "id"],
  },
  {
    from: "api_tokens",
    columns: ["rotation_family_id", "replaced_by_token_id"],
    to: "api_tokens",
    target: ["rotation_family_id", "id"],
  },
  { from: "access_group_users", columns: ["group_id"], to: "access_groups", target: ["id"] },
  { from: "access_group_users", columns: ["user_id"], to: "users", target: ["id"] },
  { from: "access_group_models", columns: ["group_id"], to: "access_groups", target: ["id"] },
  {
    from: "access_group_models",
    columns: ["provider_model_id"],
    to: "provider_models",
    target: ["id"],
  },
  {
    from: "access_group_tokens",
    columns: ["group_id", "user_id"],
    to: "access_group_users",
    target: ["group_id", "user_id"],
  },
  {
    from: "access_group_tokens",
    columns: ["user_id", "token_id"],
    to: "api_tokens",
    target: ["user_id", "id"],
  },
  {
    from: "attachment_storage_usage",
    columns: ["owner_id"],
    to: "users",
    target: ["id"],
  },
  {
    from: "attachment_storage_blobs",
    columns: ["owner_id"],
    to: "users",
    target: ["id"],
  },
  {
    from: "attachment_storage_releases",
    columns: ["owner_id", "object_key"],
    to: "attachment_storage_blobs",
    target: ["owner_id", "object_key"],
  },
  {
    from: "attachment_storage_releases",
    columns: ["owner_id", "usage_run_id"],
    to: "usage_runs",
    target: ["user_id", "id"],
  },
  {
    from: "attachment_storage_releases",
    columns: ["owner_id", "attachment_id"],
    to: "attachments",
    target: ["owner_id", "id"],
  },
  { from: "attachments", columns: ["owner_id"], to: "users", target: ["id"] },
  { from: "conversations", columns: ["owner_id"], to: "users", target: ["id"] },
  {
    from: "conversation_share_snapshots",
    columns: ["owner_id"],
    to: "users",
    target: ["id"],
  },
  {
    from: "conversation_share_snapshots",
    columns: ["conversation_id", "owner_id"],
    to: "conversations",
    target: ["id", "owner_id"],
  },
  { from: "user_preferences", columns: ["user_id"], to: "users", target: ["id"] },
  { from: "conversation_folders", columns: ["owner_id"], to: "users", target: ["id"] },
  {
    from: "conversation_folder_memberships",
    columns: ["folder_id", "owner_id"],
    to: "conversation_folders",
    target: ["id", "owner_id"],
  },
  {
    from: "conversation_folder_memberships",
    columns: ["conversation_id", "owner_id"],
    to: "conversations",
    target: ["id", "owner_id"],
  },
  { from: "conversation_tags", columns: ["owner_id"], to: "users", target: ["id"] },
  {
    from: "conversation_tag_sets",
    columns: ["conversation_id", "owner_id"],
    to: "conversations",
    target: ["id", "owner_id"],
  },
  {
    from: "conversation_tag_bindings",
    columns: ["conversation_id", "owner_id"],
    to: "conversation_tag_sets",
    target: ["conversation_id", "owner_id"],
  },
  {
    from: "conversation_tag_bindings",
    columns: ["tag_id", "owner_id"],
    to: "conversation_tags",
    target: ["id", "owner_id"],
  },
  {
    from: "conversations",
    columns: ["active_leaf_id", "id"],
    to: "messages",
    target: ["id", "conversation_id"],
  },
  { from: "messages", columns: ["conversation_id"], to: "conversations", target: ["id"] },
  {
    from: "messages",
    columns: ["parent_id", "conversation_id"],
    to: "messages",
    target: ["id", "conversation_id"],
  },
  {
    from: "messages",
    columns: ["supersedes_id", "conversation_id"],
    to: "messages",
    target: ["id", "conversation_id"],
  },
  { from: "message_attachments", columns: ["message_id"], to: "messages", target: ["id"] },
  { from: "message_attachments", columns: ["attachment_id"], to: "attachments", target: ["id"] },
  { from: "knowledge_collections", columns: ["owner_id"], to: "users", target: ["id"] },
  {
    from: "knowledge_collection_attachments",
    columns: ["collection_id"],
    to: "knowledge_collections",
    target: ["id"],
  },
  {
    from: "knowledge_collection_attachments",
    columns: ["attachment_id"],
    to: "attachments",
    target: ["id"],
  },
  {
    from: "conversation_knowledge_bindings",
    columns: ["conversation_id"],
    to: "conversations",
    target: ["id"],
  },
  {
    from: "conversation_knowledge_bindings",
    columns: ["collection_id", "owner_id"],
    to: "knowledge_collections",
    target: ["id", "owner_id"],
  },
  { from: "usage_runs", columns: ["user_id"], to: "users", target: ["id"] },
  { from: "usage_runs", columns: ["token_id"], to: "api_tokens", target: ["id"] },
  {
    from: "usage_runs",
    columns: ["pricing_version_id"],
    to: "model_price_versions",
    target: ["id"],
  },
  { from: "ledger_entries", columns: ["user_id"], to: "users", target: ["id"] },
  { from: "provider_attempts", columns: ["usage_run_id"], to: "usage_runs", target: ["id"] },
  { from: "provider_attempts", columns: ["provider_id"], to: "providers", target: ["id"] },
  {
    from: "provider_attempts",
    columns: ["provider_model_id"],
    to: "provider_models",
    target: ["id"],
  },
  {
    from: "provider_attempts",
    columns: ["pricing_version_id"],
    to: "model_price_versions",
    target: ["id"],
  },
  {
    from: "embedding_provider_attempts",
    columns: ["usage_run_id"],
    to: "usage_runs",
    target: ["id"],
  },
  {
    from: "embedding_provider_attempts",
    columns: ["parent_usage_run_id"],
    to: "usage_runs",
    target: ["id"],
  },
  { from: "document_chunks", columns: ["attachment_id"], to: "attachments", target: ["id"] },
  {
    from: "document_chunk_embeddings",
    columns: ["chunk_id"],
    to: "document_chunks",
    target: ["id"],
  },
  { from: "document_chunk_embeddings", columns: ["owner_id"], to: "users", target: ["id"] },
  {
    from: "generated_assets",
    columns: ["owner_id", "usage_run_id"],
    to: "usage_runs",
    target: ["user_id", "id"],
  },
  {
    from: "generated_assets",
    columns: ["provider_model_id"],
    to: "provider_models",
    target: ["id"],
  },
  {
    from: "generated_assets",
    columns: ["pricing_version_id"],
    to: "model_price_versions",
    target: ["id"],
  },
  {
    from: "generated_assets",
    columns: ["owner_id", "attachment_id"],
    to: "attachments",
    target: ["owner_id", "id"],
  },
  {
    from: "generated_asset_inputs",
    columns: ["owner_id", "generated_asset_id"],
    to: "generated_assets",
    target: ["owner_id", "id"],
  },
  {
    from: "generated_asset_inputs",
    columns: ["owner_id", "attachment_id"],
    to: "attachments",
    target: ["owner_id", "id"],
  },
  { from: "tool_policies", columns: ["updated_by"], to: "users", target: ["id"] },
  { from: "tool_executions", columns: ["owner_id"], to: "users", target: ["id"] },
  { from: "tool_executions", columns: ["approved_by"], to: "users", target: ["id"] },
  { from: "message_tool_executions", columns: ["message_id"], to: "messages", target: ["id"] },
  {
    from: "message_tool_executions",
    columns: ["execution_id"],
    to: "tool_executions",
    target: ["id"],
  },
  { from: "audit_events", columns: ["actor_id"], to: "users", target: ["id"] },
  { from: "admin_balance_adjustments", columns: ["actor_id"], to: "users", target: ["id"] },
  {
    from: "admin_balance_adjustments",
    columns: ["target_user_id"],
    to: "users",
    target: ["id"],
  },
  {
    from: "admin_balance_adjustments",
    columns: ["ledger_entry_id"],
    to: "ledger_entries",
    target: ["id"],
  },
  {
    from: "admin_balance_adjustments",
    columns: ["audit_event_id"],
    to: "audit_events",
    target: ["id"],
  },
  { from: "retention_policy_versions", columns: ["updated_by"], to: "users", target: ["id"] },
  {
    from: "retention_policy_state",
    columns: ["current_version"],
    to: "retention_policy_versions",
    target: ["version"],
  },
  {
    from: "retention_scrub_runs",
    columns: ["policy_version"],
    to: "retention_policy_versions",
    target: ["version"],
  },
  { from: "retention_scrub_runs", columns: ["requested_by"], to: "users", target: ["id"] },
  {
    from: "retention_schedule_state",
    columns: ["last_policy_version"],
    to: "retention_policy_versions",
    target: ["version"],
  },
  {
    from: "retention_schedule_state",
    columns: ["last_run_id"],
    to: "retention_scrub_runs",
    target: ["id"],
  },
  {
    from: "provider_payload_captures",
    columns: ["usage_run_id", "provider_attempt_id"],
    to: "provider_attempts",
    target: ["usage_run_id", "id"],
  },
]);

async function validateProviderModels(
  tx: postgres.TransactionSql,
  providersTable: string,
  modelsTable: string,
): Promise<void> {
  const providers = await tx.unsafe<{ id: string; protocol: string; enabled: boolean }[]>(
    `SELECT id,protocol,enabled FROM ${safeIdentifier(providersTable)}`,
  );
  const protocols = new Map(providers.map((provider) => [provider.id, provider.protocol]));
  const rows = await tx.unsafe<{
    id: string;
    provider_id: string;
    public_model_id: string;
    enabled: boolean;
    capabilities: unknown;
    custom_params: unknown;
  }[]>(
    `SELECT id,provider_id,public_model_id,enabled,capabilities,custom_params FROM ${
      safeIdentifier(modelsTable)
    }`,
  );
  const models: ProviderModelInvariantRecord[] = rows.map((row) => {
    if (
      !Array.isArray(row.capabilities) ||
      row.capabilities.length > 64 ||
      !row.capabilities.every((capability) =>
        typeof capability === "string" && isModelCapability(capability)
      ) ||
      new Set(row.capabilities).size !== row.capabilities.length ||
      !row.custom_params || typeof row.custom_params !== "object" ||
      Array.isArray(row.custom_params)
    ) {
      throw new BackupDataError("invariant", `Backup model ${row.public_model_id} is malformed`);
    }
    const protocol = protocols.get(row.provider_id);
    if (protocol !== "chat_completions" && protocol !== "responses") {
      throw new BackupDataError(
        "invariant",
        `Backup model ${row.public_model_id} belongs to an invalid provider protocol`,
      );
    }
    const customParams = row.custom_params as Record<string, unknown>;
    const invalid = providerCustomParamsViolation(customParams, row.public_model_id);
    if (invalid) throw new BackupDataError("invariant", invalid.message);
    const defaults = providerDefaultsViolation(
      protocol as ProviderProtocol,
      customParams,
      row.public_model_id,
    );
    if (defaults) throw new BackupDataError("invariant", defaults.message);
    return {
      id: row.id,
      providerId: row.provider_id,
      publicModelId: row.public_model_id,
      enabled: row.enabled,
      capabilities: row.capabilities as string[],
      customParams,
    };
  });
  const graph = providerModelOcrGraphViolation(models);
  if (graph) throw new BackupDataError("invariant", graph.message);
  const providerDependency = providerOcrTargetProviderViolation(models, providers);
  if (providerDependency) throw new BackupDataError("invariant", providerDependency.message);
}

async function validateStagedDatabase(
  tx: postgres.TransactionSql,
  stage: ReadonlyMap<string, string>,
): Promise<void> {
  const staged = (name: string) => safeIdentifier(stage.get(name)!);
  const [scheduleState] = await tx.unsafe<{ count: number }[]>(
    `SELECT count(*)::int count FROM ${staged("retention_schedule_state")}`,
  );
  if (scheduleState?.count !== 1) {
    throw new BackupDataError(
      "invariant",
      "Restore must contain exactly one retention schedule state",
    );
  }
  const invalidStorageSingleton = await tx.unsafe(
    `SELECT 1 FROM ${staged("attachment_storage_installation")}
      WHERE singleton_id<>1
      UNION ALL
      SELECT 1 WHERE (SELECT count(*) FROM ${staged("attachment_storage_installation")})<>1
      LIMIT 1`,
  );
  if (invalidStorageSingleton.length) {
    throw new BackupDataError(
      "invariant",
      "Restore must contain exactly one attachment storage installation state",
    );
  }
  const invalidStorageAccounting = await tx.unsafe(
    `WITH expected_owner AS (
       SELECT blob.owner_id,sum(blob.size_bytes) physical_bytes,count(*) physical_objects
       FROM ${staged("attachment_storage_blobs")} blob
       LEFT JOIN ${staged("attachment_storage_releases")} release
         ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
       WHERE release.id IS NULL GROUP BY blob.owner_id
     ), owner_mismatch AS (
       SELECT 1 FROM ${staged("attachment_storage_usage")} usage
       FULL JOIN expected_owner expected USING(owner_id)
       WHERE COALESCE(usage.physical_bytes,0)<>COALESCE(expected.physical_bytes,0)
          OR COALESCE(usage.physical_objects,0)<>COALESCE(expected.physical_objects,0)
     ), installation_mismatch AS (
       SELECT 1 FROM ${staged("attachment_storage_installation")} installation
       CROSS JOIN (
         SELECT COALESCE(sum(blob.size_bytes),0) physical_bytes,count(*) physical_objects
         FROM ${staged("attachment_storage_blobs")} blob
         LEFT JOIN ${staged("attachment_storage_releases")} release
           ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
         WHERE release.id IS NULL
       ) expected
       WHERE installation.physical_bytes<>expected.physical_bytes
          OR installation.physical_objects<>expected.physical_objects
     ), attachment_mismatch AS (
       SELECT 1 FROM ${staged("attachments")} attachment
       LEFT JOIN ${staged("attachment_storage_blobs")} blob
         ON blob.owner_id=attachment.owner_id AND blob.object_key=attachment.object_key
       WHERE attachment.physical_object=true AND (
         blob.owner_id IS NULL OR blob.size_bytes<>attachment.size_bytes
          OR blob.sha256<>attachment.sha256 OR blob.mime_type<>attachment.mime_type)
     ), invalid_nonphysical_attachment AS (
       SELECT 1 FROM ${staged("attachments")} attachment
       WHERE attachment.physical_object=false AND (
         attachment.object_key='imports/' || attachment.owner_id::text || '/' ||
           attachment.id::text || '/manifest-only' AND
         attachment.state='failed' AND attachment.deleted_at IS NOT NULL AND
         attachment.inspection_error=
           'Attachment bytes were not included in the .dgchat manifest' AND
         attachment.ingestion_status='failed' AND
         attachment.ingestion_error='Attachment bytes require a separate restore' AND
         attachment.ingested_at IS NULL
       ) IS NOT TRUE
     ), active_blob_without_attachment AS (
       SELECT 1 FROM ${staged("attachment_storage_blobs")} blob
       WHERE NOT EXISTS(
         SELECT 1 FROM ${staged("attachment_storage_releases")} release
         WHERE release.owner_id=blob.owner_id AND release.object_key=blob.object_key
       ) AND NOT EXISTS(
         SELECT 1 FROM ${staged("attachments")} attachment
         WHERE attachment.owner_id=blob.owner_id AND attachment.object_key=blob.object_key
           AND attachment.physical_object=true
       )
     ), invalid_release AS (
       SELECT 1 FROM ${staged("attachment_storage_releases")} release
       JOIN ${staged("attachment_storage_blobs")} blob
         ON blob.owner_id=release.owner_id AND blob.object_key=release.object_key
       LEFT JOIN ${staged("attachments")} attachment
         ON attachment.id=release.attachment_id AND attachment.owner_id=release.owner_id
       WHERE release.size_bytes<>blob.size_bytes OR release.sha256<>blob.sha256 OR
         release.mime_type<>blob.mime_type OR
         release.released_at<blob.admitted_at OR attachment.id IS NULL OR
         attachment.physical_object IS NOT TRUE OR
         attachment.object_key<>release.object_key OR attachment.size_bytes<>release.size_bytes OR
         attachment.sha256<>release.sha256 OR attachment.mime_type<>release.mime_type OR
         attachment.deleted_at IS NULL OR attachment.state<>'deleted' OR
         EXISTS(SELECT 1 FROM ${staged("attachments")} other
           WHERE other.owner_id=release.owner_id AND other.object_key=release.object_key
             AND other.id<>release.attachment_id) OR
         EXISTS(SELECT 1 FROM ${staged("message_attachments")} r
           WHERE r.attachment_id=release.attachment_id) OR
         EXISTS(SELECT 1 FROM ${staged("knowledge_collection_attachments")} r
           WHERE r.attachment_id=release.attachment_id) OR
         EXISTS(SELECT 1 FROM ${staged("document_chunks")} r
           WHERE r.attachment_id=release.attachment_id) OR
         EXISTS(SELECT 1 FROM ${staged("generated_assets")} r
           WHERE r.attachment_id=release.attachment_id OR
             r.usage_run_id=release.usage_run_id) OR
         EXISTS(SELECT 1 FROM ${staged("generated_asset_inputs")} r
           WHERE r.attachment_id=release.attachment_id) OR
         EXISTS(SELECT 1 FROM ${staged("conversation_share_snapshots")} snapshot
           CROSS JOIN LATERAL jsonb_each(snapshot.source_attachments) source
           WHERE source.value->>'attachmentId'=release.attachment_id::text)
     )
     SELECT 1 FROM owner_mismatch
     UNION ALL SELECT 1 FROM installation_mismatch
     UNION ALL SELECT 1 FROM attachment_mismatch
     UNION ALL SELECT 1 FROM invalid_nonphysical_attachment
     UNION ALL SELECT 1 FROM active_blob_without_attachment
     UNION ALL SELECT 1 FROM invalid_release
     LIMIT 1`,
  );
  if (invalidStorageAccounting.length) {
    throw new BackupDataError(
      "invariant",
      "Backup attachment storage accounting is inconsistent",
    );
  }
  for (const relation of RELATIONS) {
    const present = relation.columns.map((column) => `f.${safeIdentifier(column)} IS NOT NULL`)
      .join(" AND ");
    const join = relation.columns.map((column, index) =>
      `t.${safeIdentifier(relation.target[index])}=f.${safeIdentifier(column)}`
    ).join(" AND ");
    const missing = await tx.unsafe(
      `SELECT 1 FROM ${staged(relation.from)} f LEFT JOIN ${
        staged(relation.to)
      } t ON ${join} WHERE ${present} AND t.${safeIdentifier(relation.target[0])} IS NULL LIMIT 1`,
    );
    if (missing.length) {
      throw new BackupDataError(
        "invariant",
        `Backup relationship ${relation.from} to ${relation.to} is invalid`,
      );
    }
  }
  const [admins] = await tx.unsafe<{ count: number }[]>(
    `SELECT count(*)::int count FROM ${
      staged("users")
    } WHERE role='admin' AND approval_status='approved' AND state='active'
      AND deleted_at IS NULL`,
  );
  if (!admins || admins.count < 1) {
    throw new BackupDataError("invariant", "Restore must contain an active approved administrator");
  }
  const staleCredentials = await tx.unsafe(
    `SELECT 1 FROM ${staged("api_tokens")} t JOIN ${staged("users")} u ON u.id=t.user_id
      WHERE t.revoked_at IS NULL AND (
        t.authority_epoch<>u.authority_epoch OR u.approval_status<>'approved' OR
        u.state<>'active' OR u.deleted_at IS NOT NULL OR u.password_reset_pending=true
      ) LIMIT 1`,
  );
  if (staleCredentials.length) {
    throw new BackupDataError("invariant", "Backup contains invalid active API-token authority");
  }
  await validateProviderModels(tx, stage.get("providers")!, stage.get("provider_models")!);
  for await (
    const rows of tx.unsafe(`SELECT id,title,conversation_version,identity_visibility,
      attachment_policy,owner_name_snapshot,public_snapshot,source_attachments,expires_at
      FROM ${staged("conversation_share_snapshots")} ORDER BY id`).cursor(100)
  ) {
    for (const row of rows as Record<string, unknown>[]) {
      try {
        const snapshot = parsePublicConversationShare(row.public_snapshot);
        const sources = row.source_attachments;
        if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw new Error();
        const sourceEntries = Object.entries(sources as Record<string, unknown>);
        const publicAttachmentIds = new Set(snapshot.attachments.map((value) => value.id));
        if (
          snapshot.id !== row.id || snapshot.title !== row.title ||
          snapshot.conversationVersion !== row.conversation_version ||
          snapshot.identity.visibility !== row.identity_visibility ||
          snapshot.identity.displayName !== row.owner_name_snapshot ||
          snapshot.attachmentPolicy !== row.attachment_policy ||
          (snapshot.expiresAt === null) !== (row.expires_at === null) ||
          sourceEntries.length !== publicAttachmentIds.size ||
          sourceEntries.some(([publicId, source]) => {
            if (
              !publicAttachmentIds.has(publicId) || !source || typeof source !== "object" ||
              Array.isArray(source)
            ) return true;
            const keys = Object.keys(source);
            const value = source as Record<string, unknown>;
            return keys.length !== 2 || !keys.includes("attachmentId") ||
              !keys.includes("objectKey") || typeof value.attachmentId !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                value.attachmentId,
              ) || typeof value.objectKey !== "string" || !value.objectKey;
          })
        ) throw new Error();
        if (
          snapshot.expiresAt !== null &&
          new Date(snapshot.expiresAt).getTime() !== new Date(String(row.expires_at)).getTime()
        ) throw new Error();
      } catch {
        throw new BackupDataError("invariant", "Backup contains an invalid conversation share");
      }
    }
  }
  for (const table of ["conversation_folders", "conversation_tags"] as const) {
    const invalid = await tx.unsafe(
      `SELECT 1 FROM ${
        staged(table)
      } WHERE normalized_name<>translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') LIMIT 1`,
    );
    if (invalid.length) {
      throw new BackupDataError(
        "invariant",
        `Backup ${table} contains a nonportable name identity`,
      );
    }
    const duplicate = await tx.unsafe(
      `SELECT 1 FROM ${staged(table)} GROUP BY owner_id,normalized_name HAVING count(*)>1 LIMIT 1`,
    );
    if (duplicate.length) {
      throw new BackupDataError("invariant", `Backup ${table} contains duplicate name identities`);
    }
  }
  const cycles = await tx.unsafe(
    `WITH RECURSIVE walk AS (
      SELECT id,conversation_id,parent_id,ARRAY[id] path,false cycle FROM ${staged("messages")}
      UNION ALL SELECT parent.id,parent.conversation_id,parent.parent_id,walk.path || parent.id,
        parent.id=ANY(walk.path) FROM walk JOIN ${
      staged("messages")
    } parent ON parent.id=walk.parent_id
      WHERE NOT walk.cycle
    ) SELECT 1 FROM walk WHERE cycle LIMIT 1`,
  );
  if (cycles.length) throw new BackupDataError("invariant", "Backup contains a conversation cycle");
  const ledgerMismatch = await tx.unsafe(
    `WITH balances AS (
      SELECT id,user_id,sequence,balance_after_micros,
        row_number() OVER(PARTITION BY user_id ORDER BY sequence) ordinal,
        sum(amount_micros) OVER(PARTITION BY user_id ORDER BY sequence) expected
      FROM ${staged("ledger_entries")}
    ) SELECT 1 FROM balances
      WHERE sequence<>ordinal OR balance_after_micros<>expected LIMIT 1`,
  );
  if (ledgerMismatch.length) {
    throw new BackupDataError("invariant", "Backup ledger history is inconsistent");
  }
  const balanceMismatch = await tx.unsafe(
    `SELECT 1 FROM ${staged("users")} u LEFT JOIN LATERAL (
      SELECT balance_after_micros FROM ${staged("ledger_entries")} l WHERE l.user_id=u.id
      ORDER BY sequence DESC,id DESC LIMIT 1
    ) latest ON true WHERE u.balance_micros<>COALESCE(latest.balance_after_micros,0) LIMIT 1`,
  );
  if (balanceMismatch.length) {
    throw new BackupDataError("invariant", "Backup user balances do not match the ledger");
  }
  const invalidAdjustments = await tx.unsafe(
    `SELECT 1 FROM ${staged("admin_balance_adjustments")} a
      JOIN ${staged("ledger_entries")} l ON l.id=a.ledger_entry_id
      JOIN ${staged("audit_events")} e ON e.id=a.audit_event_id
      WHERE l.user_id<>a.target_user_id OR l.kind<>'adjustment'
        OR l.amount_micros<>a.amount_micros
        OR l.balance_after_micros<>a.balance_after_micros
        OR e.actor_id<>a.actor_id OR e.action<>'user.balance.adjusted'
        OR e.target_type<>'user' OR e.target_id<>a.target_user_id::text
      LIMIT 1`,
  );
  if (invalidAdjustments.length) {
    throw new BackupDataError("invariant", "Backup contains an inconsistent balance adjustment");
  }
  const terminalChecks = [
    ["messages", "status='streaming'"],
    ["provider_attempts", "status='running'"],
    ["embedding_provider_attempts", "status='running'"],
    [
      "tool_executions",
      "status IN ('pending_approval','queued_pending_reservation','queued','running')",
    ],
    ["retention_scrub_runs", "status IN ('queued','running')"],
  ] as const;
  for (const [name, predicate] of terminalChecks) {
    if ((await tx.unsafe(`SELECT 1 FROM ${staged(name)} WHERE ${predicate} LIMIT 1`)).length) {
      throw new BackupDataError("invariant", `Backup contains nonterminal ${name} state`);
    }
  }
  const invalidRecoveryAccounting = await tx.unsafe(`
    WITH valid AS (
      SELECT u.id usage_run_id,e.id execution_id
      FROM ${staged("usage_runs")} u JOIN ${staged("tool_executions")} e
        ON u.id='tool:' || e.id::text AND u.user_id=e.owner_id
      JOIN LATERAL (
        SELECT count(*) FILTER (WHERE kind='reserve')::int reserve_count,
          COALESCE(sum(amount_micros) FILTER (WHERE kind='reserve'),0)::bigint reserve_total,
          count(*) FILTER (WHERE kind IN ('settle','refund'))::int terminal_count,
          count(*) FILTER (WHERE user_id IS DISTINCT FROM u.user_id)::int owner_mismatch_count
        FROM ${staged("ledger_entries")} l
        WHERE l.usage_run_id=u.id
      ) evidence ON true
      WHERE u.status='reserved' AND u.token_id IS NULL AND u.recovery_owner='tool'
        AND e.status IN ('failed_pending_refund','cancelled_pending_refund',
          'succeeded_pending_settlement')
        AND u.reserved_micros BETWEEN 1 AND 9007199254740991
        AND e.billing_snapshot=jsonb_build_object('reservedMicros',u.reserved_micros,
          'provider',u.provider,'model',u.model)
        AND evidence.reserve_count=1 AND evidence.reserve_total=-u.reserved_micros
        AND evidence.terminal_count=0 AND evidence.owner_mismatch_count=0
    )
    SELECT 1 FROM ${staged("usage_runs")} u WHERE u.status='reserved'
      AND NOT EXISTS(SELECT 1 FROM valid v WHERE v.usage_run_id=u.id)
    UNION ALL
    SELECT 1 FROM ${staged("tool_executions")} e
      WHERE e.status IN ('failed_pending_refund','cancelled_pending_refund',
        'succeeded_pending_settlement')
        AND NOT EXISTS(SELECT 1 FROM valid v WHERE v.execution_id=e.id)
    LIMIT 1`);
  if (invalidRecoveryAccounting.length) {
    throw new BackupDataError("invariant", "Backup contains unsafe recovery accounting state");
  }
}

async function validateRestoredDatabase(tx: postgres.TransactionSql): Promise<void> {
  const [admins] = await tx<{ count: number }[]>`
    SELECT count(*)::int count FROM users
    WHERE role='admin' AND approval_status='approved' AND state='active'
      AND deleted_at IS NULL
  `;
  if (!admins || admins.count < 1) {
    throw new BackupDataError("invariant", "Restore must contain an active approved administrator");
  }
  // All three staging catalogs are deliberately excluded from portable data and are truncated
  // before live rows are installed. Keep them in the release audit anyway: this makes the
  // post-apply invariant exactly match online cleanup fencing and fails closed if restore ordering
  // is ever changed without updating validation.
  const invalidStorageAccounting = await tx`
    WITH expected_owner AS (
      SELECT blob.owner_id,sum(blob.size_bytes) physical_bytes,count(*) physical_objects
      FROM attachment_storage_blobs blob
      LEFT JOIN attachment_storage_releases release
        ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
      WHERE release.id IS NULL GROUP BY blob.owner_id
    ), owner_mismatch AS (
      SELECT 1 FROM attachment_storage_usage usage
      FULL JOIN expected_owner expected USING(owner_id)
      WHERE COALESCE(usage.physical_bytes,0)<>COALESCE(expected.physical_bytes,0)
        OR COALESCE(usage.physical_objects,0)<>COALESCE(expected.physical_objects,0)
    ), installation_mismatch AS (
      SELECT 1 FROM attachment_storage_installation installation
      CROSS JOIN (
        SELECT COALESCE(sum(blob.size_bytes),0) physical_bytes,count(*) physical_objects
        FROM attachment_storage_blobs blob
        LEFT JOIN attachment_storage_releases release
          ON release.owner_id=blob.owner_id AND release.object_key=blob.object_key
        WHERE release.id IS NULL
      ) expected
      WHERE installation.singleton_id<>1
        OR installation.physical_bytes<>expected.physical_bytes
        OR installation.physical_objects<>expected.physical_objects
    ), attachment_mismatch AS (
      SELECT 1 FROM attachments attachment
      LEFT JOIN attachment_storage_blobs blob
        ON blob.owner_id=attachment.owner_id AND blob.object_key=attachment.object_key
      WHERE attachment.physical_object=true AND (
        blob.owner_id IS NULL OR blob.size_bytes<>attachment.size_bytes
        OR blob.sha256<>attachment.sha256 OR blob.mime_type<>attachment.mime_type)
    ), invalid_nonphysical_attachment AS (
      SELECT 1 FROM attachments attachment
      WHERE attachment.physical_object=false AND (
        attachment.object_key='imports/' || attachment.owner_id::text || '/' ||
          attachment.id::text || '/manifest-only' AND
        attachment.state='failed' AND attachment.deleted_at IS NOT NULL AND
        attachment.inspection_error=
          'Attachment bytes were not included in the .dgchat manifest' AND
        attachment.ingestion_status='failed' AND
        attachment.ingestion_error='Attachment bytes require a separate restore' AND
        attachment.ingested_at IS NULL
      ) IS NOT TRUE
    ), active_blob_without_attachment AS (
      SELECT 1 FROM attachment_storage_blobs blob
      WHERE NOT EXISTS(
        SELECT 1 FROM attachment_storage_releases release
        WHERE release.owner_id=blob.owner_id AND release.object_key=blob.object_key
      ) AND NOT EXISTS(
        SELECT 1 FROM attachments attachment
        WHERE attachment.owner_id=blob.owner_id AND attachment.object_key=blob.object_key
          AND attachment.physical_object=true
      )
    ), invalid_release AS (
      SELECT 1 FROM attachment_storage_releases release
      JOIN attachment_storage_blobs blob
        ON blob.owner_id=release.owner_id AND blob.object_key=release.object_key
      LEFT JOIN attachments attachment
        ON attachment.id=release.attachment_id AND attachment.owner_id=release.owner_id
      WHERE release.size_bytes<>blob.size_bytes OR release.sha256<>blob.sha256 OR
        release.mime_type<>blob.mime_type OR
        release.released_at<blob.admitted_at OR attachment.id IS NULL OR
        attachment.physical_object IS NOT TRUE OR
        attachment.object_key<>release.object_key OR attachment.size_bytes<>release.size_bytes OR
        attachment.sha256<>release.sha256 OR attachment.mime_type<>release.mime_type OR
        attachment.deleted_at IS NULL OR attachment.state<>'deleted' OR
        EXISTS(SELECT 1 FROM attachments other
          WHERE other.owner_id=release.owner_id AND other.object_key=release.object_key
            AND other.id<>release.attachment_id) OR
        EXISTS(SELECT 1 FROM message_attachments r
          WHERE r.attachment_id=release.attachment_id) OR
        EXISTS(SELECT 1 FROM knowledge_collection_attachments r
          WHERE r.attachment_id=release.attachment_id) OR
        EXISTS(SELECT 1 FROM document_chunks r
          WHERE r.attachment_id=release.attachment_id) OR
        EXISTS(SELECT 1 FROM generated_assets r
          WHERE r.attachment_id=release.attachment_id OR
            r.usage_run_id=release.usage_run_id) OR
        EXISTS(SELECT 1 FROM generated_asset_inputs r
          WHERE r.attachment_id=release.attachment_id) OR
        EXISTS(SELECT 1 FROM generated_object_staging r
          WHERE r.id<>release.stage_id AND r.state<>'cleaned' AND
            (r.attachment_id=release.attachment_id OR
              r.owner_id=release.owner_id AND r.object_key=release.object_key)) OR
        EXISTS(SELECT 1 FROM file_upload_staging r
          WHERE r.attachment_id=release.attachment_id OR
            r.owner_id=release.owner_id AND r.object_key=release.object_key) OR
        EXISTS(SELECT 1 FROM attachment_upload_staging r
          WHERE r.attachment_id=release.attachment_id OR
            r.owner_id=release.owner_id AND r.object_key=release.object_key) OR
        EXISTS(SELECT 1 FROM conversation_share_snapshots snapshot
          CROSS JOIN LATERAL jsonb_each(snapshot.source_attachments) source
          WHERE source.value->>'attachmentId'=release.attachment_id::text)
    )
    SELECT 1 FROM owner_mismatch
    UNION ALL SELECT 1 FROM installation_mismatch
    UNION ALL SELECT 1 FROM attachment_mismatch
    UNION ALL SELECT 1 FROM invalid_nonphysical_attachment
    UNION ALL SELECT 1 FROM active_blob_without_attachment
    UNION ALL SELECT 1 FROM invalid_release
    UNION ALL SELECT 1 WHERE (SELECT count(*) FROM attachment_storage_installation)<>1
    LIMIT 1
  `;
  if (invalidStorageAccounting.length) {
    throw new BackupDataError(
      "invariant",
      "Backup attachment storage accounting is inconsistent",
    );
  }
  await validateProviderModels(tx, "providers", "provider_models");
  const cycles = await tx`
    WITH RECURSIVE walk AS (
      SELECT id,conversation_id,parent_id,ARRAY[id] path,false cycle FROM messages
      UNION ALL
      SELECT parent.id,parent.conversation_id,parent.parent_id,walk.path || parent.id,
        parent.id=ANY(walk.path)
      FROM walk JOIN messages parent ON parent.id=walk.parent_id
      WHERE NOT walk.cycle
    ) SELECT 1 FROM walk WHERE cycle LIMIT 1
  `;
  if (cycles.length) throw new BackupDataError("invariant", "Backup contains a conversation cycle");
  const ledgerMismatch = await tx`
    WITH balances AS (
      SELECT id,user_id,sequence,balance_after_micros,
        row_number() OVER(PARTITION BY user_id ORDER BY sequence) ordinal,
        sum(amount_micros) OVER(PARTITION BY user_id ORDER BY sequence) expected
      FROM ledger_entries
    ) SELECT 1 FROM balances
      WHERE sequence<>ordinal OR balance_after_micros<>expected LIMIT 1
  `;
  if (ledgerMismatch.length) {
    throw new BackupDataError("invariant", "Backup ledger history is inconsistent");
  }
  const userBalanceMismatch = await tx`
    SELECT 1 FROM users u LEFT JOIN LATERAL (
      SELECT balance_after_micros FROM ledger_entries l WHERE l.user_id=u.id
      ORDER BY sequence DESC,id DESC LIMIT 1
    ) latest ON true WHERE u.balance_micros<>COALESCE(latest.balance_after_micros,0) LIMIT 1
  `;
  if (userBalanceMismatch.length) {
    throw new BackupDataError("invariant", "Backup user balances do not match the ledger");
  }
  const invalidAdjustments = await tx`
    SELECT 1 FROM admin_balance_adjustments a
    JOIN ledger_entries l ON l.id=a.ledger_entry_id
    JOIN audit_events e ON e.id=a.audit_event_id
    WHERE l.user_id<>a.target_user_id OR l.kind<>'adjustment'
      OR l.amount_micros<>a.amount_micros
      OR l.balance_after_micros<>a.balance_after_micros
      OR e.actor_id<>a.actor_id OR e.action<>'user.balance.adjusted'
      OR e.target_type<>'user' OR e.target_id<>a.target_user_id::text
    LIMIT 1
  `;
  if (invalidAdjustments.length) {
    throw new BackupDataError("invariant", "Backup contains an inconsistent balance adjustment");
  }
}

async function applyBackupData(
  databaseUrl: string,
  source: BackupDataSource,
  options: {
    dryRun: boolean;
    restoreOperationId?: string;
    expectedOperationVersion?: number;
    expectedInstallationVersion?: number;
    objectKeyMap?: ReadonlyMap<string, string>;
    beforeCommit?: () => void | Promise<void>;
  },
): Promise<BackupRestoreImpact> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await sql.begin("isolation level serializable", async (tx) => {
      let restoreControl:
        | { operation_version: number; installation_version: number; restore_epoch: number }
        | undefined;
      if (!options.dryRun) {
        await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
        const [maintenance] = await tx<{
          operation_version: number;
          installation_version: number;
          restore_epoch: number;
        }[]>`
          SELECT o.version operation_version,s.version installation_version,
            s.restore_epoch::int restore_epoch
          FROM installation_state s JOIN backup_operations o ON o.id=s.active_restore_id
          WHERE s.singleton_id=1 AND s.maintenance_enabled=true
            AND s.active_restore_id=${options.restoreOperationId ?? null}
            AND s.version=${options.expectedInstallationVersion ?? null}
            AND o.version=${options.expectedOperationVersion ?? null}
            AND o.kind='restore' AND o.status='running' AND o.stage='restore_staging'
          FOR UPDATE OF s,o
        `;
        if (!maintenance) {
          throw new BackupDataError(
            "maintenance",
            "Restore operation does not own the expected maintenance fence",
          );
        }
        restoreControl = maintenance;
        const [transactionBinding] = await tx`
          UPDATE installation_state SET restore_transaction_id=pg_current_xact_id()
          WHERE singleton_id=1 AND maintenance_enabled=true
            AND active_restore_id=${options.restoreOperationId!}
            AND restore_transaction_id IS NULL
          RETURNING singleton_id
        `;
        if (!transactionBinding) {
          throw new BackupDataError(
            "maintenance",
            "Restore transaction authority is already bound",
          );
        }
        // Bind the local setting to both the durable operation and this exact transaction. Unlike
        // pg_locks, the xid8 binding cannot confuse a same-key session lock with an xact lock.
        await tx`SELECT set_config('dg_chat.restore_bypass',${options.restoreOperationId!},true)`;
      }
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const { stage, counts } = await stageSource(
        tx,
        source,
        suffix,
        options.objectKeyMap ?? new Map(),
      );
      await disableRedactedOcrSources(tx, stage);
      if (requiresLegacyPortableUpgrade(source.schemaVersion)) {
        const legacyLinks = safeIdentifier(stage.get("message_attachments")!);
        await tx.unsafe(`WITH ranked AS (
          SELECT message_id,attachment_id,
            row_number() OVER(PARTITION BY message_id ORDER BY attachment_id)-1 position
          FROM ${legacyLinks}
        ) UPDATE ${legacyLinks} links SET position=ranked.position
          FROM ranked WHERE ranked.message_id=links.message_id
            AND ranked.attachment_id=links.attachment_id`);
      }
      await validateStagedDatabase(tx, stage);
      const [redacted] = await tx.unsafe<{ count: number }[]>(
        `SELECT count(*)::int count FROM ${
          safeIdentifier(stage.get("providers")!)
        } WHERE credential_redacted=true`,
      );
      const totalRows = Object.values(counts).reduce((sum, count) => sum + count, 0);
      let impact: BackupRestoreImpact = Object.freeze({
        rowsByTable: Object.freeze({ ...counts }),
        totalRows,
        users: counts.users,
        conversations: counts.conversations,
        attachments: counts.attachments,
        providersDisabledForRedactedCredentials: redacted?.count ?? 0,
        restoreOperationVersion: null,
        installationVersion: options.dryRun ? null : restoreControl!.installation_version,
      });
      if (options.dryRun) return impact;

      const lockTables = BACKUP_DATA_TABLES.map((entry) => safeIdentifier(entry.name)).join(",");
      const clearTables = [
        ...BACKUP_DATA_TABLES.map((entry) => safeIdentifier(entry.name)),
        ...BACKUP_EPHEMERAL_TABLES.map(safeIdentifier),
      ].join(",");
      await tx.unsafe(`LOCK TABLE ${lockTables} IN ACCESS EXCLUSIVE MODE`);
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      // Explicitly clear every excluded credential, replay, lease, job, and staging table. The
      // backup control plane and migration bookkeeping are intentionally not in this list.
      await tx.unsafe(`TRUNCATE TABLE ${clearTables} RESTART IDENTITY CASCADE`);
      for (const definition of BACKUP_DATA_TABLES) {
        const temporary = stage.get(definition.name)!;
        await tx.unsafe(
          `INSERT INTO ${safeIdentifier(definition.name)} (${
            definition.insertColumns.map(safeIdentifier).join(",")
          }) SELECT ${insertSelection(definition)} FROM ${
            safeIdentifier(temporary)
          } ORDER BY ${definition.orderBy}`,
        );
      }
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await validateRestoredDatabase(tx);
      await tx`INSERT INTO audit_events(action,target_type,target_id,metadata)
        VALUES('backup.restore.database_committed','backup_operation',${options
        .restoreOperationId!},${
        tx.json({
          restoreEpoch: restoreControl!.restore_epoch,
          rows: totalRows,
          users: counts.users,
          conversations: counts.conversations,
          attachments: counts.attachments,
        })
      })`;
      const [fenced] = await tx<{ version: number }[]>`
        UPDATE backup_operations SET stage='database_restored',version=version+1,updated_at=now()
        WHERE id=${options.restoreOperationId!} AND kind='restore' AND status='running'
          AND stage='restore_staging' AND version=${restoreControl!.operation_version}
        RETURNING version
      `;
      if (!fenced) throw new BackupDataError("conflict", "Restore database commit fence is stale");
      impact = Object.freeze({ ...impact, restoreOperationVersion: fenced.version });
      await options.beforeCommit?.();
      const [releasedBinding] = await tx`
        UPDATE installation_state SET restore_transaction_id=NULL
        WHERE singleton_id=1 AND active_restore_id=${options.restoreOperationId!}
          AND restore_transaction_id=pg_current_xact_id()
        RETURNING singleton_id
      `;
      if (!releasedBinding) {
        throw new BackupDataError("maintenance", "Restore transaction authority was lost");
      }
      return impact;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function dryRunBackupData(
  databaseUrl: string,
  source: BackupDataSource,
): Promise<BackupRestoreImpact> {
  return await applyBackupData(databaseUrl, source, { dryRun: true });
}

export async function restoreBackupData(
  databaseUrl: string,
  source: BackupDataSource,
  options: RestoreBackupDataOptions,
): Promise<BackupRestoreImpact> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      options.restoreOperationId,
    )
  ) {
    throw new BackupDataError("invalid_source", "Restore operation ID is invalid");
  }
  if (
    !Number.isSafeInteger(options.expectedOperationVersion) ||
    options.expectedOperationVersion < 1 ||
    !Number.isSafeInteger(options.expectedInstallationVersion) ||
    options.expectedInstallationVersion < 1
  ) throw new BackupDataError("invalid_source", "Restore control versions are invalid");
  return await applyBackupData(databaseUrl, source, { dryRun: false, ...options });
}
