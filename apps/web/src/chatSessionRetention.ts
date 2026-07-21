export const MAX_RETAINED_CHAT_SESSIONS = 6;

export type ChatSessionRetentionOptions = {
  activeId: string;
  protectedIds: ReadonlySet<string>;
  limit?: number;
};

export type ChatSessionVisitPlan = {
  admitted: boolean;
  sessionIds: string[];
};

export type ChatSessionProtectionStatus = "response" | "unfinished" | null;

export type ChatComposerRetentionState = {
  hasDraft: boolean;
  editing: boolean;
  uploadCount: number;
  approvedToolCount: number;
  selectedAssetCount: number;
  recordingOrTranscribing: boolean;
  imageGenerationBusy: boolean;
  imageMutationCount: number;
  imagePanelOpen: boolean;
  toolApprovalOpen: boolean;
};

export function chatComposerRequiresRetention(state: ChatComposerRetentionState): boolean {
  return state.hasDraft || state.editing || state.uploadCount > 0 ||
    state.approvedToolCount > 0 || state.selectedAssetCount > 0 ||
    state.recordingOrTranscribing || state.imageGenerationBusy || state.imageMutationCount > 0 ||
    state.imagePanelOpen || state.toolApprovalOpen;
}

export function chatSessionQueryActivity(active: boolean) {
  return {
    enabled: active,
    refetchOnWindowFocus: active,
    refetchOnReconnect: active,
  } as const;
}

/** Gives the sidebar one consistent, user-facing status for work that prevents LRU eviction. */
export function chatSessionProtectionStatus(
  conversationId: string,
  generationBusyIds: ReadonlySet<string>,
  retentionProtectedIds: ReadonlySet<string>,
): ChatSessionProtectionStatus {
  if (generationBusyIds.has(conversationId)) return "response";
  if (retentionProtectedIds.has(conversationId)) return "unfinished";
  return null;
}

/**
 * Picks an actionable review destination in LRU order. Prefer another chat so an alert raised
 * from the active chat does not appear to do nothing; fall back to the active chat when it is the
 * only protected session.
 */
export function protectedChatReviewTarget(
  sessionIds: readonly string[],
  protectedIds: ReadonlySet<string>,
  activeId: string,
): string | null {
  return sessionIds.find((id) => id !== activeId && protectedIds.has(id)) ??
    (protectedIds.has(activeId) ? activeId : sessionIds.find((id) => protectedIds.has(id))) ??
    null;
}

/**
 * Records a visit in least-recently-used order. Re-visiting a conversation moves it to the end
 * without creating a second mounted session.
 */
export function rememberChatSession(current: readonly string[], conversationId: string): string[] {
  if (!conversationId) return [...current];
  if (current.at(-1) === conversationId) return current as string[];
  return [...current.filter((id) => id !== conversationId), conversationId];
}

/**
 * Removes clean inactive sessions in LRU order. Callers must use `planChatSessionVisit` before
 * mounting a newly visited session: pruning alone cannot safely repair a legacy over-capacity list
 * made entirely of protected work.
 */
export function pruneChatSessions(
  current: readonly string[],
  { activeId, protectedIds, limit = MAX_RETAINED_CHAT_SESSIONS }: ChatSessionRetentionOptions,
): string[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  if (current.length <= boundedLimit) return current as string[];

  const next = [...new Set(current)];
  while (next.length > boundedLimit) {
    const candidate = next.findIndex((id) => id !== activeId && !protectedIds.has(id));
    if (candidate < 0) break;
    next.splice(candidate, 1);
  }
  return next.length === current.length && next.every((id, index) => id === current[index])
    ? current as string[]
    : next;
}

/**
 * Plans a visit without ever exceeding the mounted-session limit or evicting protected work.
 * When every mounted session is protected, a new visit is rejected and the exact current list is
 * returned. Existing mounted sessions can always be revisited.
 */
export function planChatSessionVisit(
  current: readonly string[],
  conversationId: string,
  protectedIds: ReadonlySet<string>,
  limit = MAX_RETAINED_CHAT_SESSIONS,
): ChatSessionVisitPlan {
  const boundedLimit = Math.max(1, Math.floor(limit));
  if (!conversationId) return { admitted: false, sessionIds: [...current] };

  const normalized = [...new Set(current)];

  if (normalized.includes(conversationId)) {
    return {
      admitted: true,
      sessionIds: pruneChatSessions(rememberChatSession(normalized, conversationId), {
        activeId: conversationId,
        protectedIds,
        limit: boundedLimit,
      }),
    };
  }

  if (normalized.length < boundedLimit) {
    return { admitted: true, sessionIds: [...normalized, conversationId] };
  }

  // A legacy list can be over capacity after a limit/configuration change. Repair it by
  // removing only clean sessions until the new visit fits. Slicing the repaired tail would be
  // shorter, but could silently discard protected drafts, uploads, or active responses.
  while (normalized.length >= boundedLimit) {
    const candidate = normalized.findIndex((id) => !protectedIds.has(id));
    if (candidate < 0) {
      const unchanged = normalized.length === current.length &&
        normalized.every((id, index) => id === current[index]);
      return { admitted: false, sessionIds: unchanged ? current as string[] : normalized };
    }
    normalized.splice(candidate, 1);
  }
  return {
    admitted: true,
    sessionIds: [...normalized, conversationId],
  };
}

export function retainVisitedChatSession(
  current: readonly string[],
  conversationId: string,
  protectedIds: ReadonlySet<string>,
  limit = MAX_RETAINED_CHAT_SESSIONS,
): string[] {
  return planChatSessionVisit(current, conversationId, protectedIds, limit).sessionIds;
}
