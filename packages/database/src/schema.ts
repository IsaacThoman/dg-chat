import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "npm:drizzle-orm@0.45.2/pg-core";
import { sql } from "npm:drizzle-orm@0.45.2";

export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const userRole = pgEnum("user_role", ["user", "admin"]);
// PostgreSQL installations retain the historical `deleted` enum label because PostgreSQL cannot
// safely remove enum values in-place. Application state is intentionally narrower: soft deletion
// is represented independently by users.deleted_at and migration 0037 prevents new legacy values.
export const accountState = pgEnum("account_state", ["active", "suspended"]);
const xid8 = customType<{ data: string }>({ dataType: () => "xid8" });
export const messageRole = pgEnum("message_role", [
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
]);
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
  version: integer("version").notNull().default(1),
  authorityEpoch: bigint("authority_epoch", { mode: "number" }).notNull().default(1),
  balanceMicros: bigint("balance_micros", { mode: "number" }).notNull().default(0),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("users_email_uq").on(table.email),
  index("users_created_cursor_idx").on(table.createdAt.desc(), table.id.desc()),
  check("users_version_check", sql`${table.version} >= 1`),
  check("users_authority_epoch_check", sql`${table.authorityEpoch} BETWEEN 1 AND 9007199254740991`),
  check("users_account_state_check", sql`${table.state} IN ('active','suspended')`),
  check(
    "users_balance_safe_check",
    sql`${table.balanceMicros} BETWEEN 0 AND 9007199254740991`,
  ),
]);

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
  authorityEpoch: bigint("authority_epoch", { mode: "number" }).notNull().default(1),
}, (table) => [
  uniqueIndex("auth_sessions_token_uq").on(table.token),
  check(
    "auth_sessions_authority_epoch_check",
    sql`${table.authorityEpoch} BETWEEN 1 AND 9007199254740991`,
  ),
  index("auth_sessions_user_idx").on(table.userId),
  index("auth_sessions_user_page_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
]);

// Migration 0042 installs the database-level issuance fence for this table. Drizzle does not
// model triggers: every full-session insert is serialized against the matching domain users row
// and revalidates approval/lifecycle state; only limited pre-provision signup sessions may lack it.

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
  authorityEpoch: bigint("authority_epoch", { mode: "number" }),
}, (table) => [index("auth_verifications_identifier_idx").on(table.identifier)]);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    limited: boolean("limited").notNull().default(false),
    authorityEpoch: bigint("authority_epoch", { mode: "number" }).notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (
    table,
  ) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    check(
      "sessions_authority_epoch_check",
      sql`${table.authorityEpoch} BETWEEN 1 AND 9007199254740991`,
    ),
    index("sessions_user_idx").on(table.userId),
    index("sessions_user_page_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
  ],
);

export const identityTokens = pgTable("identity_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  authorityEpoch: bigint("authority_epoch", { mode: "number" }).notNull().default(1),
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
  temporaryExpiresAt: timestamp("temporary_expires_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("conversations_owner_updated_idx").on(table.ownerId, table.updatedAt),
  index("conversations_title_trgm_idx").using("gin", sql`lower(${table.title}) gin_trgm_ops`),
  index("conversations_owner_lifecycle_search_idx").on(
    table.ownerId,
    table.deletedAt,
    table.archivedAt,
    table.updatedAt.desc(),
    table.id.desc(),
  ),
  index("conversations_owner_temporary_expiry_idx").on(
    table.ownerId,
    table.temporaryExpiresAt,
    table.id,
  ).where(sql`${table.temporary} = true`),
  index("conversations_temporary_expiry_global_idx").on(table.temporaryExpiresAt, table.id)
    .where(sql`${table.temporary} = true`),
  unique("conversations_id_owner_uq").on(table.id, table.ownerId),
  check(
    "conversations_temporary_expiry_check",
    sql`(${table.temporary} = true AND ${table.temporaryExpiresAt} IS NOT NULL) OR (${table.temporary} = false AND ${table.temporaryExpiresAt} IS NULL)`,
  ),
]);

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  theme: text("theme").notNull().default("system"),
  compactConversations: boolean("compact_conversations").notNull().default(false),
  reduceMotion: boolean("reduce_motion").notNull().default(false),
  customInstructions: text("custom_instructions").notNull().default(""),
  useMemory: boolean("use_memory").notNull().default(false),
  saveHistory: boolean("save_history").notNull().default(true),
  preferredModelId: text("preferred_model_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("user_preferences_version_check", sql`${table.version} >= 1`),
  check("user_preferences_theme_check", sql`${table.theme} IN ('light','dark','system')`),
  check(
    "user_preferences_instructions_check",
    sql`char_length(${table.customInstructions}) <= 20000`,
  ),
]);

export const conversationPortabilityImports = pgTable("conversation_portability_imports", {
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.idempotencyKey] }),
  index("conversation_portability_imports_owner_created_idx").on(table.ownerId, table.createdAt),
  check(
    "conversation_portability_imports_key_check",
    sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
  ),
  check(
    "conversation_portability_imports_hash_check",
    sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
  ),
]);

export const conversationFolders = pgTable("conversation_folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  position: integer("position").notNull().default(0),
  version: integer("version").notNull().default(1),
  membershipVersion: integer("membership_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("conversation_folders_owner_name_uq").on(table.ownerId, table.normalizedName),
  uniqueIndex("conversation_folders_owner_position_uq").on(table.ownerId, table.position),
  unique("conversation_folders_id_owner_uq").on(table.id, table.ownerId),
  check("conversation_folders_name_check", sql`char_length(${table.name}) BETWEEN 1 AND 120`),
  check("conversation_folders_position_check", sql`${table.position} >= 0`),
  check("conversation_folders_version_check", sql`${table.version} >= 1`),
  check("conversation_folders_membership_version_check", sql`${table.membershipVersion} >= 0`),
  check(
    "conversation_folders_normalized_check",
    sql`${table.normalizedName} = translate(${table.name},'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`,
  ),
]);

export const conversationFolderMemberships = pgTable("conversation_folder_memberships", {
  folderId: uuid("folder_id").notNull(),
  conversationId: uuid("conversation_id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("conversation_folder_memberships_position_uq").on(table.folderId, table.position),
  index("conversation_folder_memberships_owner_idx").on(table.ownerId, table.folderId),
  check("conversation_folder_memberships_position_check", sql`${table.position} >= 0`),
  foreignKey({
    columns: [table.folderId, table.ownerId],
    foreignColumns: [conversationFolders.id, conversationFolders.ownerId],
    name: "conversation_folder_memberships_folder_owner_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.conversationId, table.ownerId],
    foreignColumns: [conversations.id, conversations.ownerId],
    name: "conversation_folder_memberships_conversation_owner_fk",
  }).onDelete("cascade"),
]);

export const conversationTags = pgTable("conversation_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  color: text("color").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("conversation_tags_owner_name_uq").on(table.ownerId, table.normalizedName),
  unique("conversation_tags_id_owner_uq").on(table.id, table.ownerId),
  index("conversation_tags_owner_name_idx").on(table.ownerId, table.normalizedName),
  check("conversation_tags_name_check", sql`char_length(${table.name}) BETWEEN 1 AND 64`),
  check("conversation_tags_color_check", sql`${table.color} ~ '^#[0-9A-Fa-f]{6}$'`),
  check("conversation_tags_version_check", sql`${table.version} >= 1`),
  check(
    "conversation_tags_normalized_check",
    sql`${table.normalizedName} = translate(${table.name},'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`,
  ),
]);

