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
  root: Pick<Document, "querySelectorAll"> = document,
  excludedDialog?: Element | null,
): boolean {
  return [...root.querySelectorAll('.modal-overlay, [role="dialog"][aria-modal="true"]')].some(
    (candidate) => {
      if (candidate === excludedDialog) return false;
      const overlay = candidate as HTMLElement;
      return !overlay.closest('[hidden], [inert], [aria-hidden="true"]');
    },
  );
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

export function modalTabTarget(
  dialog: HTMLElement,
  activeElement: Element | null,
  backwards: boolean,
  focusable = modalFocusableElements(dialog),
): HTMLElement | null {
  if (!focusable.length) return dialog;
  const first = focusable[0];
  const last = focusable.at(-1)!;
  if (!activeElement || !dialog.contains(activeElement)) return backwards ? last : first;
  if (backwards && activeElement === first) return last;
  if (!backwards && activeElement === last) return first;
  return null;
}

export function modalContainmentTarget(
  dialog: HTMLElement,
  focusedElement: EventTarget | null,
  focusable = modalFocusableElements(dialog),
): HTMLElement | null {
  return focusedElement && dialog.contains(focusedElement as Node)
    ? null
    : modalInitialFocus(dialog, focusable);
}
