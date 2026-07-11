import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { reconcileBetterAuthIdentities } from "./better-auth-reconciliation.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

function schemaDatabaseUrl(source: string, schema: string): string {
  const url = new URL(source);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

Deno.test({
  name: "0024 creates isolated Better Auth storage and backfills legacy credentials",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `better_auth_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email text NOT NULL UNIQUE,
          name text NOT NULL,
          password_hash text NOT NULL,
          email_verified_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const verifiedId = crypto.randomUUID();
      const pendingId = crypto.randomUUID();
      await sql`
        INSERT INTO users(id,email,name,password_hash,email_verified_at)
        VALUES
          (${verifiedId},'verified@example.com','Verified','pbkdf2$legacy',now()),
          (${pendingId},'pending@example.com','Pending','pbkdf2$pending',null)
      `;

      const migration = await Deno.readTextFile(
        new URL("../migrations/0024_better_auth_bridge.sql", import.meta.url),
      );
      await sql.unsafe(migration);

      assertEquals(
        [
          ...await sql`
          SELECT id::text,email,email_verified FROM auth_users ORDER BY email
        `,
        ],
        [
          { id: pendingId, email: "pending@example.com", email_verified: false },
          { id: verifiedId, email: "verified@example.com", email_verified: true },
        ],
      );
      assertEquals(
        [...await sql`SELECT count(*)::int AS count FROM users WHERE password_hash IS NOT NULL`],
        [{ count: 2 }],
      );
      assertEquals(
        [
          ...await sql`
          SELECT account_id,provider_id,user_id::text,password
          FROM auth_accounts ORDER BY account_id
        `,
        ],
        [
          {
            account_id: pendingId,
            provider_id: "credential",
            user_id: pendingId,
            password: "pbkdf2$pending",
          },
          {
            account_id: verifiedId,
            provider_id: "credential",
            user_id: verifiedId,
            password: "pbkdf2$legacy",
          },
        ].sort((left, right) => left.account_id.localeCompare(right.account_id)),
      );

      const oidcOnlyId = crypto.randomUUID();
      await sql`
        INSERT INTO users(id,email,name,password_hash)
        VALUES(${oidcOnlyId},'oidc@example.com','OIDC only',null)
      `;
      const lateImportId = crypto.randomUUID();
      await sql`
        INSERT INTO users(id,email,name,password_hash,email_verified_at)
        VALUES(${lateImportId},'late@example.com','Late import','pbkdf2$late',now())
      `;
      const changedPasswordId = crypto.randomUUID();
      await sql`
        INSERT INTO users(id,email,name,password_hash,email_verified_at)
        VALUES(
          ${changedPasswordId},'changed@example.com','Changed password','pbkdf2$new',now()
        )
      `;
      await sql`
        INSERT INTO auth_users(id,email,name,email_verified)
        VALUES(${changedPasswordId},'changed@example.com','Changed password',true)
      `;
      await sql`
        INSERT INTO auth_accounts(account_id,provider_id,user_id,password,updated_at)
        VALUES(${changedPasswordId},'credential',${changedPasswordId},'pbkdf2$old',now())
      `;
      assertEquals(
        await reconcileBetterAuthIdentities(schemaDatabaseUrl(databaseUrl!, schema)),
        {
          usersInserted: 2,
          credentialsInserted: 1,
        },
      );
      assertEquals(
        await reconcileBetterAuthIdentities(schemaDatabaseUrl(databaseUrl!, schema)),
        {
          usersInserted: 0,
          credentialsInserted: 0,
        },
      );
      assertEquals(
        [
          ...await sql`
          SELECT password FROM auth_accounts
          WHERE provider_id='credential' AND account_id=${lateImportId}
        `,
        ],
        [{ password: "pbkdf2$late" }],
      );
      assertEquals(
        [
          ...await sql`
          SELECT password FROM auth_accounts
          WHERE provider_id='credential' AND account_id=${changedPasswordId}
        `,
        ],
        [{ password: "pbkdf2$old" }],
      );
      const authUserId = crypto.randomUUID();
      await sql`
        INSERT INTO auth_users(id,email,name) VALUES(${authUserId},'new@example.com','New user')
      `;
      const sessionId = crypto.randomUUID();
      await sql`
        INSERT INTO auth_sessions(id,user_id,token,expires_at,updated_at)
        VALUES(${sessionId},${authUserId},'single-use-session',now() + interval '1 hour',now())
      `;
      assertEquals(
        [...await sql`SELECT limited FROM auth_sessions WHERE id=${sessionId}`],
        [{ limited: true }],
      );

      await sql`
        INSERT INTO auth_accounts(account_id,provider_id,user_id,password,updated_at)
        VALUES(${authUserId},'credential',${authUserId},'first',now())
      `;
      await assertRejects(() =>
        sql`
          INSERT INTO auth_accounts(account_id,provider_id,user_id,password,updated_at)
          VALUES(${authUserId},'credential',${authUserId},'second',now())
        `
      );

      await sql`DELETE FROM auth_users WHERE id=${authUserId}`;
      assertEquals(
        [...await sql`SELECT count(*)::int AS count FROM auth_sessions WHERE user_id=${authUserId}`],
        [{ count: 0 }],
      );
      assertEquals(
        [...await sql`SELECT count(*)::int AS count FROM auth_accounts WHERE user_id=${authUserId}`],
        [{ count: 0 }],
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
