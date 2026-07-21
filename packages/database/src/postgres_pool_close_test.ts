import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { closeOwnedPostgresPools } from "./normalized-postgres.ts";

Deno.test("repository forced pool close settles every unique pool and propagates rejection", async () => {
  const rejectingPool = {};
  const secondPool = {};
  const calls: Array<{ pool: object; timeout: number }> = [];
  const closeFailure = new Error("driver refused forced close");

  const error = await assertRejects(
    () =>
      closeOwnedPostgresPools(
        [rejectingPool, secondPool, rejectingPool],
        0,
        (pool, timeout) => {
          calls.push({ pool, timeout });
          if (pool === rejectingPool) throw closeFailure;
          return Promise.resolve();
        },
      ),
    AggregateError,
    "Failed to close PostgreSQL pools",
  );

  assertEquals(calls, [
    { pool: rejectingPool, timeout: 0 },
    { pool: secondPool, timeout: 0 },
  ]);
  assertEquals(error.errors, [closeFailure]);
});
