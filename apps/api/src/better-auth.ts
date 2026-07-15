import { betterAuth } from "npm:better-auth@1.6.23/minimal";
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

export interface BetterAuthBrowserSession {
  /** Durable auth_sessions identifier for current-session security decisions. */
  id: string;
  userId: string;
  limited: boolean;
  /** Time the user proved their identity, not the session's rolling refresh time. */
  authenticatedAt: string;
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
  const sql = postgres(options.databaseUrl, { max: 10 });
  const database = drizzle(sql, {
    schema: { authUsers, authSessions, authAccounts, authVerifications },
  });
  const normalizeEmail = (email: string) => email.trim().toLowerCase();
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
    try {
      await options.repository.recordAudit({
        actorId,
        action,
        targetType: "user",
        targetId: userId,
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        message: "Identity delivery audit persistence failed",
        userId,
        action,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
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

  const auth = betterAuth({
    appName: "DG Chat",
    baseURL: options.appUrl,
    basePath: "/api/auth",
    secret: options.secret,
    trustedOrigins: [options.webOrigin],
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
            !domainUser || domainUser.state !== "active" || domainUser.deletedAt !== null
          ) return;
          dispatchIdentityEmail(
            user.id,
            null,
            (signal) => options.sendPasswordResetEmail!({ email: user.email, url, token }, signal),
            "identity.password_reset_requested",
            "identity.password_reset_delivery_failed",
          );
        }
        : undefined,
      onPasswordReset: async ({ user }, request) => {
        const token = request?.headers.get("x-dg-password-reset-token");
        if (!token) throw new Error("Password reset guard token is missing");
        await options.repository.secureAfterPasswordReset(user.id, token);
        await Promise.resolve(options.repository.recordAudit({
          actorId: user.id,
          action: "identity.password_reset_completed",
          targetType: "user",
          targetId: user.id,
        })).catch((error) => {
          console.error(JSON.stringify({
            level: "error",
            message: "Password reset audit persistence failed",
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      },
    },
    emailVerification: options.sendVerificationEmail
      ? {
        sendOnSignUp: options.requireEmailVerification ?? false,
        sendVerificationEmail: async ({ user, url, token }) => {
          const domainUser = await provisionDomainUser(user);
          await options.repository.createIdentityToken(
            domainUser.id,
            "email_verification",
            await sha256(token),
            new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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
          before: async (session) => {
            let domainUser = await options.repository.findUser(session.userId);
            // Better Auth queues user.create.after until its adapter transaction commits. A new
            // signup can therefore reach session creation just before domain provisioning runs;
            // keep that session limited and let request authorization fail closed until the
            // matching domain row exists.
            const authUser = await loadAuthUser(session.userId);
            if (authUser) domainUser = await provisionDomainUser(authUser);
            if (!domainUser) return { data: { ...session, limited: true } };
            if (
              domainUser.state !== "active" || domainUser.deletedAt !== null ||
              domainUser.passwordResetPending === true
            ) {
              return false;
            }
            const limited = domainUser.approvalStatus !== "approved" ||
              ((options.requireEmailVerification ?? false) && !domainUser.emailVerifiedAt);
            return { data: { ...session, limited } };
          },
        },
      },
    },
  });

  return {
    auth,
    oidcEnabled: Boolean(options.oidc),
    handler: (request: Request) => auth.handler(request),
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
        limited: domainLimited ||
          Boolean((result.session as typeof result.session & { limited?: boolean }).limited),
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
    revokeSessionAsAdmin: async (sessionId: string) => {
      const deleted = await sql`DELETE FROM auth_sessions WHERE id=${sessionId} RETURNING id`;
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
