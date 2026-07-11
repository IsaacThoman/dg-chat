import { FormEvent, useEffect, useState } from "react";
import { Image as ImageIcon, Square } from "lucide-react";
import { Modal } from "../Modal.tsx";
import { ImageResultGrid } from "./ImageCard.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { restoreGeneratedAssetFocus } from "./imageHistory.ts";
import type { GeneratedAsset, ImageEditInput, ImageGenerationInput } from "./types.ts";
import type { ImageGenerationState } from "./imageGenerationState.ts";

export function ImageGenerationSheet({
  models,
  source,
  state,
  close,
  submit,
  cancel,
  add,
  edit,
  selectedIds = new Set<string>(),
}: {
  models: Array<{ id: string; name: string }>;
  source?: GeneratedAsset;
  state: ImageGenerationState;
  close: () => void;
  submit: (input: ImageGenerationInput | ImageEditInput) => void;
  cancel: () => void;
  add?: (asset: GeneratedAsset) => void;
  edit?: (asset: GeneratedAsset) => void;
  selectedIds?: ReadonlySet<string>;
}) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [size, setSize] = useState("1024x1024");
  const [count, setCount] = useState(1);
  const [preview, setPreview] = useState<string | null>(null);
  const closePreview = () => {
    const id = preview;
    setPreview(null);
    if (id) requestAnimationFrame(() => restoreGeneratedAssetFocus(document, id));
  };
  useEffect(() => setPrompt(""), [source?.id]);
  useEffect(() => {
    if (!models.some((item) => item.id === model)) setModel(models[0]?.id ?? "");
  }, [model, models]);
  const busy = state.phase === "submitting";
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || !model || busy) return;
    const input = { prompt: prompt.trim(), model, size, count };
    submit(source ? { ...input, sourceAssetId: source.id } : input);
  };
  return (
    <Modal
      title={source ? "Edit image" : "Create images"}
      close={close}
      dismissible={!busy}
      variant="wide"
    >
      {preview
        ? (
          <ImageLightbox
            embedded
            assets={state.assets}
            activeId={preview}
            close={closePreview}
            select={setPreview}
            edit={edit}
          />
        )
        : (
          <form className="image-generation-sheet" onSubmit={send}>
            {source?.contentUrl && (
              <div className="image-source">
                <img src={source.thumbnailUrl ?? source.contentUrl} alt="Image to edit" />
                <span>Original remains unchanged</span>
              </div>
            )}
            <label>
              <span>{source ? "Describe your changes" : "Describe the image"}</span>
              <textarea
                data-autofocus
                rows={4}
                maxLength={4000}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                required
              />
            </label>
            <div className="image-generation-options">
              <label>
                <span>Model</span>
                <select value={model} onChange={(event) => setModel(event.target.value)} required>
                  {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label>
                <span>Size</span>
                <select value={size} onChange={(event) => setSize(event.target.value)}>
                  <option>1024x1024</option>
                  <option>1536x1024</option>
                  <option>1024x1536</option>
                </select>
              </label>
              {!source && (
                <label>
                  <span>Images</span>
                  <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                    {[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}
                  </select>
                </label>
              )}
            </div>
            {busy && (
              <p role="status" aria-live="polite">
                <ImageIcon aria-hidden="true" /> Creating durable image assets…
              </p>
            )}
            {state.phase === "error" && <p className="form-error" role="alert">{state.error}</p>}
            {state.phase === "cancelled" && <p role="status">Image generation cancelled.</p>}
            {state.assets.length > 0 && (
              <ImageResultGrid
                assets={state.assets}
                selectedIds={selectedIds}
                onOpen={(asset) => setPreview(asset.id)}
                onAdd={add}
                onEdit={edit}
              />
            )}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={busy ? cancel : close}>
                {busy
                  ? (
                    <>
                      <Square size={14} /> Cancel generation
                    </>
                  )
                  : "Close"}
              </button>
              <button className="primary" disabled={busy || !prompt.trim() || !model}>
                {busy ? "Creating…" : source ? "Create edit" : "Create"}
              </button>
            </div>
          </form>
        )}
    </Modal>
  );
}
