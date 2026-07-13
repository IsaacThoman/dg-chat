import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { parseConversationPortabilityV1 } from "@dg-chat/contracts";
import { DomainError, MemoryRepository } from "./memory.ts";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const NOW = "2026-07-12T04:00:00.000Z";

function archive(title = "Portable branch") {
  return parseConversationPortabilityV1({
    format: "dgchat.owner-export",
    version: 1,
    scope: "owner",
    exportedAt: NOW,
    preferences: {
      theme: "dark",
      compactConversations: true,
      reduceMotion: false,
      customInstructions: "Do not leak me",
      useMemory: false,
      saveHistory: true,
      preferredModelId: null,
    },
    folders: [{ id: id(1), name: "Research", position: 0, createdAt: NOW, updatedAt: NOW }],
    tags: [{ id: id(2), name: "Keep", color: "#123ABC", createdAt: NOW, updatedAt: NOW }],
    attachments: [{
      id: id(3),
      filename: "diagram.png",
      mimeType: "image/png",
      byteSize: 123,
      sha256: "a".repeat(64),
      width: 20,
      height: 10,
      createdAt: NOW,
      content: { included: false },
    }],
    conversations: [{
      id: id(4),
      title,
      activeLeafId: id(7),
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
        content: "Explain",
        model: null,
        status: "complete",
        metadata: {},
        attachments: [{ attachmentId: id(3), position: 0 }],
        createdAt: NOW,
      }, {
        id: id(6),
        parentId: id(5),
        supersedesId: null,
        generationId: id(8),
        siblingIndex: 0,
        role: "assistant",
        content: "Old",
        model: "safe/model",
        status: "tombstoned",
        metadata: { finishReason: "stop" },
        attachments: [],
        createdAt: NOW,
      }, {
        id: id(7),
        parentId: id(5),
        supersedesId: id(6),
        generationId: id(8),
        siblingIndex: 1,
        role: "assistant",
        content: "New",
        model: "safe/model",
        status: "complete",
        metadata: {},
        attachments: [],
        createdAt: NOW,
      }],
    }],
  });
}

Deno.test("memory owner portability dry-run, apply, replay, remap, and drift are safe", async () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "portable@example.com", name: "Portable" });
  const other = repo.createUser({ email: "other-portable@example.com", name: "Other" });
  const input = archive();

  const preview = await repo.importConversationPortability(owner.id, input, "owner-import", true);
  assertEquals(preview.dryRun, true);
  assertEquals(repo.listConversations(owner.id).length, 0);

  const applied = await repo.importConversationPortability(owner.id, input, "owner-import");
  assertEquals({ ...applied, idMap: undefined }, {
    dryRun: false,
    replayed: false,
    conversations: 1,
    messages: 3,
    attachments: 1,
    folders: 1,
    tags: 1,
    idMap: undefined,
  });
  for (const oldId of [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8)]) {
    assertNotEquals(applied.idMap[oldId], oldId);
  }
  const detail = repo.detail(applied.idMap[id(4)], owner.id);
  assertEquals(detail.activeLeafId, applied.idMap[id(7)]);
  assertEquals(
    detail.messages.find((node) => node.id === applied.idMap[id(7)])?.supersedesId,
    applied.idMap[id(6)],
  );
  assertEquals(repo.listAttachments(owner.id, true)[0].state, "failed");
  assertEquals(repo.getUserPreferences(owner.id).theme, "dark");
  assertEquals(
    repo.exportConversationPortability(owner.id, { includeDeleted: true }).attachments[0]
      .width,
    20,
  );
  assertEquals(repo.listConversations(other.id).length, 0);

  const replay = await repo.importConversationPortability(owner.id, input, "owner-import");
  assertEquals(replay.replayed, true);
  assertEquals(replay.idMap, applied.idMap);
  assertEquals(repo.listConversations(owner.id).length, 1);
  assertEquals(repo.getUserPreferences(owner.id).version, 2);
  await assertRejects(
    () => repo.importConversationPortability(owner.id, archive("Drift"), "owner-import"),
    DomainError,
    "differs",
  );
  assertEquals(repo.listConversations(owner.id).length, 1);
});

Deno.test("memory owner export defaults private lifecycle and emits only referenced workspace", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "export@example.com", name: "Export" });
  const saved = repo.createConversation(owner.id, "Saved");
  const temporary = repo.createConversation(owner.id, "Temporary", true);
  const deleted = repo.createConversation(owner.id, "Deleted");
  repo.updateConversation(owner.id, deleted.id, { expectedVersion: 0, deleted: true });
  const temporaryNodeId = crypto.randomUUID();
  repo.messages.set(temporaryNodeId, {
    id: temporaryNodeId,
    conversationId: temporary.id,
    parentId: null,
    supersedesId: null,
    generationId: null,
    siblingIndex: 0,
    role: "assistant",
    content: "pending",
    model: null,
    status: "streaming",
    metadata: {},
    createdAt: NOW,
  });
  const output = repo.exportConversationPortability(owner.id);
  assertEquals(output.conversations.map((value) => value.id), [saved.id]);
  assertEquals(output.folders, []);
  assertEquals(output.tags, []);
  assertEquals(output.attachments, []);
  const serialized = JSON.stringify(output);
  assertEquals(serialized.includes(owner.email), false);
  assertEquals(serialized.includes("balanceMicros"), false);
  assertEquals(serialized.includes("tokenHash"), false);
  assertEquals(serialized.includes("providerCredential"), false);
});

Deno.test("memory owner export rejects selected in-flight nodes without mutating them", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "stream-export@example.com", name: "Stream" });
  const conversation = repo.createConversation(owner.id, "Active");
  const nodeId = crypto.randomUUID();
  repo.messages.set(nodeId, {
    id: nodeId,
    conversationId: conversation.id,
    parentId: null,
    supersedesId: null,
    generationId: crypto.randomUUID(),
    siblingIndex: 0,
    role: "assistant",
    content: "pending",
    model: null,
    status: "streaming",
    metadata: {},
    createdAt: NOW,
  });
  repo.conversations.get(conversation.id)!.activeLeafId = nodeId;
  try {
    repo.exportConversationPortability(owner.id);
    throw new Error("expected export to fail");
  } catch (error) {
    assertEquals(error instanceof DomainError && error.code === "export_in_progress", true);
  }
  assertEquals(repo.messages.get(nodeId)?.status, "streaming");
});
