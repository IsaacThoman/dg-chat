import type { Message } from "./types.ts";

export interface MessageBranch {
  index: number;
  total: number;
  previousId: string | null;
  nextId: string | null;
}

export interface MessageTreeNode {
  message: Message;
  active: boolean;
  children: MessageTreeNode[];
}

function compareMessages(a: Message, b: Message): number {
  return (a.siblingIndex ?? 0) - (b.siblingIndex ?? 0) ||
    createdSort(a).localeCompare(createdSort(b)) || a.id.localeCompare(b.id);
}

export function siblingMessages(messages: Message[], messageId: string): Message[] {
  const selected = messages.find((message) => message.id === messageId);
  if (!selected) return [];
  return messages.filter((message) => (message.parentId ?? null) === (selected.parentId ?? null))
    .sort(compareMessages);
}

export function messageBranch(messages: Message[], messageId: string): MessageBranch | null {
  const siblings = siblingMessages(messages, messageId);
  if (siblings.length < 2) return null;
  const index = siblings.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  return {
    index: index + 1,
    total: siblings.length,
    previousId: siblings[index - 1]?.id ?? null,
    nextId: siblings[index + 1]?.id ?? null,
  };
}

export function activeMessagePath(messages: Message[], activeLeafId?: string | null): Message[] {
  if (!messages.length) return [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  let cursor = activeLeafId ? byId.get(activeLeafId) : undefined;
  if (!cursor) cursor = newestLeaf(messages);
  const reversePath: Message[] = [];
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    reversePath.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return reversePath.reverse();
}

export function preferredLeaf(messages: Message[], branchRootId: string): string {
  const byParent = groupChildren(messages);
  const root = messages.find((message) => message.id === branchRootId);
  if (!root) return branchRootId;
  const candidates: Array<{ message: Message; depth: number }> = [];
  const visit = (message: Message, depth: number, seen: Set<string>) => {
    if (seen.has(message.id)) return;
    const nextSeen = new Set(seen).add(message.id);
    const children = byParent.get(message.id) ?? [];
    if (!children.length) candidates.push({ message, depth });
    else children.forEach((child) => visit(child, depth + 1, nextSeen));
  };
  visit(root, 0, new Set());
  candidates.sort((a, b) =>
    createdSort(b.message).localeCompare(createdSort(a.message)) ||
    b.depth - a.depth || (b.message.siblingIndex ?? 0) - (a.message.siblingIndex ?? 0) ||
    b.message.id.localeCompare(a.message.id)
  );
  return candidates[0]?.message.id ?? branchRootId;
}

/**
 * Keeps a read-only branch preview through ordinary conversation-list refreshes while ensuring it
 * can never point into a different conversation or at a node that is no longer terminal.
 */
export function reconcileBranchPreview(
  previewLeafId: string | null,
  previousConversationId: string,
  nextConversationId: string,
  messages: readonly Message[],
  readOnly = true,
): string | null {
  if (!readOnly || !previewLeafId || previousConversationId !== nextConversationId) return null;
  const exists = messages.some((message) => message.id === previewLeafId);
  const hasChild = messages.some((message) => message.parentId === previewLeafId);
  return exists && !hasChild ? previewLeafId : null;
}

export function conversationTree(
  messages: Message[],
  activeLeafId?: string | null,
): MessageTreeNode[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const children = groupChildren(messages);
  const activeIds = new Set(activeMessagePath(messages, activeLeafId).map((message) => message.id));
  const roots = messages.filter((message) => !message.parentId || !byId.has(message.parentId))
    .sort(compareMessages);
  const build = (message: Message, ancestors: Set<string>): MessageTreeNode => {
    if (ancestors.has(message.id)) {
      return { message, active: activeIds.has(message.id), children: [] };
    }
    const next = new Set(ancestors).add(message.id);
    return {
      message,
      active: activeIds.has(message.id),
      children: (children.get(message.id) ?? []).map((child) => build(child, next)),
    };
  };
  return roots.map((root) => build(root, new Set()));
}

function groupChildren(messages: Message[]): Map<string, Message[]> {
  const children = new Map<string, Message[]>();
  for (const message of messages) {
    if (!message.parentId) continue;
    const group = children.get(message.parentId) ?? [];
    group.push(message);
    children.set(message.parentId, group);
  }
  for (const group of children.values()) group.sort(compareMessages);
  return children;
}

function newestLeaf(messages: Message[]): Message {
  const parentIds = new Set(
    messages.flatMap((message) => message.parentId ? [message.parentId] : []),
  );
  return messages.filter((message) => !parentIds.has(message.id)).sort((a, b) =>
    createdSort(b).localeCompare(createdSort(a)) || (b.siblingIndex ?? 0) - (a.siblingIndex ?? 0) ||
    b.id.localeCompare(a.id)
  )[0] ?? messages[0];
}

function createdSort(message: Message): string {
  return message.createdAtIso ?? message.createdAt;
}
