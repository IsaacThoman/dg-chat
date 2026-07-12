import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "npm:drizzle-orm@0.45.2/pg-core";
import { sql } from "npm:drizzle-orm@0.45.2";

export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const userRole = pgEnum("user_role", ["user", "admin"]);
export const accountState = pgEnum("account_state", ["active", "suspended", "deleted"]);
export const messageRole = pgEnum("message_role", ["system", "user", "assistant", "tool"]);
export const messageStatus = pgEnum("message_status", [
  "complete",
  "streaming",
  "stopped",
  "error",
  "tombstoned",
]);
export const ledgerKind = pgEnum("ledger_kind", [
  "grant",
  "reserve",
  "settle",
  "refund",
  "adjustment",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  passwordResetPending: boolean("password_reset_pending").notNull().default(false),
  passwordResetTokenIdentifier: text("password_reset_token_identifier"),
  role: userRole("role").notNull().default("user"),
  approvalStatus: approvalStatus("approval_status").notNull().default("pending"),
  state: accountState("state").notNull().default("active"),
  balanceMicros: bigint("balance_micros", { mode: "number" }).notNull().default(0),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [uniqueIndex("users_email_uq").on(table.email)]);

// Better Auth owns credentials and browser sessions. These tables intentionally remain
// separate from the domain users/sessions above: domain users are the sole authority for
// approval, role, account state, credits, and API-token eligibility. Auth user IDs mirror
// domain user IDs, and request middleware fails closed when the domain row is missing.
export const authUsers = pgTable("auth_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("auth_users_email_uq").on(table.email)]);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  limited: boolean("limited").notNull().default(true),
}, (table) => [
  uniqueIndex("auth_sessions_token_uq").on(table.token),
  index("auth_sessions_user_idx").on(table.userId),
]);

export const authAccounts = pgTable("auth_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("auth_accounts_user_idx").on(table.userId),
  uniqueIndex("auth_accounts_provider_account_uq").on(table.providerId, table.accountId),
]);

export const authVerifications = pgTable("auth_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("auth_verifications_identifier_idx").on(table.identifier)]);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    limited: boolean("limited").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (
    table,
  ) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

export const identityTokens = pgTable("identity_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("identity_tokens_hash_uq").on(table.tokenHash),
  index("identity_tokens_user_purpose_idx").on(table.userId, table.purpose),
]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  activeLeafId: uuid("active_leaf_id"),
  version: integer("version").notNull().default(0),
  pinned: boolean("pinned").notNull().default(false),
  temporary: boolean("temporary").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("conversations_owner_updated_idx").on(table.ownerId, table.updatedAt)]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, {
    onDelete: "cascade",
  }),
  parentId: uuid("parent_id"),
  supersedesId: uuid("supersedes_id"),
  generationId: uuid("generation_id"),
  siblingIndex: integer("sibling_index").notNull(),
  role: messageRole("role").notNull(),
  content: text("content").notNull(),
  model: text("model"),
  status: messageStatus("status").notNull().default("complete"),
  metadata: jsonb("metadata").notNull().default({}),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("messages_conversation_idempotency_uq").on(
    table.conversationId,
    table.idempotencyKey,
  ),
  uniqueIndex("messages_sibling_uq").on(table.conversationId, table.parentId, table.siblingIndex),
  index("messages_parent_idx").on(table.parentId),
]);

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  state: text("state").notNull().default("pending"),
  inspectionError: text("inspection_error"),
  ingestionStatus: text("ingestion_status").notNull().default("not_applicable"),
  ingestionError: text("ingestion_error"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("attachments_object_key_uq").on(table.objectKey),
  uniqueIndex("attachments_owner_active_hash_uq").on(table.ownerId, table.sha256).where(
    sql`${table.deletedAt} IS NULL`,
  ),
]);

export const messageAttachments = pgTable("message_attachments", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id),
}, (table) => [primaryKey({ columns: [table.messageId, table.attachmentId] })]);

