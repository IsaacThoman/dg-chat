// deno-lint-ignore-file no-explicit-any
// Invalid archives intentionally violate the inferred fixture type; `any` keeps each adversarial
// mutation local and readable while the parser remains the subject under test.
import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  conversationPortabilityV1Schema,
  DGCHAT_FORMAT,
  DGCHAT_VERSION,
  parseConversationPortabilityV1,
} from "./conversation_portability.ts";

const IDS = {
  conversation: "00000000-0000-4000-8000-000000000001",
  otherConversation: "00000000-0000-4000-8000-000000000002",
  root: "00000000-0000-4000-8000-000000000003",
  firstAnswer: "00000000-0000-4000-8000-000000000004",
  editedAnswer: "00000000-0000-4000-8000-000000000005",
  attachment: "00000000-0000-4000-8000-000000000006",
  folder: "00000000-0000-4000-8000-000000000007",
  tag: "00000000-0000-4000-8000-000000000008",
  generation: "00000000-0000-4000-8000-000000000009",
};
const NOW = "2026-07-12T04:00:00.000Z";

function fixture() {
  return {
    format: DGCHAT_FORMAT,
    version: DGCHAT_VERSION,
    scope: "owner" as const,
    exportedAt: NOW,
    preferences: {
      theme: "system" as const,
      compactConversations: false,
      reduceMotion: false,
      customInstructions: "Be exact.",
      useMemory: false,
      saveHistory: true,
      preferredModelId: null,
    },
    folders: [{ id: IDS.folder, name: "Research", position: 0, createdAt: NOW, updatedAt: NOW }],
    tags: [{ id: IDS.tag, name: "Keep", color: "#12aBcD", createdAt: NOW, updatedAt: NOW }],
    attachments: [{
      id: IDS.attachment,
      filename: "diagram.png",
      mimeType: "image/png",
      byteSize: 123,
      sha256: "a".repeat(64),
      width: 20,
      height: 10,
      createdAt: NOW,
      content: { included: false as const },
    }],
    conversations: [{
      id: IDS.conversation,
      title: "A branched chat",
      activeLeafId: IDS.editedAnswer,
      pinned: true,
      temporary: false,
      archivedAt: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      folderId: IDS.folder,
      folderPosition: 0,
      tagIds: [IDS.tag],
      messages: [{
        id: IDS.root,
        parentId: null,
        supersedesId: null,
        generationId: null,
        siblingIndex: 0,
        role: "user" as const,
        content: "Explain this",
        model: null,
        status: "complete" as const,
        metadata: {},
        attachments: [{ attachmentId: IDS.attachment, position: 0 }],
        createdAt: NOW,
      }, {
        id: IDS.firstAnswer,
        parentId: IDS.root,
        supersedesId: null,
        generationId: IDS.generation,
        siblingIndex: 0,
        role: "assistant" as const,
        content: "Original",
        model: "provider/model",
        status: "tombstoned" as const,
        metadata: { finishReason: "stop" },
        attachments: [],
        createdAt: NOW,
      }, {
        id: IDS.editedAnswer,
        parentId: IDS.root,
        supersedesId: IDS.firstAnswer,
        generationId: IDS.generation,
        siblingIndex: 1,
        role: "assistant" as const,
        content: "Edited branch",
        model: "provider/model",
        status: "complete" as const,
        metadata: {},
        attachments: [],
        createdAt: NOW,
      }],
    }],
  };
}

Deno.test("conversation portability v1 accepts an immutable branched owner archive", () => {
  const archive = parseConversationPortabilityV1(fixture());
  assertEquals(archive.conversations[0].messages.length, 3);
  assertEquals(archive.conversations[0].activeLeafId, IDS.editedAnswer);
});

