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
