import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api } from "./api.ts";
import type { ConversationListView } from "./conversationLifecycle.ts";
import type { Conversation } from "./types.ts";

const invalidationListeners = new Set<() => void>();

export function invalidateConversationSearch(): void {
  for (const listener of invalidationListeners) listener();
}

export function subscribeConversationSearchInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

export interface ReconciledConversationSearchResult {
  conversation: Conversation;
  destination: ConversationListView;
  conversations: Conversation[];
  deletedConversations: Conversation[];
}

function conversationVersion(conversation: Conversation): number {
  return conversation.version ?? 0;
}

/**
 * Canonical lifecycle ordering used by the conversation list API: newest activity first, with a
 * descending ID tie-breaker so equal timestamps have a stable order across caches and tabs.
 */
export function compareConversationRecency(a: Conversation, b: Conversation): number {
  const aTimestamp = Date.parse(a.updatedAt);
  const bTimestamp = Date.parse(b.updatedAt);
  const updatedAt = Number.isFinite(aTimestamp) && Number.isFinite(bTimestamp)
    ? bTimestamp - aTimestamp
    : b.updatedAt.localeCompare(a.updatedAt);
  return updatedAt || b.id.localeCompare(a.id);
}

export function insertConversationByRecency(
  conversations: Conversation[],
  conversation: Conversation,
): Conversation[] {
  const index = conversations.findIndex((item) =>
    compareConversationRecency(conversation, item) < 0
  );
  return index < 0
    ? [...conversations, conversation]
    : [...conversations.slice(0, index), conversation, ...conversations.slice(index)];
}

export function conversationSearchLifecycleDestination(
  conversation: Conversation,
): ConversationListView {
  if (conversation.deleted) return "trash";
  return conversation.archived ? "archived" : "chat";
}

/**
 * Reconciles a potentially stale search snapshot with both lifecycle caches.
 *
 * Search pages are intentionally not a second source of canonical conversation state: a
 * lifecycle mutation or active-leaf change can land in the query cache after the search page was
 * fetched. Existing cache state therefore wins ties, and the search snapshot is accepted only
 * when its version is strictly newer than every cached copy.
 */
export function reconcileConversationSearchResult(
  conversations: Conversation[] | undefined,
  deletedConversations: Conversation[] | undefined,
  result: Conversation,
): ReconciledConversationSearchResult {
  const regular = conversations ?? [];
  const deleted = deletedConversations ?? [];
  const cached = [...regular, ...deleted]
    .filter((conversation) => conversation.id === result.id)
    .reduce<Conversation | undefined>(
      (newest, conversation) =>
        !newest || conversationVersion(conversation) > conversationVersion(newest) ||
          conversationVersion(conversation) === conversationVersion(newest) &&
            Boolean(conversation.deleted) && !newest.deleted
          ? conversation
          : newest,
      undefined,
    );
  const searchSnapshotWins = !cached ||
    conversationVersion(result) > conversationVersion(cached);
  const conversation = searchSnapshotWins ? result : cached;
  const reconcileLifecycle = (items: Conversation[], belongsHere: boolean): Conversation[] => {
    const existingIndex = items.findIndex((item) => item.id === result.id);
    if (!belongsHere) {
      return existingIndex < 0 ? items : items.filter((item) => item.id !== result.id);
    }
    if (searchSnapshotWins) {
      return insertConversationByRecency(
        existingIndex < 0 ? items : items.filter((item) => item.id !== result.id),
        conversation,
      );
    }
    if (existingIndex < 0) return insertConversationByRecency(items, conversation);
    const duplicate = items.findIndex((item, index) =>
      index !== existingIndex && item.id === result.id
    );
    if (items[existingIndex] === conversation && duplicate < 0) return items;
    return items.flatMap((item, index) => {
      if (item.id !== result.id) return [item];
      return index === existingIndex ? [conversation] : [];
    });
  };

  return {
    conversation,
    destination: conversationSearchLifecycleDestination(conversation),
    conversations: reconcileLifecycle(regular, !conversation.deleted),
    deletedConversations: reconcileLifecycle(deleted, Boolean(conversation.deleted)),
  };
}

export function conversationSearchAnnouncement(count: number, hasMore: boolean): string {
  const loaded = `${count} conversation${count === 1 ? "" : "s"} loaded`;
  return hasMore ? `${loaded}; more results available` : loaded;
}

export const CONVERSATION_SEARCH_MIN_CHARACTERS = 2;

export function conversationSearchTermState(query: string): {
  searching: boolean;
  tooShort: boolean;
  requestable: boolean;
} {
  const length = query.trim().length;
  return {
    searching: length > 0,
    tooShort: length > 0 && length < CONVERSATION_SEARCH_MIN_CHARACTERS,
    requestable: length >= CONVERSATION_SEARCH_MIN_CHARACTERS,
  };
}

export interface ConversationSearchState {
  key: number;
  results: Conversation[];
  cursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  pageError: boolean;
}

