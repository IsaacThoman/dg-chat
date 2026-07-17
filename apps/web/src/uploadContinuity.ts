const CLEANUP_STATES = new Set(["removing", "delete-failed"]);

/**
 * Keeps cleanup failures visible after their draft/edit scope is closed. Other inactive-scope
 * items stay hidden because only their owning retained composer may submit them.
 */
export function visibleComposerUploads<T extends { scope: string; status: string }>(
  uploads: readonly T[],
  activeScope: string,
): T[] {
  return uploads.filter((item) => item.scope === activeScope || CLEANUP_STATES.has(item.status));
}
