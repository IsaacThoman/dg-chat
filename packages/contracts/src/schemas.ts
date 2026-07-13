import { z } from "npm:zod@4.1.12";

export const emailSchema = z.string().email().max(320).transform((value) => value.toLowerCase());
export const passwordSchema = z.string().min(10).max(128);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(80),
});

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });
export const identityTokenSchema = z.object({ token: z.string().min(32).max(512) }).strict();
export const passwordResetRequestSchema = z.object({ email: emailSchema }).strict();
export const passwordResetSchema = z.object({
  // Better Auth generates 24-character, high-entropy reset tokens. The legacy
  // reset flow still emits longer `reset_` tokens, so the shared web contract
  // must accept both during the coordinated migration window.
  token: z.string().min(16).max(512),
  password: passwordSchema,
}).strict();

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).default("New chat"),
  temporary: z.boolean().default(false),
});

export const keepTemporaryConversationSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
}).strict();

/** Owner-controlled policy for one immutable, revocable conversation snapshot. */
export const createConversationShareSchema = z.object({
  // A Web Crypto generated 32-byte capability. It is hashed before persistence.
  capability: z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/),
  leafId: z.string().uuid(),
  expectedConversationVersion: z.number().int().nonnegative(),
  identityVisibility: z.enum(["owner", "anonymous"]),
  attachmentPolicy: z.enum(["include", "redact", "selected"]),
  selectedAttachmentIds: z.array(z.string().uuid()).max(100).refine(
    (ids) => new Set(ids).size === ids.length,
    "Attachment identifiers must be unique",
  ).default([]),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.attachmentPolicy === "selected" && value.selectedAttachmentIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedAttachmentIds"],
      message: "Select at least one attachment",
    });
  }
  if (value.attachmentPolicy !== "selected" && value.selectedAttachmentIds.length !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedAttachmentIds"],
      message: "Attachment selections require the selected policy",
    });
  }
});

export const revokeConversationShareSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export const updateConversationSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  deleted: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
  message: "At least one conversation field is required",
});

export const updatePreferencesSchema = z.object({
  expectedVersion: z.number().int().positive(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  compactConversations: z.boolean().optional(),
  reduceMotion: z.boolean().optional(),
  customInstructions: z.string().max(20_000).optional(),
  useMemory: z.boolean().optional(),
  saveHistory: z.boolean().optional(),
  preferredModelId: z.string().trim().min(1).max(200).nullable().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
  message: "At least one preference is required",
});

const workspaceNameSchema = z.string().trim().min(1).max(120);
const expectedWorkspaceVersionSchema = z.number().int().positive();
export const createConversationFolderSchema = z.object({ name: workspaceNameSchema }).strict();
export const updateConversationFolderSchema = z.object({
  name: workspaceNameSchema.optional(),
  expectedVersion: expectedWorkspaceVersionSchema,
}).strict().refine((value) => value.name !== undefined, { message: "A folder field is required" });
export const reorderConversationFoldersSchema = z.object({
  folderIds: z.array(z.string().uuid()).max(500).refine((ids) => new Set(ids).size === ids.length),
  expectedVersions: z.record(z.string().uuid(), expectedWorkspaceVersionSchema),
}).strict().refine((value) => {
  const keys = Object.keys(value.expectedVersions);
  return keys.length === value.folderIds.length && keys.every((id) => value.folderIds.includes(id));
}, { message: "Expected versions must exactly match folder identifiers" });
export const replaceFolderMembershipsSchema = z.object({
  conversationIds: z.array(z.string().uuid()).max(5000).refine((ids) =>
    new Set(ids).size === ids.length
  ),
  expectedMembershipVersions: z.record(z.string().uuid(), z.number().int().nonnegative()),
}).strict();
export const deleteConversationFolderSchema = z.object({
  expectedVersion: expectedWorkspaceVersionSchema,
  expectedMembershipVersion: z.number().int().nonnegative(),
}).strict();
export const workspaceDeleteSchema = z.object({
  expectedVersion: expectedWorkspaceVersionSchema,
}).strict();
export const createConversationTagSchema = z.object({
  name: workspaceNameSchema.max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict();
export const updateConversationTagSchema = z.object({
  name: workspaceNameSchema.max(64).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  expectedVersion: expectedWorkspaceVersionSchema,
}).strict().refine((value) => value.name !== undefined || value.color !== undefined, {
  message: "A tag field is required",
});
export const replaceConversationTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()).max(20).refine((ids) => new Set(ids).size === ids.length),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

const knowledgeIdempotencyKeySchema = z.string().min(8).max(160).regex(
  /^[A-Za-z0-9._:-]+$/,
  "Idempotency key contains unsupported characters",
);

export const createKnowledgeCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  idempotencyKey: knowledgeIdempotencyKeySchema.optional(),
}).strict();

export const updateKnowledgeCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  expectedVersion: z.number().int().positive(),
}).strict().refine((value) => value.name !== undefined || value.description !== undefined, {
  message: "At least one collection field is required",
});

export const knowledgeExpectedVersionSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export const knowledgeBindingSchema = z.object({
  mode: z.enum(["retrieval", "full_context"]),
  expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

export const replaceConversationKnowledgeSchema = z.object({
  collectionIds: z.array(z.string().uuid()).max(50).refine(
    (ids) => new Set(ids).size === ids.length,
    "Collection identifiers must be unique",
  ),
  mode: z.enum(["retrieval", "full_context"]),
}).strict();

export const setActiveLeafSchema = z.object({
  leafId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export const appendMessageSchema = z.object({
  parentId: z.string().uuid().nullable(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(2_000_000),
  model: z.string().max(200).optional(),
  supersedesId: z.string().uuid().nullable().optional(),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(200),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const generateMessageObjectSchema = z.object({
  parentId: z.string().uuid().nullable(),
  supersedesId: z.string().uuid().nullable().optional(),
  content: z.string().trim().max(2_000_000),
  model: z.string().min(1).max(200),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(200),
  attachmentIds: z.array(z.string().uuid()).max(10).refine(
    (ids) => new Set(ids).size === ids.length,
    "Attachment identifiers must be unique",
  ).optional().default([]),
  toolExecutionIds: z.array(z.string().uuid()).max(8).refine(
    (ids) => new Set(ids).size === ids.length,
    "Tool execution identifiers must be unique",
  ).optional().default([]),
});

const requireMessageContent = (
  value: { content: string; attachmentIds: string[]; toolExecutionIds: string[] },
  context: z.RefinementCtx,
) => {
  if (
    value.content.length === 0 && value.attachmentIds.length === 0 &&
    value.toolExecutionIds.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "Message content or at least one attachment is required",
    });
  }
};

export const generateMessageSchema = generateMessageObjectSchema.superRefine(requireMessageContent);

export const streamGenerationSchema = z.discriminatedUnion("mode", [
  generateMessageObjectSchema.extend({ mode: z.literal("send") }).superRefine(
    requireMessageContent,
  ),
  z.object({
    mode: z.enum(["regenerate", "continue"]),
    sourceMessageId: z.string().uuid(),
    model: z.string().min(1).max(200),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(200),
  }).strict(),
]);

const generationEventBase = {
  generationId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
};
export const webGenerationEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...generationEventBase,
    type: z.literal("generation.started"),
    user: z.record(z.string(), z.unknown()),
    conversation: z.record(z.string(), z.unknown()),
    replay: z.boolean(),
  }).strict(),
  ...(["response.text.delta", "response.reasoning.delta", "response.refusal.delta"] as const)
    .map((type) =>
      z.object({ ...generationEventBase, type: z.literal(type), delta: z.string().max(1_048_576) })
        .strict()
    ),
  z.object({
    ...generationEventBase,
    type: z.literal("response.tool_call.delta"),
    index: z.number().int().min(0).max(127),
    id: z.string().max(512).optional(),
    name: z.string().max(512).optional(),
    arguments: z.string().max(1_048_576).optional(),
  }).strict(),
  z.object({
    ...generationEventBase,
    type: z.literal("response.usage"),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  }).strict(),
  ...(["generation.completed", "generation.stopped", "generation.error"] as const).map((type) =>
    z.object({
      ...generationEventBase,
      type: z.literal(type),
      assistant: z.record(z.string(), z.unknown()),
      conversation: z.record(z.string(), z.unknown()),
    }).strict()
  ),
]);

const tokenMutableFields = {
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(["models:read", "chat:write", "files:read", "files:write"])).min(1),
  expiresAt: z.string().datetime().nullable(),
  rpmLimit: z.number().int().min(1).max(60_000).nullable(),
  burstLimit: z.number().int().min(1).max(1_000).nullable(),
};

function validTokenLimits(value: { rpmLimit?: number | null; burstLimit?: number | null }) {
  return value.rpmLimit === undefined || value.rpmLimit === null ||
    value.burstLimit === undefined ||
    value.burstLimit === null || value.burstLimit <= value.rpmLimit;
}

export const createTokenSchema = z.object({
  ...tokenMutableFields,
  expiresAt: tokenMutableFields.expiresAt.optional(),
  rpmLimit: tokenMutableFields.rpmLimit.optional(),
  burstLimit: tokenMutableFields.burstLimit.optional(),
}).strict().refine(validTokenLimits, {
  message: "burstLimit cannot exceed rpmLimit",
  path: ["burstLimit"],
});

export const updateTokenSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: tokenMutableFields.name.optional(),
  scopes: tokenMutableFields.scopes.optional(),
  expiresAt: tokenMutableFields.expiresAt.optional(),
  rpmLimit: tokenMutableFields.rpmLimit.optional(),
  burstLimit: tokenMutableFields.burstLimit.optional(),
}).strict().refine(validTokenLimits, {
  message: "burstLimit cannot exceed rpmLimit",
  path: ["burstLimit"],
});

export const rotateTokenSchema = z.object({
  expectedVersion: z.number().int().min(1),
  overlapSeconds: z.number().int().min(0).max(3_600),
}).strict();

