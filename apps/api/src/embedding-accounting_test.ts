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
