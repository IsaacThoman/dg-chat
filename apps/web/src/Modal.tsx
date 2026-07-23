import { type ReactNode, useContext, useEffect, useRef } from "react";
import { RiCloseLine } from "@remixicon/react";

import { ChatSessionActivityContext } from "./chatSessionActivity.ts";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import {
  modalContainmentTarget,
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
  const sessionActive = useContext(ChatSessionActivityContext);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : document.activeElement as HTMLElement,
  );

  const finalFocus = () => {
    if (!modalShouldRestoreFocus(restoreFocus)) return false;
    const target = restoreFocusTarget?.() ?? previousFocus.current;
    return target?.isConnected && !target.closest("[inert], [aria-hidden='true']") ? target : false;
  };
  const restoreCandidateRef = useRef<() => HTMLElement | null>(() => null);
  restoreCandidateRef.current = () => {
    if (!modalShouldRestoreFocus(restoreFocus)) return null;
    return restoreFocusTarget?.() ?? previousFocus.current;
  };

  // Modal owners remove this component as soon as their close callback runs. Keep an explicit
  // unmount fallback because a controlled dialog cannot finish Base UI's close lifecycle after
  // its root has already left the tree.
  useEffect(() => () => {
    const target = restoreCandidateRef.current();
    if (!target) return;
    queueMicrotask(() => {
      if (target.isConnected && !target.closest("[inert], [aria-hidden='true']")) {
        target.focus({ preventScroll: true });
      }
    });
  }, []);

  // Keep programmatic focus changes inside the modal as well. Base UI handles ordinary keyboard
  // and pointer navigation, while this guard preserves the stricter contract used by assistive
  // workflows that move focus through script (for example, browser permission recovery).
  useEffect(() => {
    if (!sessionActive) return;
    const containFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      const focused = event.target;
      if (!dialog || dialog.contains(focused as Node)) return;
      if (
        focused instanceof Element &&
        focused.closest('[data-slot="select-content"], [role="listbox"], [role="dialog"]')
      ) return;
      modalContainmentTarget(dialog, focused)?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", containFocus);
    return () => document.removeEventListener("focusin", containFocus);
  }, [sessionActive]);

  return (
    <Dialog
      open={sessionActive}
      disablePointerDismissal={!dismissible}
      onOpenChange={(open) => {
        if (!open && dismissible) close();
      }}
    >
      <DialogContent
        ref={dialogRef}
        portalClassName="modal-overlay shadcn-modal-layer"
        className={`modal${variant === "medium" ? " modal-medium" : ""}${
          variant === "wide" ? " modal-wide" : ""
        }`}
        showCloseButton={false}
        initialFocus={() => dialogRef.current ? modalInitialFocus(dialogRef.current) : true}
        finalFocus={finalFocus}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !dismissible) event.preventDefault();
        }}
      >
        <DialogHeader className="modal-head">
          <DialogTitle>{title}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Close"
            disabled={!dismissible}
            onClick={close}
          >
            <RiCloseLine aria-hidden="true" />
          </Button>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
