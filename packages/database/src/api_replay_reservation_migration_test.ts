import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0035 upgrades populated API replay rows with safe zero reservations",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `replay_reservation_${crypto.randomUUID().replaceAll("-", "")}`;
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE api_idempotency_requests(
          id uuid PRIMARY KEY,
          state text NOT NULL
        );
      `);
      const inProgress = crypto.randomUUID();
      const completed = crypto.randomUUID();
      await sql`INSERT INTO api_idempotency_requests(id,state) VALUES
        (${inProgress},'in_progress'),(${completed},'completed')`;
      const migration = await Deno.readTextFile(
        new URL("../migrations/0035_api_replay_reservations.sql", import.meta.url),
      );
      await sql.unsafe(migration);
      const rows = await sql<
        { id: string; replay_reserved_bytes: number; replay_reserved_events: number }[]
      >`SELECT id,replay_reserved_bytes,replay_reserved_events
        FROM api_idempotency_requests ORDER BY state`;
      assertEquals(
        rows.map((row) => ({
          id: String(row.id),
          bytes: Number(row.replay_reserved_bytes),
          events: Number(row.replay_reserved_events),
        })),
        [{ id: completed, bytes: 0, events: 0 }, {
          id: inProgress,
          bytes: 0,
          events: 0,
        }],
      );
      await assertRejects(() =>
        sql`UPDATE api_idempotency_requests SET replay_reserved_bytes=-1 WHERE id=${inProgress}`
      );
      await assertRejects(() =>
        sql`UPDATE api_idempotency_requests SET replay_reserved_events=-1 WHERE id=${completed}`
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
