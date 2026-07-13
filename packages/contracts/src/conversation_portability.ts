import { z } from "npm:zod@4.1.12";

/** Stable owner-scoped chat archive format. It intentionally contains no auth, billing, or provider data. */
export const DGCHAT_FORMAT = "dgchat.owner-export" as const;
export const DGCHAT_VERSION = 1 as const;

export const DGCHAT_LIMITS = {
  conversations: 2_000,
  messages: 100_000,
  messagesPerConversation: 20_000,
  attachments: 10_000,
  attachmentLinks: 100_000,
  folders: 500,
  tags: 2_000,
  tagsPerConversation: 20,
  contentChars: 2_000_000,
  customInstructionsChars: 20_000,
  metadataBytes: 64 * 1024,
} as const;

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();
const uniqueIds = <T extends z.ZodTypeAny>(schema: T, max: number) =>
  z.array(schema).max(max).refine(
    (items) => new Set(items.map((item) => (item as { id: string }).id)).size === items.length,
    "Identifiers must be unique",
  );

const boundedMetadataSchema = z.record(z.string().max(200), z.unknown()).superRefine(
  (value, context) => {
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    const seen = new Set<object>();
    let nodes = 0;
    let invalid = false;
    while (pending.length > 0 && !invalid) {
      const current = pending.pop()!;
      nodes++;
      if (nodes > 4_096 || current.depth > 12) {
        invalid = true;
      } else if (
        current.value === null || typeof current.value === "boolean" ||
        (typeof current.value === "number" && Number.isFinite(current.value))
      ) {
        continue;
      } else if (typeof current.value === "string") {
        invalid = current.value.length > 32_000;
      } else if (typeof current.value === "object") {
        if (seen.has(current.value)) {
          invalid = true;
          continue;
        }
        seen.add(current.value);
        if (Array.isArray(current.value)) {
          if (current.value.length > 256) invalid = true;
          for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
        } else {
          const entries = Object.entries(current.value);
          if (
            Object.getPrototypeOf(current.value) !== Object.prototype || entries.length > 256 ||
            entries.some(([key]) => key.length > 200)
          ) invalid = true;
          for (const [, item] of entries) pending.push({ value: item, depth: current.depth + 1 });
        }
      } else {
        invalid = true;
      }
    }
    if (invalid) {
      context.addIssue({ code: "custom", message: "Metadata must be bounded JSON data" });
      return;
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DGCHAT_LIMITS.metadataBytes) {
      context.addIssue({ code: "custom", message: "Metadata exceeds the archive byte limit" });
    }
  },
);

const preferenceSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  compactConversations: z.boolean(),
  reduceMotion: z.boolean(),
  customInstructions: z.string().max(DGCHAT_LIMITS.customInstructionsChars),
  useMemory: z.boolean(),
  saveHistory: z.boolean(),
  preferredModelId: z.string().trim().min(1).max(200).nullable(),
}).strict();