export const conversationTagSets = pgTable("conversation_tag_sets", {
  conversationId: uuid("conversation_id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("conversation_tag_sets_version_check", sql`${table.version} >= 0`),
  unique("conversation_tag_sets_conversation_owner_uq").on(table.conversationId, table.ownerId),
  foreignKey({
    columns: [table.conversationId, table.ownerId],
    foreignColumns: [conversations.id, conversations.ownerId],
    name: "conversation_tag_sets_conversation_owner_fk",
  }).onDelete("cascade"),
]);

export const conversationTagBindings = pgTable("conversation_tag_bindings", {
  conversationId: uuid("conversation_id").notNull(),
  tagId: uuid("tag_id").notNull(),
  ownerId: uuid("owner_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.tagId] }),
  index("conversation_tag_bindings_owner_idx").on(table.ownerId, table.conversationId),
  foreignKey({
    columns: [table.conversationId, table.ownerId],
    foreignColumns: [conversationTagSets.conversationId, conversationTagSets.ownerId],
    name: "conversation_tag_bindings_conversation_owner_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.tagId, table.ownerId],
    foreignColumns: [conversationTags.id, conversationTags.ownerId],
    name: "conversation_tag_bindings_tag_owner_fk",
  }).onDelete("cascade"),
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
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
  index("messages_search_content_trgm_idx").using(
    "gin",
    sql`lower(CASE WHEN ${table.role}='user' AND jsonb_typeof(${table.metadata}->'authoredContent')='string' THEN ${table.metadata}->>'authoredContent' ELSE ${table.content} END) gin_trgm_ops`,
  ).where(sql`${table.role} IN ('user','assistant') AND ${table.status} <> 'tombstoned'`),
]);

export const conversationShareSnapshots = pgTable("conversation_share_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, {
    onDelete: "cascade",
  }),
  leafId: uuid("leaf_id").notNull(),
  conversationVersion: integer("conversation_version").notNull(),
  title: text("title").notNull(),
  identityVisibility: text("identity_visibility").notNull(),
  attachmentPolicy: text("attachment_policy").notNull(),
  ownerNameSnapshot: text("owner_name_snapshot"),
  publicSnapshot: jsonb("public_snapshot").notNull(),
  sourceAttachments: jsonb("source_attachments").notNull().default({}),
  secretHash: text("secret_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  version: integer("version").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("conversation_share_snapshots_secret_uq").on(table.secretHash),
  uniqueIndex("conversation_share_snapshots_owner_idempotency_uq").on(
    table.ownerId,
    table.idempotencyKey,
  ),
  foreignKey({
    columns: [table.conversationId, table.ownerId],
    foreignColumns: [conversations.id, conversations.ownerId],
    name: "conversation_share_snapshots_conversation_owner_fk",
  }).onDelete("cascade"),
  index("conversation_share_snapshots_owner_created_idx").on(
    table.ownerId,
    table.createdAt,
    table.id,
  ),
  index("conversation_share_snapshots_public_expiry_idx").on(table.expiresAt, table.id).where(
    sql`${table.revokedAt} IS NULL`,
  ),
  check("conversation_share_snapshots_version_check", sql`${table.version} >= 1`),
  check(
    "conversation_share_snapshots_conversation_version_check",
    sql`${table.conversationVersion} >= 0`,
  ),
  check(
    "conversation_share_snapshots_title_check",
    sql`char_length(${table.title}) BETWEEN 1 AND 500`,
  ),
  check(
    "conversation_share_snapshots_identity_check",
    sql`${table.identityVisibility} IN ('owner','anonymous')`,
  ),
  check(
    "conversation_share_snapshots_attachment_policy_check",
    sql`${table.attachmentPolicy} IN ('include','redact','selected')`,
  ),
  check(
    "conversation_share_snapshots_owner_name_check",
    sql`(${table.identityVisibility}='owner' AND ${table.ownerNameSnapshot} IS NOT NULL AND char_length(${table.ownerNameSnapshot}) BETWEEN 1 AND 200) OR (${table.identityVisibility}='anonymous' AND ${table.ownerNameSnapshot} IS NULL)`,
  ),
  check(
    "conversation_share_snapshots_secret_hash_check",
    sql`${table.secretHash} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "conversation_share_snapshots_payload_hash_check",
    sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "conversation_share_snapshots_idempotency_check",
    sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
  ),
  check(
    "conversation_share_snapshots_public_snapshot_check",
    sql`jsonb_typeof(${table.publicSnapshot})='object' AND ${table.publicSnapshot}->>'id'=${table.id}::text AND ${table.publicSnapshot}->>'title'=${table.title} AND ${table.publicSnapshot}->>'conversationVersion'=${table.conversationVersion}::text AND ${table.publicSnapshot}#>>'{identity,visibility}'=${table.identityVisibility} AND (${table.publicSnapshot}#>>'{identity,displayName}') IS NOT DISTINCT FROM ${table.ownerNameSnapshot} AND ${table.publicSnapshot}->>'attachmentPolicy'=${table.attachmentPolicy} AND jsonb_typeof(${table.publicSnapshot}->'messages')='array' AND jsonb_typeof(${table.publicSnapshot}->'attachments')='array'`,
  ),
  check(
    "conversation_share_snapshots_source_attachments_check",
    sql`jsonb_typeof(${table.sourceAttachments})='object'`,
  ),
  check(
    "conversation_share_snapshots_expiry_check",
    sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
  ),
]);

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  width: integer("width"),
  height: integer("height"),
  state: text("state").notNull().default("pending"),
  inspectionError: text("inspection_error"),
  ingestionStatus: text("ingestion_status").notNull().default("not_applicable"),
  ingestionError: text("ingestion_error"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("attachments_object_key_idx").on(table.objectKey),
  index("attachments_owner_active_hash_idx").on(table.ownerId, table.sha256).where(
    sql`${table.deletedAt} IS NULL`,
  ),
  check(
    "attachments_dimensions_check",
    sql`(${table.width} IS NULL AND ${table.height} IS NULL) OR (${table.width} BETWEEN 1 AND 100000 AND ${table.height} BETWEEN 1 AND 100000)`,
  ),
]);

