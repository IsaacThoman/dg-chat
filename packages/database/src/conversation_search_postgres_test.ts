import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import {
  CONVERSATION_SEARCH_APPLICATION_NAME,
  CONVERSATION_SEARCH_POOL_MAX,
  CONVERSATION_SEARCH_QUERY_VALIDATION_MESSAGE,
  decodeConversationSearchCursor,
} from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "PostgreSQL conversation search cancellation stops database work before returning",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const control = postgres(databaseUrl!, { max: 2 });
    const owner = await repo.createUser({
      email: `cancelled-search-${crypto.randomUUID()}@example.test`,
      name: "Cancelled search",
      approvalStatus: "approved",
    });
    await repo.createConversation(owner.id, "cancellation needle");
    const lockAcquired = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const lock = control.begin(async (tx) => {
      await tx`LOCK TABLE conversations IN ACCESS EXCLUSIVE MODE`;
      lockAcquired.resolve();
      await releaseLock.promise;
    }).catch((error) => {
      lockAcquired.reject(error);
      throw error;
    });
    try {
      await lockAcquired.promise;
      const controller = new AbortController();
      const pending = repo.searchConversations(
        owner.id,
        { query: "cancellation needle", view: "chat" },
        controller.signal,
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await control<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'
            AND query LIKE '%WITH RECURSIVE eligible_base AS%'
            AND wait_event_type='Lock'`;
        if (Number(waiting[0]?.count) > 0) break;
        if (attempt === 99) throw new Error("Search never reached the PostgreSQL lock wait");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      controller.abort();
      await assertRejects(
        () =>
          Promise.race([
            pending,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Cancellation did not stop PostgreSQL work")),
                2_000,
              )
            ),
          ]),
        DOMException,
        "aborted",
      );
      const active = await control<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'
          AND query LIKE '%WITH RECURSIVE eligible_base AS%'`;
      assertEquals(Number(active[0]?.count), 0);
    } finally {
      releaseLock.resolve();
      await lock;
      await control`DELETE FROM users WHERE id=${owner.id}`;
      await control.end();
      await repo.close();
    }
  },
});

Deno.test({
  name: "PostgreSQL conversation search aborts queued work when its dedicated pool is saturated",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const control = postgres(databaseUrl!, { max: 2 });
    const owner = await repo.createUser({
      email: `saturated-search-${crypto.randomUUID()}@example.test`,
      name: "Saturated search",
      approvalStatus: "approved",
    });
    await repo.createConversation(owner.id, "saturated pool needle");
    const lockAcquired = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const lock = control.begin(async (tx) => {
      await tx`LOCK TABLE conversations IN ACCESS EXCLUSIVE MODE`;
      lockAcquired.resolve();
      await releaseLock.promise;
    }).catch((error) => {
      lockAcquired.reject(error);
      throw error;
    });
    const activeControllers = Array.from(
      { length: CONVERSATION_SEARCH_POOL_MAX },
      () => new AbortController(),
    );
    const activeSearches: Promise<unknown>[] = [];
    try {
      await lockAcquired.promise;
      for (const controller of activeControllers) {
        activeSearches.push(repo.searchConversations(
          owner.id,
          { query: "saturated pool needle", view: "chat" },
          controller.signal,
        ));
      }

      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await control<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND application_name=${CONVERSATION_SEARCH_APPLICATION_NAME}
            AND state='active' AND wait_event_type='Lock'
            AND query LIKE '/* dg-chat:conversation-search:results */%'`;
        if (Number(waiting[0]?.count) === CONVERSATION_SEARCH_POOL_MAX) break;
        if (attempt === 199) throw new Error("Dedicated search pool never became saturated");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const queuedController = new AbortController();
      const queuedSearch = repo.searchConversations(
        owner.id,
        { query: "saturated pool needle", view: "chat" },
        queuedController.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      queuedController.abort();
      await assertRejects(
        () =>
          Promise.race([
            queuedSearch,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Queued search ignored caller cancellation")),
                2_000,
              )
            ),
          ]),
        DOMException,
        "aborted",
      );

      // Free one connection while the table remains locked. A canceled queue entry must not start
      // after that slot opens; otherwise the waiting count would return to the pool maximum.
      activeControllers[0].abort();
      await assertRejects(
        () => activeSearches[0],
        DOMException,
        "aborted",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const remaining = await control<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND application_name=${CONVERSATION_SEARCH_APPLICATION_NAME}
          AND state='active' AND wait_event_type='Lock'
          AND query LIKE '/* dg-chat:conversation-search:results */%'`;
      assertEquals(Number(remaining[0]?.count), CONVERSATION_SEARCH_POOL_MAX - 1);

      releaseLock.resolve();
      await lock;
      await Promise.all(activeSearches.slice(1));
    } finally {
      for (const controller of activeControllers) controller.abort();
      releaseLock.resolve();
      await Promise.allSettled(activeSearches);
      await lock.catch(() => undefined);
      await control`DELETE FROM users WHERE id=${owner.id}`;
      await control.end();
      await repo.close();
    }
  },
});

