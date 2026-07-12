import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { parseRetentionScrubPayload, processRetentionScrub } from "./retention-scrub.ts";

const run = {
  id: "00000000-0000-4000-8000-000000000010",
  idempotencyKey: "retention-test-run",
  status: "completed" as const,
  policy: {
    version: 1,
    captureEnabled: true,
    requestBodyDays: 30 as const,
    responseBodyDays: 30 as const,
    updatedAt: "2026-07-12T00:00:00.000Z",
    updatedBy: "00000000-0000-4000-8000-000000000001",
  },
  capturesScrubbed: 2,
  requestCutoffAt: "2026-06-12T00:00:00.000Z",
  responseCutoffAt: "2026-06-12T00:00:00.000Z",
  requestBodiesScrubbed: 2,
  responseBodiesScrubbed: 2,
  bytesScrubbed: 40,
  createdAt: "2026-07-12T00:00:00.000Z",
  startedAt: "2026-07-12T00:00:01.000Z",
  completedAt: "2026-07-12T00:00:02.000Z",
  error: null,
};

Deno.test("retention scrub payload is strict and bounded", () => {
  assertEquals(parseRetentionScrubPayload({ runId: run.id }), { runId: run.id });
  assertThrows(() => parseRetentionScrubPayload({ runId: "bad" }), TypeError);
  assertThrows(() => parseRetentionScrubPayload({ runId: run.id, payload: "secret" }), TypeError);
});

Deno.test("retention scrub processes one bounded continuation slice", async () => {
  let calls = 0;
  const result = await processRetentionScrub(
    {
      scrubRetentionBatch: () => {
        calls++;
        return {
          run: { ...run, status: "running" as const },
          processed: 1,
          completed: false,
        };
      },
    },
    { runId: run.id },
    50,
  );
  assertEquals(calls, 1);
  assertEquals(result.completed, false);
});
