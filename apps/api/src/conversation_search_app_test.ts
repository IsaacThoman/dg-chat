import { assertEquals, assertExists, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  CONVERSATION_SEARCH_CURSOR_MAX_CHARS,
  type DomainRepository,
  MemoryRepository,
} from "@dg-chat/database";
import { createApp } from "./app.ts";
import { MemoryAudioConcurrencyLimiter } from "./audio-concurrency.ts";
import { sha256 } from "./crypto.ts";
import { MemoryRateLimiter, type RateLimiter, type RateLimitResult } from "./rate-limit.ts";

function cookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

function mutateCursorPosition(cursor: string, updatedAt: string, id: string): string {
  const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
  const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
  payload[1] = updatedAt;
  payload[2] = id;
  return btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function searchUser(
  repository: MemoryRepository,
  email: string,
): Promise<{ id: string; headers: Record<string, string> }> {
  const user = repository.createUser({
    email,
    name: "Search User",
    approvalStatus: "approved",
    emailVerified: true,
  });
  return { id: user.id, headers: await searchSession(repository, user.id) };
}

async function searchSession(
  repository: MemoryRepository,
  userId: string,
): Promise<Record<string, string>> {
  const token = `search-session-${crypto.randomUUID()}`;
  repository.createSession(userId, await sha256(token), false);
  return {
    cookie: `dg_session=${token}`,
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
}

function searchRequest(
  app: ReturnType<typeof createApp>["app"],
  headers: HeadersInit,
  signal?: AbortSignal,
) {
  return app.request("/api/conversations/search", {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({ query: "needle", view: "chat" }),
  });
}

Deno.test("conversation search route is distinct, private, validated, and owner scoped", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({ repository, setupToken: "conversation-search-setup" });
  const anonymous = await app.request("/api/conversations/search", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ query: "needle", view: "chat" }),
  });
  assertEquals(anonymous.status, 401);
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "conversation-search-setup" },
    body: JSON.stringify({
      email: "search-admin@example.com",
      password: "correct horse battery",
      name: "Search Admin",
    }),
  });
  const owner = (await bootstrap.json()).user;
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: "correct horse battery" }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const conversation = repository.createConversation(owner.id, "Search route");
  repository.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "<script>alert(1)</script> literal needle [tool hidden-secret]",
    metadata: { authoredContent: "<script>alert(1)</script>\u0007 literal needle" },
    expectedVersion: 0,
    idempotencyKey: "api-search-message",
  });
  const other = repository.createUser({
    email: "search-other@example.com",
    name: "Other",
    approvalStatus: "approved",
  });
  const otherConversation = repository.createConversation(other.id, "needle belongs elsewhere");
  const foreignFolder = repository.createConversationFolder(
    other.id,
    "Foreign scope",
    "api-search-foreign-folder",
  );
  const folder = repository.createConversationFolder(owner.id, "Search scope", "api-search-folder");
  const tag = repository.createConversationTag(
    owner.id,
    "Search tag",
    "#123456",
    "api-search-tag",
  );
  const now = new Date().toISOString();
  repository.conversationFolderMemberships.set(conversation.id, {
    folderId: folder.id,
    conversationId: conversation.id,
    ownerId: owner.id,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  repository.conversationTagSets.set(conversation.id, {
    conversationId: conversation.id,
    ownerId: owner.id,
    version: 1,
    updatedAt: now,
  });
  repository.conversationTagBindings.set(`${conversation.id}:${tag.id}`, {
    conversationId: conversation.id,
    tagId: tag.id,
    ownerId: owner.id,
    createdAt: now,
  });

  const response = await app.request("/api/conversations/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: "needle",
      view: "chat",
      folderId: folder.id,
      tagIds: [tag.id],
      limit: 10,
    }),
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("pragma"), "no-cache");
  const page = await response.json();
  assertEquals(page.data.length, 1);
  assertEquals(page.data[0].id, conversation.id);
  assertEquals(page.data[0].snippet.includes("<script>alert(1)</script>"), true);
  assertEquals(page.data[0].snippet.includes("\u0007"), false);

  const hidden = await app.request("/api/conversations/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "hidden-secret", view: "chat" }),
  });
  assertEquals((await hidden.json()).data, []);
  const foreignScope = await app.request("/api/conversations/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "needle", view: "chat", folderId: foreignFolder.id }),
  });
  assertEquals(foreignScope.status, 422);

  const list = await app.request("/api/conversations", { headers });
  assertEquals(
    (await list.json()).data.some((item: { id: string }) => item.id === conversation.id),
    true,
  );
  assertEquals(
    (await repository.searchConversations(other.id, {
      query: "needle",
      view: "chat",
    })).data[0].id,
    otherConversation.id,
  );

  const invalid = await app.request("/api/conversations/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "x".repeat(201), view: "chat" }),
  });
  assertEquals(invalid.status, 422);
  for (const unsafeQuery of ["bad\u0000term", "\u001b"]) {
    const unsafe = await app.request("/api/conversations/search", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: unsafeQuery, view: "chat" }),
    });
    assertEquals(unsafe.status, 422);
  }
  repository.createConversation(owner.id, "needle second cursor result");
  const cursorPage = await repository.searchConversations(owner.id, {
    query: "needle",
    view: "chat",
    limit: 1,
  });
  const cursor = cursorPage.nextCursor!;
  const invalidCursors = [
    mutateCursorPosition(
      cursor,
      cursorPage.data[0].updatedAt,
      "00000000-0000-4000-8000-000000000001",
    ),
    mutateCursorPosition(cursor, "2020-01-01T00:00:00.000Z", cursorPage.data[0].id),
    cursor + "=",
    "a".repeat(CONVERSATION_SEARCH_CURSOR_MAX_CHARS + 1),
  ];
  for (const invalidCursor of invalidCursors) {
    const invalidCursorResponse = await app.request("/api/conversations/search", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "needle", view: "chat", limit: 1, cursor: invalidCursor }),
    });
    assertEquals(invalidCursorResponse.status, 422);
  }
  repository.conversations.get(cursorPage.data[0].id)!.updatedAt = "2030-01-01T00:00:00.000Z";
  const staleCursor = await app.request("/api/conversations/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "needle", view: "chat", limit: 1, cursor }),
  });
  assertEquals(staleCursor.status, 422);
  assertEquals((await staleCursor.json()).error.message, "Invalid conversation search cursor");
  assertEquals(
    app.routes.filter((route) =>
      route.method === "POST" && route.path === "/api/conversations/search"
    ).length,
    1,
  );
});