Deno.test("conversation portability v1 rejects unknown and sensitive fields at every level", () => {
  for (
    const mutate of [
      (value: any) => value.apiTokens = [],
      (value: any) => value.preferences.ownerId = IDS.root,
      (value: any) => value.conversations[0].balanceMicros = 5_000_000,
      (value: any) => value.conversations[0].messages[0].providerKey = "secret",
      (value: any) => value.attachments[0].objectKey = "private/bucket/key",
    ]
  ) {
    const value: any = fixture();
    mutate(value);
    assertEquals(conversationPortabilityV1Schema.safeParse(value).success, false);
  }
});

Deno.test("conversation portability v1 rejects dangling and cross-conversation message edges", () => {
  for (const field of ["parentId", "supersedesId"] as const) {
    const value: any = fixture();
    value.conversations[0].messages[2][field] = IDS.otherConversation;
    assertEquals(conversationPortabilityV1Schema.safeParse(value).success, false);
  }

  const value: any = fixture();
  value.conversations.push({
    ...structuredClone(value.conversations[0]),
    id: IDS.otherConversation,
    activeLeafId: null,
    folderId: null,
    folderPosition: null,
    tagIds: [],
    messages: [],
  });
  value.conversations[0].messages[2].parentId = IDS.otherConversation;
  assertEquals(conversationPortabilityV1Schema.safeParse(value).success, false);
});

Deno.test("conversation portability v1 rejects parent cycles", () => {
  const value: any = fixture();
  value.conversations[0].messages[0].parentId = IDS.editedAnswer;
  value.conversations[0].messages[0].siblingIndex = 0;
  assertEquals(conversationPortabilityV1Schema.safeParse(value).success, false);
});

Deno.test("conversation portability v1 rejects supersession cycles and archive-wide message collisions", () => {
  const cycle: any = fixture();
  cycle.conversations[0].messages[1].supersedesId = IDS.editedAnswer;
  assertEquals(conversationPortabilityV1Schema.safeParse(cycle).success, false);

  const collision: any = fixture();
  collision.conversations.push({
    ...structuredClone(collision.conversations[0]),
    id: IDS.otherConversation,
    activeLeafId: IDS.root,
    folderId: null,
    folderPosition: null,
    tagIds: [],
    messages: [structuredClone(collision.conversations[0].messages[0])],
  });
  assertEquals(conversationPortabilityV1Schema.safeParse(collision).success, false);
});

Deno.test("conversation portability v1 validates a maximum-length chain without quadratic traversal", () => {
  const value: any = fixture();
  const messages = [];
  for (let index = 0; index < 20_000; index++) {
    const suffix = index.toString(16).padStart(12, "0");
    const messageId = `00000000-0000-4000-8001-${suffix}`;
    const parentSuffix = (index - 1).toString(16).padStart(12, "0");
    messages.push({
      ...structuredClone(value.conversations[0].messages[0]),
      id: messageId,
      parentId: index === 0 ? null : `00000000-0000-4000-8001-${parentSuffix}`,
      siblingIndex: 0,
      attachments: [],
    });
  }
  value.conversations[0].messages = messages;
  value.conversations[0].activeLeafId = messages.at(-1).id;
  assertEquals(conversationPortabilityV1Schema.safeParse(value).success, true);
});

Deno.test("conversation portability v1 enforces contiguous, unique sibling order", () => {
  for (const index of [0, 3]) {
    const value: any = fixture();
    value.conversations[0].messages[2].siblingIndex = index;
    assertEquals(conversationPortabilityV1Schema.safeParse(value).success, false);
  }
});

Deno.test("conversation portability v1 enforces a terminal active leaf", () => {
  for (const leaf of [null, IDS.root, IDS.otherConversation]) {
    const value: any = fixture();
    value.conversations[0].activeLeafId = leaf;
    assertEquals(conversationPortabilityV1Schema.safeParse(value).success, false);
  }
  const empty: any = fixture();
  empty.conversations[0].messages = [];
  empty.conversations[0].activeLeafId = IDS.root;
  assertEquals(conversationPortabilityV1Schema.safeParse(empty).success, false);
});

