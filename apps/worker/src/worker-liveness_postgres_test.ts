import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import {
  type ObjectStore,
  PostgresRepository,
  type PutObjectInput,
  type StoredObject,
} from "@dg-chat/database";
import {
  markClaimedJobProgressOrNeutralDefer,
  newWorkerIdentity,
  parseWorkerLivenessConfig,
  probeWorkerHealth,
  WorkerInstanceLostError,
  WorkerLivenessTracker,
} from "./worker-liveness.ts";
import { claimJob, deferJob } from "./job-queue.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

class ProbeStore implements ObjectStore {
  readonly implementation = "s3" as const;
  constructor(private result: boolean | "hang") {}
  put(_input: PutObjectInput): Promise<{ etag: string | null }> {
    return Promise.resolve({ etag: null });
  }
  get(_key: string): Promise<StoredObject | undefined> {
    return Promise.resolve(undefined);
  }
  delete(_key: string): Promise<void> {
    return Promise.resolve();
  }
  readiness(signal?: AbortSignal): Promise<boolean> {
    if (this.result === "hang") {
      return new Promise((resolve) =>
        signal?.addEventListener("abort", () => resolve(false), { once: true })
      );
    }
    return Promise.resolve(this.result);
  }
  close() {}
}

Deno.test({
  name: "worker instances coexist, expose stalls, and durably drain without cross-replica writes",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const config = parseWorkerLivenessConfig({
      WORKER_HEARTBEAT_INTERVAL_MS: "250",
      // This integration test performs several independent database round trips between liveness
      // writes. Use the supported upper bounds so host/CI contention cannot manufacture a stale
      // worker; explicit timestamp rewrites below still exercise both stale classifications.
      WORKER_HEARTBEAT_STALE_MS: "300000",
      WORKER_PROGRESS_STALE_MS: "3600000",
      WORKER_HEALTH_TIMEOUT_MS: "500",
      WORKER_INSTANCE_RETENTION_HOURS: "1",
    });
    const firstIdentity = newWorkerIdentity("replica-shared");
    const secondIdentity = newWorkerIdentity("replica-shared");
    const first = new WorkerLivenessTracker(sql, firstIdentity, config);
    const second = new WorkerLivenessTracker(sql, secondIdentity, config);
    const claimedJobId = crypto.randomUUID();
    try {
      await first.register();
      await second.register();
      await first.markRunning();
      await second.markRunning();
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM worker_instances
          WHERE worker_name='replica-shared' AND state='running'`)[0].count,
        2,
      );
      const repository = await PostgresRepository.connect(databaseUrl!, {
        conversationSearch: false,
        poolMax: 1,
      });
      try {
        const fleet = await repository.listWorkerInstances();
        const publicFirst = fleet.items.find((worker) =>
          worker.instanceId === firstIdentity.instanceId
        );
        assertEquals(publicFirst?.workerName, "replica-shared");
        assertEquals(publicFirst?.heartbeatAgeMs !== undefined, true);
        assertEquals(publicFirst?.heartbeatStaleMs, 300_000);
        assertEquals(publicFirst?.progressStaleMs, 3_600_000);
        assertEquals(publicFirst?.healthClockToleranceMs, 5_000);
        assertEquals(JSON.stringify(publicFirst).includes("claimToken"), false);
      } finally {
        await repository.close();
      }

      const jobId = crypto.randomUUID();
      await first.markProgress({ id: jobId, type: "attachment.ingest" });
      assertEquals(
        [
          ...await sql`SELECT current_job_id::text,current_job_type FROM worker_instances
          WHERE instance_id=${firstIdentity.instanceId}`,
        ],
        [{ current_job_id: jobId, current_job_type: "attachment.ingest" }],
      );
      await first.markProgress(undefined, true);
      assertEquals(
        [
          ...await sql`SELECT current_job_id,last_completed_job_id::text,last_completed_job_type,
          last_completed_at IS NOT NULL AS completed FROM worker_instances
          WHERE instance_id=${firstIdentity.instanceId}`,
        ],
        [{
          current_job_id: null,
          last_completed_job_id: jobId,
          last_completed_job_type: "attachment.ingest",
          completed: true,
        }],
      );
      const failedJobId = crypto.randomUUID();
      await first.markProgress({ id: failedJobId, type: "attachment.inspect" });
      await first.markProgress(undefined, false);
      assertEquals(
        [
          ...await sql`SELECT current_job_id,last_completed_job_id::text
          FROM worker_instances WHERE instance_id=${firstIdentity.instanceId}`,
        ],
        [{ current_job_id: null, last_completed_job_id: jobId }],
      );
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore(true),
          instanceId: firstIdentity.instanceId,
          config,
        }),
        true,
      );
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore(true),
          instanceId: crypto.randomUUID(),
          config,
        }),
        false,
      );
      await sql`UPDATE worker_instances SET heartbeat_at=clock_timestamp()+interval '2 seconds',
        progress_at=clock_timestamp()+interval '2 seconds'
        WHERE instance_id=${firstIdentity.instanceId}`;
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore(true),
          instanceId: firstIdentity.instanceId,
          config,
        }),
        true,
      );
      await sql`UPDATE worker_instances SET heartbeat_at=clock_timestamp()+interval '6 seconds',
        progress_at=clock_timestamp()+interval '6 seconds'
        WHERE instance_id=${firstIdentity.instanceId}`;
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore(true),
          instanceId: firstIdentity.instanceId,
          config,
        }),
        false,
      );
      await sql`UPDATE worker_instances SET heartbeat_at=now(),progress_at=now()
        WHERE instance_id=${firstIdentity.instanceId}`;
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore(false),
          instanceId: firstIdentity.instanceId,
          config,
        }),
        false,
      );
      const storageProbeStarted = performance.now();
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore("hang"),
          instanceId: firstIdentity.instanceId,
          config,
        }),
        false,
      );
      assertEquals(performance.now() - storageProbeStarted < 1_000, true);

      await sql`UPDATE worker_instances SET progress_at=now()-interval '3601 seconds',
        heartbeat_at=now() WHERE instance_id=${firstIdentity.instanceId}`;
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore(true),
          instanceId: firstIdentity.instanceId,
          config,
        }),
        false,
      );
      await sql`UPDATE worker_instances SET progress_at=now(),heartbeat_at=now()-interval '301 seconds'
        WHERE instance_id=${firstIdentity.instanceId}`;
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore(true),
          instanceId: firstIdentity.instanceId,
          config,
        }),
        false,
      );

      await second.markDraining();
      assertEquals(
        await probeWorkerHealth({
          sql,
          objectStore: new ProbeStore(true),
          instanceId: secondIdentity.instanceId,
          config,
        }),
        false,
      );
      await second.markStopped();
      assertEquals(
        [
          ...await sql`SELECT state,stopped_at IS NOT NULL AS stopped,current_job_id
          FROM worker_instances WHERE instance_id=${secondIdentity.instanceId}`,
        ],
        [{ state: "stopped", stopped: true, current_job_id: null }],
      );
      await assertRejects(
        () => second.markDraining(),
        WorkerInstanceLostError,
        "no longer owns",
      );

      await sql`DELETE FROM worker_instances WHERE instance_id=${firstIdentity.instanceId}`;
      await assertRejects(
        () => first.markProgress(),
        WorkerInstanceLostError,
        "no longer owns",
      );

      await sql`INSERT INTO jobs(id,type,payload,status,attempts,available_at)
        VALUES(${claimedJobId},'attachment.inspect','{}'::jsonb,'queued',0,to_timestamp(0))`;
      const claimed = await claimJob(sql, "liveness-fence-test", 60);
      if (!claimed || claimed.id !== claimedJobId) throw new Error("Expected test job claim");
      await assertRejects(() =>
        markClaimedJobProgressOrNeutralDefer({
          markProgress: () => first.markProgress({ id: claimed.id, type: claimed.type }),
          neutralDefer: () => deferJob(sql, claimed, 0),
        })
      );
      assertEquals(
        [...await sql`SELECT status,attempts,locked_by FROM jobs WHERE id=${claimedJobId}`],
        [{ status: "queued", attempts: 0, locked_by: null }],
      );

      const unavailable = postgres(databaseUrl!, { max: 1 });
      await unavailable.end();
      await assertRejects(() =>
        probeWorkerHealth({
          sql: unavailable,
          objectStore: new ProbeStore(true),
          instanceId: firstIdentity.instanceId,
          config,
        })
      );
    } finally {
      first.stopHeartbeat();
      second.stopHeartbeat();
      await sql`DELETE FROM jobs WHERE id=${claimedJobId}`;
      await sql`DELETE FROM worker_instances WHERE instance_id IN (
        ${firstIdentity.instanceId},${secondIdentity.instanceId})`;
      await sql.end();
    }
  },
});

Deno.test({
  name: "spawned worker serializes signal drain before terminal stopped state",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const workerName = `drain-${crypto.randomUUID()}`;
    const directory = await Deno.makeTempDir();
    const instanceFile = `${directory}/instance`;
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--unstable-worker-options", "--allow-all", "apps/worker/src/main.ts"],
      env: {
        ...Deno.env.toObject(),
        DATABASE_URL: databaseUrl!,
        S3_ENDPOINT: "http://127.0.0.1:1",
        S3_ALLOW_INSECURE: "true",
        S3_BUCKET: "worker-drain-test",
        S3_REGION: "us-east-1",
        S3_FORCE_PATH_STYLE: "true",
        WORKER_ID: workerName,
        WORKER_INSTANCE_FILE: instanceFile,
        WORKER_POLL_MS: "50",
        WORKER_HEARTBEAT_INTERVAL_MS: "250",
        WORKER_HEARTBEAT_STALE_MS: "1000",
        WORKER_PROGRESS_STALE_MS: "3000",
        WORKER_DATABASE_OPERATION_TIMEOUT_MS: "1000",
        WORKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS: "3000",
        KNOWLEDGE_EMBEDDING_BASE_URL: "",
        KNOWLEDGE_EMBEDDING_API_KEY: "",
        KNOWLEDGE_EMBEDDING_MODEL: "",
      },
      stdout: "null",
      stderr: "null",
    }).spawn();
    let instanceId: string | undefined;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await sql<{ instance_id: string; state: string }[]>`
          SELECT instance_id,state FROM worker_instances WHERE worker_name=${workerName}
          ORDER BY started_at DESC LIMIT 1`;
        if (rows[0]?.state === "running") {
          instanceId = rows[0].instance_id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!instanceId) throw new Error("Spawned worker did not become running");
      child.kill("SIGTERM");
      const status = await Promise.race([
        child.status,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Spawned worker did not stop")), 8_000)
        ),
      ]);
      assertEquals(status.success, true);
      assertEquals(
        [
          ...await sql`SELECT state,stopped_at IS NOT NULL AS stopped
          FROM worker_instances WHERE instance_id=${instanceId}`,
        ],
        [{ state: "stopped", stopped: true }],
      );
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* already stopped */ }
      await child.status.catch(() => undefined);
      await sql`DELETE FROM worker_instances WHERE worker_name=${workerName}`;
      await sql.end();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "worker fleet keyset pages isolate every active boot from larger stopped history",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    const prefix = `fleet-${crypto.randomUUID().slice(0, 8)}-`;
    const repository = await PostgresRepository.connect(databaseUrl!, {
      conversationSearch: false,
      poolMax: 1,
    });
    try {
      await sql`INSERT INTO worker_instances(instance_id,worker_name,state,started_at,
        heartbeat_at,progress_at,stopped_at)
        SELECT gen_random_uuid(),${prefix}||'active-'||n,'running',
          now()-interval '1 day'+n*interval '1 millisecond',now(),now(),NULL
        FROM generate_series(1,105) n`;
      await sql`INSERT INTO worker_instances(instance_id,worker_name,state,started_at,
        heartbeat_at,progress_at,stopped_at)
        SELECT gen_random_uuid(),${prefix}||'stopped-'||n,'stopped',
          now()+n*interval '1 millisecond',now(),now(),now()
        FROM generate_series(1,120) n`;
      await sql`UPDATE worker_instances SET heartbeat_at=now()-interval '30 seconds'
        WHERE worker_name=${prefix}||'active-1'`;
      await sql`UPDATE worker_instances SET progress_at=now()-interval '4 minutes'
        WHERE worker_name=${prefix}||'active-2'`;
      await sql`UPDATE worker_instances SET state='starting'
        WHERE worker_name IN (${prefix}||'active-4',${prefix}||'active-5',${prefix}||'active-6')`;
      await sql`UPDATE worker_instances SET heartbeat_at=now()-interval '30 seconds'
        WHERE worker_name=${prefix}||'active-5'`;
      await sql`UPDATE worker_instances SET progress_at=now()-interval '4 minutes'
        WHERE worker_name=${prefix}||'active-6'`;
      await sql`UPDATE worker_instances SET state='draining'
        WHERE worker_name IN (${prefix}||'active-7',${prefix}||'active-8',${prefix}||'active-9')`;
      await sql`UPDATE worker_instances SET heartbeat_at=now()-interval '30 seconds'
        WHERE worker_name=${prefix}||'active-8'`;
      await sql`UPDATE worker_instances SET progress_at=now()-interval '4 minutes'
        WHERE worker_name=${prefix}||'active-9'`;
      await sql`UPDATE worker_instances SET heartbeat_at=now()+interval '2 seconds',
        progress_at=now()+interval '2 seconds' WHERE worker_name=${prefix}||'active-10'`;
      await sql`UPDATE worker_instances SET heartbeat_at=now()+interval '6 seconds',
        progress_at=now()+interval '6 seconds' WHERE worker_name=${prefix}||'active-11'`;

      const first = await repository.listWorkerInstances({ scope: "active", limit: 100 });
      assertEquals(first.items.length, 100);
      assertEquals(first.items.every((worker) => worker.state !== "stopped"), true);
      assertEquals(first.hasMore, true);
      const second = await repository.listWorkerInstances({
        scope: "active",
        limit: 100,
        cursor: first.nextCursor!,
      });
      assertEquals(second.items.length, 5);
      assertEquals(second.hasMore, false);
      const active = [...first.items, ...second.items];
      assertEquals(new Set(active.map((worker) => worker.instanceId)).size, 105);
      assertEquals(
        active.find((worker) => worker.workerName === `${prefix}active-1`)?.liveness,
        "heartbeat_stale",
      );
      assertEquals(
        active.find((worker) => worker.workerName === `${prefix}active-2`)?.liveness,
        "progress_stalled",
      );
      assertEquals(
        active.find((worker) => worker.workerName === `${prefix}active-3`)?.liveness,
        "fresh",
      );
      for (
        const [ordinal, state, liveness] of [
          [4, "starting", "fresh"],
          [5, "starting", "heartbeat_stale"],
          [6, "starting", "progress_stalled"],
          [7, "draining", "fresh"],
          [8, "draining", "heartbeat_stale"],
          [9, "draining", "progress_stalled"],
          [10, "running", "fresh"],
          [11, "running", "heartbeat_stale"],
        ] as const
      ) {
        const worker = active.find((item) => item.workerName === `${prefix}active-${ordinal}`);
        assertEquals([worker?.state, worker?.liveness], [state, liveness]);
      }

      const history = await repository.listWorkerInstances({ scope: "history", limit: 100 });
      assertEquals(history.items.length, 100);
      assertEquals(history.items.every((worker) => worker.liveness === "inactive"), true);
      assertEquals(history.hasMore, true);
      await assertRejects(() =>
        repository.listWorkerInstances({ scope: "history", cursor: first.nextCursor! })
      );
      await assertRejects(() =>
        repository.listWorkerInstances({ scope: "active", cursor: "not-a-cursor" })
      );
    } finally {
      await sql`DELETE FROM worker_instances WHERE worker_name LIKE ${prefix + "%"}`;
      await repository.close();
      await sql.end();
    }
  },
});
