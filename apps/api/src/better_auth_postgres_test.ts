import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { PostgresRepository } from "@dg-chat/database";
import { createBetterAuthService } from "./better-auth.ts";
import { hashPassword } from "./crypto.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

function schemaDatabaseUrl(source: string, schema: string): string {
  const url = new URL(source);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
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
        CREATE TABLE api_tokens (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          revoked_at timestamptz
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
      service = createBetterAuthService({
        databaseUrl: schemaDatabaseUrl(databaseUrl!, schema),
        repository,
        secret: "test-secret-that-is-at-least-thirty-two-bytes-long",
        appUrl: "http://localhost:8000",
        webOrigin: "http://localhost:5173",
        requireEmailVerification: true,
        sendVerificationEmail: (delivery) => {
          verificationDeliveries.push(delivery);
          return Promise.resolve();
        },
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
      assertEquals(
        await service.getSession(new Headers({ cookie: legacyCookie })),
        { userId: legacyId, limited: false },
      );

      const signup = await service.handler(
        new Request(
          "http://localhost:8000/api/auth/sign-up/email",
          {
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
          },
        ),
      );
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
      assertEquals(session, { userId: body.user.id, limited: true });
      assertEquals(verificationDeliveries.length, 1);
      assertEquals(verificationDeliveries[0].email, "bridge@example.com");
      const verification = await service.handler(
        new Request(verificationDeliveries[0].url, {
          headers: { origin: "http://localhost:5173" },
        }),
      );
      assertEquals(verification.status, 302);
      assert((await repository.findUser(body.user.id))?.emailVerifiedAt);

      await repository.approveUser(body.user.id, "approved", 5_000_000, true);
      await service.invalidateUserSessions(body.user.id);
      assertEquals(await service.getSession(new Headers({ cookie })), null);
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
      assertEquals(
        await service.getSession(new Headers({ cookie: approvedCookie })),
        { userId: body.user.id, limited: false },
      );
      await repository.setUserState(body.user.id, "suspended");
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
        [{ limited: false }],
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
