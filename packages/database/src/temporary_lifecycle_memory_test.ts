import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

Deno.test("temporary conversations expire, promote with CAS, and purge owner-safe bounded batches", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "temp-owner@example.com", name: "Owner" });
  const other = repo.createUser({ email: "temp-other@example.com", name: "Other" });
  const first = repo.createConversation(owner.id, "first", true, undefined, 7);
  const second = repo.createConversation(owner.id, "second");
  const foreign = repo.createConversation(other.id, "foreign", true, undefined, 7);
  const saved = repo.createConversation(owner.id, "saved");

  assertEquals(first.temporaryExpiresAt !== null, true);
  assertEquals(saved.temporaryExpiresAt, null);
  assertThrows(
    () => repo.promoteTemporaryConversation(owner.id, first.id, 99),
    DomainError,
    "changed",
  );
  const promoted = repo.promoteTemporaryConversation(owner.id, first.id, 0);
  assertEquals({
    temporary: promoted.temporary,
    expiresAt: promoted.temporaryExpiresAt,
    version: promoted.version,
  }, {
    temporary: false,
    expiresAt: null,
    version: 1,
  });

  // Seed conversation-scoped relations while saved, then model an upgraded legacy temporary
  // row so the memory adapter must mirror PostgreSQL's cascades rather than leak stale metadata.
  const folder = repo.createConversationFolder(owner.id, "Temporary", "temporary-folder");
  repo.replaceFolderMemberships(owner.id, folder.id, [second.id], { [folder.id]: 0 });
  const tag = repo.createConversationTag(owner.id, "Temporary", "#123456", "temporary-tag");
  repo.replaceConversationTags(owner.id, second.id, [tag.id], 0);
  const collection = repo.createKnowledgeCollection(owner.id, {
    name: "Temporary",
    idempotencyKey: "temporary-knowledge",
  });
  repo.replaceConversationKnowledge(second.id, owner.id, {
    collectionIds: [collection.id],
    mode: "retrieval",
  });
  second.temporary = true;
  second.temporaryExpiresAt = new Date(Date.now() - 1000).toISOString();

  const message = repo.appendMessage({
    conversationId: second.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "attached",
    expectedVersion: 0,
    idempotencyKey: "temporary-message",
  });
  const attachment = repo.createAttachment({
    ownerId: owner.id,
    objectKey: `users/${owner.id}/objects/temporary`,
    filename: "temporary.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    sha256: "b".repeat(64),
  }).attachment;
  repo.transitionAttachment(attachment.id, owner.id, "pending", "inspecting");
  repo.transitionAttachment(attachment.id, owner.id, "inspecting", "ready");
  repo.linkAttachmentToMessage(message.id, attachment.id, owner.id);

  const cutoff = new Date(Date.parse(second.temporaryExpiresAt!) + 1).toISOString();
  assertEquals(
    repo.purgeExpiredTemporaryConversations({ ownerId: owner.id, limit: 1, now: cutoff }),
    {
      conversationIds: [second.id],
    },
  );
  assertThrows(() => repo.detail(second.id, owner.id), DomainError, "not found");
  assertEquals(repo.getAttachment(attachment.id, owner.id).id, attachment.id);
  assertEquals(repo.listConversationFolders(owner.id).memberships, []);
  assertEquals(repo.listConversationTags(owner.id).tagSets, []);
  assertEquals(repo.knowledgeBindings.size, 0);
  assertEquals(repo.detail(foreign.id, other.id).id, foreign.id);
  assertEquals(repo.detail(first.id, owner.id).temporary, false);
});

Deno.test("temporary lifecycle rejects invalid retention, cutoff, and batch bounds", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "temp-validation@example.com", name: "Owner" });
  assertThrows(() => repo.createConversation(owner.id, "invalid", true, undefined, 0), DomainError);
  assertThrows(
    () => repo.purgeExpiredTemporaryConversations({ ownerId: owner.id, limit: 0 }),
    DomainError,
  );
  assertThrows(
    () => repo.purgeExpiredTemporaryConversations({ ownerId: owner.id, now: "invalid" }),
    DomainError,
  );
});
