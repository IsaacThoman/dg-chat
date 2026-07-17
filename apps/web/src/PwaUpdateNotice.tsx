import { type CSSProperties, useLayoutEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";

export const PWA_UPDATE_TITLE = "An update is ready";
export const PWA_UPDATE_GUIDANCE =
  "Nothing will reload automatically. When you’re ready, finish or stop any response and send or copy any draft, then close every DG Chat tab or window. The update installs the next time you open DG Chat.";

const PWA_NOTICE_EDGE_GAP = 16;
const PWA_NOTICE_COMPOSER_GAP = 12;

export function pwaUpdateNoticeClearance(
  composerTop: number | null,
  viewportHeight: number,
): number {
  if (composerTop === null || !Number.isFinite(composerTop)) return PWA_NOTICE_EDGE_GAP;
  return Math.max(
    PWA_NOTICE_EDGE_GAP,
    Math.ceil(viewportHeight - composerTop + PWA_NOTICE_COMPOSER_GAP),
  );
}

function visibleComposerTop(viewportHeight: number): number | null {
  for (const candidate of document.querySelectorAll<HTMLElement>(".composer-wrap")) {
    const bounds = candidate.getBoundingClientRect();
    if (
      bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 &&
      bounds.top < viewportHeight && !candidate.closest("[hidden], [inert]")
    ) return bounds.top;
  }
  return null;
}

function useComposerClearance(enabled: boolean) {
  const [clearance, setClearance] = useState(PWA_NOTICE_EDGE_GAP);
  useLayoutEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const observed = new WeakSet<Element>();
    const viewportHeight = () => globalThis.visualViewport?.height ?? globalThis.innerHeight;
    const measure = () => {
      const height = viewportHeight();
      setClearance(pwaUpdateNoticeClearance(visibleComposerTop(height), height));
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    const observeComposers = () => {
      if (!resizeObserver) return;
      for (const composer of document.querySelectorAll(".composer-wrap")) {
        if (!observed.has(composer)) {
          observed.add(composer);
          resizeObserver.observe(composer);
        }
      }
    };
    const includesComposer = (node: Node) =>
      node instanceof Element &&
      (node.matches(".composer-wrap") || Boolean(node.querySelector(".composer-wrap")));
    const mutationObserver = new MutationObserver((records) => {
      const relevant = records.some((record) =>
        record.type === "attributes" ||
        [...record.addedNodes, ...record.removedNodes].some(includesComposer)
      );
      if (!relevant) return;
      observeComposers();
      update();
    });
    observeComposers();
    mutationObserver.observe(document.body, {
      attributes: true,
      // Session activation changes hidden/inert. Avoid observing general class/style churn while a
      // response streams; composer geometry itself is covered by ResizeObserver.
      attributeFilter: ["hidden", "inert"],
      childList: true,
      subtree: true,
    });
    globalThis.addEventListener("resize", update);
    globalThis.visualViewport?.addEventListener("resize", update);
    // A layout effect state update is flushed before paint, so the first visible frame is already
    // above the composer rather than briefly covering Stop or Send.
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      globalThis.removeEventListener("resize", update);
      globalThis.visualViewport?.removeEventListener("resize", update);
    };
  }, [enabled]);
  return clearance;
}

export function PwaUpdateNoticeContent(
  { onDismiss, composerClearance = PWA_NOTICE_EDGE_GAP }: {
    onDismiss: () => void;
    composerClearance?: number;
  },
) {
  return (
    <aside
      className="pwa-update-notice"
      aria-labelledby="pwa-update-title"
      aria-describedby="pwa-update-guidance"
      style={{ "--pwa-composer-clearance": `${composerClearance}px` } as CSSProperties}
    >
      <div className="pwa-update-message" role="status" aria-live="polite" aria-atomic="true">
        <span className="pwa-update-icon" aria-hidden="true">
          <RefreshCw size={18} />
        </span>
        <div>
          <strong id="pwa-update-title">{PWA_UPDATE_TITLE}</strong>
          <p id="pwa-update-guidance">{PWA_UPDATE_GUIDANCE}</p>
        </div>
      </div>
      <button type="button" className="pwa-update-dismiss" onClick={onDismiss}>
        Later
      </button>
    </aside>
  );
}

/**
 * A waiting service worker must not be activated from one client: activation removes the previous
 * precache even when another long-lived tab still needs one of its lazy chunks. We deliberately let
 * the browser activate it only after the last version-N client closes.
 */
export function PwaUpdateNotice() {
  const {
    needRefresh: [updateReady],
  } = useRegisterSW({ immediate: true });
  const [dismissed, setDismissed] = useState(false);
  const visible = updateReady && !dismissed;
  const composerClearance = useComposerClearance(visible);

  if (!visible) return null;

  return (
    <PwaUpdateNoticeContent
      composerClearance={composerClearance}
      onDismiss={() => setDismissed(true)}
    />
  );
}
