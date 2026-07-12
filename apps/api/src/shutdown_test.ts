import { assertEquals } from "jsr:@std/assert@1.0.14";
import { shutdownApi } from "./shutdown.ts";

Deno.test("shutdown cancels backup before drain and force-closes a stalled server within bounds", async () => {
  const calls: string[] = [];
  const started = performance.now();
  await shutdownApi({
    cancelBackup() {
      calls.push("backup");
      return new Promise(() => {});
    },
    drainServer() {
      calls.push("drain");
      return new Promise(() => {});
    },
    forceServer() {
      calls.push("force");
    },
    closeResources() {
      calls.push("resources");
    },
    drainGraceMs: 10,
    resourceGraceMs: 10,
  });
  assertEquals(calls, ["backup", "drain", "force", "resources"]);
  assertEquals(performance.now() - started < 100, true);
});

Deno.test("shutdown does not force a server after backup cancellation and drain settle", async () => {
  const calls: string[] = [];
  await shutdownApi({
    cancelBackup: () => calls.push("backup"),
    drainServer: () => calls.push("drain"),
    forceServer: () => calls.push("force"),
    closeResources: () => calls.push("resources"),
    drainGraceMs: 100,
    resourceGraceMs: 100,
  });
  assertEquals(calls, ["backup", "drain", "resources"]);
});
