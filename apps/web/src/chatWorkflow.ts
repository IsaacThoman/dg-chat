import type { Conversation } from "./types.ts";

export interface SendOperation {
  id: string;
  fingerprint: string;
}

export function operationForMessage(
  previous: SendOperation | null,
  fingerprint: string,
  createId: () => string = () => crypto.randomUUID(),
): SendOperation {
  return previous?.fingerprint === fingerprint ? previous : { id: createId(), fingerprint };
}

export function beginInFlight(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endInFlight(lock: { current: boolean }): void {
  lock.current = false;
}

export function mergeAttachmentIds(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function tokenScopesFromSelection(selection: {
  chat: boolean;
  models: boolean;
  filesRead: boolean;
  filesWrite: boolean;
}): string[] {
  return [
    ...(selection.chat ? ["chat:write"] : []),
    ...(selection.models ? ["models:read"] : []),
    ...(selection.filesRead ? ["files:read"] : []),
    ...(selection.filesWrite ? ["files:write"] : []),
  ];
}

export function refreshConversationGraph(
  conversationId: string,
  operations: {
    load: (id: string) => Promise<{
      conversation: Conversation;
      messages: import("./types.ts").Message[];
    }>;
  },
) {
  return operations.load(conversationId);
}

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
