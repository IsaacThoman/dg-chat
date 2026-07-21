import { type ReactNode, useContext, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  consumeModalEscape,
  modalContainmentTarget,
  modalInitialFocus,
  modalShouldRestoreFocus,
  modalTabTarget,
} from "./modalFocus.ts";
import { ChatSessionActivityContext } from "./chatSessionActivity.ts";

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
  const sessionActive = useContext(ChatSessionActivityContext);
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
    if (!sessionActive) return;
    if (restoreFrame.current !== null) {
      cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = null;
    }
    const dialog = dialogRef.current;
    if (dialog) modalInitialFocus(dialog).focus();
    const isTopmost = () => {
      const overlays = [...document.querySelectorAll<HTMLElement>(".modal-overlay")].filter(
        (candidate) => !candidate.hidden && !candidate.closest('[inert], [aria-hidden="true"]'),
      );
      return Boolean(dialog && overlays.at(-1)?.contains(dialog));
    };
    const keydown = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (consumeModalEscape(event, dismissibleRef.current, closeRef.current)) return;
      if (event.key !== "Tab" || !dialog) return;
      const target = modalTabTarget(dialog, document.activeElement, event.shiftKey);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (!dialog || !isTopmost()) return;
      modalContainmentTarget(dialog, event.target)?.focus();
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusin);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
      const shouldRestore = modalShouldRestoreFocus(restoreFocusRef.current);
      if (!shouldRestore) return;
      const focusWhenAvailable = (attempt = 0) => {
        restoreFrame.current = null;
        const activeOverlay = [...document.querySelectorAll<HTMLElement>(".modal-overlay")]
          .filter((candidate) => !candidate.closest('[hidden], [inert], [aria-hidden="true"]'))
          .at(-1);
        const candidates = [restoreFocusTargetRef.current?.() ?? null, previousFocus.current];
        const target = candidates.find((candidate) =>
          candidate?.isConnected && candidate.getClientRects().length > 0 &&
          !candidate.closest("[inert]") && (!activeOverlay || activeOverlay.contains(candidate))
        );
        if (target) {
          target.focus();
          return;
        }
        // A modal can hand off directly to another modal (for example, token creation to the
        // one-time-secret dialog). Never restore focus through the new modal to a background
        // trigger. The incoming modal normally owns focus already; if it does not, establish a
        // safe focus target inside that topmost layer.
        if (activeOverlay) {
          if (!activeOverlay.contains(document.activeElement)) {
            const activeDialog = activeOverlay.querySelector<HTMLElement>('[role="dialog"]');
            if (activeDialog) modalInitialFocus(activeDialog).focus();
          }
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
  }, [sessionActive]);
  return createPortal(
    <div
      className="modal-overlay"
      hidden={!sessionActive}
      inert={!sessionActive || undefined}
      aria-hidden={!sessionActive || undefined}
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
