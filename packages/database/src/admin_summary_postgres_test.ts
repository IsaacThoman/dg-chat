import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres admin summary returns constant-size aggregates without a ledger scan",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE audit_events,ledger_entries,usage_runs,api_tokens,sessions,messages,
        conversations,auth_sessions,auth_accounts,auth_verifications,auth_users,users
        RESTART IDENTITY CASCADE`,
    );
    try {
      const first = await repository.bootstrapAdmin({
        email: "admin-summary-postgres@example.test",
        name: "Summary administrator",
        passwordHash: "test",
      }, 100);
      const second = await repository.createUser({
        email: "admin-summary-postgres-user@example.test",
        name: "Summary user",
        passwordHash: "test",
      });
      await repository.decideUserApproval({
        actorId: first.id,
        expectedAuthorityEpoch: 1,
        targetUserId: second.id,
        expectedVersion: second.version,
        status: "approved",
        startingCreditMicros: 200,
      });
      await repository.reserve(first.id, "admin-summary-postgres-run", "test/model", 50);
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM ledger_entries`)[0].count,
        3,
      );
      assertEquals("listAllLedger" in repository, false);
      assertEquals(await repository.adminSummary(), {
        calls: 1,
        users: 2,
        balanceMicros: 250,
      });
      await sql`UPDATE users SET balance_micros=9007199254740991`;
      await assertRejects(
        () => repository.adminSummary(),
        Error,
        "Administrative usage summary exceeds safe integer bounds",
      );
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