export const knowledgeCollections = pgTable("knowledge_collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  idempotencyKey: text("idempotency_key").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("knowledge_collections_owner_idempotency_uq").on(table.ownerId, table.idempotencyKey),
  index("knowledge_collections_owner_updated_idx").on(table.ownerId, table.updatedAt),
  check("knowledge_collections_version_check", sql`${table.version} >= 1`),
]);

export const knowledgeCollectionAttachments = pgTable("knowledge_collection_attachments", {
  collectionId: uuid("collection_id").notNull().references(() => knowledgeCollections.id, {
    onDelete: "cascade",
  }),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.collectionId, table.attachmentId] })]);

export const conversationKnowledgeBindings = pgTable("conversation_knowledge_bindings", {
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, {
    onDelete: "cascade",
  }),
  collectionId: uuid("collection_id").notNull().references(() => knowledgeCollections.id, {
    onDelete: "cascade",
  }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.collectionId] }),
  index("conversation_knowledge_owner_idx").on(table.ownerId, table.conversationId),
  check("conversation_knowledge_mode_check", sql`${table.mode} IN ('retrieval','full_context')`),
  check("conversation_knowledge_version_check", sql`${table.version} >= 1`),
]);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    preview: text("preview").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (
    table,
  ) => [
    uniqueIndex("api_tokens_hash_uq").on(table.tokenHash),
    index("api_tokens_user_idx").on(table.userId),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    usageRunId: text("usage_run_id").notNull(),
    kind: ledgerKind("kind").notNull(),
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    balanceAfterMicros: bigint("balance_after_micros", { mode: "number" }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (
    table,
  ) => [
    index("ledger_run_kind_idx").on(table.usageRunId, table.kind),
    index("ledger_user_idx").on(table.userId),
  ],
);

export const usageRuns = pgTable("usage_runs", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenId: uuid("token_id").references(() => apiTokens.id),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull().default(0),
  pricingVersionId: uuid("pricing_version_id").references(() => modelPriceVersions.id, {
    onDelete: "restrict",
  }),
  pricingInputMicrosPerMillion: bigint("pricing_input_micros_per_million", { mode: "number" }),
  pricingCachedInputMicrosPerMillion: bigint("pricing_cached_input_micros_per_million", {
    mode: "number",
  }),
  pricingReasoningMicrosPerMillion: bigint("pricing_reasoning_micros_per_million", {
    mode: "number",
  }),
  pricingOutputMicrosPerMillion: bigint("pricing_output_micros_per_million", { mode: "number" }),
  pricingFixedCallMicros: bigint("pricing_fixed_call_micros", { mode: "number" }),
  pricingSource: text("pricing_source"),
  executionEpoch: integer("execution_epoch").notNull().default(0),
  executionOwnerLeaseToken: uuid("execution_owner_lease_token"),
  runLeaseToken: uuid("run_lease_token"),
  runLeaseExpiresAt: timestamp("run_lease_expires_at", { withTimezone: true }),
  actualProviderCostMicros: bigint("actual_provider_cost_micros", { mode: "number" }).notNull()
    .default(0),
  actualProviderInputTokens: bigint("actual_provider_input_tokens", { mode: "number" }).notNull()
    .default(0),
  actualProviderCachedInputTokens: bigint("actual_provider_cached_input_tokens", { mode: "number" })
    .notNull().default(0),
  actualProviderReasoningTokens: bigint("actual_provider_reasoning_tokens", { mode: "number" })
    .notNull().default(0),
  actualProviderOutputTokens: bigint("actual_provider_output_tokens", { mode: "number" }).notNull()
    .default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  latencyMs: integer("latency_ms"),
  ttftMs: integer("ttft_ms"),
  error: text("error"),
  generationLeaseToken: uuid("generation_lease_token"),
  generationLeaseExpiresAt: timestamp("generation_lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("usage_runs_analytics_time_idx").on(table.createdAt.desc(), table.id),
  index("usage_runs_analytics_user_time_idx").on(table.userId, table.createdAt.desc(), table.id),
  check(
    "usage_runs_pricing_snapshot_check",
    sql`(
      (${table.pricingVersionId} IS NULL AND
        ${table.pricingInputMicrosPerMillion} IS NULL AND
        ${table.pricingCachedInputMicrosPerMillion} IS NULL AND
        ${table.pricingReasoningMicrosPerMillion} IS NULL AND
        ${table.pricingOutputMicrosPerMillion} IS NULL AND
        ${table.pricingFixedCallMicros} IS NULL AND
        ${table.pricingSource} IS NULL)
      OR
      (${table.pricingVersionId} IS NOT NULL AND
        ${table.pricingInputMicrosPerMillion} IS NOT NULL AND
        ${table.pricingCachedInputMicrosPerMillion} IS NOT NULL AND
        ${table.pricingReasoningMicrosPerMillion} IS NOT NULL AND
        ${table.pricingOutputMicrosPerMillion} IS NOT NULL AND
        ${table.pricingFixedCallMicros} IS NOT NULL AND
        ${table.pricingSource} IS NOT NULL AND
        ${table.pricingInputMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND
        ${table.pricingCachedInputMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND
        ${table.pricingReasoningMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND
        ${table.pricingOutputMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND
        ${table.pricingFixedCallMicros} BETWEEN 0 AND 9007199254740991 AND
        char_length(${table.pricingSource}) BETWEEN 1 AND 120)
    )`,
  ),
  check(
    "usage_runs_provider_execution_check",
    sql`${table.executionEpoch} >= 0 AND ${table.actualProviderCostMicros} BETWEEN 0 AND 9007199254740991 AND ${table.actualProviderInputTokens} BETWEEN 0 AND 9007199254740991 AND ${table.actualProviderCachedInputTokens} BETWEEN 0 AND ${table.actualProviderInputTokens} AND ${table.actualProviderReasoningTokens} BETWEEN 0 AND ${table.actualProviderOutputTokens} AND ${table.actualProviderOutputTokens} BETWEEN 0 AND 9007199254740991`,
  ),
]);

export const generationControls = pgTable("generation_controls", {
  runId: text("run_id").primaryKey().references(() => usageRuns.id, { onDelete: "cascade" }),
  generationId: uuid("generation_id").notNull(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, {
    onDelete: "cascade",
  }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  userMessageId: uuid("user_message_id").notNull().references(() => messages.id, {
    onDelete: "cascade",
  }),
  mode: text("mode").notNull().default("send"),
  sourceMessageId: uuid("source_message_id").references(() => messages.id, {
    onDelete: "restrict",
  }),
  stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("generation_controls_generation_uq").on(table.generationId),
  index("generation_controls_owner_idx").on(table.ownerId, table.conversationId),
  uniqueIndex("generation_controls_active_source_uq").on(
    table.conversationId,
    table.sourceMessageId,
  )
    .where(sql`${table.terminalAt} IS NULL AND ${table.sourceMessageId} IS NOT NULL`),
  uniqueIndex("generation_controls_active_conversation_uq").on(table.conversationId)
    .where(sql`${table.terminalAt} IS NULL`),
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  lastError: text("last_error"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("jobs_claim_idx").on(table.status, table.availableAt),
  index("jobs_admin_page_idx").on(table.createdAt.desc(), table.id.desc()),
  uniqueIndex("jobs_idempotency_key_uq").on(table.idempotencyKey),
]);

export const documentChunks = pgTable("document_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id, {
    onDelete: "cascade",
  }),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  metadata: jsonb("metadata").notNull().default({}),
}, (table) => [
  uniqueIndex("document_chunks_attachment_ordinal_uq").on(table.attachmentId, table.ordinal),
]);

