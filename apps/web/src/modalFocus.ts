export const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function modalFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)].filter((element) =>
    element.tabIndex >= 0 &&
    !element.matches(":disabled, [aria-disabled='true'], [aria-hidden='true']") &&
    !element.closest("[inert]")
  );
}

export function modalShouldRestoreFocus(value: boolean | (() => boolean)): boolean {
  return typeof value === "function" ? value() : value;
}

export function modalOverlayPresent(
  root: Pick<Document, "querySelector"> = document,
): boolean {
  return Boolean(root.querySelector(".modal-overlay"));
}

export function consumeModalEscape(
  event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopImmediatePropagation">,
  dismissible: boolean,
  close: () => void,
): boolean {
  if (event.key !== "Escape" || !dismissible) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  close();
  return true;
}

export function drawerShouldHandleEscape(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented">,
  modalOpen: boolean,
): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !modalOpen;
}

export function modalInitialFocus(
  dialog: HTMLElement,
  focusable = modalFocusableElements(dialog),
): HTMLElement {
  return focusable.find((element) =>
    element.hasAttribute("data-autofocus") || element.hasAttribute("autofocus")
  ) ?? focusable[0] ?? dialog;
}
