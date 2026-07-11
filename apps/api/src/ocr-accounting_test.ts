import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "@dg-chat/database";

const pricing = {
  pricingVersionId: crypto.randomUUID(),
  inputMicrosPerMillion: 1,
  cachedInputMicrosPerMillion: 1,
  reasoningMicrosPerMillion: 1,
  outputMicrosPerMillion: 1,
  fixedCallMicros: 0,
  source: "test",
};

Deno.test("OCR child reservation atomically validates the parent lease and prevents overspend", async () => {
  const repo = new MemoryRepository();
  const user = repo.bootstrapAdmin({
    email: "ocr-atomic@example.com",
    name: "OCR atomic",
    passwordHash: "unused",
  }, 250);
  const parent = repo.reserve(user.id, "ocr-parent", "chat/model", 50);
  const reserve = (runId: string) =>
    Promise.resolve().then(() =>
      repo.reserveChildProviderUsage({
        parentUsageRunId: parent.id,
        parentOwnerLeaseToken: parent.runLeaseToken!,
        runId,
        model: "ocr/model",
        provider: "ocr:test",
        reserveMicros: 150,
        pricingSnapshot: pricing,
      })
    );
  const results = await Promise.allSettled([reserve("ocr-child-a"), reserve("ocr-child-b")]);
  assertEquals(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assertEquals(
    rejected.reason instanceof DomainError && rejected.reason.code,
    "insufficient_credit",
  );
  assertEquals(repo.ledger.at(-1)?.balanceAfterMicros, 50);

  const winner = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<
    Awaited<ReturnType<typeof reserve>>
  >;
  repo.refund(winner.value.id);
  repo.refund(parent.id);
  assertEquals(repo.ledger.at(-1)?.balanceAfterMicros, 250);

  await assertRejects(
    () => reserve("ocr-child-after-parent-terminal"),
    DomainError,
    "stale",
  );
});
