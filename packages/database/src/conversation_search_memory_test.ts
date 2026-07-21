import { assertEquals, assertNotMatch, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";
import {
  CONVERSATION_SEARCH_CURSOR_MAX_CHARS,
  CONVERSATION_SEARCH_QUERY_VALIDATION_MESSAGE,
  decodeConversationSearchCursor,
  encodeConversationSearchCursor,
} from "./repository.ts";

function mutateCursorPosition(
  cursor: string,
  updatedAt: string,
  id: string,
): string {
  const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
  const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
  payload[1] = updatedAt;
  payload[2] = id;
  return btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

Deno.test("conversation search cursor accepts canonical millisecond and microsecond positions", () => {
  const query = { query: "needle", view: "chat" } as const;
  const ownerId = "20b5b64a-c892-4f8e-a728-cd3eb492b738";
  const id = "7e040277-af45-4754-8820-e656e62b6689";
  for (
    const updatedAt of [
      "2026-01-01T00:00:00.123Z",
      "2026-01-01T00:00:00.123456Z",
    ]
  ) {
    const cursor = encodeConversationSearchCursor({ id, updatedAt }, query, ownerId);
    assertEquals(decodeConversationSearchCursor(cursor, query, ownerId), { id, updatedAt });
  }
  for (
    const updatedAt of [
      "2026-01-01T00:00:00.1234Z",
      "2026-01-01T00:00:00.12345Z",
      "2026-02-30T00:00:00.123456Z",
      "0000-01-01T00:00:00.000000Z",
    ]
  ) {
    const cursor = encodeConversationSearchCursor({ id, updatedAt }, query, ownerId);
    assertEquals(decodeConversationSearchCursor(cursor, query, ownerId), undefined);
  }
});

Deno.test("memory conversation search is owner, lifecycle, and active-path scoped", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "search@example.com",
    name: "Search",
    approvalStatus: "approved",
  });
  const other = repo.createUser({
    email: "other-search@example.com",
    name: "Other",
    approvalStatus: "approved",
  });
  const conversation = repo.createConversation(owner.id, "Ordinary title");
  const inactive = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "inactive secret needle",
    expectedVersion: 0,
    idempotencyKey: "search-inactive",
  });
  repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    supersedesId: inactive.id,
    role: "user",
    content: "active literal 100%_NEEDLE",
    expectedVersion: 1,
    idempotencyKey: "search-active",
  });
  assertEquals(
    repo.searchConversations(owner.id, { query: "secret needle", view: "chat" }).data,
    [],
  );
  assertEquals(
    repo.searchConversations(owner.id, { query: "%_needle", view: "chat" }).data.length,
    1,
  );
  assertEquals(repo.searchConversations(other.id, { query: "%_needle", view: "chat" }).data, []);

  repo.updateConversation(owner.id, conversation.id, { expectedVersion: 2, archived: true });
  assertEquals(repo.searchConversations(owner.id, { query: "%_needle", view: "chat" }).data, []);
  assertEquals(
    repo.searchConversations(owner.id, { query: "%_needle", view: "archived" }).data.length,
    1,
  );
  repo.updateConversation(owner.id, conversation.id, { expectedVersion: 3, deleted: true });
  assertEquals(
    repo.searchConversations(owner.id, { query: "%_needle", view: "archived" }).data,
    [],
  );
  assertEquals(
    repo.searchConversations(owner.id, { query: "%_needle", view: "trash" }).data.length,
    1,
  );
});

Deno.test("memory search cursor is query-bound and snippets remove controls", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "cursor-search@example.com",
    name: "Cursor",
    approvalStatus: "approved",
  });
  for (let index = 0; index < 2; index++) {
    const conversation = repo.createConversation(owner.id, `Result ${index}`);
    repo.appendMessage({
      conversationId: conversation.id,
      ownerId: owner.id,
      parentId: null,
      role: "assistant",
      content: `before\u001b[31m <img src=x onerror=alert(1)> needle ${"x".repeat(300)}`,
      expectedVersion: 0,
      idempotencyKey: `search-result-${index}`,
    });
  }
  const first = repo.searchConversations(owner.id, { query: "needle", view: "chat", limit: 1 });
  assertEquals(first.data.length, 1);
  assertEquals(first.data[0].snippet.length <= 240, true);
  assertEquals(first.data[0].snippet.includes("\u001b"), false);
  assertEquals(first.data[0].snippet.includes("<img src=x onerror=alert(1)>"), true);
  assertEquals(first.nextCursor?.includes("needle"), false);
  const encoded = first.nextCursor!.replaceAll("-", "+").replaceAll("_", "/");
  assertNotMatch(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), /needle|img/u);
  assertThrows(
    () =>
      repo.searchConversations(owner.id, {
        query: "different",
        view: "chat",
        cursor: first.nextCursor!,
      }),
    DomainError,
    "Invalid conversation search cursor",
  );
  const other = repo.createUser({
    email: "cursor-search-other@example.com",
    name: "Other",
    approvalStatus: "approved",
  });
  assertThrows(
    () =>
      repo.searchConversations(other.id, {
        query: "needle",
        view: "chat",
        cursor: first.nextCursor!,
      }),
    DomainError,
    "Invalid conversation search cursor",
  );
  const folder = repo.createConversationFolder(owner.id, "Cursor scope", "cursor-scope");
  assertThrows(
    () =>
      repo.searchConversations(owner.id, {
        query: "needle",
        view: "chat",
        folderId: folder.id,
        cursor: first.nextCursor!,
      }),
    DomainError,
    "Invalid conversation search cursor",
  );
  assertEquals(
    repo.searchConversations(owner.id, {
      query: "needle",
      view: "chat",
      limit: 1,
      cursor: first.nextCursor!,
    }).data.length,
    1,
  );
});

