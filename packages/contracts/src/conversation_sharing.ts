import { z } from "zod";
import type { PublicConversationShare } from "./types.ts";

const UUID = z.string().uuid();
const ISO = z.string().datetime({ offset: true });
const attachment = z.object({
  id: UUID,
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(1).max(25 * 1024 * 1024),
  width: z.number().int().min(1).max(100_000).nullable(),
  height: z.number().int().min(1).max(100_000).nullable(),
  createdAt: ISO,
}).strict().refine((value) => (value.width === null) === (value.height === null), {
  message: "Attachment dimensions must both be present or absent",
});
const message = z.object({
  id: UUID,
  parentId: UUID.nullable(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().max(1_000_000),
  status: z.enum(["complete", "stopped", "error"]),
  attachmentIds: z.array(UUID).max(100),
  createdAt: ISO,
}).strict();

export const publicConversationShareSchema = z.object({
  id: UUID,
  title: z.string().min(1).max(500),
  conversationVersion: z.number().int().nonnegative(),
  identity: z.object({
    visibility: z.enum(["owner", "anonymous"]),
    displayName: z.string().min(1).max(200).nullable(),
  }).strict(),
  attachmentPolicy: z.enum(["include", "redact", "selected"]),
  messages: z.array(message).min(1).max(20_000),
  attachments: z.array(attachment).max(2_000),
  createdAt: ISO,
  expiresAt: ISO.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.identity.visibility === "owner") !== (value.identity.displayName !== null)) {
    context.addIssue({ code: "custom", path: ["identity"], message: "Identity is inconsistent" });
  }
  if (value.attachmentPolicy === "redact" && value.attachments.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["attachments"],
      message: "Redacted shares cannot contain attachments",
    });
  }
  const attachmentIds = new Set(value.attachments.map((item) => item.id));
  if (attachmentIds.size !== value.attachments.length) {
    context.addIssue({
      code: "custom",
      path: ["attachments"],
      message: "Attachment identifiers must be unique",
    });
  }
  const messageIds = new Set<string>();
  let totalContent = 0;
  value.messages.forEach((item, index) => {
    totalContent += item.content.length;
    if (messageIds.has(item.id)) {
      context.addIssue({
        code: "custom",
        path: ["messages", index, "id"],
        message: "Message identifiers must be unique",
      });
    }
    messageIds.add(item.id);
    const expectedParent = index === 0 ? null : value.messages[index - 1].id;
    if (item.parentId !== expectedParent) {
      context.addIssue({
        code: "custom",
        path: ["messages", index, "parentId"],
        message: "Messages must form one ordered path",
      });
    }
    if (
      new Set(item.attachmentIds).size !== item.attachmentIds.length ||
      item.attachmentIds.some((id) => !attachmentIds.has(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["messages", index, "attachmentIds"],
        message: "Message attachment references are invalid",
      });
    }
  });
  if (totalContent > 16_000_000) {
    context.addIssue({
      code: "custom",
      path: ["messages"],
      message: "Shared message content is too large",
    });
  }
});

export function parsePublicConversationShare(value: unknown): PublicConversationShare {
  return publicConversationShareSchema.parse(value) as PublicConversationShare;
}
