import { Hono } from "npm:hono@4.9.8";
import { cors } from "npm:hono@4.9.8/cors";
import { deleteCookie, getCookie, setCookie } from "npm:hono@4.9.8/cookie";
import { logger } from "npm:hono@4.9.8/logger";
import { secureHeaders } from "npm:hono@4.9.8/secure-headers";
import { streamSSE } from "npm:hono@4.9.8/streaming";
import type { Context, MiddlewareHandler } from "npm:hono@4.9.8";
import {
  appendMessageSchema,
  approvalSchema,
  chatCompletionSchema,
  createConversationSchema,
  createTokenSchema,
  generateMessageSchema,
  loginSchema,
  registerSchema,
} from "@dg-chat/contracts";
import type { ChatCompletionRequest, PublicUser } from "@dg-chat/contracts";
import { DomainError, MemoryRepository } from "@dg-chat/database";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto.ts";
import { complete, models, simulate } from "./models.ts";

type Variables = {
  user: PublicUser;
  authType: "session" | "token";
  tokenId?: string;
  tokenScopes?: string[];
};
export interface AppOptions {
  repository?: MemoryRepository;
  setupToken?: string;
  startingCreditMicros?: number;
}

const openAIError = (message: string, code: string | null = null) => ({
  error: { message, type: "invalid_request_error", param: null, code },
});
const parseJson = async <T>(
  c: Context,
  schema: {
    safeParse: (value: unknown) => { success: boolean; data?: T; error?: { issues: unknown[] } };
  },
): Promise<T> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new DomainError("invalid_json", "Request body must be valid JSON", 400);
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainError("validation_error", "Request validation failed", 422);
  return result.data!;
};

