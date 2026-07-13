import type { Conversation } from "./types.ts";

export type ConversationListView = "chat" | "archived" | "trash";

export function conversationsForView(
  conversations: Conversation[],
  view: ConversationListView,
): Conversation[] {
  return conversations.filter((conversation) => {
    if (view === "trash") return conversation.deleted;
    if (conversation.deleted) return false;
    return view === "archived" ? conversation.archived : !conversation.archived;
  });
}

export function fallbackConversationId(
  conversations: Conversation[],
  view: ConversationListView,
  removedId: string,
): string {
  return conversationsForView(conversations, view).find((conversation) =>
    conversation.id !== removedId
  )?.id ?? "";
}

export function mergeConversationSnapshot(
  conversations: Conversation[] | undefined,
  incoming: Conversation,
): Conversation[] | undefined {
  if (!conversations) return conversations;
  return conversations.map((current) => {
    if (current.id !== incoming.id) return current;
    return (incoming.version ?? -1) >= (current.version ?? -1) ? incoming : current;
  });
}
