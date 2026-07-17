export const COMPOSER_TEXTAREA_MAX_HEIGHT = 160;
export const COMPOSER_TEXTAREA_VIEWPORT_FRACTION = 0.32;

export interface ComposerTextareaDimensions {
  height: number;
  overflowY: "auto" | "hidden";
}

/**
 * Grow the composer with its content without allowing a long draft to push the message history or
 * primary actions out of the viewport. Keeping the calculation pure makes the narrow/landscape
 * boundary independently testable.
 */
export function composerTextareaDimensions(
  scrollHeight: number,
  viewportHeight: number,
  minimumHeight = 34,
): ComposerTextareaDimensions {
  const safeMinimum = Number.isFinite(minimumHeight) ? Math.max(1, minimumHeight) : 34;
  const safeViewport = Number.isFinite(viewportHeight) ? Math.max(1, viewportHeight) : 800;
  const cap = Math.max(
    safeMinimum,
    Math.min(
      COMPOSER_TEXTAREA_MAX_HEIGHT,
      Math.floor(safeViewport * COMPOSER_TEXTAREA_VIEWPORT_FRACTION),
    ),
  );
  const contentHeight = Number.isFinite(scrollHeight) ? Math.max(safeMinimum, scrollHeight) : cap;
  return {
    height: Math.min(contentHeight, cap),
    overflowY: contentHeight > cap ? "auto" : "hidden",
  };
}

export function resizeComposerTextarea(
  textarea: HTMLTextAreaElement,
  viewportHeight = globalThis.visualViewport?.height ?? globalThis.innerHeight ?? 800,
) {
  // Reset first so scrollHeight can shrink when text is deleted or a shorter saved draft returns.
  textarea.style.height = "auto";
  const minimumHeight = Number.parseFloat(getComputedStyle(textarea).minHeight) || 34;
  const dimensions = composerTextareaDimensions(
    textarea.scrollHeight,
    viewportHeight,
    minimumHeight,
  );
  textarea.style.height = `${dimensions.height}px`;
  textarea.style.overflowY = dimensions.overflowY;
}
