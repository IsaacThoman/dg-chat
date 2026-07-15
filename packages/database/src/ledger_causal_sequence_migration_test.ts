import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0039 backfills and allocates durable per-user ledger causal sequences",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `ledger_sequence_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY,balance_micros bigint NOT NULL);
        CREATE TABLE ledger_entries(
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id),
          created_at timestamptz NOT NULL,
          amount_micros bigint NOT NULL,
          balance_after_micros bigint NOT NULL
        );
      `);
      const userId = crypto.randomUUID();
      const otherUserId = crypto.randomUUID();
      const largeUserId = crypto.randomUUID();
      const firstId = "00000000-0000-4000-8000-000000000001";
      const secondId = "00000000-0000-4000-8000-000000000002";
      const thirdId = "00000000-0000-4000-8000-000000000003";
      const otherId = "00000000-0000-4000-8000-000000000004";
      await sql`INSERT INTO users(id,balance_micros)
        VALUES(${userId},30),(${otherUserId},4),(${largeUserId},1000)`;
      await sql`INSERT INTO ledger_entries(id,user_id,created_at,amount_micros,balance_after_micros)
        VALUES
          (${secondId},${userId},'2025-01-01T00:00:00Z',20,30),
          (${firstId},${userId},'2026-01-01T00:00:00Z',10,10),
          (${otherId},${otherUserId},'2000-01-01T00:00:00Z',4,4)`;
      await sql`INSERT INTO ledger_entries(
        id,user_id,created_at,amount_micros,balance_after_micros
      ) SELECT gen_random_uuid(),${largeUserId},to_timestamp(2000-value),1,value
        FROM generate_series(1,1000) value`;

      const migration = await Deno.readTextFile(
        new URL("../migrations/0039_ledger_causal_sequence.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      assertEquals(
        [
          ...await sql`SELECT id,sequence FROM ledger_entries
          WHERE user_id=${userId} ORDER BY sequence`,
        ],
        [{ id: firstId, sequence: "1" }, { id: secondId, sequence: "2" }],
      );
      assertEquals(
        Number((await sql`SELECT sequence FROM ledger_entries WHERE id=${otherId}`)[0].sequence),
        1,
      );
      assertEquals(
        Number(
          (await sql`SELECT max(sequence) sequence FROM ledger_entries
          WHERE user_id=${largeUserId}`)[0].sequence,
        ),
        1000,
      );

      await sql`UPDATE users SET balance_micros=35 WHERE id=${userId}`;
      await sql`INSERT INTO ledger_entries(id,user_id,created_at,amount_micros,balance_after_micros)
        VALUES(${thirdId},${userId},'2025-01-01T00:00:00Z',5,35)`;
      assertEquals(
        Number((await sql`SELECT sequence FROM ledger_entries WHERE id=${thirdId}`)[0].sequence),
        3,
      );
      const explicit = await assertRejects(() =>
        sql`INSERT INTO ledger_entries(id,user_id,sequence,created_at,amount_micros,balance_after_micros)
          VALUES(${crypto.randomUUID()},${userId},3,now(),1,36)`
      );
      assertEquals(
        (explicit as Error).message.includes("explicit ledger sequence is reserved"),
        true,
      );
      const trigger = await sql`SELECT 1 FROM pg_trigger
        WHERE tgrelid='ledger_entries'::regclass AND tgname='dg_chat_assign_ledger_sequence'
          AND NOT tgisinternal`;
      assertEquals(trigger.length, 1);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});

Deno.test({
  name: "0039 reconstructs ambiguous causal trails and rejects impossible history",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const validSchema = `ledger_sequence_valid_${crypto.randomUUID().replaceAll("-", "")}`;
    const invalidSchema = `ledger_sequence_invalid_${crypto.randomUUID().replaceAll("-", "")}`;
    const migration = await Deno.readTextFile(
      new URL("../migrations/0039_ledger_causal_sequence.sql", import.meta.url),
    );
    try {
      await sql.unsafe(`CREATE SCHEMA ${validSchema}`);
      await sql.unsafe(`SET search_path TO ${validSchema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY,balance_micros bigint NOT NULL);
        CREATE TABLE ledger_entries(
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id),
          created_at timestamptz NOT NULL,
          amount_micros bigint NOT NULL,
          balance_after_micros bigint NOT NULL
        );
      `);
      const userId = crypto.randomUUID();
      const ids = [1, 2, 3, 4].map((value) =>
        `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`
      );
      await sql`INSERT INTO users(id,balance_micros) VALUES(${userId},3)`;
      // The earliest edge goes 0 -> 2 and dead-ends at 3. A greedy walk fails, while a complete
      // Euler trail is 0 -> 1 -> 0 -> 2 -> 3.
      await sql`INSERT INTO ledger_entries(
        id,user_id,created_at,amount_micros,balance_after_micros
      ) VALUES
        (${ids[1]},${userId},'2025-01-01T00:00:00Z',2,2),
        (${ids[3]},${userId},'2025-01-01T00:00:01Z',1,3),
        (${ids[0]},${userId},'2026-01-01T00:00:00Z',1,1),
        (${ids[2]},${userId},'2026-01-01T00:00:01Z',-1,0)`;
      await sql.unsafe(migration);
      assertEquals(
        [...await sql`SELECT id,sequence FROM ledger_entries ORDER BY sequence`],
        [
          { id: ids[0], sequence: "1" },
          { id: ids[2], sequence: "2" },
          { id: ids[1], sequence: "3" },
          { id: ids[3], sequence: "4" },
        ],
      );

      await sql.unsafe(`CREATE SCHEMA ${invalidSchema}`);
      await sql.unsafe(`SET search_path TO ${invalidSchema},public`);
      await sql.unsafe(`
        CREATE TABLE users(id uuid PRIMARY KEY,balance_micros bigint NOT NULL);
        CREATE TABLE ledger_entries(
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id),
          created_at timestamptz NOT NULL,
          amount_micros bigint NOT NULL,
          balance_after_micros bigint NOT NULL
        );
      `);
      const invalidUserId = crypto.randomUUID();
      await sql`INSERT INTO users(id,balance_micros) VALUES(${invalidUserId},10)`;
      await sql`INSERT INTO ledger_entries(
        id,user_id,created_at,amount_micros,balance_after_micros
      ) VALUES(${crypto.randomUUID()},${invalidUserId},now(),5,10)`;
      await assertRejects(() => sql.unsafe(migration));
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${validSchema} CASCADE`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${invalidSchema} CASCADE`);
      await sql.end();
    }
  },
});
