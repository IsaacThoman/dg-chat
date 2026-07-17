import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0043 fences immutable credential epochs in a custom schema",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `authority_epoch_${crypto.randomUUID().replaceAll("-", "")}`;
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(
          id uuid PRIMARY KEY,email text,name text,password_hash text,role text,
          approval_status text NOT NULL,state text NOT NULL,version integer DEFAULT 1,
          balance_micros bigint DEFAULT 0,email_verified_at timestamptz,created_at timestamptz DEFAULT now(),
          updated_at timestamptz DEFAULT now(),deleted_at timestamptz,
          password_reset_pending boolean NOT NULL DEFAULT false
        );
        CREATE TABLE auth_users(id uuid PRIMARY KEY);
        CREATE TABLE sessions(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),
          token_hash text UNIQUE,limited boolean NOT NULL DEFAULT false,expires_at timestamptz,
          created_at timestamptz DEFAULT now(),invalidated_at timestamptz
        );
        CREATE TABLE auth_sessions(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth_users(id),
          token text UNIQUE,limited boolean NOT NULL DEFAULT true,expires_at timestamptz,
          created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now()
        );
        CREATE TABLE api_tokens(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),
          name text,token_hash text UNIQUE,preview text,scopes jsonb,created_at timestamptz DEFAULT now()
        );
        CREATE TABLE identity_tokens(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),
          purpose text NOT NULL,token_hash text UNIQUE,expires_at timestamptz NOT NULL,
          consumed_at timestamptz,created_at timestamptz DEFAULT now()
        );
        CREATE TABLE auth_verifications(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),identifier text NOT NULL,value text NOT NULL,
          expires_at timestamptz NOT NULL,created_at timestamptz DEFAULT now(),
          updated_at timestamptz DEFAULT now()
        );
        CREATE FUNCTION dg_chat_fence_auth_session_issuance() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER dg_chat_auth_session_issuance_fence BEFORE INSERT ON auth_sessions
          FOR EACH ROW EXECUTE FUNCTION dg_chat_fence_auth_session_issuance();
      `);
      const migration = await Deno.readTextFile(
        new URL("../migrations/0043_credential_authority_epoch.sql", import.meta.url),
      );
      await sql.unsafe(migration);

      const userId = crypto.randomUUID();
      await sql`INSERT INTO users(id,email,name,approval_status,state,authority_epoch)
        VALUES(${userId},'epoch@example.test','Epoch','approved','active',2)`;
      await sql`INSERT INTO auth_users(id) VALUES(${userId})`;

      const stale = await assertRejects(() =>
        sql`INSERT INTO api_tokens(user_id,name,token_hash,preview,scopes,authority_epoch)
          VALUES(${userId},'stale','stale-hash','stale','[]',1)`
      );
      assertEquals((stale as { code?: string }).code, "42501");

      const [token] = await sql<{ id: string }[]>`
        INSERT INTO api_tokens(user_id,name,token_hash,preview,scopes,authority_epoch)
        VALUES(${userId},'current','current-hash','current','[]',2) RETURNING id`;
      const mutation = await assertRejects(() =>
        sql`UPDATE api_tokens SET authority_epoch=3 WHERE id=${token.id}`
      );
      assertEquals((mutation as { code?: string }).code, "23514");

      const staleIdentity = await assertRejects(() =>
        sql`INSERT INTO identity_tokens(user_id,purpose,token_hash,expires_at,authority_epoch)
          VALUES(${userId},'email_verification','stale-identity',now()+interval '1 hour',1)`
      );
      assertEquals((staleIdentity as { code?: string }).code, "42501");
      const [identity] = await sql<{ id: string }[]>`
        INSERT INTO identity_tokens(user_id,purpose,token_hash,expires_at,authority_epoch)
        VALUES(${userId},'email_verification','current-identity',now()+interval '1 hour',2)
        RETURNING id`;
      const identityMutation = await assertRejects(() =>
        sql`UPDATE identity_tokens SET authority_epoch=3 WHERE id=${identity.id}`
      );
      assertEquals((identityMutation as { code?: string }).code, "23514");

      const staleReset = await assertRejects(() =>
        sql`INSERT INTO auth_verifications(identifier,value,expires_at,authority_epoch)
          VALUES('reset-password:stale',${userId},now()+interval '1 hour',1)`
      );
      assertEquals((staleReset as { code?: string }).code, "42501");
      await sql`INSERT INTO auth_verifications(identifier,value,expires_at,authority_epoch)
        VALUES('reset-password:current',${userId},now()+interval '1 hour',2)`;
      const resetMutation = await assertRejects(() =>
        sql`UPDATE auth_verifications SET authority_epoch=3
          WHERE identifier='reset-password:current'`
      );
      assertEquals((resetMutation as { code?: string }).code, "23514");
      await sql`INSERT INTO auth_verifications(identifier,value,expires_at,authority_epoch)
        VALUES('oidc-state:test','opaque',now()+interval '1 hour',NULL)`;
      await sql`UPDATE users SET state='suspended' WHERE id=${userId}`;
      const suspendedReset = await assertRejects(() =>
        sql`INSERT INTO auth_verifications(identifier,value,expires_at,authority_epoch)
          VALUES('reset-password:suspended',${userId},now()+interval '1 hour',2)`
      );
      assertEquals((suspendedReset as { code?: string }).code, "42501");
      await sql`UPDATE users SET state='active',deleted_at=now() WHERE id=${userId}`;
      const deletedReset = await assertRejects(() =>
        sql`INSERT INTO auth_verifications(identifier,value,expires_at,authority_epoch)
          VALUES('reset-password:deleted',${userId},now()+interval '1 hour',2)`
      );
      assertEquals((deletedReset as { code?: string }).code, "42501");
      await sql`UPDATE users SET state='active',deleted_at=NULL WHERE id=${userId}`;

      await sql`INSERT INTO auth_sessions(user_id,token,limited,expires_at,authority_epoch)
        VALUES(${userId},'current-session',false,now()+interval '1 hour',2)`;
      const staleSession = await assertRejects(() =>
        sql`INSERT INTO auth_sessions(user_id,token,limited,expires_at,authority_epoch)
          VALUES(${userId},'stale-session',false,now()+interval '1 hour',1)`
      );
      assertEquals((staleSession as { code?: string }).code, "42501");

      const columns = await sql<{ count: number }[]>`
        SELECT count(*)::int count FROM information_schema.columns
        WHERE table_schema=${schema} AND column_name='authority_epoch'
          AND table_name IN (
            'users','sessions','auth_sessions','api_tokens','identity_tokens','auth_verifications'
          )`;
      assertEquals(columns[0].count, 6);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end({ timeout: 5 });
    }
  },
});
