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
  identityTokenSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  registerSchema,
  responsesSchema,
  setActiveLeafSchema,
  updateConversationSchema,
} from "@dg-chat/contracts";
import type { ChatCompletionRequest, ModelInfo, PublicUser } from "@dg-chat/contracts";
import {
  type ApiIdempotencyEndpoint,
  type ApiIdempotencyRequest,
  type ApiReplayQuota,
  DomainError,
  type DomainRepository,
  MemoryRepository,
} from "@dg-chat/database";
import { hashPassword, randomToken, sha256, sha256Hex, verifyPassword } from "./crypto.ts";
import { complete, models, simulate, streamChatCompletion } from "./models.ts";
import { estimateInputTokens, priceUsage, reservationPrice } from "./pricing.ts";
import { responseMessage, responseObject } from "./responses.ts";
import { type IdentityMailer, smtpIdentityMailer } from "./mail.ts";
import {
  authorizationCredentialIdentity,
  MemoryRateLimiter,
  type RateLimiter,
  requestClientKey,
  requestTrustedClientKey,
} from "./rate-limit.ts";

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
  idempotencyHeartbeatMs?: number;
  idempotencyLeaseSeconds?: number;
  replayQuota?: ApiReplayQuota;
  trustProxyHeaders?: boolean;
  authClientRateLimit?: number;
  mailer?: IdentityMailer;
  requireEmailVerification?: boolean;
  generationHeartbeatMs?: number;
  generationLeaseSeconds?: number;
  webComplete?: typeof complete;
}

