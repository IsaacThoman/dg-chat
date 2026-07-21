import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { runAccountedEmbeddingCall } from "../../api/src/embedding-accounting.ts";
import {
  callEmbeddingProviderAfterFence,
  type DurableEmbeddingBatch,
  EmbeddingNotDispatchedError,
  recoverRetrySafeEmbeddingDispatch,
} from "./document-embedding-dispatch.ts";

const interrupted: DurableEmbeddingBatch = {
  jobId: "00000000-0000-4000-8000-000000000001",
  batchOrdinal: 0,
  dispatchEpoch: 0,
  usageRunId: "run:0",
  requestSha256: "a".repeat(64),
  itemCount: 1,
  batchSize: 1,
  maximumInputTokens: 5,
  phase: "dispatched",
  embeddings: null,
  inputTokens: null,
  latencyMs: null,
  usageStatus: "reserved",
  retrySafe: true,
  dispatchClaimToken: "old-claim",
  dispatchedAt: new Date().toISOString(),
};

Deno.test("definitive embedding rejection recovery settles zero cost before advancing epoch", async () => {
  const events: string[] = [];
  const recovered = await recoverRetrySafeEmbeddingDispatch(
    interrupted,
    (terminal) => {
      events.push("settled");
      assertEquals(terminal.status, "failed");
      assertEquals(terminal.usageRunId, "run:0");
      assertEquals(terminal.inputTokens, 0);
      assertEquals(terminal.costMicros, 0);
      assertEquals(terminal.tokenSource, "none");
      assertEquals(terminal.costSource, "none");
      return Promise.resolve();
    },
    () => {
      events.push("reloaded");
      return Promise.resolve({
        ...interrupted,
        dispatchEpoch: 1,
        usageRunId: "run:1",
        phase: "pre_dispatch",
        retrySafe: false,
        dispatchClaimToken: null,
        dispatchedAt: null,
        usageStatus: "missing",
      });
    },
  );
  assertEquals(events, ["settled", "reloaded"]);
  assertEquals(recovered.dispatchEpoch, 1);
  assertEquals(recovered.phase, "pre_dispatch");
});

Deno.test("pre-fetch deadline settles reservation at zero cost and refunds it", async () => {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-no-fetch@example.com",
    name: "No fetch",
    passwordHash: "hash",
  }, 100);
  const deadline = new AbortController();
  deadline.abort(new DOMException("job deadline elapsed", "TimeoutError"));
  let providerCalls = 0;
  await assertRejects(() =>
    runAccountedEmbeddingCall({
      repository,
      userId: user.id,
      usageRunId: "embedding-no-fetch",
      purpose: "document",
      provider: "provider.example",
      model: "embed",
      upstreamModel: "embed-v1",
      content: ["never sent"],
      billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
      isDispatchOutcomeUncertain: (error) => !(error instanceof EmbeddingNotDispatchedError),
      call: () =>
        callEmbeddingProviderAfterFence({
          signal: deadline.signal,
          usageRunId: "embedding-no-fetch",
          markNoFetchRetrySafe: () => Promise.resolve(),
          call: () => {
            providerCalls += 1;
            return Promise.resolve({ value: [1], inputTokens: 1 });
          },
        }),
    })
  );
  assertEquals(providerCalls, 0);
  assertEquals(repository.usageRuns.get("embedding-no-fetch")?.status, "failed");
  assertEquals(repository.users.get(user.id)?.balanceMicros, 100);
  assertEquals(
    repository.embeddingProviderAttempts.get("embedding-no-fetch")?.costMicros,
    0,
  );
});

Deno.test("embedding rejection recovery refuses uncertain dispatches and invalid reloads", async () => {
  let settlements = 0;
  await assertRejects(() =>
    recoverRetrySafeEmbeddingDispatch(
      { ...interrupted, retrySafe: false },
      () => {
        settlements += 1;
        return Promise.resolve();
      },
      () => Promise.resolve(interrupted),
    ), TypeError);
  assertEquals(settlements, 0);
  await assertRejects(
    () =>
      recoverRetrySafeEmbeddingDispatch(
        interrupted,
        () => Promise.resolve(),
        () => Promise.resolve(interrupted),
      ),
    Error,
    "did not advance",
  );
});

Deno.test("elapsed pre-fetch deadline marks retry-safe and never invokes provider", async () => {
  const deadline = new AbortController();
  deadline.abort(new DOMException("job deadline elapsed", "TimeoutError"));
  let marked = 0;
  let providerCalls = 0;
  await assertRejects(
    () =>
      callEmbeddingProviderAfterFence({
        signal: deadline.signal,
        usageRunId: "run:no-fetch",
        markNoFetchRetrySafe: () => {
          marked += 1;
          return Promise.resolve();
        },
        call: () => {
          providerCalls += 1;
          return Promise.resolve("impossible");
        },
      }),
    Error,
    "before provider dispatch",
  );
  assertEquals(marked, 1);
  assertEquals(providerCalls, 0);
});
