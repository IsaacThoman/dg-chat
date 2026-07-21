import { assertEquals } from "jsr:@std/assert@1.0.14";
import { runDatabaseOperation } from "./resilient-loop.ts";
import { retryWorkerClaimedDatabaseOperation } from "./worker-database.ts";

Deno.test("configured claimed retry treats worker statement timeout as retryable", async () => {
  let operations = 0;
  let renewals = 0;
  const result = await retryWorkerClaimedDatabaseOperation(
    async () => {
      operations += 1;
      if (operations === 1) {
        await runDatabaseOperation(() =>
          Promise.reject({
            code: "57014",
            message: "canceling statement due to statement timeout",
          })
        );
      }
      return "settled";
    },
    () => {
      renewals += 1;
      return Promise.resolve(true);
    },
    {
      signal: new AbortController().signal,
      policy: { initialDelayMs: 1, maxDelayMs: 1 },
    },
  );
  assertEquals(result, "settled");
  assertEquals(operations, 2);
  assertEquals(renewals, 2);
});
