import { assertEquals } from "jsr:@std/assert@1.0.14";
import { shutdownApi, shutdownLogLevel } from "./shutdown.ts";

Deno.test("shutdown cancels backup before drain and force-closes a stalled server within bounds", async () => {
  const calls: string[] = [];
  const started = performance.now();
  const outcome = await shutdownApi({
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
    forceGraceMs: 10,
    resourceGraceMs: 10,
  });
  assertEquals(calls, ["backup", "drain", "force", "resources"]);
  assertEquals(performance.now() - started < 100, true);
  assertEquals(outcome, {
    backupCancellation: "timed_out",
    httpDrain: "timed_out",
    forcedAbort: true,
    forceServer: "settled",
    resources: "settled",
    failureCount: 0,
    timeoutCount: 2,
  });
});

Deno.test("shutdown does not force a server after backup cancellation and drain settle", async () => {
  const calls: string[] = [];
  const outcome = await shutdownApi({
    cancelBackup: () => calls.push("backup"),
    drainServer: () => calls.push("drain"),
    forceServer: () => calls.push("force"),
    closeResources: () => calls.push("resources"),
    drainGraceMs: 100,
    forceGraceMs: 100,
    resourceGraceMs: 100,
  });
  assertEquals(calls, ["backup", "drain", "resources"]);
  assertEquals(outcome, {
    backupCancellation: "settled",
    httpDrain: "settled",
    forcedAbort: false,
    forceServer: "not_required",
    resources: "settled",
    failureCount: 0,
    timeoutCount: 0,
  });
  assertEquals(shutdownLogLevel(outcome), "info");
});

Deno.test("shutdown reports a sanitized resource deadline outcome", async () => {
  const outcome = await shutdownApi({
    cancelBackup: () => undefined,
    drainServer: () => undefined,
    forceServer: () => undefined,
    closeResources: () => new Promise(() => {}),
    drainGraceMs: 100,
    forceGraceMs: 100,
    resourceGraceMs: 5,
  });
  assertEquals(outcome, {
    backupCancellation: "settled",
    httpDrain: "settled",
    forcedAbort: false,
    forceServer: "not_required",
    resources: "timed_out",
    failureCount: 0,
    timeoutCount: 1,
  });
  assertEquals(shutdownLogLevel(outcome), "warn");
});

Deno.test("shutdown reports phase failures without exposing error details", async () => {
  const calls: string[] = [];
  const outcome = await shutdownApi({
    cancelBackup: () => Promise.reject(new Error("secret backup detail")),
    drainServer: () => Promise.reject(new Error("secret server detail")),
    forceServer: () => calls.push("force"),
    closeResources: () => Promise.reject(new Error("secret resource detail")),
    drainGraceMs: 100,
    forceGraceMs: 100,
    resourceGraceMs: 100,
  });
  assertEquals(calls, ["force"]);
  assertEquals(outcome, {
    backupCancellation: "failed",
    httpDrain: "failed",
    forcedAbort: true,
    forceServer: "settled",
    resources: "failed",
    failureCount: 3,
    timeoutCount: 0,
  });
  assertEquals(JSON.stringify(outcome).includes("secret"), false);
  assertEquals(shutdownLogLevel(outcome), "error");
});

Deno.test("shutdown captures a failed forced abort and counts it", async () => {
  const outcome = await shutdownApi({
    cancelBackup: () => undefined,
    drainServer: () => Promise.reject(new Error("private drain detail")),
    forceServer: () => Promise.reject(new Error("private force detail")),
    closeResources: () => undefined,
    drainGraceMs: 100,
    forceGraceMs: 100,
    resourceGraceMs: 100,
  });
  assertEquals(outcome, {
    backupCancellation: "settled",
    httpDrain: "failed",
    forcedAbort: true,
    forceServer: "failed",
    resources: "settled",
    failureCount: 2,
    timeoutCount: 0,
  });
  assertEquals(JSON.stringify(outcome).includes("private"), false);
});

Deno.test("shutdown bounds a stalled forced abort before closing resources", async () => {
  const calls: string[] = [];
  const started = performance.now();
  const outcome = await shutdownApi({
    cancelBackup: () => undefined,
    drainServer: () => new Promise(() => {}),
    forceServer() {
      calls.push("force");
      return new Promise(() => {});
    },
    closeResources: () => calls.push("resources"),
    drainGraceMs: 5,
    forceGraceMs: 5,
    resourceGraceMs: 5,
  });
  assertEquals(calls, ["force", "resources"]);
  assertEquals(performance.now() - started < 100, true);
  assertEquals(outcome, {
    backupCancellation: "settled",
    httpDrain: "timed_out",
    forcedAbort: true,
    forceServer: "timed_out",
    resources: "settled",
    failureCount: 0,
    timeoutCount: 2,
  });
});

Deno.test("a stalled backup does not force an already-drained server", async () => {
  const calls: string[] = [];
  const outcome = await shutdownApi({
    cancelBackup: () => new Promise(() => {}),
    drainServer: () => undefined,
    forceServer: () => calls.push("force"),
    closeResources: () => calls.push("resources"),
    drainGraceMs: 5,
    forceGraceMs: 5,
    resourceGraceMs: 5,
  });
  assertEquals(calls, ["resources"]);
  assertEquals(outcome, {
    backupCancellation: "timed_out",
    httpDrain: "settled",
    forcedAbort: false,
    forceServer: "not_required",
    resources: "settled",
    failureCount: 0,
    timeoutCount: 1,
  });
});
