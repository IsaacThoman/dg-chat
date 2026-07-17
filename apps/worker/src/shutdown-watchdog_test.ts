import { assertEquals } from "jsr:@std/assert@1.0.14";
import { armShutdownWatchdog } from "./shutdown-watchdog.ts";

Deno.test("absolute shutdown watchdog force-closes then exits successfully", async () => {
  const events: string[] = [];
  const fired = new Promise<void>((resolve) => {
    armShutdownWatchdog(
      10,
      () => events.push("force-close"),
      ((code: number) => {
        events.push(`exit:${code}`);
        resolve();
        return undefined as never;
      }) as (code: number) => never,
    );
  });
  await fired;
  assertEquals(events, ["force-close", "exit:0"]);
});

Deno.test("disposed shutdown watchdog never closes or exits", async () => {
  const events: string[] = [];
  const dispose = armShutdownWatchdog(
    10,
    () => events.push("force-close"),
    (() => {
      events.push("exit");
      throw new Error("unexpected exit");
    }) as () => never,
  );
  dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(events, []);
});

Deno.test("shutdown watchdog exits even when forced close throws", async () => {
  const events: string[] = [];
  const fired = new Promise<void>((resolve) => {
    armShutdownWatchdog(
      10,
      () => {
        events.push("force-close");
        throw new Error("driver close failed");
      },
      ((code: number) => {
        events.push(`exit:${code}`);
        resolve();
        return undefined as never;
      }) as (code: number) => never,
    );
  });
  await fired;
  assertEquals(events, ["force-close", "exit:0"]);
});
