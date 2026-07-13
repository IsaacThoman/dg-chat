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
  {
    title,
    close,
    children,
    dismissible = true,
    variant = "default",
    restoreFocus = true,
    restoreFocusTarget,
  }: {
    title: string;
    close: () => void;
    children: ReactNode;
    dismissible?: boolean;
    variant?: "default" | "medium" | "wide";
    restoreFocus?: boolean | (() => boolean);
    restoreFocusTarget?: () => HTMLElement | null;
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
  const restoreFocusTargetRef = useRef(restoreFocusTarget);
  closeRef.current = close;
  dismissibleRef.current = dismissible;
  restoreFocusRef.current = restoreFocus;
  restoreFocusTargetRef.current = restoreFocusTarget;
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
      const focusWhenAvailable = (attempt = 0) => {
        restoreFrame.current = null;
        const candidates = [restoreFocusTargetRef.current?.() ?? null, previousFocus.current];
        const target = candidates.find((candidate) =>
          candidate?.isConnected && candidate.getClientRects().length > 0 &&
          !candidate.closest("[inert]")
        );
        if (target) {
          target.focus();
          return;
        }
        // A successful mutation can unmount the modal's owning row before React
        // commits the parent drawer's inert-state update. Give that commit a
        // bounded opportunity to expose the fallback target before giving up.
        if (attempt < 2 && restoreFocusTargetRef.current) {
          restoreFrame.current = requestAnimationFrame(() => focusWhenAvailable(attempt + 1));
        }
      };
      restoreFrame.current = requestAnimationFrame(() => focusWhenAvailable());
    };
  }, []);
  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={() => dismissibleRef.current && closeRef.current()}
    >
      <div
        ref={dialogRef}
        className={`modal${variant === "medium" ? " modal-medium" : ""}${
          variant === "wide" ? " modal-wide" : ""
        }`}
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
