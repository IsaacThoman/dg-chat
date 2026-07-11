import { ArrowLeft, ChevronLeft, ChevronRight, Download, Pencil } from "lucide-react";
import { useEffect } from "react";
import { Modal } from "../Modal.tsx";
import { assetAlt } from "./ImageCard.tsx";
import type { GeneratedAsset } from "./types.ts";

export function ImageLightbox({ assets, activeId, close, select, edit, embedded = false }: {
  assets: GeneratedAsset[];
  activeId: string;
  close: () => void;
  select: (id: string) => void;
  edit?: (asset: GeneratedAsset) => void;
  embedded?: boolean;
}) {
  const index = assets.findIndex((asset) => asset.id === activeId);
  const asset = assets[index];
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) return;
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        select(assets[index - 1].id);
      }
      if (event.key === "ArrowRight" && index >= 0 && index < assets.length - 1) {
        event.preventDefault();
        select(assets[index + 1].id);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [assets, index, select]);
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
          onClick={() => select(assets[index - 1].id)}
        >
          <ChevronLeft />
        </button>
        <span aria-live="polite">{index + 1} of {assets.length}</span>
        <button
          type="button"
          aria-label="Next image"
          disabled={index >= assets.length - 1}
          onClick={() => select(assets[index + 1].id)}
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
      <div className="modal-actions">
        {edit && asset.status === "ready" && (
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
