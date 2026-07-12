import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "0028 upgrades a populated installation with durable restore fencing",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const schema = `backup_restore_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema},public`);
      await sql.unsafe(`
        CREATE TABLE users(
          id uuid PRIMARY KEY,
          email text NOT NULL UNIQUE,
          name text NOT NULL
        );
        CREATE TABLE conversations(id uuid PRIMARY KEY, title text NOT NULL);
        CREATE TABLE auth_sessions(id text PRIMARY KEY, token text NOT NULL);
        CREATE TABLE jobs(id uuid PRIMARY KEY, status text NOT NULL);
        CREATE TABLE ledger_entries(id uuid PRIMARY KEY, amount_micros bigint NOT NULL);
      `);
      const actorId = crypto.randomUUID();
      await sql`INSERT INTO users(id,email,name)
        VALUES(${actorId},'backup-admin@example.com','Backup Admin')`;
      const migration = await Deno.readTextFile(
        new URL("../migrations/0028_backup_restore.sql", import.meta.url),
      );
      await sql.unsafe(migration);

      const [state] = await sql<{
        installation_id: string;
        maintenance_enabled: boolean;
        version: number;
        restore_epoch: string;
      }[]>`SELECT installation_id,maintenance_enabled,version,restore_epoch
        FROM installation_state`;
      assertEquals(Boolean(state.installation_id), true);
      assertEquals(state.maintenance_enabled, false);
      assertEquals(state.version, 1);
      assertEquals(Number(state.restore_epoch), 0);
      assertEquals(Number((await sql`SELECT count(*) count FROM users`)[0].count), 1);

      const [operation] = await sql<{ id: string }[]>`
        INSERT INTO backup_operations(
          kind,actor_id,actor_email,actor_name,idempotency_key,options
        ) VALUES(
          'export',${actorId},'backup-admin@example.com','Backup Admin',
          'migration-export-1','{}'::jsonb
        ) RETURNING id
      `;
      await sql`DELETE FROM users WHERE id=${actorId}`;
      const [surviving] = await sql<{
        actor_id: string | null;
        actor_email: string;
        actor_name: string;
      }[]>`SELECT actor_id,actor_email,actor_name FROM backup_operations
        WHERE id=${operation.id}`;
      assertEquals(surviving, {
        actor_id: actorId,
        actor_email: "backup-admin@example.com",
        actor_name: "Backup Admin",
      });
      await assertRejects(() => sql`INSERT INTO installation_state(singleton_id) VALUES(2)`);
      await assertRejects(() =>
        sql`UPDATE backup_operations SET objects_processed=2,objects_total=1
          WHERE id=${operation.id}`
      );

      const [restore] = await sql<{ id: string }[]>`
        INSERT INTO backup_operations(
          kind,status,actor_id,actor_email,actor_name,idempotency_key,stage,started_at,options
        ) VALUES(
          'restore','running',${actorId},'backup-admin@example.com','Backup Admin',
          'migration-restore-fence','restore_staging',now(),'{}'::jsonb
        ) RETURNING id
      `;
      const concurrent = postgres(databaseUrl!, { max: 1 });
      try {
        await concurrent.unsafe(`SET search_path TO ${schema},public`);
        let inserted!: () => void;
        let release!: () => void;
        const insertionStarted = new Promise<void>((resolve) => inserted = resolve);
        const holdMutation = new Promise<void>((resolve) => release = resolve);
        const inFlight = concurrent.begin(async (tx) => {
          await tx`INSERT INTO conversations(id,title)
            VALUES(${crypto.randomUUID()},'in-flight conversation')`;
          inserted();
          await holdMutation;
        });
        await insertionStarted;
        let fenceAcquired = false;
        const acquireFence = sql`UPDATE installation_state SET maintenance_enabled=true,
          active_restore_id=${restore.id},version=version+1,updated_at=now()`
          .then(() => fenceAcquired = true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assertEquals(fenceAcquired, false);
        release();
        await inFlight;
        await acquireFence;
        assertEquals(fenceAcquired, true);
      } finally {
        await concurrent.end();
      }
      await assertRejects(
        () =>
          sql`INSERT INTO users(id,email,name)
            VALUES(${crypto.randomUUID()},'stale-write@example.com','Stale Write')`,
        Error,
        "restore maintenance",
      );
      for (
        const write of [
          () =>
            sql`INSERT INTO conversations(id,title)
            VALUES(${crypto.randomUUID()},'stale conversation')`,
          () => sql`INSERT INTO auth_sessions(id,token) VALUES('stale-session','secret')`,
          () => sql`INSERT INTO jobs(id,status) VALUES(${crypto.randomUUID()},'queued')`,
          () =>
            sql`INSERT INTO ledger_entries(id,amount_micros)
            VALUES(${crypto.randomUUID()},100)`,
        ]
      ) {
        await assertRejects(write, Error, "restore maintenance");
      }
      // The control plane must remain writable so recovery can finalize or fail the restore.
      await sql`UPDATE backup_operations SET updated_at=now() WHERE id=${restore.id}`;
      // A caller-controlled setting, even one naming the active operation, cannot bypass the
      // database fence without this backend's exact transaction-level restore lock.
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx`SELECT set_config('dg_chat.restore_bypass','on',true)`;
            await tx`INSERT INTO users(id,email,name)
              VALUES(${crypto.randomUUID()},'forged-setting@example.com','Forged Setting')`;
          }),
        Error,
        "restore maintenance",
      );
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx`SELECT set_config('dg_chat.restore_bypass',${restore.id},true)`;
            await tx`INSERT INTO users(id,email,name)
              VALUES(${crypto.randomUUID()},'missing-lock@example.com','Missing Lock')`;
          }),
        Error,
        "restore maintenance",
      );
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext('some-other-lock'))`;
            await tx`SELECT set_config('dg_chat.restore_bypass',${restore.id},true)`;
            await tx`INSERT INTO users(id,email,name)
              VALUES(${crypto.randomUUID()},'wrong-lock@example.com','Wrong Lock')`;
          }),
        Error,
        "restore maintenance",
      );
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-backup-restore'))`;
        await tx`SELECT set_config('dg_chat.restore_bypass',${restore.id},true)`;
        const [proof] = await tx<{ operation_matches: boolean; lock_matches: boolean }[]>`
          SELECT EXISTS(
            SELECT 1 FROM installation_state s JOIN backup_operations o
              ON o.id=s.active_restore_id
            WHERE s.singleton_id=1 AND s.maintenance_enabled=true
              AND s.active_restore_id=${restore.id} AND o.kind='restore'
              AND o.status='running' AND o.stage='restore_staging'
          ) operation_matches,
          EXISTS(
            SELECT 1 FROM pg_locks held WHERE held.locktype='advisory'
              AND held.pid=pg_backend_pid() AND held.granted=true
              AND held.mode='ExclusiveLock'
              AND held.classid::bigint =
                ((hashtext('dg-chat-backup-restore')::bigint >> 32) & 4294967295)
              AND held.objid::bigint =
                (hashtext('dg-chat-backup-restore')::bigint & 4294967295)
              AND held.objsubid=1
          ) lock_matches
        `;
        assertEquals(proof, { operation_matches: true, lock_matches: true });
        await tx`INSERT INTO users(id,email,name)
          VALUES(${crypto.randomUUID()},'restore-write@example.com','Restore Write')`;
      });
      await assertRejects(
        () =>
          sql`INSERT INTO users(id,email,name)
            VALUES(${crypto.randomUUID()},'leaked-bypass@example.com','Leaked Bypass')`,
        Error,
        "restore maintenance",
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
});
