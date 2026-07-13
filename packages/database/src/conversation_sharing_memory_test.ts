import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";
import {
  MAX_ACTIVE_CONVERSATION_SHARES,
  MAX_CONVERSATION_SHARE_CONTENT_CHARS,
} from "./repository.ts";
import type { CreateConversationShareInput } from "./repository.ts";

function setup() {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "share-owner@example.com",
    name: "Snapshot Owner",
    approvalStatus: "approved",
  });
  const other = repo.createUser({
    email: "share-other@example.com",
    name: "Other",
    approvalStatus: "approved",
  });
  const conversation = repo.createConversation(owner.id, "Immutable branch");
  const root = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "Question",
    expectedVersion: 0,
    idempotencyKey: "share-root",
  });
  const leaf = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: root.id,
    role: "assistant",
    content: "Original answer",
    model: "provider/model",
    expectedVersion: 1,
    idempotencyKey: "share-leaf",
  });
  const attachmentId = crypto.randomUUID();
  repo.attachments.set(attachmentId, {
    id: attachmentId,
    ownerId: owner.id,
    objectKey: `private/${owner.id}/${attachmentId}`,
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 128,
    sha256: "a".repeat(64),
    state: "ready",
    inspectionError: null,
    ingestionStatus: "not_applicable",
    ingestionError: null,
    ingestedAt: null,
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    deletedAt: null,
  });
  repo.attachmentDimensions.set(attachmentId, { width: 20, height: 10 });
  repo.messageAttachments.set(root.id, new Set([attachmentId]));
  const input: CreateConversationShareInput = {
    conversationId: conversation.id,
    leafId: leaf.id,
    expectedConversationVersion: 2,
    identityVisibility: "owner",
    attachmentPolicy: "include",
    selectedAttachmentIds: [],
    expiresAt: null,
    idempotencyKey: "share-create-1",
    secretHash: "b".repeat(64),
  };
  return { repo, owner, other, conversation, root, leaf, attachmentId, input };
}

Deno.test("memory share materializes an immutable private-ID-free path and attachment access", async () => {
  const { repo, owner, conversation, leaf, attachmentId, input } = setup();
  const created = await repo.createConversationShare(owner.id, input);
  assertEquals(created.replayed, false);
  assertEquals(created.share.conversationVersion, 2);
  assertEquals(created.share.leafId, leaf.id);
  const snapshot = repo.resolvePublicConversationShare(input.secretHash)!;
  assertEquals(snapshot.messages.map((value) => value.content), ["Question", "Original answer"]);
  assertEquals(snapshot.identity, { visibility: "owner", displayName: "Snapshot Owner" });
  assertEquals(snapshot.attachments.length, 1);
  assertNotEquals(snapshot.attachments[0].id, attachmentId);
  const serialized = JSON.stringify(snapshot);
  assertEquals(serialized.includes(owner.email), false);
  assertEquals(serialized.includes(conversation.id), false);
  assertEquals(serialized.includes(leaf.id), false);
  assertEquals(serialized.includes("private/"), false);
  const access = repo.resolvePublicShareAttachment(input.secretHash, snapshot.attachments[0].id)!;
  assertEquals(access.objectKey, `private/${owner.id}/${attachmentId}`);

  repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: leaf.id,
    role: "user",
    content: "Later edit",
    expectedVersion: 2,
    idempotencyKey: "later-edit",
  });
  assertEquals(
    repo.resolvePublicConversationShare(input.secretHash)!.messages.map((value) => value.content),
    ["Question", "Original answer"],
  );
});

Deno.test("memory share create is concurrent-idempotent, drift-safe, owner-scoped, and audited", async () => {
  const { repo, owner, other, input } = setup();
  const [one, two] = await Promise.all([
    repo.createConversationShare(owner.id, input),
    repo.createConversationShare(owner.id, input),
  ]);
  assertEquals([one.replayed, two.replayed].sort(), [false, true]);
  assertEquals(one.share.id, two.share.id);
  assertEquals(repo.listConversationShares(owner.id).length, 1);
  assertEquals(repo.getConversationShare(owner.id, one.share.id).id, one.share.id);
  assertEquals(repo.listConversationShares(other.id), []);
  await assertRejects(
    () => repo.createConversationShare(owner.id, { ...input, secretHash: "c".repeat(64) }),
    DomainError,
    "differs",
  );
  assertThrows(
    () => repo.getConversationShare(other.id, one.share.id),
    DomainError,
    "not found",
  );
  assertEquals(
    repo.auditEvents.filter((value) => value.action === "conversation.share_created").length,
    1,
  );
  assertEquals(JSON.stringify(repo.auditEvents).includes(input.secretHash), false);
});

