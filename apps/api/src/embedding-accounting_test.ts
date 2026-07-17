import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { runAccountedEmbeddingCall } from "./embedding-accounting.ts";

class LostCommitResponseRepository extends MemoryRepository {
  terminalCalls = 0;
  override finalizeEmbeddingProviderUsage(
    input: Parameters<MemoryRepository["finalizeEmbeddingProviderUsage"]>[0],
  ) {
    this.terminalCalls += 1;
    const result = super.finalizeEmbeddingProviderUsage(input);
    if (this.terminalCalls === 1) throw new Error("connection lost after commit");
    return result;
  }
}

class LostEmbeddingBeginResponseRepository extends MemoryRepository {
  reservationCalls = 0;
  attemptCalls = 0;

  override ensureIdempotentReservation(
    input: Parameters<MemoryRepository["ensureIdempotentReservation"]>[0],
  ) {
    const result = super.ensureIdempotentReservation(input);
    this.reservationCalls += 1;
    if (this.reservationCalls === 1) throw new Error("reservation response lost");
    return result;
  }

  override startEmbeddingProviderAttempt(
    input: Parameters<MemoryRepository["startEmbeddingProviderAttempt"]>[0],
  ) {
    const result = super.startEmbeddingProviderAttempt(input);
    this.attemptCalls += 1;
    if (this.attemptCalls === 1) throw new Error("attempt response lost");
    return result;
  }
}

Deno.test("lost response after atomic embedding settlement reconciles idempotently", async () => {
  const repository = new LostCommitResponseRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-accounting@example.com",
    name: "Embedding",
    passwordHash: "hash",
  }, 100);
  assertEquals(
    await runAccountedEmbeddingCall({
      repository,
      userId: user.id,
      usageRunId: "embedding-persistence-failure",
      purpose: "query",
      provider: "provider.example",
      model: "embed",
      upstreamModel: "embed-v1",
      content: ["héllo"],
      billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
      call: () => Promise.resolve({ value: [1], inputTokens: 2 }),
    }),
    [1],
  );
  assertEquals(repository.terminalCalls, 2);
  assertEquals(repository.usageRuns.get("embedding-persistence-failure")?.status, "completed");
  assertEquals(repository.users.get(user.id)?.balanceMicros, 93);
  assertEquals(
    repository.ledger.filter((entry) => entry.usageRunId === "embedding-persistence-failure")
      .length,
    2,
  );
});

Deno.test("lost embedding begin responses converge without replaying the provider", async () => {
  const repository = new LostEmbeddingBeginResponseRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-begin-recovery@example.com",
    name: "Embedding",
    passwordHash: "hash",
  }, 100);
  let providerCalls = 0;
  const value = await runAccountedEmbeddingCall({
    repository,
    userId: user.id,
    usageRunId: "embedding-begin-recovery",
    purpose: "document",
    provider: "provider.example",
    model: "embed",
    upstreamModel: "embed-v1",
    content: ["hello"],
    billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
    databaseOperation: async (operation) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await operation();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    call: () => {
      providerCalls += 1;
      return Promise.resolve({ value: [1], inputTokens: 1 });
    },
  });
  assertEquals(value, [1]);
  assertEquals(repository.reservationCalls, 2);
  assertEquals(repository.attemptCalls, 2);
  assertEquals(providerCalls, 1);
});

Deno.test("failed embedding dispatch records the attempt and refunds the unused reservation", async () => {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-failure@example.com",
    name: "Embedding",
    passwordHash: "hash",
  }, 100);
  await assertRejects(() =>
    runAccountedEmbeddingCall({
      repository,
      userId: user.id,
      usageRunId: "embedding-provider-failure",
      purpose: "document",
      provider: "provider.example",
      model: "embed",
      upstreamModel: "embed-v1",
      content: ["hello"],
      billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
      call: () => Promise.reject(new Error("provider failed")),
    })
  );
  assertEquals(repository.users.get(user.id)?.balanceMicros, 100);
  assertEquals(repository.usageRuns.get("embedding-provider-failure")?.status, "failed");
  assertEquals(
    repository.embeddingProviderAttempts.get("embedding-provider-failure")?.status,
    "failed",
  );
});