export const documentChunkEmbeddings = pgTable("document_chunk_embeddings", {
  chunkId: uuid("chunk_id").notNull().references(() => documentChunks.id, {
    onDelete: "cascade",
  }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  embeddingVersion: text("embedding_version").notNull(),
  contentSha256: text("content_sha256").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chunkId, table.embeddingVersion] }),
  index("document_chunk_embeddings_owner_version_idx").on(
    table.ownerId,
    table.embeddingVersion,
    table.chunkId,
  ),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").references(() => users.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_events_page_idx").on(table.createdAt.desc(), table.id.desc()),
  index("audit_events_action_page_idx").on(
    table.action,
    table.createdAt.desc(),
    table.id.desc(),
  ),
  index("audit_events_actor_page_idx").on(
    table.actorId,
    table.createdAt.desc(),
    table.id.desc(),
  ),
  index("audit_events_target_page_idx").on(
    table.targetType,
    table.targetId,
    table.createdAt.desc(),
    table.id.desc(),
  ),
  index("audit_events_target_id_page_idx").on(
    table.targetId,
    table.createdAt.desc(),
    table.id.desc(),
  ),
]);

export const apiIdempotencyRequests = pgTable("api_idempotency_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  stream: boolean("stream").notNull(),
  model: text("model").notNull(),
  state: text("state").notNull(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  usageRunId: text("usage_run_id").notNull().unique(
    "api_idempotency_requests_usage_run_id_key",
  ).references(() => usageRuns.id),
  responseStatus: integer("response_status"),
  responseHeaders: jsonb("response_headers").$type<Record<string, string>>().notNull().default({}),
  responseBody: text("response_body"),
  failureStartedStream: boolean("failure_started_stream").notNull().default(false),
  observedInputTokens: integer("observed_input_tokens").notNull().default(0),
  observedOutputTokens: integer("observed_output_tokens").notNull().default(0),
  observedCostMicros: bigint("observed_cost_micros", { mode: "number" }).notNull().default(0),
  observedLatencyMs: integer("observed_latency_ms").notNull().default(0),
  retentionSeconds: integer("retention_seconds").notNull().default(86400),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  unique("api_idempotency_requests_user_id_endpoint_idempotency_key_key").on(
    table.userId,
    table.endpoint,
    table.idempotencyKey,
  ),
  index("api_idempotency_lease_idx").on(table.state, table.leaseExpiresAt).where(
    sql`${table.state} = 'in_progress'`,
  ),
  index("api_idempotency_expiry_idx").on(table.expiresAt),
]);

