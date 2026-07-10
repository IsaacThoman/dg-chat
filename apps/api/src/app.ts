import { Hono } from "npm:hono@4.12.28";
import { cors } from "npm:hono@4.12.28/cors";
import { bodyLimit } from "npm:hono@4.12.28/body-limit";
import { deleteCookie, getCookie, setCookie } from "npm:hono@4.12.28/cookie";
import { logger } from "npm:hono@4.12.28/logger";
import { secureHeaders } from "npm:hono@4.12.28/secure-headers";
import { streamSSE } from "npm:hono@4.12.28/streaming";
import type { Context, MiddlewareHandler } from "npm:hono@4.12.28";
import {
  appendMessageSchema,
  approvalSchema,
  chatCompletionSchema,
  createConversationSchema,
  createTokenSchema,
  generateMessageSchema,
  loginSchema,
  registerSchema,
  responsesSchema,
} from "@dg-chat/contracts";
import type { ChatCompletionRequest, PublicUser } from "@dg-chat/contracts";
import { DomainError, type DomainRepository, MemoryRepository } from "@dg-chat/database";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto.ts";
import { complete, models, simulate, streamChatCompletion } from "./models.ts";
import { estimateInputTokens, priceUsage, reservationPrice } from "./pricing.ts";
import { responseMessage, responseObject } from "./responses.ts";
import { MemoryRateLimiter, type RateLimiter, requestClientKey } from "./rate-limit.ts";

type Variables = {
  user: PublicUser;
  authType: "session" | "token";
  tokenId?: string;
  tokenScopes?: string[];
};
export interface AppOptions {
  repository?: DomainRepository;
  setupToken?: string;
  startingCreditMicros?: number;
  rateLimiter?: RateLimiter;
  providerStream?: typeof streamChatCompletion;
}