export const revokeTokenSchema = z.object({
  expectedVersion: z.number().int().min(1),
}).strict();

const modelAccessName = z.string().trim().min(1).max(120);
const modelAccessDescription = z.string().trim().max(500);
export const createModelAliasSchema = z.object({
  alias: z.string().trim().min(3).max(255),
  targetModelId: z.string().trim().min(3).max(255),
  description: modelAccessDescription.optional(),
}).strict();
export const updateModelAliasSchema = z.object({
  expectedVersion: z.number().int().min(1),
  alias: z.string().trim().min(3).max(255).optional(),
  targetModelId: z.string().trim().min(3).max(255).optional(),
  description: modelAccessDescription.optional(),
}).strict();
export const createAccessGroupSchema = z.object({
  name: modelAccessName,
  description: modelAccessDescription.optional(),
}).strict();
export const updateAccessGroupSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: modelAccessName.optional(),
  description: modelAccessDescription.optional(),
}).strict();
export const replaceAccessGroupIdsSchema = z.object({
  expectedVersion: z.number().int().min(1),
  ids: z.array(z.string().uuid()).max(10_000),
}).strict();
export const replaceAccessGroupModelsSchema = z.object({
  expectedVersion: z.number().int().min(1),
  ids: z.array(z.string().uuid()).max(10_000),
  acknowledgePublicModelIds: z.array(z.string().uuid()).max(10_000).default([]),
}).strict();
export const deleteAccessGroupSchema = z.object({
  expectedVersion: z.number().int().min(1),
  acknowledgePublicModelIds: z.array(z.string().uuid()).max(10_000).default([]),
}).strict();
export const setTokenAccessGroupsSchema = z.object({
  ownerId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  groupIds: z.array(z.string().uuid()).max(1_000),
}).strict();
export const replaceAccessGroupPolicySchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: modelAccessName.optional(),
  description: modelAccessDescription.optional(),
  userIds: z.array(z.string().uuid()).max(10_000),
  modelIds: z.array(z.string().uuid()).max(10_000),
  tokenIds: z.array(z.string().uuid()).max(10_000),
}).strict();
export const previewAccessGroupPolicySchema = z.object({
  proposal: z.object({
    userIds: z.array(z.string().uuid()).max(10_000),
    modelIds: z.array(z.string().uuid()).max(10_000),
    tokenIds: z.array(z.string().uuid()).max(10_000),
  }).strict().nullable().optional(),
}).strict();
export const setTokenAccessModeSchema = z.object({
  ownerId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  accessMode: z.enum(["inherit", "restricted"]),
}).strict();

export const chatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(["system", "developer", "user", "assistant", "tool"]),
      content: z.union([z.string(), z.array(z.record(z.string(), z.unknown())), z.null()]),
      name: z.string().optional(),
      tool_call_id: z.string().optional(),
      tool_calls: z.array(z.unknown()).max(128).optional(),
    }).passthrough(),
  ).min(1).max(256),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(131072).optional(),
  max_completion_tokens: z.number().int().positive().max(131072).optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(16)]).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  n: z.literal(1).optional(),
  user: z.string().optional(),
}).passthrough();

export const responsesSchema = z.object({
  model: z.string().min(1).max(200),
  input: z.union([
    z.string().min(1).max(2_000_000),
    z.array(
      z.union([
        z.object({
          type: z.literal("message").optional(),
          role: z.enum(["system", "developer", "user", "assistant"]),
          content: z.union([
            z.string().max(2_000_000),
            z.array(z.record(z.string(), z.unknown())).max(256),
          ]),
        }).passthrough(),
        z.object({
          type: z.literal("function_call"),
          id: z.string().min(1).max(512).optional(),
          call_id: z.string().min(1).max(512),
          name: z.string().min(1).max(128),
          arguments: z.string().max(1_000_000),
          status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
        }).passthrough(),
        z.object({
          type: z.literal("function_call_output"),
          call_id: z.string().min(1).max(512),
          output: z.string().max(2_000_000),
        }).passthrough(),
      ]),
    ).min(1).max(256),
  ]),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().max(131_072).optional(),
}).passthrough();

const embeddingTokenArraySchema = z.array(z.number().int().min(0).max(4_294_967_295))
  .min(1).max(131_072);

/** OpenAI-compatible embeddings request, bounded before provider dispatch. */
export const embeddingsSchema = z.object({
  model: z.string().trim().min(1).max(200),
  input: z.union([
    z.string().max(2_000_000),
    z.array(z.string().max(2_000_000)).min(1).max(2_048),
    embeddingTokenArraySchema,
    z.array(embeddingTokenArraySchema).min(1).max(2_048),
  ]),
  encoding_format: z.enum(["float", "base64"]).optional(),
  dimensions: z.number().int().min(1).max(65_536).optional(),
  user: z.string().max(512).optional(),
}).strict();

export const approvalSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  startingCreditMicros: z.number().int().nonnegative().max(1_000_000_000).optional(),
});
