/**
 * Replays the local checkbox intent over the latest server set after a version conflict. Tags
 * untouched by this dialog remain exactly as the other writer left them.
 */
export function rebaseConversationTagSelection(
  originalTagIds: string[],
  desiredTagIds: string[],
  latestTagIds: string[],
): string[] {
  const original = new Set(originalTagIds);
  const desired = new Set(desiredTagIds);
  const removals = new Set(originalTagIds.filter((id) => !desired.has(id)));
  const rebased = latestTagIds.filter((id, index) =>
    !removals.has(id) && latestTagIds.indexOf(id) === index
  );
  const present = new Set(rebased);
  for (const id of desiredTagIds) {
    if (!original.has(id) && !present.has(id)) {
      rebased.push(id);
      present.add(id);
    }
  }
  return rebased;
}

export function sameConversationTagSelection(a: string[], b: string[]): boolean {
  if (new Set(a).size !== new Set(b).size) return false;
  const values = new Set(a);
  return b.every((id) => values.has(id));
}
