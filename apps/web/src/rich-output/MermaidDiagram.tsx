import { useEffect, useId, useState } from "react";
import { writeClipboard } from "./clipboard.ts";
import { renderMermaidSvg } from "./mermaidRuntime.ts";

type DiagramState =
  | { phase: "loading" }
  | { phase: "ready"; svg: string }
  | { phase: "error"; message: string };

const MAX_MERMAID_SOURCE = 50_000;

export function MermaidDiagram({ source, title = "Mermaid diagram" }: {
  source: string;
  title?: string;
}) {
  const reactId = useId();
  const renderId = `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DiagramState>({ phase: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ phase: "loading" });
    if (source.length > MAX_MERMAID_SOURCE) {
      setState({ phase: "error", message: "Diagram source is too large to render safely." });
      return () => {
        active = false;
      };
    }
    void renderMermaidSvg(`${renderId}-${attempt}`, source, title, controller.signal).then(
      (svg) => {
        if (active) setState({ phase: "ready", svg });
      },
    ).catch(() => {
      if (active && !controller.signal.aborted) {
        setState({ phase: "error", message: "This diagram could not be rendered safely." });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, renderId, source, title]);

  const copy = async () => {
    if (await writeClipboard(source)) {
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1_500);
    }
  };

  return (
    <figure className="mermaid-diagram" data-mermaid-state={state.phase}>
      <figcaption>
        <strong>{title}</strong>
        <button type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy source"}
        </button>
      </figcaption>
      {state.phase === "loading" && (
        <div className="mermaid-loading" role="status" aria-live="polite">
          Rendering diagram…
        </div>
      )}
      {state.phase === "ready" && (
        <div
          className="mermaid-canvas"
          // The SVG is generated in Mermaid strict mode and independently sanitized above.
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
      {state.phase === "error" && (
        <div className="mermaid-error" role="alert">
          <strong>Diagram preview unavailable</strong>
          <span>{state.message}</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>
      )}
      <details className="mermaid-source" open={state.phase === "error"}>
        <summary>Diagram source</summary>
        <pre><code>{source}</code></pre>
      </details>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Diagram source copied" : ""}
      </span>
    </figure>
  );
}

export function MermaidSourceFallback({ source }: { source: string }) {
  return (
    <figure className="mermaid-diagram mermaid-limit-fallback" data-mermaid-state="limited">
      <figcaption>
        <strong>Mermaid diagram</strong>
      </figcaption>
      <div className="mermaid-error" role="status">
        <strong>Diagram preview limit reached</strong>
        <span>The source remains available without running another diagram renderer.</span>
      </div>
      <details className="mermaid-source" open>
        <summary>Diagram source</summary>
        <pre><code>{source}</code></pre>
      </details>
    </figure>
  );
}
