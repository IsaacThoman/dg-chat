import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GeneratedAssetGallery } from "./GeneratedAssetGallery.tsx";
import { assetAlt, ImageCard, ImageResultGrid } from "./ImageCard.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import type { GeneratedAsset } from "./types.ts";

const asset = {
  id: "asset-1",
  attachmentId: "attachment-1",
  contentUrl: "/api/images/assets/asset-1/content",
  thumbnailUrl: "/api/images/assets/asset-1/thumbnail",
  sourceAttachmentIds: [],
  operation: "generation",
  prompt: "  Friendly   robot <script> ",
  model: "provider/image",
  width: 1024,
  height: 1024,
  mimeType: "image/png",
  sizeBytes: 44,
  status: "ready",
  createdAt: "2026-01-01T00:00:00Z",
} satisfies GeneratedAsset;

describe("image components", () => {
  const gallery = (props: Partial<Parameters<typeof GeneratedAssetGallery>[0]> = {}) => (
    <GeneratedAssetGallery
      assets={[]}
      filters={{ deleted: false }}
      changeFilters={() => {}}
      {...props}
    />
  );
  it("renders safe durable URLs, useful alt text, and explicit actions", () => {
    const html = renderToStaticMarkup(
      <ImageCard asset={asset} onAdd={() => {}} onEdit={() => {}} onRemove={() => {}} />,
    );
    expect(html).toContain('src="/api/images/assets/asset-1/thumbnail"');
    expect(html).toContain("Generated image: Friendly robot &lt;script&gt;");
    expect(html).toContain("Add");
    expect(html).toContain('aria-label="Delete generated image"');
    expect(html).not.toContain("data:image");
  });
  it("labels grids and gallery states for assistive technology", () => {
    expect(renderToStaticMarkup(<ImageResultGrid assets={[asset]} />)).toContain(
      'aria-label="Generated images"',
    );
    const empty = renderToStaticMarkup(gallery());
    expect(empty).toContain('id="generated-images-heading"');
    expect(empty).toContain("Recently deleted");
    expect(empty).toContain("No images match this view");
    expect(renderToStaticMarkup(gallery({ loading: true }))).toContain(
      'role="status"',
    );
    const failed = renderToStaticMarkup(gallery({ error: "Unavailable", retry: () => {} }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Retry");
  });
  it("renders every server-returned row beyond the first 24 and exposes pagination", () => {
    const assets = Array.from({ length: 30 }, (_, index) => ({
      ...asset,
      id: `asset-${index + 1}`,
      attachmentId: `attachment-${index + 1}`,
      prompt: `Server match ${index + 1}`,
    }));
    const html = renderToStaticMarkup(gallery({ assets, hasMore: true, loadMore: () => {} }));
    expect(html).toContain("Server match 30");
    expect(html.match(/generated-image-card/g)?.length).toBe(30);
    expect(html).toContain("Load more");
  });
  it("normalizes and bounds generated alt text", () => {
    expect(assetAlt({ ...asset, prompt: " x  y " })).toBe("Generated image: x y");
    expect(assetAlt({ ...asset, prompt: "x".repeat(200) })).toHaveLength(
      "Generated image: ".length + 120,
    );
  });
  it("suppresses deleted media actions and fences pending mutations", () => {
    const deleted = { ...asset, status: "deleted" as const, contentUrl: null, thumbnailUrl: null };
    const deletedHtml = renderToStaticMarkup(
      <ImageCard asset={deleted} onEdit={() => {}} onRestore={() => {}} />,
    );
    expect(deletedHtml).not.toContain("Download generated image");
    expect(deletedHtml).not.toContain(">Edit<");
    expect(deletedHtml).toContain("Restore");
    const pending = renderToStaticMarkup(
      <ImageCard asset={deleted} onRestore={() => {}} mutationPending />,
    );
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("Restoring…");
    expect(pending).toContain("disabled");
  });
  it("acknowledges selected assets and embeds detail views without a nested dialog", () => {
    const selected = renderToStaticMarkup(
      <ImageCard asset={asset} selected onAdd={() => {}} />,
    );
    expect(selected).toContain("Added");
    expect(selected).toContain('aria-pressed="true"');
    expect(selected).toContain("disabled");
    const detail = renderToStaticMarkup(
      <ImageLightbox
        embedded
        assets={[asset]}
        activeId={asset.id}
        close={() => {}}
        select={() => {}}
      />,
    );
    expect(detail).toContain("Back to images");
    expect(detail).not.toContain('role="dialog"');
  });
});
