import { Check, Download, Image as ImageIcon, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { GeneratedAsset } from "./types.ts";

export function assetAlt(asset: GeneratedAsset) {
  const prompt = asset.prompt.trim().replace(/\s+/g, " ").slice(0, 120);
  return prompt ? `Generated image: ${prompt}` : "Generated image";
}

export function ImageCard({
  asset,
  selected = false,
  onOpen,
  onAdd,
  onEdit,
  onRemove,
  onRestore,
  mutationPending = false,
}: {
  asset: GeneratedAsset;
  selected?: boolean;
  onOpen?: (asset: GeneratedAsset) => void;
  onAdd?: (asset: GeneratedAsset) => void;
  onEdit?: (asset: GeneratedAsset) => void;
  onRemove?: (asset: GeneratedAsset) => void;
  onRestore?: (asset: GeneratedAsset) => void;
  mutationPending?: boolean;
}) {
  const url = asset.thumbnailUrl ?? asset.contentUrl;
  return (
    <article
      className={`generated-image-card${selected ? " selected" : ""}`}
      data-status={asset.status}
      data-generated-asset-id={asset.id}
      aria-busy={mutationPending || undefined}
    >
      <button
        className="generated-image-preview"
        type="button"
        onClick={() => onOpen?.(asset)}
        disabled={!url}
      >
        {url
          ? <img src={url} alt={assetAlt(asset)} loading="lazy" />
          : (
            <span className="generated-image-placeholder">
              <ImageIcon aria-hidden="true" />
              {asset.status}
            </span>
          )}
      </button>
      <div className="generated-image-copy">
        <strong>{asset.operation === "edit" ? "Edited image" : "Generated image"}</strong>
        <small>
          {asset.model}
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
        </small>
      </div>
      <div className="generated-image-actions">
        {onAdd && (
          <button
            type="button"
            onClick={() => onAdd(asset)}
            disabled={selected || mutationPending || !asset.attachmentId ||
              asset.status !== "ready"}
            aria-pressed={selected}
          >
            {selected ? <Check size={15} /> : <Plus size={15} />} {selected ? "Added" : "Add"}
          </button>
        )}
        {onEdit && asset.status === "ready" && (
          <button
            type="button"
            onClick={() => onEdit(asset)}
            disabled={mutationPending}
          >
            <Pencil size={15} /> Edit
          </button>
        )}
        {asset.contentUrl && (
          <a href={asset.contentUrl} download aria-label="Download generated image">
            <Download size={15} />
          </a>
        )}
        {onRemove && asset.status !== "deleted" && (
          <button
            type="button"
            aria-label="Delete generated image"
            disabled={mutationPending}
            onClick={() => onRemove(asset)}
          >
            <Trash2 size={15} />
          </button>
        )}
        {onRestore && asset.status === "deleted" && (
          <button
            type="button"
            disabled={mutationPending}
            onClick={() => onRestore(asset)}
          >
            <RotateCcw size={15} /> {mutationPending ? "Restoring…" : "Restore"}
          </button>
        )}
      </div>
    </article>
  );
}

export function ImageResultGrid({ assets, ...actions }: {
  assets: GeneratedAsset[];
  selectedIds?: ReadonlySet<string>;
  onOpen?: (asset: GeneratedAsset) => void;
  onAdd?: (asset: GeneratedAsset) => void;
  onEdit?: (asset: GeneratedAsset) => void;
}) {
  const { selectedIds = new Set<string>(), ...cardActions } = actions;
  return (
    <div className="generated-image-grid" aria-label="Generated images">
      {assets.map((asset) => (
        <ImageCard
          key={asset.id}
          asset={asset}
          selected={selectedIds.has(asset.id)}
          {...cardActions}
        />
      ))}
    </div>
  );
}