Deno.test("conversation portability v1 validates workspace and attachment references", () => {
  for (
    const mutate of [
      (value: any) => value.conversations[0].folderId = IDS.otherConversation,
      (value: any) => value.conversations[0].tagIds = [IDS.otherConversation],
      (value: any) =>
        value.conversations[0].messages[0].attachments[0].attachmentId = IDS.otherConversation,
      (value: any) => value.conversations[0].tagIds = [IDS.tag, IDS.tag],
    ]
  ) {
    const value: any = fixture();
    mutate(value);
    assertEquals(conversationPortabilityV1Schema.safeParse(value).success, false);
  }
});

Deno.test("conversation portability v1 requires deterministic folder and attachment positions", () => {
  const folderGap: any = fixture();
  folderGap.folders[0].position = 1;
  assertEquals(conversationPortabilityV1Schema.safeParse(folderGap).success, false);

  const attachmentGap: any = fixture();
  attachmentGap.conversations[0].messages[0].attachments[0].position = 1;
  assertEquals(conversationPortabilityV1Schema.safeParse(attachmentGap).success, false);

  const missingMembershipPosition: any = fixture();
  missingMembershipPosition.conversations[0].folderPosition = null;
  assertEquals(conversationPortabilityV1Schema.safeParse(missingMembershipPosition).success, false);

  const membershipGap: any = fixture();
  membershipGap.conversations[0].folderPosition = 1;
  assertEquals(conversationPortabilityV1Schema.safeParse(membershipGap).success, false);
});

Deno.test("conversation portability v1 rejects invalid supersession and duplicate attachment ordering", () => {
  const wrongRole: any = fixture();
  wrongRole.conversations[0].messages[2].role = "user";
  assertEquals(conversationPortabilityV1Schema.safeParse(wrongRole).success, false);

  const wrongParent: any = fixture();
  wrongParent.conversations[0].messages[2].parentId = null;
  wrongParent.conversations[0].messages[2].siblingIndex = 1;
  assertEquals(conversationPortabilityV1Schema.safeParse(wrongParent).success, false);

  const duplicate: any = fixture();
  duplicate.conversations[0].messages[0].attachments.push({
    attachmentId: IDS.attachment,
    position: 1,
  });
  assertEquals(conversationPortabilityV1Schema.safeParse(duplicate).success, false);
});

Deno.test("conversation portability v1 bounds metadata and requires the exact format version", () => {
  const oversized: any = fixture();
  oversized.conversations[0].messages[0].metadata = { value: "x".repeat(70_000) };
  assertEquals(conversationPortabilityV1Schema.safeParse(oversized).success, false);

  const nonJson: any = fixture();
  nonJson.conversations[0].messages[0].metadata = { value: 1n };
  assertEquals(conversationPortabilityV1Schema.safeParse(nonJson).success, false);

  const cyclic: any = fixture();
  cyclic.conversations[0].messages[0].metadata.self = cyclic.conversations[0].messages[0].metadata;
  assertEquals(conversationPortabilityV1Schema.safeParse(cyclic).success, false);

  const tooDeep: any = fixture();
  let cursor = tooDeep.conversations[0].messages[0].metadata;
  for (let index = 0; index < 14; index++) cursor = cursor.next = {};
  assertEquals(conversationPortabilityV1Schema.safeParse(tooDeep).success, false);

  for (const [field, replacement] of [["format", "chat-export"], ["version", 2]] as const) {
    const value: any = fixture();
    value[field] = replacement;
    assertThrows(() => parseConversationPortabilityV1(value));
  }
});

Deno.test("conversation portability v1 rejects in-flight streaming nodes", () => {
  const value: any = fixture();
  value.conversations[0].messages[2].status = "streaming";
  assertEquals(conversationPortabilityV1Schema.safeParse(value).success, false);
});
