import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  abortableDelay,
  boundedBackoffDelay,
  isJobLocalDatabaseError,
  isTransientDatabaseError,
  isWorkerRetryableDatabaseError,
  retryWithBoundedBackoff,
  runDatabaseOperation,
  runResilientLoop,
} from "./resilient-loop.ts";

const policy = { initialDelayMs: 100, maxDelayMs: 250, multiplier: 2 };

Deno.test("bounded worker backoff grows exponentially and caps without overflowing", () => {
  assertEquals([1, 2, 3, 4, 1_000].map((attempt) => boundedBackoffDelay(attempt, policy)), [
    100,
    200,
    250,
    250,
    250,
  ]);
});

Deno.test("database retry classification accepts connectivity faults but rejects permanent faults", async () => {
  assertEquals(
    isTransientDatabaseError(Object.assign(new Error("lookup"), { code: "ENOTFOUND" })),
    false,
  );
  const markedLookup = await awaitError(() =>
    runDatabaseOperation(() =>
      Promise.reject(Object.assign(new Error("lookup"), { code: "ENOTFOUND" }))
    )
  );
  assertEquals(isTransientDatabaseError(markedLookup), true);
  assertEquals(isTransientDatabaseError({ code: "08006", message: "connection failure" }), false);
  assertEquals(
    isTransientDatabaseError(
      await awaitError(() =>
        runDatabaseOperation(() => Promise.reject({ code: "08006", message: "connection failure" }))
      ),
    ),
    true,
  );
  assertEquals(
    isTransientDatabaseError(new AggregateError([{ code: "ECONNREFUSED" }], "connect failed")),
    false,
  );
  assertEquals(isTransientDatabaseError({ code: "08004", message: "connection rejected" }), false);
  assertEquals(isTransientDatabaseError({ code: "08P01", message: "protocol violation" }), false);
  assertEquals(isTransientDatabaseError({ code: "53400", message: "configuration limit" }), false);
  assertEquals(
    isTransientDatabaseError({ code: "28P01", message: "password authentication failed" }),
    false,
  );
  assertEquals(isTransientDatabaseError(new Error("relation jobs does not exist")), false);
});

Deno.test("database provenance preserves domain errors and retries only safe class-40 states", async () => {
  const domain = Object.assign(new Error("insufficient credit"), { code: "insufficient_credit" });
  assertEquals(await awaitError(() => runDatabaseOperation(() => Promise.reject(domain))), domain);
  for (const code of ["40001", "40P01"]) {
    const marked = await awaitError(() => runDatabaseOperation(() => Promise.reject({ code })));
    assertEquals(isTransientDatabaseError(marked), true);
  }
});

Deno.test("only worker-marked statement timeout is retryable", async () => {
  const raw = { code: "57014", message: "canceling statement due to statement timeout" };
  assertEquals(isWorkerRetryableDatabaseError(raw), false);
  const marked = await awaitError(() => runDatabaseOperation(() => Promise.reject(raw)));
  assertEquals(isTransientDatabaseError(marked), false);
  assertEquals(isWorkerRetryableDatabaseError(marked), true);
  const externallyCancelled = await awaitError(() =>
    runDatabaseOperation(() =>
      Promise.reject({ code: "57014", message: "canceling statement due to user request" })
    )
  );
  assertEquals(isWorkerRetryableDatabaseError(externallyCancelled), false);
});

Deno.test("database classification isolates job-local data and constraint SQLSTATEs", async () => {
  for (const code of ["22000", "22001", "23503", "23505", "23514", "44000"]) {
    const marked = await awaitError(() => runDatabaseOperation(() => Promise.reject({ code })));
    assertEquals(isJobLocalDatabaseError(marked), true, code);
    assertEquals(isTransientDatabaseError(marked), false, code);
  }
  for (const code of ["08004", "08P01", "28P01", "3D000", "42P01", "42501", "53400"]) {
    const marked = await awaitError(() => runDatabaseOperation(() => Promise.reject({ code })));
    assertEquals(isJobLocalDatabaseError(marked), false, code);
    assertEquals(isTransientDatabaseError(marked), false, code);
  }
  const mixed = await awaitError(() =>
    runDatabaseOperation(() =>
      Promise.reject(new AggregateError([{ code: "23505" }, { code: "42P01" }], "mixed failure"))
    )
  );
  assertEquals(isJobLocalDatabaseError(mixed), false);
});