export type ConversationSearchAction =
  | { type: "reset"; key: number; searching: boolean }
  | { type: "initialSuccess"; key: number; data: Conversation[]; cursor: string | null }
  | { type: "initialError"; key: number }
  | { type: "moreStart"; key: number }
  | { type: "moreSuccess"; key: number; data: Conversation[]; cursor: string | null }
  | { type: "moreError"; key: number };

export const initialConversationSearchState: ConversationSearchState = {
  key: 0,
  results: [],
  cursor: null,
  loading: false,
  loadingMore: false,
  error: false,
  pageError: false,
};

export function claimConversationSearchPage(inFlight: { current: boolean }): boolean {
  if (inFlight.current) return false;
  inFlight.current = true;
  return true;
}

export function abortConversationSearchRequest(
  request: { current: AbortController | null },
): void {
  request.current?.abort();
}

export function conversationSearchReducer(
  state: ConversationSearchState,
  action: ConversationSearchAction,
): ConversationSearchState {
  if (action.type === "reset") {
    return { ...initialConversationSearchState, key: action.key, loading: action.searching };
  }
  if (action.key !== state.key) return state;
  switch (action.type) {
    case "initialSuccess":
      return { ...state, results: action.data, cursor: action.cursor, loading: false };
    case "initialError":
      return { ...state, results: [], cursor: null, loading: false, error: true };
    case "moreStart":
      return { ...state, loadingMore: true, pageError: false };
    case "moreSuccess":
      return {
        ...state,
        results: [
          ...state.results,
          ...action.data.filter((item) =>
            !state.results.some((existing) => existing.id === item.id)
          ),
        ],
        cursor: action.cursor,
        loadingMore: false,
        pageError: false,
      };
    case "moreError":
      return { ...state, loadingMore: false, pageError: true };
  }
}

const aborted = (error: unknown) =>
  Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");

export function useConversationSearch(
  query: string,
  view: ConversationListView,
  folderId?: string,
  tagIds: string[] = [],
  demoScopeIds: string[] = [],
) {
  const term = query.trim();
  const { searching, tooShort, requestable } = conversationSearchTermState(term);
  const [retry, setRetry] = useState(0);
  const [state, dispatch] = useReducer(conversationSearchReducer, initialConversationSearchState);
  const tagKey = [...tagIds].sort().join(",");
  const normalizedTagIds = useMemo(() => tagKey ? tagKey.split(",") : [], [tagKey]);
  const demoScopeKey = [...demoScopeIds].sort().join(",");
  const normalizedDemoScopeIds = useMemo(
    () => demoScopeKey ? demoScopeKey.split(",") : [],
    [demoScopeKey],
  );
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pageInFlight = useRef(false);

  useEffect(() => () => abortConversationSearchRequest(controller), []);

  useEffect(
    () => subscribeConversationSearchInvalidation(() => setRetry((current) => current + 1)),
    [],
  );

  useEffect(() => {
    const key = ++generation.current;
    abortConversationSearchRequest(controller);
    pageInFlight.current = false;
    const requestController = new AbortController();
    controller.current = requestController;
    // A non-empty one-character term is an active search UI, but it has no server request and
    // therefore must not enter the loading state.
    dispatch({ type: "reset", key, searching: requestable });
    if (!requestable) return () => requestController.abort();
    const timeout = globalThis.setTimeout(() => {
      void api.searchConversations(
        term,
        view,
        undefined,
        requestController.signal,
        folderId,
        normalizedTagIds,
        normalizedDemoScopeIds,
      ).then((page) => {
        dispatch({ type: "initialSuccess", key, data: page.data, cursor: page.nextCursor });
      }).catch((error) => {
        if (!aborted(error)) dispatch({ type: "initialError", key });
      });
    }, 300);
    return () => {
      globalThis.clearTimeout(timeout);
      requestController.abort();
    };
  }, [
    folderId,
    normalizedDemoScopeIds,
    normalizedTagIds,
    requestable,
    retry,
    searching,
    term,
    view,
  ]);

  const loadMore = useCallback(async () => {
    if (!state.cursor || !claimConversationSearchPage(pageInFlight)) return;
    const key = state.key;
    abortConversationSearchRequest(controller);
    const requestController = new AbortController();
    controller.current = requestController;
    dispatch({ type: "moreStart", key });
    try {
      const page = await api.searchConversations(
        term,
        view,
        state.cursor,
        requestController.signal,
        folderId,
        normalizedTagIds,
        normalizedDemoScopeIds,
      );
      dispatch({ type: "moreSuccess", key, data: page.data, cursor: page.nextCursor });
    } catch (error) {
      if (!aborted(error)) dispatch({ type: "moreError", key });
    } finally {
      if (key === generation.current) pageInFlight.current = false;
    }
  }, [folderId, normalizedDemoScopeIds, normalizedTagIds, state.cursor, state.key, term, view]);

  return {
    ...state,
    searching,
    tooShort,
    retry: () => setRetry((current) => current + 1),
    loadMore,
  };
}
