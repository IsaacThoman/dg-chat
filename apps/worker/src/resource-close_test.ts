import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { closeResourcesBeforeDeadline } from "./resource-close.ts";

Deno.test("rejecting graceful close requires and proves forced closure", async () => {
  const events: string[] = [];
  assertEquals(
    await closeResourcesBeforeDeadline({
      graceful: [() => {
        events.push("graceful");
        return Promise.reject(new Error("close rejected"));
      }],
      forced: [() => {
        events.push("forced");
      }],
      deadlineAt: Date.now() + 200,
      forcedWindowMs: 100,
    }),
    "forced",
  );
  assertEquals(events, ["graceful", "forced"]);
});

Deno.test("blackholed graceful close switches to forced close before absolute deadline", async () => {
  const events: string[] = [];
  const started = performance.now();
  assertEquals(
    await closeResourcesBeforeDeadline({
      graceful: [() => new Promise<never>(() => {})],
      forced: [() => {
        events.push("forced");
      }],
      deadlineAt: Date.now() + 120,
      forcedWindowMs: 70,
    }),
    "forced",
  );
  assertEquals(events, ["forced"]);
  if (performance.now() - started > 300) throw new Error("Graceful blackhole escaped close budget");
});

Deno.test("rejecting or blackholed forced closure never reports closure proven", async () => {
  await assertRejects(
    () =>
      closeResourcesBeforeDeadline({
        graceful: [() => Promise.reject(new Error("graceful rejected"))],
        forced: [() => Promise.reject(new Error("forced rejected"))],
        deadlineAt: Date.now() + 200,
        forcedWindowMs: 100,
      }),
    AggregateError,
    "Resource closure failed",
  );
  const started = performance.now();
  await assertRejects(
    () =>
      closeResourcesBeforeDeadline({
        graceful: [() => Promise.reject(new Error("graceful rejected"))],
        forced: [() => new Promise<never>(() => {})],
        deadlineAt: Date.now() + 100,
        forcedWindowMs: 70,
      }),
    DOMException,
    "Forced resource close timed out",
  );
  if (performance.now() - started > 300) throw new Error("Forced blackhole escaped close budget");
});