Deno.test("worker backoff rejects timer-overflow configuration", () => {
  let rejected = false;
  try {
    boundedBackoffDelay(1, { initialDelayMs: 1, maxDelayMs: 2_147_483_648 });
  } catch (error) {
    rejected = error instanceof TypeError;
  }
  assertEquals(rejected, true);
});

async function awaitError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject");
}

Deno.test("worker backoff applies only downward injectable jitter", () => {
  const jittered = { ...policy, jitterRatio: 0.25 };
  assertEquals(boundedBackoffDelay(1, jittered, () => 0), 100);
  assertEquals(boundedBackoffDelay(1, jittered, () => 0.5), 87);
  assertEquals(boundedBackoffDelay(4, jittered, () => 1), 187);
});

Deno.test("startup retry survives transient failures with deterministic bounded delays", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  const notices: unknown[] = [];
  let calls = 0;
  const value = await retryWithBoundedBackoff({
    operation: () => {
      calls += 1;
      if (calls < 4) return Promise.reject(new Error("transient database failure"));
      return Promise.resolve("connected");
    },
    signal: controller.signal,
    policy,
    onRetry: (notice) => notices.push(notice),
    sleep: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
  });
  assertEquals(value, "connected");
  assertEquals(calls, 4);
  assertEquals(delays, [100, 200, 250]);
  assertEquals(notices, [
    { attempt: 1, delayMs: 100 },
    { attempt: 2, delayMs: 200 },
    { attempt: 3, delayMs: 250 },
  ]);
});

Deno.test("startup retry stops during backoff without another connection attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assertRejects(
    () =>
      retryWithBoundedBackoff({
        operation: () => {
          calls += 1;
          return Promise.reject(new Error("database unavailable"));
        },
        signal: controller.signal,
        policy,
        sleep: (_delayMs, signal) => {
          controller.abort(new DOMException("Worker stopping", "AbortError"));
          signal.throwIfAborted();
          return Promise.resolve();
        },
      }),
    DOMException,
    "Worker stopping",
  );
  assertEquals(calls, 1);
});

Deno.test("startup retry immediately surfaces permanent failures", async () => {
  const delays: number[] = [];
  await assertRejects(
    () =>
      retryWithBoundedBackoff({
        operation: () =>
          Promise.reject(Object.assign(new Error("bad password"), { code: "28P01" })),
        signal: new AbortController().signal,
        policy,
        shouldRetry: isTransientDatabaseError,
        sleep: (delayMs) => {
          delays.push(delayMs);
          return Promise.resolve();
        },
      }),
    Error,
    "bad password",
  );
  assertEquals(delays, []);
});

Deno.test("runtime loop backs off, resets after recovery, and exits on shutdown", async () => {
  const controller = new AbortController();
  const outcomes = ["fail", "fail", "ok", "fail", "stop"];
  const delays: number[] = [];
  let calls = 0;
  await runResilientLoop({
    iteration: () => {
      const outcome = outcomes[calls++];
      if (outcome === "fail") return Promise.reject(new Error("postgres DNS unavailable"));
      if (outcome === "stop") controller.abort();
      return Promise.resolve();
    },
    signal: controller.signal,
    policy,
    sleep: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
  });
  assertEquals(calls, 5);
  assertEquals(delays, [100, 200, 100]);
});

Deno.test("runtime loop does not conceal permanent application failures", async () => {
  let sleeps = 0;
  await assertRejects(
    () =>
      runResilientLoop({
        iteration: () => Promise.reject(new Error("unsupported durable job type")),
        signal: new AbortController().signal,
        policy,
        shouldRetry: isTransientDatabaseError,
        sleep: () => {
          sleeps += 1;
          return Promise.resolve();
        },
      }),
    Error,
    "unsupported durable job type",
  );
  assertEquals(sleeps, 0);
});

Deno.test("real abortable delay clears promptly on shutdown", async () => {
  const controller = new AbortController();
  const waiting = abortableDelay(60_000, controller.signal);
  controller.abort(new DOMException("Worker stopping", "AbortError"));
  await assertRejects(() => waiting, DOMException, "Worker stopping");
});
