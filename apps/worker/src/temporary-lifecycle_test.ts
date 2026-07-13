import { assertEquals } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { purgeTemporaryConversationBatch } from "./temporary-lifecycle.ts";

Deno.test("temporary lifecycle worker purges globally in bounded batches with durable audits", async () => {
  const repository = new MemoryRepository();
  const firstOwner = repository.createUser({ email: "one@example.test", name: "One" });
  const secondOwner = repository.createUser({ email: "two@example.test", name: "Two" });
  const first = repository.createConversation(firstOwner.id, "One", true, undefined, 1);
  const second = repository.createConversation(secondOwner.id, "Two", true, undefined, 1);
  const now = new Date(
    Math.max(Date.parse(first.temporaryExpiresAt!), Date.parse(second.temporaryExpiresAt!)) + 1,
  )
    .toISOString();
  const batch = await purgeTemporaryConversationBatch(repository, 1, now);
  assertEquals(batch.conversationIds.length, 1);
  assertEquals(batch.hasMore, true);
  const final = await purgeTemporaryConversationBatch(repository, 1, now);
  assertEquals(final.conversationIds.length, 1);
  assertEquals(final.hasMore, true);
  assertEquals(
    (await repository.listAudit({ action: "conversation.temporary_purged" })).data.length,
    2,
  );
});
