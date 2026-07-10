import { type ReactNode, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { modalFocusableElements } from "./modalFocus.ts";

export function Modal(
  { title, close, children, dismissible = true }: {
    title: string;
    close: () => void;
    children: ReactNode;
    dismissible?: boolean;
  },
) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : document.activeElement as HTMLElement,
  );
  const closeRef = useRef(close);
  const dismissibleRef = useRef(dismissible);
  closeRef.current = close;
  dismissibleRef.current = dismissible;
  useEffect(() => {
    const dialog = dialogRef.current;
    const focusable = dialog ? modalFocusableElements(dialog) : [];
    const autofocus = focusable.find((element) =>
      element.hasAttribute("data-autofocus") || element.hasAttribute("autofocus")
    );
    (autofocus ?? focusable[0] ?? dialog)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissibleRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
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
      requestAnimationFrame(() => previousFocus.current?.focus());
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={() => dismissibleRef.current && closeRef.current()}
    >
      <div
        ref={dialogRef}
        className="modal"
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
    </div>
  );
}