Deno.test({
  name: "PostgreSQL conversation search enforces its database and wall-clock deadline",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const control = postgres(databaseUrl!, { max: 2 });
    const owner = await repo.createUser({
      email: `search-deadline-${crypto.randomUUID()}@example.test`,
      name: "Search deadline",
      approvalStatus: "approved",
    });
    await repo.createConversation(owner.id, "deadline needle");
    const lockAcquired = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const lock = control.begin(async (tx) => {
      await tx`LOCK TABLE conversations IN ACCESS EXCLUSIVE MODE`;
      lockAcquired.resolve();
      await releaseLock.promise;
    }).catch((error) => {
      lockAcquired.reject(error);
      throw error;
    });
    try {
      await lockAcquired.promise;
      const pending = repo.searchConversations(owner.id, {
        query: "deadline needle",
        view: "chat",
      });
      await assertRejects(
        async () => {
          let safetyTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                safetyTimer = setTimeout(
                  () => reject(new Error("Search exceeded both deadline safeguards")),
                  7_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(safetyTimer);
          }
        },
        DomainError,
        "Conversation search took too long",
      );
      const active = await control<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND application_name=${CONVERSATION_SEARCH_APPLICATION_NAME}
          AND state='active' AND query LIKE '/* dg-chat:conversation-search:results */%'`;
      assertEquals(Number(active[0]?.count), 0);
    } finally {
      releaseLock.resolve();
      await lock.catch(() => undefined);
      await control`DELETE FROM users WHERE id=${owner.id}`;
      await control.end();
      await repo.close();
    }
  },
});

Deno.test({
  name: "PostgreSQL conversation search preserves microseconds across a cursor page boundary",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 1 });
    const suffix = crypto.randomUUID();
    const owner = await repo.createUser({
      email: `search-cursor-precision-${suffix}@example.com`,
      name: "Cursor precision",
    });
    const query = {
      query: `driver-microsecond-boundary-${suffix}`,
      view: "chat" as const,
      limit: 1,
    };
    try {
      const conversations = await Promise.all([
        repo.createConversation(owner.id, `${query.query} newest`),
        repo.createConversation(owner.id, `${query.query} middle`),
        repo.createConversation(owner.id, `${query.query} oldest`),
      ]);
      const timestamps = [
        "2026-01-01T00:00:00.000900Z",
        "2026-01-01T00:00:00.000500Z",
        "2026-01-01T00:00:00.000100Z",
      ];
      for (let index = 0; index < conversations.length; index++) {
        await sql`UPDATE conversations SET updated_at=${timestamps[index]}::text::timestamptz
          WHERE id=${conversations[index].id}`;
      }

      const first = await repo.searchConversations(owner.id, query);
      assertEquals(first.data.map((conversation) => conversation.id), [conversations[0].id]);
      assertEquals(
        decodeConversationSearchCursor(first.nextCursor!, query, owner.id),
        { updatedAt: timestamps[0], id: conversations[0].id },
      );

      const second = await repo.searchConversations(owner.id, {
        ...query,
        cursor: first.nextCursor!,
      });
      assertEquals(second.data.map((conversation) => conversation.id), [conversations[1].id]);
      assertEquals(
        decodeConversationSearchCursor(second.nextCursor!, query, owner.id),
        { updatedAt: timestamps[1], id: conversations[1].id },
      );

      const third = await repo.searchConversations(owner.id, {
        ...query,
        cursor: second.nextCursor!,
      });
      assertEquals(third.data.map((conversation) => conversation.id), [conversations[2].id]);
      assertEquals(third.nextCursor, null);
    } finally {
      await sql`DELETE FROM conversations WHERE owner_id=${owner.id}`;
      await sql`DELETE FROM users WHERE id=${owner.id}`;
      await sql.end();
      await repo.close();
    }
  },
});

Deno.test({
  name: "PostgreSQL conversation search is literal, branch-scoped, owner-scoped, and cursor-bound",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 1 });
    const suffix = crypto.randomUUID();
    const owner = await repo.createUser({ email: `search-${suffix}@example.com`, name: "Owner" });
    const other = await repo.createUser({
      email: `search-other-${suffix}@example.com`,
      name: "Other",
    });
    try {
      await assertRejects(
        () => repo.searchConversations(owner.id, { query: " n ", view: "chat" }),
        DomainError,
        CONVERSATION_SEARCH_QUERY_VALIDATION_MESSAGE,
      );
      for (let index = 0; index < 2; index++) {
        const conversation = await repo.createConversation(owner.id, `Result ${index}`);
        const inactive = await repo.appendMessage({
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: null,
          role: "user",
          content: "inactive branch secret",
          expectedVersion: 0,
          idempotencyKey: `pg-search-inactive-${index}`,
        });
        await repo.appendMessage({
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: null,
          supersedesId: inactive.id,
          role: "assistant",
          content: "<svg onload=alert(1)> literal 100%_Needle\u001b",
          expectedVersion: 1,
          idempotencyKey: `pg-search-active-${index}`,
        });
      }
      const authored = await repo.createConversation(owner.id, "Authored projection");
      await repo.appendMessage({
        conversationId: authored.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "visible authored pg [tool hidden-pg-secret]",
        metadata: { authoredContent: "visible authored pg" },
        expectedVersion: 0,
        idempotencyKey: "pg-authored-search",
      });
      assertEquals(
        (await repo.searchConversations(owner.id, {
          query: "hidden-pg-secret",
          view: "chat",
        })).data,
        [],
      );
      assertEquals(
        (await repo.searchConversations(owner.id, {
          query: "authored pg",
          view: "chat",
        })).data[0].snippet,
        "visible authored pg",
      );

      const cyclic = await repo.createConversation(owner.id, "Cycle-safe search");
      const cycleRoot = await repo.appendMessage({
        conversationId: cyclic.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "cycle-safe needle root",
        expectedVersion: 0,
        idempotencyKey: "pg-search-cycle-root",
      });
      const cycleLeaf = await repo.appendMessage({
        conversationId: cyclic.id,
        ownerId: owner.id,
        parentId: cycleRoot.id,
        role: "assistant",
        content: "cycle-safe needle leaf",
        expectedVersion: 1,
        idempotencyKey: "pg-search-cycle-leaf",
      });
      // Model a damaged/imported graph. The repository never creates this shape, but a read path
      // must still terminate rather than consume a database connection indefinitely.
      await sql`UPDATE messages SET parent_id=${cycleLeaf.id} WHERE id=${cycleRoot.id}`;
      assertEquals(
        (await repo.searchConversations(owner.id, {
          query: "cycle-safe needle",
          view: "chat",
        })).data.some((conversation) => conversation.id === cyclic.id),
        true,
      );

      const scoped = await repo.createConversation(owner.id, "scope-needle inside");
      await sql`UPDATE conversations SET updated_at='2000-01-01T00:00:00.000Z'::timestamptz
        WHERE id=${scoped.id}`;
      for (let index = 0; index < 30; index++) {
        await repo.createConversation(owner.id, `scope-needle outside ${index}`);
      }
      assertEquals(
        (await repo.searchConversations(owner.id, {
          query: "scope-needle",
          view: "chat",
          limit: 25,
        })).data.some((conversation) => conversation.id === scoped.id),
        false,
      );
      const folderId = crypto.randomUUID();
      const tagId = crypto.randomUUID();
      await sql`INSERT INTO conversation_folders(
        id,owner_id,name,normalized_name,position
      ) VALUES(${folderId},${owner.id},'Search Scope','search scope',0)`;
      await sql`INSERT INTO conversation_tags(
        id,owner_id,name,normalized_name,color
      ) VALUES(${tagId},${owner.id},'Search Tag','search tag','#123456')`;
      await sql`INSERT INTO conversation_folder_memberships(
        folder_id,conversation_id,owner_id,position
      ) VALUES(${folderId},${scoped.id},${owner.id},0)`;
      await sql`INSERT INTO conversation_tag_sets(conversation_id,owner_id,version)
        VALUES(${scoped.id},${owner.id},1)`;
      await sql`INSERT INTO conversation_tag_bindings(conversation_id,tag_id,owner_id)
        VALUES(${scoped.id},${tagId},${owner.id})`;
      const scopedPage = await repo.searchConversations(owner.id, {
        query: "scope-needle",
        view: "chat",
        folderId,
        tagIds: [tagId],
        limit: 1,
      });
      assertEquals(scopedPage.data.map((item) => item.id), [scoped.id]);
      assertEquals(scopedPage.nextCursor, null);
      const foreignFolderId = crypto.randomUUID();
      await sql`INSERT INTO conversation_folders(
        id,owner_id,name,normalized_name,position
      ) VALUES(${foreignFolderId},${other.id},'Foreign Scope','foreign scope',0)`;
      await assertRejects(
        () =>
          repo.searchConversations(owner.id, {
            query: "scope-needle",
            view: "chat",
            folderId: foreignFolderId,
          }),
        DomainError,
        "Invalid conversation search scope",
      );
      await repo.createConversation(other.id, "100%_needle foreign");
      assertEquals(
        (await repo.searchConversations(owner.id, {
          query: "branch secret",
          view: "chat",
        })).data,
        [],
      );
      const first = await repo.searchConversations(owner.id, {
        query: "%_needle",
        view: "chat",
        limit: 1,
      });
      assertEquals(first.data.length, 1);
      assertEquals(first.data[0].snippet.includes("\u001b"), false);
      assertEquals(first.data[0].snippet.includes("<svg onload=alert(1)>"), true);
      assertEquals(
        (await repo.searchConversations(other.id, {
          query: "%_needle",
          view: "chat",
        })).data.length,
        1,
      );
      await assertRejects(
        () =>
          repo.searchConversations(owner.id, {
            query: "different",
            view: "chat",
            cursor: first.nextCursor!,
          }),
        DomainError,
        "Invalid conversation search cursor",
      );
      assertEquals(
        (await repo.searchConversations(owner.id, {
          query: "%_needle",
          view: "chat",
          limit: 1,
          cursor: first.nextCursor!,
        })).data.length,
        1,
      );

      const precisionConversations = await Promise.all(
        Array.from(
          { length: 4 },
          (_, index) => repo.createConversation(owner.id, `precision-cursor-needle ${index}`),
        ),
      );
      const precisionTimestamps = [
        "2026-01-01T00:00:00.000900Z",
        "2026-01-01T00:00:00.000500Z",
        "2026-01-01T00:00:00.000100Z",
        "2026-01-01T00:00:00.000100Z",
      ];
      for (let index = 0; index < precisionConversations.length; index++) {
        // Cast through text so the fixture retains PostgreSQL microsecond precision instead of
        // being coerced through postgres.js' millisecond-precision Date serializer.
        await sql`UPDATE conversations SET updated_at=${
          precisionTimestamps[index]
        }::text::timestamptz
          WHERE id=${precisionConversations[index].id}`;
      }
      const expectedPrecisionRows = await sql<{ id: string }[]>`
        SELECT id FROM conversations
        WHERE id=ANY(${
        sql.array(precisionConversations.map((conversation) => conversation.id))
      }::uuid[])
        ORDER BY updated_at DESC,id DESC`;
      const pagedIds: string[] = [];
      let precisionCursor: string | undefined;
      for (let index = 0; index < precisionConversations.length; index++) {
        const page = await repo.searchConversations(owner.id, {
          query: "precision-cursor-needle",
          view: "chat",
          limit: 1,
          cursor: precisionCursor,
        });
        assertEquals(page.data.length, 1);
        pagedIds.push(page.data[0].id);
        precisionCursor = page.nextCursor ?? undefined;
      }
      assertEquals(precisionCursor, undefined);
      assertEquals(pagedIds.length, precisionConversations.length);
      assertEquals(new Set(pagedIds).size, precisionConversations.length);
      assertEquals(
        pagedIds,
        expectedPrecisionRows.map((row) => row.id),
      );

      const largeConversation = await repo.createConversation(owner.id, "Large search result");
      const largeNeedle = "postgres-maximum-body-final-needle";
      await repo.appendMessage({
        conversationId: largeConversation.id,
        ownerId: owner.id,
        parentId: null,
        role: "assistant",
        content: `${"x".repeat(2_000_000 - largeNeedle.length)}${largeNeedle}`,
        expectedVersion: 0,
        idempotencyKey: "postgres-bounded-search-result",
      });
      const largeResult = (await repo.searchConversations(owner.id, {
        query: largeNeedle,
        view: "chat",
      })).data[0];
      assertEquals(largeResult.id, largeConversation.id);
      assertEquals(largeResult.snippet.includes(largeNeedle), true);
      assertEquals(largeResult.snippet.length <= 240, true);
    } finally {
      await sql`DELETE FROM conversations WHERE owner_id IN (${owner.id},${other.id})`;
      await sql`DELETE FROM users WHERE id IN (${owner.id},${other.id})`;
      await sql.end();
      await repo.close();
    }
  },
});