Deno.test("conversation search disconnect aborts storage and holds admission until cleanup", async () => {
  const repository = new MemoryRepository();
  const owner = await searchUser(repository, "search-disconnect@example.test");
  const limiter = new MemoryAudioConcurrencyLimiter({ leaseMs: 10_000 });
  const originalSearch = repository.searchConversations.bind(repository);
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const storageStopped = Promise.withResolvers<void>();
  let blockFirst = true;
  let observedSignal: AbortSignal | undefined;
  const delayedRepository: DomainRepository = new Proxy(repository, {
    get(target, property) {
      if (property === "searchConversations") {
        return async (...args: Parameters<DomainRepository["searchConversations"]>) => {
          if (!blockFirst) return await originalSearch(...args);
          blockFirst = false;
          observedSignal = args[2];
          entered.resolve();
          args[2]?.addEventListener("abort", () => cancelled.resolve(), { once: true });
          await cancelled.promise;
          // Model PostgreSQL acknowledging query cancellation and rolling its transaction back.
          await storageStopped.promise;
          args[2]?.throwIfAborted();
          throw new Error("unreachable");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { app } = createApp({
    repository: delayedRepository,
    conversationSearchConcurrencyLimiter: limiter,
    conversationSearchMaxConcurrent: 1,
    conversationSearchMaxConcurrentPerUser: 1,
  });

  const controller = new AbortController();
  const pending = searchRequest(app, owner.headers, controller.signal);
  await entered.promise;
  assertEquals(observedSignal?.aborted, false);
  controller.abort();
  await cancelled.promise;

  // A refined request cannot overtake storage cancellation using the same owner's slot.
  const refinedWhileStopping = await searchRequest(app, owner.headers);
  assertEquals(refinedWhileStopping.status, 429);
  assertEquals(
    (await refinedWhileStopping.json()).error.code,
    "conversation_search_capacity_exceeded",
  );

  storageStopped.resolve();
  assertEquals((await pending).status, 499);
  assertEquals((await searchRequest(app, owner.headers)).status, 200);
  await limiter.close();
});

Deno.test("conversation search rate limits are isolated per authenticated user", async () => {
  const repository = new MemoryRepository();
  const first = await searchUser(repository, "search-rate-first@example.test");
  const second = await searchUser(repository, "search-rate-second@example.test");
  const { app } = createApp({
    repository,
    rateLimiter: new MemoryRateLimiter(),
    conversationSearchRateLimit: 1,
  });

  const firstAllowed = await searchRequest(app, first.headers);
  assertEquals(firstAllowed.status, 200);
  assertEquals(firstAllowed.headers.get("x-ratelimit-limit"), "1");
  assertEquals(firstAllowed.headers.get("x-ratelimit-remaining"), "0");

  // A second browser session for the same account shares the owner bucket.
  const sameOwnerDenied = await searchRequest(
    app,
    await searchSession(repository, first.id),
  );
  assertEquals(sameOwnerDenied.status, 429);
  assertEquals(sameOwnerDenied.headers.get("x-ratelimit-limit"), "1");
  assertEquals(sameOwnerDenied.headers.get("x-ratelimit-remaining"), "0");
  assertExists(sameOwnerDenied.headers.get("retry-after"));

  // A busy account must not consume another authenticated user's distributed bucket.
  const secondAllowed = await searchRequest(app, second.headers);
  assertEquals(secondAllowed.status, 200);
  assertEquals(secondAllowed.headers.get("x-ratelimit-limit"), "1");

  const denied = await searchRequest(app, first.headers);
  assertEquals(denied.status, 429);
  assertEquals(denied.headers.get("x-ratelimit-limit"), "1");
  assertEquals(denied.headers.get("x-ratelimit-remaining"), "0");
  assertExists(denied.headers.get("retry-after"));
  assertEquals((await denied.json()).error, {
    code: "rate_limit_exceeded",
    message: "Too many requests",
  });
});

class UnavailableRateLimiter implements RateLimiter {
  consume(): Promise<RateLimitResult> {
    return Promise.reject(new Error("redis unavailable"));
  }

  health(): Promise<boolean> {
    return Promise.resolve(false);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("conversation search fails closed when distributed rate limiting is unavailable", async () => {
  const repository = new MemoryRepository();
  const owner = await searchUser(repository, "search-rate-unavailable@example.test");
  const { app } = createApp({ repository, rateLimiter: new UnavailableRateLimiter() });

  const response = await searchRequest(app, owner.headers);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "5");
  assertEquals((await response.json()).error, {
    code: "service_unavailable",
    message: "Conversation search is temporarily unavailable",
  });
});

Deno.test("conversation search admission preserves capacity and releases exact owner slots", async () => {
  const repository = new MemoryRepository();
  const first = await searchUser(repository, "search-capacity-first@example.test");
  const second = await searchUser(repository, "search-capacity-second@example.test");
  const third = await searchUser(repository, "search-capacity-third@example.test");
  const limiter = new MemoryAudioConcurrencyLimiter({ leaseMs: 10_000 });
  const originalSearch = repository.searchConversations.bind(repository);
  const gate = Promise.withResolvers<void>();
  let block = true;
  let active = 0;
  let maximumActive = 0;
  const delayedRepository: DomainRepository = new Proxy(repository, {
    get(target, property) {
      if (property === "searchConversations") {
        return async (...args: Parameters<DomainRepository["searchConversations"]>) => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          try {
            if (block) await gate.promise;
            return await originalSearch(args[0], args[1]);
          } finally {
            active--;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { app } = createApp({
    repository: delayedRepository,
    conversationSearchConcurrencyLimiter: limiter,
    conversationSearchMaxConcurrent: 2,
    conversationSearchMaxConcurrentPerUser: 1,
  });

  const firstPending = searchRequest(app, first.headers);
  const secondPending = searchRequest(app, second.headers);
  for (let attempt = 0; attempt < 100 && active !== 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(active, 2);

  const sameOwnerDenied = await searchRequest(app, first.headers);
  assertEquals(sameOwnerDenied.status, 429);
  assertEquals(sameOwnerDenied.headers.get("retry-after"), "1");
  assertEquals((await sameOwnerDenied.json()).error, {
    code: "conversation_search_capacity_exceeded",
    message: "Too many conversation searches are in progress",
  });
  const globalDenied = await searchRequest(app, third.headers);
  assertEquals(globalDenied.status, 429);

  // Search saturation must leave ordinary repository traffic serviceable.
  const ordinary = await app.request("/api/conversations", { headers: third.headers });
  assertEquals(ordinary.status, 200);

  block = false;
  gate.resolve();
  assertEquals((await firstPending).status, 200);
  assertEquals((await secondPending).status, 200);
  assertEquals(maximumActive, 2);
  assertEquals((await searchRequest(app, third.headers)).status, 200);
  await limiter.close();
});

Deno.test("conversation search fails closed when distributed admission is unavailable", async () => {
  const repository = new MemoryRepository();
  const owner = await searchUser(repository, "search-capacity-unavailable@example.test");
  const { app } = createApp({
    repository,
    conversationSearchConcurrencyLimiter: {
      acquire: () => Promise.reject(new Error("redis unavailable")),
      close: () => Promise.resolve(),
    },
  });
  const response = await searchRequest(app, owner.headers);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "5");
  assertEquals((await response.json()).error, {
    code: "service_unavailable",
    message: "Conversation search is temporarily unavailable",
  });
});

Deno.test("conversation search rate limit configuration must be positive", () => {
  assertThrows(
    () => createApp({ conversationSearchRateLimit: 0 }),
    Error,
    "CONVERSATION_SEARCH_RATE_LIMIT must be a positive safe integer",
  );
  assertThrows(
    () =>
      createApp({
        conversationSearchMaxConcurrent: 1,
        conversationSearchMaxConcurrentPerUser: 2,
      }),
    Error,
    "Conversation search concurrency limits must be positive",
  );
});
