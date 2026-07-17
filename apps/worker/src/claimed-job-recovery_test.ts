import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  JobClaimReclaimedError,
  retryClaimedDatabaseOperation,
  settleClaimedJobFault,
} from "./claimed-job-recovery.ts";
import {
  isWorkerRetryableDatabaseError,
  runDatabaseOperation,
  runResilientLoop,
} from "./resilient-loop.ts";

const policy = { initialDelayMs: 10, maxDelayMs: 40, jitterRatio: 0.25 };
const signal = new AbortController().signal;
const noWait = () => Promise.resolve();

async function capturedDatabaseFault(
  code: string,
  message = "database transport failed",
): Promise<unknown> {
  try {
    await runDatabaseOperation(() => Promise.reject(Object.assign(new Error(message), { code })));
  } catch (error) {
    return error;
  }
  throw new Error("Expected database operation to fail");
}

Deno.test("post-claim database faults defer neutrally and retry only fenced settlement", async () => {
  const fault = await capturedDatabaseFault("ECONNRESET");
  let neutralCalls = 0;
  let applicationCalls = 0;
  const delays: number[] = [];
  const result = await settleClaimedJobFault({
    fault,
    signal,
    policy,
    random: () => 1,
    sleep: (delay) => {
      delays.push(delay);
      return Promise.resolve();
    },
    neutralDefer: async () => {
      neutralCalls += 1;
      if (neutralCalls < 3) {
        await runDatabaseOperation(() =>
          Promise.reject(Object.assign(new Error("still unavailable"), { code: "08006" }))
        );
      }
      return true;
    },
    recordApplicationFailure: () => {
      applicationCalls += 1;
      return Promise.resolve(true);
    },
  });
  assertEquals(result, "database_fault_deferred");
  assertEquals(neutralCalls, 3);
  assertEquals(applicationCalls, 0);
  assertEquals(delays, [7, 15]);
});

Deno.test("worker statement timeout neutrally defers without consuming an attempt", async () => {
  const fault = await capturedDatabaseFault(
    "57014",
    "canceling statement due to statement timeout",
  );
  let neutralCalls = 0;
  let applicationCalls = 0;
  const result = await settleClaimedJobFault({
    fault,
    signal,
    policy,
    sleep: noWait,
    isRetryableDatabaseFault: isWorkerRetryableDatabaseError,
    neutralDefer: () => {
      neutralCalls += 1;
      return Promise.resolve(true);
    },
    recordApplicationFailure: () => {
      applicationCalls += 1;
      return Promise.resolve(true);
    },
  });
  assertEquals(result, "database_fault_deferred");
  assertEquals(neutralCalls, 1);
  assertEquals(applicationCalls, 0);
});

Deno.test("claimed database retry renews before each attempt without replaying external work", async () => {
  let renewals = 0;
  let databaseMutations = 0;
  let externalCalls = 0;
  const delays: number[] = [];
  externalCalls += 1; // The provider call is deliberately outside the retried database callback.
  const value = await retryClaimedDatabaseOperation(
    async () => {
      databaseMutations += 1;
      if (databaseMutations === 1) {
        await runDatabaseOperation(() =>
          Promise.reject(Object.assign(new Error("lost commit response"), { code: "ECONNRESET" }))
        );
      }
      return "settled";
    },
    () => {
      renewals += 1;
      return Promise.resolve(true);
    },
    {
      signal,
      policy,
      random: () => 0,
      sleep: (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
    },
  );
  assertEquals(value, "settled");
  assertEquals(renewals, 2);
  assertEquals(databaseMutations, 2);
  assertEquals(externalCalls, 1);
  assertEquals(delays, [10]);
});

Deno.test("claimed database retry stops before mutation after another replica reclaims", async () => {
  let mutations = 0;
  await assertRejects(
    () =>
      retryClaimedDatabaseOperation(
        () => {
          mutations += 1;
          return Promise.resolve();
        },
        () => Promise.resolve(false),
        { signal, policy, sleep: noWait },
      ),
    JobClaimReclaimedError,
  );
  assertEquals(mutations, 0);
});

Deno.test("unmarked S3 or provider ECONNRESET consumes the application attempt", async () => {
  let neutralCalls = 0;
  let applicationCalls = 0;
  const result = await settleClaimedJobFault({
    fault: Object.assign(new Error("upstream reset"), { code: "ECONNRESET" }),
    signal,
    policy,
    sleep: noWait,
    neutralDefer: () => {
      neutralCalls += 1;
      return Promise.resolve(true);
    },
    recordApplicationFailure: () => {
      applicationCalls += 1;
      return Promise.resolve(true);
    },
  });
  assertEquals(result, "application_failure_recorded");
  assertEquals(neutralCalls, 0);
  assertEquals(applicationCalls, 1);
});

Deno.test("unmarked provider SQLSTATE-shaped codes are not granted database recovery", async () => {
  let applicationCalls = 0;
  const result = await settleClaimedJobFault({
    fault: Object.assign(new Error("provider protocol payload"), { code: "08006" }),
    signal,
    policy,
    sleep: noWait,
    neutralDefer: () => Promise.resolve(true),
    recordApplicationFailure: () => {
      applicationCalls += 1;
      return Promise.resolve(true);
    },
  });
  assertEquals(result, "application_failure_recorded");
  assertEquals(applicationCalls, 1);
});

Deno.test("fatal database configuration stops without consuming the application budget", async () => {
  let settlementCalls = 0;
  for (const code of ["08004", "28P01", "42P01"]) {
    const fault = await capturedDatabaseFault(code);
    await assertRejects(() =>
      settleClaimedJobFault({
        fault,
        signal,
        policy,
        sleep: noWait,
        neutralDefer: () => {
          settlementCalls += 1;
          return Promise.resolve(true);
        },
        recordApplicationFailure: () => {
          settlementCalls += 1;
          return Promise.resolve(true);
        },
      })
    );
  }
  assertEquals(settlementCalls, 0);
});

Deno.test("poison job SQLSTATE is recorded and the durable loop continues to the next job", async () => {
  const controller = new AbortController();
  const poison = await capturedDatabaseFault("23514");
  let iterations = 0;
  let applicationFailures = 0;
  let neutralDefers = 0;
  let sleeps = 0;

  await runResilientLoop({
    signal: controller.signal,
    policy,
    shouldRetry: () => false,
    sleep: () => {
      sleeps += 1;
      return Promise.resolve();
    },
    iteration: async () => {
      iterations += 1;
      if (iterations === 1) {
        const disposition = await settleClaimedJobFault({
          fault: poison,
          signal: controller.signal,
          policy,
          sleep: noWait,
          neutralDefer: () => {
            neutralDefers += 1;
            return Promise.resolve(true);
          },
          recordApplicationFailure: () => {
            applicationFailures += 1;
            return Promise.resolve(true);
          },
        });
        assertEquals(disposition, "application_failure_recorded");
        return;
      }
      controller.abort();
    },
  });

  assertEquals(iterations, 2);
  assertEquals(applicationFailures, 1);
  assertEquals(neutralDefers, 0);
  assertEquals(sleeps, 0);
});
