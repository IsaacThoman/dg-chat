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
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
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
  n: z.number().int().positive().max(16).optional(),
  user: z.string().optional(),
}).passthrough();

export const responsesSchema = z.object({
  model: z.string().min(1).max(200),
  input: z.union([
    z.string().min(1).max(2_000_000),
    z.array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.union([
          z.string().max(2_000_000),
          z.array(z.record(z.string(), z.unknown())).max(256),
        ]),
      }).passthrough(),
    ).min(1).max(256),
  ]),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().max(131_072).optional(),
}).passthrough();

export const approvalSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  startingCreditMicros: z.number().int().nonnegative().max(1_000_000_000).optional(),
});
