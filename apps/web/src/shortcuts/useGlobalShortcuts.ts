import { useEffect } from "react";

export function mobileSidebarLayout(
  match: Pick<typeof globalThis, "matchMedia"> = globalThis,
): boolean {
  return match.matchMedia?.("(max-width: 760px)").matches ?? false;
}

export function focusConversationSearch({
  openDrawer,
  focus,
  schedule = (callback: () => void) => requestAnimationFrame(callback),
  mobile = mobileSidebarLayout(),
}: {
  openDrawer: () => void;
  focus: () => void;
  schedule?: (callback: () => void) => unknown;
  mobile?: boolean;
}) {
  if (mobile) openDrawer();
  schedule(focus);
}

function isEditable(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(
    element?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
  );
}

export function useGlobalShortcuts({
  newChat,
  focusSearch,
}: {
  newChat: () => void;
  focusSearch: () => void;
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || document.querySelector('[aria-modal="true"]')) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        if (isEditable(event.target)) return;
        event.preventDefault();
        newChat();
      } else if (mod && event.key.toLowerCase() === "f") {
        if (isEditable(event.target)) return;
        event.preventDefault();
        focusSearch();
      } else if (event.key === "/" && !mod && !event.shiftKey && !isEditable(event.target)) {
        event.preventDefault();
        focusSearch();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [focusSearch, newChat]);
}
