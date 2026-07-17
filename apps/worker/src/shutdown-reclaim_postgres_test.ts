import { assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { claimJob, completeJob } from "./job-queue.ts";
import { operationSignal, raceAbort } from "./operation-signal.ts";
import { runResilientLoop } from "./resilient-loop.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for worker state");
}

async function childStatusWithin(
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<Deno.CommandStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.status,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Blocked worker did not stop within its budget")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test({
  name: "shutdown cancels active work without settling its claim and the lease remains reclaimable",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const id = crypto.randomUUID();
    try {
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key)
        VALUES(${id},'shutdown.test',${sql.json({ id })},${`shutdown.test:${id}`})`;
      const first = await claimJob(sql, "shutdown-worker", 60);
      if (!first) throw new Error("test job was not claimed");

      const shutdown = new AbortController();
      let operationStarted!: () => void;
      const started = new Promise<void>((resolve) => operationStarted = resolve);
      const loop = runResilientLoop({
        signal: shutdown.signal,
        policy: { initialDelayMs: 10, maxDelayMs: 10 },
        iteration: async () => {
          operationStarted();
          const operation = operationSignal(shutdown.signal, Date.now() + 60_000);
          try {
            await raceAbort(new Promise<never>(() => {}), operation.signal);
            await completeJob(sql, first);
          } finally {
            operation.dispose();
          }
        },
      });
      await started;
      const before = performance.now();
      shutdown.abort(new DOMException("Worker stopping", "AbortError"));
      await loop;
      if (performance.now() - before > 1_000) throw new Error("Worker shutdown was not bounded");

      const retained = await sql<{ status: string; locked_by: string | null }[]>`
        SELECT status,locked_by FROM jobs WHERE id=${id}`;
      assertEquals(retained[0], { status: "running", locked_by: first.claimToken });

      await sql`UPDATE jobs SET locked_at=now() - interval '61 seconds' WHERE id=${id}`;
      const replacement = await claimJob(sql, "replacement-worker", 60);
      if (!replacement) throw new Error("cancelled claim was not reclaimable");
      assertNotEquals(replacement.claimToken, first.claimToken);
      assertEquals(replacement.attempts, 1);
      assertEquals(await completeJob(sql, first), false);
      assertEquals(await completeJob(sql, replacement), true);
    } finally {
      await sql`DELETE FROM jobs WHERE id=${id}`;
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "spawned worker bounds a blocked PostgreSQL handler on shutdown and neutrally restores attempts",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const locker = postgres(databaseUrl!, { max: 1 });
    const userId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    let releaseLock!: () => void;
    const release = new Promise<void>((resolve) => releaseLock = resolve);
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => lockAcquired = resolve);
    let child: Deno.ChildProcess | undefined;
    let lockTransaction: Promise<unknown> | undefined;
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,state)
        VALUES(${userId},${`${userId}@blocked-worker.test`},'Blocked worker','hash','admin',
          'approved','active')`;
      await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,
        sha256,state,ingestion_status) VALUES(${attachmentId},${userId},
          ${`users/${userId}/blocked.txt`},'blocked.txt','text/plain',1,${"a".repeat(64)},
          'ready','not_applicable')`;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key)
        VALUES(${jobId},'attachment.inspect',${sql.json({ attachmentId, ownerId: userId })},
          ${`blocked-worker:${jobId}`})`;

      lockTransaction = locker.begin(async (tx) => {
        await tx`LOCK TABLE attachments IN ACCESS EXCLUSIVE MODE`;
        lockAcquired();
        await release;
      });
      await acquired;
      child = new Deno.Command(Deno.execPath(), {
        cwd: new URL("../../..", import.meta.url),
        args: ["run", "--allow-all", "apps/worker/src/main.ts"],
        env: {
          ...Deno.env.toObject(),
          DATABASE_URL: databaseUrl!,
          WORKER_ID: `blocked-worker-${jobId}`,
          WORKER_POLL_MS: "10",
          WORKER_DATABASE_OPERATION_TIMEOUT_MS: "250",
          WORKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS: "1000",
          S3_BUCKET: "blocked-worker-test",
          S3_ENDPOINT: "http://127.0.0.1:1",
          S3_ALLOW_INSECURE: "true",
          S3_ACCESS_KEY: "test",
          S3_SECRET_KEY: "test-secret",
        },
        stdout: "null",
        stderr: "null",
      }).spawn();
      await eventually(async () =>
        Boolean(
          (await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${jobId}`)[0]
            ?.status === "running",
        )
      );

      const started = performance.now();
      child.kill("SIGTERM");
      const status = await childStatusWithin(child, 3_000);
      assertEquals(status.success, true);
      child = undefined;
      if (performance.now() - started > 2_500) {
        throw new Error("Blocked PostgreSQL shutdown exceeded its bounded settlement window");
      }
      const [job] = await sql<{
        status: string;
        attempts: number;
        locked_by: string | null;
        last_error: string | null;
      }[]>`SELECT status,attempts,locked_by,last_error FROM jobs WHERE id=${jobId}`;
      assertEquals(job, { status: "queued", attempts: 0, locked_by: null, last_error: null });
    } finally {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited between the assertion failure and cleanup.
        }
        await child.status.catch(() => undefined);
      }
      releaseLock?.();
      await lockTransaction?.catch(() => undefined);
      await sql`DELETE FROM jobs WHERE id=${jobId}`;
      await sql`DELETE FROM attachments WHERE id=${attachmentId}`;
      await sql`DELETE FROM users WHERE id=${userId}`;
      await Promise.all([locker.end(), sql.end()]);
    }
  },
});

Deno.test({
  name: "worker neutrally defers its PostgreSQL statement timeout and stays alive",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 2 });
    const locker = postgres(databaseUrl!, { max: 1 });
    const userId = crypto.randomUUID();
    const blockedAttachmentId = crypto.randomUUID();
    const healthyAttachmentId = crypto.randomUUID();
    const blockedJobId = crypto.randomUUID();
    const healthyJobId = crypto.randomUUID();
    let releaseLock!: () => void;
    const release = new Promise<void>((resolve) => releaseLock = resolve);
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => lockAcquired = resolve);
    let child: Deno.ChildProcess | undefined;
    let lockTransaction: Promise<unknown> | undefined;
    try {
      await sql`INSERT INTO users(id,email,name,password_hash,role,approval_status,state)
        VALUES(${userId},${`${userId}@timeout-worker.test`},'Timeout worker','hash','admin',
          'approved','active')`;
      for (
        const [id, name, digest] of [
          [blockedAttachmentId, "blocked.txt", "b".repeat(64)],
          [healthyAttachmentId, "healthy.txt", "c".repeat(64)],
        ]
      ) {
        await sql`INSERT INTO attachments(id,owner_id,object_key,filename,mime_type,size_bytes,
          sha256,state,ingestion_status) VALUES(${id},${userId},${`users/${userId}/${name}`},
          ${name},'text/plain',1,${digest},'ready','not_applicable')`;
      }
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key,created_at)
        VALUES(${blockedJobId},'attachment.inspect',${
        sql.json({ attachmentId: blockedAttachmentId, ownerId: userId })
      },${`timeout-worker:${blockedJobId}`},now()-interval '1 day')`;

      lockTransaction = locker.begin(async (tx) => {
        await tx`LOCK TABLE attachments IN ACCESS EXCLUSIVE MODE`;
        lockAcquired();
        await release;
      });
      await acquired;
      child = new Deno.Command(Deno.execPath(), {
        cwd: new URL("../../..", import.meta.url),
        args: ["run", "--allow-all", "apps/worker/src/main.ts"],
        env: {
          ...Deno.env.toObject(),
          DATABASE_URL: databaseUrl!,
          WORKER_ID: `timeout-worker-${blockedJobId}`,
          WORKER_POLL_MS: "10",
          WORKER_DATABASE_OPERATION_TIMEOUT_MS: "150",
          WORKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS: "1000",
          S3_BUCKET: "timeout-worker-test",
          S3_ENDPOINT: "http://127.0.0.1:1",
          S3_ALLOW_INSECURE: "true",
          S3_ACCESS_KEY: "test",
          S3_SECRET_KEY: "test-secret",
        },
        stdout: "null",
        stderr: "null",
      }).spawn();
      await eventually(async () =>
        (await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${blockedJobId}`)[0]
          ?.status === "running"
      );
      await eventually(async () => {
        const [job] = await sql<{ status: string; attempts: number }[]>`
          SELECT status,attempts FROM jobs WHERE id=${blockedJobId}`;
        return job?.status === "queued" && job.attempts === 0;
      });

      releaseLock();
      await lockTransaction;
      lockTransaction = undefined;
      await sql`INSERT INTO jobs(id,type,payload,idempotency_key,created_at)
        VALUES(${healthyJobId},'attachment.inspect',${
        sql.json({ attachmentId: healthyAttachmentId, ownerId: userId })
      },${`timeout-worker:${healthyJobId}`},now()-interval '12 hours')`;
      await eventually(async () =>
        (await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${healthyJobId}`)[0]
          ?.status === "completed"
      );
      const [blocked] = await sql<{ status: string; attempts: number }[]>`
        SELECT status,attempts FROM jobs WHERE id=${blockedJobId}`;
      assertEquals(blocked, { status: "queued", attempts: 0 });

      child.kill("SIGTERM");
      const status = await childStatusWithin(child, 3_000);
      assertEquals(status.success, true);
      child = undefined;
    } finally {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited between the assertion failure and cleanup.
        }
        await child.status.catch(() => undefined);
      }
      releaseLock?.();
      await lockTransaction?.catch(() => undefined);
      await sql`DELETE FROM jobs WHERE id IN (${blockedJobId},${healthyJobId})`;
      await sql`DELETE FROM attachments WHERE id IN (${blockedAttachmentId},${healthyAttachmentId})`;
      await sql`DELETE FROM users WHERE id=${userId}`;
      await Promise.all([locker.end(), sql.end()]);
    }
  },
});
