import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError, PostgresRepository } from "@dg-chat/database";
import { buildKnowledgeContext } from "./knowledge-context.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres knowledge context includes bound chunks and isolates owners",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE conversation_knowledge_bindings, knowledge_collection_attachments,
      knowledge_collections, audit_events, document_chunks, message_attachments, attachments,
      jobs, ledger_entries, usage_runs, api_tokens, sessions, messages, conversations, users
      RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "rag-context-pg@example.com",
        name: "Rag",
        passwordHash: "x",
      }, 1);
      const stranger = await repo.createUser({
        email: "rag-context-other-pg@example.com",
        name: "Other",
        passwordHash: "x",
      });
      const conversation = await repo.createConversation(owner.id, "RAG");
      const collection = await repo.createKnowledgeCollection(owner.id, {
        name: "Runbook",
        idempotencyKey: "runbook",
      });
      const attachment = (await repo.createAttachment({
        ownerId: owner.id,
        objectKey: `users/${owner.id}/runbook`,
        filename: "runbook.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        sha256: "d".repeat(64),
        state: "ready",
      })).attachment;
      const mutate = postgres(databaseUrl!, { max: 1 });
      await mutate`UPDATE attachments SET ingestion_status='processing' WHERE id=${attachment.id}`;
      await mutate.end();
      const chunkId = crypto.randomUUID();
      await repo.completeAttachmentIngestion(attachment.id, owner.id, [{
        id: chunkId,
        ordinal: 0,
        content: "Postgres turbine runbook",
        metadata: {
          sourceAttachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sha256: attachment.sha256,
          extractorVersion: "builtin-document-v1",
          chunkerVersion: "character-overlap-v1",
        },
      }]);
      await repo.linkKnowledgeAttachment(collection.id, attachment.id, owner.id, 1);
      await repo.bindKnowledgeCollection(conversation.id, collection.id, owner.id, "retrieval");
      const context = await buildKnowledgeContext(repo, conversation.id, owner.id, "turbine");
      assertEquals(context.sources.length, 1);
      assertStringIncludes(String(context.message?.content), "Postgres turbine runbook");
      const vector = Array(1536).fill(0);
      vector[11] = 1;
      await repo.upsertDocumentChunkEmbeddings([{
        chunkId,
        ownerId: owner.id,
        model: "embed-test",
        version: "embed-v1",
        contentSha256: "e".repeat(64),
        embedding: vector,
      }]);
      const semantic = await buildKnowledgeContext(repo, conversation.id, owner.id, "spaceship", {
        queryEmbedding: vector,
        embeddingVersion: "embed-v1",
      });
      assertEquals(semantic.sources.map((source) => source.chunkId), [chunkId]);
      await assertRejects(
        () =>
          repo.upsertDocumentChunkEmbeddings([{
            chunkId,
            ownerId: stranger.id,
            model: "embed-test",
            version: "embed-v1",
            contentSha256: "e".repeat(64),
            embedding: vector,
          }]),
        DomainError,
        "not found",
      );
      await assertRejects(
        () => buildKnowledgeContext(repo, conversation.id, stranger.id, "turbine"),
        DomainError,
        "not found",
      );
    } finally {
      await repo.close();
    }
  },
});