Deno.test("memory search rejects forged, stale, oversized, and noncanonical cursors", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "cursor-integrity@example.com",
    name: "Cursor integrity",
    approvalStatus: "approved",
  });
  for (let index = 0; index < 2; index++) {
    repo.createConversation(owner.id, `integrity needle ${index}`);
  }
  const query = { query: "integrity needle", view: "chat" as const, limit: 1 };
  const first = repo.searchConversations(owner.id, query);
  const cursor = first.nextCursor!;
  for (
    const invalidCursor of [
      mutateCursorPosition(
        cursor,
        first.data[0].updatedAt,
        "00000000-0000-4000-8000-000000000001",
      ),
      mutateCursorPosition(cursor, "2020-01-01T00:00:00.000Z", first.data[0].id),
      cursor + "=",
      `.${cursor}`,
      "a".repeat(CONVERSATION_SEARCH_CURSOR_MAX_CHARS + 1),
    ]
  ) {
    assertThrows(
      () => repo.searchConversations(owner.id, { ...query, cursor: invalidCursor }),
      DomainError,
      "Invalid conversation search cursor",
    );
  }

  repo.conversations.get(first.data[0].id)!.updatedAt = "2030-01-01T00:00:00.000Z";
  assertThrows(
    () => repo.searchConversations(owner.id, { ...query, cursor }),
    DomainError,
    "Invalid conversation search cursor",
  );
});

Deno.test("memory scoped cursor becomes uniformly invalid when its folder is deleted", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "cursor-deleted-scope@example.com",
    name: "Deleted cursor scope",
    approvalStatus: "approved",
  });
  const folder = repo.createConversationFolder(owner.id, "Ephemeral scope", "cursor-scope-delete");
  const now = new Date().toISOString();
  for (let index = 0; index < 2; index++) {
    const conversation = repo.createConversation(owner.id, `scope deletion needle ${index}`);
    repo.conversationFolderMemberships.set(conversation.id, {
      folderId: folder.id,
      conversationId: conversation.id,
      ownerId: owner.id,
      position: index,
      createdAt: now,
      updatedAt: now,
    });
  }
  const query = {
    query: "scope deletion needle",
    view: "chat" as const,
    folderId: folder.id,
    limit: 1,
  };
  const cursor = repo.searchConversations(owner.id, query).nextCursor!;
  repo.deleteConversationFolder(owner.id, folder.id, folder.version, folder.membershipVersion);
  assertThrows(
    () => repo.searchConversations(owner.id, { ...query, cursor }),
    DomainError,
    "Invalid conversation search cursor",
  );
});