const openAIError = (message: string, code: string | null = null) => ({
  error: { message, type: "invalid_request_error", param: null, code },
});
const sameOrigin = (candidate: string, allowed: string): boolean => {
  try {
    return new URL(candidate).origin === allowed;
  } catch {
    return false;
  }
};
const publicUser = (user: Awaited<ReturnType<DomainRepository["findUser"]>>) => {
  if (!user) return undefined;
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
};
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
  const rateLimiter = options.rateLimiter ?? new MemoryRateLimiter();
  const providerStream = options.providerStream ?? streamChatCompletion;
  const setupToken = options.setupToken ?? Deno.env.get("SETUP_TOKEN") ?? "";
  const configuredStartingCredit = Deno.env.get("STARTING_CREDIT_MICROS");
  const configuredStartingUsd = Deno.env.get("DEFAULT_APPROVAL_CREDIT_USD");
  const startingCredit = options.startingCreditMicros ??
    (configuredStartingCredit
      ? Number(configuredStartingCredit)
      : configuredStartingUsd
      ? Math.round(Number(configuredStartingUsd) * 1_000_000)
      : 5_000_000);
  if (!Number.isSafeInteger(startingCredit) || startingCredit < 0) {
    throw new Error("Starting credit configuration must be a non-negative number of USD micros");
  }
  const webOrigin = new URL(
    Deno.env.get("WEB_ORIGIN") ?? Deno.env.get("WEB_URL") ?? "http://localhost:5173",
  ).origin;
  const production = Deno.env.get("DENO_ENV") === "production";
  const sessionCookie = production ? "__Host-dg_session" : "dg_session";
  const configuredAuthLimit = Number(Deno.env.get("AUTH_RATE_LIMIT") ?? "10");
  if (!Number.isSafeInteger(configuredAuthLimit) || configuredAuthLimit < 1) {
    throw new Error("AUTH_RATE_LIMIT must be a positive safe integer");
  }
  let bootstrapInProgress = false;
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", logger());
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
      },
    }),
  );
  app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("/v1/*", bodyLimit({ maxSize: 4 * 1024 * 1024 }));
  app.use(
    "*",
    cors({
      origin: webOrigin,
      credentials: true,
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    }),
  );
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const path = c.req.path;
    const authRoute = c.req.method === "POST" && (
      path === "/api/setup/bootstrap" || path === "/api/auth/sign-up/email" ||
      path === "/api/auth/register" || path === "/api/auth/sign-in/email" ||
      path === "/api/auth/login"
    );
    const generationRoute = c.req.method === "POST" &&
      (path.endsWith("/generate") || path === "/v1/chat/completions" ||
        path === "/v1/responses");
    const policy = authRoute
      ? { name: "auth", limit: configuredAuthLimit, window: 60 }
      : generationRoute
      ? { name: "generation", limit: 30, window: 60 }
      : path.startsWith("/v1/")
      ? { name: "openai", limit: 120, window: 60 }
      : null;
    if (!policy) return next();
    let result;
    try {
      const credential = authRoute
        ? undefined
        : c.req.header("authorization") ?? getCookie(c, sessionCookie) ??
          (production ? getCookie(c, "dg_session") : undefined);
      const clientKey = credential
        ? `credential:${await sha256(credential)}`
        : requestClientKey(c.req.raw.headers);
      result = await rateLimiter.consume(
        `${policy.name}:${clientKey}`,
        policy.limit,
        policy.window,
      );
    } catch {
      c.header("Retry-After", "5");
      return path.startsWith("/v1/")
        ? c.json(openAIError("Rate limiter is temporarily unavailable", "service_unavailable"), 503)
        : c.json({
          error: {
            code: "service_unavailable",
            message: "Request protection is temporarily unavailable",
          },
        }, 503);
    }
    c.header("X-RateLimit-Limit", String(result.limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfterSeconds));
      return path.startsWith("/v1/")
        ? c.json(openAIError("Rate limit exceeded", "rate_limit_exceeded"), 429)
        : c.json({ error: { code: "rate_limit_exceeded", message: "Too many requests" } }, 429);
    }
    await next();
  });
  app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const cookieAuthenticated = getCookie(c, sessionCookie) !== undefined ||
        (production && getCookie(c, "dg_session") !== undefined);
      if ((cookieAuthenticated && !origin) || (origin && !sameOrigin(origin, webOrigin))) {
        return c.json({
          error: { code: "invalid_origin", message: "Request origin is not allowed" },
        }, 403);
      }
    }
    await next();
  });

  const authenticate: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const legacySession = production ? getCookie(c, "dg_session") : undefined;
    const raw = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      getCookie(c, sessionCookie) ?? legacySession;
    if (!raw) return c.json(openAIError("Authentication required", "unauthorized"), 401);
    const hash = await sha256(raw);
    const apiToken = await repo.findApiTokenByHash(hash);
    if (apiToken) {
      const user = await repo.findUser(apiToken.userId);
      if (
        !user || user.state !== "active" || user.approvalStatus !== "approved" ||
        apiToken.revokedAt || (apiToken.expiresAt && Date.parse(apiToken.expiresAt) <= Date.now())
      ) return c.json(openAIError("Invalid or expired token", "unauthorized"), 401);
      c.set("user", publicUser(user)!);
      c.set("authType", "token");
      c.set("tokenId", apiToken.id);
      c.set("tokenScopes", apiToken.scopes);
      return next();
    }
    const session = await repo.getSession(hash);
    const user = session ? await repo.findUser(session.userId) : undefined;
    if (!session || !user || user.state !== "active") {
      return c.json(openAIError("Invalid or expired session", "unauthorized"), 401);
    }
    c.set("user", publicUser(user)!);
    c.set("authType", "session");
    if (legacySession && raw === legacySession) {
      setCookie(c, sessionCookie, legacySession, {
        httpOnly: true,
        sameSite: "Lax",
        secure: production,
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });
      deleteCookie(c, "dg_session", { path: "/" });
    }
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
  app.get("/ready", async (c) => {
    const [storage, redis] = await Promise.all([repo.readiness(), rateLimiter.health()]);
    const ready = storage.ready && redis;
    const body = { status: ready ? "ready" : "not_ready", storage, redis };
    return ready ? c.json(body, 200) : c.json(body, 503);
  });
  app.get("/api/setup/status", async (c) => {
    const users = await repo.listUsers();
    return c.json({
      bootstrapRequired: !users.some((user) => user.role === "admin"),
      setupEnabled: Boolean(setupToken),
      // Do not advertise SSO until the callback/session exchange is mounted end-to-end.
      oidcEnabled: false,
    });
  });

  app.post("/api/setup/bootstrap", async (c) => {
    if (!setupToken) throw new DomainError("setup_disabled", "SETUP_TOKEN is not configured", 503);
    if (bootstrapInProgress) {
      throw new DomainError("already_bootstrapped", "An administrator already exists", 409);
    }
    if (c.req.header("x-setup-token") !== setupToken) {
      throw new DomainError("invalid_setup_token", "Invalid setup token", 401);
    }
    bootstrapInProgress = true;
    try {
      const body = await parseJson(c, registerSchema);
      const user = await repo.bootstrapAdmin({
        ...body,
        passwordHash: await hashPassword(body.password),
      }, startingCredit);
      return c.json({ user: publicUser(user) }, 201);
    } catch (error) {
      bootstrapInProgress = false;
      throw error;
    }
  });

  const signUp = async (c: Context) => {
    const body = await parseJson(c, registerSchema);
    const user = await repo.createUser({
      ...body,
      passwordHash: await hashPassword(body.password),
    });
    const token = randomToken("sess_");
    await repo.createSession(user.id, await sha256(token), true);
    setCookie(c, sessionCookie, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: production,
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.json({ user: publicUser(user), limited: true }, 201);
  };
  app.post("/api/auth/sign-up/email", signUp);
  app.post("/api/auth/register", signUp);
  const signIn = async (c: Context) => {
    const body = await parseJson(c, loginSchema);
    const user = await repo.findUserByEmail(body.email);
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
    await repo.createSession(user.id, await sha256(token), limited);
    setCookie(c, sessionCookie, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: production,
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.json({ user: publicUser(user), limited });
  };
  app.post("/api/auth/sign-in/email", signIn);
  app.post("/api/auth/login", signIn);
  app.post("/api/auth/sign-out", async (c) => {
    const currentToken = getCookie(c, sessionCookie);
    const legacyToken = production ? getCookie(c, "dg_session") : undefined;
    if (currentToken) await repo.deleteSession(await sha256(currentToken));
    if (legacyToken && legacyToken !== currentToken) {
      await repo.deleteSession(await sha256(legacyToken));
    }
    deleteCookie(c, sessionCookie, { path: "/", secure: production });
    if (production) deleteCookie(c, "dg_session", { path: "/" });
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
    async (c) =>
      c.json({
        data: await repo.listConversations(
          c.get("user").id,
          c.req.query("deleted") === "true",
        ),
      }),
  );
  app.post("/api/conversations", async (c) => {
    const body = await parseJson(c, createConversationSchema);
    return c.json(
      await repo.createConversation(
        c.get("user").id,
        body.title,
        body.temporary,
        c.req.header("idempotency-key"),
      ),
      201,
    );
  });
  app.get(
    "/api/conversations/:id",
    async (c) => c.json(await repo.detail(c.req.param("id"), c.get("user").id)),
  );
  app.post("/api/conversations/:id/messages", async (c) => {
    const body = await parseJson(c, appendMessageSchema);
    return c.json(
      await repo.appendMessage({
        ...body,
        conversationId: c.req.param("id"),
        ownerId: c.get("user").id,
      }),
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
    const before = await repo.detail(conversationId, ownerId);
    const byId = new Map(before.messages.map((message) => [message.id, message]));
    const history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [];
    let cursor = body.parentId ? byId.get(body.parentId) : undefined;
    while (cursor) {
      history.unshift({ role: cursor.role, content: cursor.content });
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    history.push({ role: "user", content: body.content });
    const runId = `${ownerId}:web-generation:${body.idempotencyKey}`;
    const maxWebOutput = Math.max(1, model.contextWindow - estimateInputTokens(history));
    const webReservation = reservationPrice(model, history, maxWebOutput).costMicros;
    const begun = await repo.beginGeneration({
      message: {
        conversationId,
        ownerId,
        parentId: body.parentId,
        supersedesId: body.supersedesId,
        role: "user",
        content: body.content,
        model: body.model,
        expectedVersion: body.expectedVersion,
        idempotencyKey: `${body.idempotencyKey}:user`,
      },
      runId,
      provider: model.provider,
      reserveMicros: webReservation,
    });
    if (begun.replayed && begun.usageRun.status === "completed") {
      const detail = await repo.detail(conversationId, ownerId);
      const assistant = detail.messages.find((message) =>
        message.parentId === begun.message.id && message.metadata.runId === runId
      );
      if (!assistant) {
        throw new DomainError(
          "generation_replay_incomplete",
          "Generation result is unavailable",
          409,
        );
      }
      return c.json({ user: begun.message, assistant, conversation: detail }, 200);
    }
    if (
      begun.replayed && Date.now() - Date.parse(begun.usageRun.createdAt) < 3 * 60 * 1000
    ) {
      throw new DomainError(
        "generation_in_progress",
        "This generation is already in progress",
        409,
      );
    }
    const started = performance.now();
    let providerCompleted = false;
    try {
      const result = await complete({
        model: body.model,
        messages: history,
        max_tokens: maxWebOutput,
      }, c.req.raw.signal);
      providerCompleted = true;
      const cost = Math.min(
        priceUsage(model, result.inputTokens, result.outputTokens).costMicros,
        webReservation,
      );
      const completed = await repo.completeGeneration({
        conversationId,
        ownerId,
        userMessageId: begun.message.id,
        runId,
        idempotencyKey: `${body.idempotencyKey}:assistant`,
        content: result.text,
        model: body.model,
        costMicros: cost,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Math.round(performance.now() - started),
        metadata: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: Math.round(performance.now() - started),
          runId,
        },
      });
      return c.json({
        user: begun.message,
        assistant: completed.message,
        conversation: completed.conversation,
      }, 201);
    } catch (error) {
      if (!providerCompleted) {
        await repo.failGeneration({
          conversationId,
          ownerId,
          userMessageId: begun.message.id,
          runId,
          idempotencyKey: `${body.idempotencyKey}:error`,
          model: body.model,
          error: "Generation failed. Retry with a new operation.",
        });
      }
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "provider_error",
        "The model provider could not complete the request",
        502,
      );
    }
  });
  app.post("/api/conversations/:id/active-leaf", async (c) => {
    const body = await c.req.json<{ leafId: string; expectedVersion: number }>();
    return c.json(
      await repo.setActiveLeaf(
        c.req.param("id"),
        c.get("user").id,
        body.leafId,
        body.expectedVersion,
      ),
    );
  });
  app.patch("/api/conversations/:id", async (c) => {
    const body = await c.req.json<
      { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean }
    >();
    return c.json(
      await repo.updateConversation(c.get("user").id, c.req.param("id"), body),
    );
  });

  app.use("/api/tokens/*", authenticate, approved, sessionOnly);
  app.use("/api/tokens", authenticate, approved, sessionOnly);
  app.get(
    "/api/tokens",
    async (c) => c.json({ data: await repo.listApiTokens(c.get("user").id) }),
  );
  app.post("/api/tokens", async (c) => {
    const body = await parseJson(c, createTokenSchema);
    const secret = randomToken("dg_");
    const record = await repo.createApiToken(c.get("user").id, {
      ...body,
      tokenHash: await sha256(secret),
      preview: `${secret.slice(0, 7)}…${secret.slice(-4)}`,
    });
    const { tokenHash: _h, userId: _u, ...summary } = record;
    return c.json({ token: secret, ...summary }, 201);
  });
  app.delete("/api/tokens/:id", async (c) => {
    await repo.revokeApiToken(c.req.param("id"), c.get("user").id);
    return c.body(null, 204);
  });
  app.get(
    "/api/usage",
    authenticate,
    approved,
    sessionOnly,
    async (c) => c.json(await repo.usage(c.get("user").id)),
  );
  app.get("/api/models", authenticate, approved, sessionOnly, (c) => c.json({ data: models }));

  app.use("/api/admin/*", authenticate, approved, sessionOnly, admin);
  app.get(
    "/api/admin/users",
    async (c) => c.json({ data: await repo.listUsers() }),
  );
  app.patch("/api/admin/users/:id/approval", async (c) => {
    const body = await parseJson(c, approvalSchema);
    return c.json(
      publicUser(
        await repo.approveUser(
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
    return c.json(publicUser(await repo.setUserState(c.req.param("id"), body.state)));
  });
  app.get(
    "/api/admin/usage",
    async (c) => c.json(await repo.adminSummary()),
  );
  app.get("/api/admin/jobs", async (c) => c.json({ data: await repo.listJobs() }));
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
    const maxOutput = request.max_tokens ?? request.max_completion_tokens ?? 4096;
    const reserveMicros = reservationPrice(model, request.messages, maxOutput).costMicros;
    await repo.reserve(
      c.get("user").id,
      runId,
      request.model,
      reserveMicros,
      model.provider,
      c.get("tokenId"),
    );
    const started = performance.now();
    if (request.stream && request.model.startsWith("simulated/")) {
      const text = simulate(request);
      const words = text.split(/(?<=\s)/);
      const id = `chatcmpl-${crypto.randomUUID()}`;
      return streamSSE(c, async (stream) => {
        let deliveredText = "";
        let settled = false;
        try {
          for (const word of words) {
            if (stream.aborted || c.req.raw.signal.aborted) break;
            await stream.writeSSE({
              data: JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: request.model,
                choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
              }),
            });
            deliveredText += word;
            await Promise.race([
              stream.sleep(18),
              new Promise<void>((resolve) =>
                c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true })
              ),
            ]);
          }
          const input = estimateInputTokens(request.messages);
          const output = Math.ceil(deliveredText.length / 4);
          const cost = Math.min(priceUsage(model, input, output).costMicros, reserveMicros);
          // Accounting is durable before the success marker is visible. A client disconnect
          // after receiving content therefore cannot turn delivered output into a full refund.
          await repo.settle(
            runId,
            cost,
            input,
            output,
            Math.round(performance.now() - started),
          );
          settled = true;
          if (stream.aborted || c.req.raw.signal.aborted) return;
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
        } catch (error) {
          if (!settled && deliveredText.length > 0) {
            const input = estimateInputTokens(request.messages);
            const output = Math.ceil(deliveredText.length / 4);
            await repo.settle(
              runId,
              Math.min(priceUsage(model, input, output).costMicros, reserveMicros),
              input,
              output,
              Math.round(performance.now() - started),
            );
          } else if (!settled) {
            await repo.refund(runId);
          }
          if (stream.aborted || c.req.raw.signal.aborted) return;
          throw error;
        }
      });
    }
    if (request.stream) {
      return streamSSE(c, async (stream) => {
        const downstreamAbort = new AbortController();
        stream.onAbort(() =>
          downstreamAbort.abort(new DOMException("Client disconnected", "AbortError"))
        );
        const upstreamSignal = AbortSignal.any([c.req.raw.signal, downstreamAbort.signal]);
        let deliveredText = "";
        let inputTokens = estimateInputTokens(request.messages);
        let outputTokens = 0;
        let settled = false;
        try {
          for await (const data of providerStream(request, upstreamSignal)) {
            if (data === "[DONE]") {
              const finalOutput = outputTokens || Math.ceil(deliveredText.length / 4);
              await repo.settle(
                runId,
                Math.min(priceUsage(model, inputTokens, finalOutput).costMicros, reserveMicros),
                inputTokens,
                finalOutput,
                Math.round(performance.now() - started),
              );
              settled = true;
              if (!stream.aborted && !upstreamSignal.aborted) {
                await stream.writeSSE({ data: "[DONE]" });
              }
              return;
            }
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
              error?: { message?: string };
            };
            if (chunk.error) throw new Error(chunk.error.message ?? "Provider stream failed");
            inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
            if (stream.aborted || upstreamSignal.aborted) break;
            await stream.writeSSE({ data });
            if (stream.aborted || upstreamSignal.aborted) break;
            deliveredText += chunk.choices?.map((choice) => choice.delta?.content ?? "").join("") ??
              "";
          }
          if (!settled) {
            const finalOutput = outputTokens || Math.ceil(deliveredText.length / 4);
            if (finalOutput > 0) {
              await repo.settle(
                runId,
                Math.min(priceUsage(model, inputTokens, finalOutput).costMicros, reserveMicros),
                inputTokens,
                finalOutput,
                Math.round(performance.now() - started),
              );
              settled = true;
            } else {
              await repo.refund(runId);
              settled = true;
            }
          }
        } catch (error) {
          if (!settled && deliveredText.length > 0) {
            const finalOutput = outputTokens || Math.ceil(deliveredText.length / 4);
            await repo.settle(
              runId,
              Math.min(priceUsage(model, inputTokens, finalOutput).costMicros, reserveMicros),
              inputTokens,
              finalOutput,
              Math.round(performance.now() - started),
            );
          } else if (!settled) {
            await repo.refund(runId);
          }
          if (upstreamSignal.aborted) return;
          throw error;
        }
      });
    }
    let providerCompleted = false;
    try {
      const result = await complete(request, c.req.raw.signal);
      providerCompleted = true;
      const cost = Math.min(
        priceUsage(model, result.inputTokens, result.outputTokens).costMicros,
        reserveMicros,
      );
      await repo.settle(
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
      if (!providerCompleted) await repo.refund(runId);
      throw error;
    }
  };
  app.post("/v1/chat/completions", requireScope("chat:write"), chatHandler);
  app.post("/v1/responses", requireScope("chat:write"), async (c) => {
    const body = await parseJson(c, responsesSchema);
    const messages = typeof body.input === "string"
      ? [{ role: "user" as const, content: body.input }]
      : body.input.map((m) => ({
        role: m.role,
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
    const maxResponseOutput = body.max_output_tokens ?? 4096;
    const responseReservation = reservationPrice(model, messages, maxResponseOutput).costMicros;
    await repo.reserve(
      c.get("user").id,
      runId,
      body.model,
      responseReservation,
      model.provider,
      c.get("tokenId"),
    );
    const started = performance.now();
    let result;
    let providerCompleted = false;
    try {
      result = await complete({ ...request, max_tokens: maxResponseOutput }, c.req.raw.signal);
      providerCompleted = true;
      const cost = Math.min(
        priceUsage(model, result.inputTokens, result.outputTokens).costMicros,
        responseReservation,
      );
      await repo.settle(
        runId,
        cost,
        result.inputTokens,
        result.outputTokens,
        Math.round(performance.now() - started),
      );
    } catch (error) {
      if (!providerCompleted) await repo.refund(runId);
      throw error;
    }
    const responseId = `resp_${crypto.randomUUID()}`;
    const messageId = `msg_${crypto.randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const completedResponse = responseObject({
      id: responseId,
      messageId,
      model: body.model,
      createdAt,
      status: "completed",
      text: result.text,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    });
    if (!body.stream) return c.json(completedResponse);

    const pendingResponse = responseObject({
      id: responseId,
      messageId,
      model: body.model,
      createdAt,
      status: "in_progress",
    });
    return streamSSE(c, async (stream) => {
      let sequence = 0;
      const emit = async (event: Record<string, unknown>) => {
        const payload: Record<string, unknown> = { ...event, sequence_number: ++sequence };
        await stream.writeSSE({
          event: String(payload.type),
          data: JSON.stringify(payload),
        });
      };
      await emit({ type: "response.created", response: pendingResponse });
      await emit({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...responseMessage(messageId, "", "in_progress"), content: [] },
      });
      await emit({
        type: "response.content_part.added",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      for (const delta of result.text.split(/(?<=\s)/)) {
        if (stream.aborted || c.req.raw.signal.aborted) return;
        await emit({
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
          logprobs: [],
        });
      }
      await emit({
        type: "response.output_text.done",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text: result.text,
        logprobs: [],
      });
      await emit({
        type: "response.content_part.done",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: result.text, annotations: [] },
      });
      await emit({
        type: "response.output_item.done",
        output_index: 0,
        item: responseMessage(messageId, result.text),
      });
      await emit({ type: "response.completed", response: completedResponse });
    });
  });
  app.post(
    "/v1/embeddings",
    requireScope("chat:write"),
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
    requireScope("chat:write"),
    (c) =>
      c.json(
        openAIError("Image generation provider is not configured", "provider_not_configured"),
        501,
      ),
  );
  app.post(
    "/v1/audio/transcriptions",
    requireScope("chat:write"),
    (c) =>
      c.json(
        openAIError("Transcription provider is not configured", "provider_not_configured"),
        501,
      ),
  );
  app.post(
    "/v1/audio/translations",
    requireScope("chat:write"),
    (c) =>
      c.json(openAIError("Translation provider is not configured", "provider_not_configured"), 501),
  );
  app.post(
    "/v1/audio/speech",
    requireScope("chat:write"),
    (c) => c.json(openAIError("Speech provider is not configured", "provider_not_configured"), 501),
  );
  app.get(
    "/v1/files",
    requireScope("files:read"),
    (c) => c.json({ object: "list", data: [] }),
  );
  app.post(
    "/v1/files",
    requireScope("files:write"),
    (c) => c.json(openAIError("Object storage is not configured", "storage_not_configured"), 501),
  );
  app.get(
    "/v1/files/:id",
    requireScope("files:read"),
    (c) => c.json(openAIError(`File '${c.req.param("id")}' was not found`, "not_found"), 404),
  );
  app.get(
    "/v1/files/:id/content",
    requireScope("files:read"),
    (c) => c.json(openAIError(`File '${c.req.param("id")}' was not found`, "not_found"), 404),
  );
  app.delete(
    "/v1/files/:id",
    requireScope("files:write"),
    (c) => c.json(openAIError(`File '${c.req.param("id")}' was not found`, "not_found"), 404),
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
