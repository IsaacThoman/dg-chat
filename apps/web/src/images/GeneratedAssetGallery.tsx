import { useEffect, useState } from "react";
import { ImageCard } from "./ImageCard.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { restoreGeneratedAssetFocus } from "./imageHistory.ts";
import type { GeneratedAsset, GeneratedAssetFilters, ImageOperation } from "./types.ts";

export function GeneratedAssetGallery(
  {
    assets,
    filters,
    models = [],
    loading = false,
    error,
    hasMore = false,
    loadMore,
    retry,
    changeFilters,
    add,
    edit,
    remove,
    restore,
    pendingIds = new Set<string>(),
    selectedIds = new Set<string>(),
  }: {
    assets: GeneratedAsset[];
    filters: GeneratedAssetFilters;
    models?: string[];
    loading?: boolean;
    error?: string;
    hasMore?: boolean;
    loadMore?: () => void;
    retry?: () => void;
    changeFilters: (filters: GeneratedAssetFilters) => void;
    add?: (asset: GeneratedAsset) => void;
    edit?: (asset: GeneratedAsset) => void;
    remove?: (asset: GeneratedAsset) => void;
    restore?: (asset: GeneratedAsset) => void;
    pendingIds?: ReadonlySet<string>;
    selectedIds?: ReadonlySet<string>;
  },
) {
  const [query, setQuery] = useState(filters.query ?? "");
  const [active, setActive] = useState<string | null>(null);
  const closeDetails = () => {
    const id = active;
    setActive(null);
    if (id) requestAnimationFrame(() => restoreGeneratedAssetFocus(document, id));
  };
  useEffect(() => setQuery(filters.query ?? ""), [filters.query]);
  useEffect(() => {
    const normalized = query.trim();
    if (normalized === (filters.query ?? "")) return;
    const timeout = setTimeout(
      () => changeFilters({ ...filters, query: normalized || undefined }),
      300,
    );
    return () => clearTimeout(timeout);
  }, [changeFilters, filters, query]);
  if (active) {
    return (
      <ImageLightbox
        embedded
        assets={assets}
        activeId={active}
        close={closeDetails}
        select={setActive}
        edit={edit}
      />
    );
  }
  return (
    <section
      className="generated-asset-gallery"
      aria-labelledby="generated-images-heading"
      aria-busy={loading}
    >
      <header>
        <div>
          <h2 id="generated-images-heading">Images</h2>
          <p>Your generated and edited image history.</p>
        </div>
        <label>
          <span className="sr-only">Search images</span>
          <input
            type="search"
            placeholder="Search prompts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Show active or deleted images</span>
          <select
            value={filters.deleted ? "deleted" : "active"}
            onChange={(event) =>
              changeFilters({ ...filters, deleted: event.target.value === "deleted" })}
          >
            <option value="active">Active images</option>
            <option value="deleted">Recently deleted</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Filter images</span>
          <select
            value={filters.operation ?? "all"}
            onChange={(event) =>
              changeFilters({
                ...filters,
                operation: event.target.value === "all"
                  ? undefined
                  : event.target.value as ImageOperation,
              })}
          >
            <option value="all">All images</option>
            <option value="generation">Generated</option>
            <option value="edit">Edited</option>
          </select>
        </label>
        {models.length > 1 && (
          <label>
            <span className="sr-only">Filter by image model</span>
            <select
              value={filters.model ?? ""}
              onChange={(event) =>
                changeFilters({ ...filters, model: event.target.value || undefined })}
            >
              <option value="">All models</option>
              {models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
        )}
      </header>
      {error && (
        <div className="inline-error" role="alert">
          <span>{error}</span>
          {retry && <button type="button" onClick={retry}>Retry</button>}
        </div>
      )}
      {loading && assets.length === 0 && <p role="status">Loading image history…</p>}
      {loading && assets.length === 0 && (
        <div className="generated-image-grid image-gallery-skeleton" aria-hidden="true">
          {[1, 2, 3, 4].map((item) => <i key={item} />)}
        </div>
      )}
      {!loading && !error && assets.length === 0 && (
        <div className="generated-images-empty">
          <p>No images match this view.</p>
        </div>
      )}
      <div className="generated-image-grid">
        {assets.map((asset) => (
          <ImageCard
            key={asset.id}
            asset={asset}
            selected={selectedIds.has(asset.id)}
            onOpen={() => setActive(asset.id)}
            onAdd={add}
            onEdit={edit}
            onRemove={remove}
            onRestore={restore}
            mutationPending={pendingIds.has(asset.id)}
          />
        ))}
      </div>
      {hasMore && (
        <button className="secondary" type="button" disabled={loading} onClick={loadMore}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