Deno.test("memory share excludes tombstoned and hidden-instruction nodes and re-chains", async () => {
  const { repo, owner, root, input } = setup();
  repo.messages.get(root.id)!.status = "tombstoned";
  repo.messages.get(root.id)!.content = "deleted private text";
  await repo.createConversationShare(owner.id, input);
  const snapshot = repo.resolvePublicConversationShare(input.secretHash)!;
  assertEquals(snapshot.messages.length, 1);
  assertEquals(snapshot.messages[0].parentId, null);
  assertEquals(JSON.stringify(snapshot).includes("deleted private text"), false);

  const hidden = setup();
  hidden.repo.messages.get(hidden.root.id)!.role = "developer";
  hidden.repo.messages.get(hidden.root.id)!.content = "private custom instructions";
  await hidden.repo.createConversationShare(hidden.owner.id, hidden.input);
  const hiddenSnapshot = hidden.repo.resolvePublicConversationShare(hidden.input.secretHash)!;
  assertEquals(hiddenSnapshot.messages.length, 1);
  assertEquals(hiddenSnapshot.messages[0].parentId, null);
  assertEquals(JSON.stringify(hiddenSnapshot).includes("private custom instructions"), false);
});

Deno.test("memory share revocation, expiry, owner suspension/deletion, and attachment deletion fail closed", async () => {
  const { repo, owner, attachmentId, input } = setup();
  const created = await repo.createConversationShare(owner.id, input);
  repo.setUserState(owner.id, "suspended");
  assertEquals(repo.resolvePublicConversationShare(input.secretHash), undefined);
  repo.setUserState(owner.id, "active");
  repo.users.get(owner.id)!.deletedAt = new Date().toISOString();
  assertEquals(repo.resolvePublicConversationShare(input.secretHash), undefined);
  assertRejects(
    () => repo.createConversationShare(owner.id, input),
    DomainError,
    "cannot create shares",
  );
  assertRejects(
    () =>
      repo.createConversationShare(owner.id, {
        ...input,
        idempotencyKey: "deleted-owner-share",
        secretHash: "f".repeat(64),
      }),
    DomainError,
    "cannot create shares",
  );
  repo.users.get(owner.id)!.deletedAt = null;
  const publicAttachmentId =
    repo.resolvePublicConversationShare(input.secretHash)!.attachments[0].id;
  repo.attachments.get(attachmentId)!.deletedAt = new Date().toISOString();
  assertEquals(repo.resolvePublicShareAttachment(input.secretHash, publicAttachmentId), undefined);
  const revoked = repo.revokeConversationShare(owner.id, created.share.id, 1);
  assertEquals(revoked.version, 2);
  assertNotEquals(revoked.revokedAt, null);
  assertEquals(repo.resolvePublicConversationShare(input.secretHash), undefined);
  assertEquals(
    repo.auditEvents.filter((value) => value.action === "conversation.share_revoked").length,
    1,
  );

  const second = setup();
  await second.repo.createConversationShare(second.owner.id, {
    ...second.input,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assertEquals(
    second.repo.resolvePublicConversationShare(
      second.input.secretHash,
      "2100-01-01T00:00:00.000Z",
    ),
    undefined,
  );
});

Deno.test("memory share rejects temporary, streaming, dangling, cyclic, stale, and foreign paths", async () => {
  const { repo, owner, other, conversation, leaf, input } = setup();
  const temporary = repo.createConversation(owner.id, "Temporary", true);
  const temporaryLeaf = repo.appendMessage({
    conversationId: temporary.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "Private",
    expectedVersion: 0,
    idempotencyKey: "temporary-root",
  });
  await assertRejects(
    () =>
      repo.createConversationShare(owner.id, {
        ...input,
        conversationId: temporary.id,
        leafId: temporaryLeaf.id,
        expectedConversationVersion: 1,
        idempotencyKey: "temporary-share",
        secretHash: "1".repeat(64),
      }),
    DomainError,
    "temporary chat",
  );
  repo.messages.get(leaf.id)!.status = "streaming";
  await assertRejects(
    () =>
      repo.createConversationShare(owner.id, {
        ...input,
        idempotencyKey: "streaming",
        secretHash: "2".repeat(64),
      }),
    DomainError,
    "active generation",
  );
  repo.messages.get(leaf.id)!.status = "complete";
  await assertRejects(
    () =>
      repo.createConversationShare(owner.id, {
        ...input,
        leafId: crypto.randomUUID(),
        idempotencyKey: "dangling",
        secretHash: "3".repeat(64),
      }),
    DomainError,
    "not in this conversation",
  );
  repo.messages.get(leaf.id)!.parentId = leaf.id;
  await assertRejects(
    () =>
      repo.createConversationShare(owner.id, {
        ...input,
        idempotencyKey: "cycle",
        secretHash: "4".repeat(64),
      }),
    DomainError,
    "cycle",
  );
  repo.messages.get(leaf.id)!.parentId =
    [...repo.messages.values()].find((value) => value.content === "Question")!.id;
  await assertRejects(
    () =>
      repo.createConversationShare(owner.id, {
        ...input,
        expectedConversationVersion: 1,
        idempotencyKey: "stale",
        secretHash: "5".repeat(64),
      }),
    DomainError,
    "changed",
  );
  await assertRejects(
    () =>
      repo.createConversationShare(other.id, {
        ...input,
        idempotencyKey: "foreign",
        secretHash: "6".repeat(64),
      }),
    DomainError,
    "not found",
  );
  assertEquals(repo.listConversationShares(owner.id), []);
  assertEquals(
    repo.getConversationShare.bind(repo, owner.id, conversation.id) instanceof Function,
    true,
  );
});

Deno.test("memory selected and redacted policies validate exact path attachment membership", async () => {
  const { repo, owner, attachmentId, input } = setup();
  const selected = await repo.createConversationShare(owner.id, {
    ...input,
    attachmentPolicy: "selected",
    selectedAttachmentIds: [attachmentId],
    idempotencyKey: "selected",
    secretHash: "7".repeat(64),
  });
  assertEquals(selected.share.attachmentCount, 1);
  const redacted = await repo.createConversationShare(owner.id, {
    ...input,
    attachmentPolicy: "redact",
    idempotencyKey: "redacted",
    secretHash: "8".repeat(64),
  });
  assertEquals(redacted.share.attachmentCount, 0);
  await assertRejects(
    () =>
      repo.createConversationShare(owner.id, {
        ...input,
        attachmentPolicy: "selected",
        selectedAttachmentIds: [crypto.randomUUID()],
        idempotencyKey: "foreign-attachment",
        secretHash: "9".repeat(64),
      }),
    DomainError,
    "not on the shared path",
  );
});

Deno.test("memory sharing bounds content and active snapshot storage before materialization", async () => {
  const oversized = setup();
  oversized.repo.messages.get(oversized.root.id)!.content = "x".repeat(
    MAX_CONVERSATION_SHARE_CONTENT_CHARS + 1,
  );
  await assertRejects(
    () => oversized.repo.createConversationShare(oversized.owner.id, oversized.input),
    DomainError,
    "too large",
  );
  assertEquals(oversized.repo.listConversationShares(oversized.owner.id), []);
  const selected = setup();
  await assertRejects(
    () =>
      selected.repo.createConversationShare(selected.owner.id, {
        ...selected.input,
        attachmentPolicy: "selected",
        selectedAttachmentIds: Array.from({ length: 101 }, () => crypto.randomUUID()),
      }),
    DomainError,
    "invalid",
  );

  const bounded = setup();
  let firstInput: CreateConversationShareInput | undefined;
  for (let index = 0; index < MAX_ACTIVE_CONVERSATION_SHARES; index++) {
    const value = {
      ...bounded.input,
      attachmentPolicy: "redact" as const,
      idempotencyKey: `bounded-${index}`,
      secretHash: index.toString(16).padStart(64, "0"),
    };
    firstInput ??= value;
    await bounded.repo.createConversationShare(bounded.owner.id, value);
  }
  await assertRejects(
    () =>
      bounded.repo.createConversationShare(bounded.owner.id, {
        ...bounded.input,
        attachmentPolicy: "redact",
        idempotencyKey: "bounded-overflow",
        secretHash: `${"f".repeat(63)}e`,
      }),
    DomainError,
    "Revoke",
  );
  assertEquals(
    (await bounded.repo.createConversationShare(bounded.owner.id, firstInput!)).replayed,
    true,
  );
});