const openAIError = (message: string, code: string | null = null) => ({
  error: { message, type: "invalid_request_error", param: null, code },
});
const DUMMY_PASSWORD_HASH =
  "pbkdf2_sha256$210000$dg-chat-dummy-login-salt$18NUXRu_COEHJHYjLomFDBvS1D9vIlVzCYYqox7WSUw";
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  );
  return `{${entries.join(",")}}`;
};
const sseData = (data: string, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
const chunkUtf8 = (value: string, maxBytes = 16 * 1024, maxChunks = 512): string[] => {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length === 0) return [];
  if (bytes.length > maxBytes * maxChunks) {
    throw new DomainError("response_too_large", "Response exceeds replay storage limit", 413);
  }
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += maxBytes) {
    const end = Math.min(offset + maxBytes, bytes.length);
    const chunk = decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length });
    if (chunk) chunks.push(chunk);
  }
  return chunks;
};
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
  const idempotencyHeartbeatMs = Math.max(10, options.idempotencyHeartbeatMs ?? 30_000);
  const idempotencyLeaseSeconds = Math.max(1, options.idempotencyLeaseSeconds ?? 120);
  const generationHeartbeatMs = Math.max(10, options.generationHeartbeatMs ?? 30_000);
  const generationLeaseSeconds = Math.max(1, options.generationLeaseSeconds ?? 120);
  const webComplete = options.webComplete ?? complete;
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
  const mailer = options.mailer ?? (Deno.env.get("SMTP_URL")
    ? smtpIdentityMailer(
      Deno.env.get("SMTP_URL")!,
      Deno.env.get("SMTP_FROM") ?? "DG Chat <no-reply@localhost>",
    )
    : undefined);
  const requireEmailVerification = options.requireEmailVerification ??
    Deno.env.get("REQUIRE_EMAIL_VERIFICATION") === "true";
  const production = Deno.env.get("DENO_ENV") === "production";
  const sessionCookie = production ? "__Host-dg_session" : "dg_session";
  const positiveInteger = (name: string, fallback: number) => {
    const value = Number(Deno.env.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  };
  const configuredAuthLimit = positiveInteger("AUTH_RATE_LIMIT", 10);
  const configuredAuthClientLimit = options.authClientRateLimit ??
    positiveInteger("AUTH_CLIENT_RATE_LIMIT", 100);
  if (!Number.isSafeInteger(configuredAuthClientLimit) || configuredAuthClientLimit < 1) {
    throw new Error("AUTH_CLIENT_RATE_LIMIT must be a positive safe integer");
  }
  const configuredGenerationLimit = positiveInteger("GENERATION_RATE_LIMIT", 30);
  const configuredOpenAILimit = positiveInteger("OPENAI_RATE_LIMIT", 120);
  const configuredRateWindow = positiveInteger("RATE_LIMIT_WINDOW_SECONDS", 60);
  const replayQuota = options.replayQuota ?? {
    maxRequests: positiveInteger("REPLAY_MAX_REQUESTS_PER_USER", 256),
    maxBytes: positiveInteger("REPLAY_MAX_BYTES_PER_USER", 67_108_864),
    maxEvents: positiveInteger("REPLAY_MAX_EVENTS_PER_USER", 20_000),
  };
  const trustProxyHeaders = options.trustProxyHeaders ??
    Deno.env.get("TRUST_PROXY_HEADERS") === "true";
  const defaultOpenAIModel = models.find((model) => model.id === "openai/default")!;
  const configuredUpstreamModels = (Deno.env.get("OPENAI_ALLOWED_MODELS") ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model, index, values) => model.length > 0 && values.indexOf(model) === index)
    .map((model) => ({
      ...defaultOpenAIModel,
      id: `openai/${model}`,
      displayName: model,
    }));
  const modelCatalog = [
    ...models,
    ...configuredUpstreamModels.filter((candidate) =>
      !models.some((model) => model.id === candidate.id)
    ),
  ];
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
      path === "/api/auth/login" || path.startsWith("/api/auth/verify-email") ||
      path.startsWith("/api/auth/password-reset")
    );
    const generationRoute = c.req.method === "POST" &&
      (path.endsWith("/generate") || path === "/v1/chat/completions" ||
        path === "/v1/responses" || path.endsWith("/active-leaf"));
    const policy = authRoute
      ? { name: "auth", limit: configuredAuthLimit, window: configuredRateWindow }
      : generationRoute
      ? { name: "generation", limit: configuredGenerationLimit, window: configuredRateWindow }
      : path.startsWith("/v1/")
      ? { name: "openai", limit: configuredOpenAILimit, window: configuredRateWindow }
      : null;
    if (!policy) return next();
    let result;
    try {
      if (authRoute) {
        let accountIdentity = "unknown-account";
        try {
          const candidate = await c.req.raw.clone().json() as { email?: unknown };
          if (typeof candidate.email === "string") {
            const email = candidate.email.trim().toLowerCase();
            if (email.length >= 3 && email.length <= 320) {
              accountIdentity = `email:${await sha256(email)}`;
            }
          }
        } catch {
          // Malformed bodies share a small fallback bucket and are rejected by route parsing.
        }
        const results = [
          await rateLimiter.consume(
            `auth:account:${accountIdentity}`,
            configuredAuthLimit,
            configuredRateWindow,
          ),
        ];
        const trustedClient = requestTrustedClientKey(c.req.raw.headers, trustProxyHeaders);
        if (trustedClient) {
          results.push(
            await rateLimiter.consume(
              `auth:client:${trustedClient}`,
              configuredAuthClientLimit,
              configuredRateWindow,
            ),
          );
        } else {
          // Fetch does not expose a direct peer address. This installation-wide ceiling
          // prevents rotating-email PBKDF2 exhaustion until a trusted proxy is configured.
          results.push(
            await rateLimiter.consume(
              "auth:client:untrusted-deployment",
              configuredAuthClientLimit,
              configuredRateWindow,
            ),
          );
        }
        result = results.find((candidate) => !candidate.allowed) ?? results[0];
      } else {
        const authorizationIdentity = authorizationCredentialIdentity(
          c.req.header("authorization"),
        );
        const sessionIdentity = getCookie(c, sessionCookie) ??
          (production ? getCookie(c, "dg_session") : undefined);
        const credentialIdentity = authorizationIdentity ??
          (sessionIdentity ? `session:${sessionIdentity}` : undefined);
        const clientKey = credentialIdentity
          ? `credential:${await sha256(credentialIdentity)}`
          : requestClientKey(c.req.raw.headers, trustProxyHeaders);
        result = await rateLimiter.consume(
          `${policy.name}:${clientKey}`,
          policy.limit,
          policy.window,
        );
      }
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
        (requireEmailVerification && !user.emailVerifiedAt) ||
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
    if (requireEmailVerification && !c.get("user").emailVerifiedAt) {
      return c.json({
        error: {
          code: "email_verification_required",
          message: "Verify your email before continuing",
        },
      }, 403);
    }
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
      emailEnabled: Boolean(mailer),
      requireEmailVerification,
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
      await repo.recordAudit({
        actorId: user.id,
        action: "identity.bootstrap_admin",
        targetType: "user",
        targetId: user.id,
      });
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
      emailVerified: false,
    });
    await repo.recordAudit({ action: "identity.signup", targetType: "user", targetId: user.id });
    if (mailer) {
      const verificationToken = randomToken("verify_");
      await repo.createIdentityToken(
        user.id,
        "email_verification",
        await sha256(verificationToken),
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      );
      try {
        await mailer.send({
          to: user.email,
          kind: "email_verification",
          token: verificationToken,
          url: `${webOrigin}/verify-email?token=${encodeURIComponent(verificationToken)}`,
        });
        await repo.recordAudit({
          action: "identity.verification_sent",
          targetType: "user",
          targetId: user.id,
        });
      } catch {
        await repo.recordAudit({
          action: "identity.verification_delivery_failed",
          targetType: "user",
          targetId: user.id,
        });
      }
    }
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
  app.post("/api/auth/verify-email", async (c) => {
    const body = await parseJson(c, identityTokenSchema);
    const user = await repo.verifyEmail(await sha256(body.token));
    await repo.recordAudit({
      actorId: user.id,
      action: "identity.email_verified",
      targetType: "user",
      targetId: user.id,
    });
    return c.json({ user: publicUser(user) });
  });
  app.post("/api/auth/verify-email/request", authenticate, async (c) => {
    if (!mailer) {
      throw new DomainError("smtp_not_configured", "Email delivery is not configured", 503);
    }
    const user = c.get("user");
    if (user.emailVerifiedAt) return c.body(null, 204);
    const token = randomToken("verify_");
    await repo.createIdentityToken(
      user.id,
      "email_verification",
      await sha256(token),
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    await mailer.send({
      to: user.email,
      kind: "email_verification",
      token,
      url: `${webOrigin}/verify-email?token=${encodeURIComponent(token)}`,
    });
    await repo.recordAudit({
      actorId: user.id,
      action: "identity.verification_sent",
      targetType: "user",
      targetId: user.id,
    });
    return c.body(null, 202);
  });
  app.post("/api/auth/password-reset/request", async (c) => {
    const body = await parseJson(c, passwordResetRequestSchema);
    const user = await repo.findUserByEmail(body.email);
    if (user && mailer) {
      const token = randomToken("reset_");
      await repo.createIdentityToken(
        user.id,
        "password_reset",
        await sha256(token),
        new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      );
      try {
        await mailer.send({
          to: user.email,
          kind: "password_reset",
          token,
          url: `${webOrigin}/reset-password?token=${encodeURIComponent(token)}`,
        });
        await repo.recordAudit({
          action: "identity.password_reset_requested",
          targetType: "user",
          targetId: user.id,
        });
      } catch {
        await repo.recordAudit({
          action: "identity.password_reset_delivery_failed",
          targetType: "user",
          targetId: user.id,
        });
      }
    }
    return c.body(null, 202);
  });
  app.post("/api/auth/password-reset", async (c) => {
    const body = await parseJson(c, passwordResetSchema);
    const user = await repo.resetPassword(
      await sha256(body.token),
      await hashPassword(body.password),
    );
    await repo.recordAudit({
      actorId: user.id,
      action: "identity.password_reset_completed",
      targetType: "user",
      targetId: user.id,
    });
    return c.body(null, 204);
  });
  const signIn = async (c: Context) => {
    const body = await parseJson(c, loginSchema);
    const user = await repo.findUserByEmail(body.email);
    const passwordValid = await verifyPassword(
      body.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !passwordValid) {
      await repo.recordAudit({
        action: "identity.login_failed",
        targetType: "user",
        targetId: user?.id ?? null,
      });
      throw new DomainError("invalid_credentials", "Email or password is incorrect", 401);
    }
    if (user.state !== "active") {
      throw new DomainError("account_unavailable", "This account is unavailable", 403);
    }
    if (user.approvalStatus === "rejected") {
      throw new DomainError("account_rejected", "This account was not approved", 403);
    }
    const limited = user.approvalStatus !== "approved" ||
      (requireEmailVerification && !user.emailVerifiedAt);
    const token = randomToken("sess_");
    await repo.createSession(user.id, await sha256(token), limited);
    await repo.recordAudit({
      actorId: user.id,
      action: "identity.login_succeeded",
      targetType: "user",
      targetId: user.id,
    });
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
    if (currentToken) {
      const hash = await sha256(currentToken);
      const session = await repo.getSession(hash);
      await repo.deleteSession(hash);
      if (session) {
        await repo.recordAudit({
          actorId: session.userId,
          action: "session.signed_out",
          targetType: "session",
          targetId: session.id,
        });
      }
    }
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
  app.get(
    "/api/sessions",
    authenticate,
    sessionOnly,
    async (c) => c.json({ data: await repo.listSessions(c.get("user").id) }),
  );
  app.delete("/api/sessions/:id", authenticate, sessionOnly, async (c) => {
    await repo.revokeSession(c.req.param("id"), c.get("user").id);
    await repo.recordAudit({
      actorId: c.get("user").id,
      action: "session.revoked",
      targetType: "session",
      targetId: c.req.param("id"),
    });
    return c.body(null, 204);
  });

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
    const model = modelCatalog.find((candidate) => candidate.id === body.model);
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
      leaseSeconds: generationLeaseSeconds,
    });
    if (begun.kind === "completed") {
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
    if (begun.kind === "in_progress") {
      throw new DomainError(
        "generation_in_progress",
        "This generation is already in progress",
        409,
      );
    }
    let heartbeatError: unknown;
    let heartbeatInFlight = Promise.resolve();
    const heartbeat = () => {
      heartbeatInFlight = heartbeatInFlight.then(async () => {
        if (heartbeatError) return;
        try {
          await repo.heartbeatGeneration(
            runId,
            ownerId,
            begun.leaseToken,
            generationLeaseSeconds,
          );
        } catch (error) {
          heartbeatError = error;
        }
      });
      return heartbeatInFlight;
    };
    const heartbeatTimer = setInterval(() => void heartbeat(), generationHeartbeatMs);
    const checkpoint = async () => {
      await heartbeat();
      if (heartbeatError) throw heartbeatError;
    };
    const started = performance.now();
    let providerCompleted = false;
    try {
      const result = await webComplete({
        model: body.model,
        messages: history,
        max_tokens: maxWebOutput,
      }, c.req.raw.signal);
      providerCompleted = true;
      await checkpoint();
      const cost = priceUsage(model, result.inputTokens, result.outputTokens).costMicros;
      const completed = await repo.completeGeneration({
        conversationId,
        ownerId,
        userMessageId: begun.message.id,
        runId,
        leaseToken: begun.leaseToken,
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
          leaseToken: begun.leaseToken,
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
    } finally {
      clearInterval(heartbeatTimer);
      await heartbeatInFlight;
    }
  });
  app.post("/api/conversations/:id/active-leaf", async (c) => {
    const body = await parseJson(c, setActiveLeafSchema);
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
    const body = await parseJson(c, updateConversationSchema);
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
    await repo.recordAudit({
      actorId: c.get("user").id,
      action: "api_token.created",
      targetType: "api_token",
      targetId: record.id,
    });
    return c.json({ token: secret, ...summary }, 201);
  });
  app.delete("/api/tokens/:id", async (c) => {
    await repo.revokeApiToken(c.req.param("id"), c.get("user").id);
    await repo.recordAudit({
      actorId: c.get("user").id,
      action: "api_token.revoked",
      targetType: "api_token",
      targetId: c.req.param("id"),
    });
    return c.body(null, 204);
  });
  app.get(
    "/api/usage",
    authenticate,
    approved,
    sessionOnly,
    async (c) => c.json(await repo.usage(c.get("user").id)),
  );
  app.get(
    "/api/models",
    authenticate,
    approved,
    sessionOnly,
    (c) => c.json({ data: modelCatalog }),
  );

  app.use("/api/admin/*", authenticate, approved, sessionOnly, admin);
  app.get(
    "/api/admin/users",
    async (c) => c.json({ data: await repo.listUsers() }),
  );
  app.patch("/api/admin/users/:id/approval", async (c) => {
    const body = await parseJson(c, approvalSchema);
    const updated = await repo.approveUser(
      c.req.param("id"),
      body.status,
      body.startingCreditMicros ?? startingCredit,
      requireEmailVerification,
    );
    await repo.recordAudit({
      actorId: c.get("user").id,
      action: `user.approval.${body.status}`,
      targetType: "user",
      targetId: updated.id,
    });
    return c.json(publicUser(updated));
  });
  app.patch("/api/admin/users/:id/state", async (c) => {
    const body = await c.req.json<{ state: "active" | "suspended" | "deleted" }>();
    if (!["active", "suspended", "deleted"].includes(body.state)) {
      throw new DomainError("validation_error", "Invalid state", 422);
    }
    const updated = await repo.setUserState(c.req.param("id"), body.state);
    await repo.recordAudit({
      actorId: c.get("user").id,
      action: `user.state.${body.state}`,
      targetType: "user",
      targetId: updated.id,
    });
    return c.json(publicUser(updated));
  });
  app.delete("/api/admin/sessions/:id", async (c) => {
    await repo.revokeSession(c.req.param("id"));
    await repo.recordAudit({
      actorId: c.get("user").id,
      action: "session.admin_revoked",
      targetType: "session",
      targetId: c.req.param("id"),
    });
    return c.body(null, 204);
  });
  app.get(
    "/api/admin/audit",
    async (c) => {
      const rawLimit = c.req.query("limit");
      const limit = rawLimit === undefined ? 100 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new DomainError("validation_error", "limit must be an integer from 1 to 200", 422);
      }
      return c.json({ data: await repo.listAudit(limit) });
    },
  );
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
  const replayResponse = (request: ApiIdempotencyRequest) => {
    // A streaming request can fail before the first event is exposed. In that case the
    // original response is the stored JSON error, not an empty event stream.
    const replayAsStream = request.stream &&
      (request.state === "completed" || request.failureStartedStream);
    const headers = new Headers(request.responseHeaders);
    headers.set("X-Idempotent-Replay", "true");
    if (replayAsStream && !headers.has("Content-Type")) {
      headers.set("Content-Type", "text/event-stream");
    } else if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return new Response(
      replayAsStream ? request.frames.map((frame) => frame.frame).join("") : request.responseBody,
      { status: request.responseStatus ?? 500, headers },
    );
  };
  const keepApiLeaseAlive = (idempotency?: { id: string; leaseToken: string }) => {
    let stopped = false;
    let heartbeatError: unknown;
    let inFlight = Promise.resolve();
    const pulse = (observation?: {
      inputTokens: number;
      outputTokens: number;
      costMicros: number;
      latencyMs: number;
    }) => {
      if (!idempotency) return Promise.resolve();
      inFlight = inFlight.then(async () => {
        if (stopped || heartbeatError) return;
        try {
          await repo.heartbeatApiRequest(
            idempotency.id,
            idempotency.leaseToken,
            idempotencyLeaseSeconds,
            observation,
          );
        } catch (error) {
          heartbeatError = error;
        }
      });
      return inFlight;
    };
    const timer = idempotency ? setInterval(() => void pulse(), idempotencyHeartbeatMs) : undefined;
    return {
      checkpoint: async (observation?: {
        inputTokens: number;
        outputTokens: number;
        costMicros: number;
        latencyMs: number;
      }) => {
        await pulse(observation);
        if (heartbeatError) throw heartbeatError;
      },
      stop: async () => {
        if (timer !== undefined) clearInterval(timer);
        await inFlight;
        stopped = true;
      },
    };
  };
  const beginOpenAIUsage = async (
    c: Context<{ Variables: Variables }>,
    endpoint: ApiIdempotencyEndpoint,
    request: unknown,
    model: ModelInfo,
    reserveMicros: number,
  ) => {
    const idempotencyKey = c.req.header("idempotency-key");
    const runId = `${c.get("user").id}:${endpoint}:${crypto.randomUUID()}`;
    if (!idempotencyKey) {
      await repo.reserve(
        c.get("user").id,
        runId,
        model.id,
        reserveMicros,
        model.provider,
        c.get("tokenId"),
      );
      return { kind: "started" as const, runId };
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new DomainError(
        "invalid_idempotency_key",
        "Idempotency-Key must contain between 8 and 200 characters",
        400,
      );
    }
    const requestHash = await sha256Hex(canonicalJson({ endpoint, request }));
    const result = await repo.beginApiRequest({
      userId: c.get("user").id,
      endpoint,
      idempotencyKey,
      requestHash,
      stream: Boolean((request as { stream?: boolean }).stream),
      model: model.id,
      runId,
      reserveMicros,
      provider: model.provider,
      tokenId: c.get("tokenId"),
      leaseSeconds: idempotencyLeaseSeconds,
      quota: replayQuota,
    });
    if (result.kind === "in_progress") {
      return {
        kind: "replay" as const,
        response: new Response(
          JSON.stringify(
            openAIError("An identical request is still in progress", "idempotency_in_progress"),
          ),
          {
            status: 409,
            headers: {
              "content-type": "application/json",
              "retry-after": String(result.retryAfterSeconds),
            },
          },
        ),
      };
    }
    if (result.kind === "started") {
      return {
        kind: "started" as const,
        runId,
        idempotency: { id: result.request.id, leaseToken: result.leaseToken },
      };
    }
    return { kind: "replay" as const, response: replayResponse(result.request) };
  };
  app.get(
    "/v1/models",
    requireScope("models:read"),
    (c) =>
      c.json({
        object: "list",
        data: modelCatalog.map((m) => ({
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
    const model = modelCatalog.find((candidate) => candidate.id === request.model);
    if (!model) {
      return c.json(openAIError(`Model '${request.model}' does not exist`, "model_not_found"), 404);
    }
    const maxOutput = request.max_tokens ?? request.max_completion_tokens ?? 4096;
    const reserveMicros = reservationPrice(model, request, maxOutput).costMicros;
    const usage = await beginOpenAIUsage(c, "chat.completions", request, model, reserveMicros);
    if (usage.kind === "replay") return usage.response;
    const { runId, idempotency } = usage;
    const lease = keepApiLeaseAlive(idempotency);
    const started = performance.now();
    if (request.stream && request.model.startsWith("simulated/")) {
      const text = simulate(request);
      const words = text.split(/(?<=\s)/);
      const id = `chatcmpl-${crypto.randomUUID()}`;
      return streamSSE(c, async (stream) => {
        let deliveredText = "";
        let settled = false;
        let sequence = 0;
        try {
          for (const word of words) {
            if (stream.aborted || c.req.raw.signal.aborted) {
              throw new DOMException("Client disconnected", "AbortError");
            }
            const data = JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
            });
            const frame = sseData(data);
            if (idempotency) {
              const observedText = deliveredText + word;
              const observedOutput = Math.ceil(observedText.length / 4);
              const observedInput = estimateInputTokens(request);
              await repo.appendApiSseFrame(
                idempotency.id,
                idempotency.leaseToken,
                sequence++,
                frame,
                undefined,
                {
                  inputTokens: observedInput,
                  outputTokens: observedOutput,
                  costMicros: priceUsage(model, observedInput, observedOutput).costMicros,
                  latencyMs: Math.round(performance.now() - started),
                },
                replayQuota,
              );
            }
            deliveredText += word;
            await stream.writeSSE({ data });
            await Promise.race([
              stream.sleep(18),
              new Promise<void>((resolve) =>
                c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true })
              ),
            ]);
          }
          const input = estimateInputTokens(request);
          const output = Math.ceil(deliveredText.length / 4);
          const cost = priceUsage(model, input, output).costMicros;
          // Accounting is durable before the success marker is visible. A client disconnect
          // after receiving content therefore cannot turn delivered output into a full refund.
          const finishData = JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          });
          if (idempotency) {
            await repo.appendApiSseFrame(
              idempotency.id,
              idempotency.leaseToken,
              sequence++,
              sseData(finishData),
              undefined,
              undefined,
              replayQuota,
            );
            await repo.completeApiStream({
              id: idempotency.id,
              leaseToken: idempotency.leaseToken,
              responseStatus: 200,
              responseHeaders: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
              },
              terminalFrame: sseData("[DONE]"),
              costMicros: cost,
              inputTokens: input,
              outputTokens: output,
              latencyMs: Math.round(performance.now() - started),
              quota: replayQuota,
            });
          } else {
            await repo.settle(
              runId,
              cost,
              input,
              output,
              Math.round(performance.now() - started),
            );
          }
          settled = true;
          if (stream.aborted || c.req.raw.signal.aborted) return;
          await stream.writeSSE({ data: finishData });
          await stream.writeSSE({ data: "[DONE]" });
        } catch {
          if (!settled) {
            const input = estimateInputTokens(request);
            const output = Math.ceil(deliveredText.length / 4);
            const latencyMs = Math.round(performance.now() - started);
            if (idempotency) {
              await repo.failApiRequest({
                id: idempotency.id,
                leaseToken: idempotency.leaseToken,
                responseStatus: 200,
                responseHeaders: {
                  "content-type": "text/event-stream",
                  "cache-control": "no-cache",
                },
                responseBody: JSON.stringify(openAIError("Generation interrupted", "stream_error")),
                terminalFrame: sseData(
                  JSON.stringify(openAIError("Generation interrupted", "stream_error")),
                ),
                billing: output > 0
                  ? {
                    mode: "settle",
                    costMicros: priceUsage(model, input, output).costMicros,
                    inputTokens: input,
                    outputTokens: output,
                    latencyMs,
                  }
                  : { mode: "refund" },
              });
            } else if (output > 0) {
              await repo.settle(
                runId,
                priceUsage(model, input, output).costMicros,
                input,
                output,
                latencyMs,
              );
            } else await repo.refund(runId);
          }
          if (stream.aborted || c.req.raw.signal.aborted) return;
          await stream.writeSSE({
            data: JSON.stringify(openAIError("Generation interrupted", "stream_error")),
          });
        } finally {
          await lease.stop();
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
        let toolOutput = "";
        let inputTokens = estimateInputTokens(request);
        let outputTokens = 0;
        let settled = false;
        let sequence = 0;
        try {
          for await (const data of providerStream(request, upstreamSignal)) {
            if (data === "[DONE]") {
              const finalOutput = outputTokens ||
                Math.ceil((deliveredText + toolOutput).length / 4);
              const cost = priceUsage(model, inputTokens, finalOutput).costMicros;
              if (idempotency) {
                await repo.completeApiStream({
                  id: idempotency.id,
                  leaseToken: idempotency.leaseToken,
                  responseStatus: 200,
                  responseHeaders: {
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                  },
                  terminalFrame: sseData("[DONE]"),
                  costMicros: cost,
                  inputTokens,
                  outputTokens: finalOutput,
                  latencyMs: Math.round(performance.now() - started),
                  quota: replayQuota,
                });
              } else {
                await repo.settle(
                  runId,
                  cost,
                  inputTokens,
                  finalOutput,
                  Math.round(performance.now() - started),
                );
              }
              settled = true;
              if (!stream.aborted && !upstreamSignal.aborted) {
                await stream.writeSSE({ data: "[DONE]" });
              }
              return;
            }
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string; tool_calls?: unknown } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
              error?: { message?: string };
            };
            if (chunk.error) throw new Error(chunk.error.message ?? "Provider stream failed");
            inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
            const chunkText = chunk.choices?.map((choice) =>
              choice.delta?.content ?? ""
            ).join("") ?? "";
            const chunkTools = chunk.choices?.map((choice) => choice.delta?.tool_calls)
              .filter((value) => value !== undefined)
              .map((value) => JSON.stringify(value)).join("") ?? "";
            if (stream.aborted || upstreamSignal.aborted) {
              throw upstreamSignal.reason ?? new DOMException("Client disconnected", "AbortError");
            }
            if (idempotency) {
              const observedOutput = outputTokens || Math.ceil(
                (deliveredText + chunkText + toolOutput + chunkTools).length / 4,
              );
              await repo.appendApiSseFrame(
                idempotency.id,
                idempotency.leaseToken,
                sequence++,
                sseData(data),
                undefined,
                {
                  inputTokens,
                  outputTokens: observedOutput,
                  costMicros: priceUsage(model, inputTokens, observedOutput).costMicros,
                  latencyMs: Math.round(performance.now() - started),
                },
                replayQuota,
              );
            }
            deliveredText += chunkText;
            toolOutput += chunkTools;
            await stream.writeSSE({ data });
            if (stream.aborted || upstreamSignal.aborted) {
              throw upstreamSignal.reason ?? new DOMException("Client disconnected", "AbortError");
            }
          }
          if (!settled && !idempotency) {
            const finalOutput = outputTokens ||
              Math.ceil((deliveredText + toolOutput).length / 4);
            if (finalOutput > 0) {
              await repo.settle(
                runId,
                priceUsage(model, inputTokens, finalOutput).costMicros,
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
        } catch {
          if (!settled && idempotency) {
            const finalOutput = outputTokens ||
              Math.ceil((deliveredText + toolOutput).length / 4);
            const latencyMs = Math.round(performance.now() - started);
            await repo.failApiRequest({
              id: idempotency.id,
              leaseToken: idempotency.leaseToken,
              responseStatus: 200,
              responseHeaders: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
              },
              responseBody: JSON.stringify(openAIError("Provider stream failed", "provider_error")),
              terminalFrame: sseData(
                JSON.stringify(openAIError("Provider stream failed", "provider_error")),
              ),
              billing: finalOutput > 0
                ? {
                  mode: "settle",
                  costMicros: priceUsage(model, inputTokens, finalOutput).costMicros,
                  inputTokens,
                  outputTokens: finalOutput,
                  latencyMs,
                }
                : { mode: "refund" },
            });
          } else if (!settled && deliveredText.length > 0) {
            const finalOutput = outputTokens ||
              Math.ceil((deliveredText + toolOutput).length / 4);
            await repo.settle(
              runId,
              priceUsage(model, inputTokens, finalOutput).costMicros,
              inputTokens,
              finalOutput,
              Math.round(performance.now() - started),
            );
          } else if (!settled) {
            await repo.refund(runId);
          }
          if (upstreamSignal.aborted) return;
          await stream.writeSSE({
            data: JSON.stringify(openAIError("Provider stream failed", "provider_error")),
          });
        } finally {
          await lease.stop();
        }
      });
    }
    let providerCompleted = false;
    try {
      const result = await complete(request, c.req.raw.signal);
      providerCompleted = true;
      const cost = priceUsage(model, result.inputTokens, result.outputTokens).costMicros;
      await lease.checkpoint({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: cost,
        latencyMs: Math.round(performance.now() - started),
      });
      const payload = result.upstream ?? {
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
      };
      const responseBody = JSON.stringify(payload);
      if (idempotency) {
        try {
          await repo.completeApiJson({
            id: idempotency.id,
            leaseToken: idempotency.leaseToken,
            responseStatus: 200,
            responseHeaders: { "content-type": "application/json" },
            responseBody,
            costMicros: cost,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs: Math.round(performance.now() - started),
            quota: replayQuota,
          });
        } catch (persistenceError) {
          const status = persistenceError instanceof DomainError ? persistenceError.status : 500;
          await repo.failApiRequest({
            id: idempotency.id,
            leaseToken: idempotency.leaseToken,
            responseStatus: status,
            responseHeaders: { "content-type": "application/json" },
            responseBody: JSON.stringify(
              openAIError("Response replay persistence failed", "replay_persistence_error"),
            ),
            billing: {
              mode: "settle",
              costMicros: cost,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              latencyMs: Math.round(performance.now() - started),
            },
          });
          throw persistenceError;
        }
      } else {
        await repo.settle(
          runId,
          cost,
          result.inputTokens,
          result.outputTokens,
          Math.round(performance.now() - started),
        );
      }
      return new Response(responseBody, { headers: { "content-type": "application/json" } });
    } catch (error) {
      if (!providerCompleted && idempotency) {
        const body = JSON.stringify(openAIError("Provider request failed", "provider_error"));
        await repo.failApiRequest({
          id: idempotency.id,
          leaseToken: idempotency.leaseToken,
          responseStatus: 502,
          responseHeaders: { "content-type": "application/json" },
          responseBody: body,
          billing: { mode: "refund" },
        });
        return new Response(body, { status: 502, headers: { "content-type": "application/json" } });
      }
      if (!providerCompleted) await repo.refund(runId);
      throw error;
    } finally {
      await lease.stop();
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
    const model = modelCatalog.find((candidate) => candidate.id === body.model);
    if (!model) {
      return c.json(openAIError(`Model '${body.model}' does not exist`, "model_not_found"), 404);
    }
    const maxResponseOutput = body.max_output_tokens ?? 4096;
    // Responses replay repeats the final text in several terminal events. Reject requests whose
    // declared output ceiling cannot fit before spending provider credits.
    if (maxResponseOutput * 16 * 5 + 1_048_576 > 16_777_216) {
      throw new DomainError("response_too_large", "Requested output exceeds replay storage", 413);
    }
    const responseReservation = reservationPrice(
      model,
      { ...request, max_tokens: maxResponseOutput },
      maxResponseOutput,
    ).costMicros;
    const usage = await beginOpenAIUsage(c, "responses", body, model, responseReservation);
    if (usage.kind === "replay") return usage.response;
    const { runId, idempotency } = usage;
    const lease = keepApiLeaseAlive(idempotency);
    const started = performance.now();
    let result;
    let providerCompleted = false;
    try {
      result = await complete({ ...request, max_tokens: maxResponseOutput }, c.req.raw.signal);
      providerCompleted = true;
    } catch (error) {
      if (!providerCompleted && idempotency) {
        const failureBody = JSON.stringify(
          openAIError("Provider request failed", "provider_error"),
        );
        await repo.failApiRequest({
          id: idempotency.id,
          leaseToken: idempotency.leaseToken,
          responseStatus: 502,
          responseHeaders: { "content-type": "application/json" },
          responseBody: failureBody,
          billing: { mode: "refund" },
        });
        await lease.stop();
        return new Response(failureBody, {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      if (!providerCompleted) await repo.refund(runId);
      await lease.stop();
      throw error;
    }
    try {
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
      const responseCost = priceUsage(model, result.inputTokens, result.outputTokens).costMicros;
      const latencyMs = Math.round(performance.now() - started);
      await lease.checkpoint({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: responseCost,
        latencyMs,
      });
      // Usage is now durably observed, so a later response-persistence failure cannot
      // turn completed upstream work into a refund.
      const terminalizePersistenceFailure = async (error: unknown) => {
        if (!idempotency) throw error;
        const status = error instanceof DomainError ? error.status : 500;
        const failure = new DomainError(
          "replay_persistence_error",
          "Response replay persistence failed",
          status,
        );
        const failureBody = JSON.stringify(openAIError(failure.message, failure.code));
        await repo.failApiRequest({
          id: idempotency.id,
          leaseToken: idempotency.leaseToken,
          responseStatus: status,
          responseHeaders: { "content-type": "application/json" },
          responseBody: failureBody,
          billing: {
            mode: "settle",
            costMicros: responseCost,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs,
          },
        });
        throw failure;
      };
      if (!body.stream) {
        const responseBody = JSON.stringify(completedResponse);
        if (idempotency) {
          try {
            await repo.completeApiJson({
              id: idempotency.id,
              leaseToken: idempotency.leaseToken,
              responseStatus: 200,
              responseHeaders: { "content-type": "application/json" },
              responseBody,
              costMicros: responseCost,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              latencyMs,
              quota: replayQuota,
            });
          } catch (error) {
            await terminalizePersistenceFailure(error);
          }
        } else {
          await repo.settle(
            runId,
            responseCost,
            result.inputTokens,
            result.outputTokens,
            latencyMs,
          );
        }
        return new Response(responseBody, { headers: { "content-type": "application/json" } });
      }

      const pendingResponse = responseObject({
        id: responseId,
        messageId,
        model: body.model,
        createdAt,
        status: "in_progress",
      });
      let eventSequence = 0;
      const eventFrame = (event: Record<string, unknown>) => {
        const payload: Record<string, unknown> = { ...event, sequence_number: ++eventSequence };
        return sseData(JSON.stringify(payload), String(payload.type));
      };
      const responseFrames = [
        eventFrame({ type: "response.created", response: pendingResponse }),
        eventFrame({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...responseMessage(messageId, "", "in_progress"), content: [] },
        }),
        eventFrame({
          type: "response.content_part.added",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
        ...chunkUtf8(result.text).map((delta) =>
          eventFrame({
            type: "response.output_text.delta",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta,
            logprobs: [],
          })
        ),
        eventFrame({
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: result.text,
          logprobs: [],
        }),
        eventFrame({
          type: "response.content_part.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: result.text, annotations: [] },
        }),
        eventFrame({
          type: "response.output_item.done",
          output_index: 0,
          item: responseMessage(messageId, result.text),
        }),
        eventFrame({ type: "response.completed", response: completedResponse }),
      ];
      if (idempotency) {
        try {
          await repo.completeApiStream({
            id: idempotency.id,
            leaseToken: idempotency.leaseToken,
            responseStatus: 200,
            responseHeaders: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
            frames: responseFrames.slice(0, -1).map((frame, sequence) => ({ sequence, frame })),
            terminalFrame: responseFrames.at(-1),
            costMicros: responseCost,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs,
            quota: replayQuota,
          });
        } catch (error) {
          await terminalizePersistenceFailure(error);
        }
      } else {
        await repo.settle(
          runId,
          responseCost,
          result.inputTokens,
          result.outputTokens,
          latencyMs,
        );
      }
      return streamSSE(c, async (stream) => {
        for (const frame of responseFrames) {
          if (stream.aborted || c.req.raw.signal.aborted) return;
          await stream.write(frame);
        }
      });
    } finally {
      await lease.stop();
    }
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
