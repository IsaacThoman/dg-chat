import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./App.tsx";
import type { Message, Model } from "./types.ts";

const imageModel = (capability: "image_generation" | "image_editing"): Model => ({
  id: `provider/${capability}`,
  name: capability === "image_generation" ? "Canvas" : "Canvas edit",
  provider: "Provider",
  context: "image",
  capabilities: [capability],
  healthy: true,
});

function render(imageModels: Model[] = [], imageEditModels: Model[] = [], edit?: Message) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Composer
        onSend={vi.fn().mockResolvedValue(true)}
        edit={edit}
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

describe("Composer immutable edit accessibility", () => {
  it("announces immutable branching and gives the editor and action specific names", () => {
    const html = render([], [], {
      id: "message-1",
      parentId: null,
      role: "user",
      content: "Original content",
      createdAt: "now",
    });
    const descriptionId = html.match(/class="edit-banner" id="([^"]+)"/)?.[1];

    expect(descriptionId).toBeTruthy();
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain("Immutable edit: create a new branch");
    expect(html).toContain("The original message and every response after it will stay intact.");
    expect(html).toContain('aria-label="Edit message in a new branch"');
    expect(html).toContain(`aria-describedby="${descriptionId}"`);
    expect(html).toContain('aria-label="Send edited message as a new branch"');
  });
});