Deno.test("memory search applies owned workspace scope before pagination", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "scoped-search@example.com",
    name: "Scoped",
    approvalStatus: "approved",
  });
  const folder = repo.createConversationFolder(owner.id, "Chosen", "search-folder");
  const tag = repo.createConversationTag(owner.id, "Chosen tag", "#123456", "search-tag");
  const secondTag = repo.createConversationTag(
    owner.id,
    "Second tag",
    "#654321",
    "search-tag-second",
  );
  const target = repo.createConversation(owner.id, "needle inside");
  target.updatedAt = "2000-01-01T00:00:00.000Z";
  for (let index = 0; index < 30; index++) {
    repo.createConversation(owner.id, `needle outside ${index}`);
  }
  assertEquals(
    repo.searchConversations(owner.id, { query: "needle", view: "chat", limit: 25 }).data.some(
      (conversation) => conversation.id === target.id,
    ),
    false,
  );
  const now = new Date().toISOString();
  repo.conversationFolderMemberships.set(target.id, {
    folderId: folder.id,
    conversationId: target.id,
    ownerId: owner.id,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  repo.conversationTagSets.set(target.id, {
    conversationId: target.id,
    ownerId: owner.id,
    version: 1,
    updatedAt: now,
  });
  repo.conversationTagBindings.set(`${target.id}:${tag.id}`, {
    conversationId: target.id,
    tagId: tag.id,
    ownerId: owner.id,
    createdAt: now,
  });
  repo.conversationTagBindings.set(`${target.id}:${secondTag.id}`, {
    conversationId: target.id,
    tagId: secondTag.id,
    ownerId: owner.id,
    createdAt: now,
  });
  const page = repo.searchConversations(owner.id, {
    query: "needle",
    view: "chat",
    folderId: folder.id,
    tagIds: [tag.id, secondTag.id],
    limit: 1,
  });
  assertEquals(page.data.map((item) => item.id), [target.id]);
  assertEquals(page.nextCursor, null);
  const onlyFirstTag = repo.createConversation(owner.id, "needle only one tag");
  repo.conversationTagBindings.set(`${onlyFirstTag.id}:${tag.id}`, {
    conversationId: onlyFirstTag.id,
    tagId: tag.id,
    ownerId: owner.id,
    createdAt: now,
  });
  assertEquals(
    repo.searchConversations(owner.id, {
      query: "needle",
      view: "chat",
      tagIds: [tag.id, secondTag.id],
    }).data.some((item) => item.id === onlyFirstTag.id),
    false,
  );

  const other = repo.createUser({
    email: "scoped-search-other@example.com",
    name: "Other",
    approvalStatus: "approved",
  });
  const foreignFolder = repo.createConversationFolder(other.id, "Foreign", "foreign-folder");
  assertThrows(
    () =>
      repo.searchConversations(owner.id, {
        query: "needle",
        view: "chat",
        folderId: foreignFolder.id,
      }),
    DomainError,
    "Invalid conversation search scope",
  );
});

Deno.test("memory user search uses authored content and rejects unsafe terms", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "authored-search@example.com",
    name: "Authored",
    approvalStatus: "approved",
  });
  const conversation = repo.createConversation(owner.id, "Projection");
  repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "visible authored phrase\n[tool context: hidden-secret]",
    metadata: { authoredContent: "visible authored phrase" },
    expectedVersion: 0,
    idempotencyKey: "authored-search-message",
  });
  assertEquals(
    repo.searchConversations(owner.id, {
      query: "hidden-secret",
      view: "chat",
    }).data,
    [],
  );
  const visible = repo.searchConversations(owner.id, {
    query: "authored phrase",
    view: "chat",
  }).data[0];
  assertEquals(visible.snippet, "visible authored phrase");
  assertThrows(
    () => repo.searchConversations(owner.id, { query: "bad\u0000term", view: "chat" }),
    DomainError,
  );
  assertThrows(
    () => repo.searchConversations(owner.id, { query: "\u001b", view: "chat" }),
    DomainError,
  );
  assertThrows(
    () => repo.searchConversations(owner.id, { query: " n ", view: "chat" }),
    DomainError,
    CONVERSATION_SEARCH_QUERY_VALIDATION_MESSAGE,
  );
  assertThrows(
    () =>
      repo.searchConversations(owner.id, {
        query: "authored phrase",
        view: "unknown" as "chat",
      }),
    DomainError,
    "Invalid conversation search",
  );
  assertThrows(
    () =>
      repo.searchConversations(owner.id, {
        query: "authored phrase",
        view: "chat",
        folderId: "",
      }),
    DomainError,
    "Invalid conversation search",
  );

  const refined = new AbortController();
  refined.abort();
  assertThrows(
    () =>
      repo.searchConversations(
        owner.id,
        { query: "authored phrase", view: "chat" },
        refined.signal,
      ),
    DOMException,
    "aborted",
  );
});

Deno.test("memory search bounds snippets from maximum-size messages", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "bounded-search@example.com",
    name: "Bounded search",
    approvalStatus: "approved",
  });
  const conversation = repo.createConversation(owner.id, "Large result");
  const needle = "maximum-body-final-needle";
  repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "assistant",
    content: `${"x".repeat(2_000_000 - needle.length)}${needle}`,
    expectedVersion: 0,
    idempotencyKey: "bounded-search-result",
  });
  const result = repo.searchConversations(owner.id, { query: needle, view: "chat" }).data[0];
  assertEquals(result.snippet.includes(needle), true);
  assertEquals(result.snippet.length <= 240, true);
});
