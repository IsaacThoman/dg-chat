import type { Conversation } from "./types.ts";

/** Formats the canonical conversation timestamp without feeding localized text back into sorting. */
export function conversationTimestampLabel(
  conversation: Pick<Conversation, "updatedAt" | "updatedAtLabel">,
  locales?: Intl.LocalesArgument,
): string {
  if (conversation.updatedAtLabel) return conversation.updatedAtLabel;
  const timestamp = new Date(conversation.updatedAt);
  return Number.isNaN(timestamp.valueOf())
    ? conversation.updatedAt
    : timestamp.toLocaleString(locales);
}
