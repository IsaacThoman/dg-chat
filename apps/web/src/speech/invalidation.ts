export interface SpeechInvalidationMessage {
  readonly id: string;
  readonly content: string;
  readonly status?: string;
}

/**
 * Reuses the previous invalidation snapshot when the active, visible message path has not changed
 * semantically. Comparing the immutable strings directly avoids concatenating or copying large
 * message bodies, while ignoring cloned arrays and unrelated message metadata.
 *
 * Callers must pass only the active visible path: hidden sibling branches must not interrupt
 * playback.
 */
export function reconcileSpeechMessageSnapshot<T extends SpeechInvalidationMessage>(
  previous: readonly T[] | undefined,
  visiblePath: readonly T[],
): readonly T[] {
  if (!previous || previous.length !== visiblePath.length) return visiblePath;
  for (let index = 0; index < visiblePath.length; index++) {
    const before = previous[index];
    const after = visiblePath[index];
    if (
      before.id !== after.id || before.content !== after.content || before.status !== after.status
    ) return visiblePath;
  }
  return previous;
}

/** @deprecated Prefer `reconcileSpeechMessageSnapshot` with the active visible message path. */
export function speechMessageSnapshot<T extends SpeechInvalidationMessage>(
  messages: readonly T[],
): readonly T[] {
  return messages;
}