const folderSchema = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  position: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const tagSchema = z.object({
  id,
  name: z.string().trim().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const attachmentSchema = z.object({
  id,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  byteSize: z.number().int().nonnegative().max(10 * 1024 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive().max(100_000).nullable(),
  height: z.number().int().positive().max(100_000).nullable(),
  createdAt: timestamp,
  // Object bytes are deliberately transported separately from this JSON manifest.
  content: z.object({ included: z.literal(false) }).strict(),
}).strict();

const attachmentLinkSchema = z.object({
  attachmentId: id,
  position: z.number().int().nonnegative(),
}).strict();

const messageSchema = z.object({
  id,
  parentId: id.nullable(),
  supersedesId: id.nullable(),
  generationId: id.nullable(),
  siblingIndex: z.number().int().nonnegative(),
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.string().max(DGCHAT_LIMITS.contentChars),
  model: z.string().max(200).nullable(),
  // In-flight generation leases are deliberately not portable. Exporters must settle first.
  status: z.enum(["complete", "stopped", "error", "tombstoned"]),
  metadata: boundedMetadataSchema,
  attachments: z.array(attachmentLinkSchema).max(100).refine(
    (links) => new Set(links.map((link) => link.attachmentId)).size === links.length,
    "A message cannot link an attachment more than once",
  ),
  createdAt: timestamp,
}).strict();

const conversationSchema = z.object({
  id,
  title: z.string().trim().min(1).max(200),
  activeLeafId: id.nullable(),
  pinned: z.boolean(),
  temporary: z.boolean(),
  archivedAt: nullableTimestamp,
  deletedAt: nullableTimestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  folderId: id.nullable(),
  tagIds: z.array(id).max(DGCHAT_LIMITS.tagsPerConversation).refine(
    (ids) => new Set(ids).size === ids.length,
    "Conversation tag identifiers must be unique",
  ),
  messages: uniqueIds(messageSchema, DGCHAT_LIMITS.messagesPerConversation),
}).strict();

const addIssue = (context: z.RefinementCtx, path: PropertyKey[], message: string) =>
  context.addIssue({ code: "custom", path, message });

export const conversationPortabilityV1Schema = z.object({
  format: z.literal(DGCHAT_FORMAT),
  version: z.literal(DGCHAT_VERSION),
  scope: z.literal("owner"),
  exportedAt: timestamp,
  preferences: preferenceSchema,
  folders: uniqueIds(folderSchema, DGCHAT_LIMITS.folders),
  tags: uniqueIds(tagSchema, DGCHAT_LIMITS.tags),
  attachments: uniqueIds(attachmentSchema, DGCHAT_LIMITS.attachments),
  conversations: uniqueIds(conversationSchema, DGCHAT_LIMITS.conversations),
}).strict().superRefine((archive, context) => {
  const folderIds = new Set(archive.folders.map((folder) => folder.id));
  const tagIds = new Set(archive.tags.map((tag) => tag.id));
  const attachmentIds = new Set(archive.attachments.map((attachment) => attachment.id));
  const globalMessageIds = new Set<string>();
  let messageCount = 0;
  let attachmentLinkCount = 0;

  const folderPositions = [...archive.folders].sort((a, b) => a.position - b.position);
  if (folderPositions.some((folder, index) => folder.position !== index)) {
    addIssue(context, ["folders"], "Folder positions must be unique and contiguous from zero");
  }

  for (const [conversationIndex, conversation] of archive.conversations.entries()) {
    const base = ["conversations", conversationIndex];
    if (conversation.folderId !== null && !folderIds.has(conversation.folderId)) {
      addIssue(context, [...base, "folderId"], "Conversation references a missing folder");
    }
    for (const [tagIndex, tagId] of conversation.tagIds.entries()) {
      if (!tagIds.has(tagId)) {
        addIssue(context, [...base, "tagIds", tagIndex], "Conversation references a missing tag");
      }
    }

    messageCount += conversation.messages.length;
    const messages = new Map(conversation.messages.map((message) => [message.id, message]));
    const childCounts = new Map<string, number>();
    const siblingIndexes = new Map<string, Set<number>>();

    for (const [messageIndex, message] of conversation.messages.entries()) {
      const messagePath = [...base, "messages", messageIndex];
      if (globalMessageIds.has(message.id)) {
        addIssue(
          context,
          [...messagePath, "id"],
          "Message identifiers must be archive-wide unique",
        );
      }
      globalMessageIds.add(message.id);
      if (message.parentId !== null) {
        if (!messages.has(message.parentId)) {
          addIssue(context, [...messagePath, "parentId"], "Message references a missing parent");
        } else {
          childCounts.set(message.parentId, (childCounts.get(message.parentId) ?? 0) + 1);
        }
      }
      const siblingGroup = message.parentId ?? "<root>";
      const indexes = siblingIndexes.get(siblingGroup) ?? new Set<number>();
      if (indexes.has(message.siblingIndex)) {
        addIssue(context, [...messagePath, "siblingIndex"], "Sibling indexes must be unique");
      }
      indexes.add(message.siblingIndex);
      siblingIndexes.set(siblingGroup, indexes);

      if (message.supersedesId !== null) {
        const superseded = messages.get(message.supersedesId);
        if (!superseded) {
          addIssue(
            context,
            [...messagePath, "supersedesId"],
            "Message references a missing superseded node",
          );
        } else if (
          superseded.parentId !== message.parentId || superseded.role !== message.role ||
          superseded.id === message.id
        ) {
          addIssue(
            context,
            [...messagePath, "supersedesId"],
            "Superseded nodes must be distinct siblings with the same role",
          );
        }
      }

      attachmentLinkCount += message.attachments.length;
      const positions = new Set<number>();
      for (const [linkIndex, link] of message.attachments.entries()) {
        if (!attachmentIds.has(link.attachmentId)) {
          addIssue(
            context,
            [...messagePath, "attachments", linkIndex, "attachmentId"],
            "Message references a missing attachment",
          );
        }
        if (positions.has(link.position)) {
          addIssue(
            context,
            [...messagePath, "attachments", linkIndex, "position"],
            "Attachment positions must be unique",
          );
        }
        positions.add(link.position);
      }
      if ([...positions].sort((a, b) => a - b).some((position, index) => position !== index)) {
        addIssue(
          context,
          [...messagePath, "attachments"],
          "Attachment positions must be contiguous from zero",
        );
      }
    }

    for (const [group, indexes] of siblingIndexes) {
      const ordered = [...indexes].sort((a, b) => a - b);
      if (ordered.some((value, index) => value !== index)) {
        addIssue(
          context,
          [...base, "messages"],
          `Sibling indexes for ${
            group === "<root>" ? "root messages" : "a parent"
          } must be contiguous from zero`,
        );
      }
    }

    const validateAcyclicLinks = (field: "parentId" | "supersedesId", label: string) => {
      // Every node has at most one outgoing edge. Memoizing settled paths keeps hostile maximum-size
      // chains linear rather than walking the same suffix once per node.
      const state = new Map<string, "visiting" | "settled">();
      for (const start of conversation.messages) {
        if (state.get(start.id) === "settled") continue;
        const path: string[] = [];
        let cursor: typeof start | undefined = start;
        while (cursor && state.get(cursor.id) !== "settled") {
          if (state.get(cursor.id) === "visiting") {
            addIssue(context, [...base, "messages"], `Message ${label} graph contains a cycle`);
            break;
          }
          state.set(cursor.id, "visiting");
          path.push(cursor.id);
          const nextId: string | null = cursor[field];
          cursor = nextId === null ? undefined : messages.get(nextId);
        }
        for (const messageId of path) state.set(messageId, "settled");
      }
    };
    validateAcyclicLinks("parentId", "parent");
    validateAcyclicLinks("supersedesId", "supersession");

    if (conversation.messages.length === 0) {
      if (conversation.activeLeafId !== null) {
        addIssue(
          context,
          [...base, "activeLeafId"],
          "An empty conversation cannot have an active leaf",
        );
      }
    } else if (conversation.activeLeafId === null) {
      addIssue(
        context,
        [...base, "activeLeafId"],
        "A non-empty conversation requires an active leaf",
      );
    } else if (!messages.has(conversation.activeLeafId)) {
      addIssue(context, [...base, "activeLeafId"], "Active leaf references a missing message");
    } else if ((childCounts.get(conversation.activeLeafId) ?? 0) !== 0) {
      addIssue(context, [...base, "activeLeafId"], "Active leaf must not have child messages");
    }
  }

  if (messageCount > DGCHAT_LIMITS.messages) {
    addIssue(context, ["conversations"], "Archive contains too many messages");
  }
  if (attachmentLinkCount > DGCHAT_LIMITS.attachmentLinks) {
    addIssue(context, ["conversations"], "Archive contains too many attachment links");
  }
});

export type ConversationPortabilityV1 = z.infer<typeof conversationPortabilityV1Schema>;

/** Parse untrusted .dgchat JSON without accepting future or unknown fields. */
export function parseConversationPortabilityV1(input: unknown): ConversationPortabilityV1 {
  return conversationPortabilityV1Schema.parse(input);
}
