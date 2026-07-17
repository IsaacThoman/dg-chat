import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import {
  BACKUP_DATA_SCHEMA_VERSION,
  type BackupDataBatch,
  type BackupDataSource,
  dryRunBackupData,
  withRepeatableReadBackupSnapshot,
} from "./backup-data.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "concurrent usage and admin adjustment retain causal ledger, pagination, and backup order",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 4 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        `TRUNCATE admin_balance_adjustments,audit_events,ledger_entries,api_tokens,
          auth_verifications,auth_sessions,auth_accounts,auth_users,sessions,users
          RESTART IDENTITY CASCADE`,
      );
      await sql`INSERT INTO installation_state(singleton_id) VALUES(1)
        ON CONFLICT(singleton_id) DO NOTHING`;
      const actorId = crypto.randomUUID();
      const targetId = crypto.randomUUID();
      await sql`INSERT INTO users(
        id,email,name,role,approval_status,state,balance_micros,email_verified_at)
        VALUES(${actorId},'sequence-admin@example.com','Sequence Admin','admin','approved','active',0,now()),
          (${targetId},'sequence-target@example.com','Sequence Target','user','approved','active',1000,now())`;
      await sql`INSERT INTO ledger_entries(
        user_id,usage_run_id,kind,amount_micros,balance_after_micros,created_at)
        VALUES(${targetId},'sequence-opening-grant','grant',1000,1000,
          '2026-01-01T00:00:00Z')`;

      let releaseUsage!: () => void;
      const usageMayCommit = new Promise<void>((resolve) => releaseUsage = resolve);
      let usageInserted!: () => void;
      const usageHasInserted = new Promise<void>((resolve) => usageInserted = resolve);
      let usageBackendPid = 0;
      const usage = sql.begin(async (tx) => {
        usageBackendPid = Number((await tx`SELECT pg_backend_pid() pid`)[0].pid);
        await tx`UPDATE users SET balance_micros=900 WHERE id=${targetId}`;
        await tx`INSERT INTO ledger_entries(
          user_id,usage_run_id,kind,amount_micros,balance_after_micros,created_at)
          VALUES(${targetId},'sequence-concurrent-usage','reserve',-100,900,
            '2099-01-01T00:00:00Z')`;
        usageInserted();
        await usageMayCommit;
      });
      await usageHasInserted;

      let adjustmentSettled = false;
      const adjustment = repository.adjustAdminUserBalance({
        actorId,
        targetUserId: targetId,
        amountMicros: 50,
        expectedBalanceMicros: 900,
        idempotencyKeyHash: "9".repeat(64),
        requestHash: "a".repeat(64),
        reason: "Concurrent causal-order test",
      }).finally(() => adjustmentSettled = true);
      const blockedDeadline = Date.now() + 5_000;
      let observedBlocked = false;
      while (Date.now() < blockedDeadline) {
        const blocked = await sql`SELECT 1 FROM pg_stat_activity
          WHERE ${usageBackendPid}=ANY(pg_blocking_pids(pid)) LIMIT 1`;
        if (blocked.length) {
          observedBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseUsage();
      assertEquals(observedBlocked, true, "adjustment must wait on the usage user-row lock");
      assertEquals(adjustmentSettled, false);
      await usage;
      const adjusted = await adjustment;
      assertEquals(adjusted.balanceAfterMicros, 950);

      const ledger = await repository.listLedger(targetId);
      assertEquals(
        ledger.map((entry) => ({
          sequence: entry.sequence,
          amount: entry.amountMicros,
          balance: entry.balanceAfterMicros,
        })),
        [
          { sequence: 1, amount: 1000, balance: 1000 },
          { sequence: 2, amount: -100, balance: 900 },
          { sequence: 3, amount: 50, balance: 950 },
        ],
      );
      assertEquals(Date.parse(ledger[1].createdAt) > Date.parse(ledger[2].createdAt), true);

      const firstPage = await repository.listAdminUserLedger(actorId, targetId, { limit: 2 });
      assertEquals(firstPage.data.map((entry) => entry.sequence), [3, 2]);
      assertExists(firstPage.nextCursor);
      const secondPage = await repository.listAdminUserLedger(actorId, targetId, {
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      assertEquals(secondPage.data.map((entry) => entry.sequence), [1]);

      const captured = new Map<string, BackupDataBatch[]>();
      await withRepeatableReadBackupSnapshot(databaseUrl!, async (source) => {
        for (const definition of source.tables) {
          const batches: BackupDataBatch[] = [];
          for await (const batch of source.rows(definition.name)) {
            batches.push(structuredClone(batch));
          }
          captured.set(definition.name, batches);
        }
      }, { diagnosticPolicy: "included" });
      const source: BackupDataSource = {
        schemaVersion: BACKUP_DATA_SCHEMA_VERSION,
        rows(name) {
          return (async function* () {
            for (const batch of captured.get(name) ?? []) yield structuredClone(batch);
          })();
        },
      };
      const preview = await dryRunBackupData(databaseUrl!, source);
      assertEquals(preview.users, 2);
    } finally {
      await repository.close();
      await sql.end({ timeout: 5 });
    }
  },
});
