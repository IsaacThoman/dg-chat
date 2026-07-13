import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { parseConversationPortabilityV1 } from "@dg-chat/contracts";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const NOW = "2026-07-12T04:00:00.000Z";

function archive(title = "PostgreSQL portable") {
  return parseConversationPortabilityV1({
    format: "dgchat.owner-export",
    version: 1,
    scope: "owner",
    exportedAt: NOW,
    preferences: {
      theme: "dark",
      compactConversations: false,
      reduceMotion: false,
      customInstructions: "",
      useMemory: false,
      saveHistory: true,
      preferredModelId: null,
    },
    folders: [{ id: id(1), name: "Research", position: 0, createdAt: NOW, updatedAt: NOW }],
    tags: [{ id: id(2), name: "Keep", color: "#123ABC", createdAt: NOW, updatedAt: NOW }],
    attachments: [{
      id: id(3),
      filename: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
      sha256: "b".repeat(64),
      width: null,
      height: null,
      createdAt: NOW,
      content: { included: false },
    }],
    conversations: [{
      id: id(4),
      title,
      activeLeafId: id(5),
      pinned: true,
      temporary: false,
      archivedAt: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      folderId: id(1),
      folderPosition: 0,
      tagIds: [id(2)],
      messages: [{
        id: id(5),
        parentId: null,
        supersedesId: null,
        generationId: null,
        siblingIndex: 0,
        role: "user",
        content: "Portable",
        model: null,
        status: "complete",
        metadata: {},
        attachments: [{ attachmentId: id(3), position: 0 }],
        createdAt: NOW,
      }],
    }],
  });
}

Deno.test({
  name: "PostgreSQL owner portability is transactional, isolated, remapped, and idempotent",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 2 });
    const suffix = crypto.randomUUID();
    const owner = await repo.createUser({ email: `portable-${suffix}@example.com`, name: "Owner" });
    const other = await repo.createUser({
      email: `portable-other-${suffix}@example.com`,
      name: "Other",
    });
    try {
      const input = archive();
      const preview = await repo.importConversationPortability(owner.id, input, "pg-import", true);
      assertEquals(preview.dryRun, true);
      assertEquals((await repo.listConversations(owner.id)).length, 0);

      const [first, replay] = await Promise.all([
        repo.importConversationPortability(owner.id, input, "pg-import"),
        repo.importConversationPortability(owner.id, input, "pg-import"),
      ]);
      const applied = first.replayed ? replay : first;
      const repeated = first.replayed ? first : replay;
      assertEquals(applied.replayed, false);
      assertEquals(repeated.replayed, true);
      assertEquals(applied.idMap, repeated.idMap);
      assertNotEquals(applied.idMap[id(4)], id(4));
      assertEquals((await repo.listConversations(owner.id)).length, 1);
      assertEquals((await repo.listConversations(other.id)).length, 0);

      const detail = await repo.detail(applied.idMap[id(4)], owner.id);
      assertEquals(detail.activeLeafId, applied.idMap[id(5)]);
      assertEquals(detail.messages[0].id, applied.idMap[id(5)]);
      assertEquals((await repo.listAttachments(owner.id, true))[0].state, "failed");
      assertEquals((await repo.getUserPreferences(owner.id)).theme, "dark");
      const workspace = await repo.listConversationFolders(owner.id);
      assertEquals(workspace.memberships[0].conversationId, applied.idMap[id(4)]);
      assertEquals(
        (await repo.listConversationTags(owner.id)).bindings[0].tagId,
        applied.idMap[id(2)],
      );

      const exported = await repo.exportConversationPortability(owner.id, { includeDeleted: true });
      assertEquals(exported.conversations.length, 1);
      assertEquals(exported.conversations[0].messages[0].attachments.length, 1);
      assertEquals(exported.conversations[0].folderPosition, 0);
      assertEquals(JSON.stringify(exported).includes(owner.email), false);

      await assertRejects(
        () => repo.importConversationPortability(owner.id, archive("payload drift"), "pg-import"),
        DomainError,
        "differs",
      );
      assertEquals((await repo.listConversations(owner.id)).length, 1);
      assertEquals(
        (await sql<{ count: number }[]>`SELECT count(*)::int count
        FROM conversation_portability_imports WHERE owner_id=${owner.id}`)[0].count,
        1,
      );
    } finally {
      await sql`DELETE FROM message_attachments WHERE attachment_id IN (
        SELECT id FROM attachments WHERE owner_id IN (${owner.id},${other.id})
      )`;
      await sql`DELETE FROM attachments WHERE owner_id IN (${owner.id},${other.id})`;
      await sql`DELETE FROM audit_events WHERE actor_id IN (${owner.id},${other.id})`;
      await sql`DELETE FROM users WHERE id IN (${owner.id},${other.id})`;
      await sql.end();
      await repo.close();
    }
  },
});