export const apiIdempotencyEvents = pgTable("api_idempotency_events", {
  requestId: uuid("request_id").notNull().references(() => apiIdempotencyRequests.id, {
    onDelete: "cascade",
  }),
  sequence: integer("sequence").notNull(),
  frame: text("frame").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.requestId, table.sequence] })]);

export const providers = pgTable("providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  baseUrl: text("base_url").notNull(),
  protocol: text("protocol").$type<"chat_completions" | "responses">().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  version: integer("version").notNull().default(1),
  credentialEnvelope: jsonb("credential_envelope").$type<Record<string, unknown>>(),
  credentialUpdatedAt: timestamp("credential_updated_at", { withTimezone: true }),
  healthStatus: text("health_status").$type<
    "unknown" | "healthy" | "unhealthy" | "disabled"
  >().notNull().default("unknown"),
  healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
  healthLatencyMs: integer("health_latency_ms"),
  healthError: text("health_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("providers_slug_uq").on(table.slug),
  index("providers_enabled_display_idx").on(table.enabled, table.displayName, table.id),
  index("providers_health_idx").on(table.healthStatus, table.healthCheckedAt.desc()),
  check("providers_slug_check", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
  check(
    "providers_protocol_check",
    sql`${table.protocol} IN ('chat_completions','responses')`,
  ),
  check(
    "providers_health_status_check",
    sql`${table.healthStatus} IN ('unknown','healthy','unhealthy','disabled')`,
  ),
  check("providers_version_check", sql`${table.version} >= 1`),
]);

export const providerModels = pgTable("provider_models", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id").notNull().references(() => providers.id, {
    onDelete: "restrict",
  }),
  publicModelId: text("public_model_id").notNull(),
  upstreamModelId: text("upstream_model_id").notNull(),
  displayName: text("display_name").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  contextWindow: integer("context_window").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  version: integer("version").notNull().default(1),
  customParams: jsonb("custom_params").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("provider_models_public_model_id_uq").on(table.publicModelId),
  index("provider_models_provider_enabled_idx").on(
    table.providerId,
    table.enabled,
    table.displayName,
    table.id,
  ),
  index("provider_models_enabled_public_idx").on(table.enabled, table.publicModelId),
  check(
    "provider_models_display_name_check",
    sql`char_length(${table.displayName}) BETWEEN 1 AND 120`,
  ),
  check("provider_models_capabilities_check", sql`jsonb_typeof(${table.capabilities}) = 'array'`),
  check("provider_models_custom_params_check", sql`jsonb_typeof(${table.customParams}) = 'object'`),
  check("provider_models_context_window_check", sql`${table.contextWindow} > 0`),
  check("provider_models_version_check", sql`${table.version} >= 1`),
]);

