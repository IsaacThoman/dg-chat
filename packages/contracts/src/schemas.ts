import { z } from "npm:zod@4.1.12";

export const emailSchema = z.string().email().max(320).transform((value) => value.toLowerCase());
export const passwordSchema = z.string().min(10).max(128);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(80),
});

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).default("New chat"),
  temporary: z.boolean().default(false),
});

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

export const generateMessageSchema = z.object({
  parentId: z.string().uuid().nullable(),
  supersedesId: z.string().uuid().nullable().optional(),
  content: z.string().trim().min(1).max(2_000_000),
  model: z.string().min(1).max(200),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(200),
});

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(["models:read", "chat:write", "files:read", "files:write"])).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const chatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
  })).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(131072).optional(),
  tools: z.array(z.unknown()).optional(),
  user: z.string().optional(),
});

export const approvalSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  startingCreditMicros: z.number().int().nonnegative().max(1_000_000_000).optional(),
});
