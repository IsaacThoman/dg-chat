import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "@dg-chat/database";
import { buildKnowledgeContext } from "./knowledge-context.ts";

function fixture(mode: "retrieval" | "full_context") {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "rag@example.com", name: "Rag", passwordHash: "x" });
  const other = repo.createUser({
    email: "other-rag@example.com",
    name: "Other",
    passwordHash: "x",
  });
  const conversation = repo.createConversation(owner.id, "Knowledge");
  const collection = repo.createKnowledgeCollection(owner.id, {
    name: "Manuals",
    idempotencyKey: "manuals",
  });
  const attachment = repo.createAttachment({
    ownerId: owner.id,
    objectKey: `users/${owner.id}/manual.txt`,
    filename: "manual.txt",
    mimeType: "text/plain",
    sizeBytes: 100,
    sha256: "a".repeat(64),
    state: "ready",
  }).attachment;
  repo.beginAttachmentIngestion(attachment.id, owner.id);
  const metadata = {
    sourceAttachmentId: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sha256: attachment.sha256,
    extractorVersion: "builtin-document-v1",
    chunkerVersion: "character-overlap-v1",
  };
  repo.completeAttachmentIngestion(attachment.id, owner.id, [
    { id: crypto.randomUUID(), ordinal: 0, content: "Bananas are yellow fruit.", metadata },
    {
      id: crypto.randomUUID(),
      ordinal: 1,
      content: "The turbine reset lever is blue.",
      metadata,
    },
    { id: crypto.randomUUID(), ordinal: 2, content: "Bananas are yellow fruit.", metadata },
  ]);
  repo.linkKnowledgeAttachment(collection.id, attachment.id, owner.id, 1);
  repo.bindKnowledgeCollection(conversation.id, collection.id, owner.id, mode);
  return { repo, owner, other, conversation };
}

Deno.test("knowledge context ranks retrieval, deduplicates, labels, and obeys budget", async () => {
  const { repo, owner, conversation } = fixture("retrieval");
  const result = await buildKnowledgeContext(
    repo,
    conversation.id,
    owner.id,
    "How do I reset the turbine?",
    { maxCharacters: 1000, retrievalTopK: 3 },
  );
  assertEquals(result.sources.length, 1);
  assertEquals(result.sources[0].ordinal, 1);
  assertEquals(result.sources.map((source) => source.label), ["source-1"]);
  assertStringIncludes(String(result.message?.content), "[source-1]");
  const bounded = await buildKnowledgeContext(repo, conversation.id, owner.id, "turbine", {
    maxCharacters: 70,
  });
  assertEquals(bounded.includedCharacters <= 70, true);
  const noMatch = await buildKnowledgeContext(repo, conversation.id, owner.id, "spaceship");
  assertEquals(noMatch.sources, []);
  assertEquals(noMatch.message, undefined);
  const emptyQuery = await buildKnowledgeContext(repo, conversation.id, owner.id, "");
  assertEquals(emptyQuery.sources.length, 2);
});

Deno.test("full context preserves duplicate chunks and their distinct attribution", async () => {
  const { repo, owner, conversation } = fixture("full_context");
  const result = await buildKnowledgeContext(repo, conversation.id, owner.id, "irrelevant");
  assertEquals(result.sources.length, 3);
  assertEquals(result.sources.map((source) => source.ordinal), [0, 1, 2]);
  assertEquals(result.sources.map((source) => source.label), [
    "source-1",
    "source-2",
    "source-3",
  ]);
});

Deno.test("knowledge context is strictly owner scoped", async () => {
  const { repo, other, conversation } = fixture("full_context");
  await assertRejects(
    () => buildKnowledgeContext(repo, conversation.id, other.id, "anything"),
    DomainError,
    "not found",
  );
});
