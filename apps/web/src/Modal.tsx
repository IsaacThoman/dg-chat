import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  consumeModalEscape,
  modalFocusableElements,
  modalInitialFocus,
  modalShouldRestoreFocus,
} from "./modalFocus.ts";

export function Modal(
  { title, close, children, dismissible = true, variant = "default", restoreFocus = true }: {
    title: string;
    close: () => void;
    children: ReactNode;
    dismissible?: boolean;
    variant?: "default" | "wide";
    restoreFocus?: boolean | (() => boolean);
  },
) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : document.activeElement as HTMLElement,
  );
  const closeRef = useRef(close);
  const dismissibleRef = useRef(dismissible);
  const restoreFrame = useRef<number | null>(null);
  const restoreFocusRef = useRef(restoreFocus);
  closeRef.current = close;
  dismissibleRef.current = dismissible;
  restoreFocusRef.current = restoreFocus;
  useEffect(() => {
    if (restoreFrame.current !== null) {
      cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = null;
    }
    const dialog = dialogRef.current;
    if (dialog) modalInitialFocus(dialog).focus();
    const keydown = (event: KeyboardEvent) => {
      if (consumeModalEscape(event, dismissibleRef.current, closeRef.current)) return;
      if (event.key !== "Tab" || !dialog) return;
      const items = modalFocusableElements(dialog);
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      const shouldRestore = modalShouldRestoreFocus(restoreFocusRef.current);
      if (!shouldRestore) return;
      restoreFrame.current = requestAnimationFrame(() => {
        restoreFrame.current = null;
        previousFocus.current?.focus();
      });
    };
  }, []);
  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={() => dismissibleRef.current && closeRef.current()}
    >
      <div
        ref={dialogRef}
        className={`modal${variant === "wide" ? " modal-wide" : ""}`}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            disabled={!dismissible}
            onClick={close}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
