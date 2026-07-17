import postgres from "npm:postgres@3.4.7";

const DISPOSABLE_DATABASE = /^dgchat_ci_[a-z0-9_]{1,30}_[a-z][a-z0-9_]{0,23}$/u;

function disposableTestDatabase(): string {
  if (Deno.env.get("DG_CHAT_ALLOW_DESTRUCTIVE_TEST_DATABASES") !== "true") {
    throw new Error("Audit test maintenance requires the destructive test database harness");
  }
  const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ""));
  if (!DISPOSABLE_DATABASE.test(database)) {
    throw new Error("Audit test maintenance requires a helper-owned disposable database");
  }
  return database;
}

/**
 * Runs fixture mutation in the database-enforced, transaction-local test-maintenance gate.
 *
 * The database function independently requires a PostgreSQL superuser and a helper-owned
 * disposable database. This caller-side check prevents an accidentally pointed test process from
 * even attempting the privileged operation against an installation database.
 */
export async function withAuditTestMaintenance<T>(
  sql: postgres.Sql,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  disposableTestDatabase();
  let result!: T;
  await sql.begin(async (tx) => {
    await tx`SELECT dg_chat_begin_audit_test_maintenance()`;
    result = await work(tx);
  });
  return result;
}

/** Executes a static fixture-maintenance statement inside the same guarded transaction. */
export async function runAuditTestMaintenanceSql(
  sql: postgres.Sql,
  statement: string,
): Promise<void> {
  await withAuditTestMaintenance(sql, async (tx) => {
    await tx.unsafe(statement);
  });
}
