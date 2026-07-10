import type { Conversation } from "./types.ts";

export async function conversationForFirstSend(
  activeId: string,
  current: Conversation | undefined,
  operations: {
    load: (id: string) => Promise<Conversation>;
    create: () => Promise<Conversation>;
  },
): Promise<{ conversation: Conversation; created: boolean }> {
  if (current) return { conversation: current, created: false };
  if (activeId) return { conversation: await operations.load(activeId), created: false };
  return { conversation: await operations.create(), created: true };
}
