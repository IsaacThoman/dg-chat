export type ConversationMenuPosition = { left: number; top: number };

export function conversationMenuPosition(
  trigger: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  viewport: { width: number; height: number },
  menu: { width: number; height: number },
  gutter = 8,
): ConversationMenuPosition {
  const left = Math.max(
    gutter,
    Math.min(trigger.right - menu.width, viewport.width - menu.width - gutter),
  );
  const below = trigger.bottom + 4;
  const above = trigger.top - menu.height - 4;
  const top = below + menu.height <= viewport.height - gutter
    ? below
    : Math.max(gutter, Math.min(above, viewport.height - menu.height - gutter));
  return { left, top };
}