Deno.test("uncertain embedding dispatch settles the conservative reservation exactly once", async () => {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-uncertain@example.com",
    name: "Embedding",
    passwordHash: "hash",
  }, 100);
  const transport = new TypeError("connection reset after request write");
  await assertRejects(() =>
    runAccountedEmbeddingCall({
      repository,
      userId: user.id,
      usageRunId: "embedding-uncertain",
      purpose: "document",
      provider: "provider.example",
      model: "embed",
      upstreamModel: "embed-v1",
      content: ["hello"],
      billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
      isDispatchOutcomeUncertain: (error) => error === transport,
      call: () => Promise.reject(transport),
    })
  );
  assertEquals(repository.users.get(user.id)?.balanceMicros, 90);
  assertEquals(repository.usageRuns.get("embedding-uncertain")?.costMicros, 10);
  assertEquals(repository.usageRuns.get("embedding-uncertain")?.inputTokens, 5);
  assertEquals(
    repository.ledger.filter((entry) => entry.usageRunId === "embedding-uncertain").length,
    1,
  );
});

Deno.test("embedding database provenance wrapper never encloses the provider transport", async () => {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-provenance@example.com",
    name: "Embedding",
    passwordHash: "hash",
  }, 100);
  const providerError = Object.assign(new Error("provider reset"), { code: "ECONNRESET" });
  let databaseCalls = 0;
  let observed: unknown;
  try {
    await runAccountedEmbeddingCall({
      repository,
      userId: user.id,
      usageRunId: "embedding-provider-provenance",
      purpose: "document",
      provider: "provider.example",
      model: "embed",
      upstreamModel: "embed-v1",
      content: ["hello"],
      billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
      databaseOperation: async (operation) => {
        databaseCalls += 1;
        return await operation();
      },
      call: () => Promise.reject(providerError),
    });
  } catch (error) {
    observed = error;
  }
  assertEquals(observed, providerError);
  assertEquals(databaseCalls, 3); // reserve, attempt start, and failure settlement
});

Deno.test("embedding terminal settlement can use an independent bounded database path", async () => {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-terminal-path@example.com",
    name: "Embedding",
    passwordHash: "hash",
  }, 100);
  let ordinaryCalls = 0;
  let terminalCalls = 0;
  await assertRejects(() =>
    runAccountedEmbeddingCall({
      repository,
      userId: user.id,
      usageRunId: "embedding-terminal-path",
      purpose: "document",
      provider: "provider.example",
      model: "embed",
      upstreamModel: "embed-v1",
      content: ["hello"],
      billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
      databaseOperation: async (operation) => {
        ordinaryCalls += 1;
        return await operation();
      },
      terminalDatabaseOperation: async (operation) => {
        terminalCalls += 1;
        return await operation();
      },
      isDispatchOutcomeUncertain: () => true,
      call: () =>
        Promise.reject(
          new Error("Embedding outcome uncertain", {
            cause: new DOMException("Worker stopping", "AbortError"),
          }),
        ),
    })
  );
  assertEquals(ordinaryCalls, 2);
  assertEquals(terminalCalls, 1);
  assertEquals(repository.usageRuns.get("embedding-terminal-path")?.status, "failed");
  assertEquals(repository.usageRuns.get("embedding-terminal-path")?.costMicros, 10);
  assertEquals(
    repository.embeddingProviderAttempts.get("embedding-terminal-path")?.status,
    "cancelled",
  );
});

Deno.test("impossible provider token usage charges the full conservative reservation", async () => {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-impossible@example.com",
    name: "Embedding",
    passwordHash: "hash",
  }, 100);
  await assertRejects(
    () =>
      runAccountedEmbeddingCall({
        repository,
        userId: user.id,
        usageRunId: "embedding-impossible-usage",
        purpose: "query",
        provider: "provider.example",
        model: "embed",
        upstreamModel: "embed-v1",
        content: ["é"], // two UTF-8 bytes, therefore at most two tokens
        billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
        call: () => Promise.resolve({ value: [1], inputTokens: 3 }),
      }),
    Error,
    "impossible",
  );
  assertEquals(repository.users.get(user.id)?.balanceMicros, 93);
  assertEquals(repository.usageRuns.get("embedding-impossible-usage")?.costMicros, 7);
});
