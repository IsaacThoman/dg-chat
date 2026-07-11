import { betterAuth } from "npm:better-auth@1.6.23/minimal";
import { drizzleAdapter } from "npm:better-auth@1.6.23/adapters/drizzle";
import { drizzle } from "npm:drizzle-orm@0.45.2/postgres-js";
import postgres from "npm:postgres@3.4.7";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  type DomainRepository,
} from "@dg-chat/database";
import { hashPassword, verifyPassword } from "./crypto.ts";

export interface BetterAuthServiceOptions {
  databaseUrl: string;
  repository: DomainRepository;
  secret: string;
  appUrl: string;
  webOrigin: string;
  requireEmailVerification?: boolean;
  sendVerificationEmail?: (input: {
    email: string;
    url: string;
    token: string;
  }) => Promise<void>;
}

export interface BetterAuthBrowserSession {
  userId: string;
  limited: boolean;
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
    },
    emailVerification: options.sendVerificationEmail
      ? {
        sendOnSignUp: options.requireEmailVerification ?? false,
        sendVerificationEmail: ({ user, url, token }) =>
          options.sendVerificationEmail!({ email: user.email, url, token }),
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
              // Verification changes the authorization inputs. Reauthentication deliberately
              // prevents an older limited session from silently gaining workspace privileges.
              await sql`DELETE FROM auth_sessions WHERE user_id=${authUser.id}`;
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
            if (domainUser.state !== "active") return false;
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
    handler: (request: Request) => auth.handler(request),
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
        !domainUser || domainUser.state !== "active" ||
        domainUser.approvalStatus === "rejected" ||
        normalizeEmail(domainUser.email) !== normalizeEmail(result.user.email)
      ) return null;
      const domainLimited = domainUser.approvalStatus !== "approved" ||
        ((options.requireEmailVerification ?? false) && !domainUser.emailVerifiedAt);
      return {
        userId: result.user.id,
        limited: domainLimited ||
          Boolean((result.session as typeof result.session & { limited?: boolean }).limited),
      };
    },
    invalidateUserSessions: async (userId: string) => {
      await sql`DELETE FROM auth_sessions WHERE user_id=${userId}`;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

export type BetterAuthService = ReturnType<typeof createBetterAuthService>;
