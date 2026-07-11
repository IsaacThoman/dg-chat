import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { runAccountedEmbeddingCall } from "./embedding-accounting.ts";

class SettlementFailureRepository extends MemoryRepository {
  refunds = 0;
  override settle(): never {
    throw new Error("database unavailable after provider success");
  }
  override refund(runId: string) {
    this.refunds += 1;
    return super.refund(runId);
  }
}

Deno.test("successful embedding dispatch never enters the refund path when settlement fails", async () => {
  const repository = new SettlementFailureRepository();
  const user = repository.bootstrapAdmin({
    email: "embedding-accounting@example.com",
    name: "Embedding",
    passwordHash: "hash",
  }, 100);
  await assertRejects(
    () =>
      runAccountedEmbeddingCall({
        repository,
        userId: user.id,
        usageRunId: "embedding-persistence-failure",
        purpose: "query",
        provider: "provider.example",
        model: "embed",
        upstreamModel: "embed-v1",
        content: ["hello"],
        billing: { inputMicrosPerMillion: 1_000_000, fixedCallMicros: 5 },
        call: () => Promise.resolve({ value: [1], inputTokens: 2 }),
      }),
    Error,
    "database unavailable",
  );
  assertEquals(repository.refunds, 0);
  assertEquals(repository.usageRuns.get("embedding-persistence-failure")?.status, "reserved");
  assertEquals(repository.users.get(user.id)?.balanceMicros, 90);
  repository.refund("embedding-persistence-failure");
  assertEquals(repository.users.get(user.id)?.balanceMicros, 90);
  assertEquals(repository.usageRuns.get("embedding-persistence-failure")?.costMicros, 10);
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