export const modelPriceVersions = pgTable("model_price_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerModelId: uuid("provider_model_id").notNull().references(() => providerModels.id, {
    onDelete: "restrict",
  }),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  inputMicrosPerMillion: bigint("input_micros_per_million", { mode: "number" }).notNull(),
  cachedInputMicrosPerMillion: bigint("cached_input_micros_per_million", { mode: "number" })
    .notNull(),
  reasoningMicrosPerMillion: bigint("reasoning_micros_per_million", { mode: "number" })
    .notNull(),
  outputMicrosPerMillion: bigint("output_micros_per_million", { mode: "number" }).notNull(),
  fixedCallMicros: bigint("fixed_call_micros", { mode: "number" }).notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("model_price_versions_model_effective_uq").on(
    table.providerModelId,
    table.effectiveAt,
  ),
  index("model_price_versions_effective_idx").on(
    table.providerModelId,
    table.effectiveAt.desc(),
    table.id.desc(),
  ),
  check(
    "model_price_versions_amounts_check",
    sql`${table.inputMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND ${table.cachedInputMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND ${table.reasoningMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND ${table.outputMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND ${table.fixedCallMicros} BETWEEN 0 AND 9007199254740991`,
  ),
]);

export const providerRetryPolicies = pgTable("provider_retry_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  maxAttempts: integer("max_attempts").notNull(),
  maxRetries: integer("max_retries").notNull(),
  baseDelayMs: integer("base_delay_ms").notNull(),
  maxDelayMs: integer("max_delay_ms").notNull(),
  backoffMultiplierBps: integer("backoff_multiplier_bps").notNull(),
  jitterBps: integer("jitter_bps").notNull(),
  firstTokenTimeoutMs: integer("first_token_timeout_ms").notNull(),
  idleTimeoutMs: integer("idle_timeout_ms").notNull(),
  totalTimeoutMs: integer("total_timeout_ms").notNull(),
  retryableStatuses: jsonb("retryable_statuses").$type<number[]>().notNull().default([]),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("provider_retry_policies_name_uq").on(table.name),
  index("provider_retry_policies_enabled_name_idx").on(table.enabled, table.name, table.id),
  check(
    "provider_retry_policies_name_check",
    sql`char_length(btrim(${table.name})) BETWEEN 1 AND 120`,
  ),
  check(
    "provider_retry_policies_attempts_check",
    sql`${table.maxAttempts} BETWEEN 1 AND 8 AND ${table.maxRetries} BETWEEN 0 AND 3 AND ${table.maxRetries} < ${table.maxAttempts}`,
  ),
  check(
    "provider_retry_policies_delay_check",
    sql`${table.baseDelayMs} BETWEEN 0 AND 60000 AND ${table.maxDelayMs} BETWEEN ${table.baseDelayMs} AND 300000`,
  ),
  check(
    "provider_retry_policies_backoff_check",
    sql`${table.backoffMultiplierBps} BETWEEN 10000 AND 40000 AND ${table.jitterBps} BETWEEN 0 AND 10000`,
  ),
  check(
    "provider_retry_policies_timeout_check",
    sql`${table.firstTokenTimeoutMs} BETWEEN 250 AND 300000 AND ${table.idleTimeoutMs} BETWEEN 250 AND 300000 AND ${table.totalTimeoutMs} BETWEEN GREATEST(${table.firstTokenTimeoutMs},${table.idleTimeoutMs}) AND 900000`,
  ),
  check(
    "provider_retry_policies_statuses_check",
    sql`jsonb_typeof(${table.retryableStatuses}) = 'array' AND jsonb_array_length(${table.retryableStatuses}) <= 7 AND ${table.retryableStatuses} <@ '[408,425,429,500,502,503,504]'::jsonb`,
  ),
  check("provider_retry_policies_version_check", sql`${table.version} >= 1`),
]);

