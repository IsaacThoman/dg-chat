import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "npm:drizzle-orm@0.44.7/pg-core";

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
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("user"),
  approvalStatus: approvalStatus("approval_status").notNull().default("pending"),
  state: accountState("state").notNull().default("active"),
  balanceMicros: bigint("balance_micros", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [uniqueIndex("users_email_uq").on(table.email)]);

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("attachments_owner_hash_uq").on(table.ownerId, table.sha256)]);

export const messageAttachments = pgTable("message_attachments", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id),
}, (table) => [primaryKey({ columns: [table.messageId, table.attachmentId] })]);

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
    uniqueIndex("ledger_run_kind_uq").on(table.usageRunId, table.kind),
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
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  latencyMs: integer("latency_ms"),
  ttftMs: integer("ttft_ms"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [index("jobs_claim_idx").on(table.status, table.availableAt)]);

export const documentChunks = pgTable("document_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id, {
    onDelete: "cascade",
  }),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  metadata: jsonb("metadata").notNull().default({}),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").references(() => users.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
