import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { retryBeforeAbsoluteDeadline } from "./shutdown-settlement.ts";

const policy = { initialDelayMs: 20, maxDelayMs: 20 };

Deno.test("shutdown settlement refuses to start inside the final statement window", async () => {
  let attempts = 0;
  await assertRejects(
    () =>
      retryBeforeAbsoluteDeadline({
        operation: () => {
          attempts += 1;
          return Promise.resolve("too late");
        },
        deadlineAt: Date.now() + 20,
        attemptWindowMs: 50,
        policy,
        shouldRetry: () => true,
      }),
    DOMException,
    "settlement timed out",
  );
  assertEquals(attempts, 0);
});

Deno.test("shutdown settlement does not begin a retry without a complete attempt window", async () => {
  let attempts = 0;
  await assertRejects(
    () =>
      retryBeforeAbsoluteDeadline({
        operation: () => {
          attempts += 1;
          return Promise.reject(new Error("retryable"));
        },
        deadlineAt: Date.now() + 70,
        attemptWindowMs: 50,
        policy,
        shouldRetry: () => true,
        random: () => 0,
      }),
    DOMException,
    "settlement timed out",
  );
  assertEquals(attempts, 1);
});

Deno.test("shutdown settlement races a blackholed operation at the absolute deadline", async () => {
  const started = performance.now();
  await assertRejects(
    () =>
      retryBeforeAbsoluteDeadline({
        operation: () => new Promise<never>(() => {}),
        deadlineAt: Date.now() + 80,
        attemptWindowMs: 50,
        policy,
        shouldRetry: () => true,
      }),
    DOMException,
    "settlement timed out",
  );
  if (performance.now() - started > 500) throw new Error("Blackholed operation escaped deadline");
});
