import { describe, expect, it } from "vitest";
import type { Conversation } from "./types.ts";
import {
  abortConversationSearchRequest,
  claimConversationSearchPage,
  conversationSearchAnnouncement,
  conversationSearchLifecycleDestination,
  conversationSearchReducer,
  conversationSearchTermState,
  initialConversationSearchState,
  insertConversationByRecency,
  invalidateConversationSearch,
  reconcileConversationSearchResult,
  subscribeConversationSearchInvalidation,
} from "./useConversationSearch.ts";

const result = (
  id: string,
  version = 1,
  updatedAt = "2026-01-02T00:00:00.000Z",
): Conversation => ({
  id,
  title: id,
  preview: "needle",
  updatedAt,
  version,
});

describe("conversation search state", () => {
  it("ignores stale initial and load-more completions after a new query reset", () => {
    const first = conversationSearchReducer(initialConversationSearchState, {
      type: "reset",
      key: 1,
      searching: true,
    });
    const loadingPage = conversationSearchReducer(
      conversationSearchReducer(first, {
        type: "initialSuccess",
        key: 1,
        data: [result("first")],
        cursor: "next",
      }),
      { type: "moreStart", key: 1 },
    );
    const newer = conversationSearchReducer(loadingPage, {
      type: "reset",
      key: 2,
      searching: true,
    });
    const staleInitial = conversationSearchReducer(newer, {
      type: "initialSuccess",
      key: 1,
      data: [result("stale-initial")],
      cursor: null,
    });
    const stalePage = conversationSearchReducer(staleInitial, {
      type: "moreSuccess",
      key: 1,
      data: [result("stale-page")],
      cursor: null,
    });
    expect(stalePage).toEqual(newer);
    expect(stalePage.loadingMore).toBe(false);
  });

  it("preserves prior results on incremental failure and deduplicates a retry", () => {
    let state = conversationSearchReducer(initialConversationSearchState, {
      type: "reset",
      key: 3,
      searching: true,
    });
    state = conversationSearchReducer(state, {
      type: "initialSuccess",
      key: 3,
      data: [result("one")],
      cursor: "next",
    });
    state = conversationSearchReducer(state, { type: "moreStart", key: 3 });
    state = conversationSearchReducer(state, { type: "moreError", key: 3 });
    expect(state.results.map((item) => item.id)).toEqual(["one"]);
    expect(state.pageError).toBe(true);
    state = conversationSearchReducer(state, { type: "moreStart", key: 3 });
    state = conversationSearchReducer(state, {
      type: "moreSuccess",
      key: 3,
      data: [result("one"), result("two")],
      cursor: null,
    });
    expect(state.results.map((item) => item.id)).toEqual(["one", "two"]);
    expect(state.pageError).toBe(false);
  });

  it("guards same-tick duplicate load-more requests", () => {
    const inFlight = { current: false };
    expect(claimConversationSearchPage(inFlight)).toBe(true);
    expect(claimConversationSearchPage(inFlight)).toBe(false);
  });

  it("aborts the current request during unmount cleanup", () => {
    const controller = new AbortController();
    abortConversationSearchRequest({ current: controller });
    expect(controller.signal.aborted).toBe(true);
  });

  it("inserts a server-only result at its canonical recency position", () => {
    const newest = result("newest", 1, "2026-01-03T00:00:00.000Z");
    const oldest = result("oldest", 1, "2026-01-01T00:00:00.000Z");
    const concurrent = {
      ...result("concurrent", 1, "2026-01-02T00:00:00.000Z"),
      title: "Created in another tab",
    };
    expect(reconcileConversationSearchResult([newest, oldest], [], concurrent)).toEqual({
      conversation: concurrent,
      destination: "chat",
      conversations: [newest, concurrent, oldest],
      deletedConversations: [],
    });
  });

  it("uses descending IDs as a deterministic tie-breaker without sorting existing rows", () => {
    const timestamp = "2026-01-02T00:00:00.000Z";
    const newerId = result("z-chat", 1, timestamp);
    const olderId = result("a-chat", 1, timestamp);
    const inserted = result("m-chat", 1, timestamp);

    expect(insertConversationByRecency([newerId, olderId], inserted)).toEqual([
      newerId,
      inserted,
      olderId,
    ]);
  });

  it("preserves a newer cached active leaf and version over a stale search result", () => {
    const stale = { ...result("chat", 4), activeLeafId: "stale-leaf" };
    const current = { ...result("chat", 5), activeLeafId: "current-leaf" };
    const other = result("other");

    expect(reconcileConversationSearchResult([other, current], [], stale)).toEqual({
      conversation: current,
      destination: "chat",
      conversations: [other, current],
      deletedConversations: [],
    });
  });

  it("accepts a strictly newer search snapshot and moves it to its current lifecycle cache", () => {
    const staleDeleted = { ...result("chat", 4), deleted: true };
    const currentLive = { ...result("chat", 5), activeLeafId: "current-leaf" };

    expect(reconcileConversationSearchResult([], [staleDeleted], currentLive)).toEqual({
      conversation: currentLive,
      destination: "chat",
      conversations: [currentLive],
      deletedConversations: [],
    });
  });

  it("keeps a newer deleted snapshot out of the live cache when a stale live result opens", () => {
    const staleLive = { ...result("chat", 6), deleted: false };
    const currentDeleted = { ...result("chat", 7), deleted: true };
    const regular = result("regular");
    const deleted = result("deleted");

    expect(
      reconcileConversationSearchResult([regular], [deleted, currentDeleted], staleLive),
    ).toEqual({
      conversation: currentDeleted,
      destination: "trash",
      conversations: [regular],
      deletedConversations: [deleted, currentDeleted],
    });
  });

  it("preserves an equal-version archived lifecycle snapshot from the canonical cache", () => {
    const current = { ...result("chat", 8), archived: true, title: "Archived title" };
    const staleSearch = { ...result("chat", 8), archived: false, title: "Search title" };

    expect(reconcileConversationSearchResult([current], [], staleSearch)).toEqual({
      conversation: current,
      destination: "archived",
      conversations: [current],
      deletedConversations: [],
    });
  });

  it("reinserts a newer opened search result when its activity timestamp changed", () => {
    const before = result("before", 1, "2026-01-03T00:00:00.000Z");
    const after = result("after", 1, "2026-01-02T00:00:00.000Z");
    const cached = {
      ...result("chat", 4, "2026-01-01T00:00:00.000Z"),
      title: "Cached",
    };
    const newerSearchResult = {
      ...result("chat", 5, "2026-01-04T00:00:00.000Z"),
      title: "Newer server title",
    };

    const reconciled = reconcileConversationSearchResult(
      [before, after, cached],
      [],
      newerSearchResult,
    );

    expect(reconciled.conversations).toEqual([newerSearchResult, before, after]);
    expect(reconciled.conversations[1]).toBe(before);
    expect(reconciled.conversations[2]).toBe(after);
  });

  it("preserves the lifecycle array itself when the canonical cached result already wins", () => {
    const before = result("before");
    const current = { ...result("chat", 5), title: "Current" };
    const after = result("after");
    const conversations = [before, current, after];

    const reconciled = reconcileConversationSearchResult(
      conversations,
      [],
      { ...result("chat", 4), title: "Stale" },
    );

    expect(reconciled.conversations).toBe(conversations);
    expect(reconciled.conversation).toBe(current);
  });

  it("collapses duplicate cached IDs at their first position without reordering neighbors", () => {
    const before = result("before");
    const current = { ...result("chat", 5), title: "Current" };
    const between = result("between");
    const duplicate = { ...result("chat", 4), title: "Duplicate" };
    const after = result("after");

    expect(
      reconcileConversationSearchResult(
        [before, current, between, duplicate, after],
        [],
        { ...result("chat", 3), title: "Search" },
      ).conversations,
    ).toEqual([before, current, between, after]);
  });

  it("derives the opening view from the reconciled canonical lifecycle", () => {
    expect(conversationSearchLifecycleDestination(result("live"))).toBe("chat");
    expect(conversationSearchLifecycleDestination({ ...result("archived"), archived: true }))
      .toBe("archived");
    expect(
      conversationSearchLifecycleDestination({
        ...result("deleted"),
        archived: true,
        deleted: true,
      }),
    ).toBe("trash");
  });

  it("announces loaded pages without implying a complete total", () => {
    expect(conversationSearchAnnouncement(1, false)).toBe("1 conversation loaded");
    expect(conversationSearchAnnouncement(25, true)).toBe(
      "25 conversations loaded; more results available",
    );
  });

  it("keeps one-character queries local instead of sending an expensive server search", () => {
    expect(conversationSearchTermState(" ")).toEqual({
      searching: false,
      tooShort: false,
      requestable: false,
    });
    const oneCharacter = conversationSearchTermState(" n ");
    expect(oneCharacter).toEqual({
      searching: true,
      tooShort: true,
      requestable: false,
    });
    expect(
      conversationSearchReducer(initialConversationSearchState, {
        type: "reset",
        key: 1,
        searching: oneCharacter.requestable,
      }).loading,
    ).toBe(false);
    expect(conversationSearchTermState(" no ")).toEqual({
      searching: true,
      tooShort: false,
      requestable: true,
    });
  });

  it("notifies active searches after a relevant conversation mutation", () => {
    let calls = 0;
    const unsubscribe = subscribeConversationSearchInvalidation(() => calls++);
    invalidateConversationSearch();
    unsubscribe();
    invalidateConversationSearch();
    expect(calls).toBe(1);
  });
});
