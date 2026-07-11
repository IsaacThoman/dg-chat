import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./App.tsx";
import type { Model } from "./types.ts";

const imageModel = (capability: "image_generation" | "image_editing"): Model => ({
  id: `provider/${capability}`,
  name: capability === "image_generation" ? "Canvas" : "Canvas edit",
  provider: "Provider",
  context: "image",
  capabilities: [capability],
  healthy: true,
});

function render(imageModels: Model[] = [], imageEditModels: Model[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Composer
        onSend={vi.fn().mockResolvedValue(true)}
        cancelEdit={() => {}}
        disabled
        streaming={false}
        stopping={false}
        queuedCount={0}
        onStop={() => {}}
        transcriptionModels={[]}
        setTranscriptionModel={() => {}}
        imageModels={imageModels}
        imageEditModels={imageEditModels}
        disabledReason="No chat-capable model is available."
      />
    </QueryClientProvider>,
  );
}

describe("Composer image capabilities", () => {
  it("offers generation independently of chat when a generation model exists", () => {
    const html = render([imageModel("image_generation")]);
    expect(html).toContain('aria-label="Create images"');
    expect(html).not.toContain('aria-label="Create images" disabled');
    expect(html).toContain('aria-label="Open image history"');
  });

  it("does not advertise creation without an image-generation model", () => {
    const html = render([]);
    expect(html).not.toContain('aria-label="Create images"');
    expect(html).toContain('aria-label="Open image history"');
  });

  it("keeps image editing capability separate from generation", () => {
    const html = render([], [imageModel("image_editing")]);
    expect(html).not.toContain('aria-label="Create images"');
    expect(html).toContain('aria-label="Open image history"');
  });
});
