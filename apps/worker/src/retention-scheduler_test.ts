import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import {
  parseRetentionSchedulerConfig,
  scheduleAutomaticRetention,
} from "./retention-scheduler.ts";

Deno.test("retention scheduler config defaults daily and enforces operational bounds", () => {
  assertEquals(parseRetentionSchedulerConfig({}), {
    intervalSeconds: 86_400,
    pollIntervalMs: 60_000,
  });
  assertEquals(
    parseRetentionSchedulerConfig({
      RETENTION_SCRUB_INTERVAL_SECONDS: "300",
      RETENTION_SCHEDULER_POLL_SECONDS: "600",
    }),
    {
      intervalSeconds: 300,
      pollIntervalMs: 300_000,
    },
  );
  for (const value of ["299", "2592001", "1.5", "nope"]) {
    assertThrows(() => parseRetentionSchedulerConfig({ RETENTION_SCRUB_INTERVAL_SECONDS: value }));
  }
  assertThrows(() => parseRetentionSchedulerConfig({ RETENTION_SCHEDULER_POLL_SECONDS: "9" }));
});

Deno.test("automatic retention is system-owned, snapshots policy, and coalesces missed cadence", async () => {
  const repository = new MemoryRepository();
  const firstAt = "2026-01-01T00:00:00.000Z";
  const first = await scheduleAutomaticRetention(repository, {
    intervalSeconds: 86_400,
    pollIntervalMs: 60_000,
  }, firstAt);
  assertEquals(first.scheduled, true);
  assertEquals(first.reason, "policy_changed");
  assertEquals(first.overdueSeconds, 0);
  assertEquals(first.run?.policy.version, 1);
  assertEquals(first.run?.requestCutoffAt, "2025-12-02T00:00:00.000Z");
  assertEquals(repository.jobs.filter((job) => job.type === "retention.scrub").length, 1);
  const enqueueAudit = repository.auditEvents.find((event) =>
    event.action === "retention.scrub.enqueued"
  );
  assertEquals(enqueueAudit?.actorId, null);

  const duplicate = await scheduleAutomaticRetention(repository, {
    intervalSeconds: 86_400,
    pollIntervalMs: 60_000,
  }, firstAt);
  assertEquals(duplicate.scheduled, false);
  assertEquals(repository.retentionScrubRuns.size, 1);

  const missed = await scheduleAutomaticRetention(repository, {
    intervalSeconds: 86_400,
    pollIntervalMs: 60_000,
  }, "2026-01-04T12:00:00.000Z");
  assertEquals(missed.scheduled, true);
  assertEquals(missed.reason, "interval_due");
  assertEquals(missed.overdueSeconds, 216_000);
  assertEquals(missed.nextDueAt, "2026-01-05T00:00:00.000Z");
  assertEquals(repository.retentionScrubRuns.size, 2);
});

Deno.test("policy and shorter-interval changes become due without waiting for the old cadence", () => {
  const repository = new MemoryRepository();
  repository.scheduleRetentionScrub({
    intervalSeconds: 86_400,
    now: "2026-01-01T00:00:00.000Z",
  });
  const admin = repository.bootstrapAdmin({
    email: "retention-scheduler@example.com",
    name: "Retention scheduler",
    passwordHash: "hash",
  }, 0);
  repository.updateRetentionPolicy({
    expectedVersion: 1,
    captureEnabled: true,
    requestBodyDays: 7,
    responseBodyDays: 14,
  }, admin.id);
  const policy = repository.scheduleRetentionScrub({
    intervalSeconds: 86_400,
    now: "2026-01-01T00:01:00.000Z",
  });
  assertEquals(policy.scheduled, true);
  assertEquals(policy.reason, "policy_changed");
  assertEquals(policy.run?.policy.version, 2);
  assertEquals(policy.run?.requestCutoffAt, "2025-12-25T00:01:00.000Z");

  const shorter = repository.scheduleRetentionScrub({
    intervalSeconds: 300,
    now: "2026-01-01T00:07:00.000Z",
  });
  assertEquals(shorter.scheduled, true);
  assertEquals(shorter.reason, "interval_due");
  assertEquals(shorter.nextDueAt, "2026-01-01T00:11:00.000Z");
});

Deno.test("memory scheduling validates cutoffs against the injected scheduler clock", () => {
  const repository = new MemoryRepository();
  const scheduled = repository.scheduleRetentionScrub({
    intervalSeconds: 86_400,
    now: "2035-01-01T00:00:00.000Z",
  });
  assertEquals(scheduled.scheduled, true);
  assertEquals(scheduled.run?.requestCutoffAt, "2034-12-02T00:00:00.000Z");
});