export const messageAttachments = pgTable("message_attachments", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.messageId, table.attachmentId] }),
  unique("message_attachments_message_position_uq").on(table.messageId, table.position),
  check("message_attachments_position_check", sql`${table.position} >= 0`),
]);

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
    authorityEpoch: bigint("authority_epoch", { mode: "number" }).notNull().default(1),
    version: integer("version").notNull().default(1),
    rpmLimit: integer("rpm_limit"),
    burstLimit: integer("burst_limit"),
    accessMode: text("access_mode").notNull().default("inherit"),
    rotationFamilyId: uuid("rotation_family_id").notNull(),
    rotationGeneration: integer("rotation_generation").notNull().default(0),
    rotatedFromTokenId: uuid("rotated_from_token_id"),
    replacedByTokenId: uuid("replaced_by_token_id"),
    overlapEndsAt: timestamp("overlap_ends_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (
    table,
  ) => [
    uniqueIndex("api_tokens_hash_uq").on(table.tokenHash),
    check(
      "api_tokens_authority_epoch_check",
      sql`${table.authorityEpoch} BETWEEN 1 AND 9007199254740991`,
    ),
    index("api_tokens_user_idx").on(table.userId),
    index("api_tokens_user_page_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
    uniqueIndex("api_tokens_family_generation_uq").on(
      table.rotationFamilyId,
      table.rotationGeneration,
    ),
    uniqueIndex("api_tokens_family_id_uq").on(table.rotationFamilyId, table.id),
    uniqueIndex("api_tokens_user_id_uq").on(table.userId, table.id),
    foreignKey({
      columns: [table.rotationFamilyId, table.rotatedFromTokenId],
      foreignColumns: [table.rotationFamilyId, table.id],
      name: "api_tokens_rotated_from_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.rotationFamilyId, table.replacedByTokenId],
      foreignColumns: [table.rotationFamilyId, table.id],
      name: "api_tokens_replaced_by_fk",
    }).onDelete("restrict"),
    check("api_tokens_version_check", sql`${table.version} >= 1`),
    check("api_tokens_generation_check", sql`${table.rotationGeneration} >= 0`),
    check(
      "api_tokens_rpm_check",
      sql`${table.rpmLimit} IS NULL OR ${table.rpmLimit} BETWEEN 1 AND 60000`,
    ),
    check(
      "api_tokens_burst_check",
      sql`${table.burstLimit} IS NULL OR ${table.burstLimit} BETWEEN 1 AND 1000`,
    ),
    check(
      "api_tokens_rate_relation_check",
      sql`${table.rpmLimit} IS NULL OR ${table.burstLimit} IS NULL OR ${table.burstLimit} <= ${table.rpmLimit}`,
    ),
    check("api_tokens_access_mode_check", sql`${table.accessMode} IN ('inherit','restricted')`),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    usageRunId: text("usage_run_id").notNull(),
    kind: ledgerKind("kind").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
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
    index("ledger_user_page_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
    uniqueIndex("ledger_user_sequence_uq").on(table.userId, table.sequence),
    index("ledger_user_sequence_page_idx").on(
      table.userId,
      table.sequence.desc(),
      table.id.desc(),
    ),
    check(
      "ledger_sequence_safe_check",
      sql`${table.sequence} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "ledger_amount_safe_check",
      sql`${table.amountMicros} BETWEEN -9007199254740991 AND 9007199254740991`,
    ),
    check(
      "ledger_balance_safe_check",
      sql`${table.balanceAfterMicros} BETWEEN 0 AND 9007199254740991`,
    ),
  ],
);

export const usageRuns = pgTable("usage_runs", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenId: uuid("token_id").references(() => apiTokens.id),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  recoveryOwner: text("recovery_owner").notNull(),
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
    "usage_runs_recovery_owner_check",
    sql`${table.recoveryOwner} IN ('provider','api_replay','document_embedding','tool')`,
  ),
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

// Operational and intentionally non-portable: every process boot owns one immutable identity.
// Migration 0046 adds the restore-maintenance trigger, which Drizzle does not model.
export const workerInstances = pgTable("worker_instances", {
  instanceId: uuid("instance_id").primaryKey(),
  workerName: varchar("worker_name", { length: 128 }).notNull(),
  state: varchar("state", { length: 16 }).$type<"starting" | "running" | "draining" | "stopped">()
    .notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  progressAt: timestamp("progress_at", { withTimezone: true }).notNull().defaultNow(),
  heartbeatStaleMs: integer("heartbeat_stale_ms").notNull().default(20_000),
  progressStaleMs: integer("progress_stale_ms").notNull().default(180_000),
  healthClockToleranceMs: integer("health_clock_tolerance_ms").notNull().default(5_000),
  currentJobId: uuid("current_job_id"),
  currentJobType: varchar("current_job_type", { length: 100 }),
  lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
  lastCompletedJobId: uuid("last_completed_job_id"),
  lastCompletedJobType: varchar("last_completed_job_type", { length: 100 }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("worker_instances_freshness_idx").on(
    table.state,
    table.heartbeatAt.desc(),
    table.progressAt.desc(),
  ),
  index("worker_instances_name_started_idx").on(table.workerName, table.startedAt.desc()),
  check(
    "worker_instances_state_check",
    sql`${table.state} IN ('starting','running','draining','stopped')`,
  ),
  check(
    "worker_instances_current_job_check",
    sql`(${table.currentJobId} IS NULL) = (${table.currentJobType} IS NULL)`,
  ),
  check(
    "worker_instances_last_completed_job_check",
    sql`(${table.lastCompletedJobId} IS NULL) = (${table.lastCompletedJobType} IS NULL)`,
  ),
  check(
    "worker_instances_last_completed_tuple_check",
    sql`(${table.lastCompletedAt} IS NULL) = (${table.lastCompletedJobId} IS NULL)`,
  ),
  check(
    "worker_instances_stopped_at_check",
    sql`(${table.state} = 'stopped') = (${table.stoppedAt} IS NOT NULL)`,
  ),
  check(
    "worker_instances_heartbeat_stale_check",
    sql`${table.heartbeatStaleMs} BETWEEN 1000 AND 300000`,
  ),
  check(
    "worker_instances_progress_stale_check",
    sql`${table.progressStaleMs} BETWEEN 1000 AND 3600000`,
  ),
  check(
    "worker_instances_clock_tolerance_check",
    sql`${table.healthClockToleranceMs} BETWEEN 0 AND 60000`,
  ),
]);

export const documentEmbeddingBatches = pgTable("document_embedding_batches", {
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  batchOrdinal: integer("batch_ordinal").notNull(),
  dispatchEpoch: integer("dispatch_epoch").notNull().default(0),
  usageRunId: text("usage_run_id").notNull().unique(),
  requestSha256: text("request_sha256").notNull(),
  itemCount: integer("item_count").notNull(),
  batchSize: integer("batch_size").notNull(),
  maximumInputTokens: integer("maximum_input_tokens").notNull(),
  phase: text("phase").$type<"pre_dispatch" | "dispatched" | "succeeded" | "committed">()
    .notNull().default("pre_dispatch"),
  retrySafe: boolean("retry_safe").notNull().default(false),
  dispatchClaimToken: text("dispatch_claim_token"),
  providerResponse: jsonb("provider_response"),
  providerResponseSha256: text("provider_response_sha256"),
  inputTokens: integer("input_tokens"),
  latencyMs: integer("latency_ms"),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.batchOrdinal] }),
  index("document_embedding_batches_active_usage_idx").on(table.usageRunId, table.phase)
    .where(sql`${table.phase} IN ('pre_dispatch','dispatched','succeeded')`),
  check(
    "document_embedding_batches_identity_check",
    sql`${table.batchOrdinal} >= 0 AND ${table.dispatchEpoch} >= 0 AND ${table.requestSha256} ~ '^[0-9a-f]{64}$' AND ${table.itemCount} BETWEEN 1 AND 256 AND ${table.batchSize} BETWEEN 1 AND 256 AND ${table.batchOrdinal} % ${table.batchSize} = 0 AND ${table.itemCount} <= ${table.batchSize} AND ${table.maximumInputTokens} >= 0 AND (${table.providerResponseSha256} IS NULL OR ${table.providerResponseSha256} ~ '^[0-9a-f]{64}$') AND (${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0) AND (${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0)`,
  ),
  check(
    "document_embedding_batches_phase_check",
    sql`${table.phase} IN ('pre_dispatch','dispatched','succeeded','committed')`,
  ),
  check(
    "document_embedding_batches_state_check",
    sql`(
      (${table.phase}='pre_dispatch' AND ${table.retrySafe}=false AND ${table.dispatchClaimToken} IS NULL AND ${table.dispatchedAt} IS NULL AND ${table.providerResponse} IS NULL AND ${table.providerResponseSha256} IS NULL AND ${table.inputTokens} IS NULL AND ${table.latencyMs} IS NULL AND ${table.respondedAt} IS NULL AND ${table.committedAt} IS NULL)
      OR (${table.phase}='dispatched' AND ${table.dispatchClaimToken} IS NOT NULL AND ${table.dispatchedAt} IS NOT NULL AND ${table.providerResponse} IS NULL AND ${table.providerResponseSha256} IS NULL AND ${table.inputTokens} IS NULL AND ${table.latencyMs} IS NULL AND ${table.respondedAt} IS NULL AND ${table.committedAt} IS NULL)
      OR (${table.phase}='succeeded' AND ${table.retrySafe}=false AND ${table.dispatchClaimToken} IS NOT NULL AND ${table.dispatchedAt} IS NOT NULL AND ${table.providerResponse} IS NOT NULL AND ${table.providerResponseSha256} IS NOT NULL AND ${table.inputTokens} IS NOT NULL AND ${table.latencyMs} IS NOT NULL AND ${table.respondedAt} IS NOT NULL AND ${table.committedAt} IS NULL)
      OR (${table.phase}='committed' AND ${table.retrySafe}=false AND ${table.dispatchClaimToken} IS NOT NULL AND ${table.dispatchedAt} IS NOT NULL AND ${table.providerResponse} IS NULL AND ${table.providerResponseSha256} IS NOT NULL AND ${table.inputTokens} IS NOT NULL AND ${table.latencyMs} IS NOT NULL AND ${table.respondedAt} IS NOT NULL AND ${table.committedAt} IS NOT NULL)
    )`,
  ),
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

/** Durable replay boundary for privileged balance mutations. Plaintext idempotency keys are never stored. */
export const adminBalanceAdjustments = pgTable("admin_balance_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id, {
    onDelete: "restrict",
  }),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
  balanceBeforeMicros: bigint("balance_before_micros", { mode: "number" }).notNull(),
  balanceAfterMicros: bigint("balance_after_micros", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  ledgerEntryId: uuid("ledger_entry_id").notNull().references(() => ledgerEntries.id, {
    onDelete: "restrict",
  }),
  auditEventId: uuid("audit_event_id").notNull().references(() => auditEvents.id, {
    onDelete: "restrict",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("admin_balance_adjustments_actor_key_uq").on(
    table.actorId,
    table.idempotencyKeyHash,
  ),
  uniqueIndex("admin_balance_adjustments_ledger_entry_uq").on(table.ledgerEntryId),
  uniqueIndex("admin_balance_adjustments_audit_event_uq").on(table.auditEventId),
  index("admin_balance_adjustments_target_page_idx").on(
    table.targetUserId,
    table.createdAt.desc(),
    table.id.desc(),
  ),
  index("admin_balance_adjustments_actor_page_idx").on(
    table.actorId,
    table.createdAt.desc(),
    table.id.desc(),
  ),
  check(
    "admin_balance_adjustments_key_hash_check",
    sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "admin_balance_adjustments_request_hash_check",
    sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "admin_balance_adjustments_amount_check",
    sql`${table.amountMicros} BETWEEN -9007199254740991 AND 9007199254740991 AND ${table.amountMicros} <> 0`,
  ),
  check(
    "admin_balance_adjustments_balance_check",
    sql`${table.balanceBeforeMicros} BETWEEN 0 AND 9007199254740991 AND ${table.balanceAfterMicros} BETWEEN 0 AND 9007199254740991 AND ${table.balanceAfterMicros} = ${table.balanceBeforeMicros} + ${table.amountMicros}`,
  ),
  check(
    "admin_balance_adjustments_reason_check",
    sql`${table.reason} = btrim(${table.reason}) AND char_length(${table.reason}) BETWEEN 1 AND 500`,
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
  replayReservedBytes: integer("replay_reserved_bytes").notNull().default(0),
  replayReservedEvents: integer("replay_reserved_events").notNull().default(0),
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
  check(
    "api_idempotency_requests_replay_reservation_check",
    sql`${table.replayReservedBytes} >= 0 AND ${table.replayReservedEvents} >= 0`,
  ),
]);

export const apiIdempotencyEvents = pgTable("api_idempotency_events", {
  requestId: uuid("request_id").notNull().references(() => apiIdempotencyRequests.id, {
    onDelete: "cascade",
  }),
  sequence: integer("sequence").notNull(),
  frame: text("frame").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.requestId, table.sequence] })]);

export const fileUploadStaging = pgTable("file_upload_staging", {
  requestId: uuid("request_id").primaryKey().references(() => apiIdempotencyRequests.id, {
    onDelete: "cascade",
  }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  purpose: text("purpose").notNull(),
  attachmentState: text("attachment_state").notNull(),
  inspectionError: text("inspection_error"),
  state: text("state").notNull().default("pending"),
  attachmentId: uuid("attachment_id").references(() => attachments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("file_upload_staging_state_idx").on(table.state, table.updatedAt),
  check("file_upload_staging_state_check", sql`${table.state} IN ('pending','stored','finalized')`),
  check("file_upload_staging_size_check", sql`${table.sizeBytes} >= 0`),
  check("file_upload_staging_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check("file_upload_staging_purpose_check", sql`${table.purpose} = 'assistants'`),
  check(
    "file_upload_staging_attachment_state_check",
    sql`${table.attachmentState} IN ('ready','quarantined')`,
  ),
]);

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
    "providers_base_url_check",
    sql`char_length(${table.baseUrl}) BETWEEN 1 AND 2048 AND ${table.baseUrl} ~ '^https?://[^/?#@]+(?:/[^?#@]*)?$'`,
  ),
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

export const modelAliases = pgTable("model_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  alias: text("alias").notNull(),
  targetModelId: uuid("target_model_id").notNull().references(() => providerModels.id, {
    onDelete: "restrict",
  }),
  description: text("description").notNull().default(""),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("model_aliases_alias_uq").on(table.alias),
  check("model_aliases_alias_check", sql`${table.alias} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$'`),
  check("model_aliases_version_check", sql`${table.version} >= 1`),
]);

export const accessGroups = pgTable("access_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("access_groups_name_uq").on(sql`lower(${table.name})`),
  check("access_groups_version_check", sql`${table.version} >= 1`),
]);
export const accessGroupUsers = pgTable("access_group_users", {
  groupId: uuid("group_id").notNull().references(() => accessGroups.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.groupId, table.userId] })]);
export const accessGroupModels = pgTable("access_group_models", {
  groupId: uuid("group_id").notNull().references(() => accessGroups.id, { onDelete: "cascade" }),
  providerModelId: uuid("provider_model_id").notNull().references(() => providerModels.id, {
    onDelete: "cascade",
  }),
}, (table) => [
  primaryKey({ columns: [table.groupId, table.providerModelId] }),
  index("access_group_models_model_idx").on(table.providerModelId, table.groupId),
]);
export const accessGroupTokens = pgTable("access_group_tokens", {
  groupId: uuid("group_id").notNull(),
  tokenId: uuid("token_id").notNull(),
  userId: uuid("user_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.groupId, table.tokenId] }),
  foreignKey({
    columns: [table.groupId, table.userId],
    foreignColumns: [accessGroupUsers.groupId, accessGroupUsers.userId],
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.userId, table.tokenId],
    foreignColumns: [apiTokens.userId, apiTokens.id],
  }).onDelete("cascade"),
  index("access_group_tokens_token_idx").on(table.tokenId, table.groupId),
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
  unique("provider_attempts_run_id_id_uq").on(table.usageRunId, table.id),
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

export const retentionPolicyVersions = pgTable("retention_policy_versions", {
  version: integer("version").primaryKey(),
  captureEnabled: boolean("capture_enabled").notNull(),
  requestBodyDays: integer("request_body_days").notNull(),
  responseBodyDays: integer("response_body_days").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
}, (table) => [
  check("retention_policy_version_check", sql`${table.version} >= 1`),
  check("retention_policy_request_days_check", sql`${table.requestBodyDays} IN (1,7,14,30,90)`),
  check("retention_policy_response_days_check", sql`${table.responseBodyDays} IN (1,7,14,30,90)`),
]);

export const retentionPolicyState = pgTable("retention_policy_state", {
  singletonId: integer("singleton_id").primaryKey().default(1),
  currentVersion: integer("current_version").notNull().references(
    () => retentionPolicyVersions.version,
    {
      onDelete: "restrict",
    },
  ),
}, (table) => [check("retention_policy_singleton_check", sql`${table.singletonId} = 1`)]);

export const providerPayloadCaptures = pgTable("provider_payload_captures", {
  id: uuid("id").primaryKey().defaultRandom(),
  usageRunId: text("usage_run_id").notNull().references(() => usageRuns.id, {
    onDelete: "restrict",
  }),
  providerAttemptId: uuid("provider_attempt_id").notNull(),
  requestBody: text("request_body"),
  responseBody: text("response_body"),
  requestBytes: integer("request_bytes").notNull().default(0),
  responseBytes: integer("response_bytes").notNull().default(0),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  scrubbedAt: timestamp("scrubbed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("provider_payload_captures_attempt_uq").on(table.providerAttemptId),
  foreignKey({
    columns: [table.usageRunId, table.providerAttemptId],
    foreignColumns: [providerAttempts.usageRunId, providerAttempts.id],
    name: "provider_payload_captures_attempt_run_fk",
  }).onDelete("restrict"),
  index("provider_payload_captures_request_scrub_idx").on(table.capturedAt, table.id).where(
    sql`${table.requestBody} IS NOT NULL`,
  ),
  index("provider_payload_captures_response_scrub_idx").on(table.capturedAt, table.id).where(
    sql`${table.responseBody} IS NOT NULL`,
  ),
  check(
    "provider_payload_captures_body_check",
    sql`${table.requestBody} IS NOT NULL OR ${table.responseBody} IS NOT NULL OR ${table.scrubbedAt} IS NOT NULL`,
  ),
  check(
    "provider_payload_captures_request_bytes_check",
    sql`${table.requestBytes} BETWEEN 0 AND 1048576`,
  ),
  check(
    "provider_payload_captures_response_bytes_check",
    sql`${table.responseBytes} BETWEEN 0 AND 1048576`,
  ),
  check(
    "provider_payload_captures_request_size_check",
    sql`${table.requestBody} IS NULL OR octet_length(${table.requestBody})=${table.requestBytes}`,
  ),
  check(
    "provider_payload_captures_response_size_check",
    sql`${table.responseBody} IS NULL OR octet_length(${table.responseBody})=${table.responseBytes}`,
  ),
]);

export const retentionScrubRuns = pgTable("retention_scrub_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("queued"),
  policyVersion: integer("policy_version").notNull().references(
    () => retentionPolicyVersions.version,
    {
      onDelete: "restrict",
    },
  ),
  captureEnabled: boolean("capture_enabled").notNull(),
  requestBodyDays: integer("request_body_days").notNull(),
  responseBodyDays: integer("response_body_days").notNull(),
  requestCutoffAt: timestamp("request_cutoff_at", { withTimezone: true }).notNull(),
  responseCutoffAt: timestamp("response_cutoff_at", { withTimezone: true }).notNull(),
  requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "restrict" }),
  capturesScrubbed: integer("captures_scrubbed").notNull().default(0),
  requestBodiesScrubbed: integer("request_bodies_scrubbed").notNull().default(0),
  responseBodiesScrubbed: integer("response_bodies_scrubbed").notNull().default(0),
  bytesScrubbed: bigint("bytes_scrubbed", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
}, (table) => [
  uniqueIndex("retention_scrub_runs_idempotency_uq").on(table.idempotencyKey),
  index("retention_scrub_runs_status_created_idx").on(table.status, table.createdAt, table.id),
  check(
    "retention_scrub_runs_status_check",
    sql`${table.status} IN ('queued','running','completed','failed')`,
  ),
  check(
    "retention_scrub_runs_days_check",
    sql`${table.requestBodyDays} IN (1,7,14,30,90) AND ${table.responseBodyDays} IN (1,7,14,30,90)`,
  ),
  check(
    "retention_scrub_runs_counters_check",
    sql`${table.capturesScrubbed} >= 0 AND ${table.requestBodiesScrubbed} >= 0 AND ${table.responseBodiesScrubbed} >= 0 AND ${table.bytesScrubbed} >= 0`,
  ),
  check(
    "retention_scrub_runs_key_check",
    sql`char_length(${table.idempotencyKey}) BETWEEN 8 AND 200`,
  ),
  check(
    "retention_scrub_runs_cutoff_check",
    sql`${table.requestCutoffAt} <= ${table.createdAt} AND ${table.responseCutoffAt} <= ${table.createdAt}`,
  ),
  check(
    "retention_scrub_runs_terminal_check",
    sql`(${table.status} IN ('queued','running') AND ${table.completedAt} IS NULL AND ${table.error} IS NULL) OR (${table.status}='completed' AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NULL) OR (${table.status}='failed' AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NOT NULL)`,
  ),
  check(
    "retention_scrub_runs_error_check",
    sql`${table.error} IS NULL OR char_length(${table.error}) <= 1000`,
  ),
]);

export const retentionScheduleState = pgTable("retention_schedule_state", {
  singletonId: integer("singleton_id").primaryKey().default(1),
  intervalSeconds: integer("interval_seconds").notNull().default(86_400),
  nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull().defaultNow(),
  lastPolicyVersion: integer("last_policy_version").references(
    () => retentionPolicyVersions.version,
    { onDelete: "restrict" },
  ),
  lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }),
  lastRunId: uuid("last_run_id").references(() => retentionScrubRuns.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("retention_schedule_singleton_check", sql`${table.singletonId} = 1`),
  check(
    "retention_schedule_interval_check",
    sql`${table.intervalSeconds} BETWEEN 300 AND 2592000`,
  ),
  check(
    "retention_schedule_last_run_check",
    sql`(${table.lastRunId} IS NULL AND ${table.lastScheduledAt} IS NULL) OR (${table.lastRunId} IS NOT NULL AND ${table.lastScheduledAt} IS NOT NULL)`,
  ),
]);

export const backupOperations = pgTable("backup_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("queued"),
  version: integer("version").notNull().default(1),
  // Control-plane evidence survives whole-installation replacement of the users table.
  actorId: uuid("actor_id"),
  actorEmail: text("actor_email").notNull(),
  actorName: text("actor_name").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  stage: text("stage").notNull().default("queued"),
  sourceObjectKey: text("source_object_key"),
  artifactObjectKey: text("artifact_object_key"),
  archiveSha256: text("archive_sha256"),
  options: jsonb("options").notNull().default({}),
  manifest: jsonb("manifest"),
  impact: jsonb("impact"),
  confirmationFingerprint: text("confirmation_fingerprint"),
  objectsProcessed: integer("objects_processed").notNull().default(0),
  objectsTotal: integer("objects_total").notNull().default(0),
  bytesProcessed: bigint("bytes_processed", { mode: "number" }).notNull().default(0),
  bytesTotal: bigint("bytes_total", { mode: "number" }).notNull().default(0),
  error: text("error"),
  exportLeaseToken: uuid("export_lease_token"),
  exportLeaseExpiresAt: timestamp("export_lease_expires_at", { withTimezone: true }),
  // A terminal export's artifact binding is a durable cleanup tombstone. Never erase it: an
  // abort-ignoring object-store PUT may publish after a recovery worker observed the key absent.
  artifactCleanupCheckedAt: timestamp("artifact_cleanup_checked_at", { withTimezone: true }),
  artifactCleanupLeaseToken: uuid("artifact_cleanup_lease_token"),
  artifactCleanupLeaseExpiresAt: timestamp("artifact_cleanup_lease_expires_at", {
    withTimezone: true,
  }),
  providerSecretsRequested: boolean("provider_secrets_requested").notNull().default(false),
  secretArtifactObjectKey: text("secret_artifact_object_key"),
  secretArchiveSha256: text("secret_archive_sha256"),
  secretArchiveBytes: bigint("secret_archive_bytes", { mode: "number" }),
  secretProviderCount: integer("secret_provider_count"),
  secretRecoveryKeyId: text("secret_recovery_key_id"),
  secretArtifactCleanupCheckedAt: timestamp("secret_artifact_cleanup_checked_at", {
    withTimezone: true,
  }),
  secretArtifactCleanupLeaseToken: uuid("secret_artifact_cleanup_lease_token"),
  secretArtifactCleanupLeaseExpiresAt: timestamp("secret_artifact_cleanup_lease_expires_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("backup_operations_idempotency_uq").on(
    table.actorId,
    table.kind,
    table.idempotencyKey,
  ),
  index("backup_operations_status_created_idx").on(table.status, table.createdAt, table.id),
  index("backup_operations_kind_created_idx").on(
    table.kind,
    table.createdAt.desc(),
    table.id.desc(),
  ),
  index("backup_operations_secret_cleanup_idx").on(
    table.secretArtifactCleanupCheckedAt,
    table.createdAt,
    table.id,
  ).where(
    sql`${table.kind}='export' AND ${table.status} IN ('failed','cancelled') AND ${table.secretArtifactObjectKey} IS NOT NULL AND ${table.secretArchiveSha256} IS NOT NULL`,
  ),
  check("backup_operations_kind_check", sql`${table.kind} IN ('export','restore')`),
  check(
    "backup_operations_status_check",
    sql`${table.status} IN ('queued','running','validated','completed','failed','cancelled')`,
  ),
  check("backup_operations_version_check", sql`${table.version} >= 1`),
  check(
    "backup_operations_idempotency_check",
    sql`char_length(${table.idempotencyKey}) BETWEEN 8 AND 200`,
  ),
  check("backup_operations_stage_check", sql`char_length(${table.stage}) BETWEEN 1 AND 80`),
  check(
    "backup_operations_actor_check",
    sql`char_length(${table.actorEmail}) BETWEEN 3 AND 320 AND char_length(${table.actorName}) BETWEEN 1 AND 200`,
  ),
  check(
    "backup_operations_object_key_check",
    sql`(${table.sourceObjectKey} IS NULL OR (char_length(${table.sourceObjectKey}) BETWEEN 1 AND 1024 AND left(${table.sourceObjectKey},1) <> '/')) AND (${table.artifactObjectKey} IS NULL OR (char_length(${table.artifactObjectKey}) BETWEEN 1 AND 1024 AND left(${table.artifactObjectKey},1) <> '/'))`,
  ),
  check(
    "backup_operations_digest_check",
    sql`${table.archiveSha256} IS NULL OR ${table.archiveSha256} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "backup_operations_fingerprint_check",
    sql`${table.confirmationFingerprint} IS NULL OR ${table.confirmationFingerprint} ~ '^[A-F0-9]{8}$'`,
  ),
  check(
    "backup_operations_json_check",
    sql`jsonb_typeof(${table.options})='object' AND (${table.manifest} IS NULL OR jsonb_typeof(${table.manifest})='object') AND (${table.impact} IS NULL OR jsonb_typeof(${table.impact})='object')`,
  ),
  check(
    "backup_operations_progress_check",
    sql`${table.objectsProcessed} >= 0 AND ${table.objectsTotal} >= 0 AND ${table.objectsProcessed} <= ${table.objectsTotal} AND ${table.bytesProcessed} >= 0 AND ${table.bytesTotal} >= 0 AND ${table.bytesProcessed} <= ${table.bytesTotal}`,
  ),
  check(
    "backup_operations_error_check",
    sql`${table.error} IS NULL OR char_length(${table.error}) BETWEEN 1 AND 1000`,
  ),
  check(
    "backup_operations_export_lease_check",
    sql`(${table.kind}='export' AND ${table.status}='running' AND ${table.exportLeaseToken} IS NOT NULL AND ${table.exportLeaseExpiresAt} IS NOT NULL) OR (${table.exportLeaseToken} IS NULL AND ${table.exportLeaseExpiresAt} IS NULL)`,
  ),
  check(
    "backup_operations_artifact_cleanup_lease_check",
    sql`(${table.artifactCleanupLeaseToken} IS NULL AND ${table.artifactCleanupLeaseExpiresAt} IS NULL) OR (${table.kind}='export' AND ${table.status} IN ('failed','cancelled') AND ${table.artifactObjectKey} IS NOT NULL AND ${table.archiveSha256} IS NOT NULL AND ${table.artifactCleanupLeaseToken} IS NOT NULL AND ${table.artifactCleanupLeaseExpiresAt} IS NOT NULL)`,
  ),
  check(
    "backup_operations_provider_secrets_kind_check",
    sql`NOT ${table.providerSecretsRequested} OR ${table.kind}='export'`,
  ),
  check(
    "backup_operations_secret_object_key_check",
    sql`${table.secretArtifactObjectKey} IS NULL OR (char_length(${table.secretArtifactObjectKey}) BETWEEN 1 AND 1024 AND left(${table.secretArtifactObjectKey},1) <> '/')`,
  ),
  check(
    "backup_operations_secret_digest_check",
    sql`${table.secretArchiveSha256} IS NULL OR ${table.secretArchiveSha256} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "backup_operations_secret_metadata_check",
    sql`(${table.secretArtifactObjectKey} IS NULL AND ${table.secretArchiveSha256} IS NULL AND ${table.secretArchiveBytes} IS NULL AND ${table.secretProviderCount} IS NULL AND ${table.secretRecoveryKeyId} IS NULL) OR (${table.providerSecretsRequested} AND ${table.kind}='export' AND ${table.secretArtifactObjectKey} IS NOT NULL AND ${table.secretArchiveSha256} IS NOT NULL AND ${table.secretArchiveBytes} > 0 AND ${table.secretProviderCount} >= 0 AND char_length(${table.secretRecoveryKeyId}) BETWEEN 1 AND 128)`,
  ),
  check(
    "backup_operations_secret_completion_check",
    sql`${table.status} <> 'completed' OR NOT ${table.providerSecretsRequested} OR (${table.secretArtifactObjectKey} IS NOT NULL AND ${table.secretArchiveSha256} IS NOT NULL AND ${table.secretArchiveBytes} IS NOT NULL AND ${table.secretProviderCount} IS NOT NULL AND ${table.secretRecoveryKeyId} IS NOT NULL)`,
  ),
  check(
    "backup_operations_secret_cleanup_lease_check",
    sql`(${table.secretArtifactCleanupLeaseToken} IS NULL AND ${table.secretArtifactCleanupLeaseExpiresAt} IS NULL) OR (${table.kind}='export' AND ${table.status} IN ('failed','cancelled') AND ${table.secretArtifactObjectKey} IS NOT NULL AND ${table.secretArchiveSha256} IS NOT NULL AND ${table.secretArtifactCleanupLeaseToken} IS NOT NULL AND ${table.secretArtifactCleanupLeaseExpiresAt} IS NOT NULL)`,
  ),
  check(
    "backup_operations_time_check",
    sql`${table.updatedAt} >= ${table.createdAt} AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt}) AND (${table.validatedAt} IS NULL OR ${table.validatedAt} >= ${table.createdAt}) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
  ),
  check(
    "backup_operations_lifecycle_check",
    sql`(${table.status}='queued' AND ${table.startedAt} IS NULL AND ${table.completedAt} IS NULL AND ${table.error} IS NULL) OR (${table.status}='running' AND ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.error} IS NULL) OR (${table.status}='validated' AND ${table.kind}='restore' AND ${table.startedAt} IS NOT NULL AND ${table.validatedAt} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.error} IS NULL AND ${table.archiveSha256} IS NOT NULL AND ${table.impact} IS NOT NULL AND ${table.confirmationFingerprint} IS NOT NULL) OR (${table.status}='completed' AND ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NULL AND ${table.archiveSha256} IS NOT NULL) OR (${table.status}='failed' AND ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NOT NULL) OR (${table.status}='cancelled' AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NULL)`,
  ),
]);

export const backupRestoreSecretSidecars = pgTable("backup_restore_secret_sidecars", {
  id: uuid("id").primaryKey().defaultRandom(),
  restoreOperationId: uuid("restore_operation_id").notNull().references(() => backupOperations.id, {
    onDelete: "restrict",
  }),
  status: text("status").$type<
    "staging" | "uploaded" | "validated" | "applied" | "failed" | "cancelled"
  >().notNull().default("staging"),
  version: integer("version").notNull().default(1),
  idempotencyKey: text("idempotency_key").notNull(),
  // Control-plane actor evidence intentionally has no users FK so a later full restore cannot
  // cascade-truncate sidecar history while replacing portable user data.
  requestedBy: uuid("requested_by"),
  appliedBy: uuid("applied_by"),
  sourceObjectKey: text("source_object_key").notNull(),
  archiveSha256: text("archive_sha256").notNull(),
  archiveBytes: bigint("archive_bytes", { mode: "number" }).notNull(),
  sidecarId: uuid("sidecar_id").notNull(),
  recoveryKeyId: text("recovery_key_id").notNull(),
  baseBackupId: uuid("base_backup_id").notNull(),
  baseArchiveSha256: text("base_archive_sha256").notNull(),
  baseContentRootSha256: text("base_content_root_sha256").notNull(),
  sourceInstallationId: uuid("source_installation_id").notNull(),
  baseRestoreEpoch: bigint("base_restore_epoch", { mode: "number" }).notNull(),
  recordCount: integer("record_count"),
  recordsSha256: text("records_sha256"),
  providerStateSha256: text("provider_state_sha256"),
  providerPlan: jsonb("provider_plan"),
  impact: jsonb("impact"),
  error: text("error"),
  cleanupCheckedAt: timestamp("cleanup_checked_at", { withTimezone: true }),
  cleanupLeaseToken: uuid("cleanup_lease_token"),
  cleanupLeaseExpiresAt: timestamp("cleanup_lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("backup_restore_secret_sidecars_active_restore_uq").on(table.restoreOperationId)
    .where(sql`${table.status} IN ('staging','uploaded','validated','applied')`),
  uniqueIndex("backup_restore_secret_sidecars_idempotency_uq").on(
    table.restoreOperationId,
    table.idempotencyKey,
  ),
  index("backup_restore_secret_sidecars_cleanup_idx").on(
    table.cleanupCheckedAt,
    table.completedAt,
    table.id,
  ).where(sql`${table.status} IN ('applied','failed','cancelled')`),
  check(
    "backup_restore_secret_sidecars_status_check",
    sql`${table.status} IN ('staging','uploaded','validated','applied','failed','cancelled')`,
  ),
  check("backup_restore_secret_sidecars_version_check", sql`${table.version} >= 1`),
  check(
    "backup_restore_secret_sidecars_idempotency_check",
    sql`char_length(${table.idempotencyKey}) BETWEEN 8 AND 200`,
  ),
  check(
    "backup_restore_secret_sidecars_object_key_check",
    sql`char_length(${table.sourceObjectKey}) BETWEEN 1 AND 1024 AND left(${table.sourceObjectKey},1) <> '/' AND ${table.sourceObjectKey} !~ '(^|/)\.\.(/|$)' AND ${table.sourceObjectKey} !~ '//' AND ${table.sourceObjectKey} !~ '[[:cntrl:]]'`,
  ),
  check(
    "backup_restore_secret_sidecars_digest_check",
    sql`${table.archiveSha256} ~ '^[0-9a-f]{64}$' AND ${table.baseArchiveSha256} ~ '^[0-9a-f]{64}$' AND ${table.baseContentRootSha256} ~ '^[0-9a-f]{64}$' AND (${table.recordsSha256} IS NULL OR ${table.recordsSha256} ~ '^[0-9a-f]{64}$') AND (${table.providerStateSha256} IS NULL OR ${table.providerStateSha256} ~ '^[0-9a-f]{64}$')`,
  ),
  check("backup_restore_secret_sidecars_size_check", sql`${table.archiveBytes} > 0`),
  check(
    "backup_restore_secret_sidecars_restore_epoch_check",
    sql`${table.baseRestoreEpoch} > 0`,
  ),
  check(
    "backup_restore_secret_sidecars_key_check",
    sql`${table.recoveryKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
  ),
  check(
    "backup_restore_secret_sidecars_validation_check",
    sql`(${table.recordCount} IS NULL AND ${table.recordsSha256} IS NULL AND ${table.providerStateSha256} IS NULL AND ${table.providerPlan} IS NULL AND ${table.impact} IS NULL AND ${table.validatedAt} IS NULL) OR (${table.recordCount} >= 0 AND ${table.recordsSha256} IS NOT NULL AND ${table.providerStateSha256} IS NOT NULL AND jsonb_typeof(${table.providerPlan})='array' AND jsonb_array_length(${table.providerPlan})=${table.recordCount} AND jsonb_typeof(${table.impact})='object' AND ${table.validatedAt} IS NOT NULL)`,
  ),
  check(
    "backup_restore_secret_sidecars_error_check",
    sql`${table.error} IS NULL OR char_length(${table.error}) BETWEEN 1 AND 1000`,
  ),
  check(
    "backup_restore_secret_sidecars_cleanup_lease_check",
    sql`(${table.cleanupLeaseToken} IS NULL AND ${table.cleanupLeaseExpiresAt} IS NULL) OR (${table.status} IN ('applied','failed','cancelled') AND ${table.cleanupLeaseToken} IS NOT NULL AND ${table.cleanupLeaseExpiresAt} IS NOT NULL)`,
  ),
  check(
    "backup_restore_secret_sidecars_time_check",
    sql`${table.updatedAt} >= ${table.createdAt} AND (${table.validatedAt} IS NULL OR ${table.validatedAt} >= ${table.createdAt}) AND (${table.appliedAt} IS NULL OR ${table.appliedAt} >= ${table.createdAt}) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
  ),
  check(
    "backup_restore_secret_sidecars_lifecycle_check",
    sql`(${table.status} IN ('staging','uploaded') AND ${table.validatedAt} IS NULL AND ${table.appliedAt} IS NULL AND ${table.completedAt} IS NULL AND ${table.error} IS NULL) OR (${table.status}='validated' AND ${table.validatedAt} IS NOT NULL AND ${table.appliedAt} IS NULL AND ${table.completedAt} IS NULL AND ${table.error} IS NULL) OR (${table.status}='applied' AND ${table.validatedAt} IS NOT NULL AND ${table.appliedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NULL AND ${table.appliedBy} IS NOT NULL) OR (${table.status}='failed' AND ${table.appliedAt} IS NULL AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NOT NULL) OR (${table.status}='cancelled' AND ${table.appliedAt} IS NULL AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NULL)`,
  ),
]);

export const installationState = pgTable("installation_state", {
  singletonId: smallint("singleton_id").primaryKey().default(1),
  installationId: uuid("installation_id").notNull().defaultRandom(),
  maintenanceEnabled: boolean("maintenance_enabled").notNull().default(false),
  version: integer("version").notNull().default(1),
  restoreEpoch: bigint("restore_epoch", { mode: "number" }).notNull().default(0),
  restoreTransactionId: xid8("restore_transaction_id"),
  activeRestoreId: uuid("active_restore_id").references(() => backupOperations.id, {
    onDelete: "restrict",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("installation_state_installation_uq").on(table.installationId),
  check("installation_state_singleton_check", sql`${table.singletonId}=1`),
  check("installation_state_version_check", sql`${table.version} >= 1`),
  check("installation_state_restore_epoch_check", sql`${table.restoreEpoch} >= 0`),
  check(
    "installation_state_restore_transaction_check",
    sql`${table.restoreTransactionId} IS NULL OR ${table.maintenanceEnabled}=true`,
  ),
  check(
    "installation_state_maintenance_check",
    sql`${table.maintenanceEnabled} = (${table.activeRestoreId} IS NOT NULL)`,
  ),
]);
