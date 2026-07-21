import { useContext, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import type { Model } from "../types.ts";
import { ChatSessionActivityContext } from "../chatSessionActivity.ts";

export function ModelPicker({
  models,
  selected,
  setSelected,
}: {
  models: Model[];
  selected: string;
  setSelected: (id: string) => void;
}) {
  const sessionActive = useContext(ChatSessionActivityContext);
  const [open, setOpen] = useState(false);
  const [focusedModelId, setFocusedModelId] = useState(selected);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const model = models.find((item) => item.id === selected) ?? models[0];
  const initialModelId = models.some((item) => item.id === selected)
    ? selected
    : models[0]?.id ?? "";

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open || !sessionActive) return;
    const selectedItem = panelRef.current?.querySelector<HTMLButtonElement>(
      `[data-model-id="${CSS.escape(initialModelId)}"]`,
    );
    (selectedItem ?? panelRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    const pointer = (event: PointerEvent) => {
      if (
        !panelRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) close(false);
    };
    document.addEventListener("pointerdown", pointer);
    return () => document.removeEventListener("pointerdown", pointer);
  }, [initialModelId, open, sessionActive]);

  return (
    <div className="model-picker">
      <button
        ref={triggerRef}
        type="button"
        className="model-trigger"
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        disabled={!models.length}
        onClick={() => {
          if (!open) setFocusedModelId(initialModelId);
          setOpen((value) => !value);
        }}
      >
        <span className="model-glyph" aria-hidden="true">{model?.provider[0]}</span>
        <span>
          <strong>{model?.name ?? "No chat model"}</strong>
          {model && <small>{model.provider} · {model.context}</small>}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={listId}
          className="model-popover"
          role="listbox"
          aria-label="Chat model"
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              close(false);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              close();
              return;
            }
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: HTMLButtonElement | undefined;
            if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
            if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
            if (event.key === "Home") next = items[0];
            if (event.key === "End") next = items.at(-1);
            if (next) {
              event.preventDefault();
              next.focus();
            }
          }}
        >
          <div className="popover-title">
            Choose a model <SlidersHorizontal size={15} />
          </div>
          {models.map((item) => (
            <button
              id={`${listId}-${item.id}`}
              data-model-id={item.id}
              type="button"
              role="option"
              aria-selected={selected === item.id}
              tabIndex={focusedModelId === item.id ? 0 : -1}
              key={item.id}
              onFocus={() => setFocusedModelId(item.id)}
              onClick={() => {
                setSelected(item.id);
                close();
              }}
            >
              <span className={`health-dot ${item.healthy ? "" : "down"}`} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.provider} · {item.context} context</small>
              </span>
              <span className="capabilities">
                {item.capabilities.map((capability) => <i key={capability}>{capability}</i>)}
              </span>
              {selected === item.id && <Check size={17} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
