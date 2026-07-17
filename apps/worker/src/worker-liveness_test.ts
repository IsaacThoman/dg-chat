import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  evaluateWorkerHealth,
  markClaimedJobProgressOrNeutralDefer,
  newWorkerIdentity,
  parseWorkerLivenessConfig,
  readWorkerInstanceFile,
  writeWorkerInstanceFile,
} from "./worker-liveness.ts";

const config = { heartbeatStaleMs: 20_000, progressStaleMs: 180_000 };
const now = new Date("2026-07-16T12:00:00.000Z");
const snapshot = {
  instanceId: crypto.randomUUID(),
  workerName: "worker-a",
  state: "running" as const,
  heartbeatAt: new Date(now.getTime() - 1_000),
  progressAt: new Date(now.getTime() - 2_000),
  currentJobId: null,
  currentJobType: null,
  lastCompletedAt: null,
  lastCompletedJobId: null,
  lastCompletedJobType: null,
};

Deno.test("worker health independently rejects stale heartbeat and stalled progress", () => {
  assertEquals(evaluateWorkerHealth(snapshot, now, config), true);
  assertEquals(
    evaluateWorkerHealth(
      {
        ...snapshot,
        heartbeatAt: new Date(now.getTime() - 20_001),
      },
      now,
      config,
    ),
    false,
  );
  assertEquals(
    evaluateWorkerHealth(
      {
        ...snapshot,
        progressAt: new Date(now.getTime() - 180_001),
      },
      now,
      config,
    ),
    false,
  );
  assertEquals(evaluateWorkerHealth({ ...snapshot, state: "draining" }, now, config), false);
  assertEquals(evaluateWorkerHealth(undefined, now, config), false);
});

Deno.test("worker liveness configuration is bounded and preserves separate thresholds", () => {
  assertEquals(parseWorkerLivenessConfig({}), {
    heartbeatIntervalMs: 5_000,
    heartbeatStaleMs: 20_000,
    progressStaleMs: 180_000,
    healthTimeoutMs: 4_000,
    healthClockToleranceMs: 5_000,
    historyRetentionHours: 168,
    instanceFile: "/tmp/dg-chat-worker-instance",
  });
  assertThrows(() =>
    parseWorkerLivenessConfig({
      WORKER_HEARTBEAT_INTERVAL_MS: "5000",
      WORKER_HEARTBEAT_STALE_MS: "9999",
    })
  );
  assertThrows(() => parseWorkerLivenessConfig({ WORKER_HEALTH_TIMEOUT_MS: "0" }));
});

Deno.test("post-claim liveness failure neutral-defers before propagating", async () => {
  const events: string[] = [];
  const failure = new Error("liveness write failed");
  const thrown = await assertRejects(() =>
    markClaimedJobProgressOrNeutralDefer({
      markProgress: () => {
        events.push("progress");
        return Promise.reject(failure);
      },
      neutralDefer: () => {
        events.push("defer");
        return Promise.resolve(true);
      },
    })
  );
  assertEquals(thrown, failure);
  assertEquals(events, ["progress", "defer"]);
});

Deno.test("boot instance file is atomic, strict, and unique per identity", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/instance`;
  try {
    const first = newWorkerIdentity("replica-a");
    const second = newWorkerIdentity("replica-a");
    assertEquals(first.instanceId === second.instanceId, false);
    await writeWorkerInstanceFile(path, first.instanceId);
    assertEquals(await readWorkerInstanceFile(path), first.instanceId);
    await Deno.writeTextFile(path, "not-an-instance\n");
    await assertRejects(() => readWorkerInstanceFile(path), Error, "invalid");
    assertThrows(() => newWorkerIdentity("unsafe worker name"));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: "worker publishes a new boot identity before retrying an unavailable database",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const directory = await Deno.makeTempDir();
    const path = `${directory}/instance`;
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--unstable-worker-options", "--allow-all", "apps/worker/src/main.ts"],
      env: {
        ...Deno.env.toObject(),
        DATABASE_URL: "postgresql://worker:invalid@127.0.0.1:1/unavailable",
        S3_ENDPOINT: "http://127.0.0.1:1",
        S3_ALLOW_INSECURE: "true",
        S3_BUCKET: "worker-boot-test",
        S3_REGION: "us-east-1",
        S3_FORCE_PATH_STYLE: "true",
        WORKER_ID: "boot-order-test",
        WORKER_INSTANCE_FILE: path,
        WORKER_DATABASE_RETRY_INITIAL_MS: "10",
        WORKER_DATABASE_RETRY_MAX_MS: "20",
      },
      stdout: "null",
      stderr: "null",
    }).spawn();
    const childStatus = child.status;
    try {
      let instanceId: string | undefined;
      const startupDeadline = performance.now() + 30_000;
      while (performance.now() < startupDeadline) {
        try {
          instanceId = await readWorkerInstanceFile(path);
          break;
        } catch {
          const exited = await Promise.race([
            childStatus.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
          ]);
          if (exited) break;
        }
      }
      assertEquals(typeof instanceId, "string");
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* process already exited */ }
      await Promise.race([
        childStatus,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      try {
        child.kill("SIGKILL");
      } catch { /* graceful stop completed */ }
      await childStatus.catch(() => undefined);
      await Deno.remove(directory, { recursive: true });
    }
  },
});