export const providerModelRoutes = pgTable("provider_model_routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceModelId: uuid("source_model_id").notNull().references(() => providerModels.id, {
    onDelete: "restrict",
  }),
  retryPolicyId: uuid("retry_policy_id").references(() => providerRetryPolicies.id, {
    onDelete: "restrict",
  }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("provider_model_routes_source_uq").on(table.sourceModelId),
  check("provider_model_routes_version_check", sql`${table.version} >= 1`),
]);

export const providerModelRouteTargets = pgTable("provider_model_route_targets", {
  routeId: uuid("route_id").notNull().references(() => providerModelRoutes.id, {
    onDelete: "cascade",
  }),
  targetModelId: uuid("target_model_id").notNull().references(() => providerModels.id, {
    onDelete: "restrict",
  }),
  ordinal: integer("ordinal").notNull(),
}, (table) => [
  primaryKey({ columns: [table.routeId, table.ordinal] }),
  unique("provider_model_route_targets_route_target_uq").on(table.routeId, table.targetModelId),
  index("provider_model_route_targets_target_idx").on(table.targetModelId),
  check("provider_model_route_targets_ordinal_check", sql`${table.ordinal} BETWEEN 1 AND 8`),
]);

export const providerAttempts = pgTable("provider_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  usageRunId: text("usage_run_id").notNull().references(() => usageRuns.id, {
    onDelete: "restrict",
  }),
  attemptNumber: integer("attempt_number").notNull(),
  executionEpoch: integer("execution_epoch").notNull(),
  targetOrdinal: integer("target_ordinal").notNull(),
  retryNumber: integer("retry_number").notNull(),
  reason: text("reason").notNull(),
  breakerBefore: text("breaker_before"),
  breakerAfter: text("breaker_after"),
  retryable: boolean("retryable").notNull().default(false),
  providerId: uuid("provider_id").notNull().references(() => providers.id, {
    onDelete: "restrict",
  }),
  providerSlug: text("provider_slug").notNull(),
  providerVersion: integer("provider_version").notNull(),
  protocol: text("protocol").notNull(),
  providerModelId: uuid("provider_model_id").notNull().references(() => providerModels.id, {
    onDelete: "restrict",
  }),
  publicModelId: text("public_model_id").notNull(),
  upstreamModelId: text("upstream_model_id").notNull(),
  modelVersion: integer("model_version").notNull(),
  pricingVersionId: uuid("pricing_version_id").notNull().references(() => modelPriceVersions.id, {
    onDelete: "restrict",
  }),
  pricingInputMicrosPerMillion: bigint("pricing_input_micros_per_million", { mode: "number" })
    .notNull(),
  pricingCachedInputMicrosPerMillion: bigint("pricing_cached_input_micros_per_million", {
    mode: "number",
  }).notNull(),
  pricingReasoningMicrosPerMillion: bigint("pricing_reasoning_micros_per_million", {
    mode: "number",
  }).notNull(),
  pricingOutputMicrosPerMillion: bigint("pricing_output_micros_per_million", { mode: "number" })
    .notNull(),
  pricingFixedCallMicros: bigint("pricing_fixed_call_micros", { mode: "number" }).notNull(),
  pricingSource: text("pricing_source").notNull(),
  status: text("status").notNull().default("running"),
  phase: text("phase").notNull().default("planning"),
  errorCode: text("error_code"),
  httpStatus: integer("http_status"),
  visibleOutput: boolean("visible_output").notNull().default(false),
  inputTokens: integer("input_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  reasoningTokens: integer("reasoning_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  tokenSource: text("token_source").notNull().default("none"),
  costSource: text("cost_source").notNull().default("none"),
  latencyMs: integer("latency_ms"),
  ttftMs: integer("ttft_ms"),
  upstreamRequestId: text("upstream_request_id"),
  tokensPerSecond: doublePrecision("tokens_per_second"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  unique("provider_attempts_run_number_uq").on(table.usageRunId, table.attemptNumber),
  index("provider_attempts_run_idx").on(table.usageRunId, table.attemptNumber),
  check("provider_attempts_attempt_number_check", sql`${table.attemptNumber} BETWEEN 1 AND 16`),
  check("provider_attempts_execution_epoch_check", sql`${table.executionEpoch} >= 1`),
  check(
    "provider_attempts_position_check",
    sql`${table.targetOrdinal} BETWEEN 0 AND 7 AND ${table.retryNumber} BETWEEN 0 AND 3`,
  ),
  check(
    "provider_attempts_reason_check",
    sql`${table.reason} IN ('primary','retry','fallback','circuit_skip','half_open')`,
  ),
  check(
    "provider_attempts_breaker_check",
    sql`(${table.breakerBefore} IS NULL OR ${table.breakerBefore} IN ('closed','open','half_open','unavailable')) AND (${table.breakerAfter} IS NULL OR ${table.breakerAfter} IN ('closed','open','half_open','unavailable'))`,
  ),
  check(
    "provider_attempts_versions_check",
    sql`${table.providerVersion} >= 1 AND ${table.modelVersion} >= 1`,
  ),
  check(
    "provider_attempts_status_check",
    sql`${table.status} IN ('running','succeeded','failed','cancelled','skipped')`,
  ),
  check(
    "provider_attempts_phase_check",
    sql`${table.phase} IN ('planning','connect','headers','first_token','streaming','complete')`,
  ),
  check(
    "provider_attempts_sources_check",
    sql`${table.tokenSource} IN ('provider','estimated','none') AND ${table.costSource} IN ('provider','calculated','none')`,
  ),
  check(
    "provider_attempts_token_check",
    sql`${table.inputTokens} >= 0 AND ${table.cachedInputTokens} BETWEEN 0 AND ${table.inputTokens} AND ${table.outputTokens} >= 0 AND ${table.reasoningTokens} BETWEEN 0 AND ${table.outputTokens}`,
  ),
  check(
    "provider_attempts_terminal_check",
    sql`(${table.status} = 'running' AND ${table.completedAt} IS NULL) OR (${table.status} <> 'running' AND ${table.completedAt} IS NOT NULL)`,
  ),
  check(
    "provider_attempts_metrics_check",
    sql`${table.costMicros} BETWEEN 0 AND 9007199254740991 AND (${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0) AND (${table.ttftMs} IS NULL OR (${table.latencyMs} IS NOT NULL AND ${table.ttftMs} >= 0 AND ${table.ttftMs} <= ${table.latencyMs}))`,
  ),
  check(
    "provider_attempts_snapshot_text_check",
    sql`char_length(${table.providerSlug}) BETWEEN 1 AND 63 AND char_length(${table.publicModelId}) BETWEEN 3 AND 255 AND char_length(${table.upstreamModelId}) BETWEEN 1 AND 255 AND char_length(${table.pricingSource}) BETWEEN 1 AND 120 AND (${table.upstreamRequestId} IS NULL OR ${table.upstreamRequestId} ~ '^[A-Za-z0-9._:-]{1,255}$')`,
  ),
  check(
    "provider_attempts_throughput_check",
    sql`${table.tokensPerSecond} IS NULL OR (${table.tokensPerSecond} >= 0 AND ${table.tokensPerSecond} <= 1000000)`,
  ),
  check(
    "provider_attempts_terminal_semantics_check",
    sql`(${table.status}='succeeded' AND ${table.phase}='complete' AND ${table.errorCode} IS NULL AND (${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 200 AND 299)) OR (${table.status}='running') OR (${table.status} IN ('failed','cancelled','skipped') AND ${table.errorCode} IS NOT NULL)`,
  ),
  check(
    "provider_attempts_skipped_check",
    sql`${table.status}<>'skipped' OR (NOT ${table.visibleOutput} AND ${table.inputTokens}=0 AND ${table.outputTokens}=0 AND ${table.costMicros}=0 AND ${table.tokenSource}='none' AND ${table.costSource}='none')`,
  ),
]);