export function createApp(options: AppOptions = {}) {
  const repo = options.repository ?? new MemoryRepository();
  const setupToken = options.setupToken ?? Deno.env.get("SETUP_TOKEN") ?? "";
  const startingCredit = options.startingCreditMicros ??
    Number(Deno.env.get("STARTING_CREDIT_MICROS") ?? 5_000_000);
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", logger());
  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    await next();
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) await repo.flush();
  });
  app.use(
    "*",
    cors({
      origin: Deno.env.get("WEB_ORIGIN") ?? "http://localhost:5173",
      credentials: true,
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    }),
  );
  app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const allowed = Deno.env.get("WEB_ORIGIN") ?? Deno.env.get("WEB_URL") ??
        "http://localhost:5173";
      if (origin && origin !== allowed) {
        return c.json({
          error: { code: "invalid_origin", message: "Request origin is not allowed" },
        }, 403);
      }
    }
    await next();
  });

  const authenticate: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const raw = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      c.req.header("x-session-token") ?? getCookie(c, "dg_session");
    if (!raw) return c.json(openAIError("Authentication required", "unauthorized"), 401);
    const hash = await sha256(raw);
    const apiToken = repo.findApiTokenByHash(hash);
    if (apiToken) {
      const user = repo.findUser(apiToken.userId);
      if (
        !user || user.state !== "active" || user.approvalStatus !== "approved" ||
        apiToken.revokedAt || (apiToken.expiresAt && Date.parse(apiToken.expiresAt) <= Date.now())
      ) return c.json(openAIError("Invalid or expired token", "unauthorized"), 401);
      apiToken.lastUsedAt = new Date().toISOString();
      c.set("user", repo.publicUser(user));
      c.set("authType", "token");
      c.set("tokenId", apiToken.id);
      c.set("tokenScopes", apiToken.scopes);
      return next();
    }
    const session = repo.getSession(hash);
    const user = session ? repo.findUser(session.userId) : undefined;
    if (!session || !user || user.state !== "active") {
      return c.json(openAIError("Invalid or expired session", "unauthorized"), 401);
    }
    c.set("user", repo.publicUser(user));
    c.set("authType", "session");
    return next();
  };
  const approved: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    if (c.get("user").approvalStatus !== "approved") {
      return c.json({
        error: { code: "approval_required", message: "An administrator must approve this account" },
      }, 403);
    }
    await next();
  };
  const admin: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    if (c.get("user").role !== "admin") {
      return c.json(
        { error: { code: "forbidden", message: "Administrator access required" } },
        403,
      );
    }
    await next();
  };
  const sessionOnly: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    if (c.get("authType") !== "session") {
      return c.json(
        { error: { code: "session_required", message: "A browser session is required" } },
        403,
      );
    }
    await next();
  };
  const requireScope =
    (scope: string): MiddlewareHandler<{ Variables: Variables }> => async (c, next) => {
      if (c.get("authType") === "token" && !c.get("tokenScopes")?.includes(scope)) {
        return c.json(
          openAIError(`Token requires the '${scope}' scope`, "insufficient_scope"),
          403,
        );
      }
      await next();
    };

  app.get("/health", (c) => c.json({ status: "ok", service: "api" }));
  app.get("/ready", (c) => c.json({ status: "ready", storage: repo.storageKind }));

  app.post("/api/setup/bootstrap", async (c) => {
    if (!setupToken) throw new DomainError("setup_disabled", "SETUP_TOKEN is not configured", 503);
    if ([...repo.users.values()].some((u) => u.role === "admin")) {
      throw new DomainError("already_bootstrapped", "An administrator already exists", 409);
    }
    if (c.req.header("x-setup-token") !== setupToken) {
      throw new DomainError("invalid_setup_token", "Invalid setup token", 401);
    }
    const body = await parseJson(c, registerSchema);
    const user = repo.createUser({
      ...body,
      passwordHash: await hashPassword(body.password),
      role: "admin",
      approvalStatus: "approved",
    });
    repo.credit(user.id, `bootstrap:${user.id}`, "grant", startingCredit);
    return c.json({ user: repo.publicUser(user) }, 201);
  });

  const signUp = async (c: Context) => {
    const body = await parseJson(c, registerSchema);
    const user = repo.createUser({ ...body, passwordHash: await hashPassword(body.password) });
    const token = randomToken("sess_");
    repo.createSession(user.id, await sha256(token), true);
    setCookie(c, "dg_session", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: Deno.env.get("DENO_ENV") === "production",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.json({ token, user: repo.publicUser(user), limited: true }, 201);
  };
  app.post("/api/auth/sign-up/email", signUp);
  app.post("/api/auth/register", signUp);
  const signIn = async (c: Context) => {
    const body = await parseJson(c, loginSchema);
    const user = repo.findUserByEmail(body.email);
    if (!user || !await verifyPassword(body.password, user.passwordHash)) {
      throw new DomainError("invalid_credentials", "Email or password is incorrect", 401);
    }
    if (user.state !== "active") {
      throw new DomainError("account_unavailable", "This account is unavailable", 403);
    }
    if (user.approvalStatus === "rejected") {
      throw new DomainError("account_rejected", "This account was not approved", 403);
    }
    const limited = user.approvalStatus !== "approved";
    const token = randomToken("sess_");
    repo.createSession(user.id, await sha256(token), limited);
    setCookie(c, "dg_session", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: Deno.env.get("DENO_ENV") === "production",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.json({ token, user: repo.publicUser(user), limited });
  };
  app.post("/api/auth/sign-in/email", signIn);
  app.post("/api/auth/login", signIn);
  app.post("/api/auth/sign-out", async (c) => {
    const token = getCookie(c, "dg_session");
    if (token) repo.sessions.delete(await sha256(token));
    deleteCookie(c, "dg_session", { path: "/", secure: Deno.env.get("DENO_ENV") === "production" });
    return c.body(null, 204);
  });
  app.get(
    "/api/auth/me",
    authenticate,
    (c) => c.json({ user: c.get("user"), limited: c.get("user").approvalStatus !== "approved" }),
  );
  app.get(
    "/api/auth/status",
    authenticate,
    (c) => c.json({ approvalStatus: c.get("user").approvalStatus, state: c.get("user").state }),
  );

  app.use("/api/conversations/*", authenticate, approved, sessionOnly);
  app.use("/api/conversations", authenticate, approved, sessionOnly);
  app.get(
    "/api/conversations",
    (c) =>
      c.json({ data: repo.listConversations(c.get("user").id, c.req.query("deleted") === "true") }),
  );
  app.post("/api/conversations", async (c) => {
    const body = await parseJson(c, createConversationSchema);
    return c.json(repo.createConversation(c.get("user").id, body.title), 201);
  });
  app.get(
    "/api/conversations/:id",
    (c) => c.json(repo.detail(c.req.param("id"), c.get("user").id)),
  );
  app.post("/api/conversations/:id/messages", async (c) => {
    const body = await parseJson(c, appendMessageSchema);
    return c.json(
      repo.appendMessage({ ...body, conversationId: c.req.param("id"), ownerId: c.get("user").id }),
      201,
    );
  });
  app.post("/api/conversations/:id/generate", async (c) => {
    const body = await parseJson(c, generateMessageSchema);
    const conversationId = c.req.param("id");
    const ownerId = c.get("user").id;
    const model = models.find((candidate) => candidate.id === body.model) ??
      models.find((candidate) =>
        body.model.startsWith("openai/") && candidate.provider === "openai-compatible"
      );
    if (!model) {
      throw new DomainError("model_not_found", `Model '${body.model}' does not exist`, 404);
    }
    const userMessage = repo.appendMessage({
      conversationId,
      ownerId,
      parentId: body.parentId,
      supersedesId: body.supersedesId,
      role: "user",
      content: body.content,
      model: body.model,
      expectedVersion: body.expectedVersion,
      idempotencyKey: `${body.idempotencyKey}:user`,
    });
    const history = [];
    let cursor = userMessage as typeof userMessage | undefined;
    while (cursor) {
      history.unshift({ role: cursor.role, content: cursor.content });
      cursor = cursor.parentId ? repo.messages.get(cursor.parentId) : undefined;
    }
    const runId = `${ownerId}:web-generation:${body.idempotencyKey}`;
    repo.reserve(ownerId, runId, body.model, 10_000);
    const started = performance.now();
    try {
      const result = await complete({ model: body.model, messages: history }, c.req.raw.signal);
      const cost = Math.max(
        1,
        Math.ceil(
          result.inputTokens * (model.inputMicrosPerMillion / 1_000_000) +
            result.outputTokens * (model.outputMicrosPerMillion / 1_000_000),
        ),
      );
      repo.settle(
        runId,
        cost,
        result.inputTokens,
        result.outputTokens,
        Math.round(performance.now() - started),
      );
      const assistant = repo.appendMessage({
        conversationId,
        ownerId,
        parentId: userMessage.id,
        role: "assistant",
        content: result.text,
        model: body.model,
        expectedVersion: body.expectedVersion + 1,
        idempotencyKey: `${body.idempotencyKey}:assistant`,
        metadata: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: Math.round(performance.now() - started),
          runId,
        },
      });
      return c.json({
        user: userMessage,
        assistant,
        conversation: repo.conversations.get(conversationId),
      }, 201);
    } catch (error) {
      repo.refund(runId);
      throw error;
    }
  });
  app.post("/api/conversations/:id/active-leaf", async (c) => {
    const body = await c.req.json<{ leafId: string; expectedVersion: number }>();
    return c.json(
      repo.setActiveLeaf(c.req.param("id"), c.get("user").id, body.leafId, body.expectedVersion),
    );
  });
  app.patch("/api/conversations/:id", async (c) => {
    const conversation = repo.conversations.get(c.req.param("id"));
    if (!conversation || conversation.ownerId !== c.get("user").id) {
      throw new DomainError("not_found", "Conversation not found", 404);
    }
    const body = await c.req.json<
      { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean }
    >();
    if (body.title !== undefined) conversation.title = body.title.trim().slice(0, 200);
    if (body.pinned !== undefined) conversation.pinned = body.pinned;
    if (body.archived !== undefined) {
      conversation.archivedAt = body.archived ? new Date().toISOString() : null;
    }
    if (body.deleted !== undefined) {
      conversation.deletedAt = body.deleted ? new Date().toISOString() : null;
    }
    conversation.version++;
    conversation.updatedAt = new Date().toISOString();
    return c.json(conversation);
  });

  app.use("/api/tokens/*", authenticate, approved, sessionOnly);
  app.use("/api/tokens", authenticate, approved, sessionOnly);
  app.get("/api/tokens", (c) => c.json({ data: repo.listApiTokens(c.get("user").id) }));
  app.post("/api/tokens", async (c) => {
    const body = await parseJson(c, createTokenSchema);
    const secret = randomToken("dg_");
    const record = repo.createApiToken(c.get("user").id, {
      ...body,
      tokenHash: await sha256(secret),
      preview: `${secret.slice(0, 7)}…${secret.slice(-4)}`,
    });
    const { tokenHash: _h, userId: _u, ...summary } = record;
    return c.json({ token: secret, ...summary }, 201);
  });
  app.delete("/api/tokens/:id", (c) => {
    repo.revokeApiToken(c.req.param("id"), c.get("user").id);
    return c.body(null, 204);
  });
  app.get(
    "/api/usage",
    authenticate,
    approved,
    sessionOnly,
    (c) => c.json(repo.usage(c.get("user").id)),
  );
  app.get("/api/models", authenticate, approved, sessionOnly, (c) => c.json({ data: models }));

  app.use("/api/admin/*", authenticate, approved, sessionOnly, admin);
  app.get(
    "/api/admin/users",
    (c) => c.json({ data: [...repo.users.values()].map((u) => repo.publicUser(u)) }),
  );
  app.patch("/api/admin/users/:id/approval", async (c) => {
    const body = await parseJson(c, approvalSchema);
    return c.json(
      repo.publicUser(
        repo.approveUser(
          c.req.param("id"),
          body.status,
          body.startingCreditMicros ?? startingCredit,
        ),
      ),
    );
  });
  app.patch("/api/admin/users/:id/state", async (c) => {
    const body = await c.req.json<{ state: "active" | "suspended" | "deleted" }>();
    if (!["active", "suspended", "deleted"].includes(body.state)) {
      throw new DomainError("validation_error", "Invalid state", 422);
    }
    return c.json(repo.publicUser(repo.setUserState(c.req.param("id"), body.state)));
  });
  app.get(
    "/api/admin/usage",
    (c) =>
      c.json({
        calls: repo.usageRuns.size,
        users: repo.users.size,
        balanceMicros: [...repo.users.values()].reduce((n, u) => n + u.balanceMicros, 0),
        ledger: repo.ledger,
      }),
  );
  app.get("/api/admin/jobs", (c) => c.json({ data: repo.jobs }));
  app.get(
    "/api/admin/providers",
    (c) =>
      c.json({
        data: [{ id: "simulated", status: "healthy", configured: true }, {
          id: "openai-compatible",
          status: Deno.env.get("OPENAI_API_KEY") ? "configured" : "disabled",
          configured: Boolean(Deno.env.get("OPENAI_API_KEY")),
        }],
      }),
  );

  app.use("/v1/*", authenticate, approved);
  app.get(
    "/v1/models",
    requireScope("models:read"),
    (c) =>
      c.json({
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created: 0,
          owned_by: m.provider,
          capabilities: m.capabilities,
        })),
      }),
  );
  const chatHandler = async (c: Context<{ Variables: Variables }>) => {
    const request = await parseJson<ChatCompletionRequest>(c, chatCompletionSchema);
    const model = models.find((m) => m.id === request.model) ??
      (request.model.startsWith("openai/")
        ? models.find((m) => m.provider === "openai-compatible")
        : undefined);
    if (!model) {
      return c.json(openAIError(`Model '${request.model}' does not exist`, "model_not_found"), 404);
    }
    const runId = `${c.get("user").id}:chat:${
      c.req.header("idempotency-key") ?? crypto.randomUUID()
    }`;
    const estimatedInput = Math.max(1, Math.ceil(JSON.stringify(request.messages).length / 4));
    const maxOutput = request.max_tokens ?? 4096;
    const reserveMicros = Math.max(
      1,
      Math.ceil(
        estimatedInput * (model.inputMicrosPerMillion / 1_000_000) +
          maxOutput * (model.outputMicrosPerMillion / 1_000_000),
      ),
    );
    repo.reserve(c.get("user").id, runId, request.model, reserveMicros);
    const started = performance.now();
    if (request.stream && request.model.startsWith("simulated/")) {
      const text = simulate(request);
      const words = text.split(/(?<=\s)/);
      const id = `chatcmpl-${crypto.randomUUID()}`;
      return streamSSE(c, async (stream) => {
        try {
          for (const word of words) {
            if (stream.closed) break;
            await stream.writeSSE({
              data: JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: request.model,
                choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
              }),
            });
            await stream.sleep(18);
          }
          await stream.writeSSE({
            data: JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          });
          await stream.writeSSE({ data: "[DONE]" });
          const input = Math.ceil(JSON.stringify(request.messages).length / 4);
          repo.settle(
            runId,
            Math.max(1, input + Math.ceil(text.length / 4)),
            input,
            Math.ceil(text.length / 4),
            Math.round(performance.now() - started),
          );
        } catch (error) {
          repo.refund(runId);
          throw error;
        }
      });
    }
    try {
      const result = await complete(request, c.req.raw.signal);
      const cost = Math.max(
        1,
        Math.ceil(
          result.inputTokens * (model.inputMicrosPerMillion / 1_000_000) +
            result.outputTokens * (model.outputMicrosPerMillion / 1_000_000),
        ),
      );
      repo.settle(
        runId,
        cost,
        result.inputTokens,
        result.outputTokens,
        Math.round(performance.now() - started),
      );
      if (result.upstream) return c.json(result.upstream);
      return c.json({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: result.text },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: result.inputTokens,
          completion_tokens: result.outputTokens,
          total_tokens: result.inputTokens + result.outputTokens,
        },
      });
    } catch (error) {
      repo.refund(runId);
      throw error;
    }
  };
  app.post("/v1/chat/completions", requireScope("chat:write"), chatHandler);
  app.post("/v1/responses", requireScope("chat:write"), async (c) => {
    const body = await c.req.json<
      { model: string; input: string | Array<{ role: string; content: string }>; stream?: boolean }
    >();
    if (body.stream) {
      return c.json(openAIError("Streaming Responses is not enabled", "unsupported_feature"), 501);
    }
    const messages = typeof body.input === "string"
      ? [{ role: "user" as const, content: body.input }]
      : body.input.map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: m.content,
      }));
    const request = { model: body.model, messages, stream: false };
    const model = models.find((candidate) => candidate.id === body.model) ??
      models.find((candidate) =>
        body.model.startsWith("openai/") && candidate.provider === "openai-compatible"
      );
    if (!model) {
      return c.json(openAIError(`Model '${body.model}' does not exist`, "model_not_found"), 404);
    }
    const runId = `${c.get("user").id}:responses:${
      c.req.header("idempotency-key") ?? crypto.randomUUID()
    }`;
    repo.reserve(
      c.get("user").id,
      runId,
      body.model,
      Math.max(1, Math.ceil(4096 * model.outputMicrosPerMillion / 1_000_000)),
    );
    const started = performance.now();
    let result;
    try {
      result = await complete(request, c.req.raw.signal);
      const cost = Math.max(
        1,
        Math.ceil(
          result.inputTokens * model.inputMicrosPerMillion / 1_000_000 +
            result.outputTokens * model.outputMicrosPerMillion / 1_000_000,
        ),
      );
      repo.settle(
        runId,
        cost,
        result.inputTokens,
        result.outputTokens,
        Math.round(performance.now() - started),
      );
    } catch (error) {
      repo.refund(runId);
      throw error;
    }
    return c.json({
      id: `resp_${crypto.randomUUID()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: body.model,
      output: [{
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: result.text, annotations: [] }],
      }],
      usage: {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        total_tokens: result.inputTokens + result.outputTokens,
      },
    });
  });
  app.post(
    "/v1/embeddings",
    (c) =>
      c.json({
        object: "list",
        data: [],
        model: "not-configured",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      }, 501),
  );
  app.post(
    "/v1/images/generations",
    (c) =>
      c.json(
        openAIError("Image generation provider is not configured", "provider_not_configured"),
        501,
      ),
  );
  app.post(
    "/v1/audio/transcriptions",
    (c) =>
      c.json(
        openAIError("Transcription provider is not configured", "provider_not_configured"),
        501,
      ),
  );
  app.post(
    "/v1/audio/translations",
    (c) =>
      c.json(openAIError("Translation provider is not configured", "provider_not_configured"), 501),
  );
  app.post(
    "/v1/audio/speech",
    (c) => c.json(openAIError("Speech provider is not configured", "provider_not_configured"), 501),
  );
  app.get("/v1/files", (c) => c.json({ object: "list", data: [] }));
  app.post(
    "/v1/files",
    (c) => c.json(openAIError("Object storage is not configured", "storage_not_configured"), 501),
  );

  app.onError((error, c) => {
    if (error instanceof DomainError) {
      if (c.req.path.startsWith("/v1/")) {
        return c.json(openAIError(error.message, error.code), error.status as 400);
      }
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    const correlationId = crypto.randomUUID();
    console.error(
      JSON.stringify({ level: "error", message: "Unhandled request error", correlationId }),
    );
    return c.json(openAIError(`Internal server error (${correlationId})`, "internal_error"), 500);
  });
  app.notFound((c) => c.json(openAIError("Route not found", "not_found"), 404));
  return { app, repository: repo };
}
