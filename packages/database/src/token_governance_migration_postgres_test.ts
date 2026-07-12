import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0027 upgrades a populated 0026 installation once and preserves legacy token auth",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql`CREATE TABLE migration_journal(tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      await sql.unsafe(
        `CREATE TABLE users(id uuid PRIMARY KEY,email text NOT NULL,name text NOT NULL,password_hash text,approval_status text NOT NULL,state text NOT NULL)`,
      );
      await sql.unsafe(`CREATE TABLE providers(id uuid PRIMARY KEY)`);
      await sql.unsafe(
        `CREATE TABLE provider_models(id uuid PRIMARY KEY,provider_id uuid NOT NULL REFERENCES providers(id),public_model_id text NOT NULL UNIQUE)`,
      );
      await sql.unsafe(
        `CREATE TABLE api_tokens(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,name text NOT NULL,token_hash text NOT NULL UNIQUE,preview text NOT NULL,scopes jsonb NOT NULL,expires_at timestamptz,revoked_at timestamptz,last_used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`,
      );
      await sql.unsafe(`CREATE TABLE auth_users(id uuid PRIMARY KEY,email text NOT NULL)`);
      await sql.unsafe(
        `CREATE TABLE auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,token text NOT NULL UNIQUE,expires_at timestamptz NOT NULL)`,
      );
      await sql`INSERT INTO migration_journal(tag) VALUES('0026_privacy_retention')`;
      const apply27 = async () => {
        const tag = "0027_token_governance";
        if ((await sql`SELECT 1 FROM migration_journal WHERE tag=${tag}`).length) return;
        const body = await Deno.readTextFile(
          new URL("../migrations/0027_token_governance.sql", import.meta.url),
        );
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          await tx`INSERT INTO migration_journal(tag) VALUES(${tag})`;
        });
      };
      const userId = crypto.randomUUID(),
        tokenId = crypto.randomUUID(),
        authSessionId = crypto.randomUUID();
      await sql`INSERT INTO users(id,email,name,password_hash,approval_status,state) VALUES(${userId},'legacy-upgrade@example.com','Legacy','hash','approved','active')`;
      await sql`INSERT INTO auth_users(id,email) VALUES(${userId},'legacy-upgrade@example.com')`;
      await sql`INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES(${authSessionId},${userId},'legacy-session',now()+interval '1 day')`;
      await sql`INSERT INTO api_tokens(id,user_id,name,token_hash,preview,scopes) VALUES(${tokenId},${userId},'legacy','legacy-token-hash','legacy','["chat"]')`;
      await apply27();
      await apply27();
      const row = (await sql`SELECT * FROM api_tokens WHERE id=${tokenId}`)[0];
      assertEquals(String(row.rotation_family_id), tokenId);
      assertEquals(Number(row.rotation_generation), 0);
      assertEquals(Number(row.version), 1);
      assertEquals(row.rpm_limit, null);
      assertEquals(row.burst_limit, null);
      assertEquals(String(row.access_mode), "inherit");
      const authenticated =
        await sql`UPDATE api_tokens SET last_used_at=now() WHERE token_hash='legacy-token-hash' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (replaced_by_token_id IS NULL OR overlap_ends_at>now()) RETURNING id`;
      assertEquals(String(authenticated[0].id), tokenId);
      assertEquals(
        String((await sql`SELECT id FROM auth_sessions WHERE token='legacy-session'`)[0].id),
        authSessionId,
      );
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM migration_journal WHERE tag='0027_token_governance'`)[
            0
          ].count,
        ),
        1,
      );
      await assertRejects(() => sql`UPDATE api_tokens SET rpm_limit=0 WHERE id=${tokenId}`);
      await assertRejects(() => sql`UPDATE api_tokens SET access_mode='open' WHERE id=${tokenId}`);
      const constraints =
        await sql`SELECT conname,confdeltype FROM pg_constraint WHERE connamespace=${schema}::regnamespace AND conname IN ('api_tokens_rotated_from_fk','api_tokens_replaced_by_fk') ORDER BY conname`;
      assertEquals(constraints.map((row) => [row.conname, row.confdeltype]), [[
        "api_tokens_replaced_by_fk",
        "r",
      ], ["api_tokens_rotated_from_fk", "r"]]);
      const indexes =
        await sql`SELECT indexname FROM pg_indexes WHERE schemaname=${schema} AND indexname IN ('api_tokens_family_generation_uq','access_groups_name_uq') ORDER BY indexname`;
      assertEquals(indexes.map((row) => row.indexname), [
        "access_groups_name_uq",
        "api_tokens_family_generation_uq",
      ]);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
