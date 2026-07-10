import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

Deno.test("message edits append immutable sibling branches", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "u@example.com",
    name: "User",
    passwordHash: "x",
    approvalStatus: "approved",
  });
  const conversation = repo.createConversation(user.id, "Branches");
  const original = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: null,
    role: "user",
    content: "first",
    expectedVersion: 0,
    idempotencyKey: "request-0001",
  });
  const edited = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: null,
    supersedesId: original.id,
    role: "user",
    content: "edited",
    expectedVersion: 1,
    idempotencyKey: "request-0002",
  });
  assertEquals(original.content, "first");
  assertEquals(edited.siblingIndex, 1);
  assertEquals(edited.supersedesId, original.id);
  assertEquals(repo.detail(conversation.id, user.id).messages.length, 2);
});

Deno.test("optimistic versioning prevents lost updates and idempotency replays safely", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({ email: "u@example.com", name: "User", passwordHash: "x" });
  const conversation = repo.createConversation(user.id, "Race");
  const input = {
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: null,
    role: "user" as const,
    content: "hello",
    expectedVersion: 0,
    idempotencyKey: "request-0001",
  };
  const first = repo.appendMessage(input);
  assertEquals(repo.appendMessage(input).id, first.id);
  assertThrows(
    () => repo.appendMessage({ ...input, idempotencyKey: "request-0002" }),
    DomainError,
    "another tab",
  );
});

Deno.test("ledger reserve settle and refund are idempotent", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({ email: "u@example.com", name: "User", passwordHash: "x" });
  repo.credit(user.id, "grant", "grant", 5_000_000);
  repo.reserve(user.id, "run-1", "simulated/dg-chat", 10_000);
  repo.settle("run-1", 100, 10, 20, 5);
  repo.settle("run-1", 100, 10, 20, 5);
  assertEquals(user.balanceMicros, 4_999_900);
  assertEquals(repo.usage(user.id).spentMicros, 100);
});

Deno.test("replays authorize and reject payload mismatch; active leaf must be terminal", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "owner@example.com", name: "Owner", passwordHash: "x" });
  const stranger = repo.createUser({
    email: "stranger@example.com",
    name: "Stranger",
    passwordHash: "x",
  });
  const chat = repo.createConversation(owner.id, "Chat", false, "create-key");
  assertEquals(repo.createConversation(owner.id, "Chat", false, "create-key").id, chat.id);
  assertThrows(() => repo.createConversation(owner.id, "Other", false, "create-key"), DomainError);
  const root = repo.appendMessage({
    conversationId: chat.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "one",
    expectedVersion: 0,
    idempotencyKey: "message-key",
  });
  assertThrows(
    () =>
      repo.appendMessage({
        conversationId: chat.id,
        ownerId: stranger.id,
        parentId: null,
        role: "user",
        content: "one",
        expectedVersion: 1,
        idempotencyKey: "message-key",
      }),
    DomainError,
  );
  assertThrows(
    () =>
      repo.appendMessage({
        conversationId: chat.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "different",
        expectedVersion: 1,
        idempotencyKey: "message-key",
      }),
    DomainError,
  );
  repo.appendMessage({
    conversationId: chat.id,
    ownerId: owner.id,
    parentId: root.id,
    role: "assistant",
    content: "two",
    expectedVersion: 1,
    idempotencyKey: "child-key",
  });
  assertThrows(() => repo.setActiveLeaf(chat.id, owner.id, root.id, 2), DomainError, "leaf");
});

Deno.test("approval grant is minted once and rejection revokes sessions and tokens", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "approval@example.com",
    name: "Approval",
    passwordHash: "x",
  });
  repo.approveUser(user.id, "approved", 100);
  repo.reserve(user.id, "spend", "model", 100);
  repo.settle("spend", 100, 1, 1, 1);
  repo.approveUser(user.id, "rejected", 100);
  repo.approveUser(user.id, "approved", 100);
  assertEquals(user.balanceMicros, 0);
  repo.createSession(user.id, "session", false);
  const token = repo.createApiToken(user.id, {
    name: "token",
    scopes: ["chat:write"],
    tokenHash: "hash",
    preview: "hash",
  });
  repo.approveUser(user.id, "rejected", 100);
  assertEquals(repo.getSession("session"), undefined);
  assertEquals(Boolean(token.revokedAt), true);
});
