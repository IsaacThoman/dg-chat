import { useState } from "react";
import type { ArtifactDescriptor } from "./artifacts.ts";
import { safeArtifactFilename } from "./artifacts.ts";
import { writeClipboard } from "./clipboard.ts";

export function ArtifactBlock({ artifact, idPrefix }: {
  artifact: ArtifactDescriptor;
  idPrefix: string;
}) {
  const [view, setView] = useState<"preview" | "source">("preview");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const id = `${idPrefix}-artifact-${artifact.index}`;
  const filename = safeArtifactFilename(artifact.filename, artifact.language, artifact.index);
  const lines = artifact.source.split("\n");
  const preview = lines.slice(0, 16).join("\n");
  const truncated = lines.length > 16;

  const copy = async () => {
    setCopyState(await writeClipboard(artifact.source) ? "copied" : "failed");
    globalThis.setTimeout(() => setCopyState("idle"), 1_500);
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([artifact.source], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const navigateVersion = (index: number) => {
    const target = document.getElementById(`${idPrefix}-artifact-${index}`);
    target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  };

  return (
    <figure
      className="rich-artifact"
      id={id}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      data-artifact-filename={filename}
    >
      <figcaption className="rich-artifact-header">
        <span>
          <strong id={`${id}-title`}>{artifact.title}</strong>
          <small>
            {artifact.language} · {lines.length} lines
            {artifact.declaredVersion ? ` · v${artifact.declaredVersion}` : ""}
          </small>
        </span>
        <span className="rich-artifact-actions">
          <button
            type="button"
            aria-pressed={view === "preview"}
            onClick={() => setView("preview")}
          >
            Preview
          </button>
          <button type="button" aria-pressed={view === "source"} onClick={() => setView("source")}>
            Source
          </button>
          <button type="button" onClick={() => void copy()}>
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
              ? "Copy unavailable"
              : "Copy"}
          </button>
          <button type="button" onClick={download}>Export</button>
        </span>
      </figcaption>
      <pre
        className="rich-artifact-body"
        aria-label={`${view === "preview" ? "Preview" : "Source"} of ${artifact.title}`}
      >
        <code className={`language-${artifact.language}`}>{view === "preview" ? preview : artifact.source}</code>
      </pre>
      {view === "preview" && truncated && (
        <button
          className="rich-artifact-expand"
          type="button"
          onClick={() => setView("source")}
        >
          Show all {lines.length} lines
        </button>
      )}
      {artifact.versionCount > 1 && (
        <nav className="rich-artifact-versions" aria-label={`Versions of ${artifact.title}`}>
          <button
            type="button"
            disabled={artifact.versionIndex === 0}
            onClick={() =>
              navigateVersion(artifact.siblingIndexes[artifact.versionIndex - 1])}
          >
            Previous version
          </button>
          <span aria-live="polite">{artifact.versionIndex + 1} of {artifact.versionCount}</span>
          <button
            type="button"
            disabled={artifact.versionIndex === artifact.versionCount - 1}
            onClick={() =>
              navigateVersion(artifact.siblingIndexes[artifact.versionIndex + 1])}
          >
            Next version
          </button>
        </nav>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "copied"
          ? `${artifact.title} copied`
          : copyState === "failed"
          ? "Clipboard access unavailable"
          : ""}
      </span>
    </figure>
  );
}
