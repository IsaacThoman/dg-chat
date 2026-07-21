import type { Conversation } from "./types.ts";

export const INITIAL_CONVERSATION_WINDOW = 75;

export type ConversationListWindow = {
  conversations: Conversation[];
  hiddenCount: number;
};

/**
 * Bounds the normal sidebar DOM without hiding work a user must be able to recover. Pinned chats
 * consume the window first; active, streaming, and unfinished chats are appended even when they
 * are older than the current window. The returned order remains the server's stable recency order
 * so expanding the window never makes already-visible rows jump around.
 */
export function conversationListWindow(
  conversations: readonly Conversation[],
  limit: number,
  essentialIds: ReadonlySet<string>,
): ConversationListWindow {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Conversation window limit must be a positive integer");
  }
  const prioritized = [
    ...conversations.filter((conversation) => conversation.pinned),
    ...conversations.filter((conversation) => !conversation.pinned),
  ];
  const selected = new Set(prioritized.slice(0, limit).map((conversation) => conversation.id));
  for (const conversation of conversations) {
    if (essentialIds.has(conversation.id)) selected.add(conversation.id);
  }
  return {
    conversations: conversations.filter((conversation) => selected.has(conversation.id)),
    hiddenCount: conversations.length - selected.size,
  };
}
