let runtime: Promise<typeof import("mermaid").default> | null = null;
let renderTail: Promise<void> = Promise.resolve();

export const MERMAID_STABILITY_DELAY_MS = 220;

function abortError(): DOMException {
  return new DOMException("Mermaid render superseded", "AbortError");
}

export function waitForMermaidStability(
  signal: AbortSignal,
  delay = MERMAID_STABILITY_DELAY_MS,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!runtime) {
    runtime = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        theme: "neutral",
      });
      return mermaid;
    });
  }
  return await runtime;
}

export async function sanitizeMermaidSvg(svg: string, accessibleName: string): Promise<string> {
  const { default: createDOMPurify } = await import("dompurify");
  const purifier = createDOMPurify(window);
  const clean = purifier.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed", "image", "use", "a"],
    FORBID_ATTR: ["src", "srcset"],
  });
  const document = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || root.querySelector("parsererror")) {
    throw new Error("Invalid SVG output");
  }
  for (
    const forbidden of root.querySelectorAll(
      "script, foreignObject, iframe, object, embed, image, use, a",
    )
  ) forbidden.remove();
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        ((name === "href" || name === "xlink:href") && !value.startsWith("#"))
      ) {
        element.removeAttribute(attribute.name);
      }
      if (
        name === "style" &&
        /(?:javascript:|expression\s*\(|@import|url\s*\(\s*(?!["']?#))/i.test(value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  for (const style of root.querySelectorAll("style")) {
    if (
      /(?:javascript:|expression\s*\(|@import|url\s*\(\s*(?!["']?#))/i.test(style.textContent ?? "")
    ) {
      style.remove();
    }
  }
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", accessibleName);
  root.setAttribute("focusable", "false");
  return new XMLSerializer().serializeToString(root);
}

/**
 * Mermaid maintains shared DOM/configuration state. Serialize work and re-check ownership when a
 * queued render reaches the front so stale streaming-token updates never execute.
 */
export async function renderMermaidSvg(
  renderId: string,
  source: string,
  accessibleName: string,
  signal: AbortSignal,
): Promise<string> {
  await waitForMermaidStability(signal);
  const task = renderTail.then(async () => {
    if (signal.aborted) throw abortError();
    const mermaid = await loadMermaid();
    if (signal.aborted) throw abortError();
    const rendered = await mermaid.render(renderId, source);
    if (signal.aborted) throw abortError();
    return await sanitizeMermaidSvg(rendered.svg, accessibleName);
  });
  renderTail = task.then(() => undefined, () => undefined);
  return await task;
}
