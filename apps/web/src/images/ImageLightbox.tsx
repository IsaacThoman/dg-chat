import { ArrowLeft, ChevronLeft, ChevronRight, Download, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../Modal.tsx";
import { assetAlt } from "./ImageCard.tsx";
import { imageApi } from "./imageApi.ts";
import type { GeneratedAsset } from "./types.ts";

export function ImageLightbox({ assets, activeId, close, select, edit, embedded = false }: {
  assets: GeneratedAsset[];
  activeId: string;
  close: () => void;
  select: (id: string) => void;
  edit?: (asset: GeneratedAsset) => void;
  embedded?: boolean;
}) {
  const [resolvedSources, setResolvedSources] = useState<GeneratedAsset[]>([]);
  const [sourceFailures, setSourceFailures] = useState<ReadonlySet<string>>(new Set());
  const [sourceRetryVersion, setSourceRetryVersion] = useState(0);
  const [lineageActiveId, setLineageActiveId] = useState(activeId);
  useEffect(() => setLineageActiveId(activeId), [activeId]);
  const viewAssets = [
    ...assets,
    ...resolvedSources.filter((resolved) =>
      !assets.some((candidate) => candidate.id === resolved.id)
    ),
  ];
  const index = viewAssets.findIndex((asset) => asset.id === lineageActiveId);
  const asset = viewAssets[index];
  const sourceVersions = asset
    ? asset.sourceAttachmentIds.map((attachmentId, sourceIndex) => {
      const candidates = viewAssets.filter((candidate) =>
        candidate.id !== asset.id && candidate.attachmentId === attachmentId &&
        candidate.createdAt <= asset.createdAt
      ).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      );
      return { attachmentId, sourceIndex, source: candidates[0] };
    })
    : [];
  useEffect(() => {
    if (!asset) return;
    const sourceKey = (attachmentId: string) => `${asset.id}:${attachmentId}`;
    const missing = sourceVersions.filter((entry) =>
      !entry.source && !sourceFailures.has(sourceKey(entry.attachmentId))
    );
    if (!missing.length) return;
    let cancelled = false;
    void Promise.allSettled(
      missing.map((entry) =>
        imageApi.retrieveSource(entry.attachmentId, asset.createdAt, asset.id)
      ),
    ).then((results) => {
      if (cancelled) return;
      const found = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      if (found.length) {
        setResolvedSources((current) => [
          ...current,
          ...found.filter((item) => !current.some((existing) => existing.id === item.id)),
        ]);
      }
      const failed = results.flatMap((result, index) =>
        result.status === "rejected" ? [sourceKey(missing[index].attachmentId)] : []
      );
      if (failed.length) {
        setSourceFailures((current) => new Set([...current, ...failed]));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [asset?.id, asset?.createdAt, asset?.sourceAttachmentIds.join("|"), sourceRetryVersion]);
  const choose = (id: string) => {
    setLineageActiveId(id);
    if (assets.some((candidate) => candidate.id === id)) select(id);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) return;
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        choose(viewAssets[index - 1].id);
      }
      if (event.key === "ArrowRight" && index >= 0 && index < viewAssets.length - 1) {
        event.preventDefault();
        choose(viewAssets[index + 1].id);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [viewAssets, index, select]);
  if (!asset) return null;
  const content = (
    <div className="image-lightbox">
      {embedded && (
        <button type="button" className="secondary image-lightbox-back" onClick={close}>
          <ArrowLeft size={16} /> Back to images
        </button>
      )}
      {asset.contentUrl && <img src={asset.contentUrl} alt={assetAlt(asset)} />}
      <div className="image-lightbox-nav" aria-label="Image navigation">
        <button
          type="button"
          aria-label="Previous image"
          disabled={index <= 0}
          onClick={() => choose(viewAssets[index - 1].id)}
        >
          <ChevronLeft />
        </button>
        <span aria-live="polite">{index + 1} of {viewAssets.length}</span>
        <button
          type="button"
          aria-label="Next image"
          disabled={index >= viewAssets.length - 1}
          onClick={() => choose(viewAssets[index + 1].id)}
        >
          <ChevronRight />
        </button>
      </div>
      <p>{asset.prompt}</p>
      {asset.revisedPrompt && (
        <details>
          <summary>Revised prompt</summary>
          <p>{asset.revisedPrompt}</p>
        </details>
      )}
      <dl>
        <div>
          <dt>Model</dt>
          <dd>{asset.model}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Date(asset.createdAt).toLocaleString()}</dd>
        </div>
      </dl>
      {asset.operation === "edit" && (
        <section className="image-lineage" aria-labelledby={`image-lineage-${asset.id}`}>
          <h3 id={`image-lineage-${asset.id}`}>Version lineage</h3>
          <p>
            This edit is a new immutable asset. Its {asset.sourceAttachmentIds.length} input
            {asset.sourceAttachmentIds.length === 1 ? " remains" : "s remain"} unchanged.
          </p>
          {sourceVersions.length > 0 && (
            <div aria-label="Source versions">
              {sourceVersions.map(({ attachmentId, source, sourceIndex }) => {
                const failureKey = `${asset.id}:${attachmentId}`;
                if (source) {
                  return (
                    <button
                      type="button"
                      key={source.id}
                      onClick={() => choose(source.id)}
                    >
                      <ArrowLeft size={14} /> Source {sourceIndex + 1}
                    </button>
                  );
                }
                if (sourceFailures.has(failureKey)) {
                  return (
                    <span key={failureKey} className="image-lineage-source-error">
                      Source {sourceIndex + 1} unavailable.
                      <button
                        type="button"
                        onClick={() => {
                          setSourceFailures((current) => {
                            const next = new Set(current);
                            next.delete(failureKey);
                            return next;
                          });
                          setSourceRetryVersion((value) => value + 1);
                        }}
                      >
                        Retry
                      </button>
                    </span>
                  );
                }
                return <span key={failureKey}>Loading source {sourceIndex + 1}…</span>;
              })}
            </div>
          )}
          {sourceVersions.some((entry) =>
            !entry.source && !sourceFailures.has(`${asset.id}:${entry.attachmentId}`)
          ) && (
            <p className="image-lineage-unavailable" role="status" aria-live="polite">
              Loading preserved source versions…
            </p>
          )}
          {sourceVersions.some((entry) =>
            !entry.source && sourceFailures.has(`${asset.id}:${entry.attachmentId}`)
          ) && (
            <p className="sr-only" role="status" aria-live="polite">
              {sourceVersions.filter((entry) =>
                !entry.source && sourceFailures.has(`${asset.id}:${entry.attachmentId}`)
              ).map((entry) => `Source ${entry.sourceIndex + 1} unavailable. Retry is available.`)
                .join(" ")}
            </p>
          )}
        </section>
      )}
      <div className="modal-actions">
        {edit && asset.status === "ready" && asset.attachmentId &&
          asset.mimeType?.startsWith("image/") && (
          <button
            type="button"
            className="secondary"
            onClick={() => edit(asset)}
          >
            <Pencil size={16} /> Edit
          </button>
        )}
        {asset.contentUrl && (
          <a className="primary" href={asset.contentUrl} download>
            <Download size={16} /> Download
          </a>
        )}
      </div>
    </div>
  );
  return embedded
    ? content
    : <Modal title="Image details" close={close} variant="wide">{content}</Modal>;
}
