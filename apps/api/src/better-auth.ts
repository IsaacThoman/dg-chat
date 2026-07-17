import { betterAuth } from "npm:better-auth@1.6.23/minimal";
import { APIError } from "npm:better-auth@1.6.23/api";
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzleAdapter } from "npm:better-auth@1.6.23/adapters/drizzle";
import { drizzle } from "npm:drizzle-orm@0.45.2/postgres-js";
import postgres from "npm:postgres@3.4.7";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  DomainError,
  type DomainRepository,
} from "@dg-chat/database";
import { hashPassword, sha256, verifyPassword } from "./crypto.ts";
import { type OidcConfig, oidcPlugin } from "./oidc.ts";
import {
  boundedIdentityDelivery,
  DEFAULT_IDENTITY_DELIVERY_TIMEOUT_MS,
  drainIdentityDeliverySet,
  IdentityDeliveryTimeoutError,
} from "./identity-delivery.ts";

export interface BetterAuthServiceOptions {
  databaseUrl: string;
  repository: DomainRepository;
  secret: string;
  appUrl: string;
  webOrigin: string;
  oidc?: Omit<OidcConfig, "appUrl" | "webOrigin">;
  requireEmailVerification?: boolean;
  identityDeliveryTimeoutMs?: number;
  /** Test/embedding seam. Authentication library details are never forwarded to this sink. */
  authLogSink?: (line: string) => void;
  sendVerificationEmail?: (input: {
    email: string;
    url: string;
    token: string;
  }, signal?: AbortSignal) => Promise<void>;
  sendPasswordResetEmail?: (input: {
    email: string;
    url: string;
    token: string;
  }, signal?: AbortSignal) => Promise<void>;
}

export function createSanitizedBetterAuthLogger(
  sink: (line: string) => void = (line) => console.error(line),
) {
  return {
    disableColors: true,
    level: "warn" as const,
    log(level: "debug" | "info" | "warn" | "error", _message: string, ..._details: unknown[]) {
      // Better Auth includes callback parameters and adapter exceptions in its detail arguments.
      // Preserve severity and component identity only; the HTTP request lifecycle is logged
      // separately without forwarding these attacker-controlled details.
      const safeLevel = level === "error" ? "error" : "warn";
      try {
        sink(JSON.stringify({
          level: safeLevel,
          component: "better_auth",
          message: "Authentication subsystem event",
        }));
      } catch {
        // Observability must not alter authentication behavior.
      }
    },
  };
}

export function createSanitizedBetterAuthLogging(
  sink?: (line: string) => void,
) {
  const logger = createSanitizedBetterAuthLogger(sink);
  return {
    logger,
    onAPIError: {
      // Better Auth otherwise sends APIError messages through its package-global logger for warn
      // and error levels, bypassing the configured logger. Supplying this callback takes over that
      // path before the library fallback can print callback or adapter details.
      onError: (error: unknown) => {
        logger.log("error", "Authentication API error");
        // better-call logs any non-API error after a void callback returns, including adapter
        // query parameters that can contain reset tokens. Re-throw a sanitized typed error so
        // the router renders it without forwarding the original exception to global stderr.
        if (!(error instanceof APIError) || error.statusCode >= 500) {
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Authentication request failed",
          });
        }
      },
    },
  };
}

type AuthOperationalLogEntry = {
  level: "error" | "warn";
  message: string;
  action?: string;
};

export function createSanitizedAuthOperationalEmitter(
  sink: (line: string) => void = (line) => console.error(line),
) {
  return (entry: AuthOperationalLogEntry): void => {
    try {
      sink(JSON.stringify(entry));
    } catch {
      // A broken output stream or embedding sink must not change authentication control flow.
    }
  };
}

export async function recordAuthAuditWithSanitizedFailure(
  record: () => Promise<unknown> | unknown,
  emit: (entry: AuthOperationalLogEntry) => void,
  failure: AuthOperationalLogEntry,
): Promise<void> {
  try {
    await record();
  } catch {
    emit(failure);
  }
}

export interface BetterAuthBrowserSession {
  /** Durable auth_sessions identifier for current-session security decisions. */
  id: string;
  userId: string;
  limited: boolean;
  authorityEpoch: number;
  /** Time the user proved their identity, not the session's rolling refresh time. */
  authenticatedAt: string;
}

