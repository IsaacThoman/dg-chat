import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { PostgresRepository } from "@dg-chat/database";
import { createBetterAuthService } from "./better-auth.ts";
import { hashPassword } from "./crypto.ts";
import { createApp } from "./app.ts";
import { createMockOidcProvider } from "../../mock-oidc/src/provider.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

function schemaDatabaseUrl(source: string, schema: string): string {
  const url = new URL(source);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for asynchronous identity delivery");
}

Deno.test({
  name: "Better Auth creates UUID-backed pending identities and limited sessions",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const adminSql = postgres(databaseUrl!, { max: 1 });
    const schema = `better_auth_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
    let service: ReturnType<typeof createBetterAuthService> | undefined;
    let repository: PostgresRepository | undefined;
    const verificationDeliveries: Array<{ email: string; url: string; token: string }> = [];
    const passwordResetDeliveries: Array<{ email: string; url: string; token: string }> = [];
    let rejectPasswordResetDelivery = false;
    let rejectVerificationDelivery = false;
    let heldPasswordResetDelivery: Promise<void> | undefined;
    try {
      await adminSql.unsafe(`CREATE SCHEMA ${schema}`);
      await adminSql.unsafe(`SET search_path TO ${schema},public`);
      await adminSql.unsafe(`
        CREATE TYPE approval_status AS ENUM ('pending','approved','rejected');
        CREATE TYPE user_role AS ENUM ('user','admin');
        CREATE TYPE account_state AS ENUM ('active','suspended','deleted');
        CREATE TYPE ledger_kind AS ENUM ('grant','reserve','settle','refund','adjustment');
        CREATE TABLE users (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email text NOT NULL UNIQUE,
          name text NOT NULL,
          password_hash text NOT NULL,
          role user_role NOT NULL DEFAULT 'user',
          approval_status approval_status NOT NULL DEFAULT 'pending',
          state account_state NOT NULL DEFAULT 'active',
          version integer NOT NULL DEFAULT 1,
          balance_micros bigint NOT NULL DEFAULT 0,
          email_verified_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz
        );
        CREATE TABLE sessions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash text NOT NULL UNIQUE,
          limited boolean NOT NULL DEFAULT false,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          invalidated_at timestamptz
        );
        CREATE TABLE identity_tokens (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
          token_hash text NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          consumed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE api_tokens (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name text NOT NULL,
          token_hash text NOT NULL UNIQUE,
          preview text NOT NULL,
          scopes jsonb NOT NULL,
          expires_at timestamptz,
          last_used_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          revoked_at timestamptz,
          version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
          rpm_limit integer CHECK(rpm_limit IS NULL OR rpm_limit BETWEEN 1 AND 60000),
          burst_limit integer CHECK(burst_limit IS NULL OR burst_limit BETWEEN 1 AND 1000),
          access_mode text NOT NULL DEFAULT 'inherit' CHECK(access_mode IN ('inherit','restricted')),
          rotation_family_id uuid NOT NULL,
          rotation_generation integer NOT NULL DEFAULT 0 CHECK(rotation_generation >= 0),
          rotated_from_token_id uuid,
          replaced_by_token_id uuid,
          overlap_ends_at timestamptz,
          CHECK(rpm_limit IS NULL OR burst_limit IS NULL OR burst_limit <= rpm_limit),
          UNIQUE(rotation_family_id,rotation_generation),
          UNIQUE(rotation_family_id,id),
          UNIQUE(user_id,id),
          FOREIGN KEY(rotation_family_id,rotated_from_token_id)
            REFERENCES api_tokens(rotation_family_id,id) ON DELETE RESTRICT,
          FOREIGN KEY(rotation_family_id,replaced_by_token_id)
            REFERENCES api_tokens(rotation_family_id,id) ON DELETE RESTRICT
        );
        CREATE TABLE ledger_entries (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users(id),
          usage_run_id text NOT NULL,
          kind ledger_kind NOT NULL,
          amount_micros bigint NOT NULL,
          balance_after_micros bigint NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(usage_run_id,kind)
        );
        CREATE TABLE audit_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          actor_id uuid REFERENCES users(id),
          action text NOT NULL,
          target_type text NOT NULL,
          target_id text,
          metadata jsonb NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const legacyId = crypto.randomUUID();
      const legacyPasswordHash = await hashPassword("legacy password remains valid");
      await adminSql`
        INSERT INTO users(
          id,email,name,password_hash,email_verified_at,approval_status,state,role
        ) VALUES(
          ${legacyId},'legacy@example.com','Legacy user',${legacyPasswordHash},now(),
          'approved','active','user'
        )
      `;
      const migration = await Deno.readTextFile(
        new URL(
          "../../../packages/database/migrations/0024_better_auth_bridge.sql",
          import.meta.url,
        ),
      );
      await adminSql.unsafe(migration);

      repository = await PostgresRepository.connect(schemaDatabaseUrl(databaseUrl!, schema));
      const bootstrap = await repository.bootstrapAdmin({
        email: "admin@example.com",
        name: "Bootstrap Admin",
        passwordHash: await hashPassword("bootstrap password remains valid"),
      }, 5_000_000);
      const mockOidc = await createMockOidcProvider({
        publicIssuer: "http://localhost:4020",
        internalBaseUrl: "http://mock-oidc:4020",
        clientId: "dg-chat-test",
        clientSecret: "dg-chat-test-secret",
        redirectUri: "http://localhost:8000/api/auth/oidc/callback",
        controlToken: "test-control-token",
      });
      service = createBetterAuthService({
        databaseUrl: schemaDatabaseUrl(databaseUrl!, schema),
        repository,
        secret: "test-secret-that-is-at-least-thirty-two-bytes-long",
        appUrl: "http://localhost:8000",
        webOrigin: "http://localhost:5173",
        oidc: {
          providerId: "organization",
          discoveryUrl: "http://mock-oidc:4020/.well-known/openid-configuration",
          expectedIssuer: "http://localhost:4020",
          clientId: "dg-chat-test",
          clientSecret: "dg-chat-test-secret",
          allowedAlgorithms: ["ES256"],
          allowInsecureHttp: true,
          allowPrivateNetwork: true,
          fetch: (input, init) =>
            mockOidc.fetch(input instanceof Request ? input : new Request(input, init)),
        },
        requireEmailVerification: true,
        sendVerificationEmail: (delivery) => {
          if (rejectVerificationDelivery) {
            return Promise.reject(new Error("injected verification delivery failure"));
          }
          verificationDeliveries.push(delivery);
          return Promise.resolve();
        },
        sendPasswordResetEmail: (delivery) => {
          if (heldPasswordResetDelivery) return heldPasswordResetDelivery;
          if (rejectPasswordResetDelivery) {
            return Promise.reject(new Error("injected SMTP delivery failure"));
          }
          passwordResetDeliveries.push(delivery);
          return Promise.resolve();
        },
      });
      const { app } = createApp({
        repository,
        browserAuth: service,
        requireEmailVerification: true,
      });

      const noUserInfoMode = await mockOidc.fetch(
        new Request("http://mock-oidc:4020/control/mode", {
          method: "POST",
          headers: {
            authorization: "Bearer test-control-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "no_userinfo" }),
        }),
      );
      assertEquals(noUserInfoMode.status, 200);

      const oidcStart = await service.handler(
        new Request("http://localhost:8000/api/auth/sign-in/oidc", {
          method: "POST",
          headers: { origin: "http://localhost:5173", "content-type": "application/json" },
          body: "{}",
        }),
      );
      assertEquals(oidcStart.status, 200, await oidcStart.clone().text());
      const oidcStartBody = await oidcStart.json() as { url: string; redirect: boolean };
      assertEquals(oidcStartBody.redirect, true);
      const authorizeUrl = new URL(oidcStartBody.url);
      assert(authorizeUrl.searchParams.get("nonce"));
      assertEquals(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
      const authorize = await mockOidc.fetch(new Request(authorizeUrl));
      const requestId = (await authorize.text()).match(/name="request_id" value="([^"]+)"/)?.[1];
      assert(requestId);
      const decision = await mockOidc.fetch(
        new Request("http://localhost:4020/authorize/decision", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ request_id: requestId, persona: "new_verified" }),
        }),
      );
      assertEquals(decision.status, 302);
      const stateCookie = oidcStart.headers.getSetCookie().map((value) => value.split(";", 1)[0])
        .join("; ");
      assert(stateCookie);
      const oidcCallback = await service.handler(
        new Request(decision.headers.get("location")!, {
          headers: { cookie: stateCookie },
          redirect: "manual",
        }),
      );
      assertEquals(oidcCallback.status, 302, await oidcCallback.clone().text());
      assertEquals(oidcCallback.headers.get("location"), "http://localhost:5173/pending");
      const oidcSessionCookie = oidcCallback.headers.getSetCookie()
        .find((value) => value.startsWith("dg_chat.session_token="))?.split(";", 1)[0];
      assert(oidcSessionCookie);
      const oidcMe = await app.request("/api/auth/me", { headers: { cookie: oidcSessionCookie } });
      assertEquals(oidcMe.status, 200, await oidcMe.clone().text());
      const oidcIdentity = await oidcMe.json() as {
        user: { id: string; email: string; approvalStatus: string };
        limited: boolean;
      };
      assertEquals(oidcIdentity.user.email, "oidc-new@e2e.invalid");
      assertEquals(oidcIdentity.user.approvalStatus, "pending");
      assertEquals(oidcIdentity.limited, true);
      const oidcSession = await service.getSession(new Headers({ cookie: oidcSessionCookie }));
      assert(oidcSession);
      assertMatch(oidcSession.authenticatedAt, /^\d{4}-\d{2}-\d{2}T/u);
      const oidcState = await mockOidc.fetch(
        new Request("http://mock-oidc:4020/control/state", {
          headers: { authorization: "Bearer test-control-token" },
        }),
      );
      assertEquals(
        (await oidcState.json() as { counters: { userinfo: number } }).counters.userinfo,
        0,
      );
      const firstOidcApproval = await repository.decideUserApproval({
        actorId: bootstrap.id,
        targetUserId: oidcIdentity.user.id,
        expectedVersion: 1,
        status: "approved",
        startingCreditMicros: 5_000_000,
      });
      const rejectedOidcIdentity = await repository.decideUserApproval({
        actorId: bootstrap.id,
        targetUserId: oidcIdentity.user.id,
        expectedVersion: firstOidcApproval.version,
        status: "rejected",
        startingCreditMicros: 5_000_000,
        reason: "Exercise idempotent reapproval grant",
      });
      const repeatedOidcApproval = await repository.decideUserApproval({
        actorId: bootstrap.id,
        targetUserId: oidcIdentity.user.id,
        expectedVersion: rejectedOidcIdentity.version,
        status: "approved",
        startingCreditMicros: 5_000_000,
      });
      assertEquals(firstOidcApproval.balanceMicros, 5_000_000);
      assertEquals(repeatedOidcApproval.balanceMicros, 5_000_000);
      const approvedOidcStatus = await app.request("/api/auth/status", {
        headers: { cookie: oidcSessionCookie },
      });
      assertEquals(approvedOidcStatus.status, 200);
      assertEquals(await approvedOidcStatus.json(), {
        approvalStatus: "approved",
        state: "active",
        emailVerified: true,
        emailVerificationRequired: true,
        sessionLimited: true,
        fullSessionEligible: true,
        fullAccess: false,
      });

      const legacySignin = await service.handler(
        new Request("http://localhost:8000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
          },
          body: JSON.stringify({
            email: "legacy@example.com",
            password: "legacy password remains valid",
          }),
        }),
      );
      assertEquals(legacySignin.status, 200, await legacySignin.clone().text());
      const legacyCookie = legacySignin.headers.get("set-cookie")?.split(";", 1)[0];
      assert(legacyCookie);
      const legacySession = await service.getSession(new Headers({ cookie: legacyCookie }));
      assert(legacySession);
      assertEquals(
        { userId: legacySession.userId, limited: legacySession.limited },
        { userId: legacyId, limited: false },
      );
      assertMatch(legacySession.authenticatedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assertEquals(bootstrap.passwordHash, null);
      assertEquals(bootstrap.balanceMicros, 5_000_000);
      const bootstrapSignin = await service.handler(
        new Request("http://localhost:8000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
          },
          body: JSON.stringify({
            email: "admin@example.com",
            password: "bootstrap password remains valid",
          }),
        }),
      );
      assertEquals(bootstrapSignin.status, 200, await bootstrapSignin.clone().text());
      const bootstrapCookie = bootstrapSignin.headers.get("set-cookie")?.split(";", 1)[0];
      assert(bootstrapCookie);
      const tokenResponse = await app.request("/api/tokens", {
        method: "POST",
        headers: {
          cookie: bootstrapCookie,
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Before reset", scopes: ["models:read"] }),
      });
      assertEquals(tokenResponse.status, 201, await tokenResponse.clone().text());
      const apiToken = (await tokenResponse.json() as { token: string }).token;
      assertEquals(
        (await app.request("/v1/models", {
          headers: { authorization: `Bearer ${apiToken}` },
        })).status,
        200,
      );
      const resetRequest = await app.request("/api/auth/password-reset/request", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "admin@example.com" }),
      });
      assertEquals(resetRequest.status, 202, await resetRequest.clone().text());
      const unknownResetRequest = await app.request("/api/auth/password-reset/request", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "unknown-reset-account@example.com" }),
      });
      assertEquals(unknownResetRequest.status, resetRequest.status);
      assertEquals(await unknownResetRequest.text(), await resetRequest.clone().text());
      const rawResetRequest = await app.request("/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "admin@example.com" }),
      });
      assertEquals(rawResetRequest.status, 409);
      await waitFor(() => passwordResetDeliveries.length === 1);
      assertEquals(passwordResetDeliveries.length, 1);
      const resetCallback = await service.handler(
        new Request(passwordResetDeliveries[0].url, {
          redirect: "manual",
        }),
      );
      assertEquals(resetCallback.status, 302);
      const resetLocation = new URL(resetCallback.headers.get("location")!);
      assertEquals(
        resetLocation.origin + resetLocation.pathname,
        "http://localhost:5173/reset-password",
      );
      const resetToken = resetLocation.searchParams.get("token");
      assert(resetToken);
      const originalHandler = service.handler;
      let failResetOnce = true;
      service.handler = (request) => {
        const url = new URL(request.url);
        if (
          failResetOnce && request.method === "POST" && url.pathname.endsWith("/reset-password")
        ) {
          failResetOnce = false;
          return Promise.resolve(new Response("temporary auth storage failure", { status: 503 }));
        }
        return originalHandler(request);
      };
      const failedReset = await app.request("/api/auth/password-reset", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: resetToken, password: "new bootstrap password valid" }),
      });
      assertEquals(failedReset.status, 503, await failedReset.clone().text());
      const guarded = await adminSql<
        { state: string; password_reset_pending: boolean }[]
      >`SELECT state,password_reset_pending FROM users WHERE email='admin@example.com'`;
      assertEquals(guarded[0], { state: "active", password_reset_pending: true });
      assertEquals(
        (await app.request("/v1/models", {
          headers: { authorization: `Bearer ${apiToken}` },
        })).status,
        401,
      );
      const originalSecureAfterReset = repository.secureAfterPasswordReset.bind(repository);
      let failCompletionOnce = true;
      repository.secureAfterPasswordReset = (userId, token) => {
        if (failCompletionOnce) {
          failCompletionOnce = false;
          return Promise.reject(new Error("injected reset completion failure"));
        }
        return originalSecureAfterReset(userId, token);
      };
      const completionFailed = await app.request("/api/auth/password-reset", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: resetToken, password: "new bootstrap password valid" }),
      });
      assertEquals(completionFailed.status, 500, await completionFailed.clone().text());
      const replacementRequest = await app.request("/api/auth/password-reset/request", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "admin@example.com" }),
      });
      assertEquals(replacementRequest.status, 202, await replacementRequest.clone().text());
      await waitFor(() => passwordResetDeliveries.length === 2);
      assertEquals(passwordResetDeliveries.length, 2);
      const replacementCallback = await service.handler(
        new Request(passwordResetDeliveries[1].url, { redirect: "manual" }),
      );
      const replacementLocation = new URL(replacementCallback.headers.get("location")!);
      const replacementToken = replacementLocation.searchParams.get("token");
      assert(replacementToken);
      const reset = await app.request("/api/auth/password-reset", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token: replacementToken,
          password: "final bootstrap password valid",
        }),
      });
      assertEquals(reset.status, 204, await reset.clone().text());
      for (
        const token of [
          replacementToken,
          "invalid_better_auth_password_reset_token_0000000000",
        ]
      ) {
        const rejectedReset = await app.request("/api/auth/password-reset", {
          method: "POST",
          headers: {
            origin: "http://localhost:5173",
            "content-type": "application/json",
          },
          body: JSON.stringify({ token, password: "another secure replacement password" }),
        });
        assertEquals(rejectedReset.status, 400);
        assertEquals(await rejectedReset.json(), {
          error: {
            code: "invalid_identity_token",
            message: "Reset token is invalid or expired",
          },
        });
      }
      rejectPasswordResetDelivery = true;
      const rejectedDeliveryKnown = await app.request("/api/auth/password-reset/request", {
        method: "POST",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com" }),
      });
      const rejectedDeliveryUnknown = await app.request("/api/auth/password-reset/request", {
        method: "POST",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        body: JSON.stringify({ email: "no-such-user@example.com" }),
      });
      assertEquals(rejectedDeliveryKnown.status, 202);
      assertEquals(rejectedDeliveryUnknown.status, 202);
      assertEquals(
        await rejectedDeliveryKnown.text(),
        await rejectedDeliveryUnknown.text(),
      );
      await waitFor(async () =>
        (await repository!.listAudit()).data.some((event) =>
          event.action === "identity.password_reset_delivery_failed"
        )
      );
      const resetDeliveryFailure = (await repository.listAudit()).data.find((event) =>
        event.action === "identity.password_reset_delivery_failed"
      );
      assert(resetDeliveryFailure);
      assertEquals(resetDeliveryFailure.actorId, null);
      assertEquals(resetDeliveryFailure.targetId, bootstrap.id);
      rejectPasswordResetDelivery = false;

      let releaseHeldDelivery!: () => void;
      heldPasswordResetDelivery = new Promise<void>((resolve) => {
        releaseHeldDelivery = resolve;
      });
      const heldDeliveryRequest = await app.request("/api/auth/password-reset/request", {
        method: "POST",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com" }),
      });
      assertEquals(heldDeliveryRequest.status, 202);
      let deliveryDrained = false;
      const drainingDeliveries = service.drainIdentityDeliveries().then(() => {
        deliveryDrained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(deliveryDrained, false);
      releaseHeldDelivery();
      await drainingDeliveries;
      assertEquals(deliveryDrained, true);
      heldPasswordResetDelivery = undefined;
      assertEquals(
        (await app.request("/v1/models", {
          headers: { authorization: `Bearer ${apiToken}` },
        })).status,
        401,
      );
      assertEquals(
        (await app.request("/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            origin: "http://localhost:5173",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: "admin@example.com",
            password: "bootstrap password remains valid",
          }),
        })).status,
        401,
      );
      const resetSignin = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "final bootstrap password valid",
        }),
      });
      assertEquals(resetSignin.status, 200, await resetSignin.clone().text());
      const resetCookie = resetSignin.headers.get("set-cookie")?.split(";", 1)[0];
      assert(resetCookie);
      assertEquals(
        (await app.request("/api/audio/speech", {
          method: "POST",
          headers: {
            cookie: resetCookie,
            origin: "http://localhost:5173",
            "content-type": "application/json",
          },
          body: "{}",
        })).status,
        422,
      );
      assertEquals(
        (await app.request("/v1/audio/speech", {
          method: "POST",
          headers: { cookie: resetCookie, "content-type": "application/json" },
          body: "{}",
        })).status,
        401,
      );

      const signup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          name: "OIDC Bridge",
          email: "bridge@example.com",
          password: "correct horse battery staple",
        }),
      });
      assertEquals(signup.status, 200, await signup.clone().text());
      const body = await signup.json() as { user: { id: string; email: string } };
      assertMatch(
        body.user.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assertEquals(body.user.email, "bridge@example.com");

      const domainUser = await repository.findUser(body.user.id);
      assertEquals(domainUser?.approvalStatus, "pending");
      assertEquals(domainUser?.passwordHash, null);
      const cookie = signup.headers.get("set-cookie")?.split(";", 1)[0];
      assert(cookie);
      assert(!cookie.includes("correct horse battery staple"));
      const session = await service.getSession(new Headers({ cookie }));
      assert(session);
      assertEquals(
        { userId: session.userId, limited: session.limited },
        { userId: body.user.id, limited: true },
      );
      assertMatch(session.authenticatedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assertEquals((await app.request("/api/auth/me", { headers: { cookie } })).status, 200);
      const directSessions = await service.listUserSessions(body.user.id, new Headers({ cookie }));
      assertEquals(directSessions.length >= 1, true);
      assertEquals((await repository.listSessions(body.user.id)).length, 0);
      const listedSessions = await (await app.request("/api/sessions", { headers: { cookie } }))
        .json() as { data: Array<{ id: string; current: boolean }> };
      assertEquals(listedSessions.data.some((candidate) => candidate.current), true);
      assertEquals(listedSessions.data.filter((candidate) => candidate.current).length, 1);
      assertEquals((await app.request("/v1/models", { headers: { cookie } })).status, 401);
      assertEquals(
        (await app.request("/api/auth/me", {
          headers: { authorization: "Bearer copied-api-credential" },
        })).status,
        401,
      );
      await waitFor(() => verificationDeliveries.length === 1);
      assertEquals(verificationDeliveries.length, 1);
      assertEquals(verificationDeliveries[0].email, "bridge@example.com");
      await waitFor(async () =>
        (await repository!.listAudit()).data.some((event) =>
          event.action === "identity.verification_sent" && event.targetId === body.user.id
        )
      );
      const verifyThroughProduct = (token: string) =>
        app.request("/api/auth/verify-email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
          },
          body: JSON.stringify({ token }),
        });
      const concurrentVerification = await Promise.all([
        verifyThroughProduct(verificationDeliveries[0].token),
        verifyThroughProduct(verificationDeliveries[0].token),
      ]);
      assertEquals(concurrentVerification.map((response) => response.status).sort(), [200, 400]);
      const verification = concurrentVerification.find((response) => response.status === 200)!;
      assertEquals(
        (await verification.json() as { user: { id: string } }).user.id,
        body.user.id,
      );
      assert((await repository.findUser(body.user.id))?.emailVerifiedAt);
      assertEquals(
        Number(
          (await adminSql`
          SELECT count(*)::int AS count FROM audit_events
          WHERE action='identity.email_verified' AND target_id=${body.user.id}
        `)[0].count,
        ),
        1,
      );
      assertEquals(
        (await app.request(`/api/auth/verify-email?token=${verificationDeliveries[0].token}`))
          .status,
        409,
      );
      assertEquals(
        (await app.request(`/api/auth/reset-password/${verificationDeliveries[0].token}`)).status,
        409,
      );
      assertEquals(
        (await app.request("/api/auth/send-verification-email", {
          method: "POST",
          headers: { origin: "http://localhost:5173", "content-type": "application/json" },
          body: JSON.stringify({ email: "bridge@example.com" }),
        })).status,
        409,
      );
      for (const path of ["update-user", "revoke-sessions", "revoke-other-sessions"]) {
        assertEquals(
          (await app.request(`/api/auth/${path}`, {
            method: "POST",
            headers: {
              cookie,
              origin: "http://localhost:5173",
              "content-type": "application/json",
            },
            body: "{}",
          })).status,
          404,
        );
      }
      for (
        const token of [
          verificationDeliveries[0].token,
          "invalid_better_auth_verification_token_0000000000",
        ]
      ) {
        const rejectedVerification = await verifyThroughProduct(token);
        assertEquals(rejectedVerification.status, 400);
        assertEquals(await rejectedVerification.json(), {
          error: {
            code: "invalid_identity_token",
            message: "Verification token is invalid or expired",
          },
        });
      }
      assertEquals(
        await (await app.request("/api/auth/status", { headers: { cookie } })).json(),
        {
          approvalStatus: "pending",
          state: "active",
          emailVerified: true,
          emailVerificationRequired: true,
          sessionLimited: true,
          fullSessionEligible: false,
          fullAccess: false,
        },
      );

      await repository.decideUserApproval({
        actorId: bootstrap.id,
        targetUserId: body.user.id,
        expectedVersion: domainUser!.version,
        status: "approved",
        startingCreditMicros: 5_000_000,
        requireEmailVerification: true,
      });
      assertEquals(
        await (await app.request("/api/auth/status", { headers: { cookie } })).json(),
        {
          approvalStatus: "approved",
          state: "active",
          emailVerified: true,
          emailVerificationRequired: true,
          sessionLimited: true,
          fullSessionEligible: true,
          fullAccess: false,
        },
      );
      const staleWorkspace = await app.request("/api/conversations", { headers: { cookie } });
      assertEquals(staleWorkspace.status, 403);
      assertEquals(
        (await staleWorkspace.json() as { error: { code: string } }).error.code,
        "session_refresh_required",
      );
      const approvedSignin = await service.handler(
        new Request("http://localhost:8000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
          },
          body: JSON.stringify({
            email: "bridge@example.com",
            password: "correct horse battery staple",
          }),
        }),
      );
      assertEquals(approvedSignin.status, 200, await approvedSignin.clone().text());
      const approvedCookie = approvedSignin.headers.get("set-cookie")?.split(";", 1)[0];
      assert(approvedCookie);
      const approvedSession = await service.getSession(new Headers({ cookie: approvedCookie }));
      assert(approvedSession);
      assertEquals(
        { userId: approvedSession.userId, limited: approvedSession.limited },
        { userId: body.user.id, limited: false },
      );
      assertMatch(approvedSession.authenticatedAt, /^\d{4}-\d{2}-\d{2}T/u);
      const approvedTokenResponse = await app.request("/api/tokens", {
        method: "POST",
        headers: {
          cookie: approvedCookie,
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Deleted account regression", scopes: ["models:read"] }),
      });
      assertEquals(approvedTokenResponse.status, 201);
      const approvedToken = (await approvedTokenResponse.json() as { token: string }).token;

      rejectVerificationDelivery = true;
      const deliveryFailureSignup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          name: "Delivery Failure",
          email: "verification-failure@example.com",
          password: "correct horse battery staple",
        }),
      });
      assertEquals(deliveryFailureSignup.status, 200, await deliveryFailureSignup.clone().text());
      const failedIdentity = await deliveryFailureSignup.json() as { user: { id: string } };
      const failedCookie = deliveryFailureSignup.headers.get("set-cookie")?.split(";", 1)[0];
      assert(failedCookie);
      assertEquals(
        (await app.request("/api/auth/me", { headers: { cookie: failedCookie } })).status,
        200,
      );
      await waitFor(async () =>
        (await repository!.listAudit()).data.some((event) =>
          event.action === "identity.verification_delivery_failed" &&
          event.targetId === failedIdentity.user.id
        )
      );
      const verificationDeliveryFailure = (await repository.listAudit()).data.find((event) =>
        event.action === "identity.verification_delivery_failed" &&
        event.targetId === failedIdentity.user.id
      );
      assert(verificationDeliveryFailure);
      assertEquals(verificationDeliveryFailure.actorId, null);
      const resendAfterFailure = await app.request("/api/auth/verify-email/request", {
        method: "POST",
        headers: {
          cookie: failedCookie,
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
      });
      assertEquals(resendAfterFailure.ok, true, await resendAfterFailure.clone().text());
      await waitFor(async () =>
        (await repository!.listAudit()).data.filter((event) =>
          event.action === "identity.verification_delivery_failed" &&
          event.targetId === failedIdentity.user.id
        ).length >= 2
      );
      rejectVerificationDelivery = false;

      await adminSql`UPDATE users SET deleted_at=now() WHERE id=${body.user.id}`;
      assertEquals(await service.getSession(new Headers({ cookie: approvedCookie })), null);
      const passwordResetCount = passwordResetDeliveries.length;
      assertEquals(
        (await app.request("/api/auth/password-reset/request", {
          method: "POST",
          headers: {
            origin: "http://localhost:5173",
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: "bridge@example.com" }),
        })).status,
        202,
      );
      assertEquals(passwordResetDeliveries.length, passwordResetCount);
      assertEquals(
        (await app.request("/v1/models", {
          headers: { authorization: `Bearer ${approvedToken}` },
        })).status,
        401,
      );
      const deletedSignin = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "bridge@example.com",
          password: "correct horse battery staple",
        }),
      });
      assertEquals(deletedSignin.status, 401);
      assertEquals(deletedSignin.headers.has("set-cookie"), false);
      await adminSql`UPDATE users SET deleted_at=NULL WHERE id=${body.user.id}`;
      assert(await service.getSession(new Headers({ cookie: approvedCookie })));

      const bridgeUser = await repository.getAdminUser(body.user.id);
      await repository.setAdminUserState({
        actorId: bootstrap.id,
        targetUserId: body.user.id,
        expectedVersion: bridgeUser.version,
        state: "suspended",
        reason: "Exercise suspended Better Auth session behavior",
      });
      assertEquals(await service.getSession(new Headers({ cookie: approvedCookie })), null);

      assertEquals(
        [
          ...await adminSql`
          SELECT count(*)::int AS count FROM auth_users WHERE id=${body.user.id}
        `,
        ],
        [{ count: 1 }],
      );
      assertEquals(
        [
          ...await adminSql`
          SELECT limited FROM auth_sessions WHERE user_id=${body.user.id}
        `,
        ],
        [{ limited: true }],
      );
      assertEquals(
        [
          ...await adminSql`
          SELECT provider_id,password FROM auth_accounts WHERE user_id=${body.user.id}
        `,
        ].map((row) => ({
          provider_id: String(row.provider_id),
          password: typeof row.password === "string",
        })),
        [{ provider_id: "credential", password: true }],
      );
    } finally {
      await service?.close();
      await repository?.close();
      await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminSql.end();
    }
  },
});