type AuthRequestObservation = {
  kind: "sign_in" | "password_reset";
  userId: string;
  authorityEpoch: number;
  eligible: boolean;
};

type AuthRequestContext = {
  observation?: AuthRequestObservation;
  authenticatedUserId?: string;
};

type AuthenticationAuthority = {
  approvalStatus: "pending" | "approved" | "rejected";
  state: "active" | "suspended";
  deletedAt: string | null;
  passwordResetPending?: boolean;
};

export function canIssueFreshAuthentication(
  user: AuthenticationAuthority,
): boolean {
  return user.approvalStatus !== "rejected" && user.state === "active" &&
    user.deletedAt === null && user.passwordResetPending !== true;
}

export function matchesPasswordResetObservation(
  observation: AuthRequestObservation | undefined,
  userId: string,
): observation is AuthRequestObservation & { kind: "password_reset"; eligible: true } {
  return observation?.kind === "password_reset" && observation.eligible &&
    observation.userId === userId;
}

/**
 * Better Auth owns credentials, external accounts, and browser-session tokens. The domain
 * repository remains the live authorization authority; callers must load the domain user for
 * every request and fail closed when it is absent or unavailable.
 */
export function createBetterAuthService(options: BetterAuthServiceOptions) {
  if (options.requireEmailVerification && !options.sendVerificationEmail) {
    throw new Error("Email verification requires a delivery callback");
  }
  const authOperationalLog = createSanitizedAuthOperationalEmitter(options.authLogSink);
  const authLogging = createSanitizedBetterAuthLogging(options.authLogSink);
  const sql = postgres(options.databaseUrl, { max: 10 });
  const closeFailedPool = () => void sql.end({ timeout: 0 }).catch(() => undefined);
  const constructDatabase = () =>
    drizzle(sql, {
      schema: { authUsers, authSessions, authAccounts, authVerifications },
    });
  let database: ReturnType<typeof constructDatabase>;
  try {
    database = constructDatabase();
  } catch (error) {
    closeFailedPool();
    throw error;
  }
  const normalizeEmail = (email: string) => email.trim().toLowerCase();
  // Better Auth performs credential work before its database hooks. Capture domain authority at
  // the request boundary so sign-in and password-reset issuance cannot cross an authority loss.
  const authRequestContext = new AsyncLocalStorage<AuthRequestContext>();
  const provisionDomainUser = async (authUser: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
  }) => {
    const byId = await options.repository.findUser(authUser.id);
    if (byId) {
      if (normalizeEmail(byId.email) !== normalizeEmail(authUser.email)) {
        throw new Error("Authentication and domain identity mappings disagree");
      }
      if (authUser.emailVerified && !byId.emailVerifiedAt) {
        await options.repository.markUserEmailVerified(byId.id);
      }
      return byId;
    }
    const byEmail = await options.repository.findUserByEmail(authUser.email);
    if (byEmail) throw new Error("An authentication identity already uses this email");
    try {
      return await options.repository.createUser({
        id: authUser.id,
        email: authUser.email,
        name: authUser.name,
        passwordHash: null,
        emailVerified: authUser.emailVerified,
        approvalStatus: "pending",
        state: "active",
        role: "user",
      });
    } catch (error) {
      // A concurrent hook/session reconciliation may have won the insert race. Accept only the
      // exact same identity mapping; never resolve an email or UUID collision implicitly.
      const winner = await options.repository.findUser(authUser.id);
      if (winner && normalizeEmail(winner.email) === normalizeEmail(authUser.email)) return winner;
      throw error;
    }
  };
  const loadAuthUser = async (id: string) => {
    const rows = await sql<
      { id: string; email: string; name: string; email_verified: boolean }[]
    >`SELECT id,email,name,email_verified FROM auth_users WHERE id=${id}`;
    return rows[0]
      ? {
        id: String(rows[0].id),
        email: String(rows[0].email),
        name: String(rows[0].name),
        emailVerified: Boolean(rows[0].email_verified),
      }
      : undefined;
  };
  const presentedSessionToken = (headers: Headers): string | undefined => {
    const cookie = headers.get("cookie");
    if (!cookie) return undefined;
    for (const segment of cookie.split(";")) {
      const separator = segment.indexOf("=");
      if (separator < 1) continue;
      const name = segment.slice(0, separator).trim();
      if (name !== "dg_chat.session_token" && name !== "__Secure-dg_chat.session_token") continue;
      const value = segment.slice(separator + 1).trim();
      if (value) return value;
    }
    return undefined;
  };
  const identityDeliveryTimeoutMs = options.identityDeliveryTimeoutMs ??
    DEFAULT_IDENTITY_DELIVERY_TIMEOUT_MS;
  const pendingIdentityDeliveries = new Map<Promise<void>, AbortController>();
  const recordDeliveryAudit = async (
    userId: string,
    actorId: string | null,
    action: string,
  ) => {
    await recordAuthAuditWithSanitizedFailure(
      () =>
        options.repository.recordAudit({
          actorId,
          action,
          targetType: "user",
          targetId: userId,
        }),
      authOperationalLog,
      {
        level: "error",
        message: "Identity delivery audit persistence failed",
        action,
      },
    );
  };
  const recordAuthenticationOutcome = async (
    path: string,
    method: string,
    response: Response | undefined,
    context: AuthRequestContext,
    signOutSession: { session: { id: string }; user: { id: string } } | null,
  ): Promise<void> => {
    if (method !== "POST" && !path.endsWith("/oidc/callback")) return;
    const ordinarySuccess = Boolean(response?.ok);
    const oidcSuccess = path.endsWith("/oidc/callback") && response?.status === 302 &&
      response.headers.get("location") === `${options.webOrigin}/pending`;
    let event:
      | {
        actorId: string | null;
        action: string;
        targetType: "user" | "session";
        targetId: string | null;
      }
      | undefined;
    if (path.endsWith("/sign-up/email")) {
      const success = ordinarySuccess && Boolean(context.authenticatedUserId);
      event = {
        actorId: success ? context.authenticatedUserId! : null,
        action: success ? "identity.signup" : "identity.signup_failed",
        targetType: "user",
        targetId: context.authenticatedUserId ?? null,
      };
    } else if (path.endsWith("/sign-in/email")) {
      const success = ordinarySuccess && Boolean(context.authenticatedUserId);
      event = {
        actorId: success ? context.authenticatedUserId! : null,
        action: success ? "identity.login_succeeded" : "identity.login_failed",
        targetType: "user",
        targetId: context.authenticatedUserId ?? context.observation?.userId ?? null,
      };
    } else if (path.endsWith("/oidc/callback")) {
      event = {
        actorId: oidcSuccess ? context.authenticatedUserId ?? null : null,
        action: oidcSuccess ? "identity.oidc_login_succeeded" : "identity.oidc_login_failed",
        targetType: "user",
        targetId: context.authenticatedUserId ?? null,
      };
    } else if (path.endsWith("/sign-out") && signOutSession) {
      event = {
        actorId: signOutSession.user.id,
        action: ordinarySuccess ? "session.signed_out" : "session.sign_out_failed",
        targetType: "session",
        targetId: signOutSession.session.id,
      };
    }
    if (!event) return;
    await recordAuthAuditWithSanitizedFailure(
      () => options.repository.recordAudit(event!),
      authOperationalLog,
      {
        level: "error",
        message: "Authentication outcome audit persistence failed",
        action: event.action,
      },
    );
  };
  const dispatchIdentityEmail = (
    userId: string,
    actorId: string | null,
    delivery: (signal: AbortSignal) => Promise<void>,
    sentAction: string,
    failedAction: string,
  ) => {
    // SMTP latency and failure must never reveal whether a public reset address exists or leave
    // a newly-created identity half-created. Delivery remains observable through immutable audit
    // events while the accepted authentication request completes independently.
    const controller = new AbortController();
    const pending = boundedIdentityDelivery(delivery, controller, identityDeliveryTimeoutMs)
      .then(
        () => recordDeliveryAudit(userId, actorId, sentAction),
        (error) =>
          recordDeliveryAudit(
            userId,
            actorId,
            error instanceof IdentityDeliveryTimeoutError
              ? failedAction.replace(/_failed$/, "_outcome_unknown")
              : failedAction,
          ),
      );
    pendingIdentityDeliveries.set(pending, controller);
    void pending.finally(() => pendingIdentityDeliveries.delete(pending));
  };
  const drainIdentityDeliveries = (abortAfterMs?: number) =>
    drainIdentityDeliverySet(pendingIdentityDeliveries, abortAfterMs);

  const constructAuth = () =>
    betterAuth({
      appName: "DG Chat",
      baseURL: options.appUrl,
      basePath: "/api/auth",
      secret: options.secret,
      trustedOrigins: [options.webOrigin],
      ...authLogging,
      database: drizzleAdapter(database, {
        provider: "pg",
        schema: {
          user: authUsers,
          session: authSessions,
          account: authAccounts,
          verification: authVerifications,
        },
      }),
      advanced: {
        database: { generateId: "uuid" },
        cookiePrefix: "dg_chat",
      },
      account: {
        encryptOAuthTokens: true,
        storeStateStrategy: "database",
        accountLinking: { enabled: false, disableImplicitLinking: true },
      },
      plugins: options.oidc
        ? [oidcPlugin({
          ...options.oidc,
          appUrl: options.appUrl,
          webOrigin: options.webOrigin,
          pruneExpiredState: async () => {
            await sql`DELETE FROM auth_verifications WHERE expires_at<=now()`;
          },
        })]
        : [],
      session: {
        additionalFields: {
          limited: {
            type: "boolean",
            required: true,
            defaultValue: true,
            input: false,
          },
          authorityEpoch: {
            type: "number",
            required: true,
            defaultValue: 1,
            input: false,
          },
        },
      },
      verification: {
        additionalFields: {
          authorityEpoch: {
            type: "number",
            required: false,
            input: false,
          },
        },
      },
      emailAndPassword: {
        enabled: true,
        // Keep a narrow status session for unverified applicants. Domain authorization and the
        // limited session field enforce verification until the one-time link is completed.
        requireEmailVerification: false,
        revokeSessionsOnPasswordReset: true,
        password: {
          hash: hashPassword,
          verify: ({ hash, password }) => verifyPassword(password, hash),
        },
        sendResetPassword: options.sendPasswordResetEmail
          ? async ({ user, url, token }) => {
            const domainUser = await options.repository.findUser(user.id);
            if (
              !domainUser || !canIssueFreshAuthentication(domainUser)
            ) return;
            dispatchIdentityEmail(
              user.id,
              null,
              (signal) =>
                options.sendPasswordResetEmail!({ email: user.email, url, token }, signal),
              "identity.password_reset_requested",
              "identity.password_reset_delivery_failed",
            );
          }
          : undefined,
      },
      emailVerification: options.sendVerificationEmail
        ? {
          expiresIn: 24 * 60 * 60,
          sendOnSignUp: options.requireEmailVerification ?? false,
          sendVerificationEmail: async ({ user, url, token }) => {
            const domainUser = await provisionDomainUser(user);
            await options.repository.createIdentityToken(
              domainUser.id,
              "email_verification",
              await sha256(token),
              new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              domainUser.authorityEpoch,
            );
            dispatchIdentityEmail(
              user.id,
              null,
              (signal) => options.sendVerificationEmail!({ email: user.email, url, token }, signal),
              "identity.verification_sent",
              "identity.verification_delivery_failed",
            );
          },
        }
        : undefined,
      databaseHooks: {
        verification: {
          create: {
            before: async (verification) => {
              if (!verification.identifier.startsWith("reset-password:")) {
                return { data: { ...verification, authorityEpoch: null } };
              }
              const observation = authRequestContext.getStore()?.observation;
              if (!matchesPasswordResetObservation(observation, verification.value)) {
                // Better Auth does not consistently treat a false hook result as a failed write.
                // Throw so no reset link can be delivered without a fenced durable record.
                throw new Error("Password reset authority observation is unavailable");
              }
              // Reject an authority loss that completed after request admission before reaching the
              // adapter. The database trigger repeats this predicate under a user-row lock to fence
              // the final read/insert race.
              const current = await options.repository.findUser(verification.value);
              if (
                !current || current.authorityEpoch !== observation.authorityEpoch ||
                current.state !== "active" || current.deletedAt !== null ||
                current.passwordResetPending === true
              ) {
                throw new Error("Password reset authority observation is stale");
              }
              return {
                data: { ...verification, authorityEpoch: observation.authorityEpoch },
              };
            },
          },
        },
        user: {
          create: {
            after: async (authUser) => {
              await provisionDomainUser(authUser);
            },
          },
          update: {
            after: async (authUser) => {
              if (authUser.emailVerified) {
                await options.repository.markUserEmailVerified(authUser.id);
                // The status-only session remains limited by its immutable session field. Keeping
                // it alive lets the pending screen observe verification without silently granting
                // workspace access; a fresh sign-in is still required for a full session.
              }
            },
          },
        },
        session: {
          create: {
            before: async (session, context) => {
              let domainUser = await options.repository.findUser(session.userId);
              // Better Auth queues user.create.after until its adapter transaction commits. A new
              // signup can therefore reach session creation just before domain provisioning runs;
              // keep that session limited and let request authorization fail closed until the
              // matching domain row exists.
              const authUser = await loadAuthUser(session.userId);
              if (authUser) domainUser = await provisionDomainUser(authUser);
              const requestContext = authRequestContext.getStore();
              const requestObservation = requestContext?.observation;
              const passwordObservation = requestObservation?.kind === "sign_in"
                ? requestObservation
                : undefined;
              const existingSessionEpoch = context?.context?.session?.session &&
                  "authorityEpoch" in context.context.session.session
                ? Number(context.context.session.session.authorityEpoch)
                : undefined;
              const freshPasswordEpoch = passwordObservation?.userId === session.userId
                ? passwordObservation.authorityEpoch
                : undefined;
              if (passwordObservation?.userId === session.userId && !passwordObservation.eligible) {
                return false;
              }
              const freshOidcAuthentication = context?.path === "/oidc/callback";
              const authorityEpoch = freshPasswordEpoch ??
                (freshOidcAuthentication ? domainUser?.authorityEpoch : existingSessionEpoch) ??
                domainUser?.authorityEpoch ?? 1;
              if (!domainUser) {
                return { data: { ...session, limited: true, authorityEpoch: 1 } };
              }
              if (
                domainUser.state !== "active" || domainUser.deletedAt !== null ||
                domainUser.passwordResetPending === true ||
                domainUser.approvalStatus === "rejected"
              ) {
                return false;
              }
              if (requestContext) requestContext.authenticatedUserId = domainUser.id;
              const limited = domainUser.approvalStatus !== "approved" ||
                ((options.requireEmailVerification ?? false) && !domainUser.emailVerifiedAt);
              return { data: { ...session, limited, authorityEpoch } };
            },
          },
        },
      },
    });
  let auth: ReturnType<typeof constructAuth>;
  try {
    auth = constructAuth();
  } catch (error) {
    // This synchronous factory has no instance to return on construction failure. Begin closing
    // its newly allocated pool immediately; postgres.js has not yet admitted request traffic.
    closeFailedPool();
    throw error;
  }

  return {
    auth,
    oidcEnabled: Boolean(options.oidc),
    handler: async (request: Request) => {
      let observation: AuthRequestObservation | undefined;
      const path = new URL(request.url).pathname;
      if (
        request.method === "POST" &&
        (path.endsWith("/sign-in/email") || path.endsWith("/request-password-reset"))
      ) {
        try {
          const body = await request.clone().json() as { email?: unknown };
          if (typeof body.email === "string") {
            const user = await options.repository.findUserByEmail(normalizeEmail(body.email));
            if (user) {
              observation = {
                kind: path.endsWith("/request-password-reset") ? "password_reset" : "sign_in",
                userId: user.id,
                authorityEpoch: user.authorityEpoch,
                eligible: canIssueFreshAuthentication(user),
              };
            }
          }
        } catch {
          // Better Auth owns request validation and its public error contract.
        }
      }
      let signOutSession:
        | { session: { id: string }; user: { id: string } }
        | null = null;
      if (request.method === "POST" && path.endsWith("/sign-out")) {
        try {
          signOutSession = await auth.api.getSession({ headers: request.headers });
        } catch {
          // The auth handler owns the public response. Missing or malformed credentials must not
          // leak through this best-effort audit subject lookup.
        }
      }
      const context: AuthRequestContext = { observation };
      return await authRequestContext.run(context, async () => {
        let response: Response;
        try {
          response = await auth.handler(request);
        } catch (error) {
          await recordAuthenticationOutcome(
            path,
            request.method,
            undefined,
            context,
            signOutSession,
          );
          throw error;
        }
        await recordAuthenticationOutcome(path, request.method, response, context, signOutSession);
        return response;
      });
    },
    presentedSessionToken,
    async getSession(headers: Headers): Promise<BetterAuthBrowserSession | null> {
      const result = await auth.api.getSession({ headers });
      if (!result) return null;
      const domainUser = await provisionDomainUser({
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        emailVerified: result.user.emailVerified,
      });
      if (
        !domainUser || domainUser.state !== "active" || domainUser.deletedAt !== null ||
        domainUser.passwordResetPending === true ||
        normalizeEmail(domainUser.email) !== normalizeEmail(result.user.email)
      ) return null;
      const authorityEpoch = Number(
        (result.session as typeof result.session & { authorityEpoch?: number }).authorityEpoch,
      );
      const physicallyLimited = Boolean(
        (result.session as typeof result.session & { limited?: boolean }).limited,
      );
      if (
        !Number.isSafeInteger(authorityEpoch) ||
        (!physicallyLimited && authorityEpoch !== domainUser.authorityEpoch)
      ) {
        return null;
      }
      const domainLimited = domainUser.approvalStatus !== "approved" ||
        ((options.requireEmailVerification ?? false) && !domainUser.emailVerifiedAt);
      const createdAt = (result.session as typeof result.session & {
        createdAt?: Date | string;
      }).createdAt;
      const authenticatedAt = createdAt instanceof Date
        ? createdAt
        : typeof createdAt === "string"
        ? new Date(createdAt)
        : undefined;
      // Recent-authentication gates must fail closed if the auth adapter cannot identify when
      // the session was minted. Never substitute updatedAt because rolling refresh is not proof.
      if (!authenticatedAt || !Number.isFinite(authenticatedAt.getTime())) return null;
      return {
        id: result.session.id,
        userId: result.user.id,
        limited: domainLimited || physicallyLimited,
        authorityEpoch,
        authenticatedAt: authenticatedAt.toISOString(),
      };
    },
    invalidateUserSessions: async (userId: string) => {
      await sql`DELETE FROM auth_sessions WHERE user_id=${userId}`;
    },
    listUserSessions: async (userId: string, headers?: Headers) => {
      // Better Auth signs its browser cookie, while auth_sessions.token stores the unsigned
      // value. Resolve the authenticated session through Better Auth instead of comparing the
      // wire cookie directly to the durable token.
      const currentSession = headers ? await auth.api.getSession({ headers }) : null;
      const currentSessionId = currentSession?.session.id;
      const rows = await sql<
        Array<{
          id: string;
          user_id: string;
          limited: boolean;
          expires_at: Date | string;
          created_at: Date | string;
        }>
      >`
        SELECT id,user_id,limited,expires_at,created_at
        FROM auth_sessions WHERE user_id=${userId}
        ORDER BY created_at DESC,id DESC
      `;
      return rows.map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        current: Boolean(currentSessionId && String(row.id) === currentSessionId),
        limited: Boolean(row.limited),
        expiresAt: new Date(row.expires_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString(),
        invalidatedAt: null,
      }));
    },
    revokeUserSession: async (userId: string, sessionId: string) => {
      const deleted = await sql`
        DELETE FROM auth_sessions WHERE id=${sessionId} AND user_id=${userId} RETURNING id
      `;
      if (!deleted.length) throw new DomainError("not_found", "Session not found", 404);
    },
    drainIdentityDeliveries,
    close: async () => {
      await drainIdentityDeliveries();
      await sql.end({ timeout: 5 });
    },
  };
}

export type BetterAuthService = ReturnType<typeof createBetterAuthService>;
